#!/usr/bin/env node
// Executable protocol fixture: never contacts a provider or reads native credentials.
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.161.0 protocol-fixture'); process.exit(0); }
if (args[0] === 'login' || args[0] === 'auth') { console.log('{"loggedIn":true}'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let nextId = 1000;
const pending = new Map();
const parse = (stream, receive) => createInterface({ input: stream }).on('line', line => { if (line) receive(JSON.parse(line)); });
const response = message => {
  const current = pending.get(message.id);
  if (!current) return;
  pending.delete(message.id);
  if (message.error) current.reject(new Error(message.error.message)); else current.resolve(message.result);
};
async function work(prompt, toolNames, call, resumed, permission) {
  await call('report_progress', { message: resumed ? 'fixture resumed native session' : 'fixture started' });
  if (prompt.includes('fixture:pause') && !resumed) await new Promise(() => setInterval(() => {}, 1000));
  if (prompt.includes('fixture:input')) {
    const answer = await call('request_input', { question: '文件要使用什么颜色？' });
    assert.equal(answer.answer, 'blue');
  }
  if (prompt.includes('fixture:approval')) assert.equal(await permission(), true);
  if (prompt.includes('fixture:missing')) return;
  if (toolNames.includes('submit_plan')) {
    await call('submit_plan', { steps: [
      { id: 'research', name: '调研', instruction: '写 research.txt', dependsOn: [] },
      { id: 'analyze', name: '分析', instruction: '写 analyze.txt', dependsOn: [] },
      { id: 'combine', name: '汇总', instruction: '汇总两份成果', dependsOn: ['research', 'analyze'] },
    ] });
  } else {
    writeFileSync('result.txt', resumed ? 'resumed result\n' : 'verified result\n');
    await call('submit_result', { summary: '真实文件已写入', artifacts: ['result.txt'] });
  }
}
if (args.includes('app-server')) {
  let threadId = ''; let resumed = false; let toolNames = [];
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject }); send({ id, method, params });
  });
  parse(process.stdin, message => {
    if (!message.method) { response(message); return; }
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fixture' } });
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      assert.equal(message.params.sandbox, 'workspace-write');
      assert.equal(message.params.approvalPolicy, 'on-request');
      assert.equal(message.params.approvalsReviewer, 'user');
      resumed = message.method === 'thread/resume';
      threadId = message.params.threadId ?? randomUUID();
      if (resumed) toolNames = JSON.parse(readFileSync('.fixture-tools.json', 'utf8'));
      else {
        assert.ok(message.params.dynamicTools.every(tool => tool.type === 'function'));
        toolNames = message.params.dynamicTools.map(tool => tool.name);
        writeFileSync('.fixture-tools.json', JSON.stringify(toolNames));
      }
      send({ id: message.id, result: { thread: { id: threadId } } });
    }
    if (message.method === 'turn/start') {
      const turnId = randomUUID();
      const call = async (tool, arguments_) => {
        const result = await request('item/tool/call', { threadId, turnId, callId: randomUUID(), tool, arguments: arguments_ });
        assert.equal(result.success, true, result.contentItems[0].text);
        return JSON.parse(result.contentItems[0].text);
      };
      const permission = async () => (await request('item/commandExecution/requestApproval', { threadId, turnId, itemId: 'command', command: 'fixture harmless command', cwd: process.cwd() })).decision === 'accept';
      void (async () => {
        const prompt = message.params.input[0].text;
        if (prompt.includes('fixture:native-input')) {
          const answer = await request('item/tool/requestUserInput', { threadId, turnId, itemId: 'native-question', questions: [{ id: 'color', header: '颜色', question: '文件要使用什么颜色？', options: [] }] });
          assert.deepEqual(answer, { answers: { color: { answers: ['blue'] } } });
        }
        await work(prompt, toolNames, call, resumed, permission);
        // Complete before turn/start ACK to exercise notification/response races.
        send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
        send({ id: message.id, result: { turn: { id: turnId } } });
      })().catch(error => { process.stderr.write(String(error)); process.exit(1); });
    }
    if (message.method === 'turn/interrupt') send({ id: message.id, result: {} });
  });
} else if (args.includes('-p')) {
  assert.ok(args.includes('mcp__orbit__permission_prompt'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  const config = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.orbit;
  const bridge = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  parse(bridge.stdout, response);
  const mcp = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject }); bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, arguments_) => {
    const result = await mcp('tools/call', { name, arguments: arguments_ });
    assert.ok(!result.isError, result.content[0].text); return JSON.parse(result.content[0].text);
  };
  parse(process.stdin, message => {
    void (async () => {
      await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'fixture', version: '1' }, capabilities: {} });
      const tools = (await mcp('tools/list', {})).tools.map(tool => tool.name);
      const resumed = args.includes('--resume');
      const sessionId = resumed ? args[args.indexOf('--resume') + 1] : randomUUID();
      send({ type: 'system', subtype: 'init', session_id: sessionId });
      const permission = async () => (await call('permission_prompt', { tool_name: 'Bash', input: { command: 'fixture harmless command' } })).behavior === 'allow';
      await work(message.message.content, tools, call, resumed, permission);
      send({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId });
      bridge.kill();
      process.exit(message.message.content.includes('fixture:bad-exit') ? 1 : 0);
    })().catch(error => { process.stderr.write(String(error)); bridge.kill(); process.exit(1); });
  });
} else process.exit(2);
