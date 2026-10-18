import { randomUUID } from 'node:crypto';
import type { Conversation, VoiceEvent } from '../contracts';
import type { AgentInput, AgentRuntime, ToolContext } from '../domains/conversation/agent';
import type { VoiceRuntime } from '../domains/voice/realtime';
import type { RoomHistory } from '../domains/conversation/history';
import { HISTORY_PROMPT, INTERACTION_PROMPT, INTERACTION_TOOLS, InteractionService } from './interaction';
import type { WorkspaceService } from './workspace';

/** One durable room, with serialized Pi / Qwen turns and replaceable provider sessions. */
export class RoomService {
  private native: Conversation = { configured: false, status: 'idle', messages: [], draft: '' };
  private generation = 0;
  private channel: 'text' | 'voice' = 'text';
  private voiceEnabled = false;
  private voiceSession?: string;
  private textRun?: Promise<void>;
  private switching = false;
  private closed = false;

  constructor(readonly history: RoomHistory, private agent: AgentRuntime, private voice: VoiceRuntime,
    private interaction: InteractionService, private workspace: WorkspaceService,
    private changed: (state: Conversation) => void, private voiceChanged: (event: VoiceEvent) => void) {
    this.syncWorkspace();
  }

  acceptPi(state: Conversation) {
    this.history.importPi(state); this.native = state; this.emit();
  }
  acceptVoice(event: VoiceEvent) {
    if (event.type === 'transcript' && this.voiceSession && event.id && event.turnId) {
      this.history.append({ id: event.id, turnId: event.turnId, role: event.role, text: event.text,
        status: event.status, createdAt: new Date().toISOString() }, this.voiceSession, 'voice');
      this.emit();
    }
    if (event.type === 'state' && event.state === 'off' || event.type === 'error') this.voiceEnabled = false;
    this.voiceChanged(event);
  }
  private snapshot(page?: { before?: number; limit?: number }): Conversation {
    const { summary: _summary, ...state } = this.native;
    return { ...state, roomId: this.history.roomId, activeChannel: this.channel, ...this.history.page(page?.before, page?.limit) };
  }
  private emit() { this.changed(this.snapshot()); }
  async read(page?: unknown) {
    if (page !== undefined && (!page || typeof page !== 'object' || Array.isArray(page) || Object.keys(page).some(key => !['before', 'limit'].includes(key)))) throw new Error('历史分页参数无效。');
    this.acceptPi(await this.agent.read());
    return this.snapshot(page as { before?: number; limit?: number } | undefined);
  }
  syncWorkspace(context?: ToolContext) {
    for (const message of this.workspace.snapshot().messages) {
      // Preserve the original turn / session for receipts already copied from SQLite.
      if (this.history.has(message.id)) continue;
      this.history.append({ ...message, ...(context ? { turnId: context.turnId } : {}) }, context?.sessionId ?? 'workspace', 'system');
    }
    this.emit();
  }
  async execute(name: string, args: unknown, context: ToolContext) {
    if (context.roomId !== this.history.roomId || context.generation !== this.generation || this.closed) throw new Error('本轮对话已结束，工具调用已取消。');
    const result = await this.interaction.execute(name, args, { ...context,
      attachmentIds: [...new Set([...this.history.attachments(), ...context.currentAttachmentIds])] });
    this.syncWorkspace(context);
    return result;
  }
  async send(input: AgentInput) {
    if (this.closed || this.textRun || this.switching) throw new Error('请等待当前回复或切换结束，或先停止回复。');
    const generation = ++this.generation;
    this.voice.stop(false); this.voiceSession = undefined; this.channel = 'text';
    if (this.voiceEnabled) this.voiceChanged({ type: 'state', state: 'paused' });
    const run = this.agent.send({ ...input, roomId: this.history.roomId, turnId: input.requestId, generation, history: this.history.context() });
    this.textRun = run;
    try { await run; }
    finally {
      if (this.textRun === run) this.textRun = undefined;
      if (generation === this.generation && this.voiceEnabled && !this.closed) {
        try { this.openVoice(); }
        catch (error) { this.voiceEnabled = false; this.voiceChanged({ type: 'error', text: error instanceof Error ? error.message : '无法恢复语音。' }); }
      }
    }
  }
  async startVoice() {
    if (this.closed) throw new Error('Orbit 正在退出。');
    const generation = ++this.generation;
    this.voiceEnabled = true; this.switching = true; this.channel = 'voice';
    this.voice.stop(false); this.voiceSession = undefined;
    this.voiceChanged({ type: 'state', state: 'connecting' });
    try {
      await this.agent.abort();
      await this.textRun?.catch(() => {});
      if (generation === this.generation && this.voiceEnabled) this.openVoice();
    } catch (error) { if (generation === this.generation) this.stopVoice(); throw error; }
    finally { if (generation === this.generation) this.switching = false; }
  }
  private openVoice() {
    const generation = ++this.generation;
    this.switching = false;
    const sessionId = randomUUID(); this.voiceSession = sessionId; this.channel = 'voice';
    this.history.session(sessionId, 'voice');
    this.voice.start({ roomId: this.history.roomId, sessionId, generation, history: this.history.context(),
      attachmentIds: this.history.attachments(), tools: INTERACTION_TOOLS,
      instructions: INTERACTION_PROMPT + HISTORY_PROMPT,
      onSession: id => { if (this.voiceSession === sessionId) this.history.bindProvider(sessionId, id); } });
    this.emit();
  }
  stopVoice(notify = true) {
    this.voiceEnabled = false; this.switching = false;
    if (this.channel === 'voice') this.generation++;
    this.voice.stop(notify); this.voiceSession = undefined;
  }
  audio(pcm: Uint8Array) { if (this.voiceEnabled && this.channel === 'voice' && !this.switching) this.voice.audio(pcm); }
  async abort() { await this.agent.abort(); }
  async close() { this.closed = true; this.stopVoice(); await this.agent.close(); }
}
