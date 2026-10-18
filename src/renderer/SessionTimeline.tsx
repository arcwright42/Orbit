import { AudioLines, ChevronRight, FileText, LoaderCircle } from 'lucide-react';
import type { Conversation, Message, Task, Workspace } from '../contracts';

const timeLabel = (date: string) => new Date(date).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const toolStatus = { running: '运行中', complete: '已完成', interrupted: '已中断', failed: '失败' };

interface Props {
  conversation?: Conversation;
  workspace: Workspace;
  taskLabels: Partial<Record<Task['status'], string>>;
  onOpenFile(id: string): void;
  onSelectTask(id: string): void;
}

/** Three visible event kinds. Business receipts stay attached to their tool when available. */
export function SessionTimeline({ conversation, workspace, taskLabels, onOpenFile, onSelectTask }: Props) {
  const messages = conversation?.messages ?? [];
  const receipts = new Map<string, Message[]>();
  const attached = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'system' || !message.taskId) continue;
    const owner = messages.find(candidate => candidate.role === 'tool' && candidate.taskId === message.taskId && candidate.turnId === message.turnId);
    if (owner) {
      receipts.set(owner.id, [...(receipts.get(owner.id) ?? []), message]);
      attached.add(message.id);
    }
  }

  function taskLink(id: string) {
    const task = workspace.tasks.find(item => item.id === id);
    return <button className="inline-task session-task" onClick={() => onSelectTask(id)}>
      <span>{task?.title ?? '查看任务'}</span>
      {task && <span className="session-task-status">{taskLabels[task.status] ?? task.status}</span>}
      <ChevronRight size={14} aria-hidden="true" />
    </button>;
  }

  return <>
    {messages.filter(message => !attached.has(message.id)).map(message => {
      const isTool = message.role === 'tool' || message.role === 'system';
      const kind = isTool ? 'tool' : message.role;
      const related = receipts.get(message.id) ?? [];
      const task = workspace.tasks.find(item => item.id === message.taskId);
      return <article key={message.id} data-message-id={message.id} data-event-kind={kind} className={`message ${kind}`}>
        {message.role === 'tool' ? <>
          <details className="session-tool">
            <summary>
              <ChevronRight className="tool-chevron" size={13} aria-hidden="true" />
              <strong className="event-label">Tool</strong>
              <code>{message.tool?.name ?? '工具调用'}</code>
              <span className={`tool-state ${message.status ?? 'complete'}`}>{message.status === 'running' && <LoaderCircle size={12} className="spin" aria-hidden="true" />}{toolStatus[message.status ?? 'complete']}</span>
              <Metadata message={message} />
            </summary>
            <div className="tool-details">
              {message.tool?.input && <div><h3>参数</h3><pre>{message.tool.input}</pre></div>}
              <div><h3>结果</h3><pre>{message.text || (message.status === 'running' ? '等待工具返回…' : message.status === 'interrupted' ? '会话已中断，未收到执行结果。' : '无返回内容。')}</pre></div>
            </div>
          </details>
          {related.map(receipt => <div className="session-receipt" key={receipt.id} data-message-id={receipt.id}><p>{receipt.text}</p>{receipt.taskId && taskLink(receipt.taskId)}</div>)}
          {!related.length && message.taskId && taskLink(message.taskId)}
        </> : <>
          <div className="message-heading">
            <strong className="event-label">{message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : 'Tool'}</strong>
            {message.role === 'system' && <span className="receipt-label">本地记录</span>}
            <Metadata message={message} />
            {message.status === 'interrupted' && <span className="message-status">已中断</span>}
            {message.status === 'failed' && <span className="message-status failed">未完成</span>}
          </div>
          <p className="message-text">{message.text}</p>
          {message.role === 'user' && (message.attachmentIds ?? task?.attachmentIds ?? []).map(id => {
            const file = workspace.attachments.find(item => item.id === id);
            return file && <button className="file-chip" key={id} onClick={() => onOpenFile(id)}><FileText size={13} />{file.name}</button>;
          })}
          {message.role === 'system' && message.taskId && taskLink(message.taskId)}
        </>}
      </article>;
    })}
    {conversation?.status === 'running' && (conversation.draft || !messages.some(message => message.role === 'tool' && message.status === 'running')) &&
      <article className="message assistant streaming" data-event-kind="assistant" aria-live="polite">
        <div className="message-heading"><strong className="event-label">Assistant</strong><LoaderCircle size={12} className="spin" aria-hidden="true" /><span className="message-status">正在回复</span></div>
        <p className="message-text">{conversation.draft || '正在思考…'}</p>
      </article>}
  </>;
}

function Metadata({ message }: { message: Message }) {
  return <span className="event-meta">
    {message.channel === 'voice' && <span className="message-channel"><AudioLines size={12} aria-hidden="true" />语音</span>}
    <time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>
  </span>;
}
