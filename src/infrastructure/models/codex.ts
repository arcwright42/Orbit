import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ModelConfigurationError, type CodexCredentialSource, type CodexLoginStatus, type ModelCredential } from '../../domains/models/model';

export class LocalCodexCredentials implements CodexCredentialSource {
  private path: string;
  constructor(env: NodeJS.ProcessEnv = process.env, private now = Date.now) {
    const directory = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
    this.path = join(resolve(directory.startsWith('~/') ? join(homedir(), directory.slice(2)) : directory), 'auth.json');
  }

  private inspect(): { status: CodexLoginStatus; credential?: ModelCredential } {
    let data: unknown;
    try {
      const fd = openSync(this.path, 'r');
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error();
        const bytes = Buffer.alloc(stat.size + 1);
        let count = 0;
        while (count < bytes.length) {
          const read = readSync(fd, bytes, count, bytes.length - count, count);
          if (!read) break;
          count += read;
        }
        if (count > stat.size) throw new Error();
        data = JSON.parse(bytes.subarray(0, count).toString('utf8').replace(/^\uFEFF/, ''));
      } finally { closeSync(fd); }
    } catch (error) {
      return { status: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { status: 'missing', message: '未找到 Codex auth.json。请在 Codex 完成 ChatGPT 登录；首版仅支持文件式凭据，暂不支持系统凭据库。' }
        : { status: 'invalid', message: '无法读取 Codex 登录文件，请在 Codex 检查登录后重新检测。' } };
    }
    try {
      const auth = data as { auth_mode?: string; OPENAI_API_KEY?: unknown; tokens?: { access_token?: unknown } };
      if (auth.auth_mode === 'apikey' || auth.auth_mode === 'api_key' || !auth.tokens && auth.OPENAI_API_KEY) {
        return { status: { status: 'api-key', message: 'Codex 当前使用 API key 登录。请改用 ChatGPT 登录，或在 Orbit 添加 API 配置。' } };
      }
      if (auth.auth_mode && auth.auth_mode !== 'chatgpt') throw new Error();
      const token = auth.tokens?.access_token;
      if (typeof token !== 'string' || token.length > 32768 || token.split('.').length !== 3 || /\s/.test(token)) throw new Error();
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      if (!Number.isSafeInteger(claims.exp * 1000) || typeof claims.exp !== 'number' || typeof claims['https://api.openai.com/auth']?.chatgpt_account_id !== 'string' || !claims['https://api.openai.com/auth'].chatgpt_account_id) throw new Error();
      const expiresAt = claims.exp * 1000;
      if (expiresAt <= this.now() + 30_000) {
        return { status: { status: 'expired', expiresAt, message: 'Codex 登录已过期或即将过期，请在 Codex 续期或重新登录后检测。' } };
      }
      return { status: { status: 'available', expiresAt, message: '已发现有效期内的 Codex 登录；连接测试可验证模型访问。' }, credential: { apiKey: token, expiresAt } };
    } catch { return { status: { status: 'invalid', message: 'Codex 登录格式不受支持，请在 Codex 重新登录后检测。' } }; }
  }

  status(): CodexLoginStatus { return this.inspect().status; }
  resolve(): ModelCredential {
    const result = this.inspect();
    if (!result.credential) throw new ModelConfigurationError(result.status.message);
    return result.credential;
  }
}
