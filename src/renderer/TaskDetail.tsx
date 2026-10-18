import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, CheckCircle2, FileText, FolderOpen, GitBranch, LoaderCircle, Play, RotateCcw, ShieldCheck, X } from 'lucide-react';
import type { Attachment } from '../contracts';
import type { TaskDetail as Detail, TaskEvent, TaskQuestion } from '../domains/tasks/execution';
import { RUNTIME_LABELS, STEP_LABELS, TASK_LABELS, taskError, taskTime } from './task-presentation';

const mergeEvents = (old: TaskEvent[], fresh: TaskEvent[]) => [...new Map([...old, ...fresh].map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq);

export function TaskDetail({ taskId, attachments, onClose, onChanged }: {
  taskId: string; attachments: Attachment[]; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const version = useRef(0);
  const alive = useRef(true);
  const locked = useRef(false);
  const paging = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const restoreFocus = useRef(document.activeElement as HTMLElement | null);
  const refresh = useCallback(async () => {
    const request = ++version.current;
    try {
      const next = await window.orbit.execution.detail(taskId);
      if (alive.current && request === version.current) setDetail(previous => ({ ...next, events: mergeEvents(previous?.events ?? [], next.events), nextBefore: previous ? previous.nextBefore : next.nextBefore }));
    } catch (failure) { if (alive.current && request === version.current) setError(taskError(failure)); }
  }, [taskId]);
  useEffect(() => {
    alive.current = true;
    const previousFocus = restoreFocus.current;
    const unsubscribe = window.orbit.execution.onChanged(event => { if (event.taskId === taskId) void refresh(); });
    void refresh();
    return () => { alive.current = false; version.current++; unsubscribe(); queueMicrotask(() => { if (previousFocus?.isConnected) previousFocus.focus(); }); };
  }, [taskId, refresh]);
  async function action(label: string, operation: () => Promise<unknown>) {
    if (locked.current) return;
    locked.current = true; setBusy(label); setError('');
    try { await operation(); await Promise.all([refresh(), onChanged()]); }
    catch (failure) { if (alive.current) setError(taskError(failure)); }
    finally { locked.current = false; if (alive.current) setBusy(''); }
  }
  async function older() {
    if (paging.current || !detail?.nextBefore) return;
    paging.current = true; setLoadingOlder(true);
    try {
      const page = await window.orbit.execution.detail(taskId, detail.nextBefore);
      if (alive.current) setDetail(current => current ? { ...current, events: mergeEvents(page.events, current.events), nextBefore: page.nextBefore } : page);
    } catch (failure) { if (alive.current) setError(taskError(failure)); }
    finally { paging.current = false; if (alive.current) setLoadingOlder(false); }
  }
  const task = detail?.task;
  const pendingQuestions = detail?.runs.flatMap(run => run.questions.filter(question => question.status === 'pending').map(question => ({ question, stepId: run.stepId }))) ?? [];
  const completed = detail?.steps.filter(step => step.status === 'completed').length ?? 0;
  return <div className="modal-backdrop" onClick={onClose}>
    <section ref={dialog} className="task-detail execution-detail" role="dialog" aria-modal="true" aria-labelledby="task-title" onClick={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const items = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), summary, [tabindex="0"]')].filter(item => item.getClientRects().length);
        const first = items[0]; const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="detail-top"><span className="eyebrow">任务详情 · ORB-{taskId.slice(0, 6).toUpperCase()}</span><button className="icon-button" aria-label="关闭任务详情" autoFocus onClick={onClose}><X size={20} /></button></div>
      <h2 id="task-title">{task?.title ?? '正在读取任务…'}</h2>
      {error && <p className="task-error" role="alert">{error}</p>}
      {!task || !detail ? <div className="detail-loading">{error ? <button className="secondary-button" onClick={() => void refresh()}>重新加载</button> : <LoaderCircle className="spin" />}</div> : <>
        <div className="detail-meta"><span className={'badge status-' + task.status}>{TASK_LABELS[task.status]}</span>{task.execution && <span>{RUNTIME_LABELS[task.execution.selection.runtime]} · {task.execution.mode === 'plan' ? '先规划后执行' : '直接执行'}</span>}<time>{taskTime(task.createdAt)}</time></div>
        <div className="task-actions" aria-label="任务操作">
          {task.status === 'pending' && <><button className="primary-button" disabled={!!busy} onClick={() => void action('正在派发', () => window.orbit.execution.dispatch(taskId, 'direct'))}><Play size={14} />直接执行</button><button className="secondary-button" disabled={!!busy} onClick={() => void action('正在派发', () => window.orbit.execution.dispatch(taskId, 'plan'))}><GitBranch size={15} />先规划再执行</button></>}
          {['failed', 'interrupted'].includes(task.status) && <button className="primary-button" disabled={!!busy} onClick={() => void action('正在恢复', () => window.orbit.execution.retry(taskId))}><RotateCcw size={14} />重试未完成步骤</button>}
          {task.status === 'review' && <button className="primary-button" disabled={!!busy} onClick={() => void action('正在验收', () => window.orbit.execution.accept(taskId))}><CheckCircle2 size={15} />验收通过</button>}
          {!['completed', 'canceled'].includes(task.status) && <button className="secondary-button cancel-task" disabled={!!busy} onClick={() => void action('正在取消', () => window.orbit.cancelTask(taskId))}>{task.status === 'pending' ? '取消这项待派发任务' : task.status === 'canceling' ? '重新确认取消' : '取消任务'}</button>}
          {task.execution && <button className="text-button" disabled={!!busy} onClick={() => void action('正在打开', () => window.orbit.execution.openDirectory(taskId))}><FolderOpen size={15} />任务文件夹</button>}
          {busy && <span className="action-status" role="status"><LoaderCircle size={13} className="spin" />{busy}…</span>}
        </div>
        {task.status === 'canceling' && <p className="field-help">正在等待执行进程停止，已有成果会保留。</p>}
        {!!pendingQuestions.length && <section className="task-questions" aria-label="待处理问题">
          {pendingQuestions.map(({ question, stepId }) => <Question key={question.id} question={question} stepName={detail.steps.find(step => step.id === stepId)?.name ?? stepId} busy={!!busy}
            answer={answer => action('正在提交答复', () => window.orbit.execution.answer(taskId, question.id, answer))} />)}
        </section>}
        <section className="task-brief"><h3>你的要求</h3><p className="brief">{task.brief || '仅提供了附件，执行前需要明确目标。'}</p>
          {!!task.attachmentIds.length && <div aria-label="相关资料">{task.attachmentIds.map(id => {
            const file = attachments.find(item => item.id === id);
            return file && <button className="file-chip" key={id} onClick={() => void action('正在打开', () => window.orbit.openAttachment(id))}><FileText size={14} />{file.name}</button>;
          })}</div>}
        </section>
        {detail.steps.length > 0 && <section className="task-steps" aria-label="执行步骤">
          <div className="section-heading"><h3>执行步骤</h3><span>{completed} / {detail.steps.length} 已完成</span></div>
          <div className="task-progress" role="progressbar" aria-label="步骤完成进度" aria-valuenow={completed} aria-valuemin={0} aria-valuemax={detail.steps.length}><span style={{ width: completed / detail.steps.length * 100 + '%' }} /></div>
          <ol className="step-list">{detail.steps.map((step, index) => {
            const run = detail.runs.find(run => run.id === step.currentRunId);
            return <li key={step.id} className={'step-card step-' + step.status}>
              <span className="step-number">{step.status === 'completed' ? <Check size={14} /> : step.status === 'running' ? <LoaderCircle size={14} className="spin" /> : index + 1}</span>
              <div className="step-content"><div className="step-heading"><h4>{step.name}</h4><span className={'badge status-' + step.status}>{STEP_LABELS[step.status]}</span></div>
                <p className="step-meta">{step.id}{run && <> · 第 {run.attempt} 次执行</>}{step.dependsOn.length > 0 && <> · 依赖 {step.dependsOn.map(id => detail.steps.find(item => item.id === id)?.name ?? id).join('、')}</>}</p>
                <p className="step-instruction">{step.instruction}</p>
                {step.error && <p className="task-error">{step.error}</p>}
                {step.result && <div className="step-result"><p>{step.result.summary}</p>{step.result.artifacts.map(artifact => <button className="artifact-link" key={artifact.path} onClick={() => void action('正在打开', () => window.orbit.execution.openArtifact(taskId, artifact.path))}><FileText size={14} /><span>{artifact.path.split('/').slice(2).join('/')}</span><small>{Math.max(1, Math.ceil(artifact.size / 1024))} KB</small><ArrowUpRight size={13} /></button>)}</div>}
              </div>
            </li>;
          })}</ol>
          {task.status === 'review' && <p className="review-note"><CheckCircle2 size={16} />全部步骤已完成。查看成果后，可以在上方验收。</p>}
        </section>}
        {detail.events.length > 0 && <section className="task-event-section" aria-label="任务进展"><div className="section-heading"><h3>任务进展</h3><span>自动更新</span></div>
          <ol className="task-events">{[...detail.events].reverse().map(event => <li key={event.seq}><time>{taskTime(event.createdAt)}</time><p>{event.message}</p></li>)}</ol>
          {detail.nextBefore && <button className="text-button" disabled={loadingOlder} onClick={() => void older()}>{loadingOlder ? '正在加载…' : '加载更早进展'}</button>}
        </section>}
        {detail.runs.length > 0 && <details className="run-records"><summary>执行记录 · {detail.runs.length} 次</summary>{detail.runs.map(run => <div key={run.id}><strong>{run.stepId} · 第 {run.attempt} 次</strong><span>{RUNTIME_LABELS[run.selection.runtime]} · {run.status}</span><code>{run.nativeSession ?? '原生会话尚未建立'}</code>{run.error && <p>{run.error}</p>}</div>)}</details>}
      </>}
    </section>
  </div>;
}

function Question({ question, stepName, busy, answer }: { question: TaskQuestion; stepName: string; busy: boolean; answer: (value: string) => Promise<void> }) {
  const [value, setValue] = useState('');
  const approval = question.kind === 'approval';
  return <article className="task-question"><div className="question-heading">{approval ? <ShieldCheck size={17} /> : <MessageIcon />}<strong>{approval ? '需要你授权' : '需要你补充信息'}</strong><span>{stepName}</span></div><pre>{question.prompt}</pre>
    {approval ? <div className="question-actions"><button className="primary-button" disabled={busy} onClick={() => void answer('approve')}>允许本次操作</button><button className="secondary-button" disabled={busy} onClick={() => void answer('deny')}>拒绝</button></div>
      : <form onSubmit={event => { event.preventDefault(); if (value.trim() && !busy) void answer(value.trim()); }}><label htmlFor={'answer-' + question.id}>你的答复</label><textarea id={'answer-' + question.id} value={value} maxLength={16000} disabled={busy} onChange={event => setValue(event.target.value)} placeholder="补充信息后继续执行" /><button className="primary-button" disabled={busy || !value.trim()} type="submit">发送答复</button></form>}
  </article>;
}
function MessageIcon() { return <span className="question-mark">?</span>; }
