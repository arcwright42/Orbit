import { ModelSettings } from './ModelSettings';
import { ExecutionPanel, LocalTeams, taskStatus } from './ExecutionPanel';
import { useVoice } from './useVoice';
import { TaskBoard } from './TaskBoard';
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, AudioLines, Check, ChevronRight, Circle, PanelLeft, FileText, FolderOpen, Layers3, LoaderCircle, MessageSquare, Orbit, Plus, Settings2, Users, X } from 'lucide-react';
import type { Attachment, ConnectionResult, Workspace } from '../contracts';

type Page = 'home' | 'tasks' | 'teams' | 'files' | 'settings';
const labels: Record<Page, string> = { home: '主入口', tasks: '任务', teams: '团队', files: '文件', settings: '设置' };
const sizeLabel = (size: number) => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const timeLabel = (date: string) => new Date(date).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const messageError = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '操作失败，请重试。';

export function App() {
  const [data, setData] = useState<Workspace>();
  const voice = useVoice(() => { void window.orbit.workspace().then(setData); });
  const [page, setPage] = useState<Page>('home');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [partial, setPartial] = useState('');
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [url, setUrl] = useState('');
  const [connection, setConnection] = useState<ConnectionResult>();
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const lock = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    window.orbit.workspace().then(snapshot => { setData(snapshot); setUrl(snapshot.settings.openrigUrl); }).catch(e => setError(messageError(e)));
  }, []);
  useEffect(() => window.orbit.onChat(event => {
    if (event.type === 'state') { setChatBusy(event.busy); if (!event.busy) setPartial(''); }
    if (event.type === 'compaction') setCompacting(event.active);
    if (event.type === 'delta') setPartial(value => value + event.text);
    if (event.type === 'error') setError(event.text);
  }), []);
  useEffect(() => window.orbit.onWorkspace(() => { void window.orbit.workspace().then(setData); }), []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [data?.messages.length, page]);
  const active = data?.tasks.filter(task => ['pending', 'running', 'blocked', 'review'].includes(task.status)) ?? [];
  const detail = data?.tasks.find(task => task.id === selected);

  async function submit(chat = false) {
    if (lock.current || (!draft.trim() && !attachments.length)) return;
    lock.current = true; setBusy(true); setError('');
    try {
      if (chat) await window.orbit.chatText(draft, attachments.map(item => item.id));
      else setData(await window.orbit.submit({ requestId: requestId.current, text: draft, attachmentIds: attachments.map(item => item.id) }));
      setDraft(''); setAttachments([]); requestId.current = crypto.randomUUID();
    } catch (e) { setError(messageError(e)); }
    finally { lock.current = false; setBusy(false); inputRef.current?.focus(); }
  }
  async function pick() {
    if (picking || busy || attachments.length >= 8) return;
    setPicking(true); setError('');
    try {
      const added = await window.orbit.pickAttachments();
      setAttachments(current => [...current, ...added]);
      setData(await window.orbit.workspace());
      if (added.length) requestId.current = crypto.randomUUID();
    } catch (e) { setError(messageError(e)); }
    finally { setPicking(false); }
  }
  async function inspectConnection() {
    setChecking(true); setError(''); setSaved(false); setConnection(undefined);
    try {
      setData(await window.orbit.saveConnection(url));
      setSaved(true);
      setConnection(await window.orbit.checkConnection());
    } catch (e) { setError(messageError(e)); }
    finally { setChecking(false); }
  }
  const openFile = (id: string) => window.orbit.openAttachment(id).catch(e => setError(messageError(e)));
  const selectPage = (next: Page) => { setPage(next); setError(''); };

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'is-open' : 'is-collapsed'}`} inert={!sidebarOpen}>
      <div className="brand"><span className="brand-mark"><Orbit size={24} strokeWidth={1.6} /></span><span>Orbit</span></div>
      <button className="new-button" onClick={() => { selectPage('home'); setTimeout(() => inputRef.current?.focus(), 0); }}><Plus size={17} /> 新需求</button>
      <nav aria-label="主导航">
        {([{ key: 'home', icon: MessageSquare }, { key: 'tasks', icon: Layers3 }, { key: 'teams', icon: Users }, { key: 'files', icon: FolderOpen }] as const).map(({ key, icon: Icon }) =>
          <button key={key} className={`nav-item ${page === key ? 'active' : ''}`} aria-current={page === key ? 'page' : undefined} onClick={() => selectPage(key)}><Icon size={18} />{labels[key]}{key === 'tasks' && active.length > 0 && <span className="count">{active.length}</span>}</button>)}
      </nav>
      {!!data?.tasks.length && <div className="sidebar-section">最近任务</div>}
      <div className="recent-list">{data?.tasks.slice(0, 5).map(task => <button key={task.id} onClick={() => setSelected(task.id)}><Circle size={9} /><span>{task.title}</span></button>)}</div>
      <div className="sidebar-bottom"><button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => selectPage('settings')}><Settings2 size={18} />设置</button></div>
    </aside>
    <main className="main">
      <header className="topbar"><div><button className="icon-button" aria-label="切换侧栏" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(open => !open)}><PanelLeft size={18} /></button><span>{page === 'home' ? 'Orbit' : labels[page]}</span></div><button className="icon-button" aria-label="设置" onClick={() => selectPage('settings')}><Settings2 size={17} /></button></header>
      {error && <div className="error-banner" role="alert">{error}<button aria-label="关闭错误" onClick={() => setError('')}><X size={16} /></button></div>}
      {!data ? <div className="empty-state"><LoaderCircle className="spin" /><h2>正在打开你的工作空间</h2>{error && <button onClick={() => location.reload()}>重新加载</button>}</div> : <>
        {page === 'home' && <section className={`home ${data.messages.length ? 'has-messages' : ''}`}>
          {data.messages.length === 0 ? null : <div className="messages">{data.messages.map(message => <article key={message.id} className={`message ${message.role}`}><div className="message-heading">{message.role === 'user' ? <span className="mini-avatar">你</span> : <Orbit size={19} />}<strong>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'Orbit' : 'Orbit · 系统回执'}</strong><time>{timeLabel(message.createdAt)}</time></div><p>{message.text}</p>{message.role === 'user' && data.tasks.find(task => task.id === message.taskId)?.attachmentIds.map(id => { const file = data.attachments.find(item => item.id === id); return file && <button className="file-chip" key={id} onClick={() => openFile(id)}><FileText size={14} />{file.name}</button>; })}{message.role === 'system' && <button className="inline-task" onClick={() => setSelected(message.taskId)}><Layers3 size={17} /><span>{data.tasks.find(task => task.id === message.taskId)?.title}</span><span className="badge">{taskStatus[data.tasks.find(task => task.id === message.taskId)?.status ?? 'pending']}</span><ChevronRight size={15} /></button>}</article>)}<div ref={bottomRef} /></div>}
          <div className="composer-area">{chatBusy && <div className="text-progress" role="status"><span>{compacting ? '正在整理上下文…' : partial || '正在思考…'}</span><button className="secondary-button" onClick={() => void window.orbit.stopText()}>停止回复</button></div>}<div className="composer">{attachments.length > 0 && <div className="attachment-row">{attachments.map(file => <span className="file-chip" key={file.id}><FileText size={14} />{file.name}<button disabled={busy} aria-label={`移除 ${file.name}`} onClick={() => { setAttachments(current => current.filter(item => item.id !== file.id)); requestId.current = crypto.randomUUID(); }}><X size={13} /></button></span>)}</div>}<textarea ref={inputRef} aria-label="你的需求" placeholder="想做些什么？" value={draft} maxLength={16000} disabled={busy} onChange={event => { setDraft(event.target.value); requestId.current = crypto.randomUUID(); }} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(true); } }} /><div className="composer-tools"><div><button className="attach-button" aria-label="添加附件" title="图片或文档 · 每个最多 25 MB" disabled={picking || busy || attachments.length >= 8} onClick={pick}>{picking ? <LoaderCircle size={19} className="spin" /> : <Plus size={18} />}<span>添加文件</span></button><button className="icon-button" aria-label={voice.state === 'off' ? '开始语音' : '结束语音'} title="语音对话" onClick={() => { if (voice.state === 'off') void voice.start(false); else void voice.stop(); }}><AudioLines size={19} /></button></div><button className="icon-button" aria-label="保存需求" title="仅保存，不派发" disabled={busy || (!draft.trim() && !attachments.length)} onClick={() => void submit(false)}><FileText size={18} /></button><button className="send" aria-label="发送" disabled={busy || picking || (!draft.trim() && !attachments.length)} onClick={() => void submit(true)}>{busy ? <LoaderCircle size={19} className="spin" /> : <ArrowUp size={20} />}</button></div></div><div className="composer-footer"><button onClick={() => selectPage('settings')}>模型设置</button><span>⌘ ↵</span></div></div>
        </section>}
        {page === 'tasks' && <TaskBoard tasks={data.tasks} onSelect={setSelected} onNew={() => { selectPage('home'); setTimeout(() => inputRef.current?.focus(), 0); }} />}
        {page === 'teams' && <section className="page-content"><div className="page-heading"><h1>执行团队</h1><p>按模板分工，完成后由你验收。</p></div><LocalTeams /></section>}
        {page === 'files' && <section className="page-content"><div className="page-heading"><h1>你的文件</h1><p>已保存的附件</p></div>{data.attachments.length === 0 ? <Empty icon={FolderOpen} title="暂无文件" description="在主入口添加图片或文档，资料会保存在这里。" action={() => selectPage('home')} /> : <div className="task-list">{data.attachments.map(file => <button className="task-row" key={file.id} onClick={() => openFile(file.id)}><span className="task-icon"><FileText size={20} /></span><div><strong>{file.name}</strong><p>{sizeLabel(file.size)} · {timeLabel(file.createdAt)}</p></div><span className="badge neutral">已接收</span><ArrowUpRight size={17} /></button>)}</div>}</section>}
        {page === 'settings' && <section className="page-content"><div className="page-heading"><h1>设置</h1></div><ModelSettings /><div className="settings-card"><div className="settings-title"><span className="task-icon"><Users size={21} /></span><div><h3>OpenRig 连接</h3><p>当前仅连接本机服务，读取团队状态。</p></div></div><label htmlFor="openrig-url">服务地址</label><div className="connection-input"><input id="openrig-url" value={url} disabled={checking} onChange={event => { setUrl(event.target.value); setSaved(false); setConnection(undefined); }} /><button className="primary-button" disabled={checking} onClick={inspectConnection}>{checking ? <LoaderCircle className="spin" size={16} /> : saved ? <Check size={16} /> : null}{checking ? '检查中…' : '保存并检查'}</button></div><ConnectionStatus value={connection} /><p className="field-help">连接成功只表示能够读取团队，不表示模型已登录或任务已派发。</p></div><div className="settings-card"><div className="settings-title"><span className="task-icon"><Orbit size={21} /></span><div><h3>语音交互 · Qwen</h3><p>负责理解与调度，具体工作交给执行团队。</p></div><span className="badge neutral">实时语音</span></div><p className="field-help">开启后说“Hey Orbit”。等待唤醒时音频只在本机处理；唤醒后连接云端。请在连接就绪后说出需求。</p><button className="secondary-button" disabled={voice.state !== 'off'} onClick={() => { void voice.start(true); }}>开启语音唤醒</button></div></section>}
      </>}
      {(voice.state !== 'off' || voice.error || voice.lines.length > 0) && <aside className="voice-panel" aria-label="语音对话">
        <div className="voice-heading"><AudioLines size={18} /><strong>{{ off: '语音已结束', waiting: '等待唤醒 · Hey Orbit', connecting: '正在连接…', listening: '正在聆听' }[voice.state]}</strong>{voice.state !== 'off' && <button className="secondary-button" onClick={() => void voice.stop()}>结束语音</button>}</div>
        {voice.error && <p role="alert">{voice.error}</p>}
        <div className="voice-transcripts" aria-live="polite">{voice.lines.map((line, i) => <p key={i}><strong>{line.role === 'user' ? '你' : 'Orbit'}</strong> {line.text}</p>)}</div>
      </aside>}
    </main>
    {detail && <div className="modal-backdrop" onClick={() => setSelected(undefined)}><section className="task-detail" role="dialog" aria-modal="true" aria-labelledby="task-title" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') setSelected(undefined); }}><div className="detail-top"><span className="eyebrow">任务详情</span><button className="icon-button" aria-label="关闭任务详情" autoFocus onClick={() => setSelected(undefined)}><X size={20} /></button></div><h2 id="task-title">{detail.title}</h2><span className="badge">{taskStatus[detail.status]}</span><ExecutionPanel task={detail} refresh={() => { void window.orbit.workspace().then(setData); }} /><h4>你的要求</h4><p className="brief">{detail.brief || '仅提供了附件，执行前需要明确目标。'}</p><h4>相关资料</h4>{detail.attachmentIds.length ? detail.attachmentIds.map(id => { const file = data?.attachments.find(item => item.id === id); return file && <button className="file-chip" key={id} onClick={() => openFile(id)}><FileText size={14} />{file.name}</button>; }) : <p className="muted">暂无附件</p>}<div className="detail-info"><span>创建于</span><span>{timeLabel(detail.createdAt)}</span><span>执行团队</span><span>{detail.teamId ? '已关联执行团队' : '尚未派发'}</span></div>{detail.status === 'pending' && <button className="secondary-button" onClick={async () => { try { setData(await window.orbit.cancelTask(detail.id)); } catch (e) { setError(messageError(e)); } }}>取消这项待派发任务</button>}</section></div>}
  </div>;
}

function Empty({ icon: Icon, title, description, action, button = '回到主入口' }: { icon: typeof Layers3; title: string; description: string; action: () => void; button?: string }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={30} strokeWidth={1.4} /></span><h2>{title}</h2><p>{description}</p><button className="secondary-button" onClick={action}>{button}<ArrowUpRight size={15} /></button></div>;
}

function ConnectionStatus({ value }: { value?: ConnectionResult }) {
  if (!value) return null;
  return <div className={`connection-result ${value.state}`} role="status"><span className="status-dot" /><div>{value.state === 'connected' ? `连接成功 · 发现 ${value.teams.length} 支团队` : `尚未连接 · ${value.reason}`}<small>检查于 {timeLabel(value.checkedAt)}</small></div></div>;
}
