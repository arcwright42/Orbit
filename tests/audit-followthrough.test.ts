import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openCoreDatabase } from '../src/infrastructure/core-database';
import { openDatabase } from '../src/infrastructure/database';
import { ExecutionQueue } from '../src/domains/orchestration/queue';
import { TaskExecutionService } from '../src/application/task-execution';
import { WorkspaceService } from '../src/application/workspace';
import { MaterialLibrary } from '../src/domains/materials/library';
import { platformTools } from '../src/application/platform-tools';
import { runtimeContext } from '../src/application/runtime-context';
import type { TeamConfig } from '../src/domains/workflows/spec';
import type { ExecutionPort } from '../src/domains/runtime/execution-port';
import type { Seat } from '../src/domains/teams/registry';
import type { QueueItem } from '../src/domains/orchestration/types';
import { backendAttempt } from '../src/application/backend-tools';
import { TeamKnowledge } from '../src/domains/memory/team-knowledge';
import { MemoryStore } from '../src/domains/memory/store';
import { TeamRegistry } from '../src/domains/teams/registry';
import { CodexRuntime } from '../src/domains/runtime/codex';

// Regression cases from the post-PR #7 audit. Uses real Orbit application/queue/storage, isolated DBs,
// and controlled execution-port outcomes. No native model or user files involved.
// Orbit: 08d3a5bce8d61ffe7c8ac2b70310b9e46a7ace6f.
// OpenRig: 4b48ca21a9bd072aa05a08b3da6d9c0708e093c5, inspected source (not executed here).
// A1 upstream: packages/daemon/src/domain/queue-repository.ts:2931-2969.
// A2 upstream: packages/daemon/src/domain/workflow-projector.ts:1091-1100.
// A3 upstream: packages/daemon/src/domain/workflow-projector.ts:1005-1043,1224-1244.
// A4 upstream: packages/daemon/src/domain/workflow-runtime.ts:1332-1355;
// Orbit occurrence selection/replay differs and its public tool call ID is unused for retries.
// A5 is an Orbit-specific crash consistency defect introduced by its split persistence;
// upstream's transactional state is not proof of compatibility with Orbit's acceptance UX.
// A6 upstream: packages/daemon/src/domain/context-packs/profile-composer.ts:10-14,98-107.
// A7 upstream: packages/daemon/src/domain/queue-stuck-sweep.ts:369-403.
// A8 upstream: packages/cli/src/commands/context.ts (recap-write) and domain/context-packs/seat-recap-store.ts.
const simple: TeamConfig = { members: [{ role:'worker', name:'worker', instructions:'work' }], edges:[], workflow:{entry:'work',max_hops:10,steps:[{id:'work',actor_role:'worker',objective:'work'}]} };
async function until(fn:()=>boolean|Promise<boolean>) {
  for(let i=0;i<200;i++) { if(await fn()) return; await new Promise(r=>setTimeout(r,5)); }
  throw Error('Audit setup timeout');
}
function completed(seat:Seat,item:QueueItem) {
  const evidenceRef=join(seat.workspace,`${item.id}-${item.generation}.json`);
  writeFileSync(evidenceRef,JSON.stringify({summary:'verified',artifacts:[],recap:'## Decisions\nAudit only'}));
  return {kind:'completed' as const,summary:'verified',evidenceRef};
}
function fixture(config:TeamConfig,factory:(seat:Seat)=>ExecutionPort) {
  const root=mkdtempSync(join(tmpdir(),'orbit-audit-regression-')),db=openDatabase(join(root,'orbit.sqlite'));
  const materials=new MaterialLibrary(db,join(root,'files')),workspace=new WorkspaceService(db,materials);
  let service=new TaskExecutionService(db,materials,root,()=>{},undefined,factory);
  const team=service.createTeam('audit',config),requestId=randomUUID();
  const task=workspace.submit({requestId,text:'isolated audit',attachmentIds:[]}).tasks.find(t=>t.requestId===requestId)!;
  return {root,db,workspace,team,task,get service(){return service;},
    async reopen(){await service.close();service=new TaskExecutionService(db,materials,root,()=>{},undefined,factory);},
    async close(){await service.close();db.close();rmSync(root,{recursive:true,force:true});}};
}

