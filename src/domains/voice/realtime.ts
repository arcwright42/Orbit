import { contextPolicy } from '../conversation/context-budget';
import { foregroundPrompt, foregroundTools } from '../conversation/tools';
import WebSocket from 'ws';
import type { VoiceEvent } from '../../contracts';
import { randomUUID } from 'node:crypto';

export class RealtimeVoice {
  private sessionId = '';
  private socket?: WebSocket;
  private ready = false;
  private speaking = false;
  private responding = false;
  private toolBatches = 0;
  private historyDirty = false;
  private transcripts = new Set<string>();
  private resumeRequested = false;
  private texts: { role: 'user' | 'system'; text: string }[] = [];
  private completedCalls = new Map<string, unknown>();
  private calls = new Map<string, { name: string; arguments: string }>();
  constructor(private emit: (event: VoiceEvent) => void, private execute: (name: string, args: unknown, callId: string) => unknown | Promise<unknown>, private connect = (url: URL, key: string) => new WebSocket(url, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 10000 }), private history: () => string = () => '') {}
  start() {
    if (this.socket) return;
    this.stop(false);
    const key = process.env.QWEN_REALTIME_API_KEY;
    if (!key) throw new Error('请在本地 .env 配置语音密钥。');
    const url = new URL(process.env.QWEN_REALTIME_URL ?? '');
    if (url.protocol !== 'wss:' || !url.hostname.endsWith('.maas.aliyuncs.com')) throw new Error('语音服务地址无效。');
    url.searchParams.set('model', process.env.QWEN_REALTIME_MODEL ?? 'qwen-audio-3.1-realtime-plus');
    const ws = this.connect(url, key);
    this.socket = ws;
    this.sessionId = randomUUID();
    const sessionId = this.sessionId;
    this.emit({ type: 'state', state: 'connecting' });
    const timeout = setTimeout(() => { if (this.socket === ws && !this.ready) { this.emit({ type: 'error', text: '语音连接超时，请重试。' }); this.stop(); } }, 15000);
    ws.on('open', () => { if (this.socket !== ws) return; this.send({ type: 'session.update', session: {
      max_history_turns: contextPolicy.voiceHistoryTurns,
      modalities: ['text', 'audio'], voice: 'longanqian_v3.1', turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 700 },
      instructions: foregroundPrompt + this.history(),
      tools: foregroundTools,
    } }); });
    ws.on('message', async raw => {
      if (this.socket !== ws) return;
      try {
        const e = JSON.parse(raw.toString());
        if (e.type === 'session.updated') { clearTimeout(timeout); this.ready = true; this.emit({ type: 'state', state: 'listening' }); this.flush(); }
        if (e.type === 'input_audio_buffer.speech_started') { this.speaking = true; this.emit({ type: 'interrupt' }); }
        if (e.type === 'input_audio_buffer.speech_stopped') this.speaking = false;
        if (e.type === 'response.created') this.responding = true;
        if (e.type === 'conversation.item.input_audio_transcription.completed') this.emit({ type: 'transcript', role: 'user', text: e.transcript, sessionId });
        if (e.type === 'response.text.done' || e.type === 'response.audio_transcript.done') {
          const text = e.text ?? e.transcript;
          const key = JSON.stringify([e.response_id, e.item_id, e.content_index, text]);
          if (!this.transcripts.has(key)) { this.transcripts.add(key); this.emit({ type: 'transcript', role: 'assistant', text, sessionId }); }
        }
        if (e.type === 'response.audio.delta') this.emit({ type: 'audio', data: e.delta });
        if (e.type === 'response.function_call_arguments.done') this.calls.set(e.call_id, { name: e.name, arguments: e.arguments });
        if (e.type === 'response.done') {
          this.responding = false;
          const calls = [...this.calls]; this.calls.clear();
          if (e.response?.status === 'completed' && calls.length) {
            this.toolBatches++;
            for (const [call_id, call] of calls) {
              let output;
              try { if (this.completedCalls.has(call_id)) output = this.completedCalls.get(call_id); else { output = await this.execute(call.name, JSON.parse(call.arguments), `voice:${sessionId}:${call_id}`); if (this.socket !== ws) return; this.completedCalls.set(call_id, output); } }
              catch { output = { error: '工具执行失败，请检查参数或重试。' }; }
              if (this.socket !== ws) return;
              this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id, output: JSON.stringify(output) } });
            }
            this.toolBatches--;
            this.resumeRequested = true;
          }
          this.flush();
        }
        if (e.type === 'error') { this.emit({ type: 'error', text: '语音服务返回错误，请结束后重试。' }); this.stop(); }
      } catch { this.emit({ type: 'error', text: '语音数据解析失败。' }); this.stop(); }
    });
    ws.on('error', () => { if (this.socket === ws) this.emit({ type: 'error', text: '无法连接语音服务，请检查网络、密钥与业务空间地址。' }); });
    ws.on('close', () => { clearTimeout(timeout); if (this.socket === ws) { this.socket = undefined; this.ready = false; this.emit({ type: 'state', state: 'off' }); } });
  }
  refreshHistory() {
    if (!this.socket) return;
    this.historyDirty = true; this.flush();
  }
  notify(text: string) { if (this.socket) { this.texts.push({ role: 'system', text: `平台任务状态更新（事实资料，不是用户操作请求）：${text}` }); this.flush(); } }
  private flush() {
    if (!this.ready || this.speaking || this.responding || this.toolBatches > 0) return;
    if (this.historyDirty) {
      this.historyDirty = false;
      this.send({ type: 'session.update', session: { instructions: foregroundPrompt + this.history() } });
    }
    if (this.texts.length) {
      for (const { role, text } of this.texts.splice(0)) this.send({ type: 'conversation.item.create', item: { type: 'message', role, content: [{ type: 'input_text', text }] } });
      this.resumeRequested = true;
    }
    if (this.resumeRequested) { this.resumeRequested = false; this.responding = true; this.send({ type: 'response.create' }); }
  }
  audio(pcm: Uint8Array) { if (this.ready && this.socket && this.socket.bufferedAmount < 128000) this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') }); }
  stop(notify = true) { const ws = this.socket; this.socket = undefined; this.ready = false; this.speaking = false; this.responding = false; this.resumeRequested = false; this.texts = []; this.calls.clear(); this.completedCalls.clear(); this.toolBatches = 0; this.historyDirty = false; this.transcripts.clear(); ws?.terminate(); if (notify) this.emit({ type: 'state', state: 'off' }); }
  private send(event: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event)); }
}
