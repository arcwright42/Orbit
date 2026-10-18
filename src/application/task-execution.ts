import { randomUUID } from 'node:crypto';
import type { Task } from '../contracts';
import { ExecutionRepository } from '../domains/tasks/execution-repository';
import { boundedText, object, validateExecutionSettings, type RuntimeSelection, type TaskDetail, type TaskEvent, type TaskQuestion, type TaskRun, type TaskStep } from '../domains/tasks/execution';
import { validatePlan } from '../domains/tasks/plan';
import type { TaskRuntimeEvent, TaskRuntimeHandle, TaskRuntimeOutcome, TaskRuntimePort } from '../domains/tasks/runtime';
import { TaskFiles } from '../infrastructure/tasks/files';
import { executionTools } from './task-tools';

interface ActiveRun { handle: TaskRuntimeHandle; stopped?: 'cancel' | 'shutdown'; finished: Promise<void> }
const activeRunStates = new Set(['starting', 'running', 'waiting', 'unresolved']);
const executableTaskStates = new Set(['queued', 'planning', 'running', 'interrupted', 'waiting']);

/** The only owner of execution state. Runtime events are observations, tool calls are commands. */
export class TaskExecutionService {
  private active = new Map<string, ActiveRun>();
  private answers = new Map<string, { resolve: (answer: string) => void; reject: (error: Error) => void }>();
  private pumping = false;
  private ready = false;
  private closing = false;
  private dispatching = new Map<string, { mode: 'direct' | 'plan'; promise: Promise<TaskDetail> }>();

  constructor(readonly repository: ExecutionRepository, readonly files: TaskFiles, private runtime: TaskRuntimePort,
    private selection: () => RuntimeSelection, private changed: (event: TaskEvent) => void = () => {}) {}

  detail(id: string, before?: number) { return this.repository.detail(id, before); }
  settings() { return this.repository.settings(); }
  configure(value: unknown) { const settings = validateExecutionSettings(value); this.repository.saveSettings(settings); this.schedule(); return settings; }

  private commit<T>(taskId: string, type: string, message: string, work: () => T, run?: TaskRun): T {
    const committed = this.repository.transaction(() => {
      const result = work();
      const event = this.repository.append({ taskId, type, message, stepId: run?.stepId, runId: run?.id, taskStatus: this.repository.task(taskId).status });
      return { result, event };
    });
    // Listener failure cannot turn a committed command into a failed business operation.
    try { this.changed(committed.event); } catch { /* snapshots and event cursors recover the projection */ }
    return committed.result;
  }

  async start(): Promise<void> {
    if (this.ready || this.closing) return;
    for (const task of this.repository.tasks().filter(task => task.execution)) {
      if (task.execution?.plan) this.files.plan(task.id, task.execution.plan);
      for (const run of this.repository.runs(task.id)) {
        if (!activeRunStates.has(run.status)) continue;
        try {
          await this.runtime.reconcile(run);
          this.commit(task.id, 'run.interrupted', '上次执行已停止，保留进展并准备恢复。', () => {
            run.status = task.status === 'canceling' ? 'canceled' : 'interrupted'; run.endedAt = new Date().toISOString();
            for (const question of run.questions) if (question.kind === 'approval' && question.status === 'pending') question.status = 'expired';
            this.repository.saveRun(run);
            const step = this.repository.steps(task.id).find(step => step.id === run.stepId)!;
            if (step.currentRunId === run.id) { step.status = run.status; this.repository.saveStep(step); }
          }, run);
        } catch (error) {
          this.commit(task.id, 'recovery.blocked', errorMessage(error), () => {
            const current = this.repository.task(task.id); current.status = 'interrupted'; this.repository.saveTask(current);
            run.error = errorMessage(error); this.repository.saveRun(run);
          }, run);
        }
      }
      const current = this.repository.task(task.id);
      if (current.status === 'canceling' && !this.repository.runs(task.id).some(run => activeRunStates.has(run.status))) this.finishCancel(task.id);
    }
    this.ready = true; this.schedule();
  }