test('A1: waiting follows a live handoff successor instead of immediately resuming',()=>{
  const db=openCoreDatabase(':memory:'),q=new ExecutionQueue(db);
  try {
    const source=q.enqueue({requestId:'source',taskId:'task',source:'user',destination:'author',body:'work'});
    const waiter=q.enqueue({requestId:'waiter',taskId:'task',source:'user',destination:'waiting-owner',body:'wait'});
    const running=q.claimNext(['author'],3)!,waiting=q.claimNext(['waiting-owner'],3)!;
    q.finish(waiting.id,waiting.generation!,{kind:'blocked',blockedOn:`queue:${source.id}`,reason:'wait for result',wakeAfterSeconds:3600});
    const handed=q.finish(running.id,running.generation!,{kind:'handoff',destination:'expert',body:'unfinished work',reason:'expert continues'});
    q.wakeDue();
    assert.equal(q.get(waiter.id).state,'blocked','successor is pending, so predecessor closure cannot release its waiter');
    assert.equal(q.get(waiter.id).blockedOn,`queue:${handed.successorId}`);
  }finally{db.close();}
});

test('A2: dependency-graph sink handoff terminates the step without inventing another delegate',async()=>{
  const config:TeamConfig={members:['worker','helper'].map(role=>({role,name:role,instructions:role})),edges:[{from:'worker',to:'helper'}],workflow:{entry:'work',max_hops:3,steps:[{id:'work',actor_role:'worker',objective:'sink',depends_on:[],allowed_exits:['handoff']}]} };
  const calls:string[]=[];let env:ReturnType<typeof fixture>;
  env=fixture(config,seat=>({async execute(){calls.push(seat.role);if(seat.role==='worker')return {kind:'handoff',destination:env.service.teams.taskSeats(env.team.id,env.task.id).find(s=>s.role==='helper')!.sessionId,body:'sink complete',reason:'sink complete'};return {kind:'failed',reason:'there should be no extra delegation'};},async cancel(){return true;}}));
  try{await env.service.dispatch(env.task.id,env.team.id);await until(async()=>{await env.service.sync();return env.workspace.snapshot().tasks[0].status==='review';});
    assert.deepEqual(calls,['worker'],'a graph sink handoff is completion, not another current-step delegation');
  }finally{await env.close();}
});

test('a graph sink handoff cannot bypass Orbit independent review evidence',async()=>{
  const config=structuredClone(simple);Object.assign(config.workflow.steps[0],{depends_on:[],review:true});
  const env=fixture(config,()=>({async execute(){return {kind:'handoff',body:'skip review',reason:'skip review'};},async cancel(){return true;}}));
  try {
    await env.service.dispatch(env.task.id,env.team.id);await until(()=>env.service.queue.list().some(i=>i.state==='failed'));await env.service.sync();
    assert.notEqual(env.workspace.snapshot().tasks[0].status,'review');assert.throws(()=>env.service.accept(env.task.id));
  }finally{await env.close();}
});

for(const siblingFinishesFirst of [false,true]) test(`A3: mapped remediation preserves the live sibling; sibling finishes first=${siblingFinishesFirst}`,async()=>{
  const roles=['build','left','right','join'];
  const config:TeamConfig={members:roles.map(role=>({role,name:role,instructions:role})),edges:[{from:'left',to:'build'}],workflow:{entry:'build',max_hops:10,steps:[
    {id:'build',actor_role:'build',objective:'build',depends_on:[]},
    {id:'left',actor_role:'left',objective:'review left',depends_on:['build'],next_hop:{on:{failed:'build'}}},
    {id:'right',actor_role:'right',objective:'review right',depends_on:['build']},
    {id:'join',actor_role:'join',objective:'join',depends_on:['left','right']},
  ]}};
  let builds=0,lefts=0,rights=0,joins=0,releaseBuild!:()=>void,releaseRight!:()=>void;
  const buildGate=new Promise<void>(r=>releaseBuild=r),rightGate=new Promise<void>(r=>releaseRight=r);
  const env=fixture(config,seat=>({async execute(item){
    if(seat.role==='build' && ++builds===2) await buildGate;
    if(seat.role==='left' && ++lefts===1) return {kind:'failed',reason:'needs remediation'};
    if(seat.role==='right' && ++rights===1) await rightGate;
    if(seat.role==='join') joins++;
    return completed(seat,item);
  },async cancel(){releaseBuild();releaseRight();return true;}}));
  try {
    await env.service.dispatch(env.task.id,env.team.id);await until(()=>builds===2 && rights===1);
    const originalRight=env.service.queue.list().find(i=>env.service.teams.seat(i.destination).role==='right')!;
    assert.equal(env.service.queue.get(originalRight.id).state,'in-progress');assert.equal(joins,0);
    if(siblingFinishesFirst) {releaseRight();await until(()=>env.service.queue.get(originalRight.id).state==='done');releaseBuild();}
    else {releaseBuild();await until(()=>lefts===2);releaseRight();}
    await until(async()=>{await env.service.sync();return env.workspace.snapshot().tasks[0].status==='review';});
    assert.equal(builds,2);assert.equal(lefts,2);assert.equal(rights,siblingFinishesFirst ? 2 : 1);assert.equal(joins,1);
    assert.equal(env.service.queue.get(originalRight.id).state,'done');
    assert.ok(!env.service.queue.list().some(i=>i.resolution?.includes('执行回执被拒绝')));
  } finally {releaseBuild();releaseRight();await env.close();}
});

