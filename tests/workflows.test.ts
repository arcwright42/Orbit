import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/infrastructure/database';
import { TaskExecutionService } from '../src/application/task-execution';
import { WorkspaceService } from '../src/application/workspace';
import { MaterialLibrary } from '../src/domains/materials/library';
import { defaultTeamConfig, validateTeamConfig, type TeamConfig } from '../src/domains/workflows/spec';
import type { ExecutionPort } from '../src/domains/runtime/execution-port';
import type { Seat } from '../src/domains/teams/registry';
import type { QueueItem } from '../src/domains/orchestration/types';

async function setup(factory: (seat: Seat) => ExecutionPort, config: TeamConfig = defaultTeamConfig) {
  const root = await mkdtemp(join(tmpdir(), 'orbit-workflows-')), db = openDatabase(join(root, 'orbit.sqlite'));
  const materials = new MaterialLibrary(db, join(root, 'files')), workspace = new WorkspaceService(db, materials);
  const service = new TaskExecutionService(db, materials, root, () => {}, undefined, factory);
  const team = service.createTeam('团队', config);
  const task = (requestId = crypto.randomUUID()) => workspace.submit({ requestId, text: '完成项目任务', attachmentIds: [] }).tasks.find(t => t.requestId === requestId)!;
  return { root, db, materials, service, team, task, workspace, async close() { await service.close(); db.close(); await rm(root, { recursive: true, force: true }); } };
}
async function until(fn: () => Promise<boolean>) { for (let i = 0; i < 150; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('condition timeout'); }
async function completed(seat: Seat, item: QueueItem, extra = {}) { const evidenceRef = join(seat.workspace, `${item.id}-${item.generation}.json`); await writeFile(evidenceRef, JSON.stringify({ summary: '已验证', artifacts: [], verdict: 'pass', recap: '# 决策\n使用已验证方案，因为测试满足需求。', lessons: '项目测试使用 npm test', ...extra })); return { kind: 'completed' as const, summary: '已验证', evidenceRef }; }

test('review rejection returns to author; team experience is sourced, versioned and survives task isolation', async () => {
  const calls: string[] = []; let reviews = 0;
  const env = await setup(seat => ({ execute: item => { calls.push(seat.role); return completed(seat, item, { verdict: seat.role === 'reviewer' && reviews++ === 0 ? 'changes_requested' : 'pass' }); }, async cancel() { return true; } }));
  try {
    const task = env.task(); await env.service.dispatch(task.id, env.team.id);
    await until(async () => { await env.service.sync(); return env.workspace.snapshot().tasks[0].status === 'review'; });
    assert.deepEqual(calls, ['builder','reviewer','builder','reviewer']);
    const memories = env.service.memory.list({ kind: 'team', id: env.team.id }); assert.equal(memories.length, 4); assert.ok(memories.every(m => m.sourceRef.endsWith('.evidence.json') || m.sourceRef.endsWith('.json')));
    const seat = env.service.teams.taskSeats(env.team.id, task.id)[0], root = env.service.teams.seatRoot(seat);
    assert.equal((await readdir(join(root, 'recap-superseded'))).length, 2); assert.match(await readFile(join(root, 'RECAP.md'), 'utf8'), /因为测试/);
    const next = env.task(); const nextSeat = env.service.teams.taskSeats(env.team.id, next.id)[0]; assert.equal(env.service.teams.seatRoot(nextSeat), root); assert.notEqual(nextSeat.sessionId, seat.sessionId);
    const other = env.service.createTeam('other'); assert.equal(env.service.memory.list({ kind: 'team', id: other.id }).length, 0);
  } finally { await env.close(); }
});

test('custom roles execute parallel dependency branches and join only after both finish', async () => {
  const config: TeamConfig = { members: ['research','design','merge'].map(role => ({ role, name: role, instructions: role })), edges: [], workflow: { entry: 'research', max_hops: 10, steps: [
    { id: 'research', actor_role: 'research', objective: 'research', depends_on: [] }, { id: 'design', actor_role: 'design', objective: 'design', depends_on: [] }, { id: 'merge', actor_role: 'merge', objective: 'merge', depends_on: ['research','design'] },
  ] } };
  const started: string[] = []; let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const env = await setup(seat => ({ async execute(item) { started.push(seat.role); if (seat.role === 'design') await gate; return completed(seat, item); }, async cancel() { release(); return true; } }), config);
  try {
    const task = env.task(); await env.service.dispatch(task.id, env.team.id);
    await until(async () => { await env.service.sync(); return started.includes('research') && started.includes('design'); });
    assert.ok(!started.includes('merge')); release();
    await until(async () => { await env.service.sync(); return env.workspace.snapshot().tasks[0].status === 'review'; });
    assert.deepEqual(started.sort(), ['design','merge','research']);
  } finally { release(); await env.close(); }
});

test('real scheduler follows handoff through declared edge and rejects undeclared targets', async () => {
  const config: TeamConfig = { members: ['author','expert'].map(role => ({ role, name: role, instructions: role })), edges: [{ from: 'author', to: 'expert' }], workflow: { entry: 'produce', max_hops: 5, steps: [{ id: 'produce', actor_role: 'author', objective: 'produce' }] } };
  let env: Awaited<ReturnType<typeof setup>>; const calls: string[] = [];
  env = await setup(seat => ({ async execute(item) { calls.push(seat.role); if (seat.role === 'author') return { kind: 'handoff', destination: env.service.teams.taskSeats(seat.teamId, item.taskId).find(s => s.role === 'expert')!.sessionId, body: item.body, reason: '请专家完成' }; return completed(seat, item); }, async cancel() { return true; } }), config);
  try { const task = env.task(); await env.service.dispatch(task.id, env.team.id); await until(async () => { await env.service.sync(); return env.workspace.snapshot().tasks[0].status === 'review'; }); assert.deepEqual(calls, ['author','expert']); assert.ok(env.service.queue.list().some(i => i.state === 'handed-off')); }
  finally { await env.close(); }
});

test('human gate cannot be bypassed by answering/retry and specified workspace is used', async () => {
  const config = structuredClone(defaultTeamConfig); config.workflow.steps[0].gate = { target: 'human:user', summary: '允许修改项目吗？' }; let calls = 0;
  const env = await setup(seat => ({ async execute(item) { calls++; return completed(seat, item); }, async cancel() { return true; } }), config);
  try {
    const project = join(env.root, 'existing-project'); await mkdir(project); await writeFile(join(project, 'existing.txt'), 'keep');
    const task = env.task(); await env.service.dispatch(task.id, env.team.id, project); await env.service.sync(); assert.equal(calls, 0);
    assert.throws(() => env.service.answer(task.id, 'hello')); assert.throws(() => env.service.retry(task.id));
    assert.equal(env.service.detail(task.id)?.workspace, await realpath(project)); env.service.approve(task.id, '同意');
    await until(async () => { await env.service.sync(); return env.workspace.snapshot().tasks[0].status === 'review'; }); assert.equal(await readFile(join(project, 'existing.txt'), 'utf8'), 'keep');
  } finally { await env.close(); }
});

test('quit pauses queued work and restart requires explicit resume', async () => {
  const env = await setup(seat => ({ execute: item => completed(seat, item), async cancel() { return true; } }));
  let reopened: TaskExecutionService | undefined; let calls = 0;
  try {
    const task = env.task(); await env.service.dispatch(task.id, env.team.id);
    await env.service.close();
    reopened = new TaskExecutionService(env.db, env.materials, env.root, () => {}, undefined, seat => ({ async execute(item) { calls++; return completed(seat, item); }, async cancel() { return true; } }));
    await reopened.sync(); assert.equal(calls, 0); assert.equal(env.workspace.snapshot().tasks[0].status, 'blocked');
    reopened.retry(task.id); await until(async () => { await reopened!.sync(); return env.workspace.snapshot().tasks[0].status === 'review'; }); assert.ok(calls > 0);
  } finally { await reopened?.close(); await env.close(); }
});

test('configuration rejects unknown fields, dependency cycles and undeclared routing edges', () => {
  assert.throws(() => validateTeamConfig({ ...defaultTeamConfig, ignored: true }));
  const c = structuredClone(defaultTeamConfig); c.edges = []; assert.throws(() => validateTeamConfig(c));
  const d = structuredClone(defaultTeamConfig); d.workflow.steps[0].depends_on = ['reviewer']; d.workflow.steps[1].depends_on = ['builder']; assert.throws(() => validateTeamConfig(d));
});

test('missing review verdict fails rather than accepting or automatically looping', async () => {
  let count = 0;
  const env = await setup(seat => ({ execute: item => { count++; return completed(seat, item, { verdict: '' }); }, async cancel() { return true; } }));
  try { const task = env.task(); await env.service.dispatch(task.id, env.team.id); await until(async () => { await env.service.sync(); return env.workspace.snapshot().tasks[0].status === 'failed'; }); assert.equal(count, 2); assert.throws(() => env.service.accept(task.id)); }
  finally { await env.close(); }
});

test('handoff cycles are bounded before the scheduler launches an unbounded chain', async () => {
  const config: TeamConfig = { members: ['left','right'].map(role => ({ role, name: role, instructions: role })), edges: [{ from: 'left', to: 'right' }, { from: 'right', to: 'left' }], workflow: { entry: 'produce', max_hops: 3, steps: [{ id: 'produce', actor_role: 'left', objective: 'produce' }] } };
  let env: Awaited<ReturnType<typeof setup>>; let count = 0;
  env = await setup(seat => ({ async execute(item) { count++; return { kind: 'handoff', destination: env.service.teams.taskSeats(seat.teamId, item.taskId).find(s => s.role !== seat.role)!.sessionId, body: '接力', reason: '接力' }; }, async cancel() { return true; } }), config);
  try { const task = env.task(); await env.service.dispatch(task.id, env.team.id); await until(async () => { await env.service.sync(); return env.workspace.snapshot().tasks[0].status === 'failed'; }); assert.ok(count <= 4); }
  finally { await env.close(); }
});

test('foreground template discovery -> configuration -> team -> task uses shared application tools', async () => {
  const { platformTools } = await import('../src/application/platform-tools');
  const env = await setup(seat => ({ execute: item => completed(seat, item), async cancel() { return true; } }));
  try {
    const execute = platformTools(env.workspace, env.service, () => {});
    const list = await execute('list_team_templates', {}, 'list') as { id: string }[]; assert.ok(list.some(t => t.id === 'build-review'));
    const template = await execute('get_team_template', { templateId: 'build-review' }, 'get') as { config: TeamConfig };
    const saved = await execute('save_team_template', { templateId: 'my-team', name: '我的团队', description: '可复用流程', config: template.config, expectedRevision: 0 }, 'save') as { revision: number };
    assert.equal(saved.revision, 1);
    const team = await execute('create_team', { name: '实例', templateId: 'my-team' }, 'create') as { id: string };
    template.config.members[0].instructions = 'new template instructions';
    await execute('save_team_template', { templateId: 'my-team', name: '我的团队', description: 'v2', config: template.config, expectedRevision: 1 }, 'update');
    assert.notEqual(env.service.teams.require(team.id).config.members[0].instructions, template.config.members[0].instructions);
    await assert.rejects(() => execute('save_team_template', { templateId: 'my-team', name: '我的团队', description: '', config: template.config, expectedRevision: 1 }, 'stale') as Promise<unknown>);
    const request = await execute('save_request', { text: '测试模板实例', attachmentIds: [] }, 'request') as { task: { id: string } };
    assert.equal(env.service.queue.list().length, 0);
    await execute('dispatch_task', { taskId: request.task.id, teamId: team.id }, 'dispatch');
    await until(async () => { await env.service.sync(); return env.workspace.snapshot().tasks[0].status === 'review'; });
    await execute('accept_task', { taskId: request.task.id }, 'accept'); assert.equal(env.workspace.snapshot().tasks[0].status, 'completed');
  } finally { await env.close(); }
});

test('Codex adapter keeps full event evidence and recovers a settled generation without re-executing', async () => {
  const { CodexRuntime } = await import('../src/domains/runtime/codex');
  const { chmod } = await import('node:fs/promises');
  const env = await setup(() => ({ async execute() { return { kind: 'failed', reason: 'unused' }; }, async cancel() { return true; } }));
  try {
    const binary = join(env.root, 'codex-fixture');
    await writeFile(binary, `#!/usr/bin/env node\nconst fs = require('node:fs'); process.stdin.resume(); process.stdin.on('end', () => { console.log(JSON.stringify({type:'thread.started',thread_id:'native-test-123456'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'first message'}})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'second message'}})); fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1], JSON.stringify({outcome:'completed',summary:'verified',question:'',artifacts:[],verdict:'pass',recap:'decision',lessons:'lesson'})); });`); await chmod(binary, 0o700);
    const task = env.task(), seat = env.service.teams.taskSeats(env.team.id, task.id)[0];
    env.service.queue.setClaimGuard(() => true);
    env.service.queue.enqueue({ requestId: 'adapter-recovery', taskId: task.id, source: 'user', destination: seat.sessionId, body: 'verify' });
    const item = env.service.queue.claimNext([seat.sessionId], 1)!;
    const root = join(env.root, 'evidence'); const adapter = new CodexRuntime(env.service.teams, seat.sessionId, root, () => {}, undefined, binary);
    const result = await adapter.execute(item, new AbortController().signal); assert.equal(result.kind, 'completed');
    const events = await readFile(join(root, `${item.id}-${item.generation}.events.jsonl`), 'utf8'); assert.match(events, /first message/); assert.match(events, /second message/);
    assert.deepEqual(await adapter.reconcile(item), result);
    assert.equal(await adapter.reconcile({ ...item, generation: 'stale-generation' }), undefined);
    env.service.queue.recoverInterrupted(); env.service.queue.reconcileResult(item.id, item.generation!, result); assert.equal(env.service.queue.get(item.id).state, 'done');
  } finally { await env.close(); }
});

test('selected project cannot redirect task records outside its root through .orbit', async () => {
  const { symlink } = await import('node:fs/promises');
  const { taskDirectory } = await import('../src/domains/materials/workspace-files');
  const root = await mkdtemp(join(tmpdir(), 'orbit-workspace-boundary-'));
  try { const project = join(root, 'project'), outside = join(root, 'outside'); await mkdir(project); await mkdir(outside); await symlink(outside, join(project, '.orbit')); await assert.rejects(() => taskDirectory(project, 'task'), /越出/); assert.deepEqual(await readdir(outside), []); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('conditional route into a join waits for the other parallel dependency', async () => {
  const config: TeamConfig = { members: ['a','b','join'].map(role => ({ role,name:role,instructions:role })), edges: [{from:'a',to:'join'}], workflow: {entry:'a',max_hops:5,steps:[
    {id:'a',actor_role:'a',objective:'a',depends_on:[],next_hop:{on:{done:'join'}}},
    {id:'b',actor_role:'b',objective:'b',depends_on:[]}, {id:'join',actor_role:'join',objective:'join',depends_on:['a','b']},
  ]}};
  let release!: () => void; const gate = new Promise<void>(r => {release=r;}); const calls: string[]=[];
  const env=await setup(seat=>({async execute(item){calls.push(seat.role);if(seat.role==='b')await gate;return completed(seat,item);},async cancel(){release();return true;}}),config);
  try {const task=env.task();await env.service.dispatch(task.id,env.team.id);await until(async()=>{await env.service.sync();return env.service.queue.list().some(i=>i.state==='done');});assert.equal(env.workspace.snapshot().tasks[0].status,'running');assert.ok(!calls.includes('join'));release();await until(async()=>{await env.service.sync();return env.workspace.snapshot().tasks[0].status==='review';});assert.equal(calls.filter(r=>r==='join').length,1);}
  finally {release();await env.close();}
});

test('three handoffs allow A -> B -> C -> D independently of projection polling', async () => {
  const roles=['a','b','c','d']; const config:TeamConfig={members:roles.map(role=>({role,name:role,instructions:role})),edges:roles.slice(0,-1).map((r,i)=>({from:r,to:roles[i+1]})),workflow:{entry:'a',max_hops:3,steps:[{id:'a',actor_role:'a',objective:'a'}]}};
  let env:Awaited<ReturnType<typeof setup>>;const calls:string[]=[];
  env=await setup(seat=>({async execute(item){calls.push(seat.role);await env.service.sync();if(seat.role!=='d')return {kind:'handoff',destination:env.service.teams.taskSeats(seat.teamId,item.taskId).find(s=>s.role===roles[roles.indexOf(seat.role)+1])!.sessionId,body:'continue',reason:'handoff'};return completed(seat,item);},async cancel(){return true;}}),config);
  try{const task=env.task();await env.service.dispatch(task.id,env.team.id);await until(async()=>{await env.service.sync();return env.workspace.snapshot().tasks[0].status==='review';});assert.deepEqual(calls,roles);}finally{await env.close();}
});

test('author cannot delegate actual work to the reserved reviewer session', async () => {
  let env:Awaited<ReturnType<typeof setup>>; const calls:string[]=[];
  env=await setup(seat=>({async execute(item){calls.push(seat.role);if(seat.role==='builder')return {kind:'handoff',destination:env.service.teams.taskSeats(seat.teamId,item.taskId).find(s=>s.role==='reviewer')!.sessionId,body:'do author work',reason:'delegate'};return completed(seat,item);},async cancel(){return true;}}));
  try{const task=env.task();await env.service.dispatch(task.id,env.team.id);await until(async()=>{await env.service.sync();return env.workspace.snapshot().tasks[0].status==='failed';});assert.deepEqual(calls,['builder']);assert.equal(env.service.queue.list().length,1);}finally{await env.close();}
});

test('successor insertion failure rolls back queue completion, frontier and workflow trail together', async () => {
  const env=await setup(seat=>({execute:item=>completed(seat,item),async cancel(){return true;}}));
  try {
    const core=(env.service as unknown as {db:import('node:sqlite').DatabaseSync}).db;
    core.exec(`CREATE TRIGGER reject_reviewer BEFORE INSERT ON execution_queue WHEN NEW.request_id LIKE '%:reviewer:%' BEGIN SELECT RAISE(ABORT,'injected successor failure'); END`);
    const task=env.task();await env.service.dispatch(task.id,env.team.id);await until(async()=>{await env.service.sync();return env.workspace.snapshot().tasks[0].status==='failed';});
    const rows=env.service.queue.list();assert.equal(rows.length,1);assert.equal(rows[0].state,'failed');
    const trails=core.prepare('SELECT exit FROM workflow_transitions WHERE task_id=?').all(task.id);assert.deepEqual(trails.map(r=>r.exit),['failed']);
    const flow=JSON.parse(String(core.prepare('SELECT payload FROM task_flows WHERE task_id=?').get(task.id)!.payload));assert.equal(flow.runs.reviewer.state,'dormant');assert.equal(flow.hops,0);
  }finally{await env.close();}
});

test('exception coordinator retries stopped work without completing the original obligation', async () => {
  const config = structuredClone(defaultTeamConfig);
  config.members.push({role:'coordinator',name:'协调',instructions:'诊断'});
  config.workflow.exception_routing = {orchestrator_role:'coordinator'};
  const calls: string[] = []; let attempts = 0;
  const env = await setup(seat => ({ async execute(item) {
    calls.push(seat.role);
    if (seat.role === 'builder' && attempts++ === 0) return {kind:'failed',reason:'temporary failure'};
    return completed(seat,item,seat.role === 'coordinator' ? {recoveryAction:'retry'} : {});
  }, async cancel() { return true; } }),config);
  try {
    const task = env.task(); await env.service.dispatch(task.id,env.team.id);
    await until(async () => { await env.service.sync(); return env.workspace.snapshot().tasks[0].status === 'review'; });
    assert.deepEqual(calls,['builder','coordinator','builder','reviewer']);
    assert.equal(env.service.queue.list().length,3);
    assert.ok(env.service.queue.list().every(i => i.state === 'done'));
  } finally { await env.close(); }
});

test('human and authentication gates cannot be delegated to exception coordinators', async () => {
  const { exceptionTarget } = await import('../src/domains/workflows/exceptions');
  const policy = {orchestrator_role:'coordinator'};
  assert.equal(exceptionTarget(policy,'human_gate_trip'),undefined);
  assert.equal(exceptionTarget(policy,'unmapped_failed','auth:login'),undefined);
  assert.equal(exceptionTarget(policy,'stuck_overdue','human:gate'),undefined);
  assert.equal(exceptionTarget({...policy, classes:{unmapped_failed:'human_only'}},'unmapped_failed'),undefined);
  assert.equal(exceptionTarget(policy,'stuck_overdue'),'coordinator');
});

test('backend tools enforce task/team scope and reject a canceled execution capability', async () => {
  const { backendAttempt } = await import('../src/application/backend-tools');
  let env: Awaited<ReturnType<typeof setup>>, foreignId = '', otherMemoryId = '';
  let checked = false;
  env = await setup(seat => ({ async execute(item) {
    const bridge = backendAttempt(env.service.queue,env.service.teams,env.service.memory,seat,item,() => []);
    await bridge.open(); const vars = bridge.environment();
    const invoke = (name:string,input = {}) => fetch(vars.ORBIT_AGENT_ENDPOINT,{method:'POST',headers:{Authorization:`Bearer ${vars.ORBIT_AGENT_TOKEN}`},body:JSON.stringify({name,input,requestId:crypto.randomUUID()})});
    try {
      assert.equal((await invoke('get_work',{itemId:foreignId})).status,400);
      assert.equal((await invoke('read_team_memory',{memoryId:otherMemoryId})).status,400);
      assert.equal((await invoke('handoff_work',{destination:'foreign',summary:'invalid'})).status,400);
      assert.equal((await invoke('complete_work',{summary:'staged'})).status,200);
      assert.equal(env.service.queue.get(item.id).state,'in-progress');
      env.service.queue.requestCancel(item.id,'test');
      assert.equal((await invoke('report_progress',{note:'too late'})).status,400);
      checked = true;
      return {kind:'canceled',reason:'test complete'};
    } finally { await bridge.close(); }
  }, async cancel() { return true; } }));
  try {
    const other = env.service.createTeam('其他团队');
    otherMemoryId = env.service.memory.put({scope:{kind:'team',id:other.id},key:'private',taxonomy:'lore',content:'private',sourceRef:'test'},0).id;
    foreignId = env.service.queue.enqueue({requestId:'foreign',taskId:'foreign',source:'user',destination:'foreign',body:'private'}).id;
    const task = env.task(); await env.service.dispatch(task.id,env.team.id);
    await until(async () => { await env.service.sync(); return checked; });
  } finally { await env.close(); }
});

test('stalled work is diagnosed once and cannot be duplicated while its process is alive', async () => {
  const config = structuredClone(defaultTeamConfig); config.members.push({role:'coordinator',name:'协调',instructions:'诊断'}); config.workflow.exception_routing = {orchestrator_role:'coordinator'};
  let builds = 0, diagnoses = 0;
  const env = await setup(seat => ({ async execute(item,signal) {
    if (seat.role === 'builder') { builds++; await new Promise<void>(resolve => { if(signal.aborted) resolve(); else signal.addEventListener('abort',() => resolve(),{once:true}); }); return {kind:'canceled',reason:'stopped'}; }
    diagnoses++; return completed(seat,item,{recoveryAction:'retry'});
  }, async cancel() { return true; } }),config);
  try {
    const task = env.task(); await env.service.dispatch(task.id,env.team.id);
    await until(async () => builds === 1);
    const source = env.service.queue.list()[0];
    const core = (env.service as unknown as {db:import('node:sqlite').DatabaseSync}).db;
    core.prepare('UPDATE execution_events SET at=? WHERE item_id=?').run(new Date(Date.now()-600000).toISOString(),source.id);
    await until(async () => { await env.service.sync(); return diagnoses === 1 && env.service.queue.list().some(i => i.id !== source.id && i.state === 'done'); });
    await env.service.sync(); await env.service.sync();
    assert.equal(builds,1); assert.equal(diagnoses,1); assert.equal(env.service.queue.get(source.id).state,'in-progress');
    await env.service.cancel(task.id);
  } finally { await env.close(); }
});
