import type { Team } from '../../contracts';
import type { TeamCatalog } from '../teams/catalog';

// Loopback-only first integration; remote authentication is deliberately not implied.
export function normalizeOpenRigUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('请输入 OpenRig 本地服务地址。');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('服务地址格式不正确。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('当前仅支持本机 HTTP 地址，例如 http://127.0.0.1:7433。');
  }
  return url.origin;
}

export class OpenRigCatalog implements TeamCatalog {
  private origin: string;
  constructor(url: string) { this.origin = normalizeOpenRigUrl(url); }

  async listTeams(): Promise<Team[]> {
    let response: Response;
    try {
      response = await fetch(`${this.origin}/api/rigs/summary`, {
        signal: AbortSignal.timeout(5000), redirect: 'error',
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error('OpenRig 未在 5 秒内响应，请检查服务状态后重试。');
      }
      throw new Error('无法访问 OpenRig，请确认本机服务已启动且地址正确。');
    }
    if (!response.ok) throw new Error(`OpenRig 返回 HTTP ${response.status}。`);
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new Error('服务未返回有效的 JSON，请检查是否连接到 OpenRig。'); }
    if (!Array.isArray(payload) || payload.some(row => !row || typeof row.id !== 'string' || typeof row.name !== 'string')) {
      throw new Error('服务响应不符合 OpenRig 团队接口，请检查地址与版本。');
    }
    return payload.map(row => ({ id: row.id, name: row.name, lifecycle: typeof row.lifecycleState === 'string' ? row.lifecycleState : 'unknown' }));
  }
}
