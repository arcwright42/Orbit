import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { openDatabase } from '../src/infrastructure/database';
import { MaterialLibrary } from '../src/domains/materials/library';
import { WorkspaceService } from '../src/application/workspace';
import { TaskExecutionService } from '../src/application/task-execution';
import type { ExecutionPort } from '../src/domains/runtime/execution-port';
import type { Seat } from '../src/domains/teams/registry';
import type { ExecutionResult } from '../src/domains/orchestration/types';
async function setup(factory: (seat: Seat) => ExecutionPort) {
  const root = await mkdtemp(join(tmpdir(), 'orbit-execution-test-')); const db = openDatabase(join(root, 'orbit.sqlite'));
  const materials = new MaterialLibrary(db, join(root, 'attachments')), workspace = new WorkspaceService(db, materials);
  const service = new TaskExecutionService(db, materials, root, () => {}, undefined, factory);
  const team = service.createTeam('test');
  const task = (requestId: string) => workspace.submit({ requestId, text: requestId, attachmentIds: [] }).tasks.find(t => t.requestId === requestId)!;
  return { root, service, workspace, team, task, async close() { await service.close(); db.close(); await rm(root, { recursive: true, force: true }); } };
}
async function until(check: () => Promise<boolean>) { for (let n = 0; n < 100; n++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('condition timeout'); }

test('real application dispatch is deduplicated, task sessions isolated, builder review and user acceptance distinct', async () => {
  const executions: Seat[] = []; let registrations = 0;
  const env = await setup(seat => { registrations++; return ({ async execute() { executions.push(seat); const evidenceRef = join(seat.workspace, 'evidence.json'); await writeFile(evidenceRef, JSON.stringify({ summary: seat.role, artifacts: [], verdict: 'pass' })); return { kind: 'completed', summary: seat.role, evidenceRef }; }, async cancel() { return true; } }); });
  try {
    const first = env.task('first-test-request');
    const attempts = await Promise.allSettled([env.service.dispatch(first.id, env.team.id), env.service.dispatch(first.id, env.team.id)]);
    assert.equal(registrations, 2);
    assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
    await until(async () => { await env.service.sync(); return env.workspace.snapshot().tasks.find(t => t.id === first.id)?.status === 'review'; });
    assert.deepEqual(executions.map(s => s.role), ['builder', 'reviewer']);
    env.service.accept(first.id); assert.equal(env.workspace.snapshot().tasks[0].status, 'completed');
    await env.service.cancel(first.id); assert.equal(env.workspace.snapshot().tasks[0].status, 'completed');
    const second = env.task('second-test-request'); await env.service.dispatch(second.id, env.team.id);
    await until(async () => { await env.service.sync(); return env.workspace.snapshot().tasks.find(t => t.id === second.id)?.status === 'review'; });
    assert.notEqual(executions[0].sessionId, executions[2].sessionId); assert.notEqual(executions[0].workspace, executions[2].workspace);
    assert.equal(executions[0].workspace, executions[1].workspace);
  } finally { await env.close(); }
});

test('answer resumes the same task session and cancellation stops pending continuation', async () => {
  let count = 0; const sessions: string[] = [];
  const env = await setup(seat => ({ async execute(_item, signal) { sessions.push(seat.sessionId); if (seat.role === 'reviewer') return new Promise(resolve => signal.addEventListener('abort', () => resolve({ kind: 'canceled', reason: 'stopped' }), { once: true })); if (++count === 1) return { kind: 'question', question: 'Which output?' }; const evidenceRef = join(seat.workspace, 'result.json'); await writeFile(evidenceRef, JSON.stringify({ summary: 'done', artifacts: [] })); return { kind: 'completed', summary: 'done', evidenceRef }; }, async cancel() { return true; } }));
  try {
    const task = env.task('question-test-request'); await env.service.dispatch(task.id, env.team.id);
    await until(async () => { await env.service.sync(); return !!env.service.detail(task.id)?.question; });
    env.service.answer(task.id, 'a text document');
    await until(async () => env.service.queue.list().some(i => i.state === 'done'));
    await env.service.cancel(task.id); await env.service.sync();
    assert.equal(sessions[0], sessions[1]); assert.equal(env.workspace.snapshot().tasks[0].status, 'canceled');
    assert.ok(env.service.queue.list().every(i => ['done','canceled'].includes(i.state)));
  } finally { await env.close(); }
});

test('shutdown waits for dispatch and cancellation; close is idempotent', async () => {
  let settle: ((value: ExecutionResult) => void) | undefined;
  const env = await setup(() => ({ execute: (_item, signal) => new Promise(resolve => { settle = resolve; signal.addEventListener('abort', () => resolve({ kind: 'canceled', reason: 'process exited' }), { once: true }); }), async cancel() { settle?.({ kind: 'canceled', reason: 'process exited' }); return true; } }));
  try {
    const task = env.task('close-test-request'); await env.service.dispatch(task.id, env.team.id); await Promise.resolve();
    const a = env.service.close(), b = env.service.close(); assert.equal(a, b); await a;
  } finally { await env.close(); }
});

test('invalid evidence is visible and does not block projection of other tasks', async () => {
  const env = await setup(seat => ({ async execute(item) { const evidenceRef = join(seat.workspace, 'evidence.json'); await writeFile(evidenceRef, item.body.includes('invalid-test') ? 'invalid' : JSON.stringify({ summary: 'valid', artifacts: [], verdict: 'pass' })); return { kind: 'completed', summary: 'done', evidenceRef }; }, async cancel() { return true; } }));
  try {
    const bad = env.task('invalid-test-request'), good = env.task('valid-test-request');
    await env.service.dispatch(bad.id, env.team.id); await env.service.dispatch(good.id, env.team.id);
    await until(async () => { await env.service.sync(); const tasks = env.workspace.snapshot().tasks; return tasks.find(t => t.id === bad.id)?.status === 'failed' && tasks.find(t => t.id === good.id)?.status === 'review'; });
    assert.match(env.workspace.snapshot().tasks.find(t => t.id === bad.id)!.executionSummary!, /核验失败/);
  } finally { await env.close(); }
});

test('native Codex adapter preparation failure is recoverable and never reported as unknown process', async () => {
  const { CodexRuntime } = await import('../src/domains/runtime/codex');
  const env = await setup(() => ({ async execute() { return { kind: 'failed', reason: 'unused' }; }, async cancel() { return false; } }));
  try {
    const task = env.task('prepare-test-request'); const seat = env.service.teams.taskSeats(env.team.id, task.id)[0];
    const adapter = new CodexRuntime(env.service.teams, seat.sessionId, join(env.root, 'evidence'), () => {}, async () => { throw Error('invalid context'); });
    const item = env.service.queue.enqueue({ requestId: 'prepare-failure', taskId: task.id, source: 'foreground', destination: seat.sessionId, body: 'test' });
    const result = await adapter.execute({ ...item, generation: 'test' }, new AbortController().signal);
    assert.deepEqual(result, { kind: 'blocked', blockedOn: 'context:preparation', reason: 'invalid context' });
  } finally { await env.close(); }
});

test('cancel before result commit prevents successor creation', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
  const env = await setup(seat => ({ async execute() {
    const evidenceRef = join(seat.workspace, 'result.json');
    await writeFile(evidenceRef, JSON.stringify({ summary: 'done', artifacts: [], verdict: 'pass' })); entered(); await gate;
    return { kind: 'completed', summary: 'done', evidenceRef };
  }, async cancel() { release(); return true; } }));
  try {
    const task = env.task('handoff-cancel-request'); await env.service.dispatch(task.id, env.team.id); await ready;
    await env.service.cancel(task.id); await env.service.sync();
    assert.equal(env.workspace.snapshot().tasks[0].status, 'canceled');
    assert.equal(env.service.queue.list().length, 1);
  } finally { release(); await env.close(); }
});