test('A4: replaying the same retry tool call cannot redrive a later failure',async()=>{
  let executions=0;
  const env=fixture(simple,()=>({async execute(){executions++;return {kind:'failed',reason:'controlled failure'};},async cancel(){return true;}}));
  try{await env.service.dispatch(env.task.id,env.team.id);await until(()=>env.service.queue.list().some(i=>i.state==='failed'));await env.service.sync();
    const invoke=platformTools(env.workspace,env.service,()=>{}),input={taskId:env.task.id};
    await invoke('retry_task',input,'same-retry-request');await until(()=>executions===2 && env.service.queue.list().filter(i=>i.state==='failed').length===2);await env.service.sync();
    const replay=await invoke('retry_task',input,'same-retry-request');await env.service.sync();
    await assert.rejects(async()=>invoke('retry_task',{taskId:env.task.id,itemId:'changed'},'same-retry-request'),/different command/);
    await env.reopen();
    assert.deepEqual(await platformTools(env.workspace,env.service,()=>{})('retry_task',input,'same-retry-request'),replay);
    await env.service.sync();
    assert.equal(executions,2,'same call ID should return its recorded redrive, not execute another attempt');
  }finally{await env.close();}
});

test('A5: terminal core state rebuilds task projection after display-database write failure',async()=>{
  const env=fixture(simple,seat=>({async execute(item){return completed(seat,item);},async cancel(){return true;}}));
  try{await env.service.dispatch(env.task.id,env.team.id);await until(async()=>{await env.service.sync();return env.workspace.snapshot().tasks[0].status==='review';});
    env.db.exec("CREATE TRIGGER audit_reject_projection BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'controlled task projection failure'); END");
    assert.throws(()=>env.service.accept(env.task.id),/controlled task projection failure/);env.db.exec('DROP TRIGGER audit_reject_projection');
    await env.reopen();await env.service.sync();
    const core=new DatabaseSync(join(env.root,'execution-core.sqlite'),{readOnly:true});
    const flow=JSON.parse(String(core.prepare('SELECT payload FROM task_flows WHERE task_id=?').get(env.task.id)!.payload));core.close();
    assert.equal(flow.closure,'accepted');
    assert.equal(env.workspace.snapshot().tasks[0].status,'completed','closed accepted core state must restore the display projection');
  }finally{await env.close();}
});

test('A6: context budget overage reports an advisory rather than refusing all execution',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-parity-context-')),pack=join(root,'pack');mkdirSync(pack);
  writeFileSync(join(pack,'manifest.yaml'),'name: audit\nversion: "1"\ntaxonomy: world\nfiles:\n  - path: body.md\n    role: context\natoms:\n  - id: body\n    address: body.md\n    taxonomy: world\n    situations: [fresh]\n    purpose: depth\n    runtime: any\n    order: 1\n    priority: optional\n');
  writeFileSync(join(pack,'body.md'),'x'.repeat(65000));
  const seat={workspace:root} as Seat,item={taskId:'task'} as QueueItem;
  try{const context=runtimeContext(seat,item,pack,root,'fresh');assert.match(context,/context budget advisory/);assert.match(context,/dropCandidates/);assert.ok(context.includes('x'.repeat(65000)));}
  finally{rmSync(root,{recursive:true,force:true});}
});

test('A7: recovery coordinator obligations receive the same stalled-work monitoring',async()=>{
  const config=structuredClone(simple);config.members.push({role:'coordinator',name:'coordinator',instructions:'diagnose'});config.workflow.exception_routing={default:'orchestrator',orchestrator_role:'coordinator'};
  config.workflow.watchdogs=[{id:'stalled',policy:'stalled',after_seconds:1,interval_seconds:1}];
  let started=false,release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const env=fixture(config,seat=>({async execute(){if(seat.role==='worker')return {kind:'failed',reason:'needs diagnosis'};started=true;await gate;return {kind:'failed',reason:'audit cleanup'};},async cancel(){release();return true;}}));
  try{await env.service.dispatch(env.task.id,env.team.id);await until(()=>started);const diagnostic=env.service.queue.list().find(i=>i.state==='in-progress')!;
    const core=new DatabaseSync(join(env.root,'execution-core.sqlite'));core.prepare('UPDATE execution_events SET at=? WHERE item_id=?').run(new Date(Date.now()-600000).toISOString(),diagnostic.id);
    await env.service.sync();const jobs=Number(core.prepare('SELECT count(*) AS n FROM watchdog_jobs WHERE item_id=?').get(diagnostic.id)!.n);core.close();
    assert.ok(jobs>0,'recovery work is an obligation too; it must not fall outside the standing stuck sweep');
    assert.equal(env.service.queue.get(diagnostic.id).state,'in-progress','timeout is not process-death proof');
    assert.equal(env.service.detail(env.task.id)?.blockedOn,'human:exception');
    await env.service.sync();
    assert.equal(env.service.queue.list().filter(i=>i.blockedOn==='human:exception').length,1);
    assert.equal(env.service.queue.list().filter(i=>env.service.teams.seat(i.destination).role==='coordinator').length,1,'never recursively diagnose the coordinator');
  }finally{release();await env.close();}
});

