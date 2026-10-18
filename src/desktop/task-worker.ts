import { randomUUID } from 'node:crypto';
import { runPi } from '../infrastructure/execution/pi';
import { runCodex } from '../infrastructure/execution/codex';
import { runClaude } from '../infrastructure/execution/claude';
import type { ExecutionParentMessage, ExecutionWorkerMessage, RuntimeCallbacks } from '../infrastructure/execution/protocol';
import type { ModelCredential } from '../domains/models/model';

const controller = new AbortController();
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
let started = false;
const send = (message: ExecutionWorkerMessage) => { if (process.connected) process.send?.(message); };
function request(message: { type: 'tool'; name: string; args: unknown; callId: string } | { type: 'credential' }): Promise<any> {
  controller.signal.throwIfAborted();
  return new Promise((resolve, reject) => { const id = randomUUID(); pending.set(id, { resolve, reject }); send({ ...message, id }); });
}
const stop = () => { controller.abort(); for (const value of pending.values()) value.reject(new Error('执行已停止。')); pending.clear(); };
process.on('SIGTERM', stop); process.on('SIGHUP', stop);
process.on('disconnect', () => { stop(); setTimeout(() => { try { process.kill(-process.pid, 'SIGTERM'); } catch { process.exit(1); } }, 2000).unref(); });
process.on('message', (message: ExecutionParentMessage) => {
  if (message.type === 'stop') { stop(); if (!started) process.exit(0); return; }
  if (message.type === 'response' || message.type === 'credential') {
    const target = pending.get(message.id); if (!target) return; pending.delete(message.id);
    if (message.error) target.reject(new Error(message.error)); else target.resolve(message.type === 'credential' ? message.credential : message.result);
    return;
  }
  if (message.type !== 'start' || started) return;
  started = true;
  const callbacks: RuntimeCallbacks = { signal: controller.signal, event: event => send({ type: 'event', event }),
    tool: (name, args, callId) => request({ type: 'tool', name, args, callId }), credential: (): Promise<ModelCredential | undefined> => request({ type: 'credential' }) };
  void (async () => {
    try {
      const outcome = message.input.run.selection.runtime === 'pi' ? await runPi(message.input, callbacks)
        : message.input.run.selection.runtime === 'codex-cli' ? await runCodex(message.executable!, message.input, callbacks)
        : await runClaude(message.executable!, message.mcpBridge, message.input, callbacks);
      process.send?.({ type: 'outcome', outcome } satisfies ExecutionWorkerMessage, () => process.exit(0));
    } catch (error) {
      process.send?.({ type: 'outcome', outcome: { status: controller.signal.aborted ? 'interrupted' : 'failed', error: error instanceof Error ? error.message : '执行失败。' } } satisfies ExecutionWorkerMessage, () => process.exit(0));
    }
  })();
});
send({ type: 'ready' });
