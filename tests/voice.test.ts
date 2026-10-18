import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { RealtimeVoice, type VoiceSessionOptions } from '../src/domains/voice/realtime';
import { INTERACTION_TOOLS } from '../src/application/interaction';
import type { VoiceEvent } from '../src/contracts';

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent: any[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  terminate() { this.emit('close'); }
  receive(data: unknown) { this.emit('message', Buffer.from(JSON.stringify(data))); }
}
const options = (): VoiceSessionOptions => ({ roomId: 'main', sessionId: 'local-session', generation: 1,
  history: { roomId: 'main', throughSeq: 0, messages: [] }, instructions: 'test', tools: INTERACTION_TOOLS, attachmentIds: [], onSession: () => {} });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(execute: ConstructorParameters<typeof RealtimeVoice>[1] = () => ({})) {
  process.env.QWEN_REALTIME_API_KEY = 'test-key';
  process.env.QWEN_REALTIME_URL = 'wss://test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime';
  const sockets: Socket[] = [], events: VoiceEvent[] = [];
  const voice = new RealtimeVoice(e => events.push(e), execute, () => { const ws = new Socket(); sockets.push(ws); return ws as unknown as WebSocket; });
  const start = (setup = options()) => { voice.start(setup); const ws = sockets.at(-1)!; ws.emit('open'); return ws; };
  return { voice, events, start };
}

test('Qwen acknowledges injected room history before accepting microphone audio; uses all common tools and 20 turns', () => {
  const f = fixture(); const setup = options();
  setup.history.messages = [{ id: 'prior', roomId: 'main', sessionId: 'pi', turnId: 't', seq: 1, channel: 'text', role: 'user', text: '记住蓝鲸', status: 'complete', createdAt: new Date().toISOString() }];
  const ws = f.start(setup);
  try {
    assert.equal(ws.sent[0].session.max_history_turns, 20);
    assert.deepEqual(ws.sent[0].session.tools.map((tool: any) => tool.function.name), INTERACTION_TOOLS.map(tool => tool.name));
    f.voice.audio(new Uint8Array(1280)); assert.equal(ws.sent.length, 1);
    ws.receive({ type: 'session.updated', session: { id: 'provider-session' } });
    const history = ws.sent.at(-1).item; assert.equal(history.content[0].type, 'input_text');
    assert.match(history.content[0].text, /蓝鲸/);
    f.voice.audio(new Uint8Array(1280)); assert.equal(ws.sent.length, 2);
    ws.receive({ type: 'conversation.item.created', item: history });
    assert.deepEqual(f.events.at(-1), { type: 'state', state: 'listening' });
    f.voice.audio(new Uint8Array(1280)); assert.equal(ws.sent.at(-1).type, 'input_audio_buffer.append');
    ws.receive({ type: 'session.updated' }); assert.equal(ws.sent.length, 3);
  } finally { f.voice.stop(); }
});

test('Qwen awaits tools once per completed response, preserves turn IDs and drops late async results after switching', async () => {
  const calls: string[] = []; let finish: (value: unknown) => void = () => {};
  const f = fixture(async (name, _args, context) => { calls.push(name); assert.equal(context.turnId, 'local-session:user-1'); return new Promise(resolve => { finish = resolve; }); });
  const ws = f.start(); ws.receive({ type: 'session.updated' });
  try {
    ws.receive({ type: 'input_audio_buffer.speech_started', item_id: 'user-1' });
    ws.receive({ type: 'response.created', response: { id: 'response-1' } });
    ws.receive({ type: 'response.function_call_arguments.done', response_id: 'response-1', call_id: 'call-1', name: 'search_history', arguments: '{}' });
    ws.receive({ type: 'response.done', response: { id: 'response-1', status: 'completed' } });
    ws.receive({ type: 'response.done', response: { id: 'response-1', status: 'completed' } });
    assert.deepEqual(calls, ['search_history']);
    assert.equal(ws.sent.some(item => item.type === 'response.create'), false);
    finish({ matches: [] }); await tick();
    assert.equal(ws.sent.at(-2).item.output, '{"matches":[]}');
    assert.equal(ws.sent.at(-1).type, 'response.create');
    ws.receive({ type: 'response.created', response: { id: 'response-2' } });
    ws.receive({ type: 'response.function_call_arguments.done', response_id: 'response-2', call_id: 'call-2', name: 'save_request', arguments: '{}' });
    ws.receive({ type: 'response.done', response: { id: 'response-2', status: 'cancelled' } });
    assert.equal(calls.length, 1);
    ws.receive({ type: 'response.created', response: { id: 'response-3' } });
    ws.receive({ type: 'response.function_call_arguments.done', response_id: 'response-3', call_id: 'call-3', name: 'list_tasks', arguments: '{}' });
    ws.receive({ type: 'response.done', response: { id: 'response-3', status: 'completed' } });
    const next = f.start(); next.receive({ type: 'session.updated' });
    const count = next.sent.length; finish({ tasks: [] }); await tick();
    assert.equal(next.sent.length, count);
    ws.receive({ type: 'response.audio.delta', response_id: 'response-3', delta: 'AAAA' });
    assert.equal(f.events.at(-1)?.type, 'state');
  } finally { f.voice.stop(); }
});

test('Qwen archives received partial text as interrupted and ignores duplicate/late finals from stopped sessions', () => {
  const f = fixture(); const ws = f.start(); ws.receive({ type: 'session.updated' });
  ws.receive({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  ws.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'u1', text: '我要', stash: '蓝鲸' });
  ws.receive({ type: 'response.created', response: { id: 'r1' } });
  ws.receive({ type: 'response.audio_transcript.delta', response_id: 'r1', item_id: 'a1', delta: '记住了' });
  f.voice.stop();
  const transcripts = f.events.filter(event => event.type === 'transcript');
  assert.ok(transcripts.some(event => event.role === 'user' && event.text === '我要蓝鲸' && event.status === 'interrupted'));
  assert.ok(transcripts.some(event => event.role === 'assistant' && event.text === '记住了' && event.status === 'interrupted'));
  const count = f.events.length;
  ws.receive({ type: 'response.audio_transcript.done', response_id: 'r1', item_id: 'a1', transcript: '迟到' });
  assert.equal(f.events.length, count);
});
