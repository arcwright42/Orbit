import { randomUUID } from 'node:crypto';
import { readFile, copyFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openCoreDatabase } from '../infrastructure/core-database';
import { TaskRepository } from '../domains/tasks/repository';
import { ExecutionQueue } from '../domains/orchestration/queue';
import { Scheduler } from '../domains/orchestration/scheduler';
import { TeamTemplates } from '../domains/teams/templates';
import { TeamRegistry, type Seat } from '../domains/teams/registry';
import { CodexRuntime, type RuntimeEvidence } from '../domains/runtime/codex';
import type { ExecutionPort } from '../domains/runtime/execution-port';
import type { QueueItem } from '../domains/orchestration/types';
import { taskDirectory, writeMission } from '../domains/materials/workspace-files';
import type { MaterialLibrary } from '../domains/materials/library';
import type { TaskExecution } from '../contracts';
import { MemoryStore } from '../domains/memory/store';
import { TeamKnowledge } from '../domains/memory/team-knowledge';
import { successors, type WorkflowSpec, type WorkflowExit } from '../domains/workflows/spec';

interface StepRun { state: 'dormant' | 'ready' | 'active' | 'done' | 'routed'; itemId: string; visit: number; summary?: string }
interface Flow { taskId: string; teamId: string; cycle: string; phase: string; itemId: string; feedback: string; artifacts: string[]; summary: string; closed: boolean; spec: WorkflowSpec; runs: Record<string, StepRun>; hops: number; fault?: string; paused?: boolean }
export class TaskExecutionService {
  private db: DatabaseSync;
  readonly queue: ExecutionQueue;
  readonly teams: TeamRegistry;
  readonly memory: MemoryStore;
  readonly templates: TeamTemplates;
  private knowledge: TeamKnowledge;
  private scheduler: Scheduler;
  private tasks: TaskRepository;
  private ports = new Map<string, ExecutionPort>();
  private closed = false;
  private operations = new Map<string, Promise<unknown>>();
  private syncPromise?: Promise<void>;
  private closing?: Promise<void>;
  private timer: ReturnType<typeof setInterval>;
  constructor(db: DatabaseSync, private materials: MaterialLibrary, private root: string, private changed: () => void,
    private compose: (seat: Seat, item: QueueItem, pack?: string) => Promise<string> = async () => '',
    private portFactory?: (seat: Seat) => ExecutionPort) {
    this.db = openCoreDatabase(join(root, 'execution-core.sqlite')); this.tasks = new TaskRepository(db);
    this.db.exec('CREATE TABLE IF NOT EXISTS task_flows (task_id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
    this.queue = new ExecutionQueue(this.db); this.teams = new TeamRegistry(this.db, join(root, 'workspaces'));
    this.templates = new TeamTemplates(this.db);
    this.memory = new MemoryStore(this.db); this.knowledge = new TeamKnowledge(this.memory, this.teams, this.db);
    // Stable seat ownership protects its knowledge; different members may run concurrently.
    this.scheduler = new Scheduler(this.queue, this.ports, 4, destination => this.teams.seat(destination).id);
    for (const row of this.db.prepare('SELECT task_id FROM task_flows').all()) { const flow = this.flow(String(row.task_id))!; this.register(flow.teamId, flow.taskId); }
    this.queue.recoverInterrupted();
    for (const row of this.db.prepare('SELECT task_id FROM task_flows').all()) {
      const flow = this.flow(String(row.task_id))!;
      if (flow.closed || this.tasks.get(flow.taskId).status === 'review') continue;
      flow.paused = true; this.save(flow);
      for (const item of this.queue.list().filter(i => i.taskId === flow.taskId)) this.queue.pauseStopped(item.id);
      this.tasks.update(flow.taskId, { status: 'blocked', executionSummary: '恢复了任务记录，等待用户继续' });
    }
    this.timer = setInterval(() => { void this.sync().catch(() => {}); }, 500);
    this.scheduler.tick();
  }
  createTeam(name: string, config?: unknown, templateId?: string, requestId?: string) { if (config !== undefined && templateId !== undefined) throw new Error('请选择模板或自定义配置，不能同时传入'); const team = this.teams.create(name, config ?? this.templates.get(templateId ?? 'build-review').config, requestId); this.changed(); return team; }
  private register(id: string, taskId: string, directory?: string) {
    for (const seat of this.teams.taskSeats(id, taskId, directory)) if (!this.ports.has(seat.sessionId)) {
      const port = this.portFactory?.(seat) ?? new CodexRuntime(this.teams, seat.sessionId, join(this.root, 'evidence'),
        (item, note) => this.queue.activity(item.id, item.generation!, note), async (seat, item) => [this.knowledge.context(seat, item.body), await this.compose(seat, item, this.teams.require(seat.teamId).contextPack)].filter(Boolean).join('\n\n'));
      this.ports.set(seat.sessionId, { cancel: item => port.cancel(item), reconcile: item => port.reconcile?.(item) ?? Promise.resolve(undefined), execute: async (item, signal) => {
        const result = await port.execute(item, signal);
        const flow = this.flow(item.taskId);
        let root = item, handoffs = 0;
        while (root.parentId) { root = this.queue.get(root.parentId); handoffs++; }
        const stepId = flow && Object.keys(flow.runs).find(key => {
          let current = flow.runs[key].itemId ? this.queue.get(flow.runs[key].itemId) : undefined;
          while (current?.parentId) current = this.queue.get(current.parentId);
          return current?.id === root.id;
        });
        const step = flow?.spec.steps.find(s => s.id === stepId);
        const exit = result.kind === 'completed' ? 'done' : result.kind === 'handoff' ? 'handoff' : result.kind === 'failed' ? 'failed' : 'waiting';
        if (result.kind !== 'canceled' && step?.allowed_exits && !step.allowed_exits.includes(exit)) return { kind: 'failed', reason: `步骤不允许 ${exit}` };
        if (result.kind === 'handoff' && (!flow || flow.hops + handoffs + 1 > flow.spec.max_hops || step?.review || !this.teams.targets(this.teams.seat(item.destination), item.taskId).some(s => s.sessionId === result.destination))) return { kind: 'failed', reason: '交接超出次数限制、审核角色约束或团队连线' };
        if (result.kind === 'completed') {
          try {
            const evidence: RuntimeEvidence = JSON.parse(await readFile(result.evidenceRef, 'utf8'));
            if (typeof evidence.summary !== 'string' || !Array.isArray(evidence.artifacts)) throw new Error('Invalid evidence');
            if (step?.review && !['pass','changes_requested'].includes(evidence.verdict ?? '')) throw new Error('审核缺少结构化结论');
            this.knowledge.record(this.teams.seat(item.destination), { ...item, evidenceRef: result.evidenceRef }, evidence);
          } catch (error) { return { kind: 'failed', reason: `成果核验失败：${error instanceof Error ? error.message : 'invalid evidence'}` }; }
        }
        return result;
      } });
    }
  }

  private flow(taskId: string): Flow | undefined {
    const row = this.db.prepare('SELECT payload FROM task_flows WHERE task_id=?').get(taskId); if (!row) return;
    const flow: Flow = JSON.parse(String(row.payload));
    if (!flow.spec) { flow.spec = this.teams.config(flow.teamId).workflow; flow.hops = 0; flow.runs = Object.fromEntries(flow.spec.steps.map(s => [s.id, { state: s.id === flow.phase ? flow.itemId ? 'active' : 'ready' : 'dormant', itemId: s.id === flow.phase ? flow.itemId : '', visit: 0 }])); this.save(flow); }
    return flow;
  }
  private save(flow: Flow) { this.db.prepare('INSERT INTO task_flows VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET payload=excluded.payload').run(flow.taskId, JSON.stringify(flow)); }
  private serial<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Execution service closing'));
    const pending = (this.operations.get(taskId) ?? Promise.resolve()).catch(() => {}).then(action); this.operations.set(taskId, pending);
    void pending.finally(() => { if (this.operations.get(taskId) === pending) this.operations.delete(taskId); }).catch(() => {}); return pending;
  }
  dispatch(taskId: string, teamId: string, directory?: string) { return this.serial(taskId, async () => {
    const task = this.tasks.get(taskId), team = this.teams.require(teamId);
    if (this.flow(taskId)) throw new Error('任务已派发，请继续或重试现有执行。');
    if (task.status !== 'pending') throw new Error('只有待派发需求可以启动。');
    this.register(teamId, taskId, directory); const seats = this.teams.taskSeats(teamId, taskId);
    const files: string[] = [], materialDir = await taskDirectory(seats[0].workspace, task.id, 'materials');
    for (const id of task.attachmentIds) { const file = this.materials.require(id), target = join(materialDir, `${id}-${basename(file.attachment.name)}`); await copyFile(file.path, target); files.push(target); }
    const spec = structuredClone(team.config.workflow);
    const flow: Flow = { taskId, teamId, cycle: randomUUID(), phase: spec.entry, itemId: '', feedback: files.length ? `任务资料：\n${files.join('\n')}` : '', artifacts: [], summary: '', closed: false, spec, hops: 0,
      runs: Object.fromEntries(spec.steps.map(s => [s.id, { state: s.id === spec.entry || s.depends_on?.length === 0 ? 'ready' : 'dormant', itemId: '', visit: 0 }])) };
    this.save(flow); await this.prepareReady(flow); this.changed();
  }); }
  private async prepareReady(flow: Flow) {
    for (const step of flow.spec.steps) {
      const run = flow.runs[step.id];
      if (run.state === 'dormant' && step.depends_on?.length && step.depends_on.every(id => flow.runs[id].state === 'done')) run.state = 'ready';
      if (run.state === 'ready' && (!step.depends_on?.length || step.depends_on.every(id => flow.runs[id].state === 'done'))) { flow.phase = step.id; await this.ensureItem(flow); }
    }
    this.focus(flow); if (!this.flow(flow.taskId)?.closed) this.save(flow);
  }
  private focus(flow: Flow) { const entry = Object.entries(flow.runs).find(([,r]) => r.state === 'active' || r.state === 'ready'); if (entry) { flow.phase = entry[0]; flow.itemId = entry[1].itemId; } }
  private async ensureItem(flow: Flow) {
    const step = flow.spec.steps.find(s => s.id === flow.phase)!, run = flow.runs[step.id];
    const task = this.tasks.get(flow.taskId), seat = this.teams.taskSeats(flow.teamId, flow.taskId).find(s => s.role === step.actor_role)!;
    const mission = await taskDirectory(seat.workspace, task.id);
    await writeMission(mission, task.brief);
    if (this.closed || this.flow(flow.taskId)?.closed) return;
    const history = Object.entries(flow.runs).filter(([,r]) => r.summary).map(([id,r]) => `${id}: ${r.summary}`).join('\n');
    const body = `${task.brief}\n${flow.feedback}\n步骤 ${step.id}：${step.objective}\n${step.review ? '这是审核步骤，必须返回 verdict=pass 或 changes_requested，并说明证据。' : ''}\n此前结果：${history}\n成果：${flow.artifacts.join('\n')}`;
    const item = this.queue.enqueue({ requestId: `flow:${flow.taskId}:${flow.cycle}:${step.id}:${run.visit}`, taskId: task.id, source: history ? 'workflow' : 'foreground', destination: seat.sessionId, body });
    if (step.gate && item.state === 'pending') this.queue.parkPending(item.id, 'human:gate', step.gate.summary);
    run.itemId = item.id; run.state = 'active'; flow.itemId = item.id; this.save(flow);
    this.tasks.update(task.id, { status: 'running', teamId: flow.teamId }); this.scheduler.tick();
  }
  sync(): Promise<void> { if (this.syncPromise) return this.syncPromise; this.syncPromise = this.syncInner().finally(() => { this.syncPromise = undefined; }); return this.syncPromise; }
  private async syncInner() {
    if (this.closed) return;
    for (const item of this.queue.list().filter(i => i.blockedOn === 'runtime:unknown')) {
      let result = await this.ports.get(item.destination)?.reconcile?.(item);
      const flow = this.flow(item.taskId);
      const step = flow?.spec.steps.find(s => flow.runs[s.id].itemId === item.id);
      if (result?.kind === 'handoff' && (step?.review || !this.teams.targets(this.teams.seat(item.destination), item.taskId).some(s => s.sessionId === (result as { destination: string }).destination))) result = { kind: 'failed', reason: '恢复结果中的交接不符合角色约束' };
      if (result) {
        let recovered: QueueItem;
        try { recovered = this.queue.reconcileResult(item.id, item.generation!, result); }
        catch (error) { recovered = this.queue.reconcileResult(item.id, item.generation!, { kind: 'failed', reason: `恢复回执不合法：${error instanceof Error ? error.message : 'invalid result'}` }); }
        if (recovered.successorId) this.queue.pauseStopped(recovered.successorId);
        else this.queue.pauseStopped(recovered.id);
        if (flow?.closed) { if (recovered.cancelRequested) this.queue.confirmCancel(recovered.id, recovered.generation); this.tasks.update(item.taskId, { status: 'canceled' }); }
        else this.tasks.update(item.taskId, { status: 'blocked', executionSummary: '已核对原执行状态，等待用户恢复' });
      }
    }
    if (this.queue.wakeDue()) this.scheduler.tick();
    for (const row of this.db.prepare('SELECT task_id FROM task_flows').all()) {
      const flow = this.flow(String(row.task_id))!; if (flow.closed || flow.fault || flow.paused || this.tasks.get(flow.taskId).status === 'review') continue;
      try {
        for (const step of flow.spec.steps) {
          const run = flow.runs[step.id]; if (run.state !== 'active') continue;
          const item = this.queue.get(run.itemId);
          if (item.state === 'handed-off') {
            if (++flow.hops > flow.spec.max_hops) { await this.scheduler.cancel(item.successorId!, 'workflow:hop-limit'); throw new Error('工作流交接次数达到上限'); }
            const successor = this.queue.get(item.successorId!);
            if (!this.teams.targets(this.teams.seat(item.destination), item.taskId).some(s => s.sessionId === successor.destination)) { await this.scheduler.cancel(successor.id, 'workflow:invalid-target'); throw new Error('交接目标未在团队连线中声明'); }
            run.itemId = successor.id; this.save(flow); continue;
          }
          if (item.state === 'done') {
            const evidence: RuntimeEvidence = JSON.parse(await readFile(item.evidenceRef!, 'utf8'));
            if (this.closed || this.flow(flow.taskId)?.closed) break;
            if (typeof evidence.summary !== 'string' || !Array.isArray(evidence.artifacts)) throw new Error('Invalid evidence');
            if (step.review && !['pass','changes_requested'].includes(evidence.verdict ?? '')) throw new Error('审核缺少结构化结论，不能进入验收');
            if (step.review && this.teams.seat(item.destination).role !== step.actor_role) throw new Error('审核必须由指定审核角色完成');
            this.knowledge.record(this.teams.seat(item.destination), item, evidence);
            flow.summary = evidence.summary; run.summary = evidence.summary; flow.artifacts = [...new Set([...flow.artifacts, ...evidence.artifacts])];
            this.advance(flow, step.id, evidence.verdict === 'changes_requested' ? 'failed' : 'done');
            this.save(flow);
          } else if (item.state === 'failed' && !step.review && step.next_hop?.on?.failed) { run.summary = item.resolution ?? ''; this.advance(flow, step.id, 'failed'); this.save(flow); }
        }
        if (this.closed || this.flow(flow.taskId)?.closed) continue;
        await this.prepareReady(flow);
        if (this.flow(flow.taskId)?.closed) continue;
        if (Object.values(flow.runs).some(r => r.state === 'ready')) throw new Error('路由目标的前置依赖尚未完成');
        const active = Object.values(flow.runs).filter(r => r.state === 'active').map(r => this.queue.get(r.itemId));
        const bad = active.find(i => ['failed','denied','canceled'].includes(i.state));
        const blocked = active.find(i => i.state === 'blocked');
        const status = bad ? bad.state === 'canceled' ? 'canceled' : 'failed' : blocked ? 'blocked' : active.length ? 'running' : 'review';
        this.tasks.update(flow.taskId, { status, executionSummary: bad?.resolution ?? blocked?.resolution ?? flow.summary });
      } catch (error) {
        flow.fault = error instanceof Error ? error.message : '执行记录核验失败'; this.save(flow);
        // Stop other branches before presenting a failed workflow. A malformed record never means acceptance.
        for (const run of Object.values(flow.runs)) if (run.itemId && ['pending','in-progress'].includes(this.queue.get(run.itemId).state)) await this.scheduler.cancel(run.itemId, 'workflow:fault');
        this.tasks.update(flow.taskId, { status: 'failed', executionSummary: flow.fault });
      }
    }
    this.changed();
  }
  private advance(flow: Flow, id: string, exit: WorkflowExit) {
    const step = flow.spec.steps.find(s => s.id === id)!;
    if (step.allowed_exits && !step.allowed_exits.includes(exit)) throw new Error(`步骤 ${id} 不允许 ${exit}`);
    const target = step.next_hop?.on?.[exit];
    flow.runs[id].state = exit === 'done' ? 'done' : 'routed';
    if (!target && exit !== 'done') throw new Error(`步骤 ${id} 未通过且没有返工路径`);
    if (target) {
      if (++flow.hops > flow.spec.max_hops) throw new Error('工作流流转次数达到上限，请调整需求或团队配置');
      for (const key of [target, ...successors(flow.spec, target)]) {
        const run = flow.runs[key]; if (run.state === 'active') throw new Error('路由目标仍在执行，不能覆盖');
        run.state = key === target ? 'ready' : 'dormant'; run.itemId = ''; run.visit++;
      }
    }
  }
  detail(taskId: string): TaskExecution | null {
    const flow = this.flow(taskId); if (!flow) return null; this.focus(flow);
    const runs = Object.entries(flow.runs).filter(([,r]) => r.itemId).map(([id,r]) => ({ id, run: r, item: this.queue.get(r.itemId) }));
    const current = runs.find(r => r.run.state === 'active' && r.item.state === 'blocked') ?? runs.find(r => r.run.state === 'active') ?? runs.at(-1);
    if (!current) return null; const item = current.item;
    const events = this.db.prepare('SELECT seq,state,note,at FROM execution_events WHERE item_id IN (SELECT id FROM execution_queue WHERE task_id=?) ORDER BY seq DESC LIMIT 100').all(taskId).reverse();
    return { teamId: flow.teamId, phase: current.id, workspace: this.teams.seat(item.destination).workspace, state: item.state, blockedOn: item.blockedOn ?? undefined, pickup: this.queue.pickup(item.id), question: ['human:user','human:gate'].includes(item.blockedOn ?? '') ? item.resolution ?? undefined : undefined, summary: flow.fault ?? item.resolution ?? flow.summary, artifacts: flow.artifacts,
      steps: runs.map(r => ({ id: r.id, itemId: r.item.id, state: r.item.state, role: this.teams.seat(r.item.destination).role, blockedOn: r.item.blockedOn ?? undefined })),
      events: events.map(e => ({ seq: Number(e.seq), state: String(e.state), note: String(e.note), at: String(e.at) })) };
  }
  private selected(taskId: string, itemId?: string) {
    const flow = this.requireFlow(taskId);
    const candidates = Object.values(flow.runs).filter(r => r.state === 'active').map(r => this.queue.get(r.itemId));
    const item = itemId ? candidates.find(i => i.id === itemId) : candidates.find(i => i.state === 'blocked' || i.state === 'failed') ?? candidates[0];
    if (!item) throw new Error('没有可操作的执行步骤'); return { flow, item };
  }
  answer(taskId: string, text: string, itemId?: string) { const { item } = this.selected(taskId, itemId); if (item.blockedOn === 'human:gate') throw new Error('审批步骤需要明确批准，不能用普通回答绕过'); this.queue.answer(item.id, text); this.scheduler.tick(); this.changed(); }
  approve(taskId: string, answer: string, itemId?: string) { const { item } = this.selected(taskId, itemId); this.queue.approveGate(item.id, answer); this.scheduler.tick(); this.changed(); }
  retry(taskId: string, itemId?: string) {
    const saved = this.requireFlow(taskId);
    if (saved.paused) {
      const items = this.queue.list().filter(i => i.taskId === taskId);
      if (items.some(i => i.blockedOn === 'runtime:unknown')) throw new Error('上次执行状态未知，请先核对运行时');
      for (const item of items) { if (item.blockedOn === 'application:paused') this.queue.resumePaused(item.id); else if (item.state === 'failed' && Object.values(saved.runs).some(r => r.state === 'active' && r.itemId === item.id)) this.queue.retry(item.id, 'human:user', '用户恢复已核对停止的失败步骤'); }
      saved.paused = false; this.save(saved); this.scheduler.tick(); void this.sync(); this.changed(); return;
    }
    const { flow, item } = this.selected(taskId, itemId);
    if (flow.fault) throw new Error('工作流核验失败，请修正原因后重新派发新任务');
    if (item.blockedOn === 'runtime:unknown') throw new Error('上次执行状态未知，请先核对运行时，不能自动重试。');
    if (item.blockedOn?.startsWith('human:')) throw new Error('请先回答问题或明确批准');
    if (item.blockedOn === 'application:paused') this.queue.resumePaused(item.id); else this.queue.retry(item.id, 'human:user', 'User requested retry after settled runtime'); this.scheduler.tick(); this.changed();
  }
  cancel(taskId: string) { return this.serial(taskId, async () => {
    if (['completed','canceled'].includes(this.tasks.get(taskId).status)) return;
    const flow = this.flow(taskId); if (!flow) { this.tasks.cancel(taskId); this.changed(); return; }
    flow.closed = true; this.save(flow);
    for (const item of this.queue.list().filter(i => i.taskId === taskId)) await this.scheduler.cancel(item.id, 'human:user');
    const unresolved = this.queue.list().some(i => i.taskId === taskId && ['in-progress','blocked'].includes(i.state));
    this.tasks.update(taskId, { status: unresolved ? 'blocked' : 'canceled' }); this.changed();
  }); }
  accept(taskId: string) { const flow = this.requireFlow(taskId); if (this.tasks.get(taskId).status !== 'review' || flow.fault) throw new Error('任务尚未到达验收阶段。'); flow.closed = true; this.save(flow); this.tasks.update(taskId, { status: 'completed' }); this.changed(); }
  revise(taskId: string, feedback: string) { return this.serial(taskId, async () => {
    const flow = this.requireFlow(taskId); if (this.tasks.get(taskId).status !== 'review' || typeof feedback !== 'string' || !feedback.trim() || feedback.length > 16000) throw new Error('请在待验收任务中填写修改要求。');
    flow.cycle = randomUUID(); flow.hops = 0; flow.feedback += `\n用户修改要求：${feedback}`;
    for (const step of flow.spec.steps) flow.runs[step.id] = { state: step.id === flow.spec.entry || step.depends_on?.length === 0 ? 'ready' : 'dormant', itemId: '', visit: 0 };
    this.save(flow); await this.prepareReady(flow); this.changed();
  }); }
  reconcileStopped(taskId: string, itemId?: string) {
    const flow = this.flow(taskId); if (!flow) throw new Error('没有中断的执行');
    const item = this.queue.list().find(i => i.taskId === taskId && (!itemId || i.id === itemId) && i.state === 'blocked' && i.blockedOn === 'runtime:unknown');
    if (!item) throw new Error('任务不处于未知执行状态');
    if (item.cancelRequested) this.queue.confirmCancel(item.id, item.generation!);
    else { this.queue.retry(item.id, 'human:user', 'User explicitly confirmed old execution has stopped'); this.scheduler.tick(); }
    if (flow.paused && !this.queue.list().some(i => i.taskId === taskId && i.blockedOn === 'runtime:unknown')) this.retry(taskId);
    this.changed();
  }
  rotateSession(taskId: string, itemId?: string) { const { item } = this.selected(taskId, itemId); if (!['failed','blocked'].includes(item.state) || item.blockedOn === 'runtime:unknown' || item.cancelRequested || item.blockedOn?.startsWith('human:')) throw new Error('只能接替已确认停止的失败执行'); this.teams.rotate(item.destination); this.retry(taskId, item.id); }
  resultPath(taskId: string, index: number) { const flow = this.flow(taskId); if (!flow || !Number.isInteger(index) || !flow.artifacts[index]) throw new Error('成果不存在。'); return flow.artifacts[index]; }
  private requireFlow(id: string) { const flow = this.flow(id); if (!flow || flow.closed) throw new Error('任务没有可操作的执行。'); return flow; }
  close(): Promise<void> { return this.closing ??= this.closeInner(); }
  private async closeInner() {
    this.closed = true; clearInterval(this.timer); await Promise.allSettled([...this.operations.values()]); if (this.syncPromise) await this.syncPromise;
    this.scheduler.stop();
    for (const item of this.queue.list()) {
      if (item.state === 'in-progress') await this.scheduler.cancel(item.id, 'application:quit');
      else if (item.state === 'pending') this.queue.parkPending(item.id, 'application:paused', '应用已退出，等待用户恢复');
    }
    await this.scheduler.drain();
    for (const row of this.db.prepare('SELECT task_id FROM task_flows').all()) {
      const flow = this.flow(String(row.task_id))!;
      if (flow.closed || ['review','completed','canceled'].includes(this.tasks.get(flow.taskId).status)) continue;
      flow.paused = true; this.save(flow);
      for (const run of Object.values(flow.runs)) if (run.itemId) this.queue.pauseStopped(run.itemId);
      this.tasks.update(flow.taskId, { status: 'blocked', executionSummary: '应用已退出，等待恢复任务' });
    }
    this.db.close();
  }
}
