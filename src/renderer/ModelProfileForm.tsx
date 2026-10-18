import { useEffect, useRef, useState } from 'react';
import { KeyRound, Laptop, LoaderCircle, X } from 'lucide-react';
import type { ModelProfileView, ProviderDefinition } from '../domains/models/model';
import { ModelPicker } from './ModelPicker';
import type { ModelSettingsController } from './useModelSettings';

function endpoint(value: string) {
  try { return new URL(value).href.replace(/\/$/, ''); } catch { return value.trim(); }
}

export function ModelProfileForm({ original, providers, controller, onClose }: {
  original?: ModelProfileView; providers: ProviderDefinition[]; controller: ModelSettingsController;
  onClose: (savedId?: string) => void;
}) {
  const [providerId, setProviderId] = useState(original?.providerId ?? providers.find(provider => provider.source === 'api')?.id ?? providers[0].id);
  const [name, setName] = useState(original?.name ?? '');
  const [modelId, setModelId] = useState(original?.modelId ?? '');
  const [baseUrl, setBaseUrl] = useState(original?.baseUrl ?? '');
  const [contextWindow, setContextWindow] = useState(String(original?.contextWindow ?? 32768));
  const [maxTokens, setMaxTokens] = useState(String(original?.maxTokens ?? 4096));
  const [apiKey, setApiKey] = useState('');
  const [modelReady, setModelReady] = useState(false);
  const [validation, setValidation] = useState('');
  const nameRef = useRef<HTMLInputElement>(null), formRef = useRef<HTMLFormElement>(null);
  const submitting = useRef(false);
  const provider = providers.find(provider => provider.id === providerId)!;
  const isActive = original?.id === controller.state?.activeProfileId;
  const canKeepKey = original?.hasApiKey && original.providerId === providerId && original.source === provider.source
    && (!provider.customEndpoint || endpoint(baseUrl) === endpoint(original.baseUrl ?? ''));
  const validModel = provider.manualModel ? Boolean(modelId.trim()) : modelReady;
  useEffect(() => { nameRef.current?.focus(); }, []);

  function choose(id: string) {
    setProviderId(id); setModelId(''); setBaseUrl(''); setApiKey(''); setModelReady(false); setValidation('');
    setContextWindow('32768'); setMaxTokens('4096');
  }

  async function submit(activate: boolean) {
    if (submitting.current || controller.disabled || !validModel || !formRef.current?.reportValidity()) return;
    if (provider.customEndpoint && Number(contextWindow) <= Number(maxTokens)) {
      setValidation('上下文窗口必须大于最大输出长度。'); return;
    }
    submitting.current = true; setValidation('');
    try {
      const id = await controller.save({
        ...(original ? { id: original.id } : {}), name: name.trim(), source: provider.source, providerId,
        modelId: modelId.trim(), ...(provider.customEndpoint ? { baseUrl: baseUrl.trim(), contextWindow: Number(contextWindow), maxTokens: Number(maxTokens) } : {}),
        ...(provider.source === 'api' && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      }, activate);
      if (id) { setApiKey(''); onClose(id); }
    } finally { submitting.current = false; }
  }

  return <form ref={formRef} className="model-editor" aria-label={original ? '编辑模型配置' : '添加模型配置'} onSubmit={event => { event.preventDefault(); void submit(!isActive); }}>
    <div className="model-section-heading"><h4>{original ? '编辑配置' : '添加模型配置'}</h4><button type="button" className="icon-button" aria-label="关闭模型表单" disabled={Boolean(controller.pending)} onClick={() => onClose()}><X size={18} /></button></div>
    <fieldset disabled={controller.disabled}>
      <legend>连接方式</legend>
      <div className="model-source-options">
        <label className={provider.source === 'api' ? 'selected' : ''}><input type="radio" name="model-source" value="api" checked={provider.source === 'api'} onChange={() => choose(providers.find(provider => provider.source === 'api')!.id)} /><KeyRound size={18} /><span><strong>API 密钥</strong><small>连接模型服务或兼容接口</small></span></label>
        <label className={provider.source === 'codex-local' ? 'selected' : ''}><input type="radio" name="model-source" value="codex-local" checked={provider.source === 'codex-local'} onChange={() => choose('openai-codex')} /><Laptop size={18} /><span><strong>本地订阅</strong><small>复用本机 Codex 登录</small></span></label>
      </div>
      <div className="model-form-grid">
        <label>配置名称<input ref={nameRef} required maxLength={80} value={name} placeholder="例如：日常对话" onChange={event => setName(event.target.value)} /></label>
        <label>服务商<select aria-label="服务商" value={providerId} onChange={event => choose(event.target.value)}>{providers.filter(candidate => candidate.source === provider.source).map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
      </div>
      {provider.source === 'api' ? <label>API Key<input aria-label="API Key" aria-describedby="model-key-help" type="password" autoComplete="new-password" spellCheck={false} maxLength={16384} required={!canKeepKey} value={apiKey} placeholder={canKeepKey ? '已保存密钥；留空保持不变' : '输入该服务的 API Key'} onChange={event => setApiKey(event.target.value)} /><span id="model-key-help" className="model-hint">{canKeepKey ? '密钥不会回显。填写新值会替换已保存的密钥。' : '密钥加密保存在本机。更换服务商或地址时需要重新填写。'}</span></label>
        : <div className="model-local-auth"><div><strong>Codex · ChatGPT 登录</strong><button type="button" className="model-link" disabled={controller.detecting} onClick={() => void controller.detect()}>{controller.detecting ? '检测中…' : '重新检测登录'}</button></div><p className="model-hint" role="status">{controller.codex?.message ?? '正在检测本机登录…'}</p><p className="model-hint">在 Codex 中完成登录或续期，再回到这里检测。Orbit 不修改你的 Codex 登录。</p></div>}
      {provider.customEndpoint && <label>API 地址<input aria-label="API 地址" aria-describedby="model-url-help" type="url" required maxLength={2048} value={baseUrl} placeholder="https://your-provider.example/v1" onChange={event => setBaseUrl(event.target.value)} /><span id="model-url-help" className="model-hint">使用 OpenAI Chat Completions 协议。填写 API 前缀，不包含 /chat/completions。</span></label>}
      {provider.manualModel ? <label>模型 ID<input required maxLength={200} value={modelId} placeholder="填写服务商提供的模型 ID" onChange={event => setModelId(event.target.value)} /></label>
        : <ModelPicker key={providerId} providerId={providerId} value={modelId} disabled={controller.disabled} onChange={setModelId} onReady={setModelReady} />}
      {provider.customEndpoint && <details className="model-advanced"><summary>模型容量</summary><div className="model-form-grid"><label>上下文窗口（token）<input type="number" required min={2} step={1} max={Number.MAX_SAFE_INTEGER} value={contextWindow} onChange={event => setContextWindow(event.target.value)} /></label><label>最大输出（token）<input type="number" required min={1} step={1} max={Number.MAX_SAFE_INTEGER} value={maxTokens} onChange={event => setMaxTokens(event.target.value)} /></label></div><p className="model-hint">按服务商的模型规格填写，上下文窗口必须大于最大输出。</p></details>}
    </fieldset>
    {controller.state?.profiles.some(profile => profile.readOnly) && <p className="model-feedback">当前使用环境变量配置。首次保存后改由应用管理模型；选择“仅保存”会暂时停用文字对话，启用配置后恢复。</p>}
    {validation && <p className="model-feedback error" role="alert">{validation}</p>}
    <div className="model-editor-actions">
      <button type="submit" className="model-primary" disabled={controller.disabled || !validModel}>{controller.pending === 'save' && <LoaderCircle size={14} className="spin" />}{isActive ? '保存更改' : '保存并启用'}</button>
      {!isActive && <button type="button" className="secondary-button" disabled={controller.disabled || !validModel} onClick={() => void submit(false)}>仅保存</button>}
      <button type="button" className="model-link" disabled={Boolean(controller.pending)} onClick={() => onClose()}>取消编辑</button>
    </div>
  </form>;
}