  dispatch(taskId: string, mode: 'direct' | 'plan', roomId?: string): Promise<TaskDetail> {
    if (this.closing) return Promise.reject(new Error('Orbit 正在退出。'));
    if (mode !== 'direct' && mode !== 'plan') return Promise.reject(new Error('请选择直接执行或先规划。'));
    const existing = this.dispatching.get(taskId);
    if (existing) return existing.mode === mode ? existing.promise : Promise.reject(new Error('任务正在以另一种方式派发。'));
    const promise = this.dispatchOnce(taskId, mode, roomId).finally(() => this.dispatching.delete(taskId));
    this.dispatching.set(taskId, { mode, promise }); return promise;
  }
  private async dispatchOnce(taskId: string, mode: 'direct' | 'plan', roomId?: string): Promise<TaskDetail> {
    let task = this.repository.task(taskId);
    if (task.execution) {
      if (task.execution.mode !== mode) throw new Error('任务已经派发，不能改变规划方式。');
      return this.detail(taskId);
    }
    if (task.status !== 'pending') throw new Error('只有待派发任务可以开始执行。');
    const selection = structuredClone(this.selection());
    await this.runtime.preflight(selection);
    // Re-read after asynchronous preflight: cancellation can win while checking credentials.
    task = this.repository.task(taskId);
    if (task.status !== 'pending' || this.closing) throw new Error('任务已取消或应用正在退出。');
    const directory = this.files.prepare(task);
    this.commit(taskId, 'task.dispatched', mode === 'plan' ? '已派发，先规划任务步骤。' : '已派发，准备直接执行。', () => {
      task.status = 'queued'; task.updatedAt = new Date().toISOString(); task.execution = { mode, selection, roomId, directory };
      this.repository.saveTask(task);
      this.repository.saveStep({ taskId, id: mode === 'plan' ? 'planner' : 'implement', name: mode === 'plan' ? '规划任务' : '执行任务',
        kind: mode === 'plan' ? 'planner' : 'worker', instruction: task.brief, dependsOn: [], status: 'pending' });
    });
    this.schedule(); return this.detail(taskId);
  }

  private schedule() { if (this.ready && !this.closing && !this.pumping) { this.pumping = true; queueMicrotask(() => { this.pumping = false; this.pump(); }); } }
  private pump() {
    if (this.closing) return;
    const limit = this.settings().maxConcurrency;
    const occupied = () => this.repository.tasks().reduce((count, task) => count + this.repository.runs(task.id).filter(run => activeRunStates.has(run.status)).length, 0);
    for (const task of this.repository.tasks()) {
      if (occupied() >= limit) return;
      if (!task.execution || !executableTaskStates.has(task.status)) continue;
      const steps = this.repository.steps(task.id);
      const runs = this.repository.runs(task.id);
      for (const step of steps) {
        if (occupied() >= limit) return;
        if (!['pending', 'interrupted'].includes(step.status)) continue;
        // Unknown old processes retain ownership; no duplicate attempt may be launched.
        if (runs.some(run => run.stepId === step.id && activeRunStates.has(run.status))) continue;
        if (runs.some(run => run.stepId === step.id && run.questions.some(q => q.kind === 'input' && q.status === 'pending'))) continue;
        if (!step.dependsOn.every(id => steps.find(item => item.id === id)?.status === 'completed')) continue;
        this.launch(task, step, runs.filter(run => run.stepId === step.id).at(-1));
      }
    }
  }

  private launch(task: Task, step: TaskStep, previous?: TaskRun) {
    const run: TaskRun = { id: randomUUID(), taskId: task.id, stepId: step.id, attempt: (previous?.attempt ?? 0) + 1,
      selection: task.execution!.selection, status: 'starting', questions: [], startedAt: new Date().toISOString() };
    this.commit(task.id, 'run.started', '开始步骤：' + step.name, () => {
      step.status = 'running'; step.currentRunId = run.id; step.error = undefined;
      this.repository.saveStep(step); this.repository.saveRun(run);
      const current = this.repository.task(task.id); current.status = step.kind === 'planner' ? 'planning' : 'running'; current.updatedAt = run.startedAt;
      this.repository.saveTask(current);
    }, run);
    try {
      const paths = this.files.prepareRun(task.id, step.id, run.id);
      const handle = this.runtime.start({ run, ...paths, taskDirectory: task.execution!.directory,
        prompt: this.prompt(task, step, previous), tools: executionTools(step.kind === 'planner'), resumeSession: previous?.nativeSession },
      event => this.observe(run.id, event), (name, args, callId) => this.execute(run.id, name, args, callId));
      const active: ActiveRun = { handle, finished: Promise.resolve() };
      this.active.set(run.id, active);
      active.finished = handle.done.then(outcome => this.finish(run.id, outcome), error => this.finish(run.id, { status: 'failed', error: errorMessage(error) }))
        .catch(error => this.recordUnexpectedFailure(run.id, error)).finally(() => { this.active.delete(run.id); this.rejectQuestions(run.id); this.schedule(); });
    } catch (error) { this.finish(run.id, { status: 'failed', error: errorMessage(error) }); }
  }

