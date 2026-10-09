import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/infrastructure/database';
import { MaterialLibrary } from '../src/domains/materials/library';
import { WorkspaceService } from '../src/application/workspace';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-test-'));
  const path = join(directory, 'orbit.sqlite');
  const db = openDatabase(path);
  const materials = new MaterialLibrary(db, join(directory, 'attachments'));
  const service = new WorkspaceService(db, materials);
  return { directory, path, db, materials, service, cleanup: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('request retries are idempotent, differing payloads rejected, and intake never implies execution', () => {
  const f = fixture();
  try {
    const input = { requestId: 'request-1234', text: '制作一个网站', attachmentIds: [] };
    f.service.submit(input); f.service.submit(input);
    const data = f.service.snapshot();
    assert.equal(data.tasks.length, 1);
    assert.equal(data.messages.length, 2);
    assert.equal(data.tasks[0].status, 'pending');
    assert.equal(data.messages[1].role, 'system');
    assert.match(data.messages[1].text, /尚未派发/);
    assert.throws(() => f.service.submit({ ...input, text: '其他请求' }), /其他内容/);
    assert.equal(f.service.snapshot().tasks.length, 1);
  } finally { f.cleanup(); }
});

test('invalid attachment rolls back the entire intake; independent task cancellation preserves others', () => {
  const f = fixture();
  try {
    assert.throws(() => f.service.submit({ requestId: 'request-bad', text: 'hello', attachmentIds: ['missing'] }), /附件不存在/);
    assert.equal(f.service.snapshot().tasks.length, 0);
    assert.equal(f.service.snapshot().messages.length, 0);
    const first = f.service.submit({ requestId: 'request-one', text: 'first', attachmentIds: [] }).tasks[0];
    const second = f.service.submit({ requestId: 'request-two', text: 'second', attachmentIds: [] }).tasks[0];
    f.service.cancelTask(first.id); f.service.cancelTask(first.id);
    assert.equal(f.service.snapshot().tasks.find(task => task.id === second.id)?.status, 'pending');
    assert.equal(f.service.snapshot().tasks.find(task => task.id === first.id)?.status, 'canceled');
    assert.throws(() => f.service.submit({ requestId: 'request-empty', text: '  ', attachmentIds: [] }), /输入需求/);
  } finally { f.cleanup(); }
});

test('attachments are copied, records and settings survive restart', async () => {
  const f = fixture();
  try {
    const original = join(f.directory, 'brief.md');
    writeFileSync(original, '# user brief');
    const file = await f.materials.importFile(original);
    writeFileSync(original, 'changed');
    assert.equal(readFileSync(f.materials.require(file.id).path, 'utf8'), '# user brief');
    f.service.submit({ requestId: 'request-file', text: '请查看资料', attachmentIds: [file.id] });
    f.service.saveConnection('http://127.0.0.1:7444');
    const anotherDb = openDatabase(f.path);
    try {
      const restarted = new WorkspaceService(anotherDb, new MaterialLibrary(anotherDb, join(f.directory, 'attachments')));
      assert.deepEqual(restarted.snapshot(), f.service.snapshot());
    } finally { anotherDb.close(); }
  } finally { f.cleanup(); }
});
