import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PiAgentHost } from '../src/infrastructure/pi/host';
import { INTERACTION_PROMPT, INTERACTION_TOOLS } from '../src/application/interaction';
import type { WorkerMessage } from '../src/infrastructure/pi/protocol';
import type { Conversation } from '../src/contracts';
import { createModelServer } from './fixtures/model-server';

test('worker crashes restore the same session without replaying a turn; shutdown aborts active work', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-host-test-'));
  const model = await createModelServer();
  let child: ChildProcess | undefined;
  let state: Conversation | undefined;
  const host = new PiAgentHost(() => {
    const process = fork(resolve('src/desktop/agent-worker.ts'), [], {
      execArgv: ['--import', 'tsx'], env: { ...globalThis.process.env, ...model.env }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child = process;
    return {
      send: message => { process.send(message); }, kill: () => { process.kill(); },
      onMessage: listener => { process.on('message', message => listener(message as WorkerMessage)); },
      onExit: listener => { process.on('exit', listener); process.on('error', listener); },
    };
  }, { directory, systemPrompt: INTERACTION_PROMPT, tools: INTERACTION_TOOLS }, () => { throw new Error('Unexpected business call'); }, next => { state = next; });
  try {
    const initial = await host.read(); assert.equal(initial.configured, true, initial.error);
    const input = { requestId: 'crash-request', text: '慢回复', attachments: [] };
    const run = host.send(input);
    const rejected = assert.rejects(run, /退出/);
    for (let i = 0; i < 200 && !state?.draft; i++) await delay(20);
    assert.ok(state?.draft); child!.kill('SIGKILL'); await rejected;
    const resumed = await host.read();
    assert.equal(resumed.sessionId, initial.sessionId);
    assert.match(resumed.error!, /未正常结束/);
    const requestCount = model.requests.length;
    await host.send(input);
    assert.equal(model.requests.length, requestCount);
    await host.send({ requestId: 'after-crash', text: '你好', attachments: [] });
    const active = host.send({ requestId: 'shutdown-request', text: '慢回复', attachments: [] });
    for (let i = 0; i < 200 && !state?.draft; i++) await delay(20);
    await host.close(); await active;
    await assert.rejects(host.read(), /退出/);
  } finally {
    await host.close(); child?.kill(); await model.close(); rmSync(directory, { recursive: true, force: true });
  }
});
