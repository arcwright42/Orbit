import { AlertCircle, AudioLines, Check, ChevronRight, FileText, LoaderCircle, Minus } from 'lucide-react';
import type { Conversation, Message, Task, Workspace } from '../contracts';
import { MessageContent } from './MessageContent';

const timeLabel = (date: string) => new Date(date).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const toolStatus = { running: '运行中', complete: '已完成', interrupted: '已中断', failed: '失败' };
const toolNames: Record<string, string> = {
  save_request: '保存需求', list_tasks: '查询任务', search_history: '搜索对话记录', read_history: '读取对话记录',
  dispatch_task: '派发任务', get_task: '查看任务进度', cancel_task: '取消任务', retry_task: '重试任务',
  answer_task: '回复任务问题', accept_task: '确认任务成果',
};

interface Props {
  conversation?: Conversation;
  workspace: Workspace;
  taskLabels: Partial<Record<Task['status'], string>>;
  onOpenFile(id: string): void;
  onSelectTask(id: string): void;
}

/** Three event kinds, presented as a conversation rather than protocol headings. */
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
    return <button className="inline-task session-task" onClick={() => onSelectTask(id)} title={task ? `${task.title} · ${taskLabels[task.status] ?? task.status}` : '查看任务'}>
      <span>{task?.title ?? '查看任务'}</span><ChevronRight size={12} aria-hidden="true" />
    </button>;
  }

  return <>
    {messages.filter(message => !attached.has(message.id)).map(message => {
      const isTool = message.role === 'tool' || message.role === 'system';
      const kind = isTool ? 'tool' : message.role;
      const related = receipts.get(message.id) ?? [];
      const task = workspace.tasks.find(item => item.id === message.taskId);
      const name = message.tool?.name;
      const StatusIcon = message.status === 'running' ? LoaderCircle : message.status === 'failed' ? AlertCircle : message.status === 'interrupted' ? Minus : Check;
      return <article key={message.id} data-message-id={message.id} data-event-kind={kind} className={`message ${kind}`} aria-label={isTool ? '工具事件' : message.role === 'user' ? '你的消息' : 'Orbit 的回复'}>
        {isTool ? <div className="tool-row">
          <details className="session-tool">
            <summary title={name ?? '本地记录'}>
              <StatusIcon size={14} className={`${message.status === 'running' ? 'spin ' : ''}tool-icon ${message.status ?? 'complete'}`} aria-hidden="true" />
              <span className="tool-name">{name ? toolNames[name] ?? name : '已记录需求'}</span>
              {name && <span className={`tool-state ${message.status ?? 'complete'}`}>{toolStatus[message.status ?? 'complete']}</span>}
              <ChevronRight className="tool-chevron" size={12} aria-hidden="true" />
            </summary>
            <div className="tool-details">
              <div className="tool-detail-meta">{name && <code>{name}</code>}<time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>{message.channel === 'voice' && <span>语音</span>}</div>
              {message.tool?.input && <div><h3>参数</h3><pre>{message.tool.input}</pre></div>}
              <div><h3>{name ? '结果' : '记录'}</h3><pre>{message.text || (message.status === 'running' ? '等待工具返回…' : message.status === 'interrupted' ? '会话已中断，未收到执行结果。' : '无返回内容。')}</pre></div>
              {related.map(receipt => <div className="session-receipt" key={receipt.id} data-message-id={receipt.id}><p>{receipt.text}</p></div>)}
            </div>
          </details>
          {message.taskId && taskLink(message.taskId)}
        </div> : <>
          <div className="message-body" title={timeLabel(message.createdAt)}>
            {message.role === 'assistant' ? <MessageContent text={message.text} /> : <p className="message-text">{message.text}</p>}
            {message.role === 'user' && (message.attachmentIds ?? task?.attachmentIds ?? []).map(id => {
              const file = workspace.attachments.find(item => item.id === id);
              return file && <button className="file-chip" key={id} onClick={() => onOpenFile(id)}><FileText size={13} />{file.name}</button>;
            })}
          </div>
          <MessageStatus message={message} />
        </>}
      </article>;
    })}
    {conversation?.status === 'running' && (conversation.draft || !messages.some(message => message.role === 'tool' && message.status === 'running')) &&
      <article className="message assistant streaming" data-event-kind="assistant" aria-label="Orbit 正在回复" aria-live="polite">
        {conversation.draft ? <MessageContent text={conversation.draft} /> : <span className="thinking"><LoaderCircle size={14} className="spin" aria-hidden="true" />正在思考…</span>}
      </article>}
  </>;
}

function MessageStatus({ message }: { message: Message }) {
  if (message.channel !== 'voice' && !['interrupted', 'failed'].includes(message.status ?? '')) return null;
  return <div className="message-meta">
    {message.channel === 'voice' && <span className="message-channel"><AudioLines size={11} aria-hidden="true" />语音</span>}
    {message.status === 'interrupted' && <span className="message-status">已中断</span>}
    {message.status === 'failed' && <span className="message-status failed">未完成</span>}
  </div>;
}
