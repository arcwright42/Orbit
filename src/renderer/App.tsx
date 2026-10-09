import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, AudioLines, Check, ChevronRight, Circle, CircleHelp, FileText, FolderOpen, Layers3, LoaderCircle, MessageSquare, Orbit, Paperclip, Plus, Settings2, Users, X } from 'lucide-react';
import type { Attachment, ConnectionResult, Workspace } from '../contracts';

type Page = 'home' | 'tasks' | 'teams' | 'files' | 'settings';
const labels: Record<Page, string> = { home: '主入口', tasks: '任务', teams: '团队', files: '文件', settings: '设置' };
const sizeLabel = (size: number) => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const timeLabel = (date: string) => new Date(date).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const messageError = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '操作失败，请重试。';

export function App() {
  const [data, setData] = useState<Workspace>();
  const [page, setPage] = useState<Page>('home');
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [data?.messages.length, page]);
  const active = data?.tasks.filter(task => task.status === 'pending') ?? [];
  const detail = data?.tasks.find(task => task.id === selected);

  async function submit() {
    if (lock.current || (!draft.trim() && !attachments.length)) return;
    lock.current = true; setBusy(true); setError('');
    try {
      setData(await window.orbit.submit({ requestId: requestId.current, text: draft, attachmentIds: attachments.map(item => item.id) }));
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
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Orbit size={24} strokeWidth={1.6} /></span><span>Orbit</span><span className="alpha">α</span></div>
      <button className="new-button" onClick={() => { selectPage('home'); setTimeout(() => inputRef.current?.focus(), 0); }}><Plus size={17} /> 开始一件事 <span>⌘ ↵</span></button>
      <nav aria-label="主导航">
        {([{ key: 'home', icon: MessageSquare }, { key: 'tasks', icon: Layers3 }, { key: 'teams', icon: Users }, { key: 'files', icon: FolderOpen }] as const).map(({ key, icon: Icon }) =>
          <button key={key} className={`nav-item ${page === key ? 'active' : ''}`} aria-current={page === key ? 'page' : undefined} onClick={() => selectPage(key)}><Icon size={18} />{labels[key]}{key === 'tasks' && active.length > 0 && <span className="count">{active.length}</span>}</button>)}
      </nav>
      <div className="sidebar-section">最近任务 <span>{data?.tasks.length ?? 0}</span></div>
      <div className="recent-list">{data?.tasks.slice(0, 5).map(task => <button key={task.id} onClick={() => setSelected(task.id)}><Circle size={9} /><span>{task.title}</span></button>)}{!data?.tasks.length && <p className="sidebar-empty">你的想法，将从这里开始。</p>}</div>
      <div className="sidebar-bottom"><div className="local-note"><span className="dot" /> 个人工作空间<span>本机</span></div><button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => selectPage('settings')}><Settings2 size={18} />设置</button><div className="profile"><span className="avatar">你</span><div>我的 Orbit<small>开发预览 · 0.1</small></div></div></div>
    </aside>
    <main className="main">
      <header className="topbar"><span>{labels[page]}</span><div><span className="status-dot" /> 本地保存 <span className="divider" /><button className="icon-button" aria-label="查看连接设置" onClick={() => selectPage('settings')}><CircleHelp size={17} /></button></div></header>
      {error && <div className="error-banner" role="alert">{error}<button aria-label="关闭错误" onClick={() => setError('')}><X size={16} /></button></div>}
      {!data ? <div className="empty-state"><LoaderCircle className="spin" /><h2>正在打开你的工作空间</h2>{error && <button onClick={() => location.reload()}>重新加载</button>}</div> : <>
        {page === 'home' && <section className={`home ${data.messages.length ? 'has-messages' : ''}`}>
          {data.messages.length === 0 ? <div className="welcome"><div className="welcome-symbol"><Orbit size={43} strokeWidth={1.2} /><span /></div><div className="eyebrow">一个入口，让想法开始运转</div><h1>今天，我们一起做点什么？</h1><p>告诉 Orbit 你的目标。把过程交给团队，<br />把时间留给值得你关注的事。</p><div className="suggestions">{[
            { title: '把想法变成产品', text: '帮我把一个产品想法整理成可执行的开发需求。', icon: Layers3 },
            { title: '研究一个新方向', text: '我想研究一个新方向，先帮我明确研究目标和交付要求。', icon: Orbit },
            { title: '从一份资料开始', text: '基于我提供的资料，帮我规划下一步工作。', icon: FileText },
          ].map(({ title, text, icon: Icon }) => <button key={title} onClick={() => { setDraft(text); requestId.current = crypto.randomUUID(); inputRef.current?.focus(); }}><Icon size={19} /><span>{title}</span><ArrowUpRight size={14} /></button>)}</div></div> : <div className="messages">{data.messages.map(message => <article key={message.id} className={`message ${message.role}`}><div className="message-heading">{message.role === 'user' ? <span className="mini-avatar">你</span> : <Orbit size={19} />}<strong>{message.role === 'user' ? '你' : 'Orbit · 系统回执'}</strong><time>{timeLabel(message.createdAt)}</time></div><p>{message.text}</p>{message.role === 'user' && data.tasks.find(task => task.id === message.taskId)?.attachmentIds.map(id => { const file = data.attachments.find(item => item.id === id); return file && <button className="file-chip" key={id} onClick={() => openFile(id)}><FileText size={14} />{file.name}</button>; })}{message.role === 'system' && <button className="inline-task" onClick={() => setSelected(message.taskId)}><Layers3 size={17} /><span>{data.tasks.find(task => task.id === message.taskId)?.title}</span><span className="badge">{data.tasks.find(task => task.id === message.taskId)?.status === 'canceled' ? '已取消' : '待派发'}</span><ChevronRight size={15} /></button>}</article>)}<div ref={bottomRef} /></div>}
          <div className="composer-area"><div className="preview-note"><span className="amber-dot" />基础预览：目前可保存需求和附件，交互 Agent 尚未接入。</div><div className="composer">{attachments.length > 0 && <div className="attachment-row">{attachments.map(file => <span className="file-chip" key={file.id}><FileText size={14} />{file.name}<button disabled={busy} aria-label={`移除 ${file.name}`} onClick={() => { setAttachments(current => current.filter(item => item.id !== file.id)); requestId.current = crypto.randomUUID(); }}><X size={13} /></button></span>)}</div>}<textarea ref={inputRef} aria-label="你的需求" placeholder="描述你想做的事，或者添加一份资料…" value={draft} maxLength={16000} disabled={busy} onChange={event => { setDraft(event.target.value); requestId.current = crypto.randomUUID(); }} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} /><div className="composer-tools"><div><button className="icon-button" aria-label="添加附件" title="图片或文档 · 每个最多 25 MB" disabled={picking || busy || attachments.length >= 8} onClick={pick}>{picking ? <LoaderCircle size={19} className="spin" /> : <Paperclip size={19} />}</button><button className="icon-button" aria-label="语音交互尚未接入" title="语音交互将在后续版本接入" disabled><AudioLines size={19} /></button><span className="composer-label">主入口</span></div><button className="send" aria-label="保存需求" disabled={busy || picking || (!draft.trim() && !attachments.length)} onClick={submit}>{busy ? <LoaderCircle size={19} className="spin" /> : <ArrowUp size={20} />}</button></div></div><div className="composer-footer"><span>资料仅保存在本机，尚未发送给模型</span><span>⌘ Enter 发送</span></div></div>
        </section>}
        {page === 'tasks' && <section className="page-content"><div className="page-heading"><div className="eyebrow">把每件事，稳稳向前推进</div><h1>你的任务</h1><p>{active.length} 项待派发 · {data.tasks.filter(task => task.status === 'canceled').length} 项已取消</p></div>{!data.tasks.length ? <Empty icon={Layers3} title="第一件事，从一个想法开始" description="在主入口描述目标，需求会保存在这里。" action={() => selectPage('home')} /> : <div className="task-list">{data.tasks.map(task => <button className="task-row" key={task.id} onClick={() => setSelected(task.id)}><span className="task-icon"><Layers3 size={20} /></span><div><strong>{task.title}</strong><p>{timeLabel(task.createdAt)} · {task.attachmentIds.length} 个附件</p></div><span className={`badge ${task.status === 'canceled' ? 'neutral' : ''}`}>{task.status === 'pending' ? '待派发' : '已取消'}</span><ChevronRight size={17} /></button>)}</div>}</section>}
        {page === 'teams' && <section className="page-content"><div className="page-heading"><div className="eyebrow">让合适的伙伴，做擅长的事</div><h1>执行团队</h1><p>连接本机 OpenRig，查看已有团队。</p></div><ConnectionStatus value={connection} />{connection?.state === 'connected' && connection.teams.length > 0 ? <div className="team-grid">{connection.teams.map(team => <div className="team-card" key={team.id}><Users size={24} /><h3>{team.name}</h3><p>OpenRig 状态：{team.lifecycle}</p><small>只读同步 · 尚未接入任务派发</small></div>)}</div> : <Empty icon={Users} title={connection?.state === 'connected' ? '还没有执行团队' : '连接你的第一支团队'} description="团队编排将沿用 OpenRig。当前版本先提供连接检查和团队读取。" action={() => selectPage('settings')} button="设置连接" />}</section>}
        {page === 'files' && <section className="page-content"><div className="page-heading"><div className="eyebrow">资料与成果，都有自己的位置</div><h1>你的文件</h1><p>已添加的本地资料。文件已接收，不代表内容已解析。</p></div>{data.attachments.length === 0 ? <Empty icon={FolderOpen} title="给想法一些素材" description="在主入口添加图片或文档，资料会保存在这里。" action={() => selectPage('home')} /> : <div className="task-list">{data.attachments.map(file => <button className="task-row" key={file.id} onClick={() => openFile(file.id)}><span className="task-icon"><FileText size={20} /></span><div><strong>{file.name}</strong><p>{sizeLabel(file.size)} · {timeLabel(file.createdAt)}</p></div><span className="badge neutral">已接收</span><ArrowUpRight size={17} /></button>)}</div>}</section>}
        {page === 'settings' && <section className="page-content"><div className="page-heading"><div className="eyebrow">准备好你的工作空间</div><h1>设置</h1><p>先连接运行环境，再逐步接入交互与执行能力。</p></div><div className="settings-card"><div className="settings-title"><span className="task-icon"><Users size={21} /></span><div><h3>OpenRig 连接</h3><p>当前仅连接本机服务，读取团队状态。</p></div></div><label htmlFor="openrig-url">服务地址</label><div className="connection-input"><input id="openrig-url" value={url} disabled={checking} onChange={event => { setUrl(event.target.value); setSaved(false); setConnection(undefined); }} /><button className="primary-button" disabled={checking} onClick={inspectConnection}>{checking ? <LoaderCircle className="spin" size={16} /> : saved ? <Check size={16} /> : null}{checking ? '检查中…' : '保存并检查'}</button></div><ConnectionStatus value={connection} /><p className="field-help">连接成功只表示能够读取团队，不表示模型已登录或任务已派发。</p></div><div className="settings-card"><div className="settings-title"><span className="task-icon"><Orbit size={21} /></span><div><h3>常驻交互 Agent</h3><p>负责理解与调度，具体工作交给执行团队。</p></div><span className="badge neutral">尚未接入</span></div><p className="field-help">语音、模型连接和自动派发将在后续开发中接入。当前没有模拟回复或模拟执行。</p></div></section>}
      </>}
    </main>
    {detail && <div className="modal-backdrop" onClick={() => setSelected(undefined)}><section className="task-detail" role="dialog" aria-modal="true" aria-labelledby="task-title" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') setSelected(undefined); }}><div className="detail-top"><span className="eyebrow">任务详情</span><button className="icon-button" aria-label="关闭任务详情" autoFocus onClick={() => setSelected(undefined)}><X size={20} /></button></div><h2 id="task-title">{detail.title}</h2><span className="badge">{detail.status === 'pending' ? '待派发' : '已取消'}</span><h4>你的要求</h4><p className="brief">{detail.brief || '仅提供了附件，执行前需要明确目标。'}</p><h4>相关资料</h4>{detail.attachmentIds.length ? detail.attachmentIds.map(id => { const file = data?.attachments.find(item => item.id === id); return file && <button className="file-chip" key={id} onClick={() => openFile(id)}><FileText size={14} />{file.name}</button>; }) : <p className="muted">暂无附件</p>}<div className="detail-info"><span>创建于</span><span>{timeLabel(detail.createdAt)}</span><span>执行团队</span><span>尚未派发</span></div><p className="field-help">需求已持久保存。后续接入交互 Agent 后，再由平台工具安排执行。</p>{detail.status === 'pending' && <button className="secondary-button" onClick={async () => { try { setData(await window.orbit.cancelTask(detail.id)); } catch (e) { setError(messageError(e)); } }}>取消这项待派发任务</button>}</section></div>}
  </div>;
}

function Empty({ icon: Icon, title, description, action, button = '回到主入口' }: { icon: typeof Layers3; title: string; description: string; action: () => void; button?: string }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={30} strokeWidth={1.4} /></span><h2>{title}</h2><p>{description}</p><button className="secondary-button" onClick={action}>{button}<ArrowUpRight size={15} /></button></div>;
}

function ConnectionStatus({ value }: { value?: ConnectionResult }) {
  if (!value) return null;
  return <div className={`connection-result ${value.state}`} role="status"><span className="status-dot" /><div>{value.state === 'connected' ? `连接成功 · 发现 ${value.teams.length} 支团队` : `尚未连接 · ${value.reason}`}<small>检查于 {timeLabel(value.checkedAt)}</small></div></div>;
}
