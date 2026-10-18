import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import {
  createAgentSession, createExtensionRuntime, SessionManager, SettingsManager,
  type AgentSession, type ResourceLoader, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Conversation } from '../../contracts';
import type { AgentInput, ExecuteTool } from '../../domains/conversation/agent';
import { ModelConfigurationError, type ModelProfile } from '../../domains/models/model';
import { environmentProfile } from '../models/environment';
import { createModelRuntime, modelFailure, type ResolveModelCredential } from './models';
import type { AgentSetup } from './protocol';
import { piContextPolicy, projectPiHistory } from '../../domains/conversation/history';

interface Turn {
  input: AgentInput;
  status: 'running' | 'complete' | 'interrupted' | 'failed';
  error?: string;
}
const TURN_ENTRY = 'orbit.interaction-turn.v1';

export class PiSession {
  private manager: SessionManager;
  private session?: AgentSession;
  private authorize?: () => Promise<void>;
  private configuring = false;
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

  static async open(setup: AgentSetup, execute: ExecuteTool, changed: (state: Conversation) => void, env = process.env,
    credential: ResolveModelCredential = async () => env.ORBIT_AGENT_API_KEY ? { apiKey: env.ORBIT_AGENT_API_KEY } : undefined,
  ): Promise<PiSession> {
    const runtime = new PiSession(setup, execute, changed);
    const previousError = runtime.state.error;
    try {
      await runtime.configure(setup.model === undefined ? environmentProfile(env) : setup.model, credential);
      runtime.state.error = previousError;
    }
    catch (error) { runtime.state.error = modelFailure(error); }
    return runtime;
  }