test('control: actual blocker completion releases a waiting obligation',()=>{
  const db=openCoreDatabase(':memory:'),q=new ExecutionQueue(db);
  try{
    const source=q.enqueue({requestId:'source',taskId:'task',source:'user',destination:'author',body:'work'});
    const waiter=q.enqueue({requestId:'waiter',taskId:'task',source:'user',destination:'waiting-owner',body:'wait'});
    const running=q.claimNext(['author'],3)!,waiting=q.claimNext(['waiting-owner'],3)!;
    q.finish(waiting.id,waiting.generation!,{kind:'blocked',blockedOn:`queue:${source.id}`,reason:'wait for result'});
    q.finish(running.id,running.generation!,{kind:'completed',summary:'actual completion',evidenceRef:'audit-receipt'});
    assert.equal(q.wakeDue(),1);assert.equal(q.get(waiter.id).state,'pending');
  }finally{db.close();}
});

test('control: a done dependency sink completes and normal acceptance survives reopen',async()=>{
  const config=structuredClone(simple);config.workflow.steps[0].depends_on=[];
  const env=fixture(config,seat=>({async execute(item){return completed(seat,item);},async cancel(){return true;}}));
  try{
    await env.service.dispatch(env.task.id,env.team.id);
    await until(async()=>{await env.service.sync();return env.workspace.snapshot().tasks[0].status==='review';});
    env.service.accept(env.task.id);await env.reopen();await env.service.sync();
    assert.equal(env.workspace.snapshot().tasks[0].status,'completed');
  }finally{await env.close();}
});

test('control: the same context pack below the budget composes successfully',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-parity-context-')),pack=join(root,'pack');mkdirSync(pack);
  writeFileSync(join(pack,'manifest.yaml'),'name: audit\nversion: "1"\ntaxonomy: world\nfiles:\n  - path: body.md\n    role: context\natoms:\n  - id: body\n    address: body.md\n    taxonomy: world\n    situations: [fresh]\n    purpose: depth\n    runtime: any\n    order: 1\n    priority: optional\n');
  writeFileSync(join(pack,'body.md'),'audit text');
  try{assert.match(runtimeContext({workspace:root} as Seat,{taskId:'task'} as QueueItem,pack,root,'fresh'),/audit text/);}
  finally{rmSync(root,{recursive:true,force:true});}
});

