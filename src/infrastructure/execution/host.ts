import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ModelCredential, ModelProfile } from '../../domains/models/model';
import type { RuntimeAvailability, RuntimeSelection } from '../../domains/tasks/execution';
import type { TaskRuntimeEvent, TaskRuntimeInput, TaskRuntimeOutcome, TaskRuntimePort } from '../../domains/tasks/runtime';
import type { ExecutionParentMessage, ExecutionWorkerMessage } from './protocol';
import { delay, executableFor, executionEnv, probeCli, reconcileWorker, stopGroup } from './process';

export class ExecutionRuntimeHost implements TaskRuntimePort {
  constructor(private options: { worker: string; mcpBridge: string; model: () => ModelProfile | null;
    credential: (profile: ModelProfile) => ModelCredential | undefined; env?: NodeJS.ProcessEnv }) {}
  async availability(): Promise<RuntimeAvailability[]> {
    let pi: RuntimeAvailability = { runtime: 'pi', available: false, message: '请先配置 Pi 使用的文字模型。' };
    try {
      const model = this.options.model();
      if (model) { this.options.credential(model); pi = { runtime: 'pi', available: true, message: '使用当前 Orbit 文字模型，独立运行任务会话。' }; }
    } catch { pi.message = 'Pi 模型凭据不可用，请检查模型配置。'; }
    return [pi, ...await Promise.all([probeCli('codex-cli', this.options.env), probeCli('claude-cli', this.options.env)])];
  }
  async preflight(selection: RuntimeSelection) {
    if (process.platform === 'win32') throw new Error('任务执行首版支持 macOS 和 Linux。');
    if (selection.runtime === 'pi') {
      if (!selection.model) throw new Error('请先配置 Pi 使用的文字模型，或在任务执行设置中选择已登录的 CLI。');
      this.options.credential(selection.model);
    } else {
      const status = await probeCli(selection.runtime, this.options.env);
      if (!status.available) throw new Error(status.message);
    }
  }
  reconcile = reconcileWorker;
  start(input: TaskRuntimeInput, event: (event: TaskRuntimeEvent) => void, tool: (name: string, args: unknown, callId: string) => Promise<unknown>) {
    let child: ChildProcess | undefined; let stopped = false; let stopPromise: Promise<void> | undefined;
    const done = (async (): Promise<TaskRuntimeOutcome> => {
      await this.preflight(input.run.selection);
      if (stopped) return { status: 'interrupted' };
      const identity = randomUUID();
      const env = executionEnv(this.options.env);
      child = fork(this.options.worker, ['--orbit-run=' + input.run.id, '--orbit-worker=' + identity], {
        cwd: input.directory, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [], detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const process = child;
      const send = (message: ExecutionParentMessage) => { if (process.connected) process.send(message, () => {}); };
      let outcome: TaskRuntimeOutcome | undefined; let exitError: string | undefined;
      const closed = new Promise<void>(resolve => { process.once('error', error => { exitError = error.message; resolve(); }); process.once('close', () => resolve()); });
      const bootTimer = setTimeout(() => { exitError = '执行 worker 启动超时。'; if (process.pid) void stopGroup(process.pid).catch(() => {}); }, 20_000);
      process.on('message', (message: ExecutionWorkerMessage) => {
        if (message.type === 'ready') {
          clearTimeout(bootTimer);
          if (stopped) { send({ type: 'stop' }); return; }
          try {
            // Persist the identity before granting the worker permission to execute anything.
            if (!process.pid) throw new Error('未取得执行进程标识。');
            event({ type: 'process', pid: process.pid, identity });
            send({ type: 'start', input, executable: input.run.selection.runtime === 'pi' ? undefined : executableFor(input.run.selection.runtime, this.options.env), mcpBridge: this.options.mcpBridge });
          } catch (error) { exitError = error instanceof Error ? error.message : '无法开始执行'; void stopGroup(process.pid!).catch(() => {}); }
        } else if (message.type === 'event') {
          try { event(message.event); } catch { exitError = '执行事件保存失败。'; if (process.pid) void stopGroup(process.pid).catch(() => {}); }
        } else if (message.type === 'outcome') outcome = message.outcome;
        else if (message.type === 'tool') {
          void Promise.resolve().then(() => { if (stopped) throw new Error('执行已停止。'); return tool(message.name, message.args, message.callId); })
            .then(result => send({ type: 'response', id: message.id, result }), error => send({ type: 'response', id: message.id, error: error instanceof Error ? error.message : '工具执行失败。' }));
        } else if (message.type === 'credential') {
          try {
            if (stopped || !input.run.selection.model) throw new Error('执行凭据请求已失效。');
            send({ type: 'credential', id: message.id, credential: this.options.credential(input.run.selection.model) });
          } catch { send({ type: 'credential', id: message.id, error: '任务模型凭据不可用，请检查配置。' }); }
        }
      });
      const output = (chunk: Buffer) => { try { event({ type: 'output', text: chunk.toString().slice(0, 65536) }); } catch { /* exit path owns failures */ } };
      process.stdout?.on('data', output); process.stderr?.on('data', output);
      await closed; clearTimeout(bootTimer);
      // Also reap remaining descendants in the worker's known process group.
      try { if (process.pid) await stopGroup(process.pid); }
      catch { return { status: 'unresolved', error: '执行进程尚未确认停止，暂不启动重复执行。' }; }
      if (stopped) return { status: 'interrupted' };
      if (exitError) return { status: 'failed', error: exitError };
      if (process.exitCode !== 0) return { status: 'failed', error: '执行 worker 异常退出，退出码 ' + String(process.exitCode) + '。' };
      return outcome ?? { status: 'failed', error: '执行进程退出，未收到结构化执行回执。' };
    })();
    return { done, stop: () => {
      stopPromise ??= (async () => {
        stopped = true;
        if (child?.connected) child.send({ type: 'stop' }, () => {});
        await Promise.race([done.catch(() => {}), delay(4000)]);
        if (child?.pid) await stopGroup(child.pid);
        await done.catch(() => {});
      })();
      return stopPromise;
    } };
  }
}
