import type { Readable } from 'node:stream';

/** Native transports are newline-delimited JSON, never terminal text heuristics. */
export function jsonLines(stream: Readable, receive: (value: Record<string, any>) => void, fail: (error: Error) => void) {
  let buffer = ''; let stopped = false;
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    if (stopped) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { stopped = true; fail(new Error('运行时协议消息超过 8 MB。')); return; }
    let boundary: number;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, boundary).trim(); buffer = buffer.slice(boundary + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('协议消息不是对象。');
        receive(parsed);
      } catch { stopped = true; fail(new Error('运行时返回了无效的 JSON 协议消息。')); return; }
    }
  });
  stream.on('end', () => { if (!stopped && buffer.trim()) fail(new Error('运行时 JSON 消息被截断。')); });
}
