// Opt-in: uses authenticated local Codex in a disposable directory.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/infrastructure/database';
import { MaterialLibrary } from '../src/domains/materials/library';
import { WorkspaceService } from '../src/application/workspace';
import { TaskExecutionService } from '../src/application/task-execution';

const root=await mkdtemp(join(tmpdir(),'orbit-handoff-live-')),db=openDatabase(join(root,'orbit.sqlite'));
const materials=new MaterialLibrary(db,join(root,'files')),workspace=new WorkspaceService(db,materials);
const service=new TaskExecutionService(db,materials,root,()=>{});
try {
  const team=service.createTeam('Graph sink smoke',{
    members:[{role:'worker',name:'Worker',instructions:'Follow the authored workflow exit. This test has no downstream work.'}],edges:[],
    workflow:{entry:'sink',max_hops:3,steps:[{id:'sink',actor_role:'worker',objective:'Report handoff at a graph sink, with no recipient.',depends_on:[],allowed_exits:['handoff']}]},
  });
  const task=workspace.submit({requestId:'handoff-smoke',text:'先调用 get_team，确认 workflowHandoff=true。调用 write_recap，recap 为 ## Decisions 后换行 ORBIT_SINK_CHECKPOINT。再调用 handoff_work，summary 为 ORBIT_SINK_DONE，recap 为 ## Decisions 后换行 ORBIT_SINK_FINAL，不填 destination。本步骤位于依赖图末端，禁止 complete_work。工具准备成功后结束本轮。',attachmentIds:[]}).tasks[0];
  await service.dispatch(task.id,team.id);
  const deadline=Date.now()+180000;
  while(Date.now()<deadline) {
    await service.sync();const status=workspace.snapshot().tasks[0].status;
    if(status==='review') break;
    if(['blocked','failed'].includes(status)) throw new Error(service.detail(task.id)?.summary);
    await new Promise(r=>setTimeout(r,500));
  }
  assert.equal(workspace.snapshot().tasks[0].status,'review');
  const [item]=service.queue.list();assert.equal(service.queue.list().length,1);assert.equal(item.state,'done');assert.equal(item.successorId,null);assert.equal(item.evidenceRef,null);
  const seat=service.teams.taskSeats(team.id,task.id)[0];
  assert.match(await readFile(join(service.teams.seatRoot(seat),'RECAP.md'),'utf8'),/ORBIT_SINK_FINAL/);
  assert.ok(service.queue.events(0,1000).some(e=>e.itemId===item.id && e.actor==='knowledge' && e.state==='in-progress'));
  assert.ok(seat.nativeId);service.accept(task.id);
  console.log('PASS: real Codex write_recap, destination-free graph handoff, no extra delegate, final recap, explicit acceptance.');
  console.log('Evidence directory:',root);
}finally{await service.close();db.close();}