  private prompt(task: Task, step: TaskStep, previous?: TaskRun): string {
    const upstream = this.repository.steps(task.id).filter(item => step.dependsOn.includes(item.id)).map(({ id, name, result }) => ({ id, name, result }));
    const answers = this.repository.runs(task.id).filter(run => run.stepId === step.id).flatMap(run => run.questions.filter(q => q.status === 'answered' && q.kind === 'input'));
    return [
      '你是 Orbit 的任务执行 Agent。只处理当前步骤，不自行派发或启动其他 Agent。',
      '工作文件写入当前步骤目录。输入清单位于任务根目录 inputs.json，原始资料在 inputs/；上游成果路径相对任务根目录。不要修改上游成果、输入或宿主运行记录。',
      '使用 report_progress 记录实际进展，需要用户补充信息时调用 request_input。工具返回错误时修正后重试，不能编造提交成功。',
      step.kind === 'planner' ? '请拆解目标，使用 submit_plan 提交步骤和 dependsOn。无依赖的步骤可并行；只做规划，本轮不要执行这些步骤。提交成功后结束回复。'
        : '完成后必须调用 submit_result，列出真实成果的相对文件路径和结论。提交成功后结束回复；普通回复或 CLI 退出不会完成业务步骤。',
      '当前任务与步骤：\n' + JSON.stringify({ taskId: task.id, goal: task.brief, stepId: step.id, instruction: step.instruction, taskDirectory: task.execution!.directory, upstream, answers }),
      previous ? '这是恢复/重试。保留之前文件，先检查实际进展，避免重复已完成的外部操作。之前执行：\n' + JSON.stringify({ status: previous.status, error: previous.error, proposal: previous.proposal }) : '',
    ].join('\n\n');
  }

  private current(runId: string): { run: TaskRun; step: TaskStep; task: Task } {
    const run = this.repository.run(runId); const task = this.repository.task(run.taskId);
    const step = this.repository.steps(run.taskId).find(step => step.id === run.stepId)!;
    if (this.closing || this.active.get(runId)?.stopped || run.status === 'unresolved' || !activeRunStates.has(run.status) || step.currentRunId !== runId || ['canceling', 'canceled', 'completed'].includes(task.status)) throw new Error('这次执行已停止，拒绝迟到的工具或事件。');
    return { run, step, task };
  }
  private observe(runId: string, event: TaskRuntimeEvent) {
    let run: TaskRun;
    try { ({ run } = this.current(runId)); } catch (error) {
      // A process receipt is a grant to start execution, so a rejected receipt must reach the host.
      if (event.type === 'process') throw error;
      return;
    }
    if (event.type === 'output') { this.files.log(run.taskId, run.id, { at: new Date().toISOString(), ...event }); return; }
    this.commit(run.taskId, 'run.' + event.type, event.type === 'activity' ? event.message : event.type === 'session' ? '已绑定原生执行会话。' : '执行进程已启动。', () => {
      if (event.type === 'session') run.nativeSession = boundedText(event.sessionId, '原生会话标识', 4096);
      if (event.type === 'process') { run.workerPid = event.pid; run.workerIdentity = event.identity; }
      if (run.status === 'starting') run.status = 'running';
      this.repository.saveRun(run);
    }, run);
  }

