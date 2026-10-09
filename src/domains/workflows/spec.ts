/** Behavioral subset of OpenRig 4b48ca21 workflow-types/projector.
 * Keep authored roles, exits, dependencies and bounded transitions explicit.
 * Unsupported fields fail validation rather than silently promising compatibility.
 */
export type WorkflowExit = 'done' | 'failed' | 'handoff' | 'waiting';
export interface WorkflowStep {
  id: string; actor_role: string; objective: string;
  depends_on?: string[];
  allowed_exits?: WorkflowExit[];
  next_hop?: { on?: Partial<Record<WorkflowExit, string>> };
  gate?: { target: 'human:user'; summary: string };
  review?: boolean;
}
export interface WorkflowSpec { entry: string; steps: WorkflowStep[]; max_hops: number }
export interface MemberSpec { role: string; name: string; instructions: string; model?: string }
export interface TeamConfig { members: MemberSpec[]; edges: { from: string; to: string }[]; workflow: WorkflowSpec }
export const defaultTeamConfig: TeamConfig = {
  members: [
    { role: 'builder', name: '执行者', instructions: '在工作目录内完成具体任务，验证成果并记录可复用经验。' },
    { role: 'reviewer', name: '检查者', instructions: '独立检查交付是否满足要求。检查真实文件与必要测试，不代替用户验收。' },
  ],
  edges: [{ from: 'builder', to: 'reviewer' }, { from: 'reviewer', to: 'builder' }],
  workflow: { entry: 'builder', max_hops: 24, steps: [
    { id: 'builder', actor_role: 'builder', objective: '完成用户需求及修改要求。', next_hop: { on: { done: 'reviewer' } } },
    { id: 'reviewer', actor_role: 'reviewer', objective: '独立审核。通过返回 verdict=pass；需修改返回 verdict=changes_requested，并给出具体依据。', review: true, next_hop: { on: { failed: 'builder' } } },
  ] },
};
function keys(value: object, allowed: string[]) { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unsupported configuration field: ${key}`); }
function text(value: unknown, max = 16000): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid configuration text'); }
function id(value: unknown): asserts value is string { text(value, 80); if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value)) throw new Error('Role/step identifiers must use letters, digits, _ or -'); }
export function validateTeamConfig(input: unknown): TeamConfig {
  if (!input || typeof input !== 'object') throw new Error('Invalid team configuration');
  const c = structuredClone(input) as TeamConfig; keys(c, ['members','edges','workflow']);
  if (!Array.isArray(c.members) || !c.members.length || c.members.length > 24 || !Array.isArray(c.edges)) throw new Error('Invalid members/edges');
  const roles = new Set<string>();
  for (const member of c.members) { keys(member, ['role','name','instructions','model']); id(member.role); text(member.name, 80); text(member.instructions); if (member.model !== undefined) text(member.model, 200); if (roles.has(member.role)) throw new Error('Duplicate role'); roles.add(member.role); }
  for (const edge of c.edges) { keys(edge, ['from','to']); if (!roles.has(edge.from) || !roles.has(edge.to)) throw new Error('Unknown edge role'); }
  const w = c.workflow; if (!w || typeof w !== 'object') throw new Error('Invalid workflow'); keys(w, ['entry','steps','max_hops']);
  if (!Array.isArray(w.steps) || !w.steps.length || w.steps.length > 64 || !Number.isInteger(w.max_hops) || w.max_hops < 1 || w.max_hops > 1000) throw new Error('Invalid steps/hop limit');
  const steps = new Map<string, WorkflowStep>();
  for (const s of w.steps) { keys(s, ['id','actor_role','objective','depends_on','allowed_exits','next_hop','gate','review']); id(s.id); text(s.objective); if (steps.has(s.id) || !roles.has(s.actor_role)) throw new Error('Duplicate step or unknown role'); if (s.review !== undefined && typeof s.review !== 'boolean') throw new Error('Invalid review flag'); steps.set(s.id, s); }
  if (!steps.has(w.entry)) throw new Error('Unknown workflow entry');
  const exits = ['done','failed','handoff','waiting'];
  for (const s of w.steps) {
    if (s.allowed_exits && (!Array.isArray(s.allowed_exits) || !s.allowed_exits.length || s.allowed_exits.some(e => !exits.includes(e)))) throw new Error('Invalid allowed exits');
    if (s.depends_on && (!Array.isArray(s.depends_on) || s.depends_on.some(d => !steps.has(d) || d === s.id))) throw new Error('Invalid dependencies');
    if (s.gate) { keys(s.gate, ['target','summary']); if (s.gate.target !== 'human:user') throw new Error('Only human:user is a gate target; use a review step for agent gates'); text(s.gate.summary); }
    if (s.next_hop) { keys(s.next_hop, ['on']); for (const [exit,target] of Object.entries(s.next_hop.on ?? {})) { if (!['done','failed'].includes(exit) || !steps.has(target) || s.allowed_exits && !s.allowed_exits.includes(exit as WorkflowExit)) throw new Error('Invalid next-hop route: this version routes done/failed; handoff transfers the current obligation and waiting parks it'); const role = steps.get(target)!.actor_role; if (role !== s.actor_role && !c.edges.some(e => e.from === s.actor_role && e.to === role)) throw new Error('Route requires a declared team edge'); } }
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(key: string) { if (visiting.has(key)) throw new Error('Dependency cycle'); if (visited.has(key)) return; visiting.add(key); for (const dep of steps.get(key)!.depends_on ?? []) visit(dep); visiting.delete(key); visited.add(key); }
  for (const key of steps.keys()) visit(key);
  if (steps.get(w.entry)!.depends_on?.length) throw new Error('Entry cannot depend on another step');
  const reachable = new Set(w.steps.filter(s => s.id === w.entry || s.depends_on?.length === 0).map(s => s.id));
  for (let pass = 0; pass < w.steps.length; pass++) for (const step of w.steps) {
    if (step.depends_on?.length && step.depends_on.every(d => reachable.has(d))) reachable.add(step.id);
    if (reachable.has(step.id)) for (const target of Object.values(step.next_hop?.on ?? {})) reachable.add(target);
  }
  if (w.steps.some(s => !reachable.has(s.id))) throw new Error('Workflow contains unreachable steps');
  return c;
}
export function successors(spec: WorkflowSpec, stepId: string): string[] {
  const found = new Set<string>();
  const visit = (id: string) => { for (const step of spec.steps) if (step.depends_on?.includes(id) && !found.has(step.id)) { found.add(step.id); visit(step.id); } };
  visit(stepId); return [...found];
}