test('custody propagation retains a paused backoff deadline across reopen, onward handoffs and return to owner',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-custody-')),path=join(root,'core.sqlite');let db=openCoreDatabase(path),q=new ExecutionQueue(db);
  try {
    const source=q.enqueue({requestId:'source',taskId:'task',source:'user',destination:'author',body:'work'});
    const waiter=q.enqueue({requestId:'waiter',taskId:'task',source:'user',destination:'owner',body:'wait'});
    const a=q.claimNext(['author'],3)!,w=q.claimNext(['owner'],3)!;
    q.finish(w.id,w.generation!,{kind:'blocked',blockedOn:`queue:${source.id}`,reason:'wait',wakeAfterSeconds:10,wakeMaxSeconds:80});
    const due=db.prepare('SELECT due_at FROM queue_wakes WHERE item_id=?').get(w.id)!.due_at;
    q.pauseStopped(waiter.id);
    const b=q.finish(a.id,a.generation!,{kind:'handoff',destination:'expert',body:'next',reason:'next'});
    assert.equal(q.get(waiter.id).blockedOn,'application:paused');
    db.close();db=openCoreDatabase(path);q=new ExecutionQueue(db);q.resumePaused(waiter.id);
    assert.equal(q.get(waiter.id).blockedOn,`queue:${b.successorId}`);
    assert.equal(db.prepare('SELECT due_at FROM queue_wakes WHERE item_id=?').get(w.id)!.due_at,due);
    assert.equal(q.wakeDue(Number(due)-1),0);
    const running=q.claimNext(['expert'],2)!;
    q.finish(running.id,running.generation!,{kind:'handoff',destination:'owner',body:'result arrival',reason:'return'});
    assert.equal(q.wakeDue(Number(due)-1),1);assert.equal(q.get(waiter.id).state,'pending');
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('workflow rejection rolls back custody changes and successor creation together',()=>{
  const db=openCoreDatabase(':memory:'),q=new ExecutionQueue(db);
  try {
    const s=q.enqueue({requestId:'s',taskId:'t',source:'u',destination:'s',body:'work'}),w=q.enqueue({requestId:'w',taskId:'t',source:'u',destination:'w',body:'work'});
    const a=q.claimNext(['s'],2)!,b=q.claimNext(['w'],2)!;
    q.finish(b.id,b.generation!,{kind:'blocked',blockedOn:`queue:${s.id}`,reason:'wait',wakeAfterSeconds:1});
    q.setProjector(()=>{throw Error('rejected route');});
    assert.throws(()=>q.finish(a.id,a.generation!,{kind:'handoff',destination:'c',reason:'next',body:'next'}),/rejected route/);
    assert.equal(q.list().length,2);assert.equal(q.get(w.id).blockedOn,`queue:${s.id}`);assert.equal(q.get(s.id).state,'in-progress');
  }finally{db.close();}
});

test('mapped return to a still-live step creates another binding without losing its active occurrence',async()=>{
  const config:TeamConfig={members:['a','b','join'].map(role=>({role,name:role,instructions:role})),edges:[{from:'a',to:'b'}],workflow:{entry:'a',max_hops:5,steps:[
    {id:'a',actor_role:'a',objective:'route',depends_on:[],next_hop:{on:{done:'b'}}},
    {id:'b',actor_role:'b',objective:'live target',depends_on:[]},
    {id:'join',actor_role:'join',objective:'join',depends_on:['a','b']},
  ]}};
  let bs=0,as=false,releaseA!:()=>void,releaseB!:()=>void;const gateA=new Promise<void>(r=>releaseA=r),gateB=new Promise<void>(r=>releaseB=r);
  const env=fixture(config,seat=>({async execute(item){if(seat.role==='a'){as=true;await gateA;}if(seat.role==='b' && ++bs===1) await gateB;return completed(seat,item);},async cancel(){releaseA();releaseB();return true;}}));
  try {
    await env.service.dispatch(env.task.id,env.team.id);await until(()=>as && bs===1);releaseA();
    await until(()=>env.service.queue.list().filter(i=>env.service.teams.seat(i.destination).role==='b').length===2);
    const obligations=env.service.queue.list().filter(i=>env.service.teams.seat(i.destination).role==='b');
    assert.deepEqual(obligations.map(i=>i.state),['in-progress','pending']);assert.equal(bs,1,'stable seat lane remains serial');
    releaseB();await until(async()=>{await env.service.sync();return env.workspace.snapshot().tasks[0].status==='review';});
    assert.equal(bs,2);assert.ok(obligations.every(i=>env.service.queue.get(i.id).state==='done'));
  } finally {releaseA();releaseB();await env.close();}
});

test('rotate tool replay returns the original redrive through concurrent calls and a later restart',async()=>{
  let runs=0,preparations=0;
  const env=fixture(simple,()=>({async execute(){runs++;return {kind:'failed',reason:'failure'};},async cancel(){return true;},async prepareSuccessor(){preparations++;return {nativeId:`prepared-${preparations}`};}}));
  try {
    await env.service.dispatch(env.task.id,env.team.id);await until(()=>env.service.queue.list().some(i=>i.state==='failed'));
    const invoke=platformTools(env.workspace,env.service,()=>{}),input={taskId:env.task.id};
    const [first,replay]=await Promise.all([invoke('rotate_task_session',input,'rotate-once'),invoke('rotate_task_session',input,'rotate-once')]);
    assert.deepEqual(replay,first);await until(()=>runs===2);assert.equal(preparations,1);
    await env.reopen();assert.deepEqual(await platformTools(env.workspace,env.service,()=>{})('rotate_task_session',input,'rotate-once'),first);
    assert.equal(runs,2);assert.equal(preparations,1);
    await assert.rejects(async()=>platformTools(env.workspace,env.service,()=>{})('retry_task',input,'rotate-once'),/different command/);
  }finally{await env.close();}
});

test('a command receipt failure rolls back redrive instead of leaving an unrecorded extra execution',async()=>{
  let runs=0;const env=fixture(simple,()=>({async execute(){runs++;return {kind:'failed',reason:'failure'};},async cancel(){return true;}}));
  try {
    await env.service.dispatch(env.task.id,env.team.id);await until(()=>env.service.queue.list().some(i=>i.state==='failed'));
    const core=new DatabaseSync(join(env.root,'execution-core.sqlite'));
    try {
      core.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON execution_commands BEGIN SELECT RAISE(ABORT,'receipt write failed'); END");
      const invoke=platformTools(env.workspace,env.service,()=>{}),input={taskId:env.task.id};
      await assert.rejects(async()=>invoke('retry_task',input,'atomic-redrive'),/receipt write failed/);
      assert.equal(env.service.queue.list().filter(i=>i.source!=='workflow:exception').length,1);assert.equal(runs,1);
      core.exec('DROP TRIGGER reject_receipt');await invoke('retry_task',input,'atomic-redrive');await until(()=>runs===2);
      assert.equal(env.service.queue.list().filter(i=>i.source!=='workflow:exception').length,2);
    }finally{core.close();}
  }finally{await env.close();}
});

test('an interrupted rotation request remains pinned to its failed occurrence and can commit after restart',async()=>{
  let runs=0,preparations=0;
  const env=fixture(simple,seat=>({async execute(item){if(++runs===1)return {kind:'failed',reason:'failure'};return completed(seat,item);},async cancel(){return true;},async prepareSuccessor(){if(++preparations===1)throw Error('preparation interrupted');return {nativeId:'ready-after-restart'};}}));
  try {
    await env.service.dispatch(env.task.id,env.team.id);await until(()=>env.service.queue.list().some(i=>i.state==='failed'));
    const source=env.service.queue.list().find(i=>i.state==='failed')!,input={taskId:env.task.id};
    await assert.rejects(async()=>platformTools(env.workspace,env.service,()=>{})('rotate_task_session',input,'interrupted'),/preparation interrupted/);
    await env.reopen();await platformTools(env.workspace,env.service,()=>{})('rotate_task_session',input,'interrupted');
    await until(async()=>{await env.service.sync();return env.workspace.snapshot().tasks[0].status==='review';});
    assert.equal(runs,2);assert.equal(preparations,2);assert.ok(env.service.queue.get(source.id).successorId);
  }finally{await env.close();}
});

test('rotation cannot hide a paused human question behind application:paused',async()=>{
  let preparations=0;const env=fixture(simple,()=>({async execute(){return {kind:'question',question:'Need input'};},async cancel(){return true;},async prepareSuccessor(){preparations++;return {nativeId:'never'};}}));
  try {
    await env.service.dispatch(env.task.id,env.team.id);await until(()=>env.service.detail(env.task.id)?.blockedOn==='human:user');await env.reopen();
    await assert.rejects(env.service.rotateSession(env.task.id),/恢复暂停/);assert.equal(preparations,0);
    env.service.retry(env.task.id);assert.equal(env.service.detail(env.task.id)?.blockedOn,'human:user');
  }finally{await env.close();}
});

test('canceled terminal intent repairs a failed UI projection without turning cancellation into acceptance',async()=>{
  const env=fixture(simple,()=>({async execute(){return {kind:'question',question:'Need input'};},async cancel(){return true;}}));
  try {
    await env.service.dispatch(env.task.id,env.team.id);await until(()=>env.service.detail(env.task.id)?.blockedOn==='human:user');
    env.db.exec("CREATE TRIGGER reject_cancel_projection BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'projection failed'); END");
    await assert.rejects(env.service.cancel(env.task.id),/projection failed/);env.db.exec('DROP TRIGGER reject_cancel_projection');
    await env.reopen();await env.service.sync();assert.equal(env.workspace.snapshot().tasks[0].status,'canceled');
    assert.throws(()=>env.service.accept(env.task.id));
  }finally{await env.close();}
});

test('stale display state cannot overwrite an accepted core decision with cancellation',async()=>{
  const env=fixture(simple,seat=>({async execute(item){return completed(seat,item);},async cancel(){return true;}}));
  try {
    await env.service.dispatch(env.task.id,env.team.id);await until(async()=>{await env.service.sync();return env.workspace.snapshot().tasks[0].status==='review';});
    env.db.exec("CREATE TRIGGER reject_accept_projection BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'projection failed'); END");
    assert.throws(()=>env.service.accept(env.task.id),/projection failed/);env.db.exec('DROP TRIGGER reject_accept_projection');
    await env.service.cancel(env.task.id);assert.equal(env.workspace.snapshot().tasks[0].status,'completed');
    const timestamp=env.workspace.snapshot().tasks[0].updatedAt;await env.service.sync();assert.equal(env.workspace.snapshot().tasks[0].updatedAt,timestamp,'repair is idempotent, not a new user action');
  }finally{await env.close();}
});

test('missing post-compaction recap is delivered as an advisory, not silently discarded',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-skipped-')),pack=join(root,'pack');mkdirSync(pack);
  writeFileSync(join(pack,'manifest.yaml'),'name: audit\nversion: "1"\ntaxonomy: world\nfiles: []\natoms:\n  - id: recap\n    address: seat:RECAP.md\n    taxonomy: lore\n    situations: [post-compaction]\n    purpose: depth\n    runtime: any\n    order: 1\n    priority: optional\n');
  try{const context=runtimeContext({workspace:root} as Seat,{taskId:'t'} as QueueItem,pack,root,'post-compaction');assert.match(context,/context source advisories/);assert.match(context,/recap/);}
  finally{rmSync(root,{recursive:true,force:true});}
});

for(const kind of ['question','blocked','failed','handoff'] as const) test(`A8: ${kind} preserves authored RECAP and team learning without a completion receipt`,async()=>{
  const config=structuredClone(simple);config.workflow.steps[0].depends_on=[];
  const knowledge={recap:`## Decision\nCheckpoint on ${kind}`,lessons:`Reusable ${kind} lesson`};
  const env=fixture(config,()=>({async execute(){
    if(kind==='question') return {kind,question:'Need input',knowledge};
    if(kind==='blocked') return {kind,blockedOn:'external:dependency',reason:'waiting',knowledge};
    if(kind==='handoff') return {kind,reason:'sink complete',body:'done',knowledge};
    return {kind,reason:'failure',knowledge};
  },async cancel(){return true;}}));
  try {
    await env.service.dispatch(env.task.id,env.team.id);await until(()=>env.service.queue.list()[0].state!=='in-progress');await env.service.sync();
    const seat=env.service.teams.taskSeats(env.team.id,env.task.id)[0],root=env.service.teams.seatRoot(seat);
    assert.match(readFileSync(join(root,'RECAP.md'),'utf8'),new RegExp(`Checkpoint on ${kind}`));
    assert.equal(readdirSync(join(root,'recap-superseded')).length,1);
    assert.equal(env.service.memory.list({kind:'team',id:env.team.id}).length,1);
    assert.equal(env.service.queue.list()[0].evidenceRef,null,'checkpoint does not invent completion evidence');
    await env.reopen();await env.service.sync();assert.equal(readdirSync(join(root,'recap-superseded')).length,1);
  }finally{await env.close();}
});

test('write_recap persists during a live attempt, replays across bridge recreation, fences stale writers and retries failed file projection',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-recap-tool-')),db=openCoreDatabase(join(root,'core.sqlite'));
  const teams=new TeamRegistry(db,join(root,'teams')),team=teams.create('team',simple),seat=teams.taskSeats(team.id,'t')[0];
  const queue=new ExecutionQueue(db),memory=new MemoryStore(db),knowledge=new TeamKnowledge(memory,teams,db);
  queue.enqueue({requestId:'work',taskId:'t',source:'user',destination:seat.sessionId,body:'work'});const item=queue.claimNext([seat.sessionId],1)!;
  const make=()=>backendAttempt(queue,teams,memory,seat,item,()=>[],undefined,()=>true,(input,id)=>knowledge.checkpoint(seat,item,input,id));
  let bridge=make();await bridge.open();
  const call=async(name:string,input:unknown,id:string)=>{const env=bridge.environment();const r=await fetch(env.ORBIT_AGENT_ENDPOINT,{method:'POST',headers:{Authorization:`Bearer ${env.ORBIT_AGENT_TOKEN}`},body:JSON.stringify({name,input,requestId:id})});return {status:r.status,body:await r.json()};};
  try {
    const input={recap:'# 交接记录\n\n## Decision\nSaved before pause',lessons:'checkpoint lesson'};
    const first=await call('write_recap',input,'one');assert.equal(first.status,200);assert.equal(queue.get(item.id).state,'in-progress');assert.equal(bridge.staged,undefined);
    await bridge.close();bridge=make();await bridge.open();assert.deepEqual(await call('write_recap',input,'one'),first);
    assert.equal((await call('write_recap',{recap:'different'},'one')).status,400);
    assert.equal((await call('write_recap',{recap:'## Duplicate\na\n## Duplicate\nb'},'bad-markdown')).status,400);
    const seatRoot=teams.seatRoot(seat);mkdirSync(join(seatRoot,'RECAP.md'),{recursive:true});
    assert.throws(()=>knowledge.flushCheckpoints());assert.equal(db.prepare('SELECT count(*) AS n FROM knowledge_projections').get()!.n,0);
    rmSync(join(seatRoot,'RECAP.md'),{recursive:true});knowledge.flushCheckpoints();
    assert.match(readFileSync(join(seatRoot,'RECAP.md'),'utf8'),/Saved before pause/);assert.equal(memory.list({kind:'team',id:team.id}).length,1);
    assert.equal((await call('handoff_work',{summary:'sink complete'},'handoff')).status,200);assert.equal(bridge.staged?.destination,'');
    queue.finish(item.id,item.generation!,{kind:'question',question:'pause'});
    assert.equal((await call('write_recap',{recap:'late'},'late')).status,400);
    assert.throws(()=>knowledge.checkpoint(seat,item,{recap:'late'},'late-direct'),/结束/);
    queue.answer(item.id,'resume');const next=queue.claimNext([seat.sessionId],1)!;
    assert.notEqual(next.generation,item.generation);assert.equal((await call('write_recap',{recap:'stale generation'},'old-generation')).status,400);
    queue.requestCancel(next.id,'user');assert.throws(()=>knowledge.checkpoint(seat,next,{recap:'after cancel'},'canceled'),/结束/);
  }finally{await bridge.close();db.close();rmSync(root,{recursive:true,force:true});}
});

