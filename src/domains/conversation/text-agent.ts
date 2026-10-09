import type { AgentSession, FileEntry, SessionManager, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Message as PiMessage, Model } from '@earendil-works/pi-ai';
import type { TSchema } from 'typebox';
import type { DatabaseSync } from 'node:sqlite';
import type { ChatEvent, TextModelProtocol } from '../../contracts';
import { foregroundPrompt, foregroundTools, type PlatformExecute } from './tools';
import { contextPolicy } from './context-budget';
import type { TextModelStore } from '../models/settings';

interface SessionPolicy { contextWindow: number; reserveTokens: number; keepRecentTokens: number }
const defaultPolicy: SessionPolicy = {
  contextWindow: contextPolicy.textWindowTokens,
  reserveTokens: contextPolicy.textReserveTokens,
  keepRecentTokens: contextPolicy.textKeepRecentTokens,
};
export class TextAgent {
  private active?: AgentSession;
  private running?: Promise<void>;
  private stopped = false;
  get busy() { return !!this.running; }
  constructor(private db: DatabaseSync, private settings: TextModelStore, private execute: PlatformExecute,
    private emit: (event: ChatEvent) => void, private record: (role: 'user' | 'assistant', text: string) => void,
    private history: () => string, private policy: SessionPolicy = defaultPolicy) {}
  send(text: string): Promise<void> {
    if (this.busy) return Promise.reject(new Error('文本回复正在进行，请等待或停止回复。'));
    const config = this.settings.resolve();
    this.stopped = false;
    this.running = this.run(text, config).finally(() => {
      this.active?.dispose(); this.active = undefined; this.running = undefined;
      this.emit({ type: 'compaction', active: false }); this.emit({ type: 'state', busy: false });
    });
    return this.running;
  }
  private persist(manager: SessionManager) {
    const entries = [manager.getHeader(), ...manager.getEntries()].filter(Boolean);
    this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('piSessionEntries', JSON.stringify(entries));
  }
  private async run(text: string, config: ReturnType<TextModelStore['resolve']>) {
    this.emit({ type: 'state', busy: true });
    let manager: SessionManager | undefined;
    try {
      const [{ createAgentSession, SessionManager, SettingsManager, ModelRuntime, DefaultResourceLoader }, { InMemoryCredentialStore }] = await Promise.all([
        import('@earendil-works/pi-coding-agent'), import('@earendil-works/pi-ai'),
      ]);
      if (this.stopped) return;
      const model: Model<TextModelProtocol> = { id: config.model, name: config.model, provider: 'orbit-local',
        api: config.protocol, baseUrl: config.baseUrl, reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: this.policy.contextWindow, maxTokens: contextPolicy.textMaxOutputTokens };
      if (config.protocol === 'openai-completions') model.compat = { supportsDeveloperRole: false, supportsStore: false };
      const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
      modelRuntime.registerProvider(model.provider, { baseUrl: config.baseUrl, api: config.protocol, models: [model] });
      await modelRuntime.setRuntimeApiKey(model.provider, config.apiKey || 'orbit-local-no-key');
      if (this.stopped) return;
      const tools: ToolDefinition[] = foregroundTools.map(({ function: tool }) => ({ name: tool.name, label: tool.name, description: tool.description,
        parameters: tool.parameters as TSchema, executionMode: 'sequential',
        execute: async (id, args, signal) => {
          if (signal?.aborted) throw new Error('已停止');
          const result = await this.execute(tool.name, args, 'text:' + id);
          return { content: [{ type: 'text', text: JSON.stringify(result) ?? 'null' }], details: undefined };
        } }));
      const stored = this.db.prepare('SELECT value FROM settings WHERE key=?').get('piSessionEntries');
      manager = SessionManager.inMemory(process.cwd(), undefined, stored ? JSON.parse(String(stored.value)) as FileEntry[] : undefined);
      if (!stored) {
        const legacy = this.db.prepare('SELECT value FROM settings WHERE key=?').get('textTranscript');
        if (legacy) for (const message of JSON.parse(String(legacy.value)) as PiMessage[]) {
          if (['user', 'assistant', 'toolResult'].includes(message.role)) manager.appendMessage(message);
        }
      }
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: this.policy.reserveTokens, keepRecentTokens: this.policy.keepRecentTokens },
        retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 60000 } },
        cacheWarming: 'off',
      });
      // No user/project extensions, skills, context files, MCP discovery or built-in coding tools.
      const resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(), agentDir: process.cwd(), settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        disabledBuiltinExtensions: ['mcp', 'codemode', 'tool-search'],
        systemPrompt: foregroundPrompt + this.history(),
      });
      await resourceLoader.reload();
      if (this.stopped) return;
      const { session } = await createAgentSession({
        model, modelRuntime, sessionManager: manager, settingsManager, resourceLoader,
        thinkingLevel: 'off', noTools: 'builtin', tools: tools.map(tool => tool.name), customTools: tools,
      });
      this.active = session;
      if (this.stopped) return;
      session.agent.toolExecution = 'sequential';
      let turns = 0;
      const previousFinish = session.agent.finishTurn;
      session.agent.finishTurn = async (turn, signal) => {
        const result = await previousFinish?.(turn, signal);
        if (++turns >= 16) { this.emit({ type: 'error', text: '本轮调度已达到步骤上限，请查看任务状态后继续。' }); return { action: 'end' }; }
        return result ?? undefined;
      };
      session.subscribe(event => {
        if (event.type === 'entry_appended') this.persist(manager!);
        if (event.type === 'compaction_start') this.emit({ type: 'compaction', active: true });
        if (event.type === 'compaction_end') {
          this.persist(manager!); this.emit({ type: 'compaction', active: false });
          if (event.errorMessage && !this.stopped) this.emit({ type: 'error', text: '上下文压缩失败，原始历史已保留，请重试。' });
        }
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') this.emit({ type: 'delta', text: event.assistantMessageEvent.delta });
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const message = event.message;
          const answer = message.content.filter(p => p.type === 'text').map(p => p.text).join('');
          if (answer && message.stopReason !== 'error' && message.stopReason !== 'aborted') this.record('assistant', answer);
        }
      });
      this.persist(manager);
      this.record('user', text);
      await session.prompt(text);
      if (session.agent.state.errorMessage && !this.stopped) throw new Error('provider failed');
    } catch {
      if (!this.stopped) this.emit({ type: 'error', text: '文本模型请求失败，请检查本地模型配置、网络及模型的工具调用支持。' });
    } finally {
      if (manager) this.persist(manager);
    }
  }
  async stop() { this.stopped = true; await this.active?.abort(); await this.running; }
}
