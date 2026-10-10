import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, statSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCoreDatabase } from '../src/infrastructure/core-database';
import { TeamRegistry } from '../src/domains/teams/registry';
import { ExecutionQueue } from '../src/domains/orchestration/queue';
import { CodexRuntime } from '../src/domains/runtime/codex';
import { BackendAttempt } from '../src/domains/runtime/backend-tools';
import { resolveStartup, prepareStartup } from '../src/domains/runtime/startup';
import { StartupProof } from '../src/domains/runtime/startup-proof';
import { validateTeamConfig, type TeamConfig } from '../src/domains/workflows/spec';

function fixture(proof = false) {
  const root=mkdtempSync(join(tmpdir(),'orbit-startup-')),db=openCoreDatabase(join(root,'core.sqlite')),source=join(root,'source'),binary=join(root,'codex');
  mkdirSync(join(source,'skill','scripts'),{recursive:true});
  writeFileSync(join(source,'guide.md'),'# Team guidance\nUse real evidence.');
  writeFileSync(join(source,'brief.md'),'SOURCE FILE CONTEXT');
  writeFileSync(join(source,'skill','SKILL.md'),'---\nname: audit\ndescription: Review artifacts\n---\nRun scripts/check.sh');
  writeFileSync(join(source,'skill','scripts','check.sh'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  const config:TeamConfig={members:[{role:'worker',name:'Worker',instructions:'Work',startup:{actions:[{type:'send_text',value:'MEMBER ACTION',idempotent:true}]}}],edges:[],
    startup:{source_root:source,agent:{files:[{path:'guide.md',delivery_hint:'guidance_merge'},{path:'skill/SKILL.md',delivery_hint:'skill_install'}]},team:{files:[{path:'brief.md',delivery_hint:'send_text'}],actions:[{type:'send_text',value:'TEAM ACTION',idempotent:true},...(proof ? [{type:'startup_proof' as const,value:'authenticated',idempotent:true}] : [])]}},
    workflow:{entry:'work',max_hops:4,steps:[{id:'work',actor_role:'worker',objective:'Work'}]}};
  const teams=new TeamRegistry(db,join(root,'teams')),team=teams.create('startup',config),seat=teams.taskSeats(team.id,'task')[0],queue=new ExecutionQueue(db);
  writeFileSync(join(seat.workspace,'AGENTS.md'),'# User-owned instructions\nKeep this text.\n');
  queue.enqueue({requestId:'start',taskId:'task',source:'human:user',destination:seat.sessionId,body:'test'});
  const item=queue.claimNext([seat.sessionId],1)!;
  return {root,db,source,binary,teams,team,seat,item,config,close(){db.close();rmSync(root,{recursive:true,force:true});}};
}

test('startup merges ordered layers, preserves duplicates and rejects unsafe restore actions',()=>{
  const env=fixture();
  try {
    const block=resolveStartup({...env.config.startup,profile:{actions:[{type:'send_text',value:'PROFILE',idempotent:true}]},operator:{actions:[{type:'send_text',value:'MEMBER ACTION',idempotent:true}]}},env.config.members[0].startup,'fresh_start');
    assert.deepEqual(block.actions.map(a=>a.value),['PROFILE','TEAM ACTION','MEMBER ACTION','MEMBER ACTION']);
    const bad=structuredClone(env.config); bad.members[0].startup!.actions![0].idempotent=false;
    assert.throws(()=>validateTeamConfig(bad),/restore/);
    bad.members[0].startup!.actions![0].applies_on=['fresh_start'];assert.doesNotThrow(()=>validateTeamConfig(bad));
  } finally {env.close();}
});

test('startup projection installs complete local skills, preserves user guidance and refuses changed owned files',()=>{
  const env=fixture();
  try {
    const first=prepareStartup(env.seat,env.config.startup,join(env.root,'evidence'),'first','fresh_start');
    const skill=join(env.seat.workspace,'.agents','skills',`orbit-${env.seat.id}-skill`,'scripts','check.sh');
    assert.ok(existsSync(skill));assert.ok(statSync(skill).mode & 0o100);
    assert.match(readFileSync(join(env.seat.workspace,'AGENTS.md'),'utf8'),/User-owned instructions/);
    assert.match(first.text,/SOURCE FILE CONTEXT/);assert.ok(first.text.indexOf('TEAM ACTION')<first.text.indexOf('MEMBER ACTION'));
    prepareStartup(env.seat,env.config.startup,join(env.root,'evidence'),'again','restore');
    assert.equal(readFileSync(join(env.seat.workspace,'AGENTS.md'),'utf8').split('Use real evidence.').length,2);
    writeFileSync(skill,'user modification');
    assert.throws(()=>prepareStartup(env.seat,env.config.startup,join(env.root,'evidence'),'conflict','restore'),/conflict/);
    assert.equal(readFileSync(skill,'utf8'),'user modification');
  } finally {env.close();}
});

test('runtime refuses missing startup files before launch and requires authenticated proof independently of result text',async()=>{
  const env=fixture(true);
  try {
    writeFileSync(env.binary,`#!/usr/bin/env node
const fs=require('node:fs');if(process.argv.includes('--version')||process.argv.includes('status'))process.exit(0);
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',async()=>{
fs.writeFileSync('launched','yes'); console.log(JSON.stringify({type:'thread.started',thread_id:'startup-native-123'}));
if(!prompt.includes('SOURCE FILE CONTEXT')||!fs.readFileSync('AGENTS.md','utf8').includes('Use real evidence.'))process.exit(2);
if(!fs.existsSync('skip-proof')){
 const proof=JSON.parse(prompt.match(/ORBIT_STARTUP_PROOF (.+)/)[1]);
 await new Promise(r=>setTimeout(r,20));
 const call=async(input)=>fetch(process.env.ORBIT_AGENT_ENDPOINT,{method:'POST',headers:{Authorization:'Bearer '+process.env.ORBIT_AGENT_TOKEN},body:JSON.stringify({name:'startup_proof',input,requestId:require('node:crypto').randomUUID()})});
 if((await call({...proof,answer:'READY'})).status!==400)process.exit(3);
 if((await call(proof)).status!==200)process.exit(4);
}
fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],JSON.stringify({outcome:'completed',summary:'READY',artifacts:[]}));
});`);chmodSync(env.binary,0o700);
    const runtime=new CodexRuntime(env.teams,env.seat.sessionId,join(env.root,'evidence'),()=>{},undefined,env.binary,()=>new BackendAttempt(()=>({value:{}})));
    rmSync(join(env.source,'brief.md'));
    const missing=await runtime.execute(env.item,new AbortController().signal);
    assert.equal(missing.kind,'blocked');assert.equal(existsSync(join(env.seat.workspace,'launched')),false);
    writeFileSync(join(env.source,'brief.md'),'SOURCE FILE CONTEXT');
    writeFileSync(join(env.seat.workspace,'skip-proof'),'yes');
    const unproven=await runtime.execute(env.item,new AbortController().signal);
    assert.equal(unproven.kind,'blocked'); if(unproven.kind==='blocked') assert.equal(unproven.blockedOn,'context:startup-proof');
    // A failed fresh orientation is not laundered into a proven resume on the next attempt.
    rmSync(join(env.seat.workspace,'skip-proof'));
    const proven=await runtime.execute(env.item,new AbortController().signal);assert.equal(proven.kind,'completed',JSON.stringify(proven));
  } finally {env.close();}
});

test('startup proofs are generation bound, reject stale/identity-mismatched answers, and do not imply model understanding',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-proof-'));
  try {
    let generation='one';
    const proof=new StartupProof(root,'attempt',{sessionId:'session-one',generation:'one'},'contract','authenticated',()=>generation==='one');
    proof.bindNative('native-one');
    assert.throws(()=>proof.verify({...proof.submission,sessionId:'session-two'}),/identity/);
    assert.throws(()=>proof.verify({...proof.submission,answer:'READY'}),/bare_ack/);
    assert.throws(()=>proof.verify({...proof.submission,challengeId:'old'}),/stale/);
    assert.equal(proof.verified,false);proof.verify(proof.submission);assert.equal(proof.verified,true);
    assert.equal(StartupProof.needsOrientation(root,{sessionId:'session-one',generation:'one',nativeId:'native-one'}),false);
    assert.equal(StartupProof.needsOrientation(root,{sessionId:'session-one',generation:'one',nativeId:'rolled-back-native'}),true);
    generation='two';assert.throws(()=>proof.verify(proof.submission),/generation/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('native restore retains fresh-only installed resources; an undeclared guidance link is left alone',()=>{
  const env=fixture();
  try {
    for(const file of env.config.startup!.agent!.files!) file.applies_on=['fresh_start'];
    prepareStartup(env.seat,env.config.startup,join(env.root,'evidence'),'fresh','fresh_start');
    const agents=readFileSync(join(env.seat.workspace,'AGENTS.md'),'utf8');
    rmSync(join(env.source,'guide.md'));rmSync(join(env.source,'skill'),{recursive:true});
    prepareStartup(env.seat,env.config.startup,join(env.root,'evidence'),'restored','restore');
    assert.equal(readFileSync(join(env.seat.workspace,'AGENTS.md'),'utf8'),agents);
    assert.ok(existsSync(join(env.seat.workspace,'.agents','skills',`orbit-${env.seat.id}-skill`,'scripts','check.sh')));
    const other=join(env.root,'user-project');mkdirSync(other);symlinkSync(join(env.source,'brief.md'),join(other,'AGENTS.md'));
    assert.doesNotThrow(()=>prepareStartup({...env.seat,workspace:other,startup:undefined},undefined,join(env.root,'empty-evidence'),'plain','fresh_start'));
  } finally {env.close();}
});
