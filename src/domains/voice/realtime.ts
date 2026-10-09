import WebSocket from 'ws';
import type { VoiceEvent } from '../../contracts';

export class RealtimeVoice {
  private socket?: WebSocket;
  private ready = false;
  private calls = new Map<string, { name: string; arguments: string }>();
  constructor(private emit: (event: VoiceEvent) => void, private execute: (name: string, args: unknown) => unknown, private connect = (url: URL, key: string) => new WebSocket(url, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 10000 })) {}
  start() {
    this.stop(false);
    const key = process.env.QWEN_REALTIME_API_KEY;
    if (!key) throw new Error('请在本地 .env 配置语音密钥。');
    const url = new URL(process.env.QWEN_REALTIME_URL ?? '');
    if (url.protocol !== 'wss:' || !url.hostname.endsWith('.maas.aliyuncs.com')) throw new Error('语音服务地址无效。');
    url.searchParams.set('model', process.env.QWEN_REALTIME_MODEL ?? 'qwen-audio-3.1-realtime-plus');
    const ws = this.connect(url, key);
    this.socket = ws;
    this.emit({ type: 'state', state: 'connecting' });
    const timeout = setTimeout(() => { if (this.socket === ws && !this.ready) { this.emit({ type: 'error', text: '语音连接超时，请重试。' }); this.stop(); } }, 15000);
    ws.on('open', () => { if (this.socket !== ws) return; this.send({ type: 'session.update', session: {
      modalities: ['text', 'audio'], voice: 'longanqian_v3.1', turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 700 },
      instructions: '你是 Orbit 常驻交互助手。使用简短自然的中文交流。你只负责理解、澄清、保存需求和查询任务，不执行具体工作。只有用户明确要求保存需求才调用 save_request。保存后任务只是待派发，绝不能声称已经执行。查询状态必须调用 list_tasks。不能创建团队或执行代码。',
      tools: [
        { type: 'function', function: { name: 'list_tasks', description: '查询本机任务及其真实状态', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'save_request', description: '保存用户明确提出的需求为待派发任务，不会执行', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
      ],
    } }); });
    ws.on('message', raw => {
      if (this.socket !== ws) return;
      try {
        const e = JSON.parse(raw.toString());
        if (e.type === 'session.updated') { clearTimeout(timeout); this.ready = true; this.emit({ type: 'state', state: 'listening' }); }
        if (e.type === 'input_audio_buffer.speech_started') this.emit({ type: 'interrupt' });
        if (e.type === 'conversation.item.input_audio_transcription.completed') this.emit({ type: 'transcript', role: 'user', text: e.transcript });
        if (e.type === 'response.audio_transcript.done') this.emit({ type: 'transcript', role: 'assistant', text: e.transcript });
        if (e.type === 'response.audio.delta') this.emit({ type: 'audio', data: e.delta });
        if (e.type === 'response.function_call_arguments.done') this.calls.set(e.call_id, { name: e.name, arguments: e.arguments });
        if (e.type === 'response.done') {
          const calls = [...this.calls]; this.calls.clear();
          if (e.response?.status === 'completed' && calls.length) {
            for (const [call_id, call] of calls) {
              let output;
              try { output = this.execute(call.name, JSON.parse(call.arguments)); }
              catch { output = { error: '工具执行失败，请检查参数或重试。' }; }
              this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id, output: JSON.stringify(output) } });
            }
            this.send({ type: 'response.create' });
          }
        }
        if (e.type === 'error') { this.emit({ type: 'error', text: '语音服务返回错误，请结束后重试。' }); this.stop(); }
      } catch { this.emit({ type: 'error', text: '语音数据解析失败。' }); this.stop(); }
    });
    ws.on('error', () => { if (this.socket === ws) this.emit({ type: 'error', text: '无法连接语音服务，请检查网络、密钥与业务空间地址。' }); });
    ws.on('close', () => { clearTimeout(timeout); if (this.socket === ws) { this.socket = undefined; this.ready = false; this.emit({ type: 'state', state: 'off' }); } });
  }
  audio(pcm: Uint8Array) { if (this.ready && this.socket && this.socket.bufferedAmount < 128000) this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') }); }
  stop(notify = true) { const ws = this.socket; this.socket = undefined; this.ready = false; this.calls.clear(); ws?.terminate(); if (notify) this.emit({ type: 'state', state: 'off' }); }
  private send(event: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event)); }
}
