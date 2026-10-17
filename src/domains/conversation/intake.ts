import type { Message, Task } from '../../contracts';

// An explicit system receipt, NOT a simulated model response.
export function intakeReceipt(task: Task, id: string): Message {
  return {
    id, role: 'system', taskId: task.id, createdAt: task.createdAt,
    text: '需求已保存在本机，尚未派发。执行团队接入后才能开始工作。',
  };
}
