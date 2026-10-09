// Opt-in integration: authenticated local Codex, disposable task workspace; no foreground model needed.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/infrastructure/database';
import { MaterialLibrary } from '../src/domains/materials/library';
import { WorkspaceService } from '../src/application/workspace';
import { TaskExecutionService } from '../src/application/task-execution';
const root = await mkdtemp(join(tmpdir(), 'orbit-team-live-'));
const db = openDatabase(join(root, 'orbit.sqlite'));
const materials = new MaterialLibrary(db, join(root, 'files')), workspace = new WorkspaceService(db, materials);
const service = new TaskExecutionService(db, materials, root, () => {});
try {
  const team = service.createTeam('Codex 集成验证', undefined, 'build-review');
  const task = workspace.submit({ requestId: 'live-team-test', text: '先调用平台工具 get_team 和 list_work，再调用 report_progress，note 严格为 ORBIT_BACKEND_TOOL_OK。最后通过 complete_work 提交成果。在工作目录创建 hello.txt，内容严格为 ORBIT_TEAM_OK（无换行）。执行者完成后返回 completed。检查者独立读取核对，正确则 verdict=pass。artifacts 列 hello.txt。recap 解释验证依据，lessons 记录本项目精确文本文件检查方法。', attachmentIds: [] }).tasks[0];
  await service.dispatch(task.id, team.id);
  const deadline = Date.now() + 240000; let previous = '';
  while (Date.now() < deadline) {
    await service.sync(); const taskState = workspace.snapshot().tasks[0]; const detail = service.detail(task.id);
    const status = `${taskState.status}:${detail?.phase}:${detail?.state}`;
    if (status !== previous) { console.log(status); previous = status; }
    if (['failed','blocked'].includes(taskState.status)) throw new Error(detail?.summary ?? taskState.status);
    if (taskState.status === 'review') break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.equal(workspace.snapshot().tasks[0].status, 'review');
  const detail = service.detail(task.id)!;
  assert.equal(await readFile(detail.artifacts.find(p => p.endsWith('/hello.txt'))!, 'utf8'), 'ORBIT_TEAM_OK');
  assert.ok(service.teams.taskSeats(team.id, task.id).every(s => s.nativeId));
  assert.ok(service.queue.list().every(item => service.queue.events(0,1000).some(e => e.itemId === item.id && e.note === 'ORBIT_BACKEND_TOOL_OK')));
  assert.equal(service.memory.list({ kind: 'team', id: team.id }).length, 2);
  service.accept(task.id); assert.equal(workspace.snapshot().tasks[0].status, 'completed');
  console.log('PASS: real Codex builder/reviewer, structured verdict, artifact, team learning, user acceptance.');
  console.log('Evidence directory:', root);
} finally { await service.close(); db.close(); }
