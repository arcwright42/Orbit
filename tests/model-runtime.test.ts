import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelRuntime, modelCatalog, testModelConnection } from '../src/infrastructure/pi/models';
import { PiSession } from '../src/infrastructure/pi/session';
import { LocalCodexCredentials } from '../src/infrastructure/models/codex';
import type { ModelProfile } from '../src/domains/models/model';
import { INTERACTION_PROMPT, INTERACTION_TOOLS } from '../src/application/interaction';
import { createProviderServer } from './fixtures/provider-server';
import { codexToken } from './fixtures/codex-auth';
import type { Message } from '../src/contracts';
import { validateProfile } from '../src/domains/models/providers';

test('retired subscription models are excluded without breaking API access or stored-profile repair', async () => {
  const catalog = await modelCatalog('openai-codex');
  assert.ok(catalog.some(model => model.id === 'gpt-6.1-sol'));
  assert.ok(!catalog.some(model => ['gpt-5.5', 'gpt-5.3-codex-spark'].includes(model.id)));
  assert.ok((await modelCatalog('openai')).some(model => model.id === 'gpt-5.5'));
  const profile: ModelProfile = { id: 'retired-profile', name: 'Legacy Codex', source: 'codex-local', providerId: 'openai-codex', modelId: 'gpt-5.5' };
  assert.equal(validateProfile(profile, profile.id).profile.modelId, 'gpt-5.5'); // Existing documents remain readable/editable.
  let credentialsRead = false;
  await assert.rejects(createModelRuntime(profile, async () => { credentialsRead = true; return undefined; }), /停止支持/);
  assert.equal(credentialsRead, false);
});