  async execute(runId: string, name: string, value: unknown, callId: string): Promise<unknown> {
    const { run, step, task } = this.current(runId);
    boundedText(callId, '工具调用标识', 256);
    const args = object(value);
    const receipt = this.repository.receipt(runId, callId, name, args);
    if (receipt !== undefined) return receipt;
    if (name === 'read_task') return { taskId: task.id, goal: task.brief, directory: task.execution!.directory,
      steps: this.repository.steps(task.id).map(({ id, name, status, result }) => ({ id, name, status, result })) };
    if (name === 'request_input' || name === 'permission_request') return this.ask(run, callId, name, args);
    return this.commit(task.id, name === 'report_progress' ? 'step.progress' : 'step.submitted',
      name === 'report_progress' ? boundedText(args.message, '进展') : step.name + ' 已提交，等待本轮执行结束。', () => {
        let result: unknown;
        if (name === 'report_progress') result = { recorded: true };
        else if (name === 'submit_plan' && step.kind === 'planner') {
          if (run.proposal) throw new Error('本轮已提交规划，不可再次替换。');
          const plan = validatePlan(args); run.proposal = { kind: 'plan', plan }; this.repository.saveRun(run);
          result = { accepted: true, steps: plan.steps.length, message: '规划已校验。结束本轮后由宿主保存并执行。' };
        } else if (name === 'submit_result' && step.kind === 'worker') {
          if (run.proposal) throw new Error('本轮已提交成果，不可再次替换。');
          const resultValue = { summary: boundedText(args.summary, '成果结论'), artifacts: this.files.artifacts(task.id, step.id, args.artifacts) };
          run.proposal = { kind: 'result', result: resultValue }; this.repository.saveRun(run); result = { accepted: true, result: resultValue };
        } else throw new Error('当前执行不支持该工具。');
        this.repository.saveReceipt(runId, callId, name, args, result); return result;
      }, run);
  }

  private async ask(run: TaskRun, callId: string, name: string, args: Record<string, unknown>) {
    if (run.questions.some(question => question.status === 'pending')) throw new Error('请先等待当前问题的答复。');
    const question: TaskQuestion = { id: randomUUID(), kind: name === 'permission_request' ? 'approval' : 'input',
      prompt: boundedText(args.question, '问题'), status: 'pending', createdAt: new Date().toISOString() };
    const waiting = new Promise<string>((resolve, reject) => this.answers.set(question.id, { resolve, reject }));
    try {
      this.commit(run.taskId, 'task.question', question.prompt, () => {
        run.questions.push(question); run.status = 'waiting'; this.repository.saveRun(run);
        const step = this.repository.steps(run.taskId).find(step => step.id === run.stepId)!; step.status = 'waiting'; this.repository.saveStep(step);
        this.refreshTask(run.taskId);
      }, run);
      const answer = await waiting;
      this.current(run.id);
      const result = { answer };
      this.repository.transaction(() => this.repository.saveReceipt(run.id, callId, name, args, result));
      return result;
    } finally { this.answers.delete(question.id); }
  }

  answer(taskId: string, questionId: string, value: unknown): TaskDetail {
    const answer = boundedText(value, '回答');
    const run = this.repository.runs(taskId).find(run => run.questions.some(question => question.id === questionId));
    const question = run?.questions.find(question => question.id === questionId);
    if (!run || !question) throw new Error('问题不存在。');
    if (question.status === 'answered') { if (question.answer !== answer) throw new Error('问题已经回答。'); return this.detail(taskId); }
    if (question.status !== 'pending' || ['canceling', 'canceled', 'completed'].includes(this.repository.task(taskId).status) || this.closing) throw new Error('问题已结束，不能再回答。');
    if (question.kind === 'approval' && !['approve', 'deny'].includes(answer)) throw new Error('请选择允许或拒绝。');
    this.commit(taskId, 'task.answered', question.kind === 'approval' ? (answer === 'approve' ? '用户允许了本次操作。' : '用户拒绝了本次操作。') : '用户已补充信息。', () => {
      question.status = 'answered'; question.answer = answer;
      if (this.active.has(run.id)) run.status = 'running';
      this.repository.saveRun(run);
      const step = this.repository.steps(taskId).find(step => step.id === run.stepId)!;
      step.status = this.active.has(run.id) ? 'running' : 'interrupted'; this.repository.saveStep(step);
      this.refreshTask(taskId);
    }, run);
    this.answers.get(questionId)?.resolve(answer); this.schedule(); return this.detail(taskId);
  }

