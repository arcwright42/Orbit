import { boundedText, object, type TaskPlan } from './execution';

/** IDs double as directory names. The planner is reserved and added by the host. */
export function validatePlan(value: unknown): TaskPlan {
  const input = object(value);
  if (input.version !== undefined && input.version !== 1) throw new Error('不支持该规划版本。');
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 16) throw new Error('规划需要 1–16 个步骤。');
  const steps = input.steps.map(value => {
    const step = object(value);
    const id = boundedText(step.id, '步骤标识', 64);
    if (!/^[a-z][a-z0-9_-]*$/.test(id) || id === 'planner') throw new Error('步骤标识只能使用小写英文、数字、下划线和连字符，且不能是 planner。');
    if (!Array.isArray(step.dependsOn) || step.dependsOn.some(id => typeof id !== 'string')) throw new Error('dependsOn 必须是步骤标识数组。');
    const dependsOn = step.dependsOn as string[];
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error('步骤依赖不能重复。');
    return { id, name: boundedText(step.name ?? id, '步骤名称', 100), instruction: boundedText(step.instruction, '步骤要求'), dependsOn };
  });
  const byId = new Map(steps.map(step => [step.id, step]));
  if (byId.size !== steps.length) throw new Error('步骤标识不能重复。');
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('规划存在循环依赖。');
    if (visited.has(id)) return;
    const step = byId.get(id);
    if (!step) throw new Error('依赖的步骤不存在：' + id);
    visiting.add(id); step.dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
  };
  steps.forEach(step => visit(step.id));
  return { version: 1, steps };
}