test('real Pi transports use each provider protocol, read-only Codex auth, and retain history across switches', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-provider-test-'));
  const server = await createProviderServer();
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  // Never add a production override for subscription endpoints. Redirect only inside this test.
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    requestedUrls.push(request.url);
    assert.ok(['api.openai.com', 'api.anthropic.com', 'openrouter.ai', 'chatgpt.com', '127.0.0.1'].includes(url.hostname), `Unexpected network destination: ${url.hostname}`);
    assert.ok(/\/(responses|chat\/completions|messages)(\?|$)/.test(url.pathname), `Unexpected request path: ${url.pathname}`);
    return originalFetch(new Request(server.origin + url.pathname + url.search, request));
  };
  const authPath = join(directory, 'auth.json');
  const writeAuth = (token: string) => writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, refresh_token: 'DO-NOT-IMPORT-OR-REFRESH' } }));
  // Less than the SDK OAuth refresh window: valid borrowed access must still never refresh.
  const token = codexToken(Date.now() + 120_000); writeAuth(token);
  const codex = new LocalCodexCredentials({ CODEX_HOME: directory });
  const credentials = async (id: string) => id === 'profile-codex' ? codex.resolve() : { apiKey: `test-key-for-${id}` };
  let agent: PiSession | undefined;
  try {
    const codexModels = await modelCatalog('openai-codex');
    const profiles: ModelProfile[] = [
      { id: 'profile-openai', name: 'OpenAI', source: 'api', providerId: 'openai', modelId: 'gpt-4.1' },
      { id: 'profile-anthropic', name: 'Anthropic', source: 'api', providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
      { id: 'profile-openrouter', name: 'OpenRouter', source: 'api', providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-4.6' },
      { id: 'profile-custom', name: 'Custom', source: 'api', providerId: 'custom', modelId: 'custom-text', baseUrl: server.origin + '/v1' },
      { id: 'profile-codex', name: 'Codex', source: 'codex-local', providerId: 'openai-codex', modelId: codexModels[0].id },
    ];
    const beforeAuth = readFileSync(authPath);
    for (const profile of profiles) {
      const beforeCount = server.requests.length;
      const result = await testModelConnection(profile, credentials);
      assert.equal(result.ok, true, `${profile.providerId}: ${result.message}`);
      const request = server.requests.at(-1)!;
      assert.equal(server.requests.length, beforeCount + 1);
      assert.equal(request.body.model, profile.modelId);
      assert.ok(!request.body.tools || (request.body.tools as unknown[]).length === 0);
      if (profile.providerId === 'anthropic') {
        assert.match(request.path, /^\/v1\/messages/);
        assert.equal(request.headers['x-api-key'], `test-key-for-${profile.id}`);
      } else {
        assert.equal(request.headers.authorization, `Bearer ${profile.source === 'codex-local' ? token : `test-key-for-${profile.id}`}`);
        assert.match(request.path, profile.providerId === 'openai-codex' ? /\/backend-api\/codex\/responses$/ : profile.providerId === 'openai' ? /\/v1\/responses$/ : /\/chat\/completions$/);
      }
      if (profile.source === 'codex-local') assert.equal(request.headers['chatgpt-account-id'], 'test-account');
    }
    assert.deepEqual(readFileSync(authPath), beforeAuth);
    assert.deepEqual(readdirSync(directory), ['auth.json']); // Connection testing creates no session/history.
    assert.ok(!JSON.stringify(server.requests).includes('DO-NOT-IMPORT-OR-REFRESH'));

    const setup = { directory: join(directory, 'agent'), systemPrompt: INTERACTION_PROMPT, tools: INTERACTION_TOOLS, model: profiles[0] };
    agent = await PiSession.open(setup, () => { throw new Error('Unexpected tool'); }, () => {}, {}, credentials);
    const sessionId = agent.read().sessionId;
    for (const [index, profile] of profiles.entries()) {
      const history: Message[] = agent.read().messages;
      await agent.configure(profile, credentials);
      assert.equal(agent.read().sessionId, sessionId);
      assert.deepEqual(agent.read().messages, history);
      await agent.send({ requestId: `switch-turn-${index}`, text: `Remember turn ${index}`, attachments: [] });
      assert.equal(agent.read().error, undefined);
      assert.equal(agent.read().messages.length, (index + 1) * 2);
      assert.equal(agent.read().messages.at(-1)?.text, 'OK');
      assert.ok(JSON.stringify(server.requests.at(-1)?.body).includes('Remember turn 0'));
    }
    const beforeExpired = agent.read();
    const requestsBeforeExpiry = server.requests.length;
    writeAuth(codexToken(Date.now() - 1000));
    const expiredBytes = readFileSync(authPath);
    await assert.rejects(agent.send({ requestId: 'expired-turn', text: 'Do not accept me yet', attachments: [] }), /过期/);
    assert.deepEqual(agent.read().messages, beforeExpired.messages);
    assert.equal(server.requests.length, requestsBeforeExpiry);
    assert.deepEqual(readFileSync(authPath), expiredBytes);
    writeAuth(codexToken(Date.now() + 3_600_000, 'rotated-account'));
    await agent.send({ requestId: 'expired-turn', text: 'Do not accept me yet', attachments: [] });
    assert.equal(server.requests.at(-1)?.headers['chatgpt-account-id'], 'rotated-account');
    const recovered = agent.read();
    await agent.configure(null, credentials);
    assert.equal(agent.read().configured, false);
    assert.deepEqual(agent.read().messages, recovered.messages);
    await agent.close();
    agent = await PiSession.open({ ...setup, model: profiles.at(-1)! }, () => {}, () => {}, {}, credentials);
    assert.equal(agent.read().sessionId, sessionId);
    assert.deepEqual(agent.read().messages, recovered.messages);
    const beforeFailedSwitch = agent.read();
    await assert.rejects(agent.configure({ ...profiles[0], modelId: 'not-a-model' }, credentials), /模型 ID/);
    assert.deepEqual(agent.read(), beforeFailedSwitch);
    // A saved profile cannot silently use unrelated ambient API keys.
    await assert.rejects(createModelRuntime(profiles[0], async () => undefined));
    server.fail();
    const failure = await testModelConnection(profiles[0], credentials);
    assert.equal(failure.ok, false);
    assert.ok(!JSON.stringify(failure).includes('private-provider-response-body'));
    assert.ok(!requestedUrls.some(url => /oauth|token/.test(url)));
  } finally {
    await agent?.close(); globalThis.fetch = originalFetch;
    await server.close(); rmSync(directory, { recursive: true, force: true });
  }
});
