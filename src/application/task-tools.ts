import type { BusinessTool } from '../domains/conversation/agent';

const text = { type: 'string', minLength: 1, maxLength: 16000 };
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
export function executionTools(planner: boolean): BusinessTool[] {
  return [
    { name: 'read_task', description: '读取当前任务、步骤状态和已完成的上游成果。', parameters: schema({}, []) },
    { name: 'report_progress', description: '记录实际进展；不改变完成状态，不填写猜测的进度百分比。', parameters: schema({ message: text }, ['message']) },
    { name: 'request_input', description: '需要用户补充信息时提问，等待答案后继续。不要用它请求扩大执行权限。', parameters: schema({ question: text }, ['question']) },
    planner ? {
      name: 'submit_plan', description: '提交固定任务依赖图。宿主校验后保存 plan.json；本轮正常结束后开始执行。不要自行启动其他 Agent。',
      parameters: schema({ steps: { type: 'array', minItems: 1, maxItems: 16, items: schema({
        id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' }, name: { type: 'string', minLength: 1, maxLength: 100 },
        instruction: text, dependsOn: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      }, ['id', 'name', 'instruction', 'dependsOn']) } }, ['steps']),
    } : {
      name: 'submit_result', description: '提交实际结论和成果文件。文件路径相对当前步骤目录；宿主核验文件，本轮正常结束后才完成步骤。',
      parameters: schema({ summary: text, artifacts: { type: 'array', maxItems: 32, items: { type: 'string' } } }, ['summary', 'artifacts']),
    },
  ];
}
