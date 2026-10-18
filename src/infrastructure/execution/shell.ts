import { spawn } from 'node:child_process';
import type { BashOperations } from '@earendil-works/pi-coding-agent';
import { delay, execFileAsync, executionEnv } from './process';

/** Keep Pi shell jobs in the worker process group, including after a worker crash. */
export const taskShell: BashOperations = {
  exec: async (command, cwd, { onData, signal, timeout, env }) => {
    signal?.throwIfAborted();
    const child = spawn('/bin/bash', ['-c', command], { cwd, env: executionEnv(env), detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false; let stopping: Promise<void> | undefined;
    const stop = () => {
      stopping ??= (async () => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 3000 });
        const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
        const pids = new Set([child.pid]);
        for (let size = 0; size !== pids.size;) { size = pids.size; for (const [pid, parent] of rows) if (pids.has(parent)) pids.add(pid); }
        const kill = (pid: number, kind: NodeJS.Signals) => { try { process.kill(pid, kind); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
        for (const pid of [...pids].reverse()) kill(pid, 'SIGTERM');
        await delay(300);
        // Descendants inherit the worker group; the host also reaps that group before finalizing.
        if (child.exitCode === null && child.signalCode === null) for (const pid of [...pids].reverse()) kill(pid, 'SIGKILL');
      })().catch(() => { child.kill('SIGKILL'); });
    };
    const timer = timeout && timeout > 0 ? setTimeout(() => { timedOut = true; stop(); }, timeout * 1000) : undefined;
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    try {
      if (signal?.aborted) stop();
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      await stopping;
      signal?.throwIfAborted();
      if (timedOut) throw new Error('命令执行超时。');
      return { exitCode: code ?? 1 };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); child.stdout.destroy(); child.stderr.destroy(); }
  },
};
