import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ContextError, type Source, type Provenance } from './types';
export function relativePath(value: string): string {
  if (!value || isAbsolute(value) || /[\\\0:]/.test(value) || value.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new ContextError('path', `Unsafe relative path: ${value}`);
  }
  return value;
}
export function parseAddress(address: string): { ref: string; source: Source; path: string; headings: string[] } {
  const parts = address.split('#');
  if (parts.length > 2 || !parts[0]) throw new ContextError('address', `Invalid address: ${address}`);
  const headings = parts.length === 2 ? parts[1].split('/') : [];
  if (headings.length > 2 || headings.some(part => !part)) throw new ContextError('address', `Only H2/H3 address paths are supported: ${address}`);
  const ref = parts[0], colon = ref.indexOf(':');
  const source = colon < 0 ? 'library' : ref.slice(0, colon);
  if (!['library', 'project', 'mission', 'seat'].includes(source) || (colon >= 0 && source === 'library')) throw new ContextError('path', `Unknown source prefix: ${ref}`);
  const path = relativePath(colon < 0 ? ref : ref.slice(colon + 1));
  if (headings.length && !/\.(md|markdown)$/.test(path)) throw new ContextError('address', `Section address requires markdown: ${ref}`);
  return { ref, source: source as Source, path, headings };
}
function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
/** Fixed roots are trusted application config. Reads are bounded and never follow a link outside them. */
export function readSource(root: string, path: string, ref: string, source: Source): { text: string; provenance: Provenance } {
  relativePath(path);
  let base: string;
  try { base = realpathSync(root); if (!statSync(base).isDirectory()) throw new Error('not directory'); }
  catch { throw new ContextError('path', `Source root is missing or not a directory: ${root}`); }
  let current = base;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    try { lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ContextError('missing', `Source absent: ${ref}`);
      throw new ContextError('path', `Cannot inspect source: ${ref}`);
    }
    try { current = realpathSync(current); }
    catch { throw new ContextError('path', `Dangling link or unreadable source: ${ref}`); }
    if (!inside(base, current)) throw new ContextError('path', `Source escapes configured root: ${ref}`);
  }
  // O_NOFOLLOW protects the final component from a symlink swap after realpath.
  const descriptor = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > 4 * 1024 * 1024) throw new ContextError('path', `Source must be a regular file <=4MiB: ${ref}`);
    const text = readFileSync(descriptor, 'utf8');
    const verified = realpathSync(join(base, path));
    const after = statSync(verified);
    if (!inside(base, verified) || after.ino !== before.ino || after.dev !== before.dev) throw new ContextError('path', `Source changed during read: ${ref}`);
    return { text, provenance: { ref, source, root: base, realPath: verified } };
  } finally { closeSync(descriptor); }
}

/** OpenRig address compatibility: ASCII slugging, H2/H3 full spans, fenced code ignored. */
function sections(text: string) {
  const lines = text.split('\n'), headers: Array<{ level: number; line: number; path: string[] }> = [];
  let parent: string | null = null, fence: { marker: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (fence) {
        if (marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      } else if (marker[1][0] !== '`' || !marker[2].includes('`')) fence = { marker: marker[1][0], length: marker[1].length };
      continue;
    }
    if (fence) continue;
    const header = line.match(/^ {0,3}(#{1,6})(?:\s+(.*\S))?\s*$/);
    if (!header) continue;
    const level = header[1].length, title = header[2] ?? '';
    const slug = title.toLowerCase().replace(/[`*_~]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (level === 1) parent = title ? null : '';
    if (level === 2) parent = slug;
    headers.push({ level, line: index, path: level === 3 && parent !== null ? [parent, slug] : [slug] });
  }
  return { lines, headers, fence };
}
export function validateMarkdownAddressability(text: string): void {
  const { headers, fence } = sections(text);
  if (fence) throw new ContextError('address','Unterminated markdown fence');
  const paths = new Set<string>();
  for (const header of headers.filter(h => [2,3].includes(h.level))) { const path = header.path.join('/'); if (paths.has(path)) throw new ContextError('address', `Duplicate markdown address: ${path}`); paths.add(path); }
}
export function recapAdvisories(text: string): string[] {
  const notes: string[] = []; if (!sections(text).headers.some(h => h.path.some(p => p.includes('decision'))) && !/^#{1,6} .*决策/m.test(text)) notes.push('no-decisions-section');
  text.split('\n').forEach((line,i) => { if (/unverified/i.test(line) && !line.includes('UNVERIFIED:')) notes.push(`nonstandard-unverified-marker:${i+1}`); }); return notes;
}
export function readSection(text: string, headings: string[]): string {
  if (!headings.length) return text;
  const {lines,headers} = sections(text);
  const matches = headers.filter(header => [2, 3].includes(header.level) && header.path.join('/') === headings.join('/'));
  if (matches.length !== 1) throw new ContextError('address', `Section ${headings.join('/')} is ${matches.length ? 'ambiguous' : 'missing'}.`);
  const start = matches[0], end = headers.find(header => header.line > start.line && header.level <= start.level)?.line ?? lines.length;
  return lines.slice(start.line, end).join('\n');
}
