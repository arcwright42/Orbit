import type { BusinessTool } from '../conversation/agent';
import type { RuntimeSelection, TaskRun } from './execution';

export interface TaskRuntimeInput {
  run: TaskRun;
  directory: string;
  runDirectory: string;
  taskDirectory: string;
  prompt: string;
  tools: BusinessTool[];
  resumeSession?: string;
}
export type TaskRuntimeEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'process'; pid: number; identity: string }
  | { type: 'output'; text: string }
  | { type: 'activity'; message: string };
/** unresolved keeps the execution lease until the host positively reconciles the old process. */
export interface TaskRuntimeOutcome { status: 'completed' | 'failed' | 'interrupted' | 'unresolved'; error?: string }
export interface TaskRuntimeHandle { done: Promise<TaskRuntimeOutcome>; stop(): Promise<void> }
export interface TaskRuntimePort {
  start(input: TaskRuntimeInput, event: (event: TaskRuntimeEvent) => void,
    tool: (name: string, args: unknown, callId: string) => Promise<unknown>): TaskRuntimeHandle;
  /** Stop a positively identified old worker. Refuse an unresolved live process. */
  reconcile(run: TaskRun): Promise<void>;
  preflight(selection: RuntimeSelection): Promise<void>;
}
