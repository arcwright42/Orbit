import { parse } from 'yaml';
import { parseAddress, relativePath } from './files';
import { ContextError, type Atom, type Manifest, type Profile, type Runtime, type Situation, type ContextSource } from './types';
const taxonomies = ['world', 'lore', 'skills', 'mission'] as const;
const situations: Situation[] = ['fresh', 'handover', 'post-compaction'];
function fail(message: string): never { throw new ContextError('manifest', message); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an object.'); return value as Record<string, unknown>; }
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim()) fail('Expected nonempty text.'); return value; }
function list(value: unknown, nonempty = false): unknown[] { if (!Array.isArray(value) || (nonempty && !value.length)) fail('Expected an array.'); return value; }
function one<T extends string>(value: unknown, allowed: readonly T[]): T { if (!allowed.includes(value as T)) fail(`Expected ${allowed.join('|')}, got ${String(value)}`); return value as T; }
function enums<T extends string>(value: unknown, allowed: readonly T[], nonempty = true): T[] {
  const values = list(value, nonempty).map(item => one(item, allowed));
  if (new Set(values).size !== values.length) fail('Duplicate enumeration value.'); return values;
}
function id(value: unknown): string { const result = text(value); if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(result)) fail(`Invalid id: ${result}`); return result; }
function keys(value: Record<string, unknown>, allowed: string[]) { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unknown field: ${key}`); }
export function parseAtom(value: unknown, declaredFiles?: Set<string>): Atom {
  const raw = object(value);
  keys(raw, ['id','address','taxonomy','situations','purpose','runtime','order','priority','requires','profile_only','regions','probe']);
  const address = text(raw.address), parsed = parseAddress(address);
  if (declaredFiles && parsed.source === 'library' && !declaredFiles.has(parsed.path)) fail(`Undeclared atom file: ${parsed.path}`);
  if (!Number.isSafeInteger(raw.order)) fail('Atom order must be an integer.');
  if (raw.profile_only !== undefined && typeof raw.profile_only !== 'boolean') fail('profile_only must be boolean.');
  const atom: Atom = { id: id(raw.id), address, taxonomy: one(raw.taxonomy, taxonomies), situations: enums(raw.situations, situations),
    purpose: one(raw.purpose, ['depth','width']), runtime: one(raw.runtime ?? 'any', ['claude','codex','any']),
    order: raw.order as number, priority: one(raw.priority, ['core','recommended','optional']) };
  if (raw.requires !== undefined) atom.requires = list(raw.requires).map(id);
  if (raw.profile_only === true) atom.profileOnly = true;
  if (raw.regions !== undefined) atom.regions = enums(raw.regions, ['identity','ontology','terrain','actors','laws','history','state','affordances'], false);
  if (raw.probe !== undefined) {
    const probe = object(raw.probe); keys(probe, ['prompt','expect','expectedPatterns','rubric']);
    atom.probe = { prompt: text(probe.prompt), expect: text(probe.expect) };
    if (probe.rubric !== undefined) atom.probe.rubric = text(probe.rubric);
    if (probe.expectedPatterns !== undefined) {
      atom.probe.expectedPatterns = list(probe.expectedPatterns).map(pattern => { const source = text(pattern); try { new RegExp(source); } catch { fail('Invalid probe regex.'); } return source; });
    }
  }
  return atom;
}
export function validateGraph(atoms: Atom[]): void {
  const byId = new Map(atoms.map(atom => [atom.id, atom]));
  if (byId.size !== atoms.length) fail('Duplicate atom id.');
  // Iterative traversal: manifests cannot turn a long requires chain into a JS stack overflow.
  const done = new Set<string>();
  for (const atom of atoms) {
    const stack: Array<{ id: string; exit: boolean }> = [{ id: atom.id, exit: false }], active = new Set<string>();
    while (stack.length) {
      const next = stack.pop()!;
      if (next.exit) { active.delete(next.id); done.add(next.id); continue; }
      if (done.has(next.id)) continue;
      if (active.has(next.id)) fail(`Requires cycle at ${next.id}`);
      const value = byId.get(next.id); if (!value) fail(`Missing required atom: ${next.id}`);
      active.add(next.id); stack.push({ id: next.id, exit: true });
      for (const dependency of [...(value.requires ?? [])].reverse()) stack.push({ id: dependency, exit: false });
    }
  }
}
export function parseManifest(yaml: string): Manifest {
  let raw: Record<string, unknown>;
  try { raw = object(parse(yaml, { maxAliasCount: 50, uniqueKeys: true })); } catch (error) { fail(`Invalid manifest YAML: ${(error as Error).message}`); }
  const version = String(raw.version ?? ''); if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(version)) fail('Invalid version.');
  const files = list(raw.files).map(value => {
    const item = object(value), path = relativePath(text(item.path));
    if (!/\.(md|markdown|yaml|yml|txt|sh|ts|mjs|py)$/.test(path)) fail(`Unsupported file extension: ${path}`);
    return { path, role: text(item.role), ...(item.summary === undefined ? {} : { summary: text(item.summary) }) };
  });
  if (new Set(files.map(file => file.path)).size !== files.length) fail('Duplicate declared file.');
  const atoms = list(raw.atoms ?? []).map(value => parseAtom(value, new Set(files.map(file => file.path))));
  validateGraph(atoms);
  const byId = new Map(atoms.map(atom => [atom.id, atom]));
  const profiles: Profile[] = list(raw.profiles ?? []).map(value => {
    const profile = object(value); keys(profile, ['id','situations','runtimes','phases']);
    const applicable = enums(profile.situations, situations), runtimes = enums<Runtime>(profile.runtimes, ['claude','codex']);
    const selected = new Set<string>(), selectedSources = new Set<string>(), phaseIds = new Set<string>();
    const phases = list(profile.phases, true).map(value => {
      const phase = object(value); keys(phase, ['id','atoms','context']); const phaseId = id(phase.id);
      if (phaseIds.has(phaseId)) fail('Duplicate phase id.'); phaseIds.add(phaseId);
      if ((phase.atoms !== undefined) === (phase.context !== undefined)) fail('Phase must declare exactly atoms or context.');
      if (phase.atoms !== undefined) {
        const ids = list(phase.atoms, true).map(id);
        for (const atomId of ids) {
          const atom = byId.get(atomId); if (!atom) fail(`Profile references missing atom: ${atomId}`);
          if (selected.has(atomId)) fail(`Repeated profile atom: ${atomId}`);
          if (applicable.some(situation => !atom.situations.includes(situation)) || runtimes.some(runtime => atom.runtime !== 'any' && atom.runtime !== runtime)) fail(`Profile incompatible atom: ${atomId}`);
          if (atom.requires?.some(dependency => !selected.has(dependency) && !ids.includes(dependency))) fail(`Dependency must occur in same or earlier phase: ${atomId}`);
          selected.add(atomId);
        }
        return { id: phaseId, atoms: ids };
      }
      const sources = enums<ContextSource>(phase.context, ['project','mission','seat','slice']);
      for (const source of sources) { if (selectedSources.has(source)) fail('Duplicate context phase source.'); selectedSources.add(source); }
      return { id: phaseId, context: sources };
    });
    return { id: id(profile.id), situations: applicable, runtimes, phases };
  });
  if (profiles.length && !atoms.length) fail('Profiles require a canonical atom graph.');
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) fail('Duplicate profile id.');
  const manifest: Manifest = { name: text(raw.name), version, taxonomy: one(raw.taxonomy, taxonomies), files, atoms, profiles };
  if (raw.purpose !== undefined) manifest.purpose = text(raw.purpose);
  if (raw.estimatedTokens !== undefined) { if (typeof raw.estimatedTokens !== 'number' || !Number.isFinite(raw.estimatedTokens) || raw.estimatedTokens < 0) fail('Invalid token estimate.'); manifest.estimatedTokens = raw.estimatedTokens; }
  return manifest;
}
