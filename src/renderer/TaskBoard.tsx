import { useState } from 'react';
import { CheckCircle2, Circle, CircleDashed, CircleDot, Columns3, List, Paperclip, Plus, Search, SlidersHorizontal, UserRound, XCircle } from 'lucide-react';
import type { Task } from '../contracts';

const columns = [
  { id: 'pending', label: '待派发', icon: CircleDashed },
  { id: 'running', label: '进行中', icon: CircleDot },
  { id: 'review', label: '待验收', icon: Circle },
  { id: 'completed', label: '已完成', icon: CheckCircle2 },
  { id: 'canceled', label: '已取消', icon: XCircle },
] as const;

const taskCode = (id: string) => `ORB-${id.slice(0, 6).toUpperCase()}`;
const dateLabel = (date: string) => new Date(date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });

export function TaskBoard({ tasks, onSelect, onNew }: { tasks: Task[]; onSelect: (id: string) => void; onNew: () => void }) {
  const [view, setView] = useState<'board' | 'list'>('board');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const filtered = tasks.filter(task =>
    (status === 'all' || task.status === status) &&
    `${task.title} ${task.brief} ${taskCode(task.id)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const visibleColumns = columns.filter(column => status === 'all' || column.id === status);

  return <section className="task-workspace" aria-label="任务看板">
    <div className="board-toolbar">
      <div className="view-switch" aria-label="任务视图">
        <button aria-pressed={view === 'board'} onClick={() => setView('board')}><Columns3 size={14} />看板</button>
        <button aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={15} />列表</button>
      </div>
      <label className="board-filter"><SlidersHorizontal size={14} /><select aria-label="筛选任务状态" value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option>{columns.map(column => <option key={column.id} value={column.id}>{column.label}</option>)}</select></label>
      <label className="board-search"><Search size={14} /><input aria-label="搜索任务" value={query} placeholder="搜索任务…" onChange={event => setQuery(event.target.value)} /></label>
      <span className="board-total" aria-live="polite">{filtered.length} 个任务</span>
      <button className="board-new" onClick={onNew}><Plus size={15} />新建任务</button>
    </div>
    {view === 'board' ? <div className="kanban-scroll"><div className="kanban-board">
      {visibleColumns.map(column => {
        const items = filtered.filter(task => task.status === column.id);
        const Icon = column.icon;
        return <section className={`kanban-column column-${column.id}`} key={column.id} aria-label={`${column.label}任务`}>
          <header className="column-header"><Icon size={15} /><h2>{column.label}</h2><span>{items.length}</span>{column.id === 'pending' && <button aria-label="新建待派发任务" onClick={onNew}><Plus size={15} /></button>}</header>
          <div className="column-cards">{items.map(task => <button className="board-card" key={task.id} onClick={() => onSelect(task.id)} aria-label={`${task.title} · ${column.label}`}>
            <span className="card-code">{taskCode(task.id)}</span><h3>{task.title}</h3>
            {task.brief.length > task.title.length && <p>{task.brief.slice(task.title.length).trim()}</p>}
            <div className="card-metadata"><span className="card-owner" title="尚未分配执行团队"><UserRound size={12} />未分配</span>{task.attachmentIds.length > 0 && <span><Paperclip size={12} />{task.attachmentIds.length}</span>}<time dateTime={task.createdAt}>{dateLabel(task.createdAt)}</time></div>
          </button>)}{items.length === 0 && <div className="column-empty">{query ? '无匹配任务' : '暂无任务'}</div>}</div>
        </section>;
      })}
    </div></div> : <div className="grouped-task-list">{visibleColumns.map(column => {
      const items = filtered.filter(task => task.status === column.id);
      const Icon = column.icon;
      return <section key={column.id} aria-label={`${column.label}任务`}><header className="list-group-header"><Icon size={14} /><h2>{column.label}</h2><span>{items.length}</span></header>{items.map(task => <button className="compact-task-row" key={task.id} onClick={() => onSelect(task.id)}><span className="card-code">{taskCode(task.id)}</span><span className="compact-title">{task.title}</span>{task.attachmentIds.length > 0 && <span className="row-attachments"><Paperclip size={12} />{task.attachmentIds.length}</span>}<UserRound size={14} /><time>{dateLabel(task.createdAt)}</time></button>)}{!items.length && <p className="list-empty">{query ? '无匹配任务' : '暂无任务'}</p>}</section>;
    })}</div>}
  </section>;
}