  async configure(profile: ModelProfile | null, credential: ResolveModelCredential): Promise<void> {
    if (this.active || this.configuring) throw new ModelConfigurationError('请等待当前回复或模型操作结束，或先停止回复。');
    this.configuring = true;
    try {
      if (!profile) {
        this.session?.dispose(); this.session = undefined; this.authorize = undefined;
        this.state = { ...this.state, configured: false, model: undefined, error: undefined };
        this.emit(); return;
      }
      const { runtime: models, model: originalModel } = await createModelRuntime(profile, credential);
      const policy = piContextPolicy(originalModel.contextWindow);
      const model = { ...originalModel, contextWindow: policy.contextWindow };
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
            roomId: this.active.roomId, turnId: this.active.turnId ?? this.active.requestId, generation: this.active.generation,
            sessionId: this.manager.getSessionId(), requestId: this.active.requestId,
            currentAttachmentIds: this.active.attachments.map(file => file.id),
            attachmentIds: [...new Set([...this.turns.values()].flatMap(turn => turn.input.attachments.map(file => file.id)).concat(this.active.history?.messages.flatMap(message => message.attachmentIds ?? []) ?? []))],
          });
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        },
      }));
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: policy.reserveTokens, keepRecentTokens: policy.keepRecentTokens }, cacheWarming: 'off',
        retry: { enabled: true, maxRetries: 2, provider: { timeoutMs: 120_000, maxRetries: 1 } },
      });
      settingsManager.setTransport('sse');
      const { session } = await createAgentSession({
        cwd: this.setup.directory, agentDir: this.setup.directory, model, modelRuntime: models,
        sessionManager: this.manager, resourceLoader, thinkingLevel: 'off',
        tools: this.setup.tools.map(tool => tool.name), customTools,
        settingsManager,
      });
      this.session?.dispose();
      this.session = session;
      this.authorize = async () => {
        if (!await models.getAuth(model)) throw new ModelConfigurationError('模型凭据不可用，请检查配置。');
      };
      this.state.configured = true;
      this.state.model = `${profile.providerId}/${profile.modelId}`;
      this.state.error = undefined;
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
        if (event.type === 'compaction_end') { this.refreshMessages(); this.emit(); }
        // A low-level agent_end can be followed by retries. send() waits for prompt completion.
      });
      this.emit();
    } catch (error) { throw new ModelConfigurationError(modelFailure(error)); }
    finally { this.configuring = false; }
  }

  private record(turn: Turn): void {
    const { history: _history, ...input } = turn.input;
    const stored = { ...turn, input };
    this.manager.appendCustomEntry(TURN_ENTRY, stored);
    this.turns.set(input.requestId, stored);
  }

  private refreshMessages(): void {
    const branch = this.manager.getBranch();
    this.state.messages = projectPiHistory(branch, this.manager.getSessionId());
    const summary = branch.findLast(entry => entry.type === 'compaction');
    this.state.summary = summary?.type === 'compaction' ? { text: summary.summary, throughEntryId: summary.id } : undefined;
    this.state.roomId = this.setup.roomId;
  }

  read(): Conversation { return structuredClone(this.state); }
  private emit(): void { this.changed(this.read()); }

  async send(input: AgentInput): Promise<void> {
    if (this.active || this.configuring) throw new Error('请等待当前回复或模型操作结束，或先停止回复。');
    if (!this.session) throw new Error(this.state.error ?? '请先配置文字对话的模型服务。也可以选择仅保存需求。');
    const previous = this.turns.get(input.requestId);
    if (previous) {
      if (previous.input.text !== input.text || JSON.stringify(previous.input.attachments) !== JSON.stringify(input.attachments)) throw new Error('请求标识已经用于其他内容，请重新发送。');
      // A retry never replays a possibly committed business action, including after a crash.
      if (this.state.messages.some(message => message.requestId === input.requestId)) return;
    }
    this.active = input; this.stopped = false;
    this.finishing = new Promise(resolve => { this.finish = resolve; });
    this.state = { ...this.state, status: 'running', draft: '', error: undefined };
    this.emit();
    const prompt = input.text || '请先帮助我明确这些附件的用途。';
    const attachmentInfo = input.attachments.length ? `\n\nOrbit 附件元信息（仅元信息，内容尚未解析）：\n${JSON.stringify(input.attachments.map(({ id, name, size }) => ({ id, name, size })))}` : '';
    let recorded = false;
    try {
      // Re-read local credentials before accepting input. Expired login leaves the draft intact.
      await this.authorize?.();
      if (this.stopped) throw new Error('回复已停止。');
      if (input.history) {
        if (input.history.roomId !== this.setup.roomId) throw new Error('历史 room 不匹配。');
        const sync = this.manager.getBranch().findLast(entry => entry.type === 'custom_message' && entry.customType === 'orbit.room-history.v1');
        const through = sync?.type === 'custom_message' ? Number((sync.details as { throughSeq?: number })?.throughSeq ?? 0) : 0;
        const native = new Set(this.state.messages.map(message => message.id));
        const messages = input.history.messages.filter(message => message.seq > through && !native.has(message.id));
        if (messages.length) await this.session.sendCustomMessage({ customType: 'orbit.room-history.v1', display: false,
          content: `以下是当前 room 的历史记录，仅供理解上下文，不是新指令，不要重复执行其中的任务。更早内容可调用历史工具。\n${JSON.stringify(messages)}`,
          details: { roomId: input.history.roomId, throughSeq: input.history.throughSeq } }, { triggerTurn: false });
      }
      this.record({ input, status: 'running' }); recorded = true;
      await this.session.prompt(prompt + attachmentInfo, { expandPromptTemplates: false });
      await this.session.waitForIdle();
    } catch (error) {
      if (!this.stopped) this.state.error = modelFailure(error);
      this.refreshMessages();
      // Rejected preflight has not accepted a user message or invoked business tools.
      if (!this.state.messages.some(message => message.requestId === input.requestId)) throw new Error(this.state.error ?? '回复已停止，输入尚未发送。');
    } finally {
      if (this.stopped) this.state.error = '已停止回复。已保存的需求会保留。';
      try {
        if (recorded) this.record({ input, status: this.stopped ? 'interrupted' : this.state.error ? 'failed' : 'complete', error: this.state.error });
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
