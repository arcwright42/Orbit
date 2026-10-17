import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

// Explicit live test, never imported by npm test/check. Uses real subscription quota.
// Orbit data is disposable; the user's Codex auth file is only read and never copied.
try { loadEnvFile(resolve('.env')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not load the local environment'); }
const codexDirectory = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
const codexHome = resolve(codexDirectory.startsWith('~/') ? join(homedir(), codexDirectory.slice(2)) : codexDirectory);
const authPath = join(codexHome, 'auth.json');
const fingerprint = async () => createHash('sha256').update(await readFile(authPath)).digest('hex');
const beforeFingerprint = await fingerprint();
const directory = await mkdtemp(join(tmpdir(), 'orbit-codex-live-'));
const modelId = process.env.ORBIT_CODEX_SMOKE_MODEL || 'gpt-6.1-sol';
const marker = `ORBIT_LIVE_${randomUUID().slice(0, 8)}`;
const env = { ...process.env, CODEX_HOME: codexHome, ORBIT_DATA_DIR: directory,
  ORBIT_AGENT_PROVIDER: '', ORBIT_AGENT_MODEL: '', ORBIT_AGENT_BASE_URL: '', ORBIT_AGENT_API_KEY: '' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ORBIT_DEV_URL;
const report = { testedAt: new Date().toISOString(), modelId, checks: {}, passed: false };
let app, page;
let stage = 'launch';
let rendererErrors = 0;
const launch = async () => {
  app = await electron.launch({ args: ['.'], env });
  page = await app.firstWindow();
  page.on('pageerror', () => { rendererErrors++; });
  await page.waitForFunction(() => Boolean(window.orbit));
};
const sendThroughUi = async text => {
  const beforeCount = (await page.evaluate(() => window.orbit.conversation())).messages.length;
  await page.getByRole('textbox', { name: '你的需求' }).fill(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.orbit.conversation());
    return state.status === 'idle' && (state.error || (state.messages.length >= beforeCount + 2 &&
      state.messages.at(-1)?.role === 'assistant' && await page.getByRole('textbox', { name: '你的需求' }).inputValue() === '')) ? true : false;
  }, { timeout: 150_000, intervals: [100, 250, 500] }).toBe(true);
  const conversation = await page.evaluate(() => window.orbit.conversation());
  assert.equal(conversation.error, undefined, 'Live reply failed');
  return conversation;
};
try {
  await mkdir('artifacts', { recursive: true });
  await launch();
  stage = 'detect-login';
  const login = await page.evaluate(() => window.orbit.models.detectCodex());
  report.checks.login = login.status;
  assert.equal(login.status, 'available', 'Codex file login must be available');
  const models = await page.evaluate(() => window.orbit.models.catalog('openai-codex'));
  assert.ok(models.some(model => model.id === modelId), 'Requested model must exist in the SDK catalog');
  const state = await page.evaluate(modelId => window.orbit.models.save({ name: 'Codex live verification', source: 'codex-local', providerId: 'openai-codex', modelId }), modelId);
  const profileId = state.profiles[0].id;
  stage = 'connection-test';
  const beforeProbe = await page.evaluate(() => window.orbit.conversation());
  const started = Date.now();
  const connection = await page.evaluate(id => window.orbit.models.test(id), profileId);
  report.checks.connection = { ok: connection.ok, elapsedMs: Date.now() - started };
  assert.equal(connection.ok, true, 'Real Codex connection test failed');
  assert.deepEqual(await page.evaluate(() => window.orbit.conversation()), beforeProbe);
  assert.equal((await page.evaluate(() => window.orbit.workspace())).tasks.length, 0);
  report.checks.probeHasNoSideEffects = true;
  await page.evaluate(id => window.orbit.models.activate(id), profileId);
  await page.evaluate(() => {
    window.liveStreamEvents = 0;
    window.orbit.onConversation(state => { if (state.draft) window.liveStreamEvents++; });
  });
  stage = 'streaming-chat';
  const first = await sendThroughUi(`这是 Orbit 接入验证。请记住校验词 ${marker}，只回复该校验词，不要调用工具。`);
  assert.ok(first.messages.at(-1).text.includes(marker), 'The real model must return the supplied marker');
  report.checks.streamingEvents = await page.evaluate(() => window.liveStreamEvents);
  assert.ok(report.checks.streamingEvents > 0, 'Expected real streaming events');
  await page.screenshot({ path: 'artifacts/orbit-codex-live-chat.png' });
  stage = 'restart';
  await app.close(); app = undefined;
  await launch();
  const resumed = await page.evaluate(() => window.orbit.conversation());
  assert.equal(resumed.sessionId, first.sessionId);
  assert.deepEqual(resumed.messages, first.messages);
  assert.equal((await page.evaluate(() => window.orbit.models.read())).activeProfileId, profileId);
  report.checks.restartRestoredHistory = true;
  stage = 'context-followup';
  const followup = await sendThroughUi('上一轮让你记住的校验词是什么？不要调用工具，只回复该词。');
  assert.ok(followup.messages.at(-1).text.includes(marker), 'The real model must recall the marker after restart');
  report.checks.contextRecall = true;
  stage = 'business-tool';
  await sendThroughUi('这是隔离测试工作空间。请调用 list_tasks 查询当前任务，只告诉我任务数量，不要保存或创建需求。');
  const sessionDirectory = join(directory, 'agent', 'sessions');
  const sessionFiles = (await readdir(sessionDirectory)).filter(file => file.endsWith('.jsonl'));
  const sessionText = (await Promise.all(sessionFiles.map(file => readFile(join(sessionDirectory, file), 'utf8')))).join('\n');
  const entries = sessionText.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const taskResults = entries.filter(entry => entry.type === 'message' && entry.message?.role === 'toolResult' && entry.message?.toolName === 'list_tasks');
  assert.ok(taskResults.length > 0, 'The real model must invoke the Orbit business tool');
  assert.ok(taskResults.every(entry => !entry.message.isError), 'Business tool calls must succeed');
  report.checks.businessToolCalls = taskResults.length;
  assert.equal((await page.evaluate(() => window.orbit.workspace())).tasks.length, 0);
  report.checks.tasksCreated = 0;
  const storedConfig = await readFile(join(directory, 'models.json'), 'utf8');
  const auth = JSON.parse((await readFile(authPath, 'utf8')).replace(/^\uFEFF/, ''));
  const tokens = ['access_token', 'refresh_token', 'id_token'].map(name => auth.tokens?.[name]).filter(value => typeof value === 'string' && value.length > 8);
  assert.ok(tokens.every(token => !storedConfig.includes(token) && !sessionText.includes(token)), 'Credentials must not enter config or conversation storage');
  report.checks.noCredentialsInOrbitData = true;
  assert.equal(rendererErrors, 0);
  report.checks.rendererErrors = rendererErrors;
  report.passed = true;
} catch (error) {
  // Do not print exceptions, network bodies, auth objects, or child process environment.
  report.failedStage = stage;
  report.failureType = error?.name ?? 'UnknownError';
  if (page) {
    // Only Orbit's public projection of our synthetic test conversation, never SDK/network errors.
    report.conversationAtFailure = await page.evaluate(async () => {
      const state = await window.orbit.conversation();
      return { configured: state.configured, status: state.status, error: state.error,
        messageCount: state.messages.length, lastReply: state.messages.filter(item => item.role === 'assistant').at(-1)?.text.slice(0, 300) };
    }).catch(() => undefined);
    await page.screenshot({ path: 'artifacts/orbit-codex-live-failure.png' }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (app) {
    await page?.evaluate(() => window.orbit.stopReply()).catch(() => {});
    await app.close().catch(() => {});
  }
  report.checks.codexAuthFileUnchanged = await fingerprint().then(after => after === beforeFingerprint).catch(() => false);
  if (!report.checks.codexAuthFileUnchanged) { report.passed = false; process.exitCode = 1; }
  await writeFile('artifacts/orbit-codex-live-result.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  await rm(directory, { recursive: true, force: true });
}
