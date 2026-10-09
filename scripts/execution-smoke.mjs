// Opt-in end-to-end test. Uses the configured foreground API and authenticated local Codex.
// All task files and Orbit state are isolated in a disposable workspace.
import { _electron as electron } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import { join } from 'node:path'; import assert from 'node:assert/strict';
const directory = await mkdtemp(join(tmpdir(), 'orbit-e2e-'));
const env = { ...process.env, ORBIT_DATA_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE; delete env.ORBIT_DEV_URL;
let app;
try {
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  if (!process.env.ORBIT_TEST_TEXT_URL || !process.env.ORBIT_TEST_TEXT_MODEL) throw Error('Set ORBIT_TEST_TEXT_URL and ORBIT_TEST_TEXT_MODEL (optional ORBIT_TEST_TEXT_KEY) for the text model; Qwen voice is not used.');
  await page.evaluate(config => window.orbit.saveTextModel(config), { protocol: 'openai-completions', baseUrl: process.env.ORBIT_TEST_TEXT_URL, model: process.env.ORBIT_TEST_TEXT_MODEL, apiKey: process.env.ORBIT_TEST_TEXT_KEY });
   const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('textbox', { name: '你的需求' }).fill('请立即创建一个执行与检查团队，派发任务：在工作目录创建 hello.txt，内容严格为 ORBIT_REAL_EXECUTION_OK。检查者读取核对即可。不需要询问我，使用平台工具实际完成。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const end = Date.now() + 240000; let task; let last = '';
  while (Date.now() < end) {
    const state = await page.evaluate(() => window.orbit.workspace()); task = state.tasks[0];
    const detail = task ? await page.evaluate(id => window.orbit.execution(id), task.id) : null;
    const summary = JSON.stringify({ status: task?.status, phase: detail?.phase, note: detail?.summary });
    if (summary !== last) { console.log(summary); last = summary; }
    if (task?.status === 'review') break;
    if (task && ['failed', 'blocked'].includes(task.status)) throw Error(summary);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(task?.status, 'review');
  const detail = await page.evaluate(id => window.orbit.execution(id), task.id);
  const artifact = detail.artifacts.find(path => path.endsWith('/hello.txt'));
  assert.ok(artifact); assert.equal(await readFile(artifact, 'utf8'), 'ORBIT_REAL_EXECUTION_OK');
  const toggle = page.getByRole('button', { name: '切换侧栏' });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.getByRole('navigation').getByRole('button', { name: /任务/ }).click();
  await page.getByRole('button', { name: new RegExp('待验收$') }).click();
  await page.getByRole('button', { name: '验收通过', exact: true }).click();
  await page.getByRole('dialog').getByText('已完成', { exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/orbit-execution.png' });
  assert.deepEqual(errors, []);
  console.log('PASSED: foreground text -> tool dispatch -> Codex builder -> independent reviewer -> artifact -> user acceptance.');
  console.log('Isolated evidence retained at:', directory);
} catch (error) {
  if (app) console.log(await (await app.firstWindow()).evaluate(() => document.body.innerText));
  throw error;
} finally { if (app) await app.close(); }
