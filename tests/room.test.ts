import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { PiSession } from '../src/infrastructure/pi/session';
import { FileRoomHistory } from '../src/infrastructure/history/store';
import { RoomService } from '../src/application/room';
import { HISTORY_PROMPT, INTERACTION_PROMPT, INTERACTION_TOOLS, InteractionService } from '../src/application/interaction';
import { WorkspaceService } from '../src/application/workspace';
import { MaterialLibrary } from '../src/domains/materials/library';
import { openDatabase } from '../src/infrastructure/database';
import type { Conversation, VoiceEvent } from '../src/contracts';
import type { VoiceRuntime, VoiceSessionOptions } from '../src/domains/voice/realtime';
import { createModelServer } from './fixtures/model-server';

class Voice implements VoiceRuntime {
  starts: VoiceSessionOptions[] = []; stopped = 0; frames = 0;
  start(options: VoiceSessionOptions) { this.starts.push(options); }
  stop() { this.stopped++; }
  audio() { this.frames++; }
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-room-'));
  const db = openDatabase(join(directory, 'orbit.sqlite'));
  const workspace = new WorkspaceService(db, new MaterialLibrary(db, join(directory, 'attachments')));
  const history = new FileRoomHistory(directory), interaction = new InteractionService(workspace, history);
  const server = await createModelServer(), voice = new Voice(); const events: VoiceEvent[] = [];
  let room: RoomService | undefined;
  const pi = await PiSession.open({ directory: history.runtimeDirectory, roomId: history.roomId, systemPrompt: INTERACTION_PROMPT + HISTORY_PROMPT, tools: INTERACTION_TOOLS },
    (name, args, context) => room!.execute(name, args, context), state => room?.acceptPi(state), server.env);
  const agent = { read: async () => pi.read(), send: pi.send.bind(pi), abort: pi.abort.bind(pi), close: pi.close.bind(pi) };
  room = new RoomService(history, agent, voice, interaction, workspace, () => {}, event => events.push(event));
  await room.read();
  return { directory, db, workspace, history, interaction, server, pi, room, voice, events,
    send: (id: string, text: string) => room!.send(interaction.prepare({ requestId: id, text, attachmentIds: [] })),
    async cleanup() { await room!.close(); await server.close(); db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('one room bridges real Pi context with voice sessions, pauses audio during text and resumes with history', async () => {
  const f = await fixture();
  try {
    await f.room.startVoice(); const first = f.voice.starts[0];
    f.room.acceptVoice({ type: 'transcript', role: 'user', id: 'voice-u1', turnId: 'voice-turn', text: '校验词是蓝鲸', status: 'complete' });
    f.room.acceptVoice({ type: 'transcript', role: 'assistant', id: 'voice-a1', turnId: 'voice-turn', text: '记住蓝鲸了', status: 'complete' });
    f.room.acceptVoice({ type: 'transcript', role: 'assistant', id: 'voice-a1', turnId: 'voice-turn', text: '记住蓝鲸了', status: 'complete' });
    await f.send('text-request', '你好，继续聊');
    assert.ok(JSON.stringify(f.server.requests[0].messages).includes('校验词是蓝鲸'));
    assert.equal(f.voice.starts.length, 2); assert.notEqual(f.voice.starts[1].sessionId, first.sessionId);
    assert.equal(f.voice.starts[1].roomId, first.roomId);
    assert.ok(f.voice.starts[1].history.messages.some(message => message.text === '你好，继续聊'));
    assert.equal(f.history.all().length, 4);
    assert.ok(f.events.some(event => event.type === 'state' && event.state === 'paused'));
    const slow = f.send('slow-room-request', '慢回复');
    for (let i = 0; i < 100 && !f.pi.read().draft; i++) await delay(10);
    assert.ok(f.pi.read().draft);
    f.room.audio(new Uint8Array(1280)); assert.equal(f.voice.frames, 0);
    await f.room.startVoice(); await slow;
    assert.equal(f.pi.read().status, 'idle');
    assert.ok(f.history.all().some(message => message.channel === 'text' && message.status === 'interrupted'));
    const room = await f.room.read({ limit: 2 }); assert.equal(room.messages.length, 2); assert.ok(room.nextCursor);
    await assert.rejects(f.room.read({ limit: -1 }), /分页/);
    const restored = new FileRoomHistory(f.directory); assert.deepEqual(restored.all(), f.history.all());
  } finally { await f.cleanup(); }
});

test('room tools isolate generations, deduplicate the same voice turn and retain committed receipts after interruption', async () => {
  const f = await fixture();
  try {
    await f.room.startVoice(); const setup = f.voice.starts[0];
    const context = { roomId: 'main', sessionId: setup.sessionId, generation: setup.generation, turnId: 'voice-u1', requestId: 'voice-u1', attachmentIds: [], currentAttachmentIds: [] };
    await f.room.execute('save_request', { text: '保存一个网站需求' }, context);
    await f.room.execute('save_request', { text: '保存一个网站需求' }, context);
    assert.equal(f.workspace.snapshot().tasks.length, 1);
    assert.equal(f.history.all().filter(message => message.role === 'system').length, 1);
    const search = await f.room.execute('search_history', { mode: 'content', pattern: '尚未派发' }, context) as { matches: unknown[] };
    assert.ok(search.matches.length);
    f.room.stopVoice();
    await assert.rejects(f.room.execute('save_request', { text: 'late request' }, context), /已结束/);
    await f.send('save-text-request', '保存网站需求，重复调用');
    assert.equal(f.workspace.snapshot().tasks.length, 2);
    assert.equal(f.history.all().filter(message => message.role === 'system').length, 2);
    await f.send('save-text-request', '保存网站需求，重复调用');
    assert.equal(f.workspace.snapshot().tasks.length, 2);
    const tools = f.history.all().filter(message => message.role === 'tool');
    assert.ok(tools.some(message => message.channel === 'voice' && message.tool?.name === 'save_request'));
    assert.ok(tools.some(message => message.channel === 'text' && message.tool?.name === 'save_request'));
    assert.ok(tools.every(message => message.status === 'complete'));
    assert.ok(tools.filter(message => message.tool?.name === 'save_request').every(message => message.taskId && message.text.includes('"executed": false')));
    assert.ok(f.history.context().messages.every(message => message.role === 'user' || message.role === 'assistant'));
    assert.deepEqual(new FileRoomHistory(f.directory).all(), f.history.all());
  } finally { await f.cleanup(); }
});

test('tool events update one stable row on completion or failure and bound their previews', async () => {
  const f = await fixture();
  try {
    await f.room.startVoice(); const setup = f.voice.starts[0];
    const context = { roomId: 'main', sessionId: setup.sessionId, generation: setup.generation, turnId: 'tool-turn', requestId: 'tool-turn', attachmentIds: [], currentAttachmentIds: [] };
    let finish!: (result: unknown) => void;
    f.interaction.execute = () => new Promise(resolve => { finish = resolve; });
    const run = f.room.execute('list_tasks', {}, context);
    const pending = f.history.all().at(-1)!;
    assert.equal(pending.role, 'tool'); assert.equal(pending.status, 'running');
    finish({ result: 'x'.repeat(20000) }); await run;
    const done = f.history.all().at(-1)!;
    assert.equal(done.id, pending.id); assert.equal(done.seq, pending.seq);
    assert.equal(done.createdAt, pending.createdAt); assert.equal(done.status, 'complete');
    assert.ok(done.text.length < 16100); assert.match(done.text, /展示已截断/);
    f.interaction.execute = () => { throw new Error('Synthetic tool failure'); };
    await assert.rejects(f.room.execute('read_history', { file: 'missing.jsonl' }, context), /Synthetic tool failure/);
    const failed = f.history.all().at(-1)!;
    assert.equal(failed.status, 'failed'); assert.equal(failed.text, 'Synthetic tool failure');
    assert.notEqual(failed.id, done.id);
  } finally { await f.cleanup(); }
});

test('legacy native files migrate once, keep originals and Pi continues the original session', async () => {
  const f = await fixture();
  let imported: PiSession | undefined;
  try {
    await f.send('legacy-text-request', '你好');
    await f.pi.close();
    const legacy = f.history.runtimeDirectory;
    const nativeFiles = readdirSync(join(legacy, 'sessions'));
    const bytes = readFileSync(join(legacy, 'sessions', nativeFiles[0]), 'utf8');
    const migrated = new FileRoomHistory(join(f.directory, 'migration'));
    migrated.migrate(legacy, f.workspace.snapshot().messages);
    const snapshot = migrated.all(); assert.equal(snapshot.length, 2);
    migrated.migrate(legacy, f.workspace.snapshot().messages); assert.deepEqual(migrated.all(), snapshot);
    assert.equal(readFileSync(join(legacy, 'sessions', nativeFiles[0]), 'utf8'), bytes);
    imported = await PiSession.open({ directory: migrated.runtimeDirectory, roomId: 'main', tools: INTERACTION_TOOLS, systemPrompt: INTERACTION_PROMPT }, () => {}, () => {}, f.server.env);
    assert.equal(imported.read().sessionId, f.pi.read().sessionId);
    assert.equal(imported.read().messages.length, 2);
    const state: Conversation = { ...imported.read(), summary: { text: '自动压缩摘要', throughEntryId: 'compact-1' } };
    migrated.importPi(state);
    assert.match(readFileSync(join(migrated.historyDirectory, `${state.sessionId}.summary.md`), 'utf8'), /自动压缩摘要/);
  } finally { await imported?.close(); await f.cleanup(); }
});

test('native Pi auto-compaction exports a session summary without removing room history', async () => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const f = await fixture(); let compressed: PiSession | undefined;
  try {
    await f.pi.close();
    const directory = join(f.directory, 'compaction');
    const history = new FileRoomHistory(directory);
    const manager = SessionManager.create(history.runtimeDirectory, join(history.runtimeDirectory, 'sessions'));
    for (let index = 0; index < 8; index++) {
      manager.appendMessage({ role: 'user', content: `旧轮次 ${index} ${'原始记录'.repeat(1000)}`, timestamp: Date.now() });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `收到 ${index}` }],
        api: 'openai-completions', provider: 'orbit-test', model: 'orbit-test', stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 7500, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 7510, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    }
    compressed = await PiSession.open({ directory: history.runtimeDirectory, roomId: 'main', tools: INTERACTION_TOOLS, systemPrompt: INTERACTION_PROMPT + HISTORY_PROMPT }, () => {}, state => history.importPi(state),
      { ...f.server.env, ORBIT_AGENT_CONTEXT_WINDOW: '8192', ORBIT_AGENT_MAX_TOKENS: '512' });
    history.importPi(compressed.read()); const count = history.all().length;
    await compressed.send({ requestId: 'after-compaction', text: '你好', attachments: [], roomId: 'main', history: history.context() });
    assert.ok(compressed.read().summary?.text, 'Pi must actually compact through the model transport');
    assert.ok(readdirSync(history.historyDirectory).some(file => file.endsWith('.summary.md')));
    assert.ok(history.all().length >= count + 2);
    assert.ok(history.all().some(message => message.text.startsWith('旧轮次 0')));
    const summary = await history.searchHistory({ mode: 'files', pattern: '*.summary.md' }) as { matches: unknown[] };
    assert.equal(summary.matches.length, 1);
  } finally { await compressed?.close(); await f.cleanup(); }
});

test('turn cancellation never reopens voice after the user disables it; startup repairs missing SQLite receipts', async () => {
  const f = await fixture();
  try {
    await f.room.startVoice();
    const slow = f.send('cancel-voice-mode', '慢回复');
    for (let i = 0; i < 100 && !f.pi.read().draft; i++) await delay(10);
    f.room.stopVoice(); await f.room.abort(); await slow;
    assert.equal(f.voice.starts.length, 1);
    const switching = f.room.startVoice(); f.room.stopVoice(); await switching;
    assert.equal(f.voice.starts.length, 1);
    f.workspace.saveRequest({ requestId: 'receipt-before-crash', text: 'receipt persisted before crash', attachmentIds: [] }, 'agent');
    assert.equal(f.history.all().filter(message => message.role === 'system').length, 0);
    new RoomService(f.history, { read: async () => f.pi.read(), send: f.pi.send.bind(f.pi), abort: f.pi.abort.bind(f.pi), close: f.pi.close.bind(f.pi) }, f.voice, f.interaction, f.workspace, () => {}, () => {});
    assert.equal(f.history.all().filter(message => message.role === 'system').length, 1);
  } finally { await f.cleanup(); }
});
