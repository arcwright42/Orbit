import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelConfigurationService } from '../src/application/models';
import { ModelConfigurationError, type ModelProfile, type ModelRuntimePort } from '../src/domains/models/model';
import { LocalCodexCredentials } from '../src/infrastructure/models/codex';
import { FileModelRepository, protectedSecrets } from '../src/infrastructure/models/store';
import { environmentProfile } from '../src/infrastructure/models/environment';
import { validateProfile } from '../src/domains/models/providers';
import { codexToken } from './fixtures/codex-auth';

const custom = { name: '测试服务', source: 'api' as const, providerId: 'custom', modelId: 'test-model', baseUrl: 'https://example.test/v1', apiKey: 'secret-fixture-only' };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-models-test-'));
  const path = join(directory, 'models.json');
  const repository = new FileModelRepository(path);
  const key = randomBytes(32);
  // Test cipher stands in for the injected OS keychain. Production uses Electron safeStorage.
  const secrets = protectedSecrets({
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test',
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString();
    },
  });
  let busy = false;
  const configured: Array<ModelProfile | null> = [];
  const tested: ModelProfile[] = [];
  const runtime: ModelRuntimePort = {
    isBusy: () => busy,
    configure: async profile => { configured.push(profile); },
    catalog: async () => [{ id: 'catalog-model', name: 'Catalog model', contextWindow: 128000, maxTokens: 4096 }],
    testModel: async profile => { tested.push(profile); return { ok: true, message: 'OK' }; },
  };
  const codex = new LocalCodexCredentials({ CODEX_HOME: join(directory, 'codex') });
  const environment = { profile: environmentProfile({ ORBIT_AGENT_MODEL: 'legacy', ORBIT_AGENT_BASE_URL: 'https://legacy.test/v1' }), apiKey: 'legacy-key' };
  const events: unknown[] = [];
  const open = () => new ModelConfigurationService(repository, secrets, codex, runtime, environment, state => events.push(state));
  const service = open();
  return { directory, path, repository, secrets, runtime, configured, tested, events, service, open,
    busy: () => { busy = true; }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('profiles persist encrypted keys, isolate destinations, switch explicitly, and never fall back after deletion', async () => {
  const f = fixture();
  try {
    assert.equal(f.service.read().activeProfileId, 'environment');
    assert.equal(f.service.read().profiles[0].readOnly, true);
    await assert.rejects(f.service.remove('environment'), /只读/);
    const first = (await f.service.save(custom)).profiles[0];
    assert.equal(f.service.read().activeProfileId, null);
    assert.equal(f.service.current(), null);
    assert.equal(first.hasApiKey, true);
    assert.deepEqual(f.service.credential(first.id), { apiKey: custom.apiKey });
    const persisted = readFileSync(f.path, 'utf8');
    assert.ok(!persisted.includes(custom.apiKey));
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(f.events).includes(custom.apiKey));
    assert.ok(!JSON.stringify(first).includes('encryptedApiKey'));
    const second = (await f.service.save({ ...custom, name: '同一 provider 的另一套配置', apiKey: 'second-fixture-key' })).profiles.at(-1)!;
    await f.service.activate(first.id);
    assert.equal(f.service.current()?.id, first.id);
    await f.service.save({ ...custom, id: first.id, apiKey: undefined, name: '改名' });
    assert.equal(f.service.credential(first.id)?.apiKey, custom.apiKey);
    await assert.rejects(f.service.save({ ...custom, id: first.id, apiKey: undefined, baseUrl: 'https://different.test/v1' }), /API key/);
    assert.equal(f.service.current()?.baseUrl, custom.baseUrl);
    await f.service.activate(second.id);
    assert.equal(f.service.credential(second.id)?.apiKey, 'second-fixture-key');
    const resumed = f.open();
    assert.equal(resumed.current()?.id, second.id);
    assert.equal(resumed.credential(second.id)?.apiKey, 'second-fixture-key');
    const beforeTest = readFileSync(f.path, 'utf8');
    const beforeSwitches = f.configured.length;
    assert.equal((await resumed.test(first.id)).ok, true);
    assert.equal(f.configured.length, beforeSwitches);
    assert.equal(resumed.current()?.id, second.id);
    assert.equal(readFileSync(f.path, 'utf8'), beforeTest);
    await resumed.remove(second.id);
    assert.equal(resumed.current(), null);
    assert.equal(f.open().current(), null);
    await resumed.remove(first.id);
    assert.deepEqual(f.open().read().profiles, []);
    assert.equal(f.open().read().activeProfileId, null);
  } finally { f.cleanup(); }
});

