import { useEffect, useState } from 'react';
import type { TextModelSettings, TextModelProtocol } from '../contracts';

export function ModelSettings() {
  const [config, setConfig] = useState<TextModelSettings>();
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { window.orbit.textModel().then(setConfig).catch(() => setNotice('无法读取模型设置。')); }, []);
  const update = (value: Partial<TextModelSettings>) => { setConfig(c => c && ({ ...c, ...value })); setNotice(''); };
  async function save() {
    if (!config) return;
    setBusy(true); setNotice('');
    try { setConfig(await window.orbit.saveTextModel({ protocol: config.protocol, baseUrl: config.baseUrl, model: config.model, apiKey: key || undefined, clearKey })); setKey(''); setClearKey(false); setNotice('已保存，下次文本对话生效。'); }
    catch (error) { setNotice(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '保存失败。'); }
    finally { setBusy(false); }
  }
  return <div className="settings-card model-settings"><div className="settings-title"><div><h3>文本交互模型</h3><p>直接输入的文字由此模型处理。语音使用独立的 Qwen 配置。</p></div></div>{config && <fieldset disabled={busy}>
    <label>接口协议<select aria-label="文本模型协议" value={config.protocol} onChange={e => update({ protocol: e.target.value as TextModelProtocol })}><option value="openai-completions">OpenAI 兼容 · Chat Completions</option><option value="openai-responses">OpenAI 兼容 · Responses</option><option value="anthropic-messages">Anthropic · Messages</option></select></label>
    <label>服务地址<input aria-label="文本模型服务地址" placeholder="https://your-provider.example/v1" value={config.baseUrl} onChange={e => update({ baseUrl: e.target.value })} /></label>
    <label>模型名称<input aria-label="文本模型名称" placeholder="服务商提供的模型 ID" value={config.model} onChange={e => update({ model: e.target.value })} /></label>
    <label>API Key<input aria-label="文本模型 API Key" type="password" autoComplete="off" value={key} placeholder={config.hasKey ? '已保存，留空保留' : '本地无鉴权服务可留空'} onChange={e => setKey(e.target.value)} /></label>
    {config.hasKey && <label className="checkbox-label"><input type="checkbox" checked={clearKey} onChange={e => setClearKey(e.target.checked)} />清除已保存的密钥</label>}
    <p className="field-help">密钥通过系统密钥存储加密保存在本机。更换协议或服务地址时需重新填写密钥。模型需支持工具调用；本机地址支持 HTTP。</p>
    <button className="primary-button" onClick={() => void save()}>{busy ? '保存中…' : '保存文本模型'}</button>
  </fieldset>}{notice && <p role="status">{notice}</p>}</div>;
}
