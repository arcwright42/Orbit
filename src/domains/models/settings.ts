import type { DatabaseSync } from 'node:sqlite';
import type { TextModelInput, TextModelSettings } from '../../contracts';

export interface SecretCodec { encrypt(value: string): string; decrypt(value: string): string }
interface Stored extends TextModelSettings { secret?: string }
const defaults: TextModelSettings = { protocol: 'openai-completions', baseUrl: '', model: '', hasKey: false };
export class TextModelStore {
  constructor(private db: DatabaseSync, private codec: SecretCodec) {}
  private read(): Stored {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get('textModel');
    return row ? JSON.parse(String(row.value)) : { ...defaults };
  }
  public(): TextModelSettings { const { protocol, baseUrl, model, secret } = this.read(); return { protocol, baseUrl, model, hasKey: !!secret }; }
  resolve() {
    const stored = this.read();
    if (!stored.baseUrl || !stored.model) throw new Error('请先在设置中配置文本模型。语音模型不会用于文本对话。');
    return { ...this.public(), apiKey: stored.secret ? this.codec.decrypt(stored.secret) : '' };
  }
  save(input: TextModelInput): TextModelSettings {
    if (!input || !['openai-completions', 'openai-responses', 'anthropic-messages'].includes(input.protocol) ||
      typeof input.baseUrl !== 'string' || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 256 ||
      (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 8192)) ||
      (input.clearKey !== undefined && typeof input.clearKey !== 'boolean')) throw new Error('文本模型配置无效。');
    let url: URL;
    try { url = new URL(input.baseUrl); } catch { throw new Error('请填写完整的模型服务地址。'); }
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('模型地址需要 HTTPS；本机服务可使用 HTTP。');
    const baseUrl = url.toString().replace(/\/$/, '');
    const old = this.read();
    // Never silently send a previous provider's credential to a newly entered endpoint.
    const sameEndpoint = old.baseUrl === baseUrl && old.protocol === input.protocol;
    let secret = sameEndpoint ? old.secret : undefined;
    if (input.clearKey) secret = undefined;
    if (input.apiKey?.trim()) secret = this.codec.encrypt(input.apiKey.trim());
    const stored: Stored = { protocol: input.protocol, baseUrl, model: input.model.trim(), hasKey: !!secret, secret };
    this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('textModel', JSON.stringify(stored));
    return this.public();
  }
}