test('busy replies reject mutations; write/configure failure rolls back the active selection', async () => {
  const f = fixture();
  try {
    const first = (await f.service.save(custom)).profiles[0];
    const second = (await f.service.save({ ...custom, modelId: 'second' })).profiles.at(-1)!;
    await f.service.activate(first.id);
    const original = readFileSync(f.path, 'utf8');
    const write = f.repository.write.bind(f.repository);
    f.repository.write = () => { throw new ModelConfigurationError('模拟写入失败'); };
    await assert.rejects(f.service.activate(second.id), /写入失败/);
    assert.equal(f.service.current()?.id, first.id);
    assert.equal(f.configured.at(-1)?.id, first.id);
    assert.equal(readFileSync(f.path, 'utf8'), original);
    f.repository.write = write;
    f.runtime.configure = async profile => {
      f.configured.push(profile);
      if (profile?.id === second.id) throw new ModelConfigurationError('模拟凭据失效');
    };
    await assert.rejects(f.service.activate(second.id), /凭据失效/);
    assert.equal(f.service.current()?.id, first.id);
    assert.equal(f.configured.at(-1)?.id, first.id);
    assert.equal(readFileSync(f.path, 'utf8'), original);
    // If the old credential also stops working during rollback, unbind the new selection.
    f.repository.write = () => { throw new ModelConfigurationError('模拟写入失败'); };
    f.runtime.configure = async profile => {
      f.configured.push(profile);
      if (profile?.id === first.id) throw new ModelConfigurationError('旧凭据失效');
    };
    await assert.rejects(f.service.activate(second.id), /写入失败/);
    assert.equal(f.service.current()?.id, first.id);
    assert.equal(f.configured.at(-1), null);
    f.repository.write = write;
    f.runtime.configure = async profile => { f.configured.push(profile); };
    // Re-activating the same profile retries initialization after external login repair.
    const before = f.configured.length;
    await f.service.activate(first.id);
    assert.equal(f.configured.length, before + 1);
    f.busy();
    await assert.rejects(f.service.activate(second.id), /当前回复/);
    await assert.rejects(f.service.save(custom), /当前回复/);
    await assert.rejects(f.service.remove(first.id), /当前回复/);
    await assert.rejects(f.service.test(first.id), /当前回复/);
  } finally { f.cleanup(); }
});

test('corrupt configuration remains untouched, and unavailable OS storage never saves plaintext', async () => {
  const f = fixture();
  try {
    for (const content of ['{broken', '{"version":99,"profiles":[],"activeProfileId":null}']) {
      writeFileSync(f.path, content);
      const broken = f.open();
      assert.match(broken.read().error!, /格式或版本/);
      assert.equal(broken.current(), null);
      await assert.rejects(broken.save(custom), /格式或版本/);
      assert.throws(() => broken.assertCanSend(), /格式或版本/);
      assert.equal(readFileSync(f.path, 'utf8'), content);
    }
    for (const available of [true, false]) {
      const secrets = protectedSecrets({ isEncryptionAvailable: () => available, getSelectedStorageBackend: () => 'basic_text',
        encryptString: () => { throw new Error('must not encrypt'); }, decryptString: () => { throw new Error('must not decrypt'); } }, 'linux');
      assert.throws(() => secrets.encrypt('sensitive'), /安全存储不可用/);
      assert.throws(() => secrets.decrypt('sensitive'), /安全存储不可用/);
    }
    const unavailable = protectedSecrets({ isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'test',
      encryptString: () => Buffer.alloc(0), decryptString: () => '' });
    const file = join(f.directory, 'unavailable.json');
    const service = new ModelConfigurationService(new FileModelRepository(file), unavailable, new LocalCodexCredentials({ CODEX_HOME: f.directory }), f.runtime, { profile: null });
    await assert.rejects(service.save(custom), /安全存储不可用/);
    assert.equal(existsSync(file), false);
    // A Codex profile stores only its reference and does not require an API-key vault.
    const result = await service.save({ name: 'Codex', source: 'codex-local', providerId: 'openai-codex', modelId: 'catalog-model' });
    assert.equal(result.profiles[0].hasApiKey, false);
    assert.ok(!readFileSync(file, 'utf8').includes('encryptedApiKey'));
    assert.equal(readdirSync(f.directory).some(file => file.endsWith('.tmp')), false);
  } finally { f.cleanup(); }
});

