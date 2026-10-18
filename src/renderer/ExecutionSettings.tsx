import { useEffect, useRef, useState } from 'react';
import { Cpu, LoaderCircle, RefreshCw } from 'lucide-react';
import type { ExecutionConfiguration, ExecutionSettings as Settings } from '../domains/tasks/execution';
import { RUNTIME_LABELS, taskError } from './task-presentation';

export function ExecutionSettings() {
  const [configuration, setConfiguration] = useState<ExecutionConfiguration>();
  const [settings, setSettings] = useState<Settings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const alive = useRef(true);
  const locked = useRef(false);
  async function load(save = false) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setSaved(false);
    try {
      const next = save && settings ? await window.orbit.execution.configure(settings) : await window.orbit.execution.configuration();
      if (alive.current) { setConfiguration(next); setSettings(next.settings); setSaved(save); }
    } catch (failure) { if (alive.current) setError(taskError(failure)); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
  const modified = settings && configuration && JSON.stringify(settings) !== JSON.stringify(configuration.settings);
  return <section className="settings-card execution-settings" aria-labelledby="execution-settings-title">
    <div className="settings-title"><span className="task-icon"><Cpu size={21} /></span><div><h3 id="execution-settings-title">任务执行</h3><p>选择完成后台任务的 Agent 运行时</p></div><button className="icon-button" aria-label="重新检测运行时" disabled={busy} onClick={() => void load()}>{busy ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}</button></div>
    {(error || configuration?.error) && <p className="task-error" role="alert">{error || configuration?.error}</p>}
    {configuration && settings ? <>
      <fieldset className="runtime-options" disabled={busy}><legend>执行运行时</legend>{configuration.runtimes.map(runtime => <label className={'runtime-option ' + (settings.runtime === runtime.runtime ? 'selected' : '')} key={runtime.runtime}>
        <input type="radio" name="task-runtime" value={runtime.runtime} checked={settings.runtime === runtime.runtime} onChange={() => { setSettings({ ...settings, runtime: runtime.runtime }); setSaved(false); }} />
        <span><strong>{RUNTIME_LABELS[runtime.runtime]}</strong><small>{runtime.message}</small>{runtime.version && <small className="runtime-version">{runtime.version}</small>}</span><span className={'badge ' + (runtime.available ? 'status-completed' : '')}>{runtime.available ? '可用' : '不可用'}</span>
      </label>)}</fieldset>
      <label className="concurrency-field">最多同时运行的步骤数<select aria-label="最多同时运行的步骤数" value={settings.maxConcurrency} disabled={busy} onChange={event => { setSettings({ ...settings, maxConcurrency: Number(event.target.value) }); setSaved(false); }}>{[1, 2, 3, 4].map(number => <option key={number} value={number}>{number}</option>)}</select></label>
      <p className="field-help">运行时变更用于新派发的任务，已有任务继续使用原来的配置。并发上限立即生效，等待答复的步骤也占用名额。</p>
      <p className="field-help">关闭窗口后继续执行；彻底退出会停止任务，重开后恢复未完成步骤。</p>
      <div className="settings-actions"><button className="primary-button" disabled={busy || !modified} onClick={() => void load(true)}>保存执行设置</button>{saved && <span role="status">执行设置已保存</span>}</div>
    </> : !error && <p className="field-help">正在检测本机运行时…</p>}
  </section>;
}
