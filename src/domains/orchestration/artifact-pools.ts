import { basename, isAbsolute, relative, resolve } from 'node:path';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { parse } from 'yaml';
import { readSource } from '../context/files';

/** OpenRig artifact-pool-helpers at 4b48ca21: status-filtered authored records,
 * not arbitrary files. Orbit roots are explicitly limited to the task workspace. */
export interface ArtifactPool {
  path?: string; paths?: string[]; extensions?: string[]; include_statuses?: string[];
  key_field?: string; ignore_names?: string[]; recursive?: boolean; include_malformed_frontmatter?: boolean;
}
export interface Artifact { path: string; raw: string; frontmatter: Record<string, unknown> }
export function expandPools(input: ArtifactPool | ArtifactPool[]): ArtifactPool[] {
  return (Array.isArray(input) ? input : [input]).flatMap(p => p.path ? [p] : (p.paths ?? []).map(path => ({ ...p, path, paths: undefined })));
}
export function validatePools(input: ArtifactPool | ArtifactPool[]) {
  if (!input || typeof input !== 'object') throw new Error('Artifact pool required');
  const specs = Array.isArray(input) ? input : [input];
  if (!specs.length || specs.length > 32) throw new Error('Invalid artifact pools');
  for (const p of specs) {
    if (!p || typeof p !== 'object' || Object.keys(p).some(k => !['path','paths','extensions','include_statuses','key_field','ignore_names','recursive','include_malformed_frontmatter'].includes(k))) throw new Error('Unknown artifact pool setting');
    const paths = p.path !== undefined ? [p.path] : p.paths;
    if (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).some(part => part === '..' || !part) || path.includes('\\'))) throw new Error('Artifact paths must be workspace-relative');
    for (const values of [p.extensions, p.include_statuses, p.ignore_names]) if (values !== undefined && (!Array.isArray(values) || values.some(v => typeof v !== 'string' || !v))) throw new Error('Invalid artifact pool filter');
    if (p.key_field !== undefined && (typeof p.key_field !== 'string' || !p.key_field)) throw new Error('Invalid artifact key');
    for (const flag of [p.recursive,p.include_malformed_frontmatter]) if (flag !== undefined && typeof flag !== 'boolean') throw new Error('Invalid artifact pool flag');
  }
}
export function scanPools(workspace: string, input: ArtifactPool | ArtifactPool[]): Artifact[] {
  validatePools(input);
  const root = realpathSync(workspace), found = new Map<string, Artifact>();
  let visited = 0;
  for (const pool of expandPools(input)) {
    const scan = (path: string, depth: number) => {
      if (++visited > 10000 || depth > 64) throw new Error('Artifact scan exceeds its explicit limit');
      let info: ReturnType<typeof lstatSync>;
      try { info = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
      // Do not traverse links (including directory cycles or paths outside the task).
      if (info.isSymbolicLink()) return;
      const rel = relative(root, realpathSync(path)); if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return;
      if (info.isDirectory()) {
        if (depth === 0 || pool.recursive) for (const entry of readdirSync(path).sort()) scan(resolve(path,entry), depth + 1);
        return;
      }
      if (!info.isFile() || ['README.md','.DS_Store',...(pool.ignore_names ?? [])].includes(basename(path)) || !(pool.extensions ?? ['.md']).some(ext => path.endsWith(ext))) return;
      let raw: string;
      try { raw = readSource(root,rel,rel,'project').text; } catch { return; }
      let frontmatter: Record<string, unknown> = {}, malformed = false;
      if (raw.startsWith('---\n')) {
        const end = raw.indexOf('\n---\n',4);
        if (end >= 0) try {
          const parsed = parse(raw.slice(4,end), { maxAliasCount: 50 });
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) frontmatter = parsed;
        } catch { malformed = true; }
      }
      if (malformed && !pool.include_malformed_frontmatter) return;
      if (pool.include_statuses?.length && !pool.include_statuses.includes(String(frontmatter.status ?? ''))) return;
      found.set(path,{ path, raw, frontmatter });
    };
    scan(resolve(root,pool.path!),0);
  }
  return [...found.values()].sort((a,b) => a.path.localeCompare(b.path));
}
export function sourceKey(artifact: Artifact, key = 'entry') {
  const value = artifact.frontmatter[key];
  return value === undefined || value === null || value === '' ? basename(artifact.path).replace(/\.md$/,'') : value instanceof Date ? value.toISOString() : String(value);
}
