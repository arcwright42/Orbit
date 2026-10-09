import type { SubmitRequest, Task } from '../../contracts';

export function validateRequest(value: unknown): SubmitRequest {
  const input = value as Partial<SubmitRequest> | null;
  if (!input || typeof input.requestId !== 'string' || !/^[\w-]{8,80}$/.test(input.requestId)) {
    throw new Error('请求标识无效，请重新发送。');
  }
  if (typeof input.text !== 'string' || input.text.length > 16000) {
    throw new Error('需求文字最多 16,000 字符。');
  }
  if (!Array.isArray(input.attachmentIds) || input.attachmentIds.length > 8 ||
      input.attachmentIds.some(id => typeof id !== 'string') ||
      new Set(input.attachmentIds).size !== input.attachmentIds.length) {
    throw new Error('每次最多添加 8 个不同附件。');
  }
  if (!input.text.trim() && input.attachmentIds.length === 0) throw new Error('请先输入需求或添加附件。');
  return { requestId: input.requestId, text: input.text.trim(), attachmentIds: input.attachmentIds };
}

export function cancelPendingTask(task: Task, now: string): Task {
  if (task.status === 'canceled') return task;
  // Once execution is introduced, cancellation must wait for its receipt.
  if (task.status !== 'pending') throw new Error('当前任务不能直接取消。');
  return { ...task, status: 'canceled', updatedAt: now };
}
