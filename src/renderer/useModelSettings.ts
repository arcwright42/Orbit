import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodexLoginStatus, ModelConfigurationState, ModelConnectionResult, ModelProfileInput } from '../domains/models/model';

export const modelError = (error: unknown) => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': (?:\w+Error|Error): /, '')
  : '模型操作失败，请重试。';
type Notice = { kind: 'success' | 'error'; message: string };
type Probe = ModelConnectionResult & { elapsedMs: number };

/** Kept at App scope so a pending operation survives leaving the settings page. */
export function useModelSettings(replying: boolean) {
  const [state, setState] = useState<ModelConfigurationState>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [notice, setNotice] = useState<Notice>();
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [codex, setCodex] = useState<CodexLoginStatus>();
  const [detecting, setDetecting] = useState(false);
  const alive = useRef(false), revision = useRef(0), detection = useRef(0), locked = useRef(false);
  const current = useRef({ state, replying, loading, error }); current.current = { state, replying, loading, error };

  const refresh = useCallback(async () => {
    const request = ++revision.current;
    setLoading(true);
    try {
      const next = await window.orbit.models.read();
      if (alive.current && request === revision.current) { setState(next); setError(''); }
    } catch (error) { if (alive.current && request === revision.current) setError(modelError(error)); }
    finally { if (alive.current && request === revision.current) setLoading(false); }
  }, []);

  const detect = useCallback(async () => {
    const request = ++detection.current;
    setDetecting(true);
    try {
      const next = await window.orbit.models.detectCodex();
      if (alive.current && request === detection.current) setCodex(next);
    } catch (error) {
      if (alive.current && request === detection.current) setCodex({ status: 'invalid', message: modelError(error) });
    } finally { if (alive.current && request === detection.current) setDetecting(false); }
  }, []);

  useEffect(() => {
    alive.current = true;
    const unsubscribe = window.orbit.models.onChanged(next => {
      revision.current++;
      setState(next); setError(''); setLoading(false); setProbes({});
    });
    void refresh();
    return () => { alive.current = false; revision.current++; detection.current++; unsubscribe(); };
  }, [refresh]);

  async function run<T>(operation: string, work: () => Promise<T>): Promise<T | undefined> {
    const view = current.current;
    if (locked.current || view.replying || view.loading || view.error || !view.state || view.state.error) return;
    locked.current = true; setPending(operation); setNotice(undefined);
    try { return await work(); }
    catch (error) { if (alive.current) setNotice({ kind: 'error', message: modelError(error) }); }
    finally { locked.current = false; if (alive.current) setPending(''); }
  }

  function accept(next: ModelConfigurationState) {
    if (alive.current) { revision.current++; setState(next); setLoading(false); setError(''); }
  }

  async function save(input: ModelProfileInput, activate: boolean) {
    return run('save', async () => {
      const ids = new Set(current.current.state?.profiles.map(profile => profile.id));
      const saved = await window.orbit.models.save(input); accept(saved);
      const profile = saved.profiles.find(profile => input.id ? profile.id === input.id : !ids.has(profile.id));
      if (!profile) throw new Error('配置已保存，请刷新后查看。');
      if (alive.current) setProbes(previous => { const next = { ...previous }; delete next[profile.id]; return next; });
      if (activate) {
        try {
          accept(await window.orbit.models.activate(profile.id));
          if (alive.current) setNotice({ kind: 'success', message: `已启用「${profile.name}」，可以回到主入口继续对话。` });
        } catch (error) {
          if (alive.current) setNotice({ kind: 'error', message: `「${profile.name}」已保存，但启用失败：${modelError(error)}` });
        }
      } else if (alive.current) setNotice({ kind: 'success', message: saved.activeProfileId === profile.id
        ? `「${profile.name}」已更新并生效。` : `「${profile.name}」已保存。启用后用于文字对话。` });
      return profile.id;
    });
  }

  async function activate(id: string) {
    return run(`activate:${id}`, async () => {
      const next = await window.orbit.models.activate(id); accept(next);
      if (alive.current) setNotice({ kind: 'success', message: '模型已启用，对话历史已保留。' });
      return true;
    });
  }

  async function remove(id: string) {
    return run(`remove:${id}`, async () => {
      const next = await window.orbit.models.remove(id); accept(next);
      if (alive.current) setNotice({ kind: 'success', message: '配置已删除，对话历史仍然保留。' });
      return true;
    });
  }

  async function test(id: string) {
    return run(`test:${id}`, async () => {
      const started = performance.now();
      let result: ModelConnectionResult;
      try { result = await window.orbit.models.test(id); }
      catch (error) { result = { ok: false, message: modelError(error) }; }
      if (alive.current) setProbes(previous => ({ ...previous, [id]: { ...result, elapsedMs: Math.round(performance.now() - started) } }));
      return result;
    });
  }

  return { state, loading, error, pending, notice, probes, codex, detecting, refresh, detect, save, activate, remove, test,
    disabled: loading || Boolean(pending || error || state?.error) || replying || !state,
  };
}

export type ModelSettingsController = ReturnType<typeof useModelSettings>;
