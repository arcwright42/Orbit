/** Behavioral reference: OpenRig 4b48ca21 queue-repository.ts (Apache-2.0).
 * Orbit-specific implementation; queue completion is not user-task acceptance.
 */
export type QueueState = 'pending' | 'in-progress' | 'blocked' | 'done' | 'failed' | 'denied' | 'canceled' | 'handed-off';
export type Priority = 'routine' | 'urgent' | 'critical';
export interface EnqueueInput {
  requestId: string;
  taskId: string;
  source: string;
  destination: string;
  body: string;
  priority?: Priority;
}
export interface QueueItem extends Required<EnqueueInput> {
  id: string;
  state: QueueState;
  generation: string | null;
  cancelRequested: boolean;
  blockedOn: string | null;
  resolution: string | null;
  evidenceRef: string | null;
  parentId: string | null;
  successorId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface QueueEvent { seq: number; itemId: string; state: QueueState; actor: string; note: string; at: string }
export type ExecutionResult =
  | { kind: 'question'; question: string }
  | { kind: 'completed'; summary: string; evidenceRef: string }
  | { kind: 'blocked'; reason: string; blockedOn: string; wakeAfterSeconds?: number; wakeMaxSeconds?: number }
  | { kind: 'failed'; reason: string }
  | { kind: 'canceled'; reason: string }
  | { kind: 'handoff'; destination: string; body: string; reason: string };
export const activeStates: readonly QueueState[] = ['pending', 'in-progress', 'blocked'];
export function required(value: string, field: string, max = 32_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${field}.`);
  return value.trim();
}
