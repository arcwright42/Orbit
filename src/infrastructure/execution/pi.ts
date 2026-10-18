import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { createAgentSession, createBashToolDefinition, createExtensionRuntime, SessionManager, SettingsManager, type ResourceLoader, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TaskRuntimeInput, TaskRuntimeOutcome } from '../../domains/tasks/runtime';
import { piContextPolicy } from '../../domains/conversation/history';
import { createModelRuntime, modelFailure } from '../pi/models';
import type { RuntimeCallbacks } from './protocol';
import { taskShell } from './shell';

export async function runPi(input: TaskRuntimeInput, callbacks: RuntimeCallbacks): Promise<TaskRuntimeOutcome> {
  const profile = input.run.selection.model;
  if (!profile) throw new Error('任务缺少 Pi 模型配置。');
  const { runtime, model: original } = await createModelRuntime(profile, callbacks.credential);
  callbacks.signal.throwIfAborted();
  const policy = piContextPolicy(original.contextWindow);
  const model = { ...original, contextWindow: policy.contextWindow };
  const sessions = join(input.runDirectory, 'sessions'); mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const restored = input.resumeSession && existsSync(input.resumeSession);
  const manager = restored ? SessionManager.open(input.resumeSession!, sessions, input.directory) : SessionManager.create(input.directory, sessions);
  if (input.resumeSession && !restored) callbacks.event({ type: 'activity', message: '原生 Pi 会话文件缺失，将根据任务记录和已有成果建立新会话。' });
  manager.appendCustomEntry('orbit.task-run.v1', { taskId: input.run.taskId, stepId: input.run.stepId, runId: input.run.id });
  callbacks.event({ type: 'session', sessionId: manager.getSessionFile()! });
  const extensionRuntime = createExtensionRuntime();
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: extensionRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => '你是 Orbit 管理的任务执行 Agent。遵守当前任务边界，通过提供的业务工具记录进展和提交成果。',
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
  const customTools: ToolDefinition[] = input.tools.map(tool => ({ ...tool, label: tool.name, parameters: Type.Unsafe(tool.parameters), executionMode: 'sequential',
    execute: async (id, args, signal) => {
      callbacks.signal.throwIfAborted(); signal?.throwIfAborted();
      const result = await callbacks.tool(tool.name, args, id);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  }));
  const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: policy.reserveTokens, keepRecentTokens: policy.keepRecentTokens }, cacheWarming: 'off',
    retry: { enabled: true, maxRetries: 2, provider: { timeoutMs: 120000, maxRetries: 1 } } });
  settings.setTransport('sse');
  const shell = createBashToolDefinition(input.directory, { operations: taskShell });
  // SDK rendering callbacks are generic-invariant; headless execution only needs this tool surface.
  const shellTool: ToolDefinition = { name: shell.name, label: shell.label, description: shell.description, parameters: Type.Unsafe(shell.parameters),
    execute: (id, args, signal, update, context) => shell.execute(id, args as { command: string; timeout?: number }, signal, update, context) };
  const { session } = await createAgentSession({ cwd: input.directory, agentDir: input.runDirectory, sessionManager: manager,
    model, modelRuntime: runtime, settingsManager: settings, resourceLoader, thinkingLevel: 'off',
    tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', ...input.tools.map(tool => tool.name)],
    customTools: [shellTool, ...customTools] });
  let failed = false;
  const abort = () => { void session.abort(); };
  callbacks.signal.addEventListener('abort', abort, { once: true });
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'agent_start' && callbacks.signal.aborted) void session.abort();
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') callbacks.event({ type: 'output', text: event.assistantMessageEvent.delta });
    if (event.type === 'tool_execution_start') callbacks.event({ type: 'activity', message: '正在使用工具：' + event.toolName });
    if (event.type === 'message_end' && event.message.role === 'assistant') failed = event.message.stopReason === 'error' || event.message.stopReason === 'length';
  });
  try {
    callbacks.signal.throwIfAborted();
    await session.prompt(input.prompt, { expandPromptTemplates: false }); await session.waitForIdle();
    return callbacks.signal.aborted ? { status: 'interrupted' } : failed ? { status: 'failed', error: 'Pi 模型未正常完成本轮执行。' } : { status: 'completed' };
  } catch (error) { return callbacks.signal.aborted ? { status: 'interrupted' } : { status: 'failed', error: modelFailure(error) }; }
  finally { callbacks.signal.removeEventListener('abort', abort); unsubscribe(); session.dispose(); }
}
