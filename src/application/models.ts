import { randomUUID } from 'node:crypto';
import {
  ModelConfigurationError, type CodexCredentialSource, type ModelConfigurationState, type ModelCredential,
  type ModelDocument, type ModelProfile, type ModelRepository, type ModelRuntimePort, type SecretProtection,
} from '../domains/models/model';
import { PROVIDERS, providerDefinition, validateProfile } from '../domains/models/providers';

export class ModelConfigurationService {
  private document?: ModelDocument;
  private staged?: ModelDocument;
  private error?: string;
  private changing = false;

  constructor(
    private repository: ModelRepository,
    private secrets: SecretProtection,
    private codex: CodexCredentialSource,
    private runtime: ModelRuntimePort,
    private environment: { profile: ModelProfile | null; apiKey?: string },
    private changed: (state: ModelConfigurationState) => void = () => {},
  ) {
    try { this.document = repository.read(); }
    catch (error) { this.error = error instanceof ModelConfigurationError ? error.message : '模型配置读取失败。'; }
  }

  current(): ModelProfile | null {
    if (this.error) return null;
    const document = this.staged ?? this.document;
    return structuredClone(document ? document.profiles.find(entry => entry.profile.id === document.activeProfileId)?.profile ?? null : this.environment.profile);
  }

  read(): ModelConfigurationState {
    return structuredClone({
      providers: [...PROVIDERS],
      profiles: this.document
        ? this.document.profiles.map(({ profile, encryptedApiKey }) => ({ ...profile, hasApiKey: Boolean(encryptedApiKey) }))
        : !this.error && this.environment.profile ? [{ ...this.environment.profile, hasApiKey: this.environment.profile.source === 'api' && Boolean(this.environment.apiKey), readOnly: true }] : [],
      activeProfileId: this.error ? null : this.document ? this.document.activeProfileId : this.environment.profile?.id ?? null,
      ...(this.error ? { error: this.error } : {}),
    });
  }

  assertCanSend(): void {
    if (this.changing) throw new ModelConfigurationError('模型配置正在更新，请稍后发送。');
    if (this.error) throw new ModelConfigurationError(this.error);
  }

  credential(id: string): ModelCredential | undefined {
    const document = this.staged ?? this.document;
    if (id === 'environment' && !document && !this.error && this.environment.profile) {
      if (this.environment.profile.source === 'codex-local') return this.codex.resolve();
      return this.environment.apiKey ? { apiKey: this.environment.apiKey } : undefined;
    }
    const entry = document?.profiles.find(item => item.profile.id === id);
    if (!entry) throw new ModelConfigurationError('模型配置不存在。');
    if (entry.profile.source === 'codex-local') return this.codex.resolve();
    if (!entry.encryptedApiKey) throw new ModelConfigurationError('请为这套配置填写 API key。');
    return { apiKey: this.secrets.decrypt(entry.encryptedApiKey) };
  }

  executionCredential(profile: ModelProfile): ModelCredential | undefined {
    const current = this.read().profiles.find(candidate => candidate.id === profile.id);
    if (!current || current.providerId !== profile.providerId || current.source !== profile.source || current.baseUrl !== profile.baseUrl) {
      throw new ModelConfigurationError('任务所用模型配置已删除或服务地址已改变，请恢复配置后重试。');
    }
    return this.credential(profile.id);
  }

  detectCodex() { return this.codex.status(); }
  catalog(id: unknown) { return this.runtime.catalog(providerDefinition(id).id); }

  private requireId(value: unknown): string {
    if (typeof value !== 'string' || !/^[\w-]{8,80}$/.test(value) || value === 'environment') throw new ModelConfigurationError('配置标识无效，环境变量配置为只读。');
    return value;
  }

