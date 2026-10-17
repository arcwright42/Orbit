import { InMemoryCredentialStore, InMemoryModelsStore, type Provider } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ModelConfigurationError, type ModelCredential, type ModelOption, type ModelProfile } from '../../domains/models/model';
import { modelUnavailableReason, validateProfile } from '../../domains/models/providers';

export type ResolveModelCredential = (id: string) => Promise<ModelCredential | undefined>;
const emptyRuntime = () => ModelRuntime.create({
  credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
  modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
});

let catalogRuntime: Promise<ModelRuntime> | undefined;
export async function modelCatalog(providerId: string): Promise<ModelOption[]> {
  if (providerId === 'custom') return [];
  catalogRuntime ??= emptyRuntime();
  return (await catalogRuntime).getModels(providerId)
    .filter(model => !modelUnavailableReason(providerId, model.id))
    .map(({ id, name, contextWindow, maxTokens }) => ({ id, name, contextWindow, maxTokens }));
}

export async function createModelRuntime(profile: ModelProfile, credential: ResolveModelCredential) {
  const unavailable = modelUnavailableReason(profile.providerId, profile.modelId);
  if (unavailable) throw new ModelConfigurationError(unavailable);
  const runtime = await emptyRuntime();
  if (profile.providerId === 'custom') {
    const { profile: custom } = validateProfile(profile, profile.id);
    runtime.registerProvider('custom', {
      baseUrl: custom.baseUrl, api: 'openai-completions',
      models: [{ id: custom.modelId, name: custom.modelId, reasoning: false, input: ['text'],
        contextWindow: custom.contextWindow!, maxTokens: custom.maxTokens!,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens' },
      }],
    });
  }
  const original = runtime.getProvider(profile.providerId);
  if (!original) throw new ModelConfigurationError('未找到配置的模型服务。');
  const provider: Provider = {
    ...original,
    // No OAuth handler/store: borrowed refresh tokens can never enter Pi's refresh path.
    auth: { apiKey: {
      name: profile.source === 'codex-local' ? '本地 Codex 登录' : 'Orbit API key',
      resolve: async input => {
        input.signal.throwIfAborted();
        const resolved = await credential(profile.id);
        input.signal.throwIfAborted();
        if (resolved) {
          if (resolved.expiresAt !== undefined && resolved.expiresAt <= Date.now() + 30_000) throw new ModelConfigurationError('Codex 登录已过期，请在 Codex 续期后重新检测。');
          return { auth: { apiKey: resolved.apiKey }, source: profile.source === 'codex-local' ? 'Codex auth.json' : 'Orbit' };
        }
        // Preserve native provider env auth only for the explicit read-only legacy profile.
        if (profile.id === 'environment' && profile.source === 'api') return original.auth.apiKey?.resolve(input);
        throw new ModelConfigurationError('模型凭据不可用，请检查配置或在 Codex 重新登录。');
      },
    } },
  };
  if (profile.providerId === 'openrouter') {
    const models = original.getModels().map(model => ({ ...model, api: 'openai-completions' as const, baseUrl: 'https://openrouter.ai/api/v1' }));
    provider.getModels = () => models;
    provider.getAllModels = () => models;
  }
  runtime.registerNativeProvider(provider);
  const model = runtime.getModel(profile.providerId, profile.modelId);
  if (!model) throw new ModelConfigurationError('未找到配置的模型，请检查模型 ID。');
  if (!await runtime.getAuth(model)) throw new ModelConfigurationError('请配置文字对话的模型密钥。');
  return { runtime, model };
}

export function modelFailure(error: unknown): string {
  // SDK errors can contain provider response bodies. Only our own controlled errors reach IPC.
  for (let cause = error, depth = 0; cause && depth < 6; depth++) {
    if (cause instanceof ModelConfigurationError) return cause.message;
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return '模型连接失败，请检查服务地址、模型、密钥或 Codex 登录状态。';
}

export async function testModelConnection(profile: ModelProfile, credential: ResolveModelCredential) {
  try {
    const { runtime, model } = await createModelRuntime(profile, credential);
    const result = await runtime.completeSimple(model, {
      messages: [{ role: 'user', content: 'Reply OK.', timestamp: Date.now() }],
    }, { maxTokens: 16, transport: 'sse', signal: AbortSignal.timeout(15_000) });
    return result.stopReason === 'error' || result.stopReason === 'aborted'
      ? { ok: false, message: '模型连接失败，请检查模型访问权限、额度或 Codex 登录状态。' }
      : { ok: true, message: '模型连接成功。' };
  } catch (error) { return { ok: false, message: modelFailure(error) }; }
}
