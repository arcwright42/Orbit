import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { RealtimeVoice } from '../src/domains/voice/realtime';
import type { VoiceEvent } from '../src/contracts';

test('voice gates audio on session readiness, executes completed tools only, and isolates stopped sessions', () => {
  process.env.QWEN_REALTIME_API_KEY = 'test-key';
  process.env.QWEN_REALTIME_URL = 'wss://test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime';
  class Socket extends EventEmitter {
    readyState = 1; bufferedAmount = 0; sent: Record<string, unknown>[] = [];
    send(data: string) { this.sent.push(JSON.parse(data)); }
    terminate() { this.emit('close'); }
    receive(data: unknown) { this.emit('message', Buffer.from(JSON.stringify(data))); }
  }
  const sockets: Socket[] = []; const events: VoiceEvent[] = []; const calls: string[] = [];
  const voice = new RealtimeVoice(e => events.push(e), name => { calls.push(name); return { status: 'pending' }; }, () => { const ws = new Socket(); sockets.push(ws); return ws as unknown as WebSocket; });
  voice.start(); const first = sockets[0]; first.emit('open');
  voice.audio(new Uint8Array(1280)); assert.equal(first.sent.length, 1);
  first.receive({ type: 'session.updated' }); voice.audio(new Uint8Array(1280)); assert.equal(first.sent.length, 2);
  first.receive({ type: 'response.function_call_arguments.done', call_id: 'one', name: 'list_tasks', arguments: '{}' });
  assert.equal(calls.length, 0);
  first.receive({ type: 'response.done', response: { status: 'completed' } });
  assert.deepEqual(calls, ['list_tasks']); assert.equal(first.sent.at(-1)?.type, 'response.create');
  first.receive({ type: 'response.function_call_arguments.done', call_id: 'two', name: 'save_request', arguments: '{}' });
  first.receive({ type: 'response.done', response: { status: 'cancelled' } }); assert.equal(calls.length, 1);
  first.receive({ type: 'input_audio_buffer.speech_started' }); assert.equal(events.at(-1)?.type, 'interrupt');
  voice.stop(); first.receive({ type: 'response.audio.delta', delta: 'AAAA' }); assert.equal(events.at(-1)?.type, 'state');
});
