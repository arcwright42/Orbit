import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { MaterialLibrary } from '../../domains/materials/library';
import type { Task } from '../../contracts';
import type { TaskArtifact, TaskPlan } from '../../domains/tasks/execution';

export class TaskFiles {
  constructor(readonly root: string, private materials: MaterialLibrary) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // macOS /var -> /private/var must not turn a valid artifact into a ../ path.
    this.root = realpathSync(root);
  }
  taskDirectory(taskId: string): string { return this.child(this.root, taskId); }
  stepDirectory(taskId: string, stepId: string): string { return this.child(join(this.taskDirectory(taskId), 'steps'), stepId); }
  runDirectory(taskId: string, runId: string): string { return this.child(join(this.taskDirectory(taskId), 'runs'), runId); }
  private child(root: string, id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('目录标识无效。');
    return join(root, id);
  }
  prepare(task: Task) {
    const root = this.taskDirectory(task.id);
    mkdirSync(join(root, 'inputs'), { recursive: true, mode: 0o700 });
    const inputs = task.attachmentIds.map(id => {
      const { attachment, path } = this.materials.require(id);
      const target = join(root, 'inputs', id + '-' + basename(attachment.name));
      if (!existsSync(target)) copyFileSync(path, target);
      return { id, name: attachment.name, path: relative(root, target) };
    });
    this.writeJson(join(root, 'inputs.json'), inputs);
    return root;
  }
  prepareRun(taskId: string, stepId: string, runId: string) {
    const directory = this.stepDirectory(taskId, stepId);
    const runDirectory = this.runDirectory(taskId, runId);
    mkdirSync(directory, { recursive: true, mode: 0o700 }); mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const root = realpathSync(this.taskDirectory(taskId)) + sep;
    if (!realpathSync(directory).startsWith(root) || !realpathSync(runDirectory).startsWith(root)) throw new Error('步骤或执行目录不能指向任务外部。');
    return { directory, runDirectory };
  }
  plan(taskId: string, plan: TaskPlan) { this.writeJson(join(this.taskDirectory(taskId), 'plan.json'), plan); }
  writeJson(path: string, value: unknown) { const temporary = path + '.' + randomUUID() + '.tmp'; writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
  log(taskId: string, runId: string, value: unknown) { appendFileSync(join(this.runDirectory(taskId, runId), 'events.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 }); }
  artifacts(taskId: string, stepId: string, value: unknown): TaskArtifact[] {
    if (!Array.isArray(value) || value.length > 32 || value.some(path => typeof path !== 'string')) throw new Error('成果必须是最多 32 个相对文件路径。');
    return [...new Set(value as string[])].map(path => {
      const absolute = this.containedFile(this.stepDirectory(taskId, stepId), path);
      if (!absolute.startsWith(realpathSync(this.taskDirectory(taskId)) + sep)) throw new Error('成果不能指向任务外部。');
      const stat = statSync(absolute);
      if (stat.size > 100 * 1024 * 1024) throw new Error('单个成果文件不得超过 100 MB。');
      return { path: relative(this.taskDirectory(taskId), absolute), size: stat.size, sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex') };
    });
  }
  openArtifact(taskId: string, path: string): string { return this.containedFile(this.taskDirectory(taskId), path); }
  verify(taskId: string, artifact: TaskArtifact) {
    const path = this.openArtifact(taskId, artifact.path);
    if (statSync(path).size !== artifact.size || createHash('sha256').update(readFileSync(path)).digest('hex') !== artifact.sha256) throw new Error('成果在提交后发生变化，请重新提交：' + artifact.path);
  }
  private containedFile(root: string, path: string): string {
    if (!path || isAbsolute(path)) throw new Error('成果必须使用步骤目录内的相对路径。');
    const actualRoot = realpathSync(root);
    const actual = realpathSync(resolve(root, path));
    if (!actual.startsWith(actualRoot + sep) || !statSync(actual).isFile()) throw new Error('成果必须是目录内的普通文件，不能越界。');
    return actual;
  }
}
