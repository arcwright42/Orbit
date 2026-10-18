import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PiSession } from '../src/infrastructure/pi/session';
import { InteractionService, INTERACTION_PROMPT, INTERACTION_TOOLS } from '../src/application/interaction';
import { WorkspaceService } from '../src/application/workspace';
import { MaterialLibrary } from '../src/domains/materials/library';
import { openDatabase } from '../src/infrastructure/database';
import type { Conversation } from '../src/contracts';
import { createModelServer } from './fixtures/model-server';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-pi-test-'));
  const db = openDatabase(join(directory, 'orbit.sqlite'));
  const workspace = new WorkspaceService(db, new MaterialLibrary(db, join(directory, 'attachments')));
  const business = new InteractionService(workspace);
  const server = await createModelServer();
  const events: Conversation[] = [];
  const setup = { directory: join(directory, 'agent'), systemPrompt: INTERACTION_PROMPT, tools: INTERACTION_TOOLS };
  const open = () => PiSession.open(setup, (name, args, context) => business.execute(name, args, context), state => events.push(state), server.env);
  const agent = await open();
  return { directory, db, workspace, business, server, events, agent, open, async cleanup() {
    await agent.close(); await server.close(); db.close(); rmSync(directory, { recursive: true, force: true });
  } };
}

test('real Pi SDK streams chat, restricts tools, persists context and deduplicates business requests', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    assert.equal(f.agent.read().configured, true, f.agent.read().error);
    const greeting = f.business.prepare({ requestId: 'greeting-1234', text: '你好', attachmentIds: [] });
    await f.agent.send(greeting);
    assert.equal(f.workspace.snapshot().tasks.length, 0);
    assert.equal(f.agent.read().messages.length, 2);
    assert.ok(f.events.some(event => event.draft.length > 0));
    assert.equal(f.agent.read().error, undefined);
    const filePath = join(f.directory, 'brief.md'); writeFileSync(filePath, 'PRIVATE FILE CONTENT');
    const file = await f.workspace.materials.importFile(filePath);
    const input = f.business.prepare({ requestId: 'request-1234', text: '保存网站需求，重复调用', attachmentIds: [file.id] });
    await f.agent.send(input); await f.agent.send(input);
    assert.equal(f.workspace.snapshot().tasks.length, 1);
    assert.equal(f.workspace.snapshot().messages.length, 1); // business receipt only; Pi owns conversation
    assert.deepEqual(f.workspace.snapshot().tasks[0].attachmentIds, [file.id]);
    assert.equal(f.workspace.snapshot().tasks[0].status, 'pending');
    assert.equal(f.workspace.snapshot().tasks[0].brief, input.text);
    await assert.rejects(f.agent.send({ ...input, text: 'different' }), /其他内容/);
    assert.ok(f.server.requests.every(request => request.tools?.map(tool => tool.function.name).sort().join(',') === INTERACTION_TOOLS.map(tool => tool.name).sort().join(',')));
    assert.ok(!JSON.stringify(f.server.requests).includes('PRIVATE FILE CONTENT'));
    const before = f.agent.read(); await f.agent.close();
    const restarted = await f.open();
    try {
      assert.equal(restarted.read().sessionId, before.sessionId);
      assert.deepEqual(restarted.read().messages, before.messages);
      await restarted.send(input);
      assert.equal(f.workspace.snapshot().tasks.length, 1);
      await restarted.send(f.business.prepare({ requestId: 'followup-1234', text: '你好，继续上一轮', attachmentIds: [] }));
      assert.ok(JSON.stringify(f.server.requests.at(-1)?.messages).includes('保存网站需求'));
    } finally { await restarted.close(); }
  } finally { await f.cleanup(); }
});

test('abort and provider failures settle; unsupported execution tools never reach the business layer', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const slow = f.agent.send(f.business.prepare({ requestId: 'slow-request', text: '慢回复', attachmentIds: [] }));
    for (let i = 0; i < 100 && !f.agent.read().draft; i++) await delay(20);
    assert.ok(f.agent.read().draft);
    await assert.rejects(f.agent.send(f.business.prepare({ requestId: 'busy-request', text: '你好', attachmentIds: [] })), /当前回复/);
    await f.agent.abort(); await slow;
    assert.equal(f.agent.read().status, 'idle'); assert.match(f.agent.read().error!, /停止/);
    await f.agent.send(f.business.prepare({ requestId: 'error-request', text: '模拟失败', attachmentIds: [] }));
    assert.equal(f.agent.read().status, 'idle'); assert.match(f.agent.read().error!, /失败/);
    await f.agent.send(f.business.prepare({ requestId: 'forbidden-request', text: '越权工具', attachmentIds: [] }));
    assert.equal(f.workspace.snapshot().tasks.length, 0);
    assert.ok(JSON.stringify(f.server.requests.at(-1)).includes('not found'));
    await f.agent.send(f.business.prepare({ requestId: 'recovery-request', text: '你好', attachmentIds: [] }));
    assert.equal(f.agent.read().error, undefined);
    const beforeEarlyAbort = f.agent.read().messages;
    const early = f.agent.send(f.business.prepare({ requestId: 'early-abort-request', text: '慢回复', attachmentIds: [] }));
    const rejected = assert.rejects(early, /输入尚未发送/);
    await f.agent.abort(); await rejected;
    assert.equal(f.agent.read().status, 'idle');
    assert.deepEqual(f.agent.read().messages, beforeEarlyAbort);
  } finally { await f.cleanup(); }
});

test('business tools reject unrelated attachments and unconfigured sessions preserve input', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.business.prepare({ requestId: 'invalid-file', text: 'hello', attachmentIds: ['missing'] }), /附件不存在/);
    assert.throws(() => f.business.execute('save_request', { text: '保存', attachmentIds: ['unrelated'] }, {
      sessionId: 'session', requestId: 'turn', attachmentIds: [], currentAttachmentIds: [],
    }), /只能关联/);
    const unconfigured = await PiSession.open({ directory: join(f.directory, 'unconfigured'), systemPrompt: INTERACTION_PROMPT, tools: INTERACTION_TOOLS }, () => {}, () => {}, {});
    try {
      assert.equal(unconfigured.read().configured, false);
      await assert.rejects(unconfigured.send(f.business.prepare({ requestId: 'unconfigured', text: 'hello', attachmentIds: [] })), /配置/);
      assert.equal(unconfigured.read().messages.length, 0);
    } finally { await unconfigured.close(); }
  } finally { await f.cleanup(); }
});
