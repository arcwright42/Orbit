import { randomUUID } from 'node:crypto';
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openCoreDatabase } from '../infrastructure/core-database';
import { TaskRepository } from '../domains/tasks/repository';
import { ExecutionQueue } from '../domains/orchestration/queue';
import { Scheduler } from '../domains/orchestration/scheduler';
import { TeamRegistry, type Seat } from '../domains/teams/registry';
import { CodexRuntime, type RuntimeEvidence } from '../domains/runtime/codex';
import type { ExecutionPort } from '../domains/runtime/execution-port';
import type { QueueItem } from '../domains/orchestration/types';
import type { MaterialLibrary } from '../domains/materials/library';
import type { TaskExecution } from '../contracts';

interface Flow { taskId: string; teamId: string; cycle: string; phase: 'builder' | 'reviewer'; itemId: string; feedback: string; artifacts: string[]; summary: string; closed: boolean }
export class TaskExecutionService {
  private db: DatabaseSync;
  readonly queue: ExecutionQueue;
  readonly teams: TeamRegistry;
  private scheduler: Scheduler;
  private tasks: TaskRepository;
  private ports = new Map<string, ExecutionPort>();
  private syncing = false;
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
    this.scheduler = new Scheduler(this.queue, this.ports, 2, destination => this.teams.seat(destination).teamId);
    for (const row of this.db.prepare('SELECT payload FROM task_flows').all()) { const flow: Flow = JSON.parse(String(row.payload)); this.register(flow.teamId, flow.taskId); }
    // Electron is a single-instance owner; uncertain work remains blocked pending explicit reconciliation.
    this.queue.recoverInterrupted();
    this.timer = setInterval(() => { void this.sync().catch(() => { /* Next replay retries without advancing a cursor. */ }); }, 500);
    this.scheduler.tick();
  }
  createTeam(name: string) { const team = this.teams.create(name); this.changed(); return team; }
  private register(id: string, taskId: string) {
    for (const seat of this.teams.taskSeats(id, taskId)) this.ports.set(seat.sessionId, this.portFactory?.(seat) ?? new CodexRuntime(this.teams, seat.sessionId, join(this.root, 'evidence'),
      (item, note) => this.queue.activity(item.id, item.generation!, note), (seat, item) => this.compose(seat, item, this.teams.require(seat.teamId).contextPack)));
  }
  private flow(taskId: string): Flow | undefined { const row = this.db.prepare('SELECT payload FROM task_flows WHERE task_id=?').get(taskId); return row ? JSON.parse(String(row.payload)) : undefined; }
  private save(flow: Flow) { this.db.prepare('INSERT INTO task_flows VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET payload=excluded.payload').run(flow.taskId, JSON.stringify(flow)); }
  private serial<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Execution service closing'));
    const pending = (this.operations.get(taskId) ?? Promise.resolve()).catch(() => {}).then(action);
    this.operations.set(taskId, pending);
    void pending.finally(() => { if (this.operations.get(taskId) === pending) this.operations.delete(taskId); }).catch(() => {});
    return pending;
  }
  dispatch(taskId: string, teamId: string) { return this.serial(taskId, () => this.dispatchInner(taskId, teamId)); }
  private async dispatchInner(taskId: string, teamId: string) {
    const task = this.tasks.get(taskId); this.teams.require(teamId);
    if (this.flow(taskId)) throw new Error('任务已派发，请继续或重试现有执行。');
    if (task.status !== 'pending') throw new Error('只有待派发需求可以启动。');
    this.register(teamId, taskId); const seats = this.teams.taskSeats(teamId, taskId);
    const materials: string[] = [];
    const directory = join(seats[0].workspace, 'materials', task.id); await mkdir(directory, { recursive: true });
    for (const id of task.attachmentIds) { const file = this.materials.require(id); const target = join(directory, `${id}-${basename(file.attachment.name)}`); await copyFile(file.path, target); materials.push(target); }
    const flow: Flow = { taskId, teamId, cycle: randomUUID(), phase: 'builder', itemId: '', feedback: materials.length ? `\n任务资料（仅本任务附件）：\n${materials.join('\n')}` : '', artifacts: [], summary: '', closed: false };
    this.save(flow); await this.ensureItem(flow); this.changed();
  }
  private async ensureItem(flow: Flow) {
    const task = this.tasks.get(flow.taskId), team = this.teams.require(flow.teamId), seats = this.teams.taskSeats(flow.teamId, flow.taskId), seat = seats.find(s => s.role === flow.phase)!;
    const mission = join(seat.workspace, '.orbit', task.id), seatRoot = join(seat.workspace, '.orbit', 'seats', seat.sessionId);
    await mkdir(mission, { recursive: true }); await mkdir(seatRoot, { recursive: true });
    await writeFile(join(mission, 'MISSION.md'), task.brief);
    if (flow.summary) await writeFile(join(seatRoot, 'RECAP.md'), flow.summary);
    if (this.closed || this.flow(flow.taskId)?.closed) return;
    const body = flow.phase === 'builder' ? `${task.brief}\n${flow.feedback}` : `请独立检查以下任务与成果。核实真实文件和必要检查，不代替用户验收。\n原始需求：${task.brief}\n执行者回执：${flow.summary}\n成果：${flow.artifacts.join('\n')}`;
    const item = this.queue.enqueue({ requestId: `flow:${flow.taskId}:${flow.cycle}:${flow.phase}`, taskId: flow.taskId, source: flow.phase === 'builder' ? 'foreground' : seats.find(s => s.role === 'builder')!.sessionId, destination: seat.sessionId, body });
    flow.itemId = item.id; this.save(flow); this.tasks.update(task.id, { status: 'running', teamId: team.id }); this.scheduler.tick();
  }
  sync(): Promise<void> { if (this.syncPromise) return this.syncPromise; this.syncPromise = this.syncInner().finally(() => { this.syncPromise = undefined; }); return this.syncPromise; }
  private async syncInner() {
    if (this.syncing || this.closed) return; this.syncing = true;
    try {
      let changed = false;
      for (const row of this.db.prepare('SELECT payload FROM task_flows').all()) {
        const flow: Flow = JSON.parse(String(row.payload));
        if (flow.closed) {
          if (flow.itemId && this.tasks.get(flow.taskId).status !== 'completed') {
            const item = this.queue.get(flow.itemId);
            if (['canceled','done','failed','denied'].includes(item.state) && this.tasks.get(flow.taskId).status !== 'canceled') { this.tasks.update(flow.taskId, { status: 'canceled' }); changed = true; }
          }
          continue;
        }
        try {
        if (!flow.itemId) { await this.ensureItem(flow); changed = true; continue; }
        const item = this.queue.get(flow.itemId), task = this.tasks.get(flow.taskId);
        if (item.state === 'done' && task.status !== 'review' && task.status !== 'completed') {
          const evidence = JSON.parse(await readFile(item.evidenceRef!, 'utf8')) as RuntimeEvidence;
          if (this.closed || this.flow(flow.taskId)?.closed) continue;
          if (typeof evidence.summary !== 'string' || !Array.isArray(evidence.artifacts)) throw new Error('Invalid evidence');
          flow.summary = evidence.summary; flow.artifacts = [...new Set([...flow.artifacts, ...evidence.artifacts])];
          if (flow.phase === 'builder') { flow.phase = 'reviewer'; flow.itemId = ''; this.save(flow); await this.ensureItem(flow); }
          else { this.save(flow); this.tasks.update(task.id, { status: 'review', executionSummary: flow.summary }); }
          changed = true;
        } else {
          const status = item.state === 'blocked' ? 'blocked' : item.state === 'failed' || item.state === 'denied' ? 'failed' : item.state === 'canceled' ? 'canceled' : item.state === 'pending' || item.state === 'in-progress' ? 'running' : task.status;
          if (task.status !== status) { this.tasks.update(task.id, { status, executionSummary: item.resolution ?? undefined }); changed = true; }
        }
        } catch (error) {
          this.tasks.update(flow.taskId, { status: 'failed', executionSummary: `执行记录核验失败：${error instanceof Error ? error.message : 'unknown'}` });
          changed = true;
        }
      }
      if (changed) this.changed();
    } finally { this.syncing = false; }
  }
  detail(taskId: string): TaskExecution | null {
    const flow = this.flow(taskId); if (!flow?.itemId) return null; const item = this.queue.get(flow.itemId);
    const events = this.db.prepare('SELECT seq,state,note,at FROM execution_events WHERE item_id IN (SELECT id FROM execution_queue WHERE task_id=?) ORDER BY seq DESC LIMIT 100').all(taskId).reverse();
    return { teamId: flow.teamId, phase: flow.phase, state: item.state, blockedOn: item.blockedOn ?? undefined, pickup: this.queue.pickup(item.id), question: item.blockedOn === 'human:user' ? item.resolution ?? undefined : undefined, summary: item.resolution ?? flow.summary, artifacts: flow.artifacts, events: events.map(e => ({ seq: Number(e.seq), state: String(e.state), note: String(e.note), at: String(e.at) })) };
  }
  answer(taskId: string, text: string) { const flow = this.requireFlow(taskId); this.queue.answer(flow.itemId, text); this.scheduler.tick(); this.changed(); }
  retry(taskId: string) { const flow = this.requireFlow(taskId), item = this.queue.get(flow.itemId); if (item.blockedOn === 'runtime:unknown') throw new Error('上次执行状态未知，请先核对运行时，不能自动重试。'); this.queue.retry(item.id, 'human:user', 'User requested retry after a settled runtime result'); this.scheduler.tick(); this.changed(); }
  cancel(taskId: string) { return this.serial(taskId, () => this.cancelInner(taskId)); }
  private async cancelInner(taskId: string) { if (['completed', 'canceled'].includes(this.tasks.get(taskId).status)) return; const flow = this.flow(taskId); if (!flow) { this.tasks.cancel(taskId); this.changed(); return; } flow.closed = true; this.save(flow);
    if (!flow.itemId) { this.tasks.update(taskId, { status: 'canceled' }); this.changed(); return; }
    await this.scheduler.cancel(flow.itemId, 'human:user');
    const item = this.queue.get(flow.itemId);
    this.tasks.update(taskId, { status: item.state === 'canceled' || item.state === 'done' ? 'canceled' : 'blocked', executionSummary: item.state === 'done' ? '已停止后续阶段；保留已产生成果。' : item.resolution ?? '取消等待运行时确认' }); this.changed(); }
  accept(taskId: string) { const flow = this.requireFlow(taskId); if (this.tasks.get(taskId).status !== 'review') throw new Error('任务尚未到达验收阶段。'); flow.closed = true; this.save(flow); this.tasks.update(taskId, { status: 'completed' }); this.changed(); }
  revise(taskId: string, feedback: string) { return this.serial(taskId, () => this.reviseInner(taskId, feedback)); }
  private async reviseInner(taskId: string, feedback: string) { const flow = this.requireFlow(taskId); if (this.tasks.get(taskId).status !== 'review' || typeof feedback !== 'string' || !feedback.trim() || feedback.length > 16000) throw new Error('请在待验收任务中填写修改要求。'); flow.cycle = randomUUID(); flow.phase = 'builder'; flow.feedback += `\n用户修改要求：${feedback}`; flow.itemId = ''; this.save(flow); await this.ensureItem(flow); this.changed(); }
  reconcileStopped(taskId: string) {
    const flow = this.flow(taskId); if (!flow?.itemId) throw new Error('没有中断的执行');
    const item = this.queue.get(flow.itemId);
    if (item.state !== 'blocked' || item.blockedOn !== 'runtime:unknown') throw new Error('任务不处于未知执行状态');
    if (item.cancelRequested) { this.queue.confirmCancel(item.id, item.generation!); this.tasks.update(taskId, { status: 'canceled' }); }
    else { flow.closed = false; this.save(flow); this.queue.retry(item.id, 'human:user', 'User explicitly confirmed old execution has stopped'); this.scheduler.tick(); }
    this.changed();
  }
  resultPath(taskId: string, index: number) { const flow = this.flow(taskId); if (!flow || !Number.isInteger(index) || !flow.artifacts[index]) throw new Error('成果不存在。'); return flow.artifacts[index]; }
  private requireFlow(id: string) { const flow = this.flow(id); if (!flow?.itemId || flow.closed) throw new Error('任务没有可操作的执行。'); return flow; }
  close(): Promise<void> { return this.closing ??= this.closeInner(); }
  private async closeInner() { this.closed = true; clearInterval(this.timer); await Promise.allSettled([...this.operations.values()]); if (this.syncPromise) await this.syncPromise; this.scheduler.stop(); for (const item of this.queue.list()) if (item.state === 'in-progress') await this.scheduler.cancel(item.id, 'application:quit'); await this.scheduler.drain(); this.db.close(); }
}
