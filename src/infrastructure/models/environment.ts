import type { ModelProfile } from '../../domains/models/model';

// Legacy environment configuration stays read-only and is used only before a models.json exists.
export function environmentProfile(env: NodeJS.ProcessEnv): ModelProfile | null {
  const modelId = env.ORBIT_AGENT_MODEL?.trim();
  const baseUrl = env.ORBIT_AGENT_BASE_URL?.trim();
  const providerId = baseUrl ? 'custom' : env.ORBIT_AGENT_PROVIDER?.trim();
  if (!modelId || !providerId) return null;
  let publicUrl: string | undefined;
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) publicUrl = url.href.replace(/\/$/, '');
    } catch { /* Keep an invalid custom profile unconfigured, without exposing a credential-bearing URL. */ }
  }
  return {
    id: 'environment', name: '环境变量配置', providerId, modelId,
    source: providerId === 'openai-codex' ? 'codex-local' : 'api',
    ...(baseUrl ? { baseUrl: publicUrl, contextWindow: Number(env.ORBIT_AGENT_CONTEXT_WINDOW ?? 32768), maxTokens: Number(env.ORBIT_AGENT_MAX_TOKENS ?? 4096) } : {}),
  };
}
