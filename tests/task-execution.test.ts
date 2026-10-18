import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/infrastructure/database';
import { MaterialLibrary } from '../src/domains/materials/library';
import { WorkspaceService } from '../src/application/workspace';
import { ExecutionRepository } from '../src/domains/tasks/execution-repository';
import { TaskExecutionService } from '../src/application/task-execution';
import { TaskFiles } from '../src/infrastructure/tasks/files';
import { validatePlan } from '../src/domains/tasks/plan';
import type { TaskRun } from '../src/domains/tasks/execution';
import type { TaskRuntimeEvent, TaskRuntimeInput, TaskRuntimeOutcome, TaskRuntimePort } from '../src/domains/tasks/runtime';

class Runtime implements TaskRuntimePort {
  started: Array<{ input: TaskRuntimeInput; event: (event: TaskRuntimeEvent) => void; tool: (name: string, args: unknown, id: string) => Promise<unknown>; finish: (outcome: TaskRuntimeOutcome) => void }> = [];
  reconciled: string[] = [];
  unresolved = false;
  preflight = async () => {};
  reconcile = async (run: TaskRun) => { if (this.unresolved) throw new Error('旧进程尚无法确认停止'); this.reconciled.push(run.id); };
  start(input: TaskRuntimeInput, event: (event: TaskRuntimeEvent) => void, tool: (name: string, args: unknown, id: string) => Promise<unknown>) {
    let finish!: (outcome: TaskRuntimeOutcome) => void;
    const done = new Promise<TaskRuntimeOutcome>(resolve => { finish = resolve; });
    this.started.push({ input, event, tool, finish });
    return { done, stop: async () => { finish({ status: 'interrupted' }); } };
  }
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(check(), 'condition did not become true');
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-execution-'));
  const db = openDatabase(join(directory, 'orbit.sqlite'));
  const materials = new MaterialLibrary(db, join(directory, 'attachments'));
  const workspace = new WorkspaceService(db, materials);
  const repository = new ExecutionRepository(db);
  const files = new TaskFiles(join(directory, 'tasks'), materials);
  const runtime = new Runtime();
  const service = new TaskExecutionService(repository, files, runtime, () => ({ runtime: repository.settings().runtime }));
  await service.start();
  return { directory, db, repository, files, runtime, service,
    task: () => workspace.saveRequest({ requestId: randomUUID(), text: '分析资料并生成文件', attachmentIds: [] }),
    cleanup: async () => { await service.close(); db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('plans reject cycles, unknown dependencies, duplicate IDs and unsafe directory names', () => {
  const step = { id: 'analyze', instruction: '分析', dependsOn: [] };
  for (const steps of [[step, step], [{ ...step, id: '../escape' }], [{ ...step, dependsOn: ['missing'] }], [{ ...step, dependsOn: ['analyze'] }]]) {
    assert.throws(() => validatePlan({ steps }));
  }
  assert.throws(() => validatePlan({ steps: [step, { id: 'build', instruction: '制作', dependsOn: ['analyze', 'analyze'] }] }));
});

test('dispatch is idempotent; turn completion alone never completes a task; retry preserves the step', async () => {
  const f = await fixture();
  try {
    const task = f.task();
    await Promise.all([f.service.dispatch(task.id, 'direct'), f.service.dispatch(task.id, 'direct')]);
    await until(() => f.runtime.started.length === 1);
    f.runtime.started[0].event({ type: 'session', sessionId: 'native-one' });
    f.runtime.started[0].finish({ status: 'completed' });
    await until(() => f.service.detail(task.id).task.status === 'failed');
    assert.match(f.service.detail(task.id).steps[0].error!, /未通过工具/);
    await f.service.retry(task.id); await until(() => f.runtime.started.length === 2);
    const resumed = f.runtime.started[1];
    assert.equal(resumed.input.resumeSession, 'native-one');
    assert.equal(resumed.input.run.stepId, 'implement');
    writeFileSync(join(resumed.input.directory, 'result.txt'), 'verified result');
    const args = { summary: '已生成文件', artifacts: ['result.txt'] };
    const result = await resumed.tool('submit_result', args, 'result-1');
    assert.deepEqual(await resumed.tool('submit_result', args, 'result-1'), result);
    assert.equal(f.service.detail(task.id).task.status, 'running');
    resumed.finish({ status: 'completed' });
    await until(() => f.service.detail(task.id).task.status === 'review');
    assert.equal(f.service.accept(task.id).task.status, 'completed');
    assert.equal(f.service.detail(task.id).runs.length, 2);
  } finally { await f.cleanup(); }
});

test('planner commits fixed DAG; ready branches run concurrently and a join waits for all dependencies', async () => {
  const f = await fixture();
  try {
    const task = f.task(); await f.service.dispatch(task.id, 'plan'); await until(() => f.runtime.started.length === 1);
    const plan = { steps: [
      { id: 'research', name: '调研', instruction: '收集资料', dependsOn: [] },
      { id: 'analyze', name: '分析', instruction: '分析资料', dependsOn: [] },
      { id: 'summarize', name: '汇总', instruction: '汇总上游', dependsOn: ['research', 'analyze'] },
    ] };
    await f.runtime.started[0].tool('submit_plan', plan, 'plan');
    assert.equal(f.service.detail(task.id).steps.length, 1);
    f.runtime.started[0].finish({ status: 'completed' }); await until(() => f.runtime.started.length === 3);
    assert.equal(JSON.parse(readFileSync(join(f.files.taskDirectory(task.id), 'plan.json'), 'utf8')).steps.length, 3);
    for (const run of f.runtime.started.slice(1, 3)) await run.tool('submit_result', { summary: run.input.run.stepId, artifacts: [] }, 'result');
    f.runtime.started[1].finish({ status: 'completed' }); await until(() => f.service.detail(task.id).steps[1].status === 'completed');
    assert.equal(f.runtime.started.length, 3);
    f.runtime.started[2].finish({ status: 'completed' }); await until(() => f.runtime.started.length === 4);
    assert.match(f.runtime.started[3].input.prompt, /research/);
    assert.match(f.runtime.started[3].input.prompt, /analyze/);
    await assert.rejects(f.runtime.started[3].tool('submit_plan', plan, 'replan'), /不支持/);
    await f.runtime.started[3].tool('submit_result', { summary: '汇总完成', artifacts: [] }, 'result');
    f.runtime.started[3].finish({ status: 'completed' }); await until(() => f.service.detail(task.id).task.status === 'review');
  } finally { await f.cleanup(); }
});

test('cancellation fences late tools and events; a submitted candidate cannot win over cancellation', async () => {
  const f = await fixture();
  try {
    const task = f.task(); await f.service.dispatch(task.id, 'direct'); await until(() => f.runtime.started.length === 1);
    const run = f.runtime.started[0];
    await run.tool('submit_result', { summary: '候选结果', artifacts: [] }, 'result');
    await f.service.cancel(task.id);
    await assert.rejects(run.tool('report_progress', { message: '迟到' }, 'late'), /已停止/);
    const before = f.service.detail(task.id); run.event({ type: 'activity', message: '迟到事件' });
    assert.deepEqual(f.service.detail(task.id), before);
    assert.equal(before.task.status, 'canceled');
    assert.equal(before.steps[0].result, undefined);
  } finally { await f.cleanup(); }
});

test('artifact containment and hashes reject escaping symlinks and changed submissions', async () => {
  const f = await fixture();
  try {
    const task = f.task(); await f.service.dispatch(task.id, 'direct'); await until(() => f.runtime.started.length === 1);
    const run = f.runtime.started[0]; const outside = join(f.directory, 'outside.txt'); writeFileSync(outside, 'outside');
    symlinkSync(outside, join(run.input.directory, 'escape.txt'));
    await assert.rejects(run.tool('submit_result', { summary: '越界', artifacts: ['escape.txt'] }, 'escape'), /越界/);
    writeFileSync(join(run.input.directory, 'result.txt'), 'first');
    await run.tool('submit_result', { summary: '成果', artifacts: ['result.txt'] }, 'result');
    writeFileSync(join(run.input.directory, 'result.txt'), 'changed');
    run.finish({ status: 'completed' }); await until(() => f.service.detail(task.id).task.status === 'failed');
    assert.match(f.service.detail(task.id).steps[0].error!, /发生变化/);
  } finally { await f.cleanup(); }
});

test('questions persist, stop for shutdown, and resume automatically only after the missing answer', async () => {
  const f = await fixture();
  let restarted: TaskExecutionService | undefined;
  try {
    const task = f.task(); await f.service.dispatch(task.id, 'direct'); await until(() => f.runtime.started.length === 1);
    const question = f.runtime.started[0].tool('request_input', { question: '需要哪种格式？' }, 'question').catch(error => error);
    await until(() => f.service.detail(task.id).task.status === 'waiting');
    const questionId = f.service.detail(task.id).runs[0].questions[0].id;
    await f.service.close(); await question;
    const runtime = new Runtime(); restarted = new TaskExecutionService(f.repository, f.files, runtime, () => ({ runtime: 'pi' }));
    await restarted.start(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(runtime.started.length, 0);
    restarted.answer(task.id, questionId, 'Markdown'); await until(() => runtime.started.length === 1);
    assert.match(runtime.started[0].input.prompt, /Markdown/);
    assert.equal(runtime.started[0].input.run.attempt, 2);
  } finally { await restarted?.close(); await f.cleanup(); }
});

test('crash recovery reconciles old process before auto-resume; unresolved processes keep their capacity', async () => {
  const f = await fixture(); let restarted: TaskExecutionService | undefined;
  try {
    const task = f.task(); await f.service.dispatch(task.id, 'direct'); await until(() => f.runtime.started.length === 1);
    await f.service.close();
    const old = f.repository.runs(task.id)[0]; old.status = 'running'; old.workerPid = 9999; old.workerIdentity = old.id;
    f.repository.saveRun(old);
    const step = f.repository.steps(task.id)[0]; step.status = 'running'; f.repository.saveStep(step);
    const runtime = new Runtime(); runtime.unresolved = true;
    restarted = new TaskExecutionService(f.repository, f.files, runtime, () => ({ runtime: 'pi' })); restarted.configure({ runtime: 'pi', maxConcurrency: 1 });
    await restarted.start(); const another = f.task(); await restarted.dispatch(another.id, 'direct');
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(runtime.started.length, 0);
    runtime.unresolved = false; await restarted.retry(task.id); await until(() => runtime.started.length === 1);
    assert.deepEqual(runtime.reconciled, [old.id]); assert.equal(runtime.started[0].input.run.attempt, 2);
  } finally { await restarted?.close(); await f.cleanup(); }
});

test('failure retry retains completed branches and a settings change only affects new dispatches', async () => {
  const f = await fixture();
  try {
    const task = f.task(); await f.service.dispatch(task.id, 'plan'); await until(() => f.runtime.started.length === 1);
    await f.runtime.started[0].tool('submit_plan', { steps: [
      { id: 'first', instruction: '第一步', dependsOn: [] }, { id: 'second', instruction: '第二步', dependsOn: ['first'] },
    ] }, 'plan');
    f.runtime.started[0].finish({ status: 'completed' }); await until(() => f.runtime.started.length === 2);
    await f.runtime.started[1].tool('submit_result', { summary: '已完成', artifacts: [] }, 'result');
    f.runtime.started[1].finish({ status: 'completed' }); await until(() => f.runtime.started.length === 3);
    f.runtime.started[2].finish({ status: 'failed', error: '临时失败' }); await until(() => f.service.detail(task.id).task.status === 'failed');
    f.service.configure({ runtime: 'codex-cli', maxConcurrency: 2 }); await f.service.retry(task.id); await until(() => f.runtime.started.length === 4);
    assert.equal(f.runtime.started[3].input.run.stepId, 'second'); assert.equal(f.runtime.started[3].input.run.selection.runtime, 'pi');
    assert.equal(f.service.detail(task.id).steps.find(step => step.id === 'first')?.status, 'completed');
  } finally { await f.cleanup(); }
});
