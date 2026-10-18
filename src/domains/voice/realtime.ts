import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { VoiceEvent } from '../../contracts';
import type { BusinessTool, ExecuteTool, ToolContext } from '../conversation/agent';
import { CONTEXT_POLICY, type HistoryContext } from '../conversation/history';

export interface VoiceSessionOptions {
  roomId: string;
  sessionId: string;
  generation: number;
  history: HistoryContext;
  tools: BusinessTool[];
  instructions: string;
  attachmentIds: string[];
  onSession: (providerId: string) => void;
}
export interface VoiceRuntime {
  start(options: VoiceSessionOptions): void;
  stop(notify?: boolean): void;
  audio(pcm: Uint8Array): void;
}
interface Transcript { id: string; turnId: string; role: 'user' | 'assistant'; text: string; status: 'complete' | 'interrupted' | 'failed'; responseId?: string }
interface Response { turnId: string; calls: Map<string, { name: string; arguments: string }>; settled: boolean; canceled: boolean }

/** Official Qwen realtime transport. Room owns persistence, turn arbitration and business tools. */
export class RealtimeVoice implements VoiceRuntime {
  private socket?: WebSocket;
  private ready = false;
  private timer?: NodeJS.Timeout;
  private options?: VoiceSessionOptions;
  private turnId = '';
  private responses = new Map<string, Response>();
  private transcripts = new Map<string, Transcript>();
  private historyItems = new Set<string>();
  private initialized = false;