test('newer checkpoints outrank delayed completion projection and one broken seat does not block other seats',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-checkpoint-order-')),db=openCoreDatabase(join(root,'core.sqlite'));
  const teams=new TeamRegistry(db,join(root,'teams')),team=teams.create('team',simple),seat=teams.taskSeats(team.id,'t')[0];
  const other=teams.taskSeats(teams.create('other team',simple).id,'t2')[0];
  const queue=new ExecutionQueue(db),memory=new MemoryStore(db),knowledge=new TeamKnowledge(memory,teams,db);
  try {
    queue.enqueue({requestId:'old',taskId:'t',source:'u',destination:seat.sessionId,body:'old work'});const old=queue.claimNext([seat.sessionId],1)!;
    queue.finish(old.id,old.generation!,{kind:'completed',summary:'old completed',evidenceRef:'old.json'});
    queue.enqueue({requestId:'new',taskId:'t',source:'u',destination:seat.sessionId,body:'new work'});const newer=queue.claimNext([seat.sessionId],2)!;
    const receipt=knowledge.checkpoint(seat,newer,{recap:'## Decision\nNewer checkpoint'},'newer');
    knowledge.flushCheckpoints();knowledge.record(seat,queue.get(old.id),{summary:'Old completion',recap:'## Decision\nOld completion',artifacts:[],nativeId:'native',transcript:''});
    assert.match(readFileSync(join(teams.seatRoot(seat),'RECAP.md'),'utf8'),/Newer checkpoint/);
    assert.ok(knowledge.projected(receipt.recordKey));
    const broken=knowledge.checkpoint(seat,newer,{recap:'## Decision\nRetry broken projection'},'broken');
    rmSync(join(teams.seatRoot(seat),'RECAP.md'));mkdirSync(join(teams.seatRoot(seat),'RECAP.md'));
    queue.enqueue({requestId:'other',taskId:'t2',source:'u',destination:other.sessionId,body:'other work'});const otherItem=queue.claimNext([other.sessionId],2)!;
    const healthy=knowledge.checkpoint(other,otherItem,{recap:'## Decision\nOther seat checkpoint'},'healthy');
    assert.throws(()=>knowledge.flushCheckpoints(),/journal retained/);assert.equal(knowledge.projected(broken.recordKey),false);assert.equal(knowledge.projected(healthy.recordKey),true);
    assert.match(readFileSync(join(teams.seatRoot(other),'RECAP.md'),'utf8'),/Other seat checkpoint/);
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('native Codex parsing retains recap on every non-completed outcome and permits graph handoff without a destination',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-native-recap-')),db=openCoreDatabase(join(root,'core.sqlite'));
  const teams=new TeamRegistry(db,join(root,'teams')),team=teams.create('team',simple),seat=teams.taskSeats(team.id,'t')[0];
  const queue=new ExecutionQueue(db),binary=join(root,'codex-test.cjs');
  try {
    for(const outcome of ['question','waiting','failed','handoff']) {
      const payload={outcome,summary:'receipt',question:'question',artifacts:[],destination:'',blockedOn:'external:dependency',wakeAfterSeconds:0,wakeMaxSeconds:0,recap:`## Decision\nNative ${outcome}`,lessons:'native lesson'};
      writeFileSync(binary,`#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv.includes('--version') || process.argv.includes('status'))process.exit(0);process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'native-checkpoint'}));fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],${JSON.stringify(JSON.stringify(payload))});});`);chmodSync(binary,0o700);
      queue.enqueue({requestId:outcome,taskId:'t',source:'user',destination:seat.sessionId,body:'work'});const item=queue.claimNext([seat.sessionId],1)!;
      const runtime=new CodexRuntime(teams,seat.sessionId,join(root,'evidence'),()=>{},undefined,binary,undefined,undefined,()=>true);
      const result=await runtime.execute(item,new AbortController().signal);
      assert.equal(result.kind,outcome==='waiting' ? 'blocked' : outcome);assert.equal(result.knowledge?.recap,payload.recap);
      const recovered=await runtime.reconcile(item);assert.deepEqual(recovered,JSON.parse(JSON.stringify(result)));
      queue.finish(item.id,item.generation!,{kind:'failed',reason:'test next outcome'});
    }
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
