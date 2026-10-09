import type { Message, Task } from '../../contracts';

// An explicit system receipt, NOT a simulated model response.
export function intakeReceipt(task: Task, id: string): Message {
  return {
    id, role: 'system', taskId: task.id, createdAt: task.createdAt,
    text: '需求已保存在本机，尚未派发。交互 Agent 与自动编排正在接入中；这条回执不是 AI 回复。',
  };
}
