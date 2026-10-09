import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseAddress, readSection, readSource } from './files';
import { parseAtom, parseManifest, validateGraph } from './manifest';
import { ContextError, type Atom, type Composition, type ContextPack, type ContextSource, type Piece, type Runtime, type Situation, type Source } from './types';
export * from './types';
export { parseManifest } from './manifest';
export { parseAddress, readSection } from './files';

/** Load an actual directory and verify every declared file, not just selected atoms. */
export function loadContextPack(directory: string): ContextPack {
  const manifest = parseManifest(readSource(directory, 'manifest.yaml', 'manifest.yaml', 'library').text);
  for (const file of manifest.files) readSource(directory, file.path, file.path, 'library');
  return { directory: realpathSync(directory), manifest };
}

/** Import declared bytes only; source tree references remain references to caller-owned roots.
 * Destination must not exist. Script files are inert bytes, never executed.
 */
export function importContextPack(sourceDirectory: string, destination: string): ContextPack {
  const manifestText = readSource(sourceDirectory, 'manifest.yaml', 'manifest.yaml', 'library').text;
  const manifest = parseManifest(manifestText);
  if (manifest.files.some(file => file.path === 'manifest.yaml')) throw new ContextError('manifest', 'manifest.yaml cannot also be a content file.');
  const files = manifest.files.map(file => ({ path: file.path, text: readSource(sourceDirectory, file.path, file.path, 'library').text }));
  mkdirSync(destination); // exclusive creation; never overwrite a pre-existing pack
  try {
    writeFileSync(join(destination, 'manifest.yaml'), manifestText, { flag: 'wx' });
    for (const file of files) { const path = join(destination, file.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, file.text, { flag: 'wx' }); }
    return loadContextPack(destination);
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
}

/** File-only packs use the declared file walk, distinct from atom-profile composition.
 * Bytes are untouched; the separator matches upstream plain-file assembly.
 */
export function assembleContextPack(pack: ContextPack): {
  text: string; estimatedTokens: number; files: Array<{ path: string; role: string; text: string; provenance: import('./types').Provenance }>;
} {
  const files = pack.manifest.files.map(file => {
    const read = readSource(pack.directory, file.path, file.path, 'library');
    return { path: file.path, role: file.role, text: read.text, provenance: read.provenance };
  });
  const text = files.map(file => file.text).join('\n\n');
  return { text, estimatedTokens: Math.ceil(Buffer.byteLength(text, 'utf8') / 4), files };
}

export interface ComposeOptions {
  situation: Situation;
  runtime: Runtime;
  budgetTokens?: number;
  profileId?: string;
  roots?: Partial<Record<Exclude<Source, 'library'>, string>>;
  /** Explicit, ordered selections, not guessed files. slice is a phase grouping, NOT a filesystem root prefix. */
  contextAtoms?: Partial<Record<ContextSource, Atom[]>>;
}
export function composeContextPack(pack: ContextPack, options: ComposeOptions): Composition {
  if (!['fresh','handover','post-compaction'].includes(options.situation) || !['claude','codex'].includes(options.runtime)) throw new ContextError('compose', 'Invalid situation/runtime.');
  if (options.budgetTokens !== undefined && (!Number.isSafeInteger(options.budgetTokens) || options.budgetTokens < 0)) throw new ContextError('compose', 'Invalid token budget.');
  if (!pack.manifest.atoms.length) throw new ContextError('compose', 'File-only pack: use assembleContextPack instead of atom composition.');
  const manifest = pack.manifest, byId = new Map(manifest.atoms.map(atom => [atom.id, atom]));
  const result: Composition = { situation: options.situation, runtime: options.runtime, pieces: [], totalEstimatedTokens: 0, skipped: [] };
  const fits = (atom: Atom) => atom.runtime === 'any' || atom.runtime === options.runtime;
  const resolve = (atom: Atom, phaseId?: string): Piece[] => {
    if (!fits(atom)) throw new ContextError('compose', `Runtime excludes required atom: ${atom.id}`);
    const parsed = parseAddress(atom.address);
    if (parsed.source === 'library' && !manifest.files.some(file => file.path === parsed.path)) throw new ContextError('compose', `Undeclared library file: ${parsed.path}`);
    const root = parsed.source === 'library' ? pack.directory : options.roots?.[parsed.source];
    if (!root) throw new ContextError('compose', `Missing configured ${parsed.source} root for ${atom.id}`);
    try {
      const read = readSource(root, parsed.path, parsed.ref, parsed.source), text = readSection(read.text, parsed.headings);
      return [{ ...read.provenance, atomId: atom.id, address: atom.address, taxonomy: atom.taxonomy, priority: atom.priority, order: atom.order,
        text, estimatedTokens: Math.ceil(Buffer.byteLength(text, 'utf8') / 4), ...(phaseId ? { phaseId } : {}) }];
    } catch (error) {
      if (error instanceof ContextError && error.code === 'missing' && parsed.source === 'seat' && parsed.path === 'RECAP.md' && options.situation === 'post-compaction') {
        result.skipped.push({ atomId: atom.id, address: atom.address, reason: 'Seat recap genuinely absent.' }); return [];
      }
      throw new ContextError('compose', `Atom ${atom.id} (${atom.address}): ${(error as Error).message}`);
    }
  };
  if (options.profileId !== undefined) {
    const profile = manifest.profiles.find(profile => profile.id === options.profileId);
    if (!profile || !profile.situations.includes(options.situation) || !profile.runtimes.includes(options.runtime)) throw new ContextError('compose', 'Profile missing or incompatible with situation/runtime.');
    result.profileId = profile.id;
    const delivered = new Set<string>();
    result.phases = profile.phases.map(phase => {
      let selected: Atom[];
      if (phase.atoms) selected = phase.atoms.map(atomId => byId.get(atomId)!);
      else {
        selected = (phase.context ?? []).flatMap(source => {
          const explicit = options.contextAtoms?.[source];
          if (!explicit?.length) throw new ContextError('compose', `Phase ${phase.id} requires explicit ${source} context selection.`);
          return explicit.map(atom => {
            const { profileOnly, ...fields } = atom;
            return parseAtom({ ...fields, ...(profileOnly ? { profile_only: true } : {}) });
          });
        });
        // Unlike the upstream caller contract, Orbit validates supplied selections at this public boundary.
        for (const atom of selected) {
          if (!atom.situations.includes(options.situation)) throw new ContextError('compose', `Context atom ${atom.id} excludes situation.`);
          if (atom.requires?.some(dependency => !delivered.has(dependency) && !selected.some(other => other.id === dependency))) throw new ContextError('compose', `Context dependency omitted: ${atom.id}`);
        }
        const selectedIds = new Set(selected.map(atom => atom.id));
        validateGraph(selected.map(atom => ({ ...atom, requires: atom.requires?.filter(id => selectedIds.has(id)) })));
      }
      for (const atom of selected) { if (delivered.has(atom.id)) throw new ContextError('compose', `Repeated delivered atom: ${atom.id}`); delivered.add(atom.id); }
      return { id: phase.id, kind: phase.atoms ? 'atoms' as const : 'context' as const, pieces: selected.flatMap(atom => resolve(atom, phase.id)) };
    });
    result.pieces = result.phases.flatMap(phase => phase.pieces);
  } else {
    const tags: Situation[] = options.situation === 'fresh' ? ['fresh'] : options.situation === 'handover' ? ['fresh','handover'] : ['post-compaction','handover'];
    const selected = new Map(manifest.atoms.filter(atom => !atom.profileOnly && fits(atom) && atom.situations.some(tag => tags.includes(tag))).map(atom => [atom.id, atom]));
    const pending = [...selected.values()];
    while (pending.length) {
      const atom = pending.pop()!;
      for (const dependency of atom.requires ?? []) {
        const needed = byId.get(dependency);
        if (!needed || !fits(needed)) throw new ContextError('compose', `Dependency unavailable for ${options.runtime}: ${atom.id} requires ${dependency}`);
        if (!selected.has(dependency)) { selected.set(dependency, needed); pending.push(needed); }
      }
    }
    result.pieces = [...selected.values()].sort((a,b) => a.order - b.order || a.id.localeCompare(b.id)).flatMap(atom => resolve(atom));
  }
  result.totalEstimatedTokens = result.pieces.reduce((sum, piece) => sum + piece.estimatedTokens, 0);
  if (options.budgetTokens !== undefined && result.totalEstimatedTokens > options.budgetTokens) {
    const priority = { optional: 0, recommended: 1, core: 2 };
    result.budget = { limitTokens: options.budgetTokens, overageTokens: result.totalEstimatedTokens - options.budgetTokens,
      dropCandidates: [...result.pieces].sort((a,b) => priority[a.priority] - priority[b.priority] || b.estimatedTokens - a.estimatedTokens || a.atomId.localeCompare(b.atomId))
        .map(piece => ({ atomId: piece.atomId, priority: piece.priority, estimatedTokens: piece.estimatedTokens })) };
  }
  return result;
}
