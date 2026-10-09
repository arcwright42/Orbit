import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenRigCatalog, normalizeOpenRigUrl } from '../src/domains/runtime/openrig';

test('connection rejects remote hosts, credentials, unexpected paths and schemes', () => {
  for (const url of ['https://example.com', 'http://example.com', 'file:///etc/passwd', 'http://user:secret@localhost:7433', 'http://localhost:7433/api']) {
    assert.throws(() => normalizeOpenRigUrl(url));
  }
  assert.equal(normalizeOpenRigUrl('http://localhost:7433/'), 'http://localhost:7433');
});

test('OpenRig summary adapter reads actual contract and rejects malformed/error responses', async () => {
  let mode = 'ok';
  const server = createServer((req, res) => {
    assert.equal(req.url, '/api/rigs/summary');
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'ok') res.end(JSON.stringify([{ id: 'rig-1', name: 'starter', lifecycleState: 'running' }]));
    else if (mode === 'bad') res.end(JSON.stringify({ teams: [] }));
    else { res.statusCode = 503; res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const catalog = new OpenRigCatalog(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    assert.deepEqual(await catalog.listTeams(), [{ id: 'rig-1', name: 'starter', lifecycle: 'running' }]);
    mode = 'bad'; await assert.rejects(() => catalog.listTeams(), /不符合/);
    mode = 'unavailable'; await assert.rejects(() => catalog.listTeams(), /503/);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
