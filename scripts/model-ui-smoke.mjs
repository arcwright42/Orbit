import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelServer } from '../tests/fixtures/model-server.ts';
import { codexToken } from '../tests/fixtures/codex-auth.ts';

// All configuration mutations go through visible controls and real preload/IPC.
const directory = await mkdtemp(join(tmpdir(), 'orbit-model-ui-'));
const codexHome = join(directory, 'codex');
await mkdir(codexHome);
await mkdir('artifacts', { recursive: true });
const model = await createModelServer();
const second = await createModelServer();
let rejectedResponse;
const rejected = createServer((req, res) => { req.resume(); rejectedResponse = res; });
rejected.listen(0, '127.0.0.1'); await once(rejected, 'listening');
const rejectedUrl = `http://127.0.0.1:${rejected.address().port}/v1`;
const env = { ...process.env, CODEX_HOME: codexHome, ORBIT_DATA_DIR: join(directory, 'data'),
  ORBIT_AGENT_BASE_URL: '', ORBIT_AGENT_PROVIDER: '', ORBIT_AGENT_MODEL: '', ORBIT_AGENT_API_KEY: '',
  ORBIT_CODEX_PATH: join(directory, 'missing-codex'), ORBIT_CLAUDE_PATH: join(directory, 'missing-claude') };
