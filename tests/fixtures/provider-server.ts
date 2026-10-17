import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { zstdDecompressSync } from 'node:zlib';

// Real SDK transports talk HTTP/SSE to this server. All credentials are synthetic fixtures.
export async function createProviderServer() {
  const requests: Array<{ path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  let fail = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const body = JSON.parse((req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString());
    const path = req.url ?? '';
    requests.push({ path, headers: req.headers, body });
    if (fail) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { type: 'authentication_error', message: 'private-provider-response-body' } })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const event = (value: { type: string; [key: string]: unknown }) => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    if (path.includes('/responses')) {
      const id = `resp_${requests.length}`, item = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
      event({ type: 'response.created', response: { id, status: 'in_progress' } });
      event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'OK' });
      event({ type: 'response.output_item.done', output_index: 0, item });
      event({ type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    } else if (path.startsWith('/v1/messages')) {
      event({ type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } });
      event({ type: 'content_block_stop', index: 0 });
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      event({ type: 'message_stop' });
    } else if (path.endsWith('/chat/completions')) {
      for (const [delta, finish] of [[{ role: 'assistant', content: 'OK' }, null], [{}, 'stop']]) {
        res.write(`data: ${JSON.stringify({ id: `chat_${requests.length}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
    }
    res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, requests, fail: () => { fail = true; }, async close() {
    server.closeAllConnections(); server.close(); await once(server, 'close');
  } };
}
