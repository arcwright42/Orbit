import { useEffect, useRef, useState } from 'react';
import { Check, KeyRound, Laptop, LoaderCircle, MessageSquare, Plus, RefreshCw } from 'lucide-react';
import { ModelProfileForm } from './ModelProfileForm';
import { modelError, type ModelSettingsController } from './useModelSettings';
import './model-settings.css';

const loginLabels = { available: '已检测到登录', missing: '未检测到登录', expired: '登录已过期', invalid: '登录不可用', 'api-key': '当前为 API 登录' };

export function ModelSettings({ controller: c, configured, replying, onStopReply }: {
  controller: ModelSettingsController; configured: boolean; replying: boolean; onStopReply: () => Promise<unknown>;
}) {
  const [editor, setEditor] = useState<string>();
  const [removing, setRemoving] = useState<string>();
  const [query, setQuery] = useState('');
  const [stopError, setStopError] = useState('');
  const section = useRef<HTMLElement>(null), addButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const active = c.state?.profiles.find(profile => profile.id === c.state?.activeProfileId);
  const original = c.state?.profiles.find(profile => profile.id === editor);
  const profiles = c.state?.profiles.filter(profile => `${profile.name} ${profile.modelId} ${profile.providerId} ${c.state?.providers.find(provider => provider.id === profile.providerId)?.name}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(b.id === active?.id) - Number(a.id === active?.id)) ?? [];
  useEffect(() => { void c.detect(); }, [c.detect]);
  useEffect(() => {
    if (c.notice) section.current?.querySelector('[data-model-notice]')?.scrollIntoView({ block: 'nearest' });
  }, [c.notice]);

  function edit(id: string) {
    previousFocus.current = document.activeElement as HTMLElement;
    setEditor(id); setRemoving(undefined);
  }

  function closeEditor(savedId?: string) {
    setEditor(undefined);
    if (savedId) setQuery('');
    requestAnimationFrame(() => {
      const heading = savedId ? section.current?.querySelector<HTMLElement>(`[data-profile-id="${savedId}"] h4`) : undefined;
      (heading ?? (previousFocus.current?.isConnected ? previousFocus.current : addButton.current))?.focus();
    });
  }

  return <section ref={section} className="settings-card model-settings" aria-labelledby="model-settings-title">
    <div className="settings-title"><span className="task-icon"><MessageSquare size={21} /></span><div><h3 id="model-settings-title">模型配置</h3><p>管理文字对话使用的服务与模型</p></div><button type="button" className="icon-button" aria-label="刷新模型配置" disabled={c.loading || Boolean(c.pending)} onClick={() => { void c.refresh(); void c.detect(); }}><RefreshCw size={16} className={c.loading ? 'spin' : ''} /></button></div>
    <div className="model-current"><div><span className="model-eyebrow">当前文字模型</span><strong>{active?.name ?? '尚未启用模型'}</strong><p>{active ? `${c.state?.providers.find(provider => provider.id === active.providerId)?.name ?? active.providerId} · ${active.modelId}` : '添加配置后，即可在主入口开始对话。'}</p></div><span className={`model-tag ${configured ? 'success' : ''}`}>{configured ? <><Check size={12} />已启用</> : active ? '需要重新启用' : '待配置'}</span></div>
    <p className="model-hint">切换模型保留对话历史，后续对话会携带上下文发送到新选择的服务。语音模型单独配置。</p>
    {replying && <div className="model-feedback" role="status">文字回复中，结束后可修改配置或测试连接。<button type="button" className="model-link" onClick={() => { void onStopReply().catch(error => setStopError(modelError(error))); }}>停止回复</button></div>}
    {stopError && <p className="model-feedback error" role="alert">{stopError}</p>}
    {(c.error || c.state?.error) && <div className="model-feedback error" role="alert">{c.error || c.state?.error}{c.error && <button className="model-link" disabled={c.loading} onClick={() => void c.refresh()}>重试读取配置</button>}</div>}
    {c.notice && <p data-model-notice className={`model-feedback ${c.notice.kind}`} role={c.notice.kind === 'error' ? 'alert' : 'status'}>{c.notice.message}</p>}
    {!c.state ? <p className="model-hint" role="status">{c.loading ? '正在读取模型配置…' : '暂时无法读取模型配置。'}</p> : <>
      <div className="model-section-heading"><h4>已保存的配置 <span>{c.state.profiles.length}</span></h4><button ref={addButton} type="button" className="secondary-button" disabled={c.disabled || Boolean(editor) || c.state.profiles.length >= 100} onClick={() => edit('new')}><Plus size={14} />添加配置</button></div>
      {editor && (editor === 'new' || original) && <ModelProfileForm key={editor} original={original} providers={c.state.providers} controller={c} onClose={closeEditor} />}
      {c.state.profiles.length > 4 && <input className="model-profile-search" type="search" aria-label="搜索已保存的配置" placeholder="搜索配置、服务商或模型" value={query} onChange={event => setQuery(event.target.value)} />}
      {!c.state.profiles.length && !editor && !c.state.error && <div className="model-empty"><KeyRound size={23} /><strong>连接你的第一个模型</strong><p>使用 API 密钥，或复用本机的 Codex 订阅登录。</p><button type="button" className="model-primary" disabled={c.disabled} onClick={() => edit('new')}>添加模型配置</button></div>}
      <div className="model-profile-list">{profiles.map(profile => {
        const selected = profile.id === active?.id, probe = c.probes[profile.id];
        const unavailable = c.disabled || Boolean(editor);
        return <article className={`model-profile ${selected ? 'selected' : ''}`} data-profile-id={profile.id} key={profile.id} aria-label={`模型配置：${profile.name}`}>
          <div className="model-profile-heading"><span className="model-provider-icon">{profile.source === 'codex-local' ? <Laptop size={18} /> : <KeyRound size={18} />}</span><div><h4 tabIndex={-1}>{profile.name}</h4><p>{c.state?.providers.find(provider => provider.id === profile.providerId)?.name ?? profile.providerId} · <span>{profile.modelId}</span></p></div>{selected && <span className="model-tag">当前选择</span>}</div>
          <div className="model-profile-meta"><span className="model-tag">{profile.readOnly ? '环境变量 · 只读' : profile.source === 'codex-local' ? '本地订阅' : 'API 密钥'}</span><span>{profile.source === 'codex-local' ? c.codex ? loginLabels[c.codex.status] : '正在检测登录…' : profile.hasApiKey ? profile.readOnly ? '由环境提供密钥' : '密钥已保存' : '未提供密钥'}</span></div>
          {profile.baseUrl && <p className="model-endpoint">{profile.baseUrl}</p>}
          {profile.source === 'codex-local' && c.codex && c.codex.status !== 'available' && <p className="model-feedback" role="status">{c.codex.message}</p>}
          {profile.readOnly ? <p className="model-hint">由启动环境提供。添加应用配置后可在此管理；原密钥不会自动复制。</p> : <>
            <div className="model-profile-actions"><button type="button" className={selected && configured ? 'secondary-button' : 'model-primary'} disabled={unavailable} onClick={() => void c.activate(profile.id)}>{c.pending === `activate:${profile.id}` ? <LoaderCircle size={13} className="spin" /> : null}{selected ? '重新启用' : '启用'}</button><button type="button" className="secondary-button" disabled={unavailable} onClick={() => void c.test(profile.id)}>{c.pending === `test:${profile.id}` ? <><LoaderCircle size={13} className="spin" />测试中…</> : '测试连接'}</button><button type="button" className="model-link" disabled={unavailable} onClick={() => edit(profile.id)}>编辑</button><button type="button" className="model-link model-remove" disabled={unavailable} onClick={() => setRemoving(profile.id)}>删除</button></div>
            {probe && <p className={`model-feedback ${probe.ok ? 'success' : 'error'}`} role={probe.ok ? 'status' : 'alert'}>{probe.ok ? `连接成功 · ${(probe.elapsedMs / 1000).toFixed(1)} 秒` : '连接失败'}<span>{probe.message}</span></p>}
            {removing === profile.id && <div className="model-delete-confirm" role="group" aria-label={`删除确认：${profile.name}`}><p>删除「{profile.name}」？{selected ? '删除后文字对话将暂停，直到启用另一套配置。' : ''}对话历史会保留。</p><div><button type="button" className="secondary-button" disabled={c.disabled} onClick={() => setRemoving(undefined)}>保留配置</button><button type="button" className="model-danger" disabled={c.disabled} onClick={async () => { if (await c.remove(profile.id)) { setRemoving(undefined); addButton.current?.focus(); } }}>确认删除</button></div></div>}
          </>}
        </article>;
      })}</div>
      {query && !profiles.length && <p className="model-hint" role="status">没有匹配的配置。</p>}
      {c.state.profiles.some(profile => !profile.readOnly) && <p className="model-hint">测试连接会发送一次简短请求，可能产生少量模型用量；不会切换当前模型。</p>}
    </>}
  </section>;
}
