import { validateWatchdogs, type WatchdogSpec } from '../orchestration/watchdog';
import type { ExceptionRouting } from './exceptions';
/** Behavioral subset of OpenRig 4b48ca21 workflow-types/projector.
 * Keep authored roles, exits, dependencies and bounded transitions explicit.
 * Unsupported fields fail validation rather than silently promising compatibility.
 */
export type WorkflowExit = 'done' | 'failed' | 'handoff' | 'waiting';
export interface WorkflowStep {
  id: string; actor_role: string; objective: string;
  depends_on?: string[];
  allowed_exits?: WorkflowExit[];
  next_hop?: { mode?: 'require' | 'forbid'; suggested_roles?: string[]; on?: Partial<Record<WorkflowExit, string>> };
  re_present_after_seconds?: number; re_present_max_seconds?: number;
  acceptance?: { candidate: string; verdicts: string[]; evidence_ref: string };
  gate?: { target: string; summary: string; evidence_ref?: string };
  review?: boolean;
}
export interface WorkflowSpec { entry: string; steps: WorkflowStep[]; max_hops: number; exception_routing?: ExceptionRouting; watchdogs?: WatchdogSpec[] }
export interface MemberSpec { role: string; name: string; instructions: string; model?: string; context_atoms?: Partial<Record<'project' | 'mission' | 'seat' | 'slice', string[]>>; context_profiles?: Partial<Record<'fresh' | 'handover' | 'post-compaction', string>> }
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
  for (const member of c.members) { keys(member, ['role','name','instructions','model','context_profiles','context_atoms']); id(member.role); text(member.name, 80); text(member.instructions); if (member.model !== undefined) text(member.model, 200); if (member.context_atoms) { keys(member.context_atoms,['project','mission','seat','slice']); for(const ids of Object.values(member.context_atoms)) { if(!Array.isArray(ids)) throw new Error('Invalid context selection'); ids.forEach(v => text(v,200)); } } if (member.context_profiles) { keys(member.context_profiles, ['fresh','handover','post-compaction']); for (const value of Object.values(member.context_profiles)) text(value, 200); } if (roles.has(member.role)) throw new Error('Duplicate role'); roles.add(member.role); }
  for (const edge of c.edges) { keys(edge, ['from','to']); if (!roles.has(edge.from) || !roles.has(edge.to)) throw new Error('Unknown edge role'); }
  const w = c.workflow; if (!w || typeof w !== 'object') throw new Error('Invalid workflow'); keys(w, ['entry','steps','max_hops','exception_routing','watchdogs']);
  if (!Array.isArray(w.steps) || !w.steps.length || w.steps.length > 64 || !Number.isInteger(w.max_hops) || w.max_hops < 1 || w.max_hops > 1000) throw new Error('Invalid steps/hop limit');
  if (w.watchdogs) validateWatchdogs(w.watchdogs);
  if (w.exception_routing) {
    const policy = w.exception_routing; keys(policy, ['default','orchestrator_role','classes']);
    if (policy.default && !['orchestrator','human_only'].includes(policy.default)) throw new Error('Invalid exception default');
    if (policy.orchestrator_role && !roles.has(policy.orchestrator_role)) throw new Error('Unknown orchestrator role');
    if (policy.classes) { keys(policy.classes, ['unmapped_failed','stuck_overdue']); if (Object.values(policy.classes).some(v => !['orchestrator','human_only'].includes(v))) throw new Error('Invalid exception policy'); }
  }
  const steps = new Map<string, WorkflowStep>();
  for (const s of w.steps) { keys(s, ['id','actor_role','objective','depends_on','allowed_exits','next_hop','gate','review','acceptance','re_present_after_seconds','re_present_max_seconds']); id(s.id); text(s.objective); if (steps.has(s.id) || !roles.has(s.actor_role)) throw new Error('Duplicate step or unknown role'); if (s.review !== undefined && typeof s.review !== 'boolean') throw new Error('Invalid review flag'); steps.set(s.id, s); }
  for (const step of w.steps) if (step.review && w.steps.some(s => !s.review && s.actor_role === step.actor_role)) throw new Error('独立审核角色不能同时承担制作步骤');
  for(const watchdog of w.watchdogs ?? []) if(watchdog.step_ids?.some(id=>!steps.has(id))) throw new Error('Unknown watchdog step');
  if (!steps.has(w.entry)) throw new Error('Unknown workflow entry');
  const exits = ['done','failed','handoff','waiting'];
  for (const s of w.steps) {
    if (s.allowed_exits && (!Array.isArray(s.allowed_exits) || !s.allowed_exits.length || s.allowed_exits.some(e => !exits.includes(e)))) throw new Error('Invalid allowed exits');
    if (s.depends_on && (!Array.isArray(s.depends_on) || s.depends_on.some(d => !steps.has(d) || d === s.id))) throw new Error('Invalid dependencies');
    if (s.gate) { keys(s.gate, ['target','summary','evidence_ref']); if (s.gate.target !== 'human:user' && !roles.has(s.gate.target)) throw new Error('Unknown gate target'); text(s.gate.summary); if (s.gate.evidence_ref !== undefined) text(s.gate.evidence_ref); if (s.gate.target !== 'human:user' && !s.acceptance) throw new Error('Role gate requires a typed acceptance contract'); }
    if (s.acceptance) { keys(s.acceptance, ['candidate','verdicts','evidence_ref']); text(s.acceptance.candidate); text(s.acceptance.evidence_ref); if (!Array.isArray(s.acceptance.verdicts) || !s.acceptance.verdicts.length) throw new Error('Acceptance verdicts required'); s.acceptance.verdicts.forEach(v => text(v, 200)); }
    if (s.re_present_after_seconds !== undefined && (!Number.isInteger(s.re_present_after_seconds) || s.re_present_after_seconds < 1 || s.re_present_after_seconds > 86400)) throw new Error('Invalid re-presentation delay');
    if (s.re_present_max_seconds !== undefined && (!Number.isInteger(s.re_present_max_seconds) || s.re_present_max_seconds < (s.re_present_after_seconds ?? Infinity) || s.re_present_max_seconds > 604800)) throw new Error('Invalid re-presentation maximum');
    if (s.next_hop) { keys(s.next_hop, ['on','mode','suggested_roles']); if (s.next_hop.mode && !['require','forbid'].includes(s.next_hop.mode)) throw new Error('Invalid next-hop mode'); if (s.next_hop.suggested_roles && (!Array.isArray(s.next_hop.suggested_roles) || s.next_hop.suggested_roles.some(r => !roles.has(r) || !w.steps.some(step => step.actor_role===r)))) throw new Error('Unknown suggested role');  for (const [exit,target] of Object.entries(s.next_hop.on ?? {})) { if (!exits.includes(exit) || !steps.has(target) || s.allowed_exits && !s.allowed_exits.includes(exit as WorkflowExit)) throw new Error('Invalid next-hop route: unsupported exit or target'); const role = steps.get(target)!.gate?.target === 'human:user' ? steps.get(target)!.actor_role : steps.get(target)!.gate?.target ?? steps.get(target)!.actor_role; if (role !== s.actor_role && !c.edges.some(e => e.from === s.actor_role && e.to === role)) throw new Error('Route requires a declared team edge'); } }
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(key: string) { if (visiting.has(key)) throw new Error('Dependency cycle'); if (visited.has(key)) return; visiting.add(key); for (const dep of steps.get(key)!.depends_on ?? []) visit(dep); visiting.delete(key); visited.add(key); }
  for (const key of steps.keys()) visit(key);
  if (steps.get(w.entry)!.depends_on?.length) throw new Error('Entry cannot depend on another step');
  const reachable = new Set(w.steps.filter(s => s.id === w.entry || s.depends_on?.length === 0).map(s => s.id));
  for (let pass = 0; pass < w.steps.length; pass++) for (const step of w.steps) {
    if (step.depends_on?.length && step.depends_on.every(d => reachable.has(d))) reachable.add(step.id);
    if (reachable.has(step.id)) { for (const target of Object.values(step.next_hop?.on ?? {})) reachable.add(target); const next=nextStep(w,step,'handoff'); if(next) reachable.add(next); }
  }
  if (w.steps.some(s => !reachable.has(s.id))) throw new Error('Workflow contains unreachable steps');
  return c;
}
export function successors(spec: WorkflowSpec, stepId: string): string[] {
  const found = new Set<string>();
  const visit = (id: string) => { for (const step of spec.steps) if (step.depends_on?.includes(id) && !found.has(step.id)) { found.add(step.id); visit(step.id); } };
  visit(stepId); return [...found];
}

/** Mapped exits win. Structural handoff uses authored role hints then serial declaration order. */
export function nextStep(spec: WorkflowSpec, step: WorkflowStep, exit: WorkflowExit): string | undefined {
  const mapped=step.next_hop?.on?.[exit]; if(mapped) return mapped;
  if(exit!=='handoff' || step.next_hop?.mode==='forbid') return;
  for(const role of step.next_hop?.suggested_roles ?? []) { const target=spec.steps.find(s=>s.actor_role===role); if(target) return target.id; }
  if(step.next_hop?.mode==='require' || spec.steps.some(s=>s.depends_on!==undefined)) return;
  return spec.steps[spec.steps.findIndex(s=>s.id===step.id)+1]?.id;
}
