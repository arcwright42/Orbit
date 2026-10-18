import type { ModelCredential } from '../../domains/models/model';
import type { TaskRuntimeEvent, TaskRuntimeInput, TaskRuntimeOutcome } from '../../domains/tasks/runtime';

export type ExecutionParentMessage =
  | { type: 'start'; input: TaskRuntimeInput; executable?: string; mcpBridge: string }
  | { type: 'stop' }
  | { type: 'response'; id: string; result?: unknown; error?: string }
  | { type: 'credential'; id: string; credential?: ModelCredential; error?: string };
export type ExecutionWorkerMessage =
  | { type: 'ready' }
  | { type: 'event'; event: TaskRuntimeEvent }
  | { type: 'outcome'; outcome: TaskRuntimeOutcome }
  | { type: 'tool'; id: string; name: string; args: unknown; callId: string }
  | { type: 'credential'; id: string };
export interface RuntimeCallbacks {
  event(event: TaskRuntimeEvent): void;
  tool(name: string, args: unknown, callId: string): Promise<unknown>;
  credential(): Promise<ModelCredential | undefined>;
  signal: AbortSignal;
}
