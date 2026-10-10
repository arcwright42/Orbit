import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, writeFile, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import type { Seat } from '../teams/registry';
const exec = promisify(execFile);
export function runtimeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME','PATH','USER','LOGNAME','TMPDIR','LANG','LC_ALL','CODEX_HOME','SSL_CERT_FILE','SSL_CERT_DIR']) if (process.env[key]) env[key]=process.env[key];
  return env;
}
export type Readiness = {ready:true} | {ready:false; blockedOn:string; reason:string};
/** Local checks never perform a model turn or infer auth readiness from a config file. */
export async function checkCodexReady(binary: string, seat: Seat, signal?: AbortSignal): Promise<Readiness> {
  try { await access(seat.workspace,constants.R_OK | constants.W_OK); }
  catch { return {ready:false,blockedOn:'context:workspace',reason:'工作目录不存在或不可读写'}; }
  try { await exec(binary,['--version'],{env:runtimeEnvironment(),timeout:10000,signal,maxBuffer:65536}); }
  catch { return {ready:false,blockedOn:'runtime:unavailable',reason:'Codex 不可执行或版本检查超时'}; }
  try { await exec(binary,['login','status'],{env:runtimeEnvironment(),timeout:10000,signal,maxBuffer:65536}); }
  catch { return {ready:false,blockedOn:'auth:codex',reason:'Codex 登录状态检查失败，请完成本地登录后重试'}; }
  return {ready:true};
}
/** Per-attempt resource receipt. No edits to user-owned AGENTS.md or global Codex config. */
export async function projectStartup(root: string, name: string, prompt: string) {
  await mkdir(root,{recursive:true}); const path=join(root,`${name}.startup.md`), temporary=`${path}.tmp`;
  await writeFile(temporary,prompt,{mode:0o600}); await rename(temporary,path); return path;
}
