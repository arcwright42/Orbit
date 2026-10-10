import type { ExecutionResult, QueueItem } from '../orchestration/types';

/** Adapter owns actual process/protocol, authorization and result evidence.
 * execute must settle only when this attempt stops; abort alone is not cancellation proof.
 * item.generation fences late results; item.id is the durable execution identity.
 */
export interface ExecutionPort {
  execute(item: QueueItem, signal: AbortSignal): Promise<ExecutionResult>;
  /** True only after the runtime confirms execution stopped. May resolve false. */
  /** Only returns a result with durable exit evidence, never based on inactivity. */
  reconcile?(item: QueueItem): Promise<ExecutionResult | undefined>;
  cancel(item: QueueItem): Promise<boolean>;
}
