import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Explicit online test. Uses the installed CLI's login or Pi's read-only Codex provider.
// The test writes only to disposable Orbit task directories and native CLI session history.
const runtime = process.argv[2] ?? 'codex-cli';
assert.ok(['pi', 'codex-cli', 'claude-cli'].includes(runtime));
const directory = await mkdtemp(join(tmpdir(), 'orbit-task-live-'));
const marker = 'ORBIT_TASK_' + randomUUID().slice(0, 8);
const env = { ...process.env, ORBIT_DATA_DIR: directory,
  ORBIT_AGENT_PROVIDER: '', ORBIT_AGENT_MODEL: '', ORBIT_AGENT_BASE_URL: '', ORBIT_AGENT_API_KEY: '' };
delete env.ELECTRON_RUN_AS_NODE; delete env.ORBIT_DEV_URL;
const report = { runtime, testedAt: new Date().toISOString(), checks: {}, passed: false };
let app;
try {
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.orbit));
  if (runtime === 'pi') {
    const modelId = process.env.ORBIT_CODEX_SMOKE_MODEL ?? 'gpt-6.1-sol';
    const state = await page.evaluate(modelId => window.orbit.models.save({ name: 'Task live smoke', source: 'codex-local', providerId: 'openai-codex', modelId }), modelId);
    await page.evaluate(id => window.orbit.models.activate(id), state.profiles[0].id);
    report.checks.model = modelId;
  }
  const configuration = await page.evaluate(runtime => window.orbit.execution.configure({ runtime, maxConcurrency: 2 }), runtime);
  assert.equal(configuration.runtimes.find(value => value.runtime === runtime)?.available, true, 'Selected runtime must be available');
  const workspace = await page.evaluate(({ marker }) => window.orbit.submit({ requestId: marker, attachmentIds: [],
    text: '这是隔离目录中的执行验收。直接完成一个小任务：在当前步骤工作目录创建 result.txt，内容必须只有 ' + marker + ' 加一个换行。不要联网、不要安装依赖、不要读取个人文件。先 report_progress，再用本地写文件工具创建文件，最后 submit_result 提交 result.txt，结束回复。' }), { marker });
  const taskId = workspace.tasks[0].id;
  await page.evaluate(id => window.orbit.execution.dispatch(id, 'direct'), taskId);
  await expect.poll(async () => {
    const detail = await page.evaluate(id => window.orbit.execution.detail(id), taskId);
    return ['review', 'failed', 'waiting', 'interrupted'].includes(detail.task.status);
  }, { timeout: 180_000, intervals: [200, 500, 1000] }).toBe(true);
  const detail = await page.evaluate(id => window.orbit.execution.detail(id), taskId);
  report.checks.status = detail.task.status;
  report.checks.progressTools = detail.events.filter(event => event.type === 'step.progress').length;
  report.checks.nativeSession = Boolean(detail.runs[0].nativeSession);
  report.checks.error = detail.runs[0].error;
  assert.equal(detail.task.status, 'review', 'Live task must reach review: ' + (detail.runs[0].error ?? detail.task.status));
  assert.ok(report.checks.progressTools > 0);
  assert.equal(await readFile(join(detail.task.execution.directory, 'steps/implement/result.txt'), 'utf8'), marker + '\n');
  assert.equal(detail.steps[0].result.artifacts[0].path, 'steps/implement/result.txt');
  await page.evaluate(id => window.orbit.execution.accept(id), taskId);
  report.checks.artifactVerified = true; report.checks.accepted = true;
  await app.close(); app = undefined;
  app = await electron.launch({ args: ['.'], env });
  const reopened = await app.firstWindow(); await reopened.waitForFunction(() => Boolean(window.orbit));
  const restored = await reopened.evaluate(id => window.orbit.execution.detail(id), taskId);
  assert.equal(restored.task.status, 'completed'); assert.equal(restored.runs.length, 1);
  report.checks.restartDidNotReplay = true; report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Live task failed'; process.exitCode = 1;
} finally {
  if (app) await app.close();
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/task-live-' + runtime + '.json', JSON.stringify(report, null, 2) + '\n');
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
