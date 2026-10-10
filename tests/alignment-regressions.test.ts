import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/infrastructure/database';
import { openCoreDatabase } from '../src/infrastructure/core-database';
import { ExecutionQueue } from '../src/domains/orchestration/queue';
import { Watchdog } from '../src/domains/orchestration/watchdog';
import { TaskExecutionService } from '../src/application/task-execution';
import { WorkspaceService } from '../src/application/workspace';
import { MaterialLibrary } from '../src/domains/materials/library';
import { defaultTeamConfig, validateTeamConfig, type TeamConfig } from '../src/domains/workflows/spec';
import type { ExecutionPort } from '../src/domains/runtime/execution-port';
import type { Seat } from '../src/domains/teams/registry';
import type { QueueItem } from '../src/domains/orchestration/types';

async function fixture(factory: (seat: Seat) => ExecutionPort, config = structuredClone(defaultTeamConfig)) {
  const root = await mkdtemp(join(tmpdir(), 'orbit-alignment-'));
  const db = openDatabase(join(root, 'orbit.sqlite'));
  const materials = new MaterialLibrary(db, join(root, 'files'));
  const workspace = new WorkspaceService(db, materials);
  const service = new TaskExecutionService(db, materials, root, () => {}, undefined, factory);
  const team = service.createTeam('audit', config);
  const task = () => { const requestId = randomUUID(); return workspace.submit({ requestId, text: 'isolated work', attachmentIds: [] }).tasks.find(t => t.requestId === requestId)!; };
  return { root, db, workspace, service, team, task, async close() { await service.close(); db.close(); await rm(root, { recursive: true, force: true }); } };
}
async function completed(seat: Seat, item: QueueItem, extra = {}) {
  const evidenceRef = join(seat.workspace, `${item.id}-${item.generation}.json`);
  await writeFile(evidenceRef, JSON.stringify({ summary: 'verified', artifacts: [], verdict: 'pass', recap: '## Decisions\nReceipt', lessons: '', ...extra }));
  return { kind: 'completed' as const, summary: 'verified', evidenceRef };
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out');
}

