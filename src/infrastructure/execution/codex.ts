import { spawn } from 'node:child_process';
import type { TaskRuntimeInput, TaskRuntimeOutcome } from '../../domains/tasks/runtime';
import type { RuntimeCallbacks } from './protocol';
import { jsonLines } from './json-lines';
import { executionEnv, stopChild } from './process';

/** Codex 0.161+ app-server JSON-RPC. The CLI owns authentication and native history. */
export async function runCodex(executable: string, input: TaskRuntimeInput, callbacks: RuntimeCallbacks): Promise<TaskRuntimeOutcome> {
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { cwd: input.directory, env: executionEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 0; let threadId = ''; let turnId = ''; let failure: Error | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const turns = new Map<string, TaskRuntimeOutcome>();
  let resolveTurn: ((outcome: TaskRuntimeOutcome) => void) | undefined;
  let rejectTurn: ((error: Error) => void) | undefined;
  const finished = new Promise<TaskRuntimeOutcome>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  // A startup failure can arrive before the caller reaches the turn wait.
  void finished.catch(() => {});
  const fail = (error: Error) => {
    failure = error; rejectTurn?.(error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear();
  };
  const write = (value: unknown) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n'); };
  const request = (method: string, params: unknown): Promise<any> => {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex ' + method + ' 超时。')); }, 60_000);
      pending.set(id, { resolve, reject, timer }); write({ id, method, params });
    });
  };
  const response = async (method: string, params: Record<string, any>): Promise<unknown> => {
    if (params.threadId && params.threadId !== threadId) throw new Error('工具请求不属于当前执行会话。');
    if (method === 'item/tool/call') {
      if (!input.tools.some(tool => tool.name === params.tool)) return { success: false, contentItems: [{ type: 'inputText', text: '当前步骤不支持此工具。' }] };
      try {
        const result = await callbacks.tool(params.tool, params.arguments, params.callId);
        return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
      } catch (error) { return { success: false, contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : '工具执行失败。' }] }; }
    }
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const answer = await callbacks.tool('permission_request', { question: 'Codex 请求允许本次操作：\n' + JSON.stringify({ command: params.command, cwd: params.cwd, reason: params.reason, changes: params.changes, itemId: params.itemId }) }, 'approval-' + (params.approvalId ?? params.itemId)) as { answer: string };
      return { decision: answer.answer === 'approve' ? 'accept' : 'decline' };
    }
    if (method === 'item/permissions/requestApproval') {
      const answer = await callbacks.tool('permission_request', { question: 'Codex 请求本轮额外权限：\n' + JSON.stringify(params.permissions) }, 'permission-' + params.itemId) as { answer: string };
      return { permissions: answer.answer === 'approve' ? params.permissions : {}, scope: 'turn' };
    }
    if (method === 'tool/requestUserInput') {
      const answers: Record<string, { answers: string[] }> = {};
      for (const question of params.questions ?? []) {
        const result = await callbacks.tool('request_input', { question: question.question + (question.options?.length ? '\n' + JSON.stringify(question.options) : '') }, 'question-' + params.itemId + '-' + question.id) as { answer: string };
        answers[question.id] = { answers: [result.answer] };
      }
      return { answers };
    }
    throw new Error('暂不支持 Codex 请求：' + method);
  };
  jsonLines(child.stdout, message => {
    if (message.method && message.id !== undefined) {
      void response(message.method, message.params ?? {}).then(result => write({ id: message.id, result }), error => write({ id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : '请求失败。' } }));
    } else if (message.id !== undefined) {
      const current = pending.get(message.id); if (!current) return;
      clearTimeout(current.timer); pending.delete(message.id);
      if (message.error) current.reject(new Error('Codex 请求失败：' + String(message.error.message).slice(0, 1200))); else current.resolve(message.result);
    } else {
      const params = message.params ?? {};
      if (params.threadId && params.threadId !== threadId) return;
      if (message.method === 'item/agentMessage/delta') callbacks.event({ type: 'output', text: String(params.delta ?? '') });
      if (message.method === 'item/started') callbacks.event({ type: 'activity', message: 'Codex：' + String(params.item?.type ?? '工作中') });
      if (message.method === 'turn/completed') {
        const turn = params.turn ?? {};
        const outcome: TaskRuntimeOutcome = turn.status === 'completed' ? { status: 'completed' } : turn.status === 'interrupted' ? { status: 'interrupted' } : { status: 'failed', error: 'Codex 执行失败：' + String(turn.error?.message ?? turn.status ?? 'unknown').slice(0, 1200) };
        turns.set(turn.id, outcome); if (turn.id === turnId) resolveTurn?.(outcome);
      }
    }
  }, fail);
  child.stderr.on('data', chunk => callbacks.event({ type: 'output', text: String(chunk).slice(0, 65536) }));
  child.stdin.on('error', () => fail(new Error('Codex 输入管道已关闭。')));
  child.once('error', () => fail(new Error('无法启动 Codex CLI。')));
  child.once('close', () => fail(new Error('Codex 进程退出，未完成当前协议请求。')));
  const abort = () => { if (threadId && turnId) write({ id: ++nextId, method: 'turn/interrupt', params: { threadId, turnId } }); fail(new Error('执行已停止。')); };
  callbacks.signal.addEventListener('abort', abort, { once: true });
  try {
    callbacks.signal.throwIfAborted();
    await request('initialize', { clientInfo: { name: 'orbit_desktop', title: 'Orbit', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    write({ method: 'initialized', params: {} });
    const common = { cwd: input.directory, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' };
    const started = input.resumeSession
      ? await request('thread/resume', { ...common, threadId: input.resumeSession })
      : await request('thread/start', { ...common, dynamicTools: input.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, inputSchema: tool.parameters })) });
    threadId = started.thread?.id;
    if (!threadId) throw new Error('Codex 未返回原生 thread ID。');
    callbacks.event({ type: 'session', sessionId: threadId });
    const startedTurn = await request('turn/start', { threadId, input: [{ type: 'text', text: input.prompt }] });
    turnId = startedTurn.turn?.id;
    if (!turnId) throw new Error('Codex 未返回本轮 turn ID。');
    if (turns.has(turnId)) resolveTurn?.(turns.get(turnId)!);
    return await finished;
  } catch (error) { return callbacks.signal.aborted ? { status: 'interrupted' } : { status: 'failed', error: error instanceof Error ? error.message : 'Codex 执行失败。' }; }
  finally {
    callbacks.signal.removeEventListener('abort', abort);
    for (const current of pending.values()) clearTimeout(current.timer);
    await stopChild(child);
  }
}