test('input validation constrains sources, endpoints and model catalogs', async () => {
  const f = fixture();
  try {
    for (const baseUrl of ['file:///tmp/test', 'https://user:password@example.test', 'https://example.test?key=secret', 'https://example.test/v1/chat/completions']) {
      assert.throws(() => validateProfile({ ...custom, baseUrl }, 'test-id-123'), /API 地址/);
    }
    await assert.rejects(f.service.save({ ...custom, maxTokens: 999999 }), /上下文窗口/);
    await assert.rejects(f.service.save({ ...custom, source: 'codex-local' }), /不匹配/);
    await assert.rejects(f.service.save({ ...custom, providerId: 'anthropic' }), /预设/);
    await assert.rejects(f.service.save({ name: 'bad model', source: 'api', providerId: 'openai', modelId: 'not-in-catalog', apiKey: 'fake' }), /支持目录/);
    assert.throws(() => f.service.catalog('unsupported'), /不支持/);
    const result = await f.service.save({ name: 'OpenAI', source: 'api', providerId: 'openai', modelId: 'catalog-model', apiKey: 'fake' });
    assert.equal(result.profiles[0].providerId, 'openai');
    for (const baseUrl of ['https://user:private-env-key@example.test/v1', 'https://example.test/v1?key=private-env-key']) {
      const profile = environmentProfile({ ORBIT_AGENT_MODEL: 'legacy', ORBIT_AGENT_BASE_URL: baseUrl });
      assert.ok(!JSON.stringify(profile).includes('private-env-key'));
      assert.throws(() => validateProfile(profile, 'environment'), /API 地址/);
    }
  } finally { f.cleanup(); }
});

test('Codex file credentials are read-only, bounded, expiry-aware, and re-read after external rotation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-codex-test-'));
  const path = join(directory, 'auth.json');
  const source = new LocalCodexCredentials({ CODEX_HOME: directory });
  const write = (value: unknown) => writeFileSync(path, JSON.stringify(value));
  try {
    assert.equal(source.status().status, 'missing');
    assert.equal(existsSync(path), false);
    assert.throws(() => source.resolve(), /未找到/);
    for (const value of [null, [], { tokens: { access_token: 'malformed' } }, { tokens: { access_token: codexToken(Date.now() + 100000, '') } }]) {
      write(value); assert.equal(source.status().status, 'invalid'); assert.throws(() => source.resolve());
    }
    write({ auth_mode: 'apikey', OPENAI_API_KEY: 'not-a-subscription' });
    assert.equal(source.status().status, 'api-key');
    write({ auth_mode: 'chatgpt', tokens: { access_token: codexToken(Date.now() - 1000), refresh_token: 'never-import-this' } });
    assert.equal(source.status().status, 'expired');
    assert.throws(() => source.resolve(), /过期/);
    const token = codexToken();
    writeFileSync(path, '\uFEFF' + JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, refresh_token: 'never-import-this', id_token: 'private-id-token' } }));
    const before = readFileSync(path);
    const status = source.status();
    assert.equal(status.status, 'available');
    assert.ok(!JSON.stringify(status).includes(token));
    assert.equal(source.resolve().apiKey, token);
    assert.ok(!JSON.stringify(source.resolve()).includes('never-import-this'));
    assert.deepEqual(readFileSync(path), before);
    const rotated = codexToken(Date.now() + 7_200_000);
    write({ tokens: { access_token: rotated } });
    assert.equal(source.resolve().apiKey, rotated);
    writeFileSync(path, 'x'.repeat(1024 * 1024 + 1));
    assert.equal(source.status().status, 'invalid');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