test('an old external timer cannot release a later user question, auth gate or unrelated wait', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-timer-'));
  const db = openCoreDatabase(join(root, 'core.sqlite')), q = new ExecutionQueue(db);
  try {
    for (const blockedOn of ['human:user', 'auth:codex', 'external:different']) {
      q.enqueue({ requestId: blockedOn, taskId: 'task', source: 'user', destination: 'seat', body: 'work' });
      const first = q.claimNext(['seat'], 1)!;
      q.finish(first.id, first.generation!, { kind: 'blocked', blockedOn: 'external:dependency', reason: 'waiting', wakeAfterSeconds: 1 });
      q.wakeDue(Date.now() + 2000);
      const second = q.claimNext(['seat'], 1)!;
      q.finish(second.id, second.generation!, blockedOn === 'human:user' ? { kind: 'question', question: 'Required information?' } : { kind: 'blocked', blockedOn, reason: 'new blocker' });
      assert.equal(q.wakeDue(Date.now() + 3000), 0, blockedOn);
      assert.equal(q.get(second.id).blockedOn, blockedOn);
    }
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test('legacy timer migration restores a proven paused wait and drops a timer with no matching closure',()=>{
  const db=openCoreDatabase(':memory:');let q=new ExecutionQueue(db);
  try {
    db.exec('CREATE TABLE workflow_transitions (seq INTEGER PRIMARY KEY,item_id TEXT,payload TEXT)');
    const parked=(id:string,blocker:string)=>{q.enqueue({requestId:id,taskId:id,source:'user',destination:id,body:'work'});const item=q.claimNext([id],2)!;const result={kind:'blocked' as const,blockedOn:blocker,reason:'wait',wakeAfterSeconds:1};q.finish(item.id,item.generation!,result);return {item,result};};
    const paused=parked('paused','external:original'),stale=parked('stale','external:different');
    db.prepare('INSERT INTO workflow_transitions(item_id,payload) VALUES (?,?)').run(paused.item.id,JSON.stringify({result:paused.result}));
    db.prepare('INSERT INTO workflow_transitions(item_id,payload) VALUES (?,?)').run(stale.item.id,JSON.stringify({result:{kind:'blocked',blockedOn:'external:different',reason:'new blocker without deadline'}}));
    q.pauseStopped(paused.item.id);db.exec('ALTER TABLE queue_wakes DROP COLUMN blocker');
    q=new ExecutionQueue(db);q.resumePaused(paused.item.id);
    assert.equal(q.wakeDue(Date.now()+2000),1);
    assert.equal(q.get(paused.item.id).state,'pending');assert.equal(q.get(stale.item.id).blockedOn,'external:different');
  } finally {db.close();}
});

test('revise clears review immediately; acceptance checks the live frontier even with a stale task projection', async () => {
  let builds = 0, release!: () => void;
  const gate = new Promise<void>(r => release = r);
  const env = await fixture(seat => ({ async execute(item) { if (seat.role === 'builder' && ++builds === 2) await gate; return completed(seat, item); }, async cancel() { release(); return true; } }));
  try {
    const t = env.task(); await env.service.dispatch(t.id, env.team.id);
    await until(async () => { await env.service.sync(); return env.workspace.snapshot().tasks[0].status === 'review'; });
    await env.service.revise(t.id, 'Revise the result');
    await until(async () => builds === 2); await env.service.sync();
    assert.equal(env.workspace.snapshot().tasks[0].status, 'running');
    assert.throws(() => env.service.accept(t.id));
    const stale = { ...env.workspace.snapshot().tasks[0], status: 'review' };
    env.db.prepare('UPDATE tasks SET payload=? WHERE id=?').run(JSON.stringify(stale), t.id);
    assert.throws(() => env.service.accept(t.id));
    await env.service.sync(); assert.equal(env.workspace.snapshot().tasks[0].status, 'running');
    release(); await until(async () => { await env.service.sync(); return env.workspace.snapshot().tasks[0].status === 'review'; });
    env.service.accept(t.id); assert.equal(env.workspace.snapshot().tasks[0].status, 'completed');
  } finally { release(); await env.close(); }
});

test('reviewer reported failure follows the authored failed mapping', async () => {
  let reviews = 0; const calls: string[] = [];
  const env = await fixture(seat => ({ async execute(item) { calls.push(seat.role); if (seat.role === 'reviewer' && reviews++ === 0) return { kind: 'failed', reason: 'Recoverable review failure' }; return completed(seat, item); }, async cancel() { return true; } }));
  try {
    const t = env.task(); await env.service.dispatch(t.id, env.team.id);
    await until(async () => { await env.service.sync(); return env.workspace.snapshot().tasks[0].status === 'review'; });
    assert.deepEqual(calls, ['builder', 'reviewer', 'builder', 'reviewer']);
  } finally { await env.close(); }
});

test('workflow refuses non-finishing steps and unreachable wait deadlines as upstream does', () => {
  const c: TeamConfig = { members: [{ role: 'worker', name: 'worker', instructions: 'work' }], edges: [], workflow: { entry: 'one', max_hops: 3, steps: [{ id: 'one', actor_role: 'worker', objective: 'one', allowed_exits: ['waiting'] }] } };
  assert.throws(() => validateTeamConfig(c), /step_cannot_finish/);
  c.workflow.steps[0].allowed_exits = ['done']; c.workflow.steps[0].re_present_after_seconds = 5;
  assert.throws(() => validateTeamConfig(c), /waiting_re_presentation_unreachable/);
  c.workflow.steps[0].allowed_exits = ['waiting']; c.workflow.steps[0].next_hop = { on: { waiting: 'one' } };
  assert.throws(() => validateTeamConfig(c), /waiting_re_presentation_unreachable/);
});

test('artifact policies filter ready records and require downstream references to each source key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbit-artifacts-'));
  const db = openCoreDatabase(join(root, 'core.sqlite')), q = new ExecutionQueue(db);
  try {
    const item = q.enqueue({ requestId: 'artifact', taskId: 'task', source: 'user', destination: 'seat', body: 'work' });
    for (const name of ['source', 'target']) await mkdir(join(root, name));
    await writeFile(join(root, 'source', 'README.md'), 'Documentation');
    await writeFile(join(root, 'source', 'draft.md'), '---\nentry: draft-1\nstatus: draft\n---\nDraft');
    await writeFile(join(root, 'source', 'malformed.md'), '---\nstatus: ready: bad\n---\nHalf-written');
    const fired: string[] = [], wd = new Watchdog(db), facts = { item, lastActivity: 0, workspace: root };
    const context = { pools: [{ path: 'source', include_statuses: ['ready'], recursive: true }] };
    const pool = { id: 'pool', policy: 'artifact-pool-ready' as const, after_seconds: 1, interval_seconds: 1, context };
    const edge = { id: 'edge', policy: 'edge-artifact-required' as const, after_seconds: 1, interval_seconds: 1, context: { source: context.pools[0], target: { path: 'target', include_statuses: ['approved'] } } };
    wd.scan(facts, [pool, edge], w => fired.push(w.policy), 2000); assert.equal(fired.length, 0);
    await mkdir(join(root, 'source', 'nested')); await writeFile(join(root, 'source', 'nested', 'request.md'), '---\nentry: change-123\nstatus: ready\n---\nProduce a review');
    await writeFile(join(root, 'target', 'other.md'), '---\nentry: other-456\n---\nUnrelated');
    wd.scan(facts, [pool, edge], w => fired.push(w.policy), 4000);
    assert.deepEqual(fired, ['artifact-pool-ready', 'edge-artifact-required']);
    await writeFile(join(root, 'target', 'review.md'), '---\nstatus: draft\n---\nReview of change-123');
    wd.scan(facts, [edge], w => fired.push(w.policy), 6000); assert.equal(fired.length, 2);
    await rm(join(root, 'target', 'review.md'));
    wd.scan(facts, [edge], w => fired.push(w.policy), 8000); assert.equal(fired.length, 3);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test('unclaimed escalation closes when the original packet is claimed and completed', async () => {
  let release!: () => void; const gate = new Promise<void>(r => release = r); let started = false;
  const config: TeamConfig = { members: [{ role: 'worker', name: 'worker', instructions: 'work' }], edges: [], workflow: { entry: 'one', max_hops: 3, watchdogs: [{ id: 'unclaimed', policy: 'unclaimed', after_seconds: 1, interval_seconds: 1 }], steps: [{ id: 'one', actor_role: 'worker', objective: 'one' }] } };
  const env = await fixture(seat => ({ async execute(item) { if (!started) { started = true; await gate; } return completed(seat, item); }, async cancel() { release(); return true; } }), config);
  try {
    const t1 = env.task(); await env.service.dispatch(t1.id, env.team.id); await until(async () => started);
    const t2 = env.task(); await env.service.dispatch(t2.id, env.team.id);
    const pending = env.service.queue.list().find(i => i.taskId === t2.id)!;
    const core = (env.service as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    core.prepare('UPDATE execution_events SET at=? WHERE item_id=?').run(new Date(Date.now() - 10000).toISOString(), pending.id);
    await env.service.sync(); assert.equal(env.service.detail(t2.id)?.blockedOn, 'human:exception');
    release();
    await until(async () => { await env.service.sync(); return env.workspace.snapshot().tasks.find(t => t.id === t2.id)?.status === 'review'; });
    assert.ok(!env.service.queue.list().some(i => i.taskId === t2.id && i.blockedOn === 'human:exception'));
  } finally { release(); await env.close(); }
});
