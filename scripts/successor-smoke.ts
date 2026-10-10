// Opt-in: one real Codex readiness turn; no task execution or user workspace writes.
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openCoreDatabase } from '../src/infrastructure/core-database';
import { TeamRegistry } from '../src/domains/teams/registry';
import { CodexRuntime } from '../src/domains/runtime/codex';
import { transaction } from '../src/infrastructure/database';
import { defaultTeamConfig } from '../src/domains/workflows/spec';
const root=await mkdtemp(join(tmpdir(),'orbit-successor-live-')),db=openCoreDatabase(join(root,'core.sqlite'));
try {
  const config=structuredClone(defaultTeamConfig);config.startup={team:{actions:[{type:'startup_proof',value:'authenticated',idempotent:true}]}};
  const teams=new TeamRegistry(db,join(root,'teams')),team=teams.create('Successor readiness',config),seat=teams.taskSeats(team.id,'probe')[0];
  teams.bindNative(seat.sessionId,seat.generation,'prior-binding-for-probe');
  const prior=teams.beginSuccessor(seat.sessionId),adapter=new CodexRuntime(teams,seat.sessionId,join(root,'evidence'),()=>{});
  const ready=await adapter.prepareSuccessor(new AbortController().signal,'这是一次接替协议验证。无未完成工作，不修改任何文件。');
  assert.equal(teams.seat(seat.sessionId).nativeId,'prior-binding-for-probe');
  transaction(db,()=>teams.commitSuccessor(seat.sessionId,prior.generation,ready.nativeId));
  assert.equal(teams.seat(seat.sessionId).nativeId,ready.nativeId);
  assert.notEqual(teams.seat(seat.sessionId).generation,prior.generation);
  assert.equal(db.prepare('SELECT count(*) AS n FROM seat_session_lineage').get()!.n,1);
  const proofs=await Promise.all((await readdir(join(root,'evidence'))).filter(f=>f.endsWith('.startup-proof.json')).map(async f=>JSON.parse(await readFile(join(root,'evidence',f),'utf8'))));
  assert.ok(proofs.some(p=>p.status==='verified'));
  console.log('PASS: real Codex auth/version checks, native READY plus authenticated orientation receipt, old binding preserved until fenced commit, lineage retained.');
} finally {db.close();await rm(root,{recursive:true,force:true});}