  private finish(runId: string, outcome: TaskRuntimeOutcome) {
    const run = this.repository.run(runId); const task = this.repository.task(run.taskId);
    const step = this.repository.steps(run.taskId).find(step => step.id === run.stepId)!;
    if (!activeRunStates.has(run.status) || step.currentRunId !== run.id) return;
    if (outcome.status === 'unresolved') {
      this.commit(task.id, 'recovery.blocked', outcome.error ?? '旧执行尚未确认停止，请检查后重试。', () => {
        for (const question of run.questions) if (question.kind === 'approval' && question.status === 'pending') question.status = 'expired';
        run.status = 'unresolved'; run.error = outcome.error; this.repository.saveRun(run);
        step.status = 'interrupted'; step.error = outcome.error; this.repository.saveStep(step);
        if (task.status !== 'canceling') task.status = 'interrupted';
        this.repository.saveTask(task);
      }, run);
      return;
    }
    const stop = this.active.get(runId)?.stopped;
    let status: 'completed' | 'failed' | 'interrupted' | 'canceled' = stop === 'cancel' || task.status === 'canceling' ? 'canceled' : stop === 'shutdown' || this.closing ? 'interrupted' : outcome.status;
    let error = outcome.error;
    if (status === 'completed') {
      try {
        if (!run.proposal) throw new Error('运行时已结束，但未通过工具提交规划或成果。');
        if (run.proposal.kind === 'result') run.proposal.result.artifacts.forEach(artifact => this.files.verify(task.id, artifact));
        else this.files.plan(task.id, run.proposal.plan);
      } catch (failure) { status = 'failed'; error = errorMessage(failure); }
    }
    this.commit(task.id, 'run.' + status, error ?? (status === 'completed' ? step.name + ' 已完成。' : step.name + ' 已停止。'), () => {
      run.status = status; run.error = error; run.endedAt = new Date().toISOString();
      for (const question of run.questions) if (question.status === 'pending' && (question.kind === 'approval' || status !== 'interrupted')) question.status = 'expired';
      step.status = status; step.error = error;
      if (status === 'completed' && run.proposal?.kind === 'result') step.result = run.proposal.result;
      if (status === 'completed' && run.proposal?.kind === 'plan') {
        task.execution!.plan = run.proposal.plan; this.repository.saveTask(task);
        for (const planned of run.proposal.plan.steps) this.repository.saveStep({ ...planned, taskId: task.id, kind: 'worker', status: 'pending',
          dependsOn: planned.dependsOn.length ? planned.dependsOn : ['planner'] });
      }
      this.repository.saveRun(run); this.repository.saveStep(step); this.refreshTask(task.id);
    }, run);
  }
  private refreshTask(taskId: string) {
    const task = this.repository.task(taskId);
    if (['canceling', 'canceled', 'completed'].includes(task.status)) return;
    const steps = this.repository.steps(taskId); const runs = this.repository.runs(taskId);
    task.status = steps.every(step => step.status === 'completed') ? 'review'
      : steps.some(step => step.status === 'failed') ? 'failed'
      : steps.some(step => step.status === 'running') ? (steps.some(step => step.kind === 'planner' && step.status === 'running') ? 'planning' : 'running')
      : runs.some(run => run.questions.some(question => question.status === 'pending')) ? 'waiting'
      : steps.some(step => step.status === 'interrupted') ? 'interrupted' : 'queued';
    task.updatedAt = new Date().toISOString(); this.repository.saveTask(task);
  }

