import { useEffect, useState } from 'react';
import { LoaderCircle, Search } from 'lucide-react';
import type { ModelOption } from '../domains/models/model';
import { modelError } from './useModelSettings';

export function ModelPicker({ providerId, value, disabled, onChange, onReady }: {
  providerId: string; value: string; disabled: boolean; onChange: (id: string) => void; onReady: (valid: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<{ providerId: string; options: ModelOption[]; error?: string }>();
  const [query, setQuery] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    setCatalog(undefined); setQuery('');
    void window.orbit.models.catalog(providerId).then(options => {
      if (!disposed) setCatalog({ providerId, options });
    }).catch(error => { if (!disposed) setCatalog({ providerId, options: [], error: modelError(error) }); });
    return () => { disposed = true; };
  }, [providerId, retry]);
  const current = catalog?.providerId === providerId ? catalog : undefined;
  const selected = current?.options.find(option => option.id === value);
  useEffect(() => { onReady(Boolean(selected)); }, [selected, onReady]);
  const options = current?.options.filter(option => `${option.id} ${option.name}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const pinned = selected && !options.some(option => option.id === value);
  return <div className="model-picker">
    <label htmlFor="model-choice">模型</label>
    {!current ? <p className="model-hint" role="status"><LoaderCircle size={14} className="spin" />正在加载模型目录…</p>
      : current.error ? <div className="model-feedback error" role="alert">{current.error}<button type="button" className="model-link" disabled={disabled} onClick={() => setRetry(value => value + 1)}>重试加载模型</button></div>
        : <>
          <label className="model-search"><Search size={15} /><input type="search" aria-label="搜索模型" placeholder="搜索模型名称或 ID" value={query} disabled={disabled} onChange={event => setQuery(event.target.value)} /></label>
          <select id="model-choice" size={5} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
            <option value="" disabled>选择一个模型</option>
            {value && !selected && <option value={value} disabled>{value} · 不在当前目录</option>}
            {pinned && <optgroup label="已选择"><option value={selected.id}>{selected.name} · {selected.id}</option></optgroup>}
            {options.map(option => <option key={option.id} value={option.id}>{option.name === option.id ? option.id : `${option.name} · ${option.id}`}</option>)}
          </select>
          {!options.length && <p className="model-hint" role="status">{current.options.length ? '没有匹配的模型，请调整搜索。' : '该服务暂无可选模型。'}</p>}
          {value && !selected && <p className="model-feedback error" role="alert">已保存的模型不在当前支持目录中，请重新选择；原配置仍然保留。</p>}
          {selected && <p className="model-hint">已选择 {selected.id} · 上下文 {selected.contextWindow.toLocaleString()} · 最大输出 {selected.maxTokens.toLocaleString()}</p>}
          <p className="model-hint">目录不代表账号可用权限，保存后可测试连接。</p>
        </>}
  </div>;
}
