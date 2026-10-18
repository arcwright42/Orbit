import type { ExecutionRuntime, StepStatus, TaskStatus } from '../domains/tasks/execution';

export const TASK_LABELS: Record<TaskStatus, string> = {
  pending: '待派发', queued: '排队中', planning: '规划中', running: '执行中', waiting: '等待你处理',
  interrupted: '执行中断', canceling: '正在取消', canceled: '已取消', failed: '执行失败', review: '待验收', completed: '已完成',
};
export const STEP_LABELS: Record<StepStatus, string> = {
  pending: '等待执行', running: '执行中', waiting: '等待你处理', interrupted: '已中断', completed: '已完成', failed: '失败', canceled: '已取消',
};
export const RUNTIME_LABELS: Record<ExecutionRuntime, string> = { pi: 'Pi SDK', 'codex-cli': 'Codex CLI', 'claude-cli': 'Claude Code' };
export const activeTask = (status: TaskStatus) => !['completed', 'canceled'].includes(status);
export function taskGroup(status: TaskStatus) {
  if (['queued', 'planning', 'running', 'canceling'].includes(status)) return 'running';
  if (['waiting', 'interrupted', 'failed'].includes(status)) return 'attention';
  return status;
}
export const taskError = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '操作失败，请重试。';
export const taskTime = (date: string) => new Date(date).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
