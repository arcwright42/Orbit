import { randomUUID } from 'node:crypto';
import { PiSession } from '../infrastructure/pi/session';
import { modelCatalog, testModelConnection, type ResolveModelCredential } from '../infrastructure/pi/models';
import { ModelConfigurationError, type ModelCredential } from '../domains/models/model';
import type { ParentMessage, WorkerMessage } from '../infrastructure/pi/protocol';

// Electron utilityProcess in the app; Node IPC in isolated integration tests.
const parentPort = (process as NodeJS.Process & { parentPort?: {
  postMessage(message: WorkerMessage): void;
  on(event: 'message', listener: (event: { data: ParentMessage }) => void): void;
} }).parentPort;
const send = (message: WorkerMessage) => { if (parentPort) parentPort.postMessage(message); else process.send?.(message); };
let session: PiSession | undefined;
const tools = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
const credentials = new Map<string, { resolve: (value: ModelCredential | undefined) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
const credential: ResolveModelCredential = profileId => new Promise((resolve, reject) => {
  const id = randomUUID();
  const timer = setTimeout(() => { credentials.delete(id); reject(new ModelConfigurationError('模型凭据读取超时。')); }, 15_000);
  credentials.set(id, { resolve, reject, timer });
  send({ type: 'credential', id, profileId });
});

async function receive(message: ParentMessage): Promise<void> {
  if (message.type === 'credential_result') {
    const pending = credentials.get(message.id);
    if (pending) {
      credentials.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new ModelConfigurationError(message.error)); else pending.resolve(message.credential);
    }
    return;
  }
  if (message.type === 'tool_result') {
    const pending = tools.get(message.id);
    if (pending) {
      tools.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
    }
    return;
  }
  try {
    if (message.type === 'init') {
      if (session) throw new Error('会话已经初始化。');
      session = await PiSession.open(message.setup, (name, args, context) => new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => { tools.delete(id); reject(new Error('业务工具响应超时。')); }, 15_000);
        tools.set(id, { resolve, reject, timer });
        send({ type: 'tool', id, name, args, context });
      }), state => send({ type: 'state', state }), process.env, message.setup.model === undefined ? undefined : credential);
    } else {
      if (!session) throw new Error('会话尚未初始化。');
      if (message.type === 'configure') await session.configure(message.model, credential);
      if (message.type === 'catalog') {
        send({ type: 'response', id: message.id, models: await modelCatalog(message.providerId) }); return;
      }
      if (message.type === 'test_model') {
        if (!message.model) throw new ModelConfigurationError('请先选择模型配置。');
        send({ type: 'response', id: message.id, connection: await testModelConnection(message.model, credential) }); return;
      }
      if (message.type === 'send') await session.send(message.input);
      if (message.type === 'abort' || message.type === 'close') {
        for (const pending of tools.values()) { clearTimeout(pending.timer); pending.reject(new Error('回复已停止。')); }
        tools.clear();
        if (message.type === 'close') await session.close(); else await session.abort();
      }
    }
    send({ type: 'response', id: message.id, state: session!.read() });
  } catch (error) {
    send({ type: 'response', id: message.id, error: error instanceof Error ? error.message : '对话操作失败。', configurationError: error instanceof ModelConfigurationError });
  }
}
if (parentPort) parentPort.on('message', event => { void receive(event.data); });
else {
  process.on('message', message => { void receive(message as ParentMessage); });
  process.on('disconnect', () => { void session?.close().finally(() => process.exit(0)); });
}
