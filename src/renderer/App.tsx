import { useVoice } from './useVoice';
import { useRoom } from './useRoom';
import { SessionTimeline } from './SessionTimeline';
import { TaskBoard } from './TaskBoard';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, AudioLines, Circle, PanelLeft, FileText, FolderOpen, Layers3, LoaderCircle, MessageSquare, Orbit, Plus, Settings2, Square, X } from 'lucide-react';
import type { Attachment, Workspace } from '../contracts';

type Page = 'home' | 'tasks' | 'files' | 'settings';
const labels: Record<Page, string> = { home: '主入口', tasks: '任务', files: '文件', settings: '设置' };
const sizeLabel = (size: number) => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const timeLabel = (date: string) => new Date(date).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const messageError = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '操作失败，请重试。';

export function App() {
  const [data, setData] = useState<Workspace>();
  const voice = useVoice();
  const [page, setPage] = useState<Page>('home');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState('');
  const { conversation, loadingOlder, loadOlder } = useRoom(
    () => { void window.orbit.workspace().then(setData).catch(e => setError(messageError(e))); },
    e => setError(messageError(e)),
  );
  const [sending, setSending] = useState(false);
  const busy = sending || conversation?.status === 'running';
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<string>();
  const requestId = useRef(crypto.randomUUID());
  const lock = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const scrollAnchor = useRef<{ id: string; top: number } | null>(null);
  const messages = conversation?.messages ?? [];
  useEffect(() => { void window.orbit.workspace().then(setData).catch(e => setError(messageError(e))); }, []);
  useLayoutEffect(() => {
    const container = messagesRef.current;
    if (!container) return;
    const anchor = scrollAnchor.current;
    if (anchor) {
      if (messages[0]?.id === anchor.id) return;
      const element = [...container.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.dataset.messageId === anchor.id);
      if (element) container.scrollTop += element.getBoundingClientRect().top - anchor.top;
      scrollAnchor.current = null;
    } else if (followBottom.current) bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [conversation?.messages, conversation?.draft, page, voice.state]);
  function older() {
    const first = messagesRef.current?.querySelector<HTMLElement>('[data-message-id]');
    if (first?.dataset.messageId) scrollAnchor.current = { id: first.dataset.messageId, top: first.getBoundingClientRect().top };
    followBottom.current = false;
    void loadOlder().then(loaded => { if (!loaded) scrollAnchor.current = null; });
  }
  const active = data?.tasks.filter(task => task.status === 'pending') ?? [];
  const detail = data?.tasks.find(task => task.id === selected);

  async function submit(saveOnly = false) {
    if (lock.current || busy || (!draft.trim() && !attachments.length)) return;
    lock.current = true; setSending(true); setError(''); followBottom.current = true;
    try {
      const input = { requestId: requestId.current, text: draft, attachmentIds: attachments.map(item => item.id) };
      if (saveOnly) setData(await window.orbit.submit(input));
      else { await window.orbit.sendMessage(input); setData(await window.orbit.workspace()); }
      setDraft(''); setAttachments([]); requestId.current = crypto.randomUUID();
    } catch (e) { setError(messageError(e)); }
    finally { lock.current = false; setSending(false); inputRef.current?.focus(); }
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
  const openFile = (id: string) => window.orbit.openAttachment(id).catch(e => setError(messageError(e)));
  const selectPage = (next: Page) => { setPage(next); setError(''); };

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'is-open' : 'is-collapsed'}`} inert={!sidebarOpen}>
      <div className="brand"><span className="brand-mark"><Orbit size={24} strokeWidth={1.6} /></span><span>Orbit</span></div>
      <button className="new-button" onClick={() => { selectPage('home'); setTimeout(() => inputRef.current?.focus(), 0); }}><Plus size={17} /> 新需求</button>
      <nav aria-label="主导航">
        {([{ key: 'home', icon: MessageSquare }, { key: 'tasks', icon: Layers3 }, { key: 'files', icon: FolderOpen }] as const).map(({ key, icon: Icon }) =>
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
        {page === 'home' && <section className={`home ${messages.length || busy ? 'has-messages' : ''}`}>
          {messages.length === 0 && !busy ? null : <div className="messages" ref={messagesRef} onScroll={event => { const element = event.currentTarget; followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
            {conversation?.nextCursor && <button className="history-more" disabled={loadingOlder} onClick={older}>{loadingOlder ? '正在加载…' : '加载更早的对话'}</button>}
            <SessionTimeline conversation={conversation} workspace={data} taskLabels={{ pending: '待派发', canceled: '已取消' }} onOpenFile={openFile} onSelectTask={setSelected} />
            <div ref={bottomRef} /></div>}
          <div className="composer-area"><div className="composer">{attachments.length > 0 && <div className="attachment-row">{attachments.map(file => <span className="file-chip" key={file.id}><FileText size={14} />{file.name}<button disabled={busy} aria-label={`移除 ${file.name}`} onClick={() => { setAttachments(current => current.filter(item => item.id !== file.id)); requestId.current = crypto.randomUUID(); }}><X size={13} /></button></span>)}</div>}<textarea ref={inputRef} aria-label="你的需求" placeholder="想做些什么？" value={draft} maxLength={16000} disabled={busy} onChange={event => { setDraft(event.target.value); requestId.current = crypto.randomUUID(); }} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} /><div className="composer-tools"><div><button className="attach-button" aria-label="添加附件" title="图片或文档 · 每个最多 25 MB" disabled={picking || busy || attachments.length >= 8} onClick={pick}>{picking ? <LoaderCircle size={19} className="spin" /> : <Plus size={18} />}<span>添加文件</span></button><button className="icon-button" aria-label={voice.state === 'paused' ? '切回语音' : voice.state === 'off' ? (busy ? '切换到语音' : '开始语音') : '结束语音'} title="语音对话" onClick={() => { if (voice.state === 'paused') void voice.resume(); else if (voice.state === 'off') void voice.start(false); else void voice.stop(); }}><AudioLines size={19} /></button></div>{conversation?.status === 'running' ? <button className="send" aria-label="停止回复" onClick={() => { void window.orbit.stopReply().catch(e => setError(messageError(e))); }}><Square size={14} fill="currentColor" /></button> : <button className="send" aria-label="发送消息" disabled={busy || picking || !conversation?.configured || (!draft.trim() && !attachments.length)} onClick={() => void submit()}>{busy ? <LoaderCircle size={19} className="spin" /> : <ArrowUp size={20} />}</button>}</div></div><div className="composer-footer"><button onClick={() => selectPage('settings')}>{conversation?.configured ? '对话设置' : '模型尚未配置'}</button><button disabled={busy || picking || (!draft.trim() && !attachments.length)} onClick={() => void submit(true)}>仅保存需求</button><span>⌘ ↵</span></div>{conversation?.error && <p className="conversation-notice" role="status">{conversation.error}</p>}</div>
        </section>}
        {page === 'tasks' && <TaskBoard tasks={data.tasks} onSelect={setSelected} onNew={() => { selectPage('home'); setTimeout(() => inputRef.current?.focus(), 0); }} />}
        {page === 'files' && <section className="page-content"><div className="page-heading"><h1>你的文件</h1><p>已保存的附件</p></div>{data.attachments.length === 0 ? <Empty icon={FolderOpen} title="暂无文件" description="在主入口添加图片或文档，资料会保存在这里。" action={() => selectPage('home')} /> : <div className="task-list">{data.attachments.map(file => <button className="task-row" key={file.id} onClick={() => openFile(file.id)}><span className="task-icon"><FileText size={20} /></span><div><strong>{file.name}</strong><p>{sizeLabel(file.size)} · {timeLabel(file.createdAt)}</p></div><span className="badge neutral">已接收</span><ArrowUpRight size={17} /></button>)}</div>}</section>}
        {page === 'settings' && <section className="page-content">
          <div className="page-heading"><h1>设置</h1></div>
          <div className="settings-card">
            <div className="settings-title"><span className="task-icon"><MessageSquare size={21} /></span><div><h3>文字对话</h3><p>{conversation?.model ?? '尚未配置模型服务'}</p></div><span className="badge neutral">{conversation?.configured ? '已配置' : '待配置'}</span></div>
            <p className="field-help">文字与语音共用一段对话，记录保存在本机，重启后可以继续。Orbit 会查询任务、澄清目标，并将明确的工作需求保存为待派发任务。执行团队尚未接入。</p>
            {!conversation?.configured && <p className="field-help">开发版本请按项目 README 配置文字模型服务并重启应用；也可先在主入口选择“仅保存需求”。</p>}
          </div>
          <div className="settings-card">
            <div className="settings-title"><span className="task-icon"><Orbit size={21} /></span><div><h3>语音交互</h3><p>与 Orbit 对话、记录需求和查询任务。</p></div><span className="badge neutral">实时语音</span></div>
            <p className="field-help">开启后说“Hey Orbit”。等待唤醒时音频只在本机处理；唤醒后连接云端。请在连接就绪后说出需求。</p>
            <button className="secondary-button" disabled={voice.state !== 'off'} onClick={() => { void voice.start(true); }}>开启语音唤醒</button>
          </div>
        </section>}
      </>}
      {(voice.state !== 'off' || voice.error) && <aside className="voice-panel" aria-label="语音对话">
        <div className="voice-heading"><AudioLines size={18} /><strong>{{ off: '语音已结束', waiting: '等待唤醒 · Hey Orbit', connecting: '正在连接…', listening: '正在聆听', paused: '文字回复中 · 麦克风已暂停' }[voice.state]}</strong>{voice.state !== 'off' && <button className="secondary-button" onClick={() => void voice.stop()}>结束语音</button>}</div>
        {voice.error && <p role="alert">{voice.error}</p>}
        {voice.state === 'paused' ? <div className="voice-actions"><span>回复结束后自动恢复语音。</span><button className="secondary-button" onClick={() => void voice.resume()}>停止文字，切回语音</button></div> : voice.state === 'listening' && <p className="voice-help">可以直接说，也可以输入文字。对话记录在主入口继续。</p>}
      </aside>}
    </main>
    {detail && <div className="modal-backdrop" onClick={() => setSelected(undefined)}><section className="task-detail" role="dialog" aria-modal="true" aria-labelledby="task-title" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') setSelected(undefined); }}><div className="detail-top"><span className="eyebrow">任务详情</span><button className="icon-button" aria-label="关闭任务详情" autoFocus onClick={() => setSelected(undefined)}><X size={20} /></button></div><h2 id="task-title">{detail.title}</h2><span className="badge">{detail.status === 'pending' ? '待派发' : '已取消'}</span><h4>你的要求</h4><p className="brief">{detail.brief || '仅提供了附件，执行前需要明确目标。'}</p><h4>相关资料</h4>{detail.attachmentIds.length ? detail.attachmentIds.map(id => { const file = data?.attachments.find(item => item.id === id); return file && <button className="file-chip" key={id} onClick={() => openFile(id)}><FileText size={14} />{file.name}</button>; }) : <p className="muted">暂无附件</p>}<div className="detail-info"><span>创建于</span><span>{timeLabel(detail.createdAt)}</span></div>{detail.status === 'pending' && <button className="secondary-button" onClick={async () => { try { setData(await window.orbit.cancelTask(detail.id)); } catch (e) { setError(messageError(e)); } }}>取消这项待派发任务</button>}</section></div>}
  </div>;
}

function Empty({ icon: Icon, title, description, action, button = '回到主入口' }: { icon: typeof Layers3; title: string; description: string; action: () => void; button?: string }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={30} strokeWidth={1.4} /></span><h2>{title}</h2><p>{description}</p><button className="secondary-button" onClick={action}>{button}<ArrowUpRight size={15} /></button></div>;
}
