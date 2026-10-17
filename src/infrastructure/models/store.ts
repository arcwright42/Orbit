import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ModelConfigurationError, type ModelDocument, type ModelRepository, type SecretProtection } from '../../domains/models/model';
import { validateProfile } from '../../domains/models/providers';

export class FileModelRepository implements ModelRepository {
  constructor(private path: string) {}

  read(): ModelDocument | undefined {
    let raw: string;
    try { raw = readFileSync(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new ModelConfigurationError('无法读取模型配置，请检查用户数据目录。');
    }
    try {
      const value = JSON.parse(raw);
      if (value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 100 ||
          value.activeProfileId !== null && typeof value.activeProfileId !== 'string') throw new Error();
      const ids = new Set<string>();
      const profiles = value.profiles.map((entry: { profile?: unknown; encryptedApiKey?: unknown }) => {
        const input = entry.profile as { id?: unknown } | undefined;
        if (!input || typeof input.id !== 'string' || !/^[\w-]{8,80}$/.test(input.id) || ids.has(input.id) || input.id === 'environment') throw new Error();
        ids.add(input.id);
        const { profile } = validateProfile(input, input.id);
        if (entry.encryptedApiKey !== undefined && (typeof entry.encryptedApiKey !== 'string' || profile.source !== 'api')) throw new Error();
        return { profile, ...(typeof entry.encryptedApiKey === 'string' ? { encryptedApiKey: entry.encryptedApiKey } : {}) };
      });
      if (value.activeProfileId !== null && !ids.has(value.activeProfileId)) throw new Error();
      return { version: 1, activeProfileId: value.activeProfileId, profiles };
    } catch { throw new ModelConfigurationError('models.json 格式或版本无效；请修复配置文件后重启，现有文件未被覆盖。'); }
  }

  write(document: ModelDocument): void {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify(document, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.path);
    } catch { throw new ModelConfigurationError('模型配置保存失败，请检查目录权限和磁盘空间。'); }
    finally { try { rmSync(temporary, { force: true }); } catch { /* Keep the controlled persistence error. */ } }
  }
}

// Electron is injected by the main process; domain/services and tests need no Electron import.
export function protectedSecrets(storage: {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}, platform = process.platform): SecretProtection {
  const available = () => {
    if (!storage.isEncryptionAvailable() || platform === 'linux' && storage.getSelectedStorageBackend() === 'basic_text') {
      throw new ModelConfigurationError('系统安全存储不可用，无法保存或读取 API key。');
    }
  };
  return {
    encrypt(value) {
      available();
      try { return storage.encryptString(value).toString('base64'); }
      catch { throw new ModelConfigurationError('API key 加密失败，配置未保存。'); }
    },
    decrypt(value) {
      available();
      try { return storage.decryptString(Buffer.from(value, 'base64')); }
      catch { throw new ModelConfigurationError('无法解密 API key，请重新填写密钥。'); }
    },
  };
}
