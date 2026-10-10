import { constants } from 'node:fs';
import { mkdir, realpath, open } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';

/** Internal task files may not follow a project's .orbit symlink outside the selected root. */
export async function taskDirectory(root: string, taskId: string, child?: string) {
  const base = await realpath(root);
  let directory = base;
  for (const segment of ['.orbit', taskId, ...(child ? [child] : [])]) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(segment) || segment === '..') throw new Error('Invalid task path');
    directory = join(directory, segment); await mkdir(directory, { recursive: true });
    const resolved = await realpath(directory), rel = relative(base, resolved);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('任务资料目录不能通过符号链接越出项目目录');
    directory = resolved;
  }
  return directory;
}
export async function writeMission(directory: string, brief: string) {
  const file = await open(join(directory, 'MISSION.md'), constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(brief); } finally { await file.close(); }
}
