import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelServer } from '../tests/fixtures/model-server.ts';

const directory = await mkdtemp(join(tmpdir(), 'orbit-task-ui-'));
const executable = join(directory, 'fixture-cli.mjs');
await copyFile('tests/fixtures/execution-cli.mjs', executable); await chmod(executable, 0o700);
const model = await createModelServer();
const env = { ...process.env, ...model.env, ORBIT_DATA_DIR: directory, ORBIT_CODEX_PATH: executable, ORBIT_CLAUDE_PATH: executable };
delete env.ELECTRON_RUN_AS_NODE; delete env.ORBIT_DEV_URL;
await mkdir('artifacts', { recursive: true });
let app, page;
const errors = [];
const launch = async () => {
  app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.orbit));
  await app.evaluate(({ shell }) => { globalThis.taskOpenedFiles = []; shell.openPath = async path => { globalThis.taskOpenedFiles.push(path); return ''; }; });
};
const state = id => page.evaluate(id => window.orbit.execution.detail(id), id);
const dialog = () => page.getByRole('dialog');
const waitStatus = async (id, status) => {
  await expect.poll(async () => (await state(id)).task.status, { timeout: 30_000, intervals: [50, 100, 250] }).toBe(status);
  if (await dialog().count()) await expect(dialog().locator('.detail-meta .badge')).toHaveText({ review: '待验收', failed: '执行失败', completed: '已完成', waiting: '等待你处理', canceled: '已取消', running: '执行中' }[status]);
};
const home = async () => {
  if (await dialog().count()) await page.getByRole('button', { name: '关闭任务详情' }).click();
  if (!await page.getByRole('navigation').isVisible()) await page.getByRole('button', { name: '切换侧栏' }).click();
  await page.getByRole('navigation').getByRole('button', { name: '主入口' }).click();
};
const save = async text => {
  await home(); await page.getByRole('textbox', { name: '你的需求' }).fill(text);
  await page.getByRole('button', { name: '仅保存需求', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => window.orbit.workspace())).tasks.some(task => task.brief === text)).toBe(true);
  const task = (await page.evaluate(() => window.orbit.workspace())).tasks.find(task => task.brief === text);
  await page.locator('.inline-task').filter({ hasText: task.title }).first().click();
  await expect(dialog().getByRole('button', { name: '直接执行', exact: true })).toBeVisible(); return task.id;
};
const selectRuntime = async runtime => {
  await home(); await page.locator('.topbar').getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('region', { name: '任务执行', exact: true });
  await settings.getByRole('radio', { name: new RegExp(runtime) }).check();
  await settings.getByRole('combobox', { name: '最多同时运行的步骤数' }).selectOption('2');
  const save = settings.getByRole('button', { name: '保存执行设置' }); if (await save.isEnabled()) await save.click();
  await expect(settings.getByRole('button', { name: '重新检测运行时' })).toBeEnabled();
};
try {
  await launch();
  const planned = await save('为周末读书会准备资料：先分析主题，再汇总一份 Markdown 提纲');
  await dialog().getByRole('button', { name: '先规划再执行' }).click();
  await waitStatus(planned, 'review');
  assert.equal((await state(planned)).steps.length, 4);
  await expect(dialog().getByRole('progressbar')).toHaveAttribute('aria-valuenow', '4');
  assert.equal(await dialog().locator('.artifact-link').count(), 3);
  await dialog().locator('.artifact-link').last().click();
  assert.ok((await app.evaluate(() => globalThis.taskOpenedFiles)).at(-1).endsWith('/steps/combine/result.txt'));
  await dialog().evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: 'artifacts/orbit-task-execution.png' });
  await dialog().getByRole('button', { name: '验收通过' }).click(); await waitStatus(planned, 'completed');
  await home(); await page.getByRole('navigation').getByRole('button', { name: /任务/ }).click();
  await expect(page.getByRole('region', { name: '已完成任务', exact: true }).getByRole('button')).toHaveCount(1);
  await selectRuntime('Codex CLI');
  assert.equal((await page.evaluate(() => window.orbit.execution.configuration())).settings.runtime, 'codex-cli');
  await page.screenshot({ path: 'artifacts/orbit-execution-settings.png' });

  const input = await save('fixture:input · 收到指定颜色后生成文件');
  await dialog().getByRole('button', { name: '直接执行', exact: true }).click(); await waitStatus(input, 'waiting');
  await dialog().getByRole('textbox', { name: '你的答复' }).fill('blue');
  await dialog().getByRole('button', { name: '发送答复' }).click(); await waitStatus(input, 'review');
  assert.equal((await state(input)).runs[0].questions[0].answer, 'blue');

  const approval = await save('fixture:approval · 需要授权的执行示例');
  await dialog().getByRole('button', { name: '直接执行', exact: true }).click(); await waitStatus(approval, 'waiting');
  await page.screenshot({ path: 'artifacts/orbit-task-approval.png' });
  await dialog().getByRole('button', { name: '拒绝', exact: true }).click(); await waitStatus(approval, 'failed');
  await dialog().getByRole('button', { name: '重试未完成步骤' }).click(); await waitStatus(approval, 'waiting');
  await dialog().getByRole('button', { name: '允许本次操作' }).click(); await waitStatus(approval, 'review');
  const approvalDetail = await state(approval);
  assert.equal(approvalDetail.runs.length, 2);
  assert.equal(approvalDetail.runs[1].nativeSession, approvalDetail.runs[0].nativeSession);
  assert.deepEqual(approvalDetail.runs.flatMap(run => run.questions.map(question => question.answer)), ['deny', 'approve']);

  const canceled = await save('fixture:pause · 后台任务与停止回复相互独立');
  await dialog().getByRole('button', { name: '直接执行', exact: true }).click();
  await expect.poll(async () => (await state(canceled)).events.some(event => event.message === 'fixture started'), { timeout: 20_000 }).toBe(true);
  await home(); await page.getByRole('textbox', { name: '你的需求' }).fill('慢回复');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('正在等待测试中断', { exact: true }).waitFor();
  await page.getByRole('button', { name: '停止回复', exact: true }).click();
  assert.equal((await state(canceled)).task.status, 'running');
  await page.locator('.inline-task').filter({ hasText: 'fixture:pause · 后台任务' }).first().click();
  await dialog().getByRole('button', { name: '取消任务', exact: true }).click(); await waitStatus(canceled, 'canceled');

  const events = await save('fixture:events · 进展分页验证');
  await dialog().getByRole('button', { name: '直接执行', exact: true }).click(); await waitStatus(events, 'review');
  await home(); await page.locator('.inline-task').filter({ hasText: 'fixture:events' }).first().click();
  await expect(dialog().getByRole('button', { name: '加载更早进展' })).toBeVisible();
  assert.equal(await dialog().locator('.task-events li').count(), 100);
  await dialog().getByRole('button', { name: '加载更早进展' }).click();
  await expect.poll(() => dialog().locator('.task-events li').count()).toBeGreaterThan(120);
  await expect(dialog().getByRole('button', { name: '加载更早进展' })).toHaveCount(0);
  const count = await dialog().locator('.task-events li').count(); assert.ok(count > 120);
  await dialog().getByRole('button', { name: '验收通过' }).click(); await waitStatus(events, 'completed');
  await expect(dialog().locator('.task-events li')).toHaveCount(count + 1);
  await dialog().getByRole('button', { name: '关闭任务详情' }).focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'SUMMARY');
  await page.keyboard.press('Tab'); await expect(dialog().getByRole('button', { name: '关闭任务详情' })).toBeFocused();

  const resume = await save('fixture:pause · 完整退出后恢复');
  await dialog().getByRole('button', { name: '直接执行', exact: true }).click();
  await expect.poll(async () => (await state(resume)).events.some(event => event.message === 'fixture started'), { timeout: 20_000 }).toBe(true);
  const nativeSession = (await state(resume)).runs[0].nativeSession;
  await home(); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  assert.equal((await state(resume)).task.status, 'running');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await selectRuntime('Claude Code');
  await app.close(); app = undefined; await launch();
  await waitStatus(resume, 'review');
  const resumed = await state(resume);
  assert.equal(resumed.runs.length, 2); assert.equal(resumed.runs[1].nativeSession, nativeSession);
  assert.equal(resumed.task.execution.selection.runtime, 'codex-cli');
  assert.equal((await page.evaluate(() => window.orbit.execution.configuration())).settings.runtime, 'claude-cli');
  assert.equal(await readFile(join(resumed.task.execution.directory, 'steps/implement/result.txt'), 'utf8'), 'resumed result\n');
  await home(); await page.getByRole('navigation').getByRole('button', { name: /任务/ }).click();
  await page.screenshot({ path: 'artifacts/orbit-task-board-states.png' });
  assert.deepEqual(errors, []);
  console.log('Task UI smoke passed: real Pi DAG, runtime settings, artifacts/acceptance, input/approval/denial/retry, independent cancellation, event paging/focus, hidden-window continuation and restart with original runtime.');
} catch (error) {
  if (app && page) await page.screenshot({ path: 'artifacts/orbit-task-ui-failure.png' }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  await model.close(); await rm(directory, { recursive: true, force: true });
}
