import type { ModelProfile } from '../models/model';

export type ExecutionRuntime = 'pi' | 'codex-cli' | 'claude-cli';
export interface ExecutionSettings { runtime: ExecutionRuntime; maxConcurrency: number }
export const DEFAULT_EXECUTION_SETTINGS: ExecutionSettings = { runtime: 'pi', maxConcurrency: 2 };
export interface RuntimeSelection { runtime: ExecutionRuntime; model?: ModelProfile }
export type TaskStatus = 'pending' | 'queued' | 'planning' | 'running' | 'waiting' | 'interrupted' | 'canceling' | 'canceled' | 'failed' | 'review' | 'completed';
export type StepStatus = 'pending' | 'running' | 'waiting' | 'interrupted' | 'completed' | 'failed' | 'canceled';
export type RunStatus = 'starting' | 'running' | 'waiting' | 'unresolved' | 'completed' | 'failed' | 'interrupted' | 'canceled';
export interface PlanStep { id: string; name: string; instruction: string; dependsOn: string[] }
export interface TaskPlan { version: 1; steps: PlanStep[] }
export interface TaskExecution {
  mode: 'direct' | 'plan';
  selection: RuntimeSelection;
  roomId?: string;
  directory: string;
  plan?: TaskPlan;
}
export interface TaskArtifact { path: string; size: number; sha256: string }
export interface StepResult { summary: string; artifacts: TaskArtifact[] }
export interface TaskStep extends PlanStep {
  taskId: string;
  kind: 'planner' | 'worker';
  status: StepStatus;
  currentRunId?: string;
  result?: StepResult;
  error?: string;
}
export interface TaskQuestion {
  id: string;
  kind: 'input' | 'approval';
  prompt: string;
  status: 'pending' | 'answered' | 'expired';
  answer?: string;
  createdAt: string;
}
export type RunProposal = { kind: 'plan'; plan: TaskPlan } | { kind: 'result'; result: StepResult };
export interface TaskRun {
  id: string;
  taskId: string;
  stepId: string;
  attempt: number;
  status: RunStatus;
  selection: RuntimeSelection;
  nativeSession?: string;
  workerPid?: number;
  workerIdentity?: string;
  proposal?: RunProposal;
  questions: TaskQuestion[];
  error?: string;
  startedAt: string;
  endedAt?: string;
}
export interface TaskEvent { seq: number; taskId: string; stepId?: string; runId?: string; type: string; message: string; createdAt: string; taskStatus?: TaskStatus }
export interface TaskDetail { task: import('../../contracts').Task; steps: TaskStep[]; runs: TaskRun[]; events: TaskEvent[]; nextBefore?: number }
export interface RuntimeAvailability { runtime: ExecutionRuntime; available: boolean; message: string; version?: string }
export interface ExecutionConfiguration { settings: ExecutionSettings; runtimes: RuntimeAvailability[]; error?: string }
export interface TaskExecutionApi {
  configuration(): Promise<ExecutionConfiguration>;
  configure(settings: ExecutionSettings): Promise<ExecutionConfiguration>;
  detail(taskId: string, before?: number): Promise<TaskDetail>;
  dispatch(taskId: string, mode: 'direct' | 'plan'): Promise<TaskDetail>;
  retry(taskId: string): Promise<TaskDetail>;
  answer(taskId: string, questionId: string, answer: string): Promise<TaskDetail>;
  accept(taskId: string): Promise<TaskDetail>;
  openArtifact(taskId: string, path: string): Promise<void>;
  openDirectory(taskId: string): Promise<void>;
  onChanged(listener: (event: TaskEvent) => void): () => void;
}

export function validateExecutionSettings(value: unknown): ExecutionSettings {
  const input = object(value);
  if (!['pi', 'codex-cli', 'claude-cli'].includes(String(input.runtime)) || !Number.isInteger(input.maxConcurrency) || Number(input.maxConcurrency) < 1 || Number(input.maxConcurrency) > 4) {
    throw new Error('请选择有效运行时，并将并发数设为 1–4。');
  }
  return { runtime: input.runtime as ExecutionRuntime, maxConcurrency: Number(input.maxConcurrency) };
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须是对象。');
  return value as Record<string, unknown>;
}
export function boundedText(value: unknown, name: string, max = 16000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(name + '不能为空，且不得超过 ' + max + ' 个字符。');
  return value.trim();
}