delete env.ELECTRON_RUN_AS_NODE; delete env.ORBIT_DEV_URL;
let app, page;
const errors = [];
const launch = async (overrides = {}) => {
  app = await electron.launch({ args: ['.'], env: { ...env, ...overrides } });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('textbox', { name: '你的需求' }).waitFor();
};
const settings = async () => {
  await page.locator('.topbar').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '模型配置', exact: true }).waitFor();
};
const home = async () => {
  if (!await page.getByRole('navigation').isVisible()) await page.getByRole('button', { name: '切换侧栏' }).click();
  await page.getByRole('navigation').getByRole('button', { name: '主入口', exact: true }).click();
};
const profile = name => page.getByRole('article', { name: `模型配置：${name}`, exact: true });
const addApi = async (name, url, key) => {
  await page.getByRole('button', { name: '添加配置', exact: true }).click();
  await page.getByLabel('配置名称', { exact: true }).fill(name);
  await page.getByLabel('服务商', { exact: true }).selectOption('custom');
  await page.getByLabel('API Key', { exact: true }).fill(key);
  await page.getByLabel('API 地址', { exact: true }).fill(url);
  await page.getByLabel('模型 ID', { exact: true }).fill('orbit-test');
};
const state = () => page.evaluate(() => window.orbit.models.read());
try {
  await launch();
  await page.getByRole('button', { name: '配置模型', exact: true }).click();
  await page.getByText('连接你的第一个模型', { exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/orbit-models-empty.png' });
  await addApi('日常对话', model.env.ORBIT_AGENT_BASE_URL, 'model-ui-first-key');
  await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password');
  await page.screenshot({ path: 'artifacts/orbit-models-api-form.png' });
  await page.getByRole('button', { name: '仅保存', exact: true }).click();
  await expect(profile('日常对话')).toBeVisible();
  assert.equal((await state()).activeProfileId, null);
  const firstId = (await state()).profiles[0].id;
  const beforeProbe = await page.evaluate(() => window.orbit.conversation());
  await profile('日常对话').getByRole('button', { name: '测试连接' }).click();
  await expect(profile('日常对话').getByRole('status')).toContainText('连接成功');
  assert.deepEqual(await page.evaluate(() => window.orbit.conversation()), beforeProbe);
  assert.equal((await state()).activeProfileId, null);
  assert.ok(!(await readFile(join(env.ORBIT_DATA_DIR, 'models.json'), 'utf8')).includes('model-ui-first-key'));
  await profile('日常对话').getByRole('button', { name: '启用', exact: true }).click();
  await expect.poll(async () => (await state()).activeProfileId).toBe(firstId);
  await expect(profile('日常对话').getByRole('button', { name: '编辑', exact: true })).toBeEnabled();

  // Saved secrets are never populated; normalized endpoints retain the existing key.
  await profile('日常对话').getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await page.getByLabel('配置名称', { exact: true }).fill('日常文字');
  await page.getByLabel('API 地址', { exact: true }).fill(`${model.env.ORBIT_AGENT_BASE_URL}/`);
  await expect(page.getByLabel('API Key', { exact: true })).not.toHaveAttribute('required', '');
  await page.getByRole('button', { name: '保存更改', exact: true }).click();
  await expect(profile('日常文字')).toBeVisible();
  await profile('日常文字').getByRole('button', { name: '测试连接' }).click();
  await expect(profile('日常文字').getByRole('status')).toContainText('连接成功');
  assert.equal(model.authorizations.at(-1), 'Bearer model-ui-first-key');

  await home();
  await page.getByRole('textbox', { name: '你的需求' }).fill('你好');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('你好，我是 Orbit。我们可以先明确你的目标。', { exact: true }).waitFor();
  const initial = await page.evaluate(() => window.orbit.conversation());
  await page.getByRole('textbox', { name: '你的需求' }).fill('慢回复');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('正在等待测试中断', { exact: true }).waitFor();
  await settings();
  await expect(profile('日常文字').getByRole('button', { name: '编辑', exact: true })).toBeDisabled();
  await expect(profile('日常文字').getByRole('button', { name: '测试连接' })).toBeDisabled();
  await page.getByRole('button', { name: '停止回复', exact: true }).click();
  await expect(profile('日常文字').getByRole('button', { name: '编辑', exact: true })).toBeEnabled();

  await addApi('备用模型', second.env.ORBIT_AGENT_BASE_URL, 'model-ui-second-key');
  await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  await expect(profile('备用模型').getByText('当前选择', { exact: true })).toBeVisible();
  const secondId = (await state()).activeProfileId;
  const switched = await page.evaluate(() => window.orbit.conversation());
  assert.equal(switched.sessionId, initial.sessionId);
  assert.deepEqual(switched.messages.slice(0, initial.messages.length), initial.messages);
  // Changed destinations require an explicit new key. A slow probe remains locked across navigation.
  await profile('日常文字').getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('API 地址', { exact: true }).fill(rejectedUrl);
  await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute('required', '');
  await page.getByLabel('API Key', { exact: true }).fill('rejected-ui-key');
  await page.getByRole('button', { name: '仅保存', exact: true }).click();
  await profile('日常文字').getByRole('button', { name: '测试连接' }).click();
  await expect.poll(() => Boolean(rejectedResponse)).toBe(true);
  await home();
  await expect(page.getByRole('textbox', { name: '你的需求' })).toBeDisabled();
  rejectedResponse.writeHead(401, { 'Content-Type': 'application/json' });
  rejectedResponse.end(JSON.stringify({ error: { message: 'Rejected fixture key', type: 'authentication_error' } }));
  await expect(page.getByRole('textbox', { name: '你的需求' })).toBeEnabled();
  await settings();
  await expect(profile('日常文字').getByRole('alert')).toContainText('连接失败');
  assert.equal((await state()).activeProfileId, secondId);

  // Missing and expired login paths stay visible; a failed activation cannot lose a saved profile.
  await page.getByRole('button', { name: '添加配置', exact: true }).click();
  await page.getByRole('radio', { name: /本地订阅/ }).check();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveCount(0);
  await page.getByLabel('配置名称', { exact: true }).fill('本机 Codex');
  await page.getByRole('searchbox', { name: '搜索模型', exact: true }).fill('gpt-6.1-sol');
  await page.getByLabel('模型', { exact: true }).selectOption('gpt-6.1-sol');
  await expect(page.getByRole('status').filter({ hasText: '未找到 Codex' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/orbit-models-codex-form.png' });
  await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '已保存，但启用失败' })).toBeVisible();
  await expect(profile('本机 Codex')).toBeVisible();
  assert.equal((await state()).activeProfileId, secondId);
  await expect(page.getByRole('form', { name: '添加模型配置' })).toHaveCount(0);
  const codexId = (await state()).profiles.find(profile => profile.source === 'codex-local').id;
  const authPath = join(codexHome, 'auth.json');
  await writeFile(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: codexToken(Date.now() - 1000) } }));
  await page.getByRole('button', { name: '刷新模型配置' }).click();
  await expect(profile('本机 Codex').getByText('登录已过期', { exact: true })).toBeVisible();
  await profile('本机 Codex').getByRole('button', { name: '测试连接' }).click();
  await expect(profile('本机 Codex').getByRole('alert')).toContainText('过期');
  assert.equal((await state()).profiles.filter(profile => profile.id === codexId).length, 1);

  // All built-in provider catalogs are usable, and rapid provider changes never keep the old model.
  await profile('本机 Codex').getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('radio', { name: /API 密钥/ }).check();
  await page.getByLabel('服务商', { exact: true }).selectOption('openrouter');
  await page.getByLabel('服务商', { exact: true }).selectOption('anthropic');
  await page.getByRole('searchbox', { name: '搜索模型', exact: true }).fill('claude');
  await expect.poll(async () => page.getByLabel('模型', { exact: true }).locator('option').count()).toBeGreaterThan(1);
  assert.ok((await page.getByLabel('模型', { exact: true }).locator('option').allTextContents()).slice(1).every(label => /claude/i.test(label)));
  await page.getByRole('button', { name: '取消编辑', exact: true }).click();
  await expect(profile('本机 Codex').getByRole('button', { name: '编辑', exact: true })).toBeFocused();
  await page.locator('.page-content').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: 'artifacts/orbit-models-profiles.png' });
  await app.close(); app = undefined;
  await launch(); await settings();
  assert.equal((await state()).activeProfileId, secondId);
  assert.equal((await page.evaluate(() => window.orbit.conversation())).sessionId, initial.sessionId);
  await expect(profile('备用模型').getByText('当前选择', { exact: true })).toBeVisible();
  await profile('备用模型').getByRole('button', { name: '删除', exact: true }).click();
  await profile('备用模型').getByRole('button', { name: '保留配置', exact: true }).click();
  assert.equal((await state()).activeProfileId, secondId);
  await profile('备用模型').getByRole('button', { name: '删除', exact: true }).click();
  await profile('备用模型').getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(profile('备用模型')).toHaveCount(0);
  assert.equal((await page.evaluate(() => window.orbit.conversation())).configured, false);
  assert.equal((await state()).activeProfileId, null);

  // Unknown saved catalog entries remain visible, including after an application restart.
  await app.close(); app = undefined;
  const stored = JSON.parse(await readFile(join(env.ORBIT_DATA_DIR, 'models.json'), 'utf8'));
  stored.profiles.find(entry => entry.profile.id === codexId).profile.modelId = 'removed-model';
  await writeFile(join(env.ORBIT_DATA_DIR, 'models.json'), JSON.stringify(stored));
  await launch(); await settings();
  await profile('本机 Codex').getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '不在当前支持目录' })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存并启用', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '取消编辑', exact: true }).click();
  await app.close(); app = undefined;

  await launch({ ORBIT_DATA_DIR: join(directory, 'environment'), ...model.env });
  await settings();
  await page.getByText('环境变量 · 只读', { exact: true }).waitFor();
  await expect(page.locator('.model-profile-actions')).toHaveCount(0);
  await page.getByRole('button', { name: '添加配置', exact: true }).click();
  await expect(page.getByText(/首次保存后改由应用管理模型/)).toBeVisible();
  await app.close(); app = undefined;
  const corrupt = join(directory, 'corrupt'); await mkdir(corrupt);
  await writeFile(join(corrupt, 'models.json'), '{broken');
  await launch({ ORBIT_DATA_DIR: corrupt }); await settings();
  await expect(page.getByRole('alert').filter({ hasText: /models.json/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加配置', exact: true })).toBeDisabled();
  assert.equal(await readFile(join(corrupt, 'models.json'), 'utf8'), '{broken');
  assert.deepEqual(errors, []);
  console.log('Model UI smoke passed: UI CRUD, encrypted key retention, catalogs, explicit probe/activation, partial failure, busy/navigation locking, history/restart, login recovery, read-only environment, corrupt config protection.');
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: 'artifacts/orbit-model-ui-failure.png' }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  rejected.closeAllConnections(); rejected.close();
  await model.close(); await second.close();
  await rm(directory, { recursive: true, force: true });
}
