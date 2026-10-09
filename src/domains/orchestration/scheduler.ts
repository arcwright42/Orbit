import type { ExecutionPort } from '../runtime/execution-port';
import { ExecutionQueue } from './queue';
import type { EnqueueInput, QueueItem } from './types';

/** Explicit lifecycle: enqueue/tick starts work; no timer or Electron dependency.
 * Each registered destination has a single lane, with a global concurrency bound.
 */
export class Scheduler {
  private runs = new Map<string, { controller: AbortController; settled: Promise<void> }>();
  private stopped = false;
  private errors: string[] = [];

  constructor(readonly queue: ExecutionQueue, private agents: ReadonlyMap<string, ExecutionPort>, private concurrency = 2, private lane: (destination: string) => string = value => value) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency.');
  }

  enqueue(input: EnqueueInput): QueueItem {
    if (this.stopped) throw new Error('Scheduler stopped.');
    if (!this.agents.has(input.destination.trim())) throw new Error('Destination has no registered execution adapter.');
    const item = this.queue.enqueue(input);
    this.tick();
    return this.queue.get(item.id);
  }

  tick(): void {
    if (this.stopped) return;
    for (;;) {
      const item = this.queue.claimNext([...this.agents.keys()], this.concurrency, this.lane);
      if (!item) return;
      const controller = new AbortController();
      const port = this.agents.get(item.destination)!;
      const settled = Promise.resolve().then(async () => {
        try {
          const result = await port.execute(item, controller.signal);
          // A returned result is adapter proof this execution attempt has settled.
          this.queue.finish(item.id, item.generation!, result);
        } catch (error) {
          // A thrown transport error does not prove the remote process stopped.
          this.queue.finish(item.id, item.generation!, { kind: 'blocked', blockedOn: 'runtime:unknown',
            reason: error instanceof Error ? error.message || 'Runtime failed without a result.' : 'Runtime failed without a result.' });
        }
      }).catch(error => { this.errors.push(error instanceof Error ? error.message : String(error)); })
        .finally(() => {
          this.runs.delete(item.id);
          try { this.tick(); } catch (error) { this.errors.push(error instanceof Error ? error.message : String(error)); }
        });
      this.runs.set(item.id, { controller, settled });
    }
  }

  async cancel(id: string, actor: string): Promise<QueueItem> {
    const item = this.queue.requestCancel(id, actor);
    if (!item.cancelRequested || !['in-progress', 'blocked'].includes(item.state) || !item.generation) return item;
    if (item.state === 'blocked' && item.blockedOn !== 'runtime:unknown' && !this.runs.has(id)) { this.queue.confirmCancel(id, item.generation); this.tick(); return this.queue.get(id); }
    const port = this.agents.get(item.destination);
    if (!port) return item;
    // Abort is a signal, never sufficient to label the task canceled.
    this.runs.get(id)?.controller.abort();
    if (await port.cancel(item)) this.queue.confirmCancel(id, item.generation);
    this.tick();
    return this.queue.get(id);
  }

  /** Stop accepting new work; intentionally leaves active runtime calls alive. */
  stop(): void { this.stopped = true; }

  async drain(): Promise<void> {
    while (this.runs.size) await Promise.all([...this.runs.values()].map(run => run.settled));
    if (this.errors.length) throw new AggregateError(this.errors.map(message => new Error(message)), 'Scheduler persistence errors.');
  }
}
