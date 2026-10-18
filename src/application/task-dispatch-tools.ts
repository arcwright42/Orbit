import type { BusinessTool } from '../domains/conversation/agent';

const id = { type: 'string', minLength: 1, maxLength: 100 };
const parameters = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
export const TASK_DISPATCH_TOOLS: BusinessTool[] = [
  { name: 'dispatch_task', description: '派发用户明确要求执行的任务。简单任务 direct；需要拆分串并行步骤时 plan，由 Planner 先规划。新任务提供 text，已保存任务提供 taskId。运行时使用系统设置。',
    parameters: parameters({ taskId: id, text: { type: 'string', minLength: 1, maxLength: 16000 }, mode: { type: 'string', enum: ['direct', 'plan'] },
      attachmentIds: { type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string' } } }, ['mode']) },
  { name: 'get_task', description: '读取任务的真实步骤、进展、待处理问题和成果。', parameters: parameters({ taskId: id }, ['taskId']) },
  { name: 'cancel_task', description: '根据用户要求取消任务，等待执行停止。停止聊天回复不会取消任务。', parameters: parameters({ taskId: id }, ['taskId']) },
  { name: 'retry_task', description: '根据用户要求重试失败或中断任务，保留已完成步骤。', parameters: parameters({ taskId: id }, ['taskId']) },
  { name: 'answer_task', description: '将用户对任务信息问题的明确答复传回执行方。权限审批必须由用户在任务详情处理。', parameters: parameters({ taskId: id, questionId: id, answer: { type: 'string', minLength: 1, maxLength: 16000 } }, ['taskId', 'questionId', 'answer']) },
  { name: 'accept_task', description: '只有用户明确表示验收通过时，才将待验收任务标记完成。', parameters: parameters({ taskId: id }, ['taskId']) },
];
