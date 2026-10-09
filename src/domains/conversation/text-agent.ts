import type { Agent, AgentMessage, AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import type { TSchema } from 'typebox';
import type { DatabaseSync } from 'node:sqlite';
import type { ChatEvent, TextModelProtocol } from '../../contracts';
import { foregroundPrompt, foregroundTools, type PlatformExecute } from './tools';
import type { TextModelStore } from '../models/settings';

export class TextAgent {
  private active?: Agent;
  private running?: Promise<void>;
  private stopped = false;
  get busy() { return !!this.running; }
  constructor(private db: DatabaseSync, private settings: TextModelStore, private execute: PlatformExecute,
    private emit: (event: ChatEvent) => void, private record: (role: 'user' | 'assistant', text: string) => void,
    private history: () => string, private streamOverride?: StreamFn) {}
  send(text: string): Promise<void> {
    if (this.busy) return Promise.reject(new Error('文本回复正在进行，请等待或停止回复。'));
    const config = this.settings.resolve();
    this.stopped = false;
    this.running = this.run(text, config).finally(() => { this.active = undefined; this.running = undefined; this.emit({ type: 'state', busy: false }); });
    return this.running;
  }
  private async run(text: string, config: ReturnType<TextModelStore['resolve']>) {
    this.emit({ type: 'state', busy: true });
    try {
      const [{ Agent }, completions, responses, anthropic] = await Promise.all([
        import('@earendil-works/pi-agent-core'), import('@earendil-works/pi-ai/api/openai-completions'),
        import('@earendil-works/pi-ai/api/openai-responses'), import('@earendil-works/pi-ai/api/anthropic-messages'),
      ]);
      if (this.stopped) return;
      const model: Model<TextModelProtocol> = { id: config.model, name: config.model, provider: 'orbit-local',
        api: config.protocol, baseUrl: config.baseUrl, reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 };
      if (config.protocol === 'openai-completions') model.compat = { supportsDeveloperRole: false, supportsStore: false };
      const stream: StreamFn = this.streamOverride ?? ((model, context, options) => {
        const opts = { ...options, apiKey: config.apiKey || 'orbit-local-no-key', maxTokens: 4096 };
        if (config.protocol === 'anthropic-messages') return anthropic.streamSimple(model as Model<'anthropic-messages'>, context, opts);
        if (config.protocol === 'openai-responses') return responses.streamSimple(model as Model<'openai-responses'>, context, opts);
        return completions.streamSimple(model as Model<'openai-completions'>, context, opts);
      });
      const tools: AgentTool[] = foregroundTools.map(({ function: tool }) => ({ name: tool.name, label: tool.name, description: tool.description,
        parameters: tool.parameters as TSchema, executionMode: 'sequential',
        execute: async (id, args, signal) => {
          if (signal?.aborted) throw new Error('已停止');
          const result = await this.execute(tool.name, args, 'text:' + id);
          return { content: [{ type: 'text', text: JSON.stringify(result) ?? 'null' }], details: undefined };
        } }));
      const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get('textTranscript');
      const saved: AgentMessage[] = row ? JSON.parse(String(row.value)) : [];
      // Keep complete user turns, never orphan a tool result by slicing arbitrary messages.
      const starts = saved.flatMap((m, index) => m.role === 'user' ? [index] : []);
      let start = Math.max(0, starts.length - 12);
      while (start < starts.length - 1 && JSON.stringify(saved.slice(starts[start])).length > 48000) start++;
      const messages = saved.slice(starts[start] ?? 0);
      // Recreate only the instruction baseline; retain whole provider messages and tool-result pairs.
      let turns = 0;
      const agent = new Agent({ initialState: { model, tools, systemPrompt: foregroundPrompt + this.history(),
        messages: messages.filter(m => m.role !== 'system') }, streamFn: stream, toolExecution: 'sequential', maxRetryDelayMs: 1000, finishTurn: () => { if (++turns >= 16) { this.emit({ type: 'error', text: '本轮调度已达到步骤上限，请查看任务状态后继续。' }); return { action: 'end' }; } } });
      this.active = agent;
      agent.subscribe(event => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') this.emit({ type: 'delta', text: event.assistantMessageEvent.delta });
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const message = event.message;
          const answer = message.content.filter(p => p.type === 'text').map(p => p.text).join('');
          if (answer && message.stopReason !== 'error' && message.stopReason !== 'aborted') this.record('assistant', answer);
        }
      });
      this.record('user', text);
      await agent.prompt(text);
      if (agent.state.errorMessage && !this.stopped) throw new Error('provider failed');
    } catch {
      if (!this.stopped) { this.emit({ type: 'error', text: '文本模型请求失败，请检查本地模型配置、网络及模型的工具调用支持。' }); }
    } finally {
      if (this.active) {
        const messages = this.active.state.messages.filter(m => m.role !== 'assistant' || !['error', 'aborted'].includes(m.stopReason));
        this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('textTranscript', JSON.stringify(messages));
      }
    }
  }
  async stop() { this.stopped = true; this.active?.abort(); await this.running; }
}
