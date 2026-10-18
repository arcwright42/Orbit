import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { jsonLines } from '../infrastructure/execution/json-lines';

// Small stdio MCP transport. It forwards only the tools the current Run exposes.
const endpoint = process.env.ORBIT_TOOL_ENDPOINT;
const token = process.env.ORBIT_TOOL_TOKEN;
if (!endpoint || !token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error('Missing local task tool capability.');
const connection = randomUUID();
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
function call(path: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request(endpoint + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } }, res => {
      let response = ''; res.setEncoding('utf8');
      res.on('data', chunk => { response += chunk; if (Buffer.byteLength(response) > 2 * 1024 * 1024) req.destroy(new Error('Tool response too large.')); });
      res.on('end', () => { try { if (res.statusCode !== 200) throw new Error('Task tool capability is no longer valid.'); resolve(JSON.parse(response)); } catch (error) { reject(error); } });
    });
    req.once('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
jsonLines(process.stdin, message => {
  if (message.id === undefined) return;
  void (async () => {
    let result: unknown;
    if (message.method === 'initialize') result = { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'orbit-task-tools', version: '1.0.0' } };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list') result = await call('/tools');
    else if (message.method === 'tools/call') result = await call('/tools', { name: message.params?.name, args: message.params?.arguments ?? {}, callId: connection + ':' + message.id });
    else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); return; }
    send({ jsonrpc: '2.0', id: message.id, result });
  })().catch(error => send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : 'Tool transport failed.' } }));
}, error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; process.stdin.destroy(); });
