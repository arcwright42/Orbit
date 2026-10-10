import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../src/infrastructure/database';
import { TextModelStore } from '../src/domains/models/settings';
import { WorkspaceService } from '../src/application/workspace';
import { MaterialLibrary } from '../src/domains/materials/library';
import { TextAgent } from '../src/domains/conversation/text-agent';
import type { ChatEvent } from '../src/contracts';
import { platformTools } from '../src/application/platform-tools';
import type { TaskExecutionService } from '../src/application/task-execution';

const codec = { encrypt: (value: string) => Buffer.from(value).toString('base64'), decrypt: (value: string) => Buffer.from(value, 'base64').toString() };
test('local text settings never expose secrets, retain keys only for the same endpoint, and persist independently of voice', () => {
  const db = openDatabase(':memory:'); const store = new TextModelStore(db, codec);
  try {
    assert.throws(() => store.resolve(), /文本模型/);
    const input = { protocol: 'openai-completions' as const, baseUrl: 'https://text.example/v1', model: 'text-model', apiKey: 'test-text-secret' };
    const visible = store.save(input);
    assert.equal(visible.hasKey, true); assert.ok(!JSON.stringify(visible).includes(input.apiKey));
    assert.equal(new TextModelStore(db, codec).resolve().apiKey, input.apiKey);
    store.save({ ...input, model: 'other', apiKey: undefined });
    assert.equal(store.resolve().apiKey, input.apiKey);
    store.save({ ...input, baseUrl: 'https://another.example/v1', apiKey: undefined });
    assert.equal(store.public().hasKey, false);
    store.save(input); store.save({ ...input, apiKey: undefined, clearKey: true });
    assert.equal(store.resolve().apiKey, '');
    assert.throws(() => store.save({ ...input, baseUrl: 'http://remote.example/v1' }), /HTTPS/);
    assert.throws(() => store.save({ ...input, baseUrl: 'https://user:pass@remote.example/v1' }), /HTTPS/);
    assert.throws(() => store.save({ ...input, baseUrl: 'https://remote.example/v1?key=secret' }), /HTTPS/);
  } finally { db.close(); }
});

