import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryCredentialStore, InMemoryModelsStore, Type } from '@earendil-works/pi-ai';
import {
  createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ResourceLoader, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Conversation, Message } from '../../contracts';
import type { AgentInput, ExecuteTool } from '../../domains/conversation/agent';
import type { AgentSetup } from './protocol';

interface Turn {
  input: AgentInput;
  status: 'running' | 'complete' | 'interrupted' | 'failed';
  error?: string;
}
const TURN_ENTRY = 'orbit.interaction-turn.v1';

export class PiSession {
  private manager: SessionManager;
  private session?: AgentSession;
  private active?: AgentInput;
  private stopped = false;
  private finishing?: Promise<void>;
  private finish?: () => void;
  private state: Conversation = { configured: false, status: 'idle', messages: [], draft: '' };
  private turns = new Map<string, Turn>();

  private constructor(private setup: AgentSetup, private execute: ExecuteTool, private changed: (state: Conversation) => void) {
    mkdirSync(setup.directory, { recursive: true, mode: 0o700 });
    this.manager = SessionManager.continueRecent(setup.directory, join(setup.directory, 'sessions'));
    for (const entry of this.manager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === TURN_ENTRY) {
        const turn = entry.data as Turn;
        this.turns.set(turn.input.requestId, turn);
      }
    }
    for (const turn of this.turns.values()) {
      if (turn.status === 'running') {
        this.record({ ...turn, status: 'interrupted', error: '上次回复未正常结束，已保留对话和已保存的任务。可以发送新消息继续。' });
      }
    }
    this.state.sessionId = this.manager.getSessionId();
    this.state.error = [...this.turns.values()].at(-1)?.error;
    this.refreshMessages();
  }

  static async open(setup: AgentSetup, execute: ExecuteTool, changed: (state: Conversation) => void, env = process.env): Promise<PiSession> {
    const runtime = new PiSession(setup, execute, changed);
    await runtime.configure(env);
    return runtime;
  }

  private async configure(env: NodeJS.ProcessEnv): Promise<void> {
    const modelId = env.ORBIT_AGENT_MODEL?.trim();
    const baseUrl = env.ORBIT_AGENT_BASE_URL?.trim();
    const provider = baseUrl ? 'orbit' : env.ORBIT_AGENT_PROVIDER?.trim();
    if (!modelId || !provider) return;
    try {
      const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
        modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
      });
      if (baseUrl) {
        const url = new URL(baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('模型服务地址必须是 HTTP 或 HTTPS 地址，密钥请单独配置。');
        if (!env.ORBIT_AGENT_API_KEY) throw new Error('请配置文字对话的模型密钥。');
        const contextWindow = Number(env.ORBIT_AGENT_CONTEXT_WINDOW ?? 32768);
        const maxTokens = Number(env.ORBIT_AGENT_MAX_TOKENS ?? 4096);
        if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || contextWindow <= maxTokens) {
          throw new Error('模型上下文窗口和最大输出长度配置无效。');
        }
        models.registerProvider(provider, {
          baseUrl, api: 'openai-completions', apiKey: '$ORBIT_AGENT_API_KEY',
          models: [{ id: modelId, name: modelId, reasoning: false, input: ['text'], contextWindow, maxTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens' },
          }],
        });
      }
      if (env.ORBIT_AGENT_API_KEY) await models.setRuntimeApiKey(provider, env.ORBIT_AGENT_API_KEY);
      const model = models.getModel(provider, modelId);
      if (!model) throw new Error('未找到配置的模型，请检查服务商和模型名称。');
      if (!models.hasConfiguredAuth(provider) && !await models.checkAuth(provider)) throw new Error('请配置文字对话的模型密钥。');
      const extensionRuntime = createExtensionRuntime();
      // Host-owned resources: no implicit ~/.pi, project instructions, skills or extensions.
      const resourceLoader: ResourceLoader = {
        getExtensions: () => ({ extensions: [], errors: [], runtime: extensionRuntime }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => this.setup.systemPrompt,
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
        extendResources: () => {}, reload: async () => {},
      };
      const customTools: ToolDefinition[] = this.setup.tools.map(tool => ({
        ...tool, label: tool.name, parameters: Type.Unsafe(tool.parameters), executionMode: 'sequential',
        execute: async (_id, args, signal) => {
          if (!this.active || this.stopped || signal?.aborted) throw new Error('回复已停止。');
          const result = await this.execute(tool.name, args, {
            sessionId: this.manager.getSessionId(), requestId: this.active.requestId,
            currentAttachmentIds: this.active.attachments.map(file => file.id),
            attachmentIds: [...new Set([...this.turns.values()].flatMap(turn => turn.input.attachments.map(file => file.id)))],
          });
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        },
      }));
      const { session } = await createAgentSession({
        cwd: this.setup.directory, agentDir: this.setup.directory, model, modelRuntime: models,
        sessionManager: this.manager, resourceLoader, thinkingLevel: 'off',
        tools: this.setup.tools.map(tool => tool.name), customTools,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: true }, cacheWarming: 'off',
          retry: { enabled: true, maxRetries: 2, provider: { timeoutMs: 120_000, maxRetries: 1 } },
        }),
      });
      this.session = session;
      this.state.configured = true;
      this.state.model = `${provider}/${modelId}`;
      session.subscribe(event => {
        // abort() can arrive during prompt preflight, before Pi creates its run controller.
        if (event.type === 'agent_start' && this.stopped) void session.abort();
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          this.state.draft += event.assistantMessageEvent.delta;
          this.emit();
        }
        if (event.type === 'message_end') {
          if (event.message.role === 'assistant') {
            this.state.draft = '';
            this.state.error = event.message.stopReason === 'error' ? '模型回复失败，请检查模型服务、密钥和额度后再发送。'
              : event.message.stopReason === 'length' ? '回复达到模型长度上限，可以发送新消息继续。' : undefined;
          }
          this.refreshMessages(); this.emit();
        }
        // A low-level agent_end can be followed by retries. send() waits for prompt completion.
      });
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : '模型初始化失败。';
    }
  }

  private record(turn: Turn): void {
    this.manager.appendCustomEntry(TURN_ENTRY, turn);
    this.turns.set(turn.input.requestId, turn);
  }

  private refreshMessages(): void {
    const messages: Message[] = [];
    let input: AgentInput | undefined;
    for (const entry of this.manager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === TURN_ENTRY) {
        const turn = entry.data as Turn;
        if (turn.status === 'running') input = turn.input;
      }
      if (entry.type !== 'message') continue;
      const message = entry.message;
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      const text = typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('');
      if (!text && message.role === 'assistant') continue;
      messages.push({
        id: `pi-${entry.id}`, role: message.role, text: message.role === 'user' && input ? input.text || '已添加附件' : text,
        createdAt: entry.timestamp,
        ...(message.role === 'user' && input ? { requestId: input.requestId, attachmentIds: input.attachments.map(file => file.id) } : {}),
      });
      if (message.role === 'user') input = undefined;
    }
    this.state.messages = messages;
  }

  read(): Conversation { return structuredClone(this.state); }
  private emit(): void { this.changed(this.read()); }

  async send(input: AgentInput): Promise<void> {
    if (this.active) throw new Error('请等待当前回复，或先停止回复。');
    if (!this.session) throw new Error(this.state.error ?? '请先配置文字对话的模型服务。也可以选择仅保存需求。');
    const previous = this.turns.get(input.requestId);
    if (previous) {
      if (JSON.stringify(previous.input) !== JSON.stringify(input)) throw new Error('请求标识已经用于其他内容，请重新发送。');
      // A retry never replays a possibly committed business action, including after a crash.
      if (this.state.messages.some(message => message.requestId === input.requestId)) return;
    }
    this.record({ input, status: 'running' });
    this.active = input; this.stopped = false;
    this.finishing = new Promise(resolve => { this.finish = resolve; });
    this.state = { ...this.state, status: 'running', draft: '', error: undefined };
    this.emit();
    const prompt = input.text || '请先帮助我明确这些附件的用途。';
    const attachmentInfo = input.attachments.length ? `\n\nOrbit 附件元信息（仅元信息，内容尚未解析）：\n${JSON.stringify(input.attachments.map(({ id, name, size }) => ({ id, name, size })))}` : '';
    try {
      await this.session.prompt(prompt + attachmentInfo, { expandPromptTemplates: false });
      await this.session.waitForIdle();
    } catch {
      if (!this.stopped) this.state.error = '模型回复失败，请检查模型配置或连接后再发送。';
      this.refreshMessages();
      // Rejected preflight has not accepted a user message or invoked business tools.
      if (!this.state.messages.some(message => message.requestId === input.requestId)) throw new Error(this.state.error ?? '回复已停止，输入尚未发送。');
    } finally {
      if (this.stopped) this.state.error = '已停止回复。已保存的需求会保留。';
      try {
        this.record({ input, status: this.stopped ? 'interrupted' : this.state.error ? 'failed' : 'complete', error: this.state.error });
      } catch { this.state.error = '对话保存失败，请检查本机可用空间后重启。已创建的任务请在任务页核对。'; }
      this.active = undefined; this.state.status = 'idle'; this.state.draft = '';
      this.refreshMessages(); this.emit();
      this.finish?.(); this.finish = undefined;
    }
  }

  async abort(): Promise<void> {
    if (!this.active) return;
    this.stopped = true;
    await this.session?.abort();
    await this.finishing;
  }

  async close(): Promise<void> { await this.abort(); this.session?.dispose(); }
}
