import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelServer } from '../tests/fixtures/model-server.ts';
import { codexToken } from '../tests/fixtures/codex-auth.ts';

const directory = await mkdtemp(join(tmpdir(), 'orbit-model-smoke-'));
const codexHome = join(directory, 'codex');
await mkdir(codexHome);
const model = await createModelServer();
const other = await createModelServer();
const env = { ...process.env, ...model.env, CODEX_HOME: codexHome, ORBIT_DATA_DIR: directory,
  ORBIT_CODEX_PATH: join(directory, 'missing-codex'), ORBIT_CLAUDE_PATH: join(directory, 'missing-claude') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ORBIT_DEV_URL;
let app;
const errors = [];
const authPath = join(codexHome, 'auth.json');
const auth = token => JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, refresh_token: 'fixture-refresh-do-not-copy' } });
try {
  app = await electron.launch({ args: ['.'], env });
  let page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.orbit));
  assert.equal((await page.evaluate(() => window.orbit.models.read())).activeProfileId, 'environment');
  assert.equal((await page.evaluate(() => window.orbit.models.detectCodex())).status, 'missing');
  const input = { name: 'API fixture', source: 'api', providerId: 'custom', modelId: 'orbit-test', baseUrl: model.env.ORBIT_AGENT_BASE_URL, apiKey: 'encrypted-desktop-fixture-key' };
  let state = await page.evaluate(input => window.orbit.models.save(input), input);
  const first = state.profiles[0].id;
  assert.equal(state.activeProfileId, null);
  assert.ok(!JSON.stringify(state).includes(input.apiKey));
  assert.ok(!JSON.stringify(state).includes('encryptedApiKey'));
  const stored = await readFile(join(directory, 'models.json'), 'utf8');
  assert.ok(!stored.includes(input.apiKey));
  assert.ok(stored.includes('encryptedApiKey'));
  await page.evaluate(id => window.orbit.models.activate(id), first);
  await page.evaluate(() => window.orbit.sendMessage({ requestId: 'models-first-turn', text: '保存网站需求', attachmentIds: [] }));
  const workspace = await page.evaluate(() => window.orbit.workspace());
  const initial = await page.evaluate(() => window.orbit.conversation());
  assert.equal(workspace.tasks.length, 1);
  assert.ok(model.authorizations.every(value => value === `Bearer ${input.apiKey}`));

  state = await page.evaluate(input => window.orbit.models.save(input), { ...input, name: 'Second API', baseUrl: other.env.ORBIT_AGENT_BASE_URL, apiKey: 'second-desktop-fixture-key' });
  const second = state.profiles.at(-1).id;
  const beforeProbe = await page.evaluate(() => window.orbit.conversation());
  assert.equal((await page.evaluate(id => window.orbit.models.test(id), second)).ok, true);
  assert.deepEqual(await page.evaluate(() => window.orbit.conversation()), beforeProbe);
  assert.deepEqual(await page.evaluate(() => window.orbit.workspace()), workspace);
  assert.equal(other.authorizations.at(-1), 'Bearer second-desktop-fixture-key');
  await page.evaluate(id => window.orbit.models.activate(id), second);
  const switched = await page.evaluate(() => window.orbit.conversation());
  assert.equal(switched.sessionId, initial.sessionId);
  assert.deepEqual(switched.messages, initial.messages);
  await page.evaluate(() => window.orbit.sendMessage({ requestId: 'models-second-turn', text: '你好，继续', attachmentIds: [] }));
  assert.ok(JSON.stringify(other.requests.at(-1)).includes('保存网站需求'));

  await page.evaluate(() => {
    window.modelSmokeRun = window.orbit.sendMessage({ requestId: 'models-slow-turn', text: '慢回复', attachmentIds: [] }).catch(error => error.message);
  });
  await expect.poll(async () => (await page.evaluate(() => window.orbit.conversation())).draft.length).toBeGreaterThan(0);
  for (const operation of ['activate', 'remove', 'test']) {
    const message = await page.evaluate(async ({ operation, id }) => {
      try { await window.orbit.models[operation](id); return 'unexpected success'; } catch (error) { return error.message; }
    }, { operation, id: first });
    assert.match(message, /当前回复/);
  }
  const busySave = await page.evaluate(async input => {
    try { await window.orbit.models.save(input); return 'unexpected success'; } catch (error) { return error.message; }
  }, input);
  assert.match(busySave, /当前回复/);
  await page.evaluate(() => window.orbit.stopReply());
  await page.evaluate(() => window.modelSmokeRun);
  const beforeRestart = await page.evaluate(() => window.orbit.conversation());
  await app.close(); app = undefined;
  app = await electron.launch({ args: ['.'], env });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.orbit));
  assert.equal((await page.evaluate(() => window.orbit.models.read())).activeProfileId, second);
  const restored = await page.evaluate(() => window.orbit.conversation());
  assert.equal(restored.sessionId, initial.sessionId);
  assert.deepEqual(restored.messages, beforeRestart.messages);
  await page.evaluate(() => window.orbit.sendMessage({ requestId: 'models-restart-turn', text: '你好', attachmentIds: [] }));
  assert.equal(other.authorizations.at(-1), 'Bearer second-desktop-fixture-key');

  const validAuth = auth(codexToken());
  await writeFile(authPath, validAuth);
  assert.equal((await page.evaluate(() => window.orbit.models.detectCodex())).status, 'available');
  const catalog = await page.evaluate(() => window.orbit.models.catalog('openai-codex'));
  state = await page.evaluate(modelId => window.orbit.models.save({ name: 'Codex fixture', source: 'codex-local', providerId: 'openai-codex', modelId }), catalog[0].id);
  const codex = state.profiles.at(-1).id;
  const beforeCodex = await page.evaluate(() => window.orbit.conversation());
  await page.evaluate(id => window.orbit.models.activate(id), codex);
  assert.deepEqual((await page.evaluate(() => window.orbit.conversation())).messages, beforeCodex.messages);
  assert.equal(await readFile(authPath, 'utf8'), validAuth);
  const expiredAuth = auth(codexToken(Date.now() - 1000));
  await writeFile(authPath, expiredAuth);
  const rejected = await page.evaluate(async () => {
    try { await window.orbit.sendMessage({ requestId: 'models-expired-turn', text: '不会发送', attachmentIds: [] }); return 'unexpected success'; }
    catch (error) { return error.message; }
  });
  assert.match(rejected, /过期/);
  assert.deepEqual((await page.evaluate(() => window.orbit.conversation())).messages, beforeCodex.messages);
  assert.equal((await page.evaluate(id => window.orbit.models.test(id), codex)).ok, false);
  assert.equal(await readFile(authPath, 'utf8'), expiredAuth);
  assert.ok(!(await readFile(join(directory, 'models.json'), 'utf8')).includes('fixture-refresh-do-not-copy'));
  await writeFile(authPath, validAuth);
  await page.evaluate(id => window.orbit.models.activate(id), codex);
  assert.equal((await page.evaluate(() => window.orbit.conversation())).configured, true);
  await page.evaluate(id => window.orbit.models.remove(id), codex);
  assert.equal((await page.evaluate(() => window.orbit.conversation())).configured, false);
  await app.close(); app = undefined;
  app = await electron.launch({ args: ['.'], env });
  page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.orbit));
  assert.equal((await page.evaluate(() => window.orbit.models.read())).activeProfileId, null);
  assert.equal((await page.evaluate(() => window.orbit.conversation())).configured, false);
  assert.deepEqual(await page.evaluate(() => window.orbit.workspace()), workspace);
  assert.deepEqual(errors, []);
  console.log('Model desktop smoke passed: encrypted storage, IPC CRUD/test/switch, history/restart, busy rejection, Codex read-only/expiry, no environment fallback.');
} finally {
  if (app) await app.close();
  await model.close(); await other.close();
  await rm(directory, { recursive: true, force: true });
}