  private async mutate(work: (document: ModelDocument) => Promise<void> | void, forceConfigure = false): Promise<ModelConfigurationState> {
    if (this.error) throw new ModelConfigurationError(this.error);
    if (this.changing || this.runtime.isBusy()) throw new ModelConfigurationError('请等待当前回复或模型操作结束，或先停止回复。');
    this.changing = true;
    const previous = this.current();
    const next = structuredClone(this.document ?? { version: 1 as const, activeProfileId: null, profiles: [] });
    let reconfigured = false;
    try {
      await work(next);
      this.staged = next;
      const current = this.current();
      // Updating the active entry also rebinds its credential, even when its model ID is unchanged.
      const activeChanged = JSON.stringify(previous) !== JSON.stringify(current) ||
        JSON.stringify(this.document?.profiles.find(item => item.profile.id === next.activeProfileId)) !== JSON.stringify(next.profiles.find(item => item.profile.id === next.activeProfileId));
      if (activeChanged || forceConfigure) {
        reconfigured = true;
        await this.runtime.configure(current);
      }
      this.repository.write(next);
      this.document = next;
    } catch (error) {
      this.staged = undefined;
      if (reconfigured) {
        try { await this.runtime.configure(previous); }
        catch {
          // A previous credential may also have expired. Never leave the uncommitted target bound.
          try { await this.runtime.configure(null); } catch { /* A disconnected worker is already unusable. */ }
        }
      }
      throw error;
    } finally { this.staged = undefined; this.changing = false; }
    const state = this.read(); this.changed(state); return state;
  }

  save(value: unknown): Promise<ModelConfigurationState> {
    return this.mutate(async document => {
      const candidate = value as { id?: unknown } | null;
      const id = candidate?.id === undefined ? randomUUID() : this.requireId(candidate.id);
      const existing = document.profiles.find(item => item.profile.id === id);
      if (candidate?.id !== undefined && !existing) throw new ModelConfigurationError('模型配置不存在。');
      if (!existing && document.profiles.length >= 100) throw new ModelConfigurationError('最多保存 100 套模型配置。');
      const { profile, apiKey } = validateProfile(value, id);
      if (!providerDefinition(profile.providerId).manualModel && !(await this.runtime.catalog(profile.providerId)).some(model => model.id === profile.modelId)) {
        throw new ModelConfigurationError('模型不在当前支持目录中，请重新选择模型。');
      }
      const sameDestination = existing?.profile.source === profile.source && existing?.profile.providerId === profile.providerId && existing?.profile.baseUrl === profile.baseUrl;
      const encryptedApiKey = apiKey !== undefined ? this.secrets.encrypt(apiKey) : sameDestination ? existing?.encryptedApiKey : undefined;
      if (profile.source === 'api' && !encryptedApiKey) throw new ModelConfigurationError('请为新的服务或地址填写 API key。');
      const entry = { profile, ...(encryptedApiKey ? { encryptedApiKey } : {}) };
      document.profiles = [...document.profiles.filter(item => item.profile.id !== id), entry];
    });
  }

  remove(value: unknown): Promise<ModelConfigurationState> {
    return this.mutate(document => {
      const id = this.requireId(value);
      if (!document.profiles.some(item => item.profile.id === id)) throw new ModelConfigurationError('模型配置不存在。');
      document.profiles = document.profiles.filter(item => item.profile.id !== id);
      if (document.activeProfileId === id) document.activeProfileId = null;
    });
  }

  activate(value: unknown): Promise<ModelConfigurationState> {
    return this.mutate(document => {
      const id = this.requireId(value);
      if (!document.profiles.some(item => item.profile.id === id)) throw new ModelConfigurationError('模型配置不存在。');
      document.activeProfileId = id;
    }, true);
  }

  async test(value: unknown) {
    if (this.changing || this.runtime.isBusy()) throw new ModelConfigurationError('请等待当前回复或模型操作结束。');
    const id = this.requireId(value);
    const entry = this.document?.profiles.find(item => item.profile.id === id);
    if (!entry) throw new ModelConfigurationError('模型配置不存在，请先保存。');
    this.changing = true;
    try { return await this.runtime.testModel(entry.profile); }
    finally { this.changing = false; }
  }
}
