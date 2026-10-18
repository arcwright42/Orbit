import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskRuntimeInput, TaskRuntimeOutcome } from '../../domains/tasks/runtime';
import type { RuntimeCallbacks } from './protocol';
import { jsonLines } from './json-lines';
import { executionEnv, stopChild } from './process';

export async function runClaude(executable: string, bridge: string, input: TaskRuntimeInput, callbacks: RuntimeCallbacks): Promise<TaskRuntimeOutcome> {
  const token = randomUUID();
  const tools = input.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters }));
  tools.push({ name: 'permission_prompt', description: 'Handle a native Claude Code permission request.', inputSchema: {
    type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object', additionalProperties: true }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'],
  } });
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== 'Bearer ' + token) { response.writeHead(401).end('{}'); return; }
    if (request.method === 'GET' && request.url === '/tools') { response.end(JSON.stringify({ tools })); return; }
    if (request.method !== 'POST' || request.url !== '/tools') { response.writeHead(404).end('{}'); return; }
    try {
      let body = ''; for await (const chunk of request) { body += chunk.toString(); if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('工具参数过大。'); }
      const { name, args, callId } = JSON.parse(body);
      callbacks.signal.throwIfAborted();
      if (!tools.some(tool => tool.name === name)) throw new Error('当前步骤不支持该工具。');
      let result: unknown;
      if (name === 'permission_prompt') {
        // Orbit's own bookkeeping tools do not need an extra native permission round trip.
        if (input.tools.some(tool => 'mcp__orbit__' + tool.name === args.tool_name)) result = { behavior: 'allow', updatedInput: args.input };
        else {
          const answer = await callbacks.tool('permission_request', { question: 'Claude Code 请求允许本次操作：\n' + JSON.stringify({ tool: args.tool_name, input: args.input }) }, callId) as { answer: string };
          result = answer.answer === 'approve' ? { behavior: 'allow', updatedInput: args.input } : { behavior: 'deny', message: '用户拒绝了本次操作。' };
        }
      } else result = await callbacks.tool(name, args, callId);
      response.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result) }] }));
    } catch (error) { response.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : '工具执行失败。' }] })); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法创建任务工具桥。');
  const configPath = join(input.runDirectory, 'mcp.json');
  writeFileSync(configPath, JSON.stringify({ mcpServers: { orbit: { type: 'stdio', command: process.execPath, args: [bridge], env: {
    ELECTRON_RUN_AS_NODE: '1', ORBIT_TOOL_ENDPOINT: 'http://127.0.0.1:' + address.port, ORBIT_TOOL_TOKEN: token,
  } } } }), { mode: 0o600 });
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', 'default', '--permission-prompt-tool', 'mcp__orbit__permission_prompt', '--mcp-config', configPath,
    '--allowedTools', ...input.tools.map(tool => 'mcp__orbit__' + tool.name)];
  if (input.resumeSession) args.push('--resume', input.resumeSession);
  const child = spawn(executable, args, { cwd: input.directory, env: executionEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let result: TaskRuntimeOutcome | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let settle!: (outcome: TaskRuntimeOutcome) => void;
  const done = new Promise<TaskRuntimeOutcome>(resolve => { settle = resolve; });
  jsonLines(child.stdout, message => {
    if (message.session_id && (message.type === 'system' || message.type === 'result')) callbacks.event({ type: 'session', sessionId: String(message.session_id) });
    if (message.type === 'stream_event') {
      const delta = message.event?.delta;
      if (delta?.type === 'text_delta') callbacks.event({ type: 'output', text: String(delta.text) });
      if (message.event?.type === 'content_block_start' && message.event.content_block?.type === 'tool_use') callbacks.event({ type: 'activity', message: 'Claude Code：' + message.event.content_block.name });
    }
    if (message.type === 'result') {
      result = message.subtype === 'success' && !message.is_error ? { status: 'completed' } : { status: 'failed', error: 'Claude Code 未正常完成本轮：' + String(message.subtype ?? 'unknown') };
      child.stdin.end();
      // The native process must flush history and exit successfully before business completion.
      exitTimer = setTimeout(() => settle({ status: 'failed', error: 'Claude Code 返回结果后未正常退出。' }), 15_000);
    }
  }, error => settle({ status: 'failed', error: error.message }));
  child.stderr.on('data', chunk => callbacks.event({ type: 'output', text: String(chunk).slice(0, 65536) }));
  child.once('error', () => settle({ status: 'failed', error: '无法启动 Claude Code CLI。' }));
  child.stdin.on('error', () => settle(result ?? { status: 'failed', error: 'Claude Code 输入管道已关闭。' }));
  child.once('close', code => settle(result && code === 0 ? result : { status: 'failed', error: 'Claude Code 进程退出，未收到成功执行回执。' }));
  const abort = () => { settle({ status: 'interrupted' }); };
  callbacks.signal.addEventListener('abort', abort, { once: true });
  try {
    callbacks.signal.throwIfAborted();
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: input.prompt }, parent_tool_use_id: null, session_id: input.resumeSession ?? '' }) + '\n');
    return await done;
  } finally {
    clearTimeout(exitTimer);
    callbacks.signal.removeEventListener('abort', abort);
    await stopChild(child);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    try { unlinkSync(configPath); } catch { /* only a short-lived, run-scoped capability was stored */ }
  }
}
