import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

// A local HTTP provider, not a fake AgentSession: Pi still runs streaming,
// tool dispatch, context reconstruction, cancellation and persistence itself.
export async function createModelServer() {
  const requests: Array<{ messages: Array<{ role: string; content?: string | Array<{ type: string; text?: string }> }>; tools?: Array<{ function: { name: string } }> }> = [];
  const held = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as typeof requests[number];
    requests.push(body);
    const last = body.messages.at(-1);
    const user = [...body.messages].reverse().find(message => message.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : (user?.content ?? []).map(part => part.text ?? '').join('');
    if (text?.includes('模拟失败')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Test credentials rejected', type: 'authentication_error' } })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({
      id: 'test-response', object: 'chat.completion.chunk', created: 1, model: 'orbit-test',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
    chunk({ role: 'assistant' });
    if (text?.includes('慢回复')) {
      chunk({ content: '正在等待测试中断' }); held.add(res); res.on('close', () => held.delete(res)); return;
    }
    if (last?.role !== 'tool' && /网站|保存|任务|越权工具/.test(text ?? '')) {
      const name = text?.includes('越权工具') ? 'bash' : text?.includes('任务') && !text.includes('保存') && !text.includes('网站') ? 'list_tasks' : 'save_request';
      const args = name === 'save_request' ? { text: text.split('\n\nOrbit 附件')[0] } : name === 'bash' ? { command: 'touch forbidden' } : {};
      const calls = text.includes('重复调用') ? [0, 1] : [0];
      chunk({ tool_calls: calls.map(index => ({ index, id: `call_${requests.length}_${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
      chunk({}, 'tool_calls');
    } else {
      const reply = last?.role === 'tool' ? '已核实工具结果。需求若已保存，仍然尚未派发。' : '你好，我是 Orbit。我们可以先明确你的目标。';
      chunk({ content: reply.slice(0, 6) });
      await new Promise(resolve => setTimeout(resolve, 15));
      chunk({ content: reply.slice(6) }); chunk({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    requests, env: { ORBIT_AGENT_BASE_URL: url, ORBIT_AGENT_MODEL: 'orbit-test', ORBIT_AGENT_API_KEY: 'local-test-only' },
    async close() {
      for (const response of held) response.destroy();
      server.closeAllConnections(); server.close(); await once(server, 'close');
    },
  };
}