  async retry(taskId: string): Promise<TaskDetail> {
    const task = this.repository.task(taskId);
    if (!task.execution || !['failed', 'interrupted'].includes(task.status)) throw new Error('当前任务无需重试。');
    if (this.closing) throw new Error('Orbit 正在退出。');
    await this.runtime.preflight(task.execution.selection);
    for (const run of this.repository.runs(taskId).filter(run => activeRunStates.has(run.status) && !this.active.has(run.id))) {
      await this.runtime.reconcile(run);
      this.commit(taskId, 'run.interrupted', '已确认旧执行停止。', () => { run.status = 'interrupted'; this.repository.saveRun(run); }, run);
    }
    const current = this.repository.task(taskId);
    if (!['failed', 'interrupted'].includes(current.status) || this.closing) throw new Error('任务状态已变化。');
    this.commit(taskId, 'task.retried', '重新执行未完成步骤，保留已完成成果。', () => {
      for (const step of this.repository.steps(taskId)) if (['failed', 'interrupted', 'running'].includes(step.status) && !this.active.has(step.currentRunId ?? '')) {
        step.status = 'interrupted'; step.error = undefined; this.repository.saveStep(step);
      }
      current.status = 'queued'; this.repository.saveTask(current);
    });
    this.schedule(); return this.detail(taskId);
  }
  async cancel(taskId: string): Promise<TaskDetail> {
    const task = this.repository.task(taskId);
    if (task.status === 'canceled') return this.detail(taskId);
    if (task.status === 'completed') throw new Error('已验收任务不能取消。');
    this.commit(taskId, 'task.canceling', '正在取消，等待执行停止。', () => { task.status = 'canceling'; this.repository.saveTask(task); });
    const runs = this.repository.runs(taskId).filter(run => activeRunStates.has(run.status));
    for (const run of runs) {
      const active = this.active.get(run.id);
      if (active) { active.stopped = 'cancel'; this.rejectQuestions(run.id); await active.handle.stop(); await active.finished; }
      else { await this.runtime.reconcile(run); run.status = 'canceled'; run.endedAt = new Date().toISOString(); this.repository.transaction(() => this.repository.saveRun(run)); }
    }
    this.finishCancel(taskId); this.schedule(); return this.detail(taskId);
  }
  private finishCancel(taskId: string) {
    this.commit(taskId, 'task.canceled', '任务已取消，历史成果已保留。', () => {
      for (const step of this.repository.steps(taskId)) if (step.status !== 'completed') { step.status = 'canceled'; this.repository.saveStep(step); }
      for (const run of this.repository.runs(taskId)) { for (const question of run.questions) if (question.status === 'pending') question.status = 'expired'; this.repository.saveRun(run); }
      const task = this.repository.task(taskId); task.status = 'canceled'; task.updatedAt = new Date().toISOString(); this.repository.saveTask(task);
    });
  }
  accept(taskId: string): TaskDetail {
    const task = this.repository.task(taskId);
    if (task.status === 'completed') return this.detail(taskId);
    if (task.status !== 'review') throw new Error('只有待验收任务可以验收。');
    for (const step of this.repository.steps(taskId)) step.result?.artifacts.forEach(artifact => this.files.verify(taskId, artifact));
    this.commit(taskId, 'task.accepted', '用户已验收成果。', () => { task.status = 'completed'; task.updatedAt = new Date().toISOString(); this.repository.saveTask(task); });
    return this.detail(taskId);
  }
  artifact(taskId: string, path: string): string {
    if (!this.repository.steps(taskId).some(step => step.result?.artifacts.some(artifact => artifact.path === path))) throw new Error('成果不属于当前任务。');
    return this.files.openArtifact(taskId, path);
  }
  private rejectQuestions(runId: string) { for (const question of this.repository.run(runId).questions) this.answers.get(question.id)?.reject(new Error('执行已停止，问题保留在任务记录中。')); }
  private recordUnexpectedFailure(runId: string, error: unknown) {
    const run = this.repository.run(runId);
    this.commit(run.taskId, 'run.failed', errorMessage(error), () => {
      run.status = 'failed'; run.error = errorMessage(error); this.repository.saveRun(run);
      const step = this.repository.steps(run.taskId).find(step => step.id === run.stepId)!;
      step.status = 'failed'; step.error = run.error; this.repository.saveStep(step); this.refreshTask(run.taskId);
    }, run);
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await Promise.allSettled([...this.dispatching.values()].map(value => value.promise));
    const runs = [...this.active.entries()];
    for (const [id, active] of runs) { active.stopped = 'shutdown'; this.rejectQuestions(id); }
    await Promise.all(runs.map(async ([, active]) => { await active.handle.stop(); await active.finished; }));
  }
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : '任务执行失败。'; }
