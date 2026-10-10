import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/infrastructure/database';
import { WorkspaceService } from '../src/application/workspace';
import { MaterialLibrary } from '../src/domains/materials/library';
import { platformTools } from '../src/application/platform-tools';
import type { TaskExecutionService } from '../src/application/task-execution';

test('shared history tools find old voice facts after text switches, with stable cursors across restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-history-')), path = join(root, 'history.sqlite');
  let db = openDatabase(path);
  const make = () => new WorkspaceService(db, new MaterialLibrary(db, root));
  let workspace = make(), execute = platformTools(workspace, {} as TaskExecutionService, () => {});
  try {
    workspace.recordInteraction('user', '上个月讨论过电动车，通勤预算两万元。', 'voice');
    workspace.recordInteraction('assistant', '记住了这次讨论，候选是车型A。', 'voice');
    for (let i = 0; i < 150; i++) workspace.recordInteraction('user', `新话题 ${i}`, 'text');
    const hits = await execute('search_history', { query: '电动车 通勤', limit: 10 }, 'search') as any;
    assert.equal(hits.matches.length, 1);
    assert.equal(hits.matches[0].channel, 'voice');
    const around = await execute('read_history', { message_id: hits.matches[0].message_id, before: 0, after: 1 }, 'read') as any;
    assert.deepEqual(around.messages.map((m: any) => m.text), ['上个月讨论过电动车，通勤预算两万元。', '记住了这次讨论，候选是车型A。']);
    const cursor = around.next_cursor;
    db.close(); db = openDatabase(path); workspace = make(); execute = platformTools(workspace, {} as TaskExecutionService, () => {});
    const page = await execute('read_history', { cursor, limit: 2 }, 'page') as any;
    assert.equal(page.room_id, hits.room_id);
    assert.deepEqual(page.messages.map((m: any) => m.text), ['新话题 0', '新话题 1']);
    assert.ok(page.messages[0].sequence > around.messages[1].sequence);
    const short = await execute('search_history', { query: '预算' }, 'short') as any;
    assert.equal(short.matches.length, 1, 'two-character Chinese queries must also work');
    await assert.rejects(Promise.resolve().then(() => execute('read_history', { room_id: 'foreign-room' }, 'scope')), /room/);
    await assert.rejects(Promise.resolve().then(() => execute('read_history', { cursor: -1 }, 'invalid')), /cursor/);
    assert.equal((await execute('search_history', { query: '" OR *' }, 'literal') as any).matches.length, 0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('history migration is idempotent and raw messages remain fully readable, including long originals', async () => {
  const db = openDatabase(':memory:');
  db.exec('CREATE TABLE interactions (id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
  db.prepare('INSERT INTO interactions VALUES (?,?)').run('legacy-message', JSON.stringify({ id: 'legacy-message', role: 'user', channel: 'voice', text: '旧版语音需求', createdAt: '2026-09-01T00:00:00Z' }));
  try {
    const workspace = new WorkspaceService(db, new MaterialLibrary(db, '/unused'));
    new WorkspaceService(db, new MaterialLibrary(db, '/unused'));
    const execute = platformTools(workspace, {} as TaskExecutionService, () => {});
    assert.equal((await execute('search_history', { query: '旧版语音' }, 'migration') as any).matches.length, 1);
    const original = '长消息标记' + '完整原文。'.repeat(16000);
    workspace.recordInteraction('user', original, 'text');
    const found = (await execute('search_history', { query: '长消息标记' }, 'large') as any).matches[0];
    let reconstructed = '', offset = 0;
    do {
      const page = await execute('read_history', { message_id: found.message_id, before: 0, after: 0, text_offset: offset }, 'long-' + offset) as any;
      const message = page.messages[0]; reconstructed += message.text; offset = message.next_text_offset;
    } while (offset !== undefined);
    assert.equal(reconstructed, original);
    assert.equal(workspace.snapshot().messages.at(-1)!.text, original);
    const request = { requestId: 'history-task', text: '保存为测试任务', attachmentIds: [] };
    workspace.submit(request); workspace.submit(request);
    assert.equal((await execute('search_history', { query: request.text }, 'task') as any).matches.filter((m: any) => m.role === 'user').length, 1);
    await execute('list_tasks', {}, 'text:session-A:tool-one');
    const tools=(await execute('search_history', {query:'list_tasks',include_tools:true}, 'tool-search') as any).matches;
    assert.equal(tools[0].role,'tool');
    const originalTool=(await execute('read_history',{message_id:tools[0].message_id,before:0,after:0},'tool-read') as any).messages[0];
    assert.equal(originalTool.session_id,'session-A');assert.equal(JSON.parse(originalTool.text).name,'list_tasks');
    assert.equal((await execute('search_history',{query:'list_tasks'},'no-echo') as any).matches.length,0,'retrieval must not echo previous tool results as primary user statements');
  } finally { db.close(); }
});
