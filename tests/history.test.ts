import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRoomHistory } from '../src/infrastructure/history/store';
import { CONTEXT_POLICY, piContextPolicy } from '../src/domains/conversation/history';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-history-'));
  const history = new FileRoomHistory(directory);
  const add = (id: string, text: string, session = 'pi-session', role: 'user' | 'assistant' = 'user') => history.append({ id, text, role, turnId: id, createdAt: '2026-10-18T10:00:00.000Z' }, session, session === 'voice-session' ? 'voice' : 'text');
  return { directory, history, add, cleanup: () => rmSync(directory, { force: true, recursive: true }) };
}

test('session files, bounded pages, idempotent updates, summaries and rebuildable room metadata survive restart', async () => {
  const f = fixture();
  try {
    f.add('one', '蓝鲸 project'); f.add('one', '蓝鲸 project'); f.add('two', '记住啦', 'voice-session', 'assistant');
    f.add('three', 'another turn');
    const files = readdirSync(f.history.historyDirectory);
    assert.equal(files.length, 2);
    assert.equal(files.filter(file => file.includes('--qwen--')).length, 1);
    assert.equal(readFileSync(join(f.history.historyDirectory, files.find(file => file.includes('--pi--'))!), 'utf8').trim().split('\n').length, 2);
    const last = f.history.page(undefined, 2); assert.deepEqual(last.messages.map(message => message.id), ['two', 'three']);
    assert.deepEqual(f.history.page(last.nextCursor, 2).messages.map(message => message.id), ['one']);
    f.history.summary('pi-session', '蓝鲸摘要', 'compaction-id');
    const find = await f.history.searchHistory({ mode: 'files', pattern: '*--qwen--*.jsonl' }) as { matches: { file: string }[] };
    assert.equal(find.matches.length, 1); assert.match(find.matches[0].file, /--qwen--/);
    const content = await f.history.searchHistory({ mode: 'content', pattern: '蓝鲸' }) as { matches: { file: string; line: number; excerpt: string }[] };
    assert.equal(content.matches.length, 2); assert.ok(content.matches.every(match => match.line >= 1 && match.excerpt.includes('蓝鲸')));
    writeFileSync(join(f.history.directory, 'room.json'), '{torn');
    const restored = new FileRoomHistory(f.directory);
    assert.deepEqual(restored.all(), f.history.all()); assert.equal(restored.warnings.length, 1);
    assert.ok(readdirSync(f.history.directory).some(file => file.endsWith('.corrupt')));
    const scope = new FileRoomHistory(f.directory, 'another');
    assert.deepEqual((await scope.searchHistory({ mode: 'content', pattern: '蓝鲸' }) as { matches: unknown[] }).matches, []);
  } finally { f.cleanup(); }
});

test('history tools cap UTF-8 JSON output, resume within long lines and deny path/symlink escapes', async () => {
  const f = fixture();
  try {
    f.add('long', '鲸🐳"\\'.repeat(14000));
    const file = readdirSync(f.history.historyDirectory)[0];
    let cursor: string | undefined, text = '', pages = 0;
    do {
      const result = await f.history.readHistory({ file, cursor });
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768, 'serialized tool result must respect byte budget');
      text += result.lines.map(line => line.text).join(''); cursor = result.nextCursor; pages++;
    } while (cursor && pages < 100);
    assert.ok(pages > 2); assert.equal(text, readFileSync(join(f.history.historyDirectory, file), 'utf8').trim());
    assert.ok(Buffer.byteLength(JSON.stringify(f.history.context().messages)) <= CONTEXT_POLICY.recentBytes);
    assert.ok(f.history.context().messages[0].text.includes('截断'));
    await assert.rejects(f.history.readHistory({ file: '../room.json' }), /不属于/);
    await assert.rejects(f.history.readHistory({ file, cursor: '-1:0' }), /游标/);
    await assert.rejects(f.history.searchHistory({ mode: 'content', pattern: '(', literal: false }), /正则/);
    await assert.rejects(f.history.searchHistory({ mode: 'files', pattern: '../*' }), /文件名/);
    const privatePath = join(f.directory, 'private.jsonl'); writeFileSync(privatePath, 'secret');
    symlinkSync(privatePath, join(f.history.historyDirectory, 'escape.jsonl'));
    await assert.rejects(f.history.readHistory({ file: 'escape.jsonl' }), /路径无效/);
    await assert.rejects(f.history.searchHistory({ mode: 'content', pattern: 'secret' }), /路径无效/);
  } finally { f.cleanup(); }
});

test('torn JSONL records preserve readable messages and future writes start a recovered segment', () => {
  const f = fixture();
  try {
    f.add('one', 'safe'); const file = readdirSync(f.history.historyDirectory)[0];
    appendFileSync(join(f.history.historyDirectory, file), '{torn');
    const original = readFileSync(join(f.history.historyDirectory, file), 'utf8');
    const restored = new FileRoomHistory(f.directory); assert.equal(restored.all().length, 1);
    restored.append({ id: 'two', role: 'user', text: 'after recovery', createdAt: new Date().toISOString() }, 'pi-session', 'text');
    assert.equal(readFileSync(join(f.history.historyDirectory, file), 'utf8'), original);
    assert.equal(new FileRoomHistory(f.directory).all().length, 2);
    assert.equal(piContextPolicy(1_000_000).contextWindow, 262144);
    assert.deepEqual(piContextPolicy(8192), { contextWindow: 8192, reserveTokens: 2048, keepRecentTokens: 3072 });
  } finally { f.cleanup(); }
});

test('unfinished tool events become interrupted after restart without changing their sequence or replaying them', () => {
  const f = fixture();
  try {
    f.add('user', '查询任务');
    const running = f.history.append({ id: 'tool-call', role: 'tool', text: '', status: 'running',
      tool: { name: 'list_tasks', input: '{}' }, turnId: 'user', createdAt: '2026-10-18T10:00:01.000Z' }, 'pi-session', 'text');
    const restored = new FileRoomHistory(f.directory);
    const interrupted = restored.all().at(-1)!;
    assert.deepEqual(interrupted, { ...running, status: 'interrupted' });
    assert.deepEqual(restored.context().messages.map(message => message.id), ['user']);
    assert.deepEqual(new FileRoomHistory(f.directory).all(), restored.all());
    assert.deepEqual(restored.warnings, []);
  } finally { f.cleanup(); }
});
