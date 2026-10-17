import { randomUUID } from 'node:crypto';
import type { Conversation } from '../../contracts';
import type { AgentInput, AgentRuntime, ExecuteTool } from '../../domains/conversation/agent';
import type { AgentCommand, AgentProcess, AgentSetup, WorkerMessage } from './protocol';

// Only the worker imports Pi. The host bridges typed events and Orbit business tools.
export class PiAgentHost implements AgentRuntime {
  private child?: AgentProcess;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private active?: AgentInput;
  private pending = new Map<string, { resolve: (state?: Conversation) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private state: Conversation = { configured: false, status: 'idle', messages: [], draft: '' };

  constructor(
    private spawn: () => AgentProcess,
    private setup: AgentSetup,
    private execute: ExecuteTool,
    private changed: (state: Conversation) => void,
  ) {}

  private start(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Orbit 正在退出。'));
    if (!this.starting) {
      const starting = Promise.resolve().then(async () => {
        if (this.closing) throw new Error('Orbit 正在退出。');
        const child = this.spawn();
        this.child = child;
        child.onMessage(message => { if (this.child === child) void this.receive(message); });
        child.onExit(() => { if (this.child === child) this.disconnect('对话进程已退出，重新发送可恢复会话。'); });
        try { await this.call({ id: randomUUID(), type: 'init', setup: this.setup }); }
        catch (error) { this.disconnect('对话初始化失败，请重试。'); child.kill(); throw error; }
      });
      this.starting = starting;
      void starting.catch(() => { if (this.starting === starting) this.starting = undefined; });
    }
    return this.starting;
  }

  private disconnect(error: string): void {
    this.child = undefined; this.starting = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(error)); }
    this.pending.clear();
    this.state = { ...this.state, status: 'idle', draft: '', error };
    if (!this.closing) this.changed(this.state);
  }

  private call(command: AgentCommand): Promise<Conversation | undefined> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const child = this.child;
        this.disconnect('对话响应超时，已停止本轮回复。请重新发送。');
        child?.kill();
      }, command.type === 'send' ? 10 * 60_000 : 30_000);
      this.pending.set(command.id, { resolve, reject, timer });
      try {
        if (!this.child) throw new Error('对话进程不可用。');
        this.child.send(command);
      } catch (error) {
        clearTimeout(timer); this.pending.delete(command.id); reject(error);
      }
    });
  }

  private async receive(message: WorkerMessage): Promise<void> {
    if (message.type === 'state') {
      this.state = message.state; this.changed(this.state); return;
    }
    if (message.type === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.state) { this.state = message.state; this.changed(this.state); }
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.state);
      return;
    }
    const child = this.child;
    try {
      if (!this.active || this.active.requestId !== message.context.requestId || this.state.status !== 'running') {
        throw new Error('本轮对话已结束，工具调用已取消。');
      }
      const result = await this.execute(message.name, message.args, message.context);
      if (this.child === child) child?.send({ type: 'tool_result', id: message.id, result });
    } catch (error) {
      if (this.child === child) {
        try { child?.send({ type: 'tool_result', id: message.id, error: error instanceof Error ? error.message : '工具调用失败。' }); }
        catch { this.disconnect('对话进程已断开，已保存的任务会保留。'); child?.kill(); }
      }
    }
  }

  async read(): Promise<Conversation> {
    await this.start();
    return (await this.call({ id: randomUUID(), type: 'read' }))!;
  }

  async send(input: AgentInput): Promise<void> {
    if (this.active) throw new Error('请等待当前回复，或先停止回复。');
    this.active = input;
    try { await this.start(); await this.call({ id: randomUUID(), type: 'send', input }); }
    finally { this.active = undefined; }
  }

  async abort(): Promise<void> {
    if (!this.child) return;
    await this.start();
    await this.call({ id: randomUUID(), type: 'abort' });
  }

  close(): Promise<void> {
    if (!this.closing) this.closing = Promise.resolve().then(async () => {
      try { await this.starting; } catch { /* Initialization may have been interrupted. */ }
      const child = this.child;
      if (!child) return;
      try { await this.call({ id: randomUUID(), type: 'close' }); }
      finally { child.kill(); this.disconnect('Orbit 已退出。'); }
    });
    return this.closing;
  }
}