  constructor(private emit: (event: VoiceEvent) => void, private execute: ExecuteTool,
    private connect = (url: URL, key: string) => new WebSocket(url, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 10000 })) {}

  start(options: VoiceSessionOptions) {
    this.stop(false);
    const key = process.env.QWEN_REALTIME_API_KEY;
    if (!key) throw new Error('请在本地 .env 配置语音密钥。');
    const url = new URL(process.env.QWEN_REALTIME_URL ?? '');
    if (url.protocol !== 'wss:' || !url.hostname.endsWith('.maas.aliyuncs.com')) throw new Error('语音服务地址无效。');
    url.searchParams.set('model', process.env.QWEN_REALTIME_MODEL ?? 'qwen-audio-3.1-realtime-plus');
    this.options = options;
    const ws = this.connect(url, key); this.socket = ws;
    this.emit({ type: 'state', state: 'connecting' });
    this.timer = setTimeout(() => { if (this.socket === ws && !this.ready) this.fail('语音连接或历史同步超时，请重试。'); }, 15000);
    ws.on('open', () => {
      if (this.socket !== ws) return;
      this.send({ type: 'session.update', session: {
        modalities: ['text', 'audio'], voice: 'longanqian_v3.1', max_history_turns: CONTEXT_POLICY.voiceHistoryTurns,
        turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 700 },
        instructions: options.instructions,
        tools: options.tools.map(tool => ({ type: 'function', function: tool })),
      } });
    });
    ws.on('message', raw => {
      if (this.socket !== ws) return;
      try { this.receive(JSON.parse(raw.toString()), ws); }
      catch { this.fail('语音数据处理失败，请结束后重试。'); }
    });
    ws.on('error', () => { if (this.socket === ws) this.fail('无法连接语音服务，请检查网络、密钥与业务空间地址。'); });
    ws.on('close', () => { if (this.socket === ws) this.stop(); });
  }

  private listening() {
    if (!this.initialized || this.historyItems.size || this.ready) return;
    clearTimeout(this.timer); this.ready = true; this.emit({ type: 'state', state: 'listening' });
  }
  private response(id: string): Response {
    let response = this.responses.get(id);
    if (!response) { response = { turnId: this.turnId, calls: new Map(), settled: false, canceled: false }; this.responses.set(id, response); }
    return response;
  }
  private publish(transcript: Transcript) {
    if (transcript.text.trim()) this.emit({ type: 'transcript', ...transcript });
  }
  private interrupt() {
    for (const response of this.responses.values()) if (!response.settled) response.canceled = true;
    for (const transcript of this.transcripts.values()) {
      if (transcript.status === 'interrupted' || transcript.status === 'failed') continue;
      if (transcript.role === 'assistant' && transcript.responseId && !this.responses.get(transcript.responseId)?.settled ||
          transcript.role === 'user' && transcript.status !== 'complete') {
        transcript.status = 'interrupted'; this.publish(transcript);
      }
    }
    this.emit({ type: 'interrupt' });
  }
  // Protocol envelopes are validated by event kind; arbitrary server errors never reach the UI.
  private receive(e: Record<string, any>, ws: WebSocket) {
    const options = this.options!;
    if ((e.type === 'session.created' || e.type === 'session.updated') && typeof e.session?.id === 'string') options.onSession(e.session.id);
    if (e.type === 'session.updated' && !this.initialized) {
      this.initialized = true;
      for (const message of options.history.messages) {
        if (message.role === 'system') continue;
        const id = `oh_${randomUUID().replaceAll('-', '')}`; this.historyItems.add(id);
        this.send({ type: 'conversation.item.create', item: { id, type: 'message', role: message.role,
          content: [{ type: message.role === 'user' ? 'input_text' : 'output_text',
            text: `${message.status !== 'complete' ? `[历史记录：${message.status}] ` : ''}${message.text}` }] } });
      }
      this.listening();
    }
    if (e.type === 'conversation.item.created' && this.historyItems.delete(e.item?.id)) { this.listening(); return; }
    if (this.historyItems.has(e.item_id)) return;
    if (e.type === 'input_audio_buffer.speech_started' || e.type === 'input_audio_buffer.committed') {
      if (typeof e.item_id !== 'string') return;
      const turnId = `${options.sessionId}:${e.item_id}`;
      if (this.turnId !== turnId) { this.interrupt(); this.turnId = turnId; }
    }
    if (e.type === 'response.created' && typeof e.response?.id === 'string') this.response(e.response.id);
    if (e.type === 'conversation.item.input_audio_transcription.completed' || e.type === 'conversation.item.input_audio_transcription.delta') {
      if (typeof e.item_id !== 'string') return;
      const id = `qwen-${options.sessionId}-${e.item_id}`;
      const complete = e.type.endsWith('.completed');
      const transcript: Transcript = { id, turnId: `${options.sessionId}:${e.item_id}`, role: 'user',
        text: complete ? String(e.transcript ?? '') : String(e.text ?? '') + String(e.stash ?? ''), status: complete ? 'complete' : 'interrupted' };
      this.transcripts.set(id, transcript);
      // Deltas stay in memory until finalization or stop, so search never sees every speculative token.
      if (complete) this.publish(transcript);
    }
    if (e.type === 'response.audio_transcript.delta' || e.type === 'response.audio_transcript.done' || e.type === 'response.text.delta' || e.type === 'response.text.done') {
      if (typeof e.response_id !== 'string' || typeof e.item_id !== 'string') return;
      const response = this.response(e.response_id);
      const id = `qwen-${options.sessionId}-${e.item_id}`;
      const previous = this.transcripts.get(id);
      const transcript: Transcript = { id, turnId: response.turnId, responseId: e.response_id, role: 'assistant',
        text: e.type.endsWith('.done') ? String(e.transcript ?? e.text ?? previous?.text ?? '') : (previous?.text ?? '') + String(e.delta ?? ''),
        status: response.canceled ? 'interrupted' : 'complete' };
      this.transcripts.set(id, transcript);
      if (e.type.endsWith('.done')) this.publish(transcript);
    }
    if (e.type === 'response.audio.delta' && this.ready && typeof e.delta === 'string' && !this.response(e.response_id).canceled) this.emit({ type: 'audio', data: e.delta });
    if (e.type === 'response.function_call_arguments.done' && typeof e.response_id === 'string' && typeof e.call_id === 'string') {
      this.response(e.response_id).calls.set(e.call_id, { name: e.name, arguments: e.arguments });
    }
    if (e.type === 'response.done' && typeof e.response?.id === 'string') {
      const responseId = e.response.id, response = this.response(responseId);
      if (response.settled) return;
      response.settled = true;
      for (const transcript of this.transcripts.values()) if (transcript.responseId === responseId) {
        transcript.status = response.canceled || e.response.status === 'cancelled' ? 'interrupted' : e.response.status === 'completed' ? 'complete' : 'failed';
        this.publish(transcript);
      }
      if (e.response.status === 'completed' && !response.canceled) void this.runTools(response, ws).catch(() => {
        if (this.socket === ws) this.fail('语音工具结果处理失败，请重试。');
      });
    }
    if (e.type === 'error') this.fail('语音服务返回错误，请结束后重试。');
  }
  private async runTools(response: Response, ws: WebSocket) {
    const options = this.options!;
    const current = () => this.socket === ws && this.turnId === response.turnId && !response.canceled;
    if (!current() || !response.turnId || !response.calls.size) return;
    const context: ToolContext = { roomId: options.roomId, sessionId: options.sessionId, generation: options.generation,
      turnId: response.turnId, requestId: response.turnId, attachmentIds: options.attachmentIds, currentAttachmentIds: [] };
    for (const [call_id, call] of response.calls) {
      if (!current()) return;
      let output: unknown;
      try {
        if (!options.tools.some(tool => tool.name === call.name)) throw new Error('Unknown tool');
        output = await this.execute(call.name, JSON.parse(call.arguments), context);
      } catch { output = { error: '工具执行失败，请检查参数或重试。' }; }
      if (!current()) return;
      this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id, output: JSON.stringify(output) } });
    }
    if (current()) this.send({ type: 'response.create' });
  }
  audio(pcm: Uint8Array) {
    if (this.ready && this.socket && this.socket.bufferedAmount < 128000) this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') });
  }
  stop(notify = true) {
    clearTimeout(this.timer);
    if (this.socket) {
      this.send({ type: 'response.cancel' }); this.interrupt();
      for (const transcript of this.transcripts.values()) this.publish(transcript);
    }
    const ws = this.socket; this.socket = undefined; this.ready = false; this.initialized = false;
    this.responses.clear(); this.transcripts.clear(); this.historyItems.clear(); this.turnId = '';
    ws?.terminate(); if (notify) this.emit({ type: 'state', state: 'off' });
  }
  private fail(text: string) { this.stop(); this.emit({ type: 'error', text }); }
  private send(event: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event)); }
}
