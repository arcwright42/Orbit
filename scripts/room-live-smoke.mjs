// Opt-in live verification: real local Codex login + official Qwen, synthetic speech only.
// Requires macOS say/afconvert. User credentials are read only; all Orbit data is temporary.
import { _electron as electron, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
try { loadEnvFile(resolve('.env')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not load local environment'); }
const directory = await mkdtemp(join(tmpdir(), 'orbit-room-live-'));
const authPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
const fingerprint = async () => createHash('sha256').update(await readFile(authPath)).digest('hex');
const before = await fingerprint();
const env = { ...process.env, ORBIT_DATA_DIR: directory, ORBIT_AGENT_PROVIDER: '', ORBIT_AGENT_MODEL: '', ORBIT_AGENT_BASE_URL: '', ORBIT_AGENT_API_KEY: '' };
delete env.ELECTRON_RUN_AS_NODE; delete env.ORBIT_DEV_URL;
const report = { testedAt: new Date().toISOString(), checks: {}, passed: false };
let app, page, stage = 'launch';
const launch = async () => {
  app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.orbit?.room));
  await page.evaluate(() => { window.voiceEvents = []; window.audioChunks = 0; window.orbit.onVoice(event => {
    if (event.type === 'audio') window.audioChunks++; else window.voiceEvents.push(event);
  }); });
};
const send = async text => {
  await page.evaluate(input => window.orbit.sendMessage(input), { requestId: randomUUID(), text, attachmentIds: [] });
  const state = await page.evaluate(() => window.orbit.room.read()); assert.equal(state.error, undefined, 'Pi reply failed'); return state;
};
try {
  await mkdir('artifacts', { recursive: true }); await launch();
  stage = 'codex-setup';
  const detected = await page.evaluate(() => window.orbit.models.detectCodex()); assert.equal(detected.status, 'available');
  const models = await page.evaluate(() => window.orbit.models.save({ name: 'Room live test', source: 'codex-local', providerId: 'openai-codex', modelId: 'gpt-6.1-sol' }));
  await page.evaluate(id => window.orbit.models.activate(id), models.profiles[0].id);
  stage = 'pi-context';
  const initial = await send('这是语音与文字上下文验证。请记住项目代号是“蓝鲸”，只回复收到，不要创建任务。');
  report.checks.piText = initial.messages.some(message => message.channel === 'text' && message.role === 'assistant');
  stage = 'qwen-bootstrap';
  await page.evaluate(() => window.orbit.voiceStart(false));
  await page.waitForFunction(() => window.voiceEvents.some(event => event.type === 'state' && event.state === 'listening'), {}, { timeout: 25000 });
  report.checks.qwenHistoryAcknowledged = true;
  // A neutral synthetic utterance asks for text context, adds a new voice-only fact, then requests a real history tool.
  const aiff = join(directory, 'query.aiff'), pcm = join(directory, 'query.pcm');
  execFileSync('/usr/bin/say', ['-v', 'Tingting', '-r', '160', '-o', aiff, '刚才我在文字里说的项目代号是什么？再记住，我喜欢绿色。请调用搜索历史工具核对项目代号，不要创建任务。']);
  execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, pcm]);
  const wave = await readFile(pcm); let offset = 12, samples;
  while (offset + 8 <= wave.length) {
    const length = wave.readUInt32LE(offset + 4);
    if (wave.toString('ascii', offset, offset + 4) === 'data') { samples = wave.subarray(offset + 8, offset + 8 + length); break; }
    offset += 8 + length + length % 2;
  }
  assert.ok(samples?.length);
  stage = 'qwen-speech';
  const audio = Buffer.concat([Buffer.alloc(16000), samples, Buffer.alloc(48000)]);
  for (let i = 0; i < audio.length; i += 1280) {
    await page.evaluate(data => window.orbit.voiceAudio(new Uint8Array(data)), [...audio.subarray(i, i + 1280)]);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  await expect.poll(async () => (await page.evaluate(() => window.orbit.room.read())).messages.filter(message => message.channel === 'voice' && message.role === 'assistant').map(message => message.text).join(' '), { timeout: 45000, intervals: [250, 500] }).toContain('蓝鲸');
  const spoken = await page.evaluate(() => window.orbit.room.read());
  assert.ok(spoken.messages.some(message => message.channel === 'voice' && message.role === 'user' && message.text.includes('绿色')));
  assert.ok(await page.evaluate(() => window.audioChunks > 0)); report.checks.textToVoiceRecall = true;
  stage = 'voice-to-pi';
  const followup = await send('我刚才在语音里说喜欢什么颜色？只回复颜色，不要创建任务。');
  assert.ok(followup.messages.filter(message => message.channel === 'text' && message.role === 'assistant').at(-1).text.includes('绿色'));
  report.checks.voiceToTextRecall = true;
  await expect.poll(() => page.evaluate(() => window.voiceEvents.filter(event => event.type === 'state' && event.state === 'listening').length), { timeout: 25000 }).toBe(2);
  assert.ok(await page.evaluate(() => window.voiceEvents.some(event => event.type === 'state' && event.state === 'paused')));
  report.checks.voiceResumedAfterText = true;
  await page.evaluate(() => window.orbit.voiceStop());
  stage = 'history-tools';
  await send('请先调用 search_history，用 content 模式搜索“绿色”，再调用 read_history 读取命中的文件行，告诉我记录来自文字还是语音。不要创建任务。');
  const nativeDirectory = join(directory, 'rooms/main/runtime/pi/sessions');
  const native = (await Promise.all((await readdir(nativeDirectory)).filter(file => file.endsWith('.jsonl')).map(file => readFile(join(nativeDirectory, file), 'utf8')))).join('\n');
  const results = native.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.message?.role === 'toolResult');
  for (const name of ['search_history', 'read_history']) assert.ok(results.some(entry => entry.message.toolName === name && !entry.message.isError), `${name} must execute successfully`);
  report.checks.piHistoryTools = true;
  const beforeRestart = await page.evaluate(() => window.orbit.room.read());
  stage = 'restart'; await app.close(); app = undefined; await launch();
  const restarted = await page.evaluate(() => window.orbit.room.read());
  assert.equal(restarted.roomId, beforeRestart.roomId); assert.deepEqual(restarted.messages, beforeRestart.messages);
  assert.equal((await page.evaluate(() => window.orbit.workspace())).tasks.length, 0);
  report.checks.roomRestart = true; report.checks.tasksCreated = 0;
  const manifest = JSON.parse(await readFile(join(directory, 'rooms/main/room.json'), 'utf8'));
  report.checks.voiceSessions = manifest.sessions.filter(session => session.channel === 'voice').length;
  const auth = JSON.parse(await readFile(authPath, 'utf8'));
  const historyDirectory = join(directory, 'rooms/main/history');
  const stored = native + (await Promise.all((await readdir(historyDirectory)).map(file => readFile(join(historyDirectory, file), 'utf8')))).join('') + await readFile(join(directory, 'models.json'), 'utf8');
  assert.ok(['access_token', 'refresh_token', 'id_token'].map(name => auth.tokens?.[name]).filter(value => typeof value === 'string' && value.length > 8).every(token => !stored.includes(token)));
  report.checks.noCredentialsInHistory = true; report.passed = true;
} catch (error) {
  report.failedStage = stage; report.failureType = error?.name ?? 'UnknownError'; process.exitCode = 1;
  if (page) report.publicState = await page.evaluate(async () => ({
    voice: window.voiceEvents, room: (await window.orbit.room.read()).messages.map(({ role, channel, text }) => ({ role, channel, text: text.slice(0, 500) })),
  })).catch(() => undefined);
} finally {
  if (app) await app.close().catch(() => {});
  report.checks.codexAuthFileUnchanged = await fingerprint().then(after => after === before);
  if (!report.checks.codexAuthFileUnchanged) { report.passed = false; process.exitCode = 1; }
  await writeFile('artifacts/orbit-room-live-result.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report)); await rm(directory, { recursive: true, force: true });
}