test('actual Pi harness calls platform tools, consumes results, streams text and restores complete tool history', async () => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ body: JSON.parse(body), path: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = requests.length === 1 ? { tool_calls: [{ index: 0, id: 'call-list', type: 'function', function: { name: 'list_tasks', arguments: '{}' } }] } : { content: '共有一个待派发任务。' };
    res.write('data: ' + JSON.stringify({ id: 'test-' + requests.length, object: 'chat.completion.chunk', model: 'test-text', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ id: 'test-' + requests.length, choices: [{ index: 0, delta: {}, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const db = openDatabase(':memory:'), store = new TextModelStore(db, codec);
  store.save({ protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'test-text', apiKey: 'text-only-key' });
  const workspace = new WorkspaceService(db, new MaterialLibrary(db, '/unused'));
  workspace.recordInteraction('user', '语音需求：准备周五的产品发布计划，预算两千元。', 'voice');
  workspace.recordInteraction('assistant', '已记下周五发布和两千元预算，等你补充目标。', 'voice');
  const sharedHistory = () => JSON.stringify(workspace.snapshot().messages.filter(m => m.channel !== 'text'));
  const events: ChatEvent[] = [], records: string[] = [], tools: string[] = [];
  const makeAgent = () => new TextAgent(db, store, name => { tools.push(name); return [{ id: 'one', status: 'pending' }]; }, e => events.push(e), (role, text) => { records.push(text); workspace.recordInteraction(role, text, 'text'); }, sharedHistory);
  const first = makeAgent();
  try {
    await first.send('查询任务');
    assert.equal(workspace.snapshot().messages.filter(m => m.channel === 'voice').length, 2);
    assert.equal(events.some(e => e.type === 'error'), false, JSON.stringify(events));
    assert.deepEqual(tools, ['list_tasks']); assert.equal(requests.length, 2);
    assert.ok(JSON.stringify(requests[0].body.messages).includes('预算两千元'));
    assert.ok(JSON.stringify(requests[0].body.messages).includes('等你补充目标'));
    assert.equal(requests[0].path, '/v1/chat/completions');
    assert.equal(requests[0].authorization, 'Bearer text-only-key');
    assert.equal(requests[0].body.model, 'test-text');
    assert.ok(requests[1].body.messages.some((m: any) => m.role === 'tool' && m.content.includes('pending')));
    assert.deepEqual(requests[0].body.tools.map((t: any) => t.function.name).sort(), ['search_history', 'read_history', 'list_tasks', 'save_request', 'list_teams', 'create_team', 'dispatch_task', 'get_task_execution', 'answer_task', 'cancel_task', 'retry_task', 'configure_team_context', 'accept_task', 'revise_task', 'approve_task_step', 'rotate_task_session', 'search_team_memory', 'list_team_templates', 'get_team_template', 'get_team', 'save_team_template'].sort());
    assert.ok(records.includes('共有一个待派发任务。'));
    assert.ok(events.some(e => e.type === 'delta'));
    workspace.recordInteraction('user', '补充语音：发布目标是桌面客户端。', 'voice');
    await makeAgent().send('继续');
    assert.ok(JSON.stringify(requests[2].body.messages).includes('发布目标是桌面客户端'));
    assert.ok(JSON.stringify(requests[2].body.messages).includes('预算两千元'));
    assert.ok(requests[2].body.messages.some((m: any) => m.role === 'tool'));
    assert.ok(requests[2].body.messages.some((m: any) => m.role === 'user' && JSON.stringify(m.content).includes('查询任务')));
    assert.equal(first.busy, false);
  } finally { await first.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close(); }
});

test('text cancellation aborts a pending provider request and releases the foreground without running tools', async () => {
  let arrived!: () => void; const ready = new Promise<void>(r => { arrived = r; });
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); arrived(); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const db = openDatabase(':memory:'), store = new TextModelStore(db, codec);
  store.save({ protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1', model: 'test' });
  let calls = 0;
  const agent = new TextAgent(db, store, () => { calls++; }, () => {}, () => {}, () => '');
  try {
    const run = agent.send('hello'); await ready;
    await assert.rejects(agent.send('second'), /正在进行/);
    await agent.stop(); await run;
    assert.equal(agent.busy, false); assert.equal(calls, 0);
  } finally { await agent.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close(); }
});

test('native Pi threshold compaction persists a summary and raw history, then restores the compacted session', async () => {
  const requests: any[] = [];
  let recalling=false,recallStep=0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; requests.push(JSON.parse(body));
    const summarizing=JSON.stringify(requests.at(-1).messages).includes('context summarization assistant');
    const text = summarizing ? '## Goal\n保留原始预算约束：两千元。\n## Next Steps\n继续产品发布计划。' : '继续沿用两千元预算。';
    let delta:unknown={content:text},finish='stop';
    if(recalling && !summarizing && recallStep<2) {
      const name=recallStep===0 ? 'search_history' : 'read_history';
      const result=recallStep===1 ? JSON.parse(requests.at(-1).messages.findLast((m:any)=>m.role==='tool').content) : undefined;
      const args=recallStep===0 ? {query:'海棠厅'} : {message_id:result.matches[0].message_id,before:0,after:0};
      delta={tool_calls:[{index:0,id:'recall-'+recallStep++,type:'function',function:{name,arguments:JSON.stringify(args)}}]};finish='tool_calls';
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 'compact', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ id: 'compact', choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const db = openDatabase(':memory:'), store = new TextModelStore(db, codec);
  const workspace=new WorkspaceService(db,new MaterialLibrary(db,'/unused'));
  workspace.recordInteraction('user','最早的语音补充：发布会地点是海棠厅。','voice');
  const execute=platformTools(workspace,{} as TaskExecutionService,()=>{});
  store.save({ protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1', model: 'compact-test' });
  const legacy = Array.from({ length: 16 }, (_, i) => ({ role: 'user', content: (i === 0 ? '原始预算两千元。' : '补充需求。') + 'history '.repeat(250), timestamp: i }));
  db.prepare('INSERT INTO settings VALUES (?,?)').run('textTranscript', JSON.stringify(legacy));
  const events: ChatEvent[] = [];
  const create = () => new TextAgent(db, store, execute, e => events.push(e), (role,text,sessionId)=>workspace.recordInteraction(role,text,'text',sessionId), () => '', { contextWindow: 8192, reserveTokens: 4096, keepRecentTokens: 512 });
  const agent = create();
  try {
    await agent.send('请继续');
    assert.ok(events.some(e => e.type === 'compaction' && e.active), JSON.stringify(events));
    assert.equal(events.some(e => e.type === 'error'), false, JSON.stringify(events));
    const entries = JSON.parse(String(db.prepare('SELECT value FROM settings WHERE key=?').get('piSessionEntries')!.value));
    const compaction = entries.find((e: any) => e.type === 'compaction');
    assert.ok(compaction); assert.ok(compaction.summary.includes('两千元'));
    assert.ok(entries.some((e: any) => e.type === 'message' && JSON.stringify(e.message).includes('原始预算两千元')));
    const header = entries.find((e: any) => e.type === 'session').id;
    recalling=true; await create().send('重启后继续：查一下会场原话');
    assert.equal(recallStep,2);assert.equal(events.some(e=>e.type==='error'),false,JSON.stringify(events));
    assert.ok(requests.at(-1).messages.some((m:any)=>m.role==='tool' && m.content.includes('最早的语音补充')));
    const restored = JSON.parse(String(db.prepare('SELECT value FROM settings WHERE key=?').get('piSessionEntries')!.value));
    assert.ok(!JSON.stringify(requests.at(-1).messages).includes('原始预算两千元。'));
    assert.ok(requests.at(-1).messages.length < legacy.length);
    assert.equal(restored.find((e: any) => e.type === 'session').id, header);
    assert.ok(restored.some((e: any) => e.type === 'compaction' && e.id === compaction.id));
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('两千元'));
  } finally { await agent.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close(); }
});

test('failed native compaction leaves the original persisted history without a replacement summary', async () => {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 'incomplete', choices: [{ index: 0, delta: { content: 'incomplete summary' }, finish_reason: 'length' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const db = openDatabase(':memory:'), store = new TextModelStore(db, codec);
  store.save({ protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1', model: 'compact-fail' });
  const legacy = Array.from({ length: 16 }, (_, i) => ({ role: 'user', content: 'original-' + i + ' history'.repeat(250), timestamp: i }));
  db.prepare('INSERT INTO settings VALUES (?,?)').run('textTranscript', JSON.stringify(legacy));
  const events: ChatEvent[] = [];
  const agent = new TextAgent(db, store, () => ({}), e => events.push(e), () => {}, () => '', { contextWindow: 8192, reserveTokens: 4096, keepRecentTokens: 512 });
  try {
    await agent.send('continue');
    assert.ok(events.some(e => e.type === 'error'));
    const entries = JSON.parse(String(db.prepare('SELECT value FROM settings WHERE key=?').get('piSessionEntries')!.value));
    assert.ok(!entries.some((e: any) => e.type === 'compaction'));
    for (let i = 0; i < 16; i++) assert.ok(entries.some((e: any) => e.type === 'message' && JSON.stringify(e.message).includes('original-' + i)));
  } finally { await agent.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close(); }
});
