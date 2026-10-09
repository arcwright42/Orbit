import { exceptionTarget, type ExceptionClass } from '../domains/workflows/exceptions';
import { backendAttempt } from './backend-tools';
import { randomUUID } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { transaction } from '../infrastructure/database';
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
import type { ExecutionResult, QueueItem } from '../domains/orchestration/types';
import { taskDirectory, writeMission } from '../domains/materials/workspace-files';
import type { MaterialLibrary } from '../domains/materials/library';
import type { TaskExecution } from '../contracts';
import { MemoryStore } from '../domains/memory/store';
import { TeamKnowledge } from '../domains/memory/team-knowledge';
import { successors, type WorkflowSpec, type WorkflowExit } from '../domains/workflows/spec';

interface StepRun { state: 'dormant' | 'ready' | 'active' | 'done' | 'routed'; itemId: string; visit: number; summary?: string }
interface ExceptionRun { sourceId: string; sourceGeneration: string | null; stepId: string; itemId?: string; kind: ExceptionClass; status: 'open' | 'resolved' | 'human' }
interface Flow { taskId: string; teamId: string; cycle: string; phase: string; itemId: string; feedback: string; artifacts: string[]; summary: string; closed: boolean; spec: WorkflowSpec; runs: Record<string, StepRun>; hops: number; authors?: string[]; exceptions?: Record<string, ExceptionRun>; fault?: string; paused?: boolean }
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
    this.db.exec('CREATE TABLE IF NOT EXISTS task_flows (task_id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workflow_transitions (seq INTEGER PRIMARY KEY AUTOINCREMENT,item_id TEXT NOT NULL,generation TEXT NOT NULL,task_id TEXT NOT NULL,step_id TEXT NOT NULL,exit TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(item_id,generation))');
    this.queue = new ExecutionQueue(this.db); this.teams = new TeamRegistry(this.db, join(root, 'workspaces'));
    this.templates = new TeamTemplates(this.db);
    this.memory = new MemoryStore(this.db); this.knowledge = new TeamKnowledge(this.memory, this.teams, this.db);
    // Stable seat ownership protects its knowledge; different members may run concurrently.
    this.scheduler = new Scheduler(this.queue, this.ports, 4, destination => this.teams.seat(destination).id);
    for (const row of this.db.prepare('SELECT task_id FROM task_flows').all()) { const flow = this.flow(String(row.task_id))!; this.register(flow.teamId, flow.taskId); }
    this.queue.setClaimGuard(item => { const flow = this.flow(item.taskId); return !!flow && !flow.closed && !flow.paused && !flow.fault; });
    this.queue.setProjector((item, result) => this.projectResult(item, result));
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
        (item, note) => this.queue.activity(item.id, item.generation!, note), async (seat, item) => [this.knowledge.context(seat, item.body), await this.compose(seat, item, this.teams.require(seat.teamId).contextPack)].filter(Boolean).join('\n\n'), undefined, (seat, item) => backendAttempt(this.queue, this.teams, this.memory, seat, item, () => this.handoffTargets(seat, item)));
      this.ports.set(seat.sessionId, { cancel: item => port.cancel(item), reconcile: item => port.reconcile?.(item) ?? Promise.resolve(undefined), execute: async (item, signal) => {
        this.flushKnowledge();
        const start = this.flow(item.taskId), step = start?.spec.steps.find(s => start.runs[s.id].itemId === item.id);
        if (start?.closed || signal.aborted) return { kind: 'canceled', reason: '任务已取消' };
        if (start && step) {
          if (step.review && start.authors?.includes(seat.id)) return { kind: 'failed', reason: '该席位参与过实际制作，不能独立审核自己的成果' };
          if (!step.review) { start.authors = [...new Set([...(start.authors ?? []), seat.id])]; this.save(start); }
        }
        const result = await port.execute(item, signal);
        if (result.kind === 'completed') {
          try {
            const evidence = this.evidence(result.evidenceRef);
            if (step?.review && !['pass','changes_requested'].includes(evidence.verdict ?? '')) throw new Error('审核缺少结构化结论');
          } catch (error) { return { kind: 'failed', reason: `成果核验失败：${error instanceof Error ? error.message : 'invalid evidence'}` }; }
        }
        return result;
      } });
    }
  }

  private handoffTargets(seat: Seat, item: QueueItem) {
    const flow = this.flow(item.taskId), step = flow?.spec.steps.find(s => flow.runs[s.id].itemId === item.id);
    if (!flow || !step || step.review) return [];
    return this.teams.targets(seat, item.taskId).filter(target => !flow.spec.steps.some(s => s.review && s.actor_role === target.role));
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
    await writeMission(await taskDirectory(seats[0].workspace, task.id), task.brief);
    transaction(this.db, () => { this.save(flow); this.prepareReady(flow); }); this.scheduler.tick(); this.changed();
  }); }
  private prepareReady(flow: Flow) {
    if (this.closed || flow.paused || flow.closed) return;
    for (const step of flow.spec.steps) {
      const run = flow.runs[step.id];
      if (run.state === 'dormant' && step.depends_on?.length && step.depends_on.every(id => flow.runs[id].state === 'done')) run.state = 'ready';
      if (run.state === 'ready' && (!step.depends_on?.length || step.depends_on.every(id => flow.runs[id].state === 'done'))) { flow.phase = step.id; this.ensureItem(flow); }
    }
    this.focus(flow); if (!this.flow(flow.taskId)?.closed) this.save(flow);
  }
  private focus(flow: Flow) { const entry = Object.entries(flow.runs).find(([,r]) => r.state === 'active' || r.state === 'ready'); if (entry) { flow.phase = entry[0]; flow.itemId = entry[1].itemId; } }
  private ensureItem(flow: Flow) {
    const step = flow.spec.steps.find(s => s.id === flow.phase)!, run = flow.runs[step.id];
    const task = this.tasks.get(flow.taskId), seat = this.teams.taskSeats(flow.teamId, flow.taskId).find(s => s.role === step.actor_role)!;
    if (this.closed || this.flow(flow.taskId)?.closed) return;
    const history = Object.entries(flow.runs).filter(([,r]) => r.summary).map(([id,r]) => `${id}: ${r.summary}`).join('\n');
    const body = `${task.brief}\n${flow.feedback}\n步骤 ${step.id}：${step.objective}\n${step.review ? '这是审核步骤，必须返回 verdict=pass 或 changes_requested，并说明证据。' : ''}\n此前结果：${history}\n成果：${flow.artifacts.join('\n')}`;
    const item = this.queue.enqueue({ requestId: `flow:${flow.taskId}:${flow.cycle}:${step.id}:${run.visit}`, taskId: task.id, source: history ? 'workflow' : 'foreground', destination: seat.sessionId, body });
    if (step.gate && item.state === 'pending') this.queue.parkPending(item.id, 'human:gate', step.gate.summary);
    run.itemId = item.id; run.state = 'active'; flow.itemId = item.id; this.save(flow);

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
    this.flushKnowledge();
    if (this.queue.wakeDue()) this.scheduler.tick();
    for (const row of this.db.prepare('SELECT task_id FROM task_flows').all()) {
      const flow = this.flow(String(row.task_id))!; if (flow.fault) { for (const item of this.queue.list().filter(i => i.taskId === flow.taskId && ['pending','in-progress'].includes(i.state))) await this.scheduler.cancel(item.id, 'workflow:fault'); this.tasks.update(flow.taskId, { status: 'failed', executionSummary: flow.fault }); continue; } if (flow.closed || flow.paused || this.tasks.get(flow.taskId).status === 'review') continue;
      try {
        transaction(this.db, () => {
          for (const [stepId, run] of Object.entries(flow.runs)) if (run.state === 'active' && this.queue.pickup(run.itemId) === 'stalled-after-claim') this.routeException(flow, stepId, this.queue.get(run.itemId), 'stuck_overdue');
          this.save(flow);
        });
        // Legacy rows may have completed before transactional projection existed.
        for (const step of flow.spec.steps) {
          const run = flow.runs[step.id]; if (run.state !== 'active') continue;
          const item = this.queue.get(run.itemId);
          if (this.db.prepare('SELECT 1 FROM workflow_transitions WHERE item_id=? AND generation=?').get(item.id, item.generation)) continue;
          const result: ExecutionResult | undefined = item.state === 'done' ? { kind: 'completed', summary: item.resolution ?? '', evidenceRef: item.evidenceRef! }
            : item.state === 'handed-off' ? { kind: 'handoff', destination: this.queue.get(item.successorId!).destination, body: '', reason: item.resolution ?? '' }
            : item.state === 'failed' ? { kind: 'failed', reason: item.resolution ?? '' } : undefined;
          if (result) transaction(this.db, () => this.projectResult(item, result));
        }
        const latest = this.flow(flow.taskId)!; Object.assign(flow, latest);
        if (this.closed || flow.closed || flow.fault) continue;
        transaction(this.db, () => this.prepareReady(flow)); this.scheduler.tick();
        const recovery = Object.values(flow.exceptions ?? {}).filter(e => e.status === 'open' && e.itemId);
        const active = [...Object.values(flow.runs).filter(r => r.state === 'active' && !recovery.some(e => e.sourceId === r.itemId)).map(r => this.queue.get(r.itemId)), ...recovery.map(e => this.queue.get(e.itemId!))];
        const bad = active.find(i => ['failed','denied','canceled'].includes(i.state));
        const blocked = active.find(i => i.state === 'blocked');
        const status = bad ? bad.state === 'canceled' ? 'canceled' : 'failed' : blocked ? 'blocked' : active.length || Object.values(flow.runs).some(r => r.state === 'ready') ? 'running' : 'review';
        this.tasks.update(flow.taskId, { status, teamId: flow.teamId, executionSummary: bad?.resolution ?? blocked?.resolution ?? flow.summary });
      } catch (error) {
        flow.fault = error instanceof Error ? error.message : '执行记录核验失败'; this.save(flow);
        // Stop other branches before presenting a failed workflow. A malformed record never means acceptance.
        for (const item of this.queue.list().filter(i => i.taskId === flow.taskId && ['pending','in-progress'].includes(i.state))) await this.scheduler.cancel(item.id, 'workflow:fault');
        this.tasks.update(flow.taskId, { status: 'failed', executionSummary: flow.fault });
      }
    }
    this.changed();
  }
  private flushKnowledge() {
    for (const row of this.db.prepare("SELECT q.* FROM execution_queue q JOIN workflow_transitions w ON w.item_id=q.id AND w.generation=q.generation WHERE q.state='done' AND NOT EXISTS (SELECT 1 FROM knowledge_projections s WHERE s.record_key=q.id || '-' || q.generation)").all()) {
      const item = this.queue.get(String(row.id));
      try { this.knowledge.record(this.teams.seat(item.destination), item, this.evidence(item.evidenceRef!)); } catch { /* Durable result remains available for knowledge projection retry. */ }
    }
  }
  private evidence(path: string): RuntimeEvidence {
    const evidence: RuntimeEvidence = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof evidence.summary !== 'string' || !Array.isArray(evidence.artifacts) || evidence.artifacts.some(a => typeof a !== 'string')) throw new Error('Invalid evidence');
    return evidence;
  }
  /** Runs inside the queue's transaction: packet close, frontier, successors and trail commit together. */
  private projectResult(item: QueueItem, result: ExecutionResult) {
    const flow = this.flow(item.taskId); if (!flow || flow.closed) return;
    const diagnostic = Object.values(flow.exceptions ?? {}).find(e => e.itemId === item.id && e.status === 'open');
    if (diagnostic) { this.resolveException(flow, diagnostic, item, result); return; }
    const step = flow.spec.steps.find(s => flow.runs[s.id].state === 'active' && flow.runs[s.id].itemId === item.id);
    if (!step || this.db.prepare('SELECT 1 FROM workflow_transitions WHERE item_id=? AND generation=?').get(item.id, item.generation)) return;
    const run = flow.runs[step.id];
    const rejected = result.kind === 'failed' && result.reason.startsWith('执行回执被拒绝');
    const exit: WorkflowExit = result.kind === 'completed' ? 'done' : result.kind === 'handoff' ? 'handoff' : result.kind === 'failed' ? 'failed' : 'waiting';
    if (!rejected && result.kind !== 'canceled' && step.allowed_exits && !step.allowed_exits.includes(exit)) throw new Error(`步骤不允许 ${exit}`);
    if (result.kind === 'handoff' && item.state === 'handed-off') {
      const target = this.teams.seat(result.destination);
      if (++flow.hops > flow.spec.max_hops) throw new Error('交接次数达到上限');
      if (step.review || flow.spec.steps.some(s => s.review && s.actor_role === target.role)) throw new Error('执行工作不能交给保留的独立审核席位');
      if (!this.teams.targets(this.teams.seat(item.destination), item.taskId).some(s => s.sessionId === target.sessionId)) throw new Error('交接目标未在团队连线中声明');
      run.itemId = item.successorId!;
      if (flow.paused || this.closed) this.queue.pauseStopped(run.itemId);
    } else if (result.kind === 'completed' && item.state === 'done') {
      const evidence = this.evidence(result.evidenceRef);
      const seat = this.teams.seat(item.destination);
      if (step.review && (seat.role !== step.actor_role || flow.authors?.includes(seat.id) || !['pass','changes_requested'].includes(evidence.verdict ?? ''))) throw new Error('独立审核角色、作者隔离或审核结论不成立');
      run.summary = evidence.summary; flow.summary = evidence.summary; flow.artifacts = [...new Set([...flow.artifacts, ...evidence.artifacts])];
      this.advance(flow, step.id, evidence.verdict === 'changes_requested' ? 'failed' : 'done');
    } else if (result.kind === 'failed') {
      if (rejected) flow.fault = result.reason;
      else if (!step.review && step.next_hop?.on?.failed) { run.summary = result.reason; this.advance(flow, step.id, 'failed'); }
      else this.routeException(flow, step.id, item, 'unmapped_failed');
    }
    if (result.kind === 'blocked' && item.blockedOn !== 'runtime:unknown' && /^(runtime|context|auth):/.test(item.blockedOn ?? '')) this.routeException(flow, step.id, item, 'unmapped_failed');
    this.save(flow);
    if (!flow.fault) this.prepareReady(flow);
    this.db.prepare('INSERT INTO workflow_transitions (item_id,generation,task_id,step_id,exit,payload) VALUES (?,?,?,?,?,?)')
      .run(item.id, item.generation!, item.taskId, step.id, exit, JSON.stringify({ result, frontier: Object.values(flow.runs).filter(r => r.state === 'active').map(r => r.itemId), hops: flow.hops }));
  }
  private routeException(flow: Flow, stepId: string, source: QueueItem, kind: ExceptionClass) {
    const key = `${source.id}:${source.generation}:${kind}`;
    flow.exceptions ??= {}; if (flow.exceptions[key]) return;
    const record: ExceptionRun = { sourceId: source.id, sourceGeneration: source.generation, stepId, kind, status: 'human' };
    flow.exceptions[key] = record;
    const role = exceptionTarget(flow.spec.exception_routing, kind, source.blockedOn);
    const seat = this.teams.taskSeats(flow.teamId, flow.taskId).find(s => s.role === role);
    // Bound recovery recursion, never ask the failed occupant to certify its own recovery.
    if (!seat || seat.sessionId === source.destination || flow.hops >= flow.spec.max_hops || this.closed || flow.paused) return;
    flow.hops++;
    const diagnostic = this.queue.enqueue({ requestId: `exception:${key}`, taskId: flow.taskId, source: source.destination, destination: seat.sessionId,
      body: `异常诊断 ${kind}。原义务 ${source.id}，状态 ${source.state}，原因：${source.resolution ?? ''}。\n仅分析证据和选择恢复建议，不接手制作或代替用户审批。使用平台工具 get_work 查询原义务。以 outcome=completed 提交诊断，recoveryAction 必须为 retry（重试已停止步骤）、rotate（新会话接替已停止步骤）、ask_user（请求用户处理）或 abort（保留失败）。summary 说明原因；不得因超时推断进程已停止。完成诊断不代表原任务完成。` });
    record.itemId = diagnostic.id; record.status = 'open';
  }
  private resolveException(flow: Flow, record: ExceptionRun, item: QueueItem, result: ExecutionResult) {
    if (this.db.prepare('SELECT 1 FROM workflow_transitions WHERE item_id=? AND generation=?').get(item.id, item.generation)) return;
    const source = this.queue.get(record.sourceId);
    if (source.generation !== record.sourceGeneration) record.status = 'resolved';
    else if (result.kind === 'completed') {
      const evidence = this.evidence(result.evidenceRef), action = evidence.recoveryAction;
      if (!action) throw new Error('诊断缺少恢复建议');
      const stopped = source.state === 'failed' || source.state === 'blocked' && source.blockedOn !== 'runtime:unknown' && !source.blockedOn?.startsWith('human:') && !source.blockedOn?.startsWith('auth:');
      if (['retry','rotate'].includes(action) && stopped && !source.cancelRequested) {
        if (action === 'rotate') this.teams.rotate(source.destination);
        this.queue.retry(source.id, item.destination, `协调者依据：${evidence.summary}`); record.status = 'resolved';
      } else { record.status = action === 'abort' ? 'resolved' : 'human'; }
    } else if (result.kind === 'handoff') { throw new Error('诊断不能转移原任务所有权，请提交明确恢复建议'); }
    else if (result.kind === 'failed' || result.kind === 'canceled') record.status = 'human';
    // Question/blocked keep the diagnostic active so the user can answer the actual question.
    this.save(flow);
    this.db.prepare('INSERT INTO workflow_transitions (item_id,generation,task_id,step_id,exit,payload) VALUES (?,?,?,?,?,?)')
      .run(item.id, item.generation!, item.taskId, `exception:${record.stepId}`, result.kind, JSON.stringify({ result, status: record.status, sourceId: source.id }));
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
    for (const e of Object.values(flow.exceptions ?? {})) if (e.itemId && e.status === 'open') runs.unshift({ id: `exception:${e.stepId}`, run: { state: 'active', itemId: e.itemId, visit: 0 }, item: this.queue.get(e.itemId) });
    const current = runs.find(r => r.run.state === 'active' && r.item.state === 'blocked') ?? runs.find(r => r.run.state === 'active') ?? runs.at(-1);
    if (!current) return null; const item = current.item;
    const events = this.db.prepare('SELECT seq,state,note,at FROM execution_events WHERE item_id IN (SELECT id FROM execution_queue WHERE task_id=?) ORDER BY seq DESC LIMIT 100').all(taskId).reverse();
    return { teamId: flow.teamId, phase: current.id, workspace: this.teams.seat(item.destination).workspace, state: item.state, blockedOn: item.blockedOn ?? undefined, pickup: this.queue.pickup(item.id), question: ['human:user','human:gate'].includes(item.blockedOn ?? '') ? item.resolution ?? undefined : undefined, summary: flow.fault ?? item.resolution ?? flow.summary, artifacts: flow.artifacts,
      steps: runs.map(r => ({ id: r.id, itemId: r.item.id, state: r.item.state, role: this.teams.seat(r.item.destination).role, blockedOn: r.item.blockedOn ?? undefined })),
      events: events.map(e => ({ seq: Number(e.seq), state: String(e.state), note: String(e.note), at: String(e.at) })) };
  }
  private selected(taskId: string, itemId?: string) {
    const flow = this.requireFlow(taskId);
    const candidates = [...Object.values(flow.exceptions ?? {}).filter(e => e.status === 'open' && e.itemId).map(e => this.queue.get(e.itemId!)), ...Object.values(flow.runs).filter(r => r.state === 'active').map(r => this.queue.get(r.itemId))];
    const item = itemId ? candidates.find(i => i.id === itemId) : candidates.find(i => i.blockedOn?.startsWith('human:')) ?? candidates.find(i => i.state === 'blocked' || i.state === 'failed') ?? candidates[0];
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
    transaction(this.db, () => { this.save(flow); this.prepareReady(flow); }); this.scheduler.tick(); this.changed();
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
      for (const item of this.queue.list().filter(i => i.taskId === flow.taskId)) this.queue.pauseStopped(item.id);
      this.tasks.update(flow.taskId, { status: 'blocked', executionSummary: '应用已退出，等待恢复任务' });
    }
    this.db.close();
  }
}
