import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/infrastructure/database';
import { MaterialLibrary } from '../src/domains/materials/library';
import { WorkspaceService } from '../src/application/workspace';
import { ExecutionRepository } from '../src/domains/tasks/execution-repository';
import { TaskExecutionService } from '../src/application/task-execution';
import { TaskFiles } from '../src/infrastructure/tasks/files';
import { ExecutionRuntimeHost } from '../src/infrastructure/execution/host';
import { alive, groupMembers } from '../src/infrastructure/execution/process';
import type { ExecutionRuntime } from '../src/domains/tasks/execution';
import type { ModelProfile } from '../src/domains/models/model';
import { environmentProfile } from '../src/infrastructure/models/environment';
import { createModelServer } from './fixtures/model-server';

let workers: string;
before(async () => {
  mkdirSync('node_modules/.cache', { recursive: true });
  workers = mkdtempSync(resolve('node_modules/.cache/orbit-execution-'));
  await build({ entryPoints: ['src/desktop/task-worker.ts', 'src/desktop/task-mcp.ts'], outdir: workers, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' });
});
after(() => rmSync(workers, { recursive: true, force: true }));
async function until(check: () => boolean, description = 'runtime state') {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.ok(check(), description);
}
function fixture(runtime: ExecutionRuntime, model?: ModelProfile) {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-runtime-'));
  const executable = join(directory, 'native-cli');
  copyFileSync('tests/fixtures/execution-cli.mjs', executable); chmodSync(executable, 0o700);
  const db = openDatabase(join(directory, 'orbit.sqlite'));
  const materials = new MaterialLibrary(db, join(directory, 'attachments'));
  const workspace = new WorkspaceService(db, materials);
  const repository = new ExecutionRepository(db);
  const files = new TaskFiles(join(directory, 'tasks'), materials);
  const host = new ExecutionRuntimeHost({ worker: join(workers, 'task-worker.mjs'), mcpBridge: join(workers, 'task-mcp.mjs'), model: () => model ?? null, credential: () => model ? { apiKey: 'local-test-only' } : undefined,
    env: { ...process.env, ORBIT_CODEX_PATH: executable, ORBIT_CLAUDE_PATH: executable } });
  const service = () => new TaskExecutionService(repository, files, host, () => ({ runtime, model }));
  return { directory, db, host, repository, files, service, task: (text: string) => workspace.saveRequest({ requestId: randomUUID(), text, attachmentIds: [] }),
    cleanup: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
for (const runtime of ['codex-cli', 'claude-cli'] as const) {
  test(runtime + ' executes a planned DAG through child IPC and native tools, including explicit approval', { timeout: 60_000 }, async () => {
    const f = fixture(runtime); const service = f.service();
    try {
      assert.equal((await f.host.availability()).find(item => item.runtime === runtime)?.available, true);
      await service.start(); const task = f.task('fixture:approval'); await service.dispatch(task.id, 'plan');
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const detail = service.detail(task.id);
        for (const question of detail.runs.flatMap(run => run.questions).filter(q => q.status === 'pending')) service.answer(task.id, question.id, 'approve');
        if (['review', 'failed'].includes(detail.task.status)) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const detail = service.detail(task.id);
      assert.equal(detail.task.status, 'review', JSON.stringify(detail));
      assert.equal(detail.steps.length, 4);
      assert.equal(detail.runs.length, 4);
      assert.ok(detail.runs.every(run => run.nativeSession && run.workerPid && run.workerIdentity));
      assert.equal(detail.runs.flatMap(run => run.questions).filter(q => q.answer === 'approve').length, 4);
      for (const run of detail.runs) assert.deepEqual(await groupMembers(run.workerPid!), []);
      assert.equal(readFileSync(service.artifact(task.id, 'steps/combine/result.txt'), 'utf8'), 'verified result\n');
      assert.equal(service.accept(task.id).task.status, 'completed');
    } finally { await service.close(); f.cleanup(); }
  });
  test(runtime + ' persists native identity, resumes after full shutdown, and cancels without descendants', { timeout: 60_000 }, async () => {
    const f = fixture(runtime); const first = f.service(); let second: TaskExecutionService | undefined;
    try {
      await first.start(); const task = f.task('fixture:pause'); await first.dispatch(task.id, 'direct');
      await until(() => first.detail(task.id).events.some(event => event.message === 'fixture started'));
      const old = first.detail(task.id).runs[0];
      await first.close(); assert.deepEqual(await groupMembers(old.workerPid!), []);
      second = f.service(); await second.start();
      await until(() => ['review', 'failed'].includes(second!.detail(task.id).task.status));
      const detail = second.detail(task.id);
      assert.equal(detail.task.status, 'review', JSON.stringify(detail));
      assert.equal(detail.runs.length, 2);
      assert.equal(detail.runs[1].nativeSession, old.nativeSession);
      assert.equal(readFileSync(second.artifact(task.id, 'steps/implement/result.txt'), 'utf8'), 'resumed result\n');
      const canceled = f.task('fixture:pause'); await second.dispatch(canceled.id, 'direct');
      await until(() => second!.detail(canceled.id).events.some(event => event.message === 'fixture started'));
      await second.cancel(canceled.id);
      const run = second.detail(canceled.id).runs[0];
      assert.equal(second.detail(canceled.id).task.status, 'canceled');
      assert.deepEqual(await groupMembers(run.workerPid!), []);
    } finally { await second?.close(); await first.close(); f.cleanup(); }
  });
  test(runtime + ' waits for persisted user input and rejects a successful exit without submit_result', { timeout: 60_000 }, async () => {
    const f = fixture(runtime); const service = f.service();
    try {
      await service.start(); const input = f.task('fixture:input'); await service.dispatch(input.id, 'direct');
      await until(() => service.detail(input.id).task.status === 'waiting');
      service.answer(input.id, service.detail(input.id).runs[0].questions[0].id, 'blue');
      await until(() => service.detail(input.id).task.status === 'review');
      const missing = f.task('fixture:missing'); await service.dispatch(missing.id, 'direct');
      await until(() => service.detail(missing.id).task.status === 'failed');
      assert.match(service.detail(missing.id).runs[0].error!, /未通过工具/);
    } finally { await service.close(); f.cleanup(); }
  });
}
test('Claude success result followed by nonzero process exit cannot complete the business step', { timeout: 30_000 }, async () => {
  const f = fixture('claude-cli'); const service = f.service();
  try {
    await service.start(); const task = f.task('fixture:bad-exit'); await service.dispatch(task.id, 'direct');
    await until(() => ['failed', 'review'].includes(service.detail(task.id).task.status));
    assert.equal(service.detail(task.id).task.status, 'failed');
  } finally { await service.close(); f.cleanup(); }
});

test('Pi SDK uses real filesystem tools and independent native sessions for a planned DAG', { timeout: 60_000 }, async () => {
  const provider = await createModelServer(); const f = fixture('pi', environmentProfile(provider.env)!); const service = f.service();
  try {
    await service.start(); const task = f.task('Pi 规划和执行任务'); await service.dispatch(task.id, 'plan');
    await until(() => ['review', 'failed'].includes(service.detail(task.id).task.status));
    const detail = service.detail(task.id);
    assert.equal(detail.task.status, 'review', JSON.stringify(detail));
    assert.equal(new Set(detail.runs.map(run => run.nativeSession)).size, 4);
    assert.equal(readFileSync(service.artifact(task.id, 'steps/combine/result.txt'), 'utf8'), 'Pi SDK verified result\n');
    assert.ok(provider.requests.some(request => JSON.stringify(request).includes('steps/research/result.txt')));
    assert.ok(provider.authorizations.every(value => value === 'Bearer local-test-only'));
  } finally { await service.close(); f.cleanup(); await provider.close(); }
});

test('a killed Pi worker cannot leave its active shell command running', { timeout: 30_000 }, async () => {
  const provider = await createModelServer(); const f = fixture('pi', environmentProfile(provider.env)!); const service = f.service();
  try {
    await service.start(); const task = f.task('fixture:shell'); await service.dispatch(task.id, 'direct');
    const pidFile = join(f.files.stepDirectory(task.id, 'implement'), 'shell.pid');
    await until(() => existsSync(pidFile));
    const shellPid = Number(readFileSync(pidFile, 'utf8').trim());
    const workerPid = service.detail(task.id).runs[0].workerPid!;
    process.kill(workerPid, 'SIGKILL');
    await until(() => service.detail(task.id).task.status === 'failed');
    assert.equal(alive(shellPid), false); assert.deepEqual(await groupMembers(workerPid), []);
  } finally { await service.close(); f.cleanup(); await provider.close(); }
});
