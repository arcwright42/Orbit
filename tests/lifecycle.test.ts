import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync,existsSync,chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCoreDatabase } from '../src/infrastructure/core-database';
import { ExecutionQueue } from '../src/domains/orchestration/queue';
import { Watchdog, type WatchdogSpec } from '../src/domains/orchestration/watchdog';
import { validateMarkdownAddressability,recapAdvisories } from '../src/domains/context/files';
import { parseNativeContext, predecessorHistory } from '../src/domains/runtime/native-context';
import { DatabaseSync } from 'node:sqlite';
import { checkCodexReady } from '../src/domains/runtime/readiness';
import type { Seat } from '../src/domains/teams/registry';

test('watchdog delivery rollback, restart dedupe and generation fencing', () => {
  const root=mkdtempSync(join(tmpdir(),'orbit-watchdog-')),db=openCoreDatabase(join(root,'core.sqlite')),queue=new ExecutionQueue(db);
  try {
    const item=queue.enqueue({requestId:'one',taskId:'task',source:'user',destination:'seat',body:'work'}),spec:WatchdogSpec={id:'unclaimed',policy:'unclaimed',after_seconds:1,interval_seconds:1};
    const facts={item,lastActivity:0,workspace:root};let watchdog=new Watchdog(db),count=0;
    assert.throws(()=>watchdog.scan(facts,[spec],()=>{queue.note(item.id,'watchdog','rolled back');throw Error('delivery failed');},2000));
    assert.ok(!queue.events().some(e=>e.note==='rolled back'));
    watchdog.scan(facts,[spec],()=>{count++;},2000);watchdog=new Watchdog(db);watchdog.scan(facts,[spec],()=>{count++;},4000);assert.equal(count,1);
    const claimed=queue.claimNext(['seat'],1)!;watchdog.scan({...facts,item:claimed},[{...spec,policy:'stalled'}],()=>{count++;},5000);assert.equal(count,2);
    watchdog.scan(facts,[spec],()=>{count++;},7000);assert.equal(count,2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM watchdog_jobs WHERE status='superseded'").get()!.n,1);
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

test('watchdog context facts must be fresh; artifact readiness is event based and cannot escape workspace',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-watchdog-')),db=openCoreDatabase(join(root,'core.sqlite')),queue=new ExecutionQueue(db);
  try {
    const item=queue.enqueue({requestId:'one',taskId:'task',source:'user',destination:'seat',body:'work'}),watchdog=new Watchdog(db),calls:string[]=[];
    const specs:WatchdogSpec[]=[{id:'usage',policy:'context-usage-threshold',after_seconds:1,interval_seconds:1,threshold:.8},{id:'artifacts',policy:'artifact-pool-ready',after_seconds:1,interval_seconds:1,paths:['result.txt']}];
    const facts={item,lastActivity:0,workspace:root,context:{used:90,window:100,sampledAt:new Date(0).toISOString()}};
    watchdog.scan(facts,specs,w=>calls.push(w.policy),1_000_000);assert.equal(calls.length,0);
    writeFileSync(join(root,'result.txt'),'real evidence');watchdog.scan({...facts,context:{...facts.context,sampledAt:new Date(1_001_000).toISOString()}},specs,w=>calls.push(w.policy),1_001_000);
    assert.equal(calls.join(','),'context-usage-threshold,artifact-pool-ready');watchdog.scan(facts,[specs[1]],w=>calls.push(w.policy),1_002_000);assert.equal(calls.length,2);
    assert.throws(()=>watchdog.scan(facts,[{...specs[1],paths:['../secret']}],()=>{},1_003_000));
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('recap rejects ambiguous headings and unclosed fences but authoring findings remain advisory',()=>{
  assert.throws(()=>validateMarkdownAddressability('## Decision\na\n## Decision\nb'),/Duplicate/);
  assert.throws(()=>validateMarkdownAddressability('## Decisions\n```js\ncode'),/Unterminated/);
  assert.doesNotThrow(()=>validateMarkdownAddressability('## Decisions\n```md\n## Decisions\n```'));
  assert.deepEqual(recapAdvisories('Some summary\nunverified result'),['no-decisions-section','nonstandard-unverified-marker:2']);
});

test('native compaction and context usage are read from native events, not API billing totals',()=>{
  const parsed=parseNativeContext([
    {type:'turn.completed',usage:{input_tokens:999999}},
    {type:'compacted',timestamp:'2026-10-10T00:00:00Z'},
    {type:'event_msg',timestamp:'2026-10-10T00:00:01Z',payload:{type:'token_count',info:{last_token_usage:{total_tokens:90},model_context_window:100}}},
  ].map(e=>JSON.stringify(e)).join('\n')+'\n{partial');
  assert.equal(parsed.used,90);assert.equal(parsed.window,100);assert.equal(parsed.compactedAt,'2026-10-10T00:00:00Z');
  assert.deepEqual(parseNativeContext(JSON.stringify({type:'turn.completed',usage:{input_tokens:999999}})),{});
});

test('readiness checks auth before launching task work and never exposes credential output',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-ready-')),binary=join(root,'codex');
  try {writeFileSync(binary,`#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nif [ "$1" = "login" ]; then echo SECRET_DO_NOT_RETURN >&2; exit 1; fi\ntouch '${join(root,'executed')}'\n`);chmodSync(binary,0o700);
    const result=await checkCodexReady(binary,{workspace:root} as Seat);assert.equal(result.ready,false);if(!result.ready)assert.equal(result.blockedOn,'auth:codex');assert.doesNotMatch(JSON.stringify(result),/SECRET/);assert.equal(existsSync(join(root,'executed')),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('native successor protocol closes stdin, requires READY and leaves binding untouched until commit',async()=>{
  const {TeamRegistry}=await import('../src/domains/teams/registry');const {CodexRuntime}=await import('../src/domains/runtime/codex');
  const root=mkdtempSync(join(tmpdir(),'orbit-successor-')),db=openCoreDatabase(join(root,'core.sqlite')),binary=join(root,'codex');
  try{
    writeFileSync(binary,`#!/usr/bin/env node\nif(process.argv.includes('--version') || process.argv.includes('status'))process.exit(0);let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{if(!text.includes('handover marker'))process.exit(2);console.log(JSON.stringify({type:'thread.started',thread_id:'fresh-native-123'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'READY'}}));});`);chmodSync(binary,0o700);
    const teams=new TeamRegistry(db,join(root,'teams')),team=teams.create('test'),seat=teams.taskSeats(team.id,'task')[0];teams.bindNative(seat.sessionId,seat.generation,'old-native-123');
    const adapter=new CodexRuntime(teams,seat.sessionId,join(root,'evidence'),()=>{},undefined,binary);const ready=await adapter.prepareSuccessor(new AbortController().signal,'handover marker');assert.equal(ready.nativeId,'fresh-native-123');assert.equal(teams.seat(seat.sessionId).nativeId,'old-native-123');
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('successor receives predecessor exchanges even without completed evidence and archives their provenance', async () => {
  const {TeamRegistry}=await import('../src/domains/teams/registry');const {CodexRuntime}=await import('../src/domains/runtime/codex');
  const root=mkdtempSync(join(tmpdir(),'orbit-record-')),db=openCoreDatabase(join(root,'core.sqlite')),binary=join(root,'codex');
  const native = new DatabaseSync(join(root,'state_5.sqlite')), record = join(root,'rollout.jsonl');
  try {
    native.exec('CREATE TABLE threads (id TEXT PRIMARY KEY,rollout_path TEXT)'); native.prepare('INSERT INTO threads VALUES (?,?)').run('failed-native-123',record);
    writeFileSync(record,[
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'原任务：修复导出问题'}]}},
      {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'失败前已查明 CSV 引号转义，补丁尚未应用。'}]}},
      {type:'event_msg',payload:{type:'turn_failed',message:'network error'}},
    ].map(e=>JSON.stringify(e)).join('\n')+'\n{partial');
    const captured = predecessorHistory('failed-native-123',root);
    assert.match(captured,/补丁尚未应用/); assert.match(captured,/rollout.jsonl/); assert.match(captured,/replayed from record/);
    assert.match(predecessorHistory('missing-native-123',root),/unavailable/);
    writeFileSync(binary,`#!/usr/bin/env node\nif(process.argv.includes('--version') || process.argv.includes('status'))process.exit(0);let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{if(!text.includes('补丁尚未应用') || !process.argv.includes('explicit-test-model'))process.exit(2);console.log(JSON.stringify({type:'thread.started',thread_id:'new-native-123'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'READY'}}));});`);chmodSync(binary,0o700);
    const teams=new TeamRegistry(db,join(root,'teams')),team=teams.create('test',{members:[{role:'worker',name:'worker',instructions:'work',model:'explicit-test-model'}],edges:[],workflow:{entry:'work',max_hops:4,steps:[{id:'work',actor_role:'worker',objective:'work'}]}}),seat=teams.taskSeats(team.id,'task')[0];
    teams.bindNative(seat.sessionId,seat.generation,'failed-native-123');
    const adapter=new CodexRuntime(teams,seat.sessionId,join(root,'evidence'),()=>{},undefined,binary,undefined,id=>predecessorHistory(id,root));
    const ready=await adapter.prepareSuccessor(new AbortController().signal,'task context');
    assert.equal(ready.nativeId,'new-native-123'); assert.equal(teams.seat(seat.sessionId).nativeId,'failed-native-123');
    const {readFileSync,readdirSync}=await import('node:fs');
    const saved = readdirSync(join(root,'evidence')).filter(f=>f.endsWith('.startup.md')).map(f=>readFileSync(join(root,'evidence',f),'utf8')).join('\n');
    assert.match(saved,/补丁尚未应用/); assert.match(saved,/rollout.jsonl/);
  } finally { native.close();db.close();rmSync(root,{recursive:true,force:true}); }
});
