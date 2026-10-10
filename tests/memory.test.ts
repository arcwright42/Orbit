import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openCoreDatabase } from '../src/infrastructure/core-database';
import { MemoryStore, type MemoryInput, type MemoryScope } from '../src/domains/memory/store';

const team: MemoryScope = { kind: 'team', id: 'one' };
const other: MemoryScope = { kind: 'team', id: 'two' };
const input = (scope = team): MemoryInput => ({ scope, key: 'ui-preference', taxonomy: 'lore', content: '用户喜欢极简白色界面，使用 TypeScript 开发。', sourceRef: 'message:123' });

test('memory revision, scope isolation, literal multilingual retrieval, disable and delete', () => {
  const db = openCoreDatabase(':memory:'), store = new MemoryStore(db);
  try {
    const first = store.put(input(), 0), foreign = store.put(input(other), 0);
    assert.throws(() => store.put(input(), 0), /revision conflict/);
    const changed = store.put({ ...input(), content: '用户偏好极简白色界面，使用 TypeScript 编程。' }, 1);
    assert.equal(changed.id, first.id);
    assert.equal(changed.revision, 2);
    assert.equal(store.search([team], '极简界面')[0].memory.id, first.id);
    assert.equal(store.search([team], 'typescript')[0].memory.id, first.id);
    assert.equal(store.search([team], '" OR * --').length, 0);
    assert(!store.search([team], '界面').some(hit => hit.memory.id === foreign.id));
    assert.throws(() => store.setEnabled(other, first.id, false), /scope/);
    store.setEnabled(team, first.id, false);
    assert.equal(store.search([team], '界面').length, 0);
    assert.equal(store.list(team).length, 1);
    store.put(input(), 3); // editing must not silently re-enable forgotten context
    assert.equal(store.search([team], '界面').length, 0);
    store.delete(other, first.id);
    assert.equal(store.list(team).length, 1);
    store.delete(team, first.id);
    assert.equal(store.list(team).length, 0);
  } finally { db.close(); }
});

test('context selection preserves record provenance within a strict character budget', () => {
  const db = openCoreDatabase(':memory:'), store = new MemoryStore(db);
  try {
    store.put(input(), 0);
    const context = store.context([team], '界面', 1000);
    assert.equal(context.records.length, 1);
    assert.equal(JSON.parse(context.text).source, 'message:123');
    assert(context.text.length <= 1000);
    assert.deepEqual(store.context([team], '界面', 10), { records: [], text: '' });
    assert.deepEqual(store.search([], '界面'), []);
  } finally { db.close(); }
});

test('core entry preserves memory and queue across reopen and never starts work implicitly', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openExecutionCore } = await import('../src/application/execution-core');
  const directory = mkdtempSync(join(tmpdir(), 'orbit-memory-'));
  const options = { databasePath: join(directory, 'core.sqlite'), agents: new Map() };
  try {
    const core = openExecutionCore(options);
    core.memory.put(input(), 0);
    core.queue.enqueue({ requestId: 'one', taskId: 'goal', source: 'entry', destination: 'not-connected', body: 'Work' });
    await core.close();
    const reopened = openExecutionCore(options);
    try {
      assert.equal(reopened.memory.search([team], '界面')[0].memory.sourceRef, 'message:123');
      assert.equal(reopened.queue.list()[0].state, 'pending');
      assert.equal(reopened.queue.events().length, 1);
    } finally { await reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a late first projection of an older completion cannot replace a newer seat recap or its advisories', async()=>{
  const {mkdtempSync,readFileSync,readdirSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {TeamRegistry}=await import('../src/domains/teams/registry');
  const {TeamKnowledge}=await import('../src/domains/memory/team-knowledge');
  const {ExecutionQueue}=await import('../src/domains/orchestration/queue');
  const root=mkdtempSync(join(tmpdir(),'orbit-late-recap-')),db=openCoreDatabase(join(root,'core.sqlite'));
  try {
    const teams=new TeamRegistry(db,join(root,'teams')),team=teams.create('recap'),seat=teams.taskSeats(team.id,'task')[0];
    const queue=new ExecutionQueue(db),knowledge=new TeamKnowledge(new MemoryStore(db),teams,db);
    const completed=(requestId:string)=>{queue.enqueue({requestId,taskId:'task',source:'user',destination:seat.sessionId,body:'work'});const item=queue.claimNext([seat.sessionId],1)!;queue.finish(item.id,item.generation!,{kind:'completed',summary:requestId,evidenceRef:join(root,requestId+'.json')});return queue.get(item.id);};
    const older=completed('older'),newer=completed('newer');
    const evidence=(recap:string)=>({summary:recap,artifacts:[],nativeId:'test',transcript:'',recap,lessons:'source-backed lesson'});
    knowledge.record(seat,newer,evidence('## Decisions\nNewer decision with rationale.'));
    knowledge.record(seat,older,evidence('Old informal notes, no decision section.'));
    const seatRoot=teams.seatRoot(seat);
    assert.match(readFileSync(join(seatRoot,'RECAP.md'),'utf8'),/Newer decision/);
    assert.deepEqual(JSON.parse(readFileSync(join(seatRoot,'RECAP.advisories.json'),'utf8')),[]);
    assert.equal(readdirSync(join(seatRoot,'recap-superseded')).length,2);
    assert.equal(new MemoryStore(db).list({kind:'team',id:team.id}).length,2);
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});
