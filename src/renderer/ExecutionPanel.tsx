import { useEffect, useState } from 'react';
import type { LocalTeamInfo, Task, TaskExecution } from '../contracts';
export const taskStatus: Record<Task['status'], string> = { pending: '待派发', running: '进行中', blocked: '待处理', review: '待验收', completed: '已完成', failed: '失败', canceled: '已取消' };
export function ExecutionPanel({ task, refresh }: { task: Task; refresh: () => void }) {
  const [directory, setDirectory] = useState<string>();
  const [teams, setTeams] = useState<LocalTeamInfo[]>([]), [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<TaskExecution | null>(null), [answer, setAnswer] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    const update = () => { void window.orbit.localTeams().then(setTeams); void window.orbit.execution(task.id).then(setDetail).catch(e => setError(String(e))); };
    update(); const interval = setInterval(update, 2000); const off = window.orbit.onWorkspace(update); return () => { clearInterval(interval); off(); };
  }, [task.id]);
  async function run(action: () => Promise<unknown>) { setBusy(true); setError(''); try { await action(); setDetail(await window.orbit.execution(task.id)); refresh(); setAnswer(''); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  return <div className="execution-panel">
    {error && <p role="alert">{error}</p>}
    {task.status === 'pending' && <><h4>派发给团队</h4><select aria-label="执行团队" value={selected} onChange={e => setSelected(e.target.value)}><option value="">选择团队</option>{teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select><button className="secondary-button" disabled={busy} onClick={() => void run(async () => { const team = await window.orbit.createTeam(`任务团队 ${teams.length + 1}`); setTeams(await window.orbit.localTeams()); setSelected(team.id); })}>新建执行与检查团队</button><button className="primary-button" disabled={busy || !selected} onClick={() => void run(() => window.orbit.dispatchTask(task.id, selected, directory))}>开始执行</button><button className="secondary-button" disabled={busy} onClick={() => void window.orbit.pickWorkspaceDirectory().then(path => { if (path) setDirectory(path); })}>指定项目目录</button>{directory ? <p className="field-help">{directory} <button onClick={() => setDirectory(undefined)}>恢复默认</button></p> : <p className="field-help">自动建立任务目录</p>}</>}
    {detail && <><h4>{detail.phase.startsWith('human:') ? '需要你处理' : detail.phase.startsWith('exception:') ? '异常协调' : detail.phase === 'builder' ? '执行者' : detail.phase === 'reviewer' ? '检查者' : detail.phase} · {taskStatus[task.status]}</h4>{detail.pickup === 'stalled-after-claim' && <p role="status">已领取，但长时间没有新的活动证据。请检查执行状态。</p>}{detail.summary && <p className="brief">{detail.summary}</p>}
      {detail.question && <p><strong>需要你回答：</strong>{detail.question}</p>}
      {(detail.question || task.status === 'review') && <textarea aria-label="任务反馈" placeholder={detail.question ? '填写回答，继续执行…' : '填写修改要求…'} value={answer} onChange={e => setAnswer(e.target.value)} />}
      {detail.question && detail.blockedOn !== 'human:gate' && <button className="primary-button" disabled={busy || !answer.trim()} onClick={() => void run(() => window.orbit.answerTask(task.id, answer))}>{detail.blockedOn === 'human:exception' ? '记录处理意见' : '回答并继续'}</button>}
      {detail.blockedOn === 'human:gate' && <button className="primary-button" disabled={busy} onClick={() => void run(() => window.orbit.approveTaskStep(task.id, answer || '用户批准执行该步骤'))}>批准执行此步骤</button>}
      {detail.workspace && <p className="field-help">{detail.workspace}</p>}
      {detail.steps && detail.steps.length > 1 && <div>{detail.steps.map(s => <p className="field-help" key={s.id}>{s.id} · {s.role} · {s.state}</p>)}</div>}
      {task.status === 'review' && <><button className="primary-button" disabled={busy} onClick={() => void run(() => window.orbit.acceptTask(task.id))}>验收通过</button><button className="secondary-button" disabled={busy || !answer.trim()} onClick={() => void run(() => window.orbit.reviseTask(task.id, answer))}>提交修改要求</button></>}
      {['blocked', 'failed'].includes(task.status) && (!detail.question || detail.blockedOn === 'human:exception') && detail.blockedOn !== 'runtime:unknown' && <button className="secondary-button" disabled={busy} onClick={() => void run(() => window.orbit.retryTask(task.id))}>重试已停止的执行</button>}
      {['blocked','failed'].includes(task.status) && (!detail.question || detail.blockedOn === 'human:exception') && detail.blockedOn !== 'runtime:unknown' && <button className="secondary-button" disabled={busy} onClick={() => void run(() => window.orbit.rotateTaskSession(task.id))}>新会话接替</button>}
      {detail.blockedOn === 'runtime:unknown' && <><p>上次进程是否仍在执行尚不明确。请先核对运行时，确认停止后才能恢复。</p><button className="secondary-button" disabled={busy} onClick={() => void run(() => window.orbit.reconcileTask(task.id))}>我已确认原执行停止，恢复任务</button></>}
      {!!detail.artifacts.length && <><h4>成果文件</h4>{detail.artifacts.map((file, index) => <button className="file-chip" key={file} onClick={() => void run(() => window.orbit.openResult(task.id, index))}>{file.split('/').at(-1)}</button>)}</>}
      <details><summary>执行记录</summary>{detail.events.map(e => <p className="field-help" key={e.seq}>{new Date(e.at).toLocaleTimeString()} · {e.note}</p>)}</details></>}
    {['running', 'blocked'].includes(task.status) && <button className="secondary-button" disabled={busy} onClick={() => void run(() => window.orbit.cancelTask(task.id))}>取消执行</button>}
  </div>;
}
export function LocalTeams() {
  const [templates, setTemplates] = useState<{ id: string; name: string; description: string }[]>([]), [template, setTemplate] = useState('build-review');
  const [teams, setTeams] = useState<LocalTeamInfo[]>([]), [name, setName] = useState(''), [error, setError] = useState('');
  const refresh = () => window.orbit.localTeams().then(setTeams);
  useEffect(() => { void window.orbit.teamTemplates().then(setTemplates); void refresh(); return window.orbit.onWorkspace(() => { void refresh(); }); }, []);
  return <><div className="connection-input"><input aria-label="新团队名称" placeholder="团队名称" value={name} onChange={e => setName(e.target.value)} /><select aria-label="团队模板" value={template} onChange={e => setTemplate(e.target.value)}>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select><button className="primary-button" disabled={!name.trim()} onClick={async () => { try { await window.orbit.createTeam(name, undefined, template); setName(''); await refresh(); } catch (e) { setError(String(e)); } }}>创建团队</button></div>{error && <p role="alert">{error}</p>}<div className="team-grid">{teams.map(team => <div className="team-card" key={team.id}><h3>{team.name}</h3><p>{team.seats.map(s => s.name).join(' · ')}</p><p className="field-help">Codex · 团队经验持续积累</p><button className="secondary-button" onClick={async () => { try { await window.orbit.importContextPack(team.id); await refresh(); } catch (e) { setError(String(e)); } }}>{team.contextPack ? '更换上下文包' : '导入上下文包'}</button></div>)}</div></>;
}
