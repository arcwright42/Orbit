import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCoreDatabase } from '../src/infrastructure/core-database';
import { ExecutionQueue } from '../src/domains/orchestration/queue';
import { Scheduler } from '../src/domains/orchestration/scheduler';
import type { ExecutionPort } from '../src/domains/runtime/execution-port';
import type { EnqueueInput, ExecutionResult } from '../src/domains/orchestration/types';

const input = (requestId: string, destination = 'worker'): EnqueueInput => ({ requestId, taskId: 'goal-one', source: 'entry', destination, body: 'Build a page' });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-core-'));
  const path = join(directory, 'core.sqlite'), db = openCoreDatabase(path), queue = new ExecutionQueue(db);
  return { path, db, queue, close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const complete: ExecutionResult = { kind: 'completed', summary: 'Delivered draft', evidenceRef: 'artifact:one' };

function controlled() {
  const calls: string[] = [], pending = new Map<string, (value: ExecutionResult) => void>();
  const port: ExecutionPort = {
    execute: item => { calls.push(item.id); return new Promise(resolve => pending.set(item.id, resolve)); },
    cancel: async () => false,
  };
  return { calls, pending, port };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('idempotent queue, priority ordering, durable events and claims across DB connections', () => {
  const f = fixture(), secondDb = openCoreDatabase(f.path), second = new ExecutionQueue(secondDb);
  try {
    const first = f.queue.enqueue(input('one'));
    assert.equal(f.queue.enqueue(input('one')).id, first.id);
    assert.throws(() => f.queue.enqueue({ ...input('one'), body: 'Changed' }), /different content/);
    const urgent = f.queue.enqueue({ ...input('two'), priority: 'critical' });
    const claim = second.claimNext(['worker'], 2)!;
    assert.equal(claim.id, urgent.id);
    assert.equal(f.queue.claimNext(['worker'], 2), undefined);
    second.finish(claim.id, claim.generation!, complete);
    assert.equal(f.queue.claimNext(['worker'], 2)?.id, first.id);
    assert.equal(f.queue.get(urgent.id).evidenceRef, 'artifact:one');
    assert.deepEqual(f.queue.events().map(event => event.state), ['pending', 'pending', 'in-progress', 'done', 'in-progress']);
    assert.equal(second.events(4).length, 1);
  } finally { secondDb.close(); f.close(); }
});

test('handoff closes the old obligation and creates one linked successor atomically', () => {
  const f = fixture();
  try {
    const original = f.queue.enqueue(input('one'));
    const claim = f.queue.claimNext(['worker'], 1)!;
    assert.throws(() => f.queue.finish(claim.id, claim.generation!, { kind: 'handoff', destination: 'reviewer', body: 'Check', reason: '' }), /reason/);
    assert.equal(f.queue.list().length, 1);
    assert.equal(f.queue.get(original.id).state, 'in-progress');
    f.queue.finish(claim.id, claim.generation!, { kind: 'handoff', destination: 'reviewer', body: 'Check artifact', reason: 'Ready for review' });
    f.queue.finish(claim.id, claim.generation!, complete);
    const closed = f.queue.get(original.id), successor = f.queue.get(closed.successorId!);
    assert.equal(closed.state, 'handed-off');
    assert.equal(successor.parentId, original.id);
    assert.equal(successor.taskId, original.taskId);
    assert.equal(successor.state, 'pending');
    assert.equal(f.queue.list().length, 2);
  } finally { f.close(); }
});

test('scheduler keeps owner lanes serial while other agents run concurrently', async () => {
  const f = fixture(), runtime = controlled();
  const scheduler = new Scheduler(f.queue, new Map([['a', runtime.port], ['b', runtime.port]]), 2);
  try {
    const a = scheduler.enqueue(input('a1', 'a'));
    const a2 = scheduler.enqueue(input('a2', 'a'));
    const b = scheduler.enqueue(input('b1', 'b'));
    await turn();
    assert.deepEqual(new Set(runtime.calls), new Set([a.id, b.id]));
    runtime.pending.get(a.id)!(complete);
    await turn();
    assert.equal(runtime.calls.at(-1), a2.id);
    runtime.pending.get(a2.id)!(complete); runtime.pending.get(b.id)!(complete);
    await scheduler.drain();
    assert(f.queue.list().every(item => item.state === 'done'));
  } finally { scheduler.stop(); f.close(); }
});

test('cancellation awaits runtime proof and fences late completion', async () => {
  const f = fixture(), runtime = controlled();
  let confirmed = false;
  runtime.port.cancel = async () => confirmed;
  const scheduler = new Scheduler(f.queue, new Map([['worker', runtime.port]]));
  try {
    const item = scheduler.enqueue(input('one'));
    await turn();
    assert.equal((await scheduler.cancel(item.id, 'user')).state, 'in-progress');
    assert.equal(f.queue.get(item.id).cancelRequested, true);
    confirmed = true;
    assert.equal((await scheduler.cancel(item.id, 'user')).state, 'canceled');
    runtime.pending.get(item.id)!(complete);
    await scheduler.drain();
    assert.equal(f.queue.get(item.id).state, 'canceled');
    assert.equal(f.queue.get(item.id).evidenceRef, null);
  } finally { scheduler.stop(); f.close(); }
});

test('restart parks uncertain work, blocks the owner lane, and requires explicit reconciliation', () => {
  const f = fixture();
  try {
    const item = f.queue.enqueue(input('one'));
    const old = f.queue.claimNext(['worker'], 1)!;
    f.queue.enqueue(input('two'));
    const restartedDb = openCoreDatabase(f.path), restarted = new ExecutionQueue(restartedDb);
    try {
      assert.equal(restarted.recoverInterrupted(), 1);
      assert.equal(restarted.claimNext(['worker'], 1), undefined);
      restarted.finish(item.id, old.generation!, complete);
      assert.equal(restarted.get(item.id).state, 'blocked');
      assert.throws(() => restarted.retry(item.id, 'user', ''), /reconciliation/);
      restarted.retry(item.id, 'user', 'Old process terminated; checked no side effects.');
      const current = restarted.claimNext(['worker'], 1)!;
      assert.notEqual(current.generation, old.generation);
      restarted.finish(item.id, old.generation!, complete);
      assert.equal(restarted.get(item.id).state, 'in-progress');
    } finally { restartedDb.close(); }
  } finally { f.close(); }
});

test('runtime transport failure does not pretend completion or automatically rerun', async () => {
  const f = fixture();
  const port: ExecutionPort = { execute: async () => { throw new Error('Connection lost'); }, cancel: async () => false };
  const scheduler = new Scheduler(f.queue, new Map([['worker', port]]));
  try {
    const first = scheduler.enqueue(input('one'));
    const second = scheduler.enqueue(input('two'));
    await scheduler.drain();
    assert.equal(f.queue.get(first.id).blockedOn, 'runtime:unknown');
    assert.equal(f.queue.get(second.id).state, 'pending');
  } finally { scheduler.stop(); f.close(); }
});

test('uncertain remote execution retains global capacity as well as its destination lane', () => {
  const f = fixture();
  try {
    f.queue.enqueue(input('one', 'a'));
    f.queue.claimNext(['a'], 1);
    f.queue.recoverInterrupted();
    f.queue.enqueue(input('two', 'b'));
    assert.equal(f.queue.claimNext(['b'], 1), undefined);
    assert.equal(f.queue.claimNext(['b'], 2)?.destination, 'b');
  } finally { f.close(); }
});
