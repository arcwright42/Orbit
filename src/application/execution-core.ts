import { openCoreDatabase } from '../infrastructure/core-database';
import { ExecutionQueue } from '../domains/orchestration/queue';
import { Scheduler } from '../domains/orchestration/scheduler';
import { MemoryStore } from '../domains/memory/store';
import type { ExecutionPort } from '../domains/runtime/execution-port';

/** Trusted main-process entry, deliberately not connected to renderer IPC yet.
 * Open once per application runtime owner. Opening does NOT start or retry work.
 */
export function openExecutionCore(options: {
  databasePath: string;
  agents: ReadonlyMap<string, ExecutionPort>;
  maxConcurrent?: number;
}) {
  const db = openCoreDatabase(options.databasePath);
  try {
    const queue = new ExecutionQueue(db);
    const memory = new MemoryStore(db);
    const scheduler = new Scheduler(queue, options.agents, options.maxConcurrent ?? 2);
    let closing: Promise<void> | undefined;
    return {
      queue, memory, scheduler,
      /** Does not abort ongoing work; caller may request cancellation first.
       * Await runtime settlement before closing SQLite so late callbacks remain safe.
       */
      close(): Promise<void> {
        closing ??= (async () => {
          scheduler.stop();
          try { await scheduler.drain(); } finally { db.close(); }
        })();
        return closing;
      },
    };
  } catch (error) { db.close(); throw error; }
}
