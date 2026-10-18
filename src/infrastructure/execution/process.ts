import { accessSync, constants } from 'node:fs';
import { execFile, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { ExecutionRuntime, RuntimeAvailability, TaskRun } from '../../domains/tasks/execution';

export const execFileAsync = promisify(execFile);
export function executionEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PATH: [...new Set([...(env.PATH ?? '').split(delimiter), join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].filter(Boolean).join(delimiter) };
}
export function executableFor(runtime: Exclude<ExecutionRuntime, 'pi'>, env: NodeJS.ProcessEnv = process.env): string {
  const override = runtime === 'codex-cli' ? env.ORBIT_CODEX_PATH : env.ORBIT_CLAUDE_PATH;
  const name = runtime === 'codex-cli' ? 'codex' : 'claude';
  const candidates = override ? [override] : executionEnv(env).PATH!.split(delimiter).map(path => join(path, name));
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next known executable directory */ }
  }
  throw new Error('未找到 ' + name + ' CLI，请先在本机安装并登录。');
}
export async function probeCli(runtime: Exclude<ExecutionRuntime, 'pi'>, env = process.env): Promise<RuntimeAvailability> {
  try {
    const executable = executableFor(runtime, env);
    const options = { env: executionEnv(env), timeout: 8000, maxBuffer: 256 * 1024 };
    const version = (await execFileAsync(executable, ['--version'], options)).stdout.trim().slice(0, 150);
    if (runtime === 'codex-cli') {
      const match = /codex-cli (\d+)\.(\d+)/.exec(version);
      if (!match || Number(match[1]) === 0 && Number(match[2]) < 161) throw new Error('Codex CLI 需要 0.161.0 或更高版本。');
      await execFileAsync(executable, ['login', 'status'], options);
    } else await execFileAsync(executable, ['auth', 'status', '--json'], options);
    return { runtime, available: true, version, message: '本地 CLI 与登录可用。' };
  } catch (error) {
    const message = error instanceof Error && (error.message.startsWith('未找到') || error.message.startsWith('Codex CLI 需要'))
      ? error.message : 'CLI 不可用或尚未登录，请在终端检查安装和登录状态。';
    return { runtime, available: false, message };
  }
}
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
export async function groupMembers(group: number): Promise<number[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,pgid='], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(([, pgid]) => pgid === group).map(([pid]) => pid);
}
export function signalGroup(pid: number, signal: NodeJS.Signals) {
  try { process.kill(-pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function stopGroup(pid: number) {
  signalGroup(pid, 'SIGTERM');
  for (let i = 0; i < 30; i++) { if (!(await groupMembers(pid)).length) return; await delay(100); }
  signalGroup(pid, 'SIGKILL');
  for (let i = 0; i < 20; i++) { if (!(await groupMembers(pid)).length) return; await delay(100); }
  throw new Error('执行进程尚未确认停止，暂不启动重复执行。');
}
export async function reconcileWorker(run: TaskRun) {
  if (!run.workerPid) return; // Worker never received start before its process receipt was committed.
  if (!alive(run.workerPid)) {
    if ((await groupMembers(run.workerPid)).length) throw new Error('旧执行仍有未核实的子进程，暂不重复执行。');
    return;
  }
  const { stdout } = await execFileAsync('/bin/ps', ['-p', String(run.workerPid), '-o', 'command='], { timeout: 5000 });
  if (!run.workerIdentity || !stdout.includes('--orbit-run=' + run.id) || !stdout.includes('--orbit-worker=' + run.workerIdentity)) throw new Error('旧进程身份无法确认，请检查后重试。');
  await stopGroup(run.workerPid);
}
export async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([closed, delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await closed;
}
