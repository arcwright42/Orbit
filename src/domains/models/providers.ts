import { ModelConfigurationError, type ModelProfile, type ModelProfileInput, type ProviderDefinition } from './model';

export const PROVIDERS: readonly ProviderDefinition[] = [
  { id: 'openai', name: 'OpenAI', source: 'api', protocol: 'openai-responses', customEndpoint: false, manualModel: false },
  { id: 'anthropic', name: 'Anthropic', source: 'api', protocol: 'anthropic-messages', customEndpoint: false, manualModel: false },
  { id: 'openrouter', name: 'OpenRouter', source: 'api', protocol: 'openai-completions', customEndpoint: false, manualModel: false },
  { id: 'custom', name: 'OpenAI 兼容服务', source: 'api', protocol: 'openai-completions', customEndpoint: true, manualModel: true },
  { id: 'openai-codex', name: '本地 Codex 登录', source: 'codex-local', protocol: 'openai-codex-responses', customEndpoint: false, manualModel: false },
];

// Pi 1.3.0's bundled catalog predates these ChatGPT-sign-in retirements.
// Verified 2026-10-17: https://learn.chatgpt.com/docs/models#deprecated-codex-models
// This policy does not restrict the OpenAI API provider or custom endpoints.
const RETIRED_CODEX_MODELS = new Set(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-5.3-codex', 'gpt-5.2']);
export function modelUnavailableReason(providerId: string, modelId: string): string | undefined {
  if (providerId === 'openai-codex' && RETIRED_CODEX_MODELS.has(modelId)) {
    return '该模型已停止支持 Codex 的 ChatGPT 登录，请重新选择模型；原配置和对话仍然保留。';
  }
  return undefined;
}

export function providerDefinition(id: unknown): ProviderDefinition {
  const provider = PROVIDERS.find(item => item.id === id);
  if (!provider) throw new ModelConfigurationError('不支持该模型服务。');
  return provider;
}

export function validateProfile(value: unknown, id: string): { profile: ModelProfile; apiKey?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModelConfigurationError('模型配置无效。');
  const input = value as Partial<ModelProfileInput>;
  const provider = providerDefinition(input.providerId);
  if (input.source !== provider.source) throw new ModelConfigurationError('凭据类型与模型服务不匹配。');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new ModelConfigurationError('配置名称需要 1–80 个字符。');
  if (typeof input.modelId !== 'string' || !input.modelId.trim() || input.modelId.length > 200 || /[\r\n\0]/.test(input.modelId)) {
    throw new ModelConfigurationError('请填写有效的模型 ID。');
  }
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 16384 || /[\r\n\0]/.test(input.apiKey))) {
    throw new ModelConfigurationError('API key 无效；保留原密钥时请省略该字段。');
  }
  const profile: ModelProfile = { id, name: input.name.trim(), source: provider.source, providerId: provider.id, modelId: input.modelId.trim() };
  if (provider.customEndpoint) {
    let url: URL;
    try { url = new URL(input.baseUrl ?? ''); } catch { throw new ModelConfigurationError('请填写模型服务的完整 API 地址。'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.href.length > 2048 || /\/chat\/completions\/?$/.test(url.pathname)) {
      throw new ModelConfigurationError('API 地址应包含 API 前缀，不包含凭据、查询参数或 /chat/completions。');
    }
    profile.baseUrl = url.href.replace(/\/$/, '');
    profile.contextWindow = input.contextWindow ?? 32768;
    profile.maxTokens = input.maxTokens ?? 4096;
    if (!Number.isSafeInteger(profile.contextWindow) || !Number.isSafeInteger(profile.maxTokens) || profile.maxTokens < 1 || profile.contextWindow <= profile.maxTokens) {
      throw new ModelConfigurationError('上下文窗口必须大于最大输出长度，且两者必须为正整数。');
    }
  } else if (input.baseUrl !== undefined || input.contextWindow !== undefined || input.maxTokens !== undefined) {
    throw new ModelConfigurationError('该预设使用内置端点和模型参数；自定义地址请选择兼容服务。');
  }
  if (provider.source === 'codex-local' && input.apiKey !== undefined) throw new ModelConfigurationError('Codex 使用本地登录，不接受 API key。');
  return { profile, ...(input.apiKey !== undefined ? { apiKey: input.apiKey.trim() } : {}) };
}
