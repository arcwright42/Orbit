#!/usr/bin/env node
// Native Codex uses its normal command tool. Credentials stay in inherited environment.
const { randomUUID } = require('node:crypto');
async function main() {
  const [name = 'list_tools', json = '{}', requestId = randomUUID()] = process.argv.slice(2);
  const endpoint = process.env.ORBIT_AGENT_ENDPOINT, token = process.env.ORBIT_AGENT_TOKEN;
  if (!endpoint || !token || !/^http:\/\/127\.0\.0\.1:\d+\/tools$/.test(endpoint)) throw new Error('No active Orbit execution capability');
  const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, input: JSON.parse(json), requestId }), signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Platform tool failed');
  process.stdout.write(JSON.stringify(result) + '\n');
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
