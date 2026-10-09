// Actual Electron + Pi harness with a local deterministic SSE provider. No cloud credentials.
import { _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const requests = [];
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const tool = requests.length === 1;
  const delta = tool ? { tool_calls: [{ index: 0, id: 'list-smoke', type: 'function', function: { name: 'list_tasks', arguments: '{}' } }] } : { content: '本地文本模型已连接，目前没有任务。' };
  for (const [d, finish_reason] of [[delta, null], [{}, tool ? 'tool_calls' : 'stop']]) res.write('data: ' + JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', model: 'orbit-text-test', choices: [{ index: 0, delta: d, finish_reason }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const directory = await mkdtemp(join(tmpdir(), 'orbit-text-smoke-'));
const env = { ...process.env, ORBIT_DATA_DIR: directory, QWEN_REALTIME_URL: 'invalid://voice-must-not-be-used' };
delete env.ELECTRON_RUN_AS_NODE; delete env.ORBIT_DEV_URL;
let app;
try {
  app = await electron.launch({ args: ['.'], env });
  let page = await app.firstWindow();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('textbox', { name: '你的需求' }).fill('hello');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '请先在设置中配置文本模型' }).waitFor();
  assert.equal(requests.length, 0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('文本模型服务地址').fill('http://127.0.0.1:' + server.address().port + '/v1');
  await page.getByLabel('文本模型名称').fill('orbit-text-test');
  await page.getByLabel('文本模型 API Key').fill('local-fixture-secret');
  await page.getByRole('button', { name: '保存文本模型' }).click();
  await page.getByText('已保存，下次文本对话生效。').waitFor();
  const config = await page.evaluate(() => window.orbit.textModel());
  assert.equal(config.hasKey, true); assert.ok(!JSON.stringify(config).includes('local-fixture-secret'));
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/orbit-model-settings.png' });
  await page.getByRole('button', { name: '切换侧栏' }).click();
  await page.getByRole('navigation').getByRole('button', { name: '主入口' }).click();
  await page.getByRole('textbox', { name: '你的需求' }).fill('查询任务');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText('本地文本模型已连接，目前没有任务。', { exact: true }).waitFor();
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some(m => m.role === 'tool'));
  assert.equal(await page.getByRole('complementary', { name: '语音对话' }).count(), 0);
  await page.screenshot({ path: 'artifacts/orbit-text-chat.png' });
  assert.deepEqual(errors, []);
  await app.close(); app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow();
  assert.equal((await page.evaluate(() => window.orbit.textModel())).model, 'orbit-text-test');
  await page.getByText('本地文本模型已连接，目前没有任务。', { exact: true }).waitFor();
  console.log('Text smoke passed: local settings, encrypted key metadata, Pi tool loop, Qwen isolation, restart persistence.');
} finally {
  if (app) await app.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
