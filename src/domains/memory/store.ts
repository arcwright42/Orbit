import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../../infrastructure/database';

/** Taxonomy reference: OpenRig context-pack-types.ts, 4b48ca21 (Apache-2.0).
 * Storage/retrieval is Orbit's implementation, not OpenRig's filesystem context pack format.
 */
export type MemoryTaxonomy = 'world' | 'lore' | 'skills' | 'mission';
export interface MemoryScope { kind: 'personal' | 'team' | 'task'; id: string }
export interface MemoryInput {
  scope: MemoryScope; key: string; taxonomy: MemoryTaxonomy; content: string; sourceRef: string;
}
export interface Memory extends MemoryInput {
  id: string; revision: number; enabled: boolean; createdAt: string; updatedAt: string;
}
export interface MemoryMatch { memory: Memory; score: number }
const taxonomies: MemoryTaxonomy[] = ['world', 'lore', 'skills', 'mission'];
function required(value: string, field: string, max = 32_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${field}.`);
  return value.trim();
}
function scopeKey(scope: MemoryScope): string {
  if (!['personal', 'team', 'task'].includes(scope.kind)) throw new Error('Invalid memory scope.');
  return required(scope.id, 'scope id', 256);
}
function decode(row: Record<string, unknown>): Memory {
  return { id: String(row.id), scope: { kind: row.scope_kind as MemoryScope['kind'], id: String(row.scope_id) },
    key: String(row.key), taxonomy: row.taxonomy as MemoryTaxonomy, content: String(row.content), sourceRef: String(row.source_ref),
    revision: Number(row.revision), enabled: Boolean(row.enabled), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

export class MemoryStore {
  constructor(private db: DatabaseSync) {}

  /** optimistic revision prevents an agent overwriting a newer user correction. 0 = create only. */
  put(input: MemoryInput, expectedRevision: number): Memory {
    const scopeId = scopeKey(input.scope), key = required(input.key, 'key', 256);
    const content = required(input.content, 'memory content'), source = required(input.sourceRef, 'sourceRef', 2048);
    if (!taxonomies.includes(input.taxonomy)) throw new Error('Invalid memory taxonomy.');
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error('Invalid revision.');
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM memories WHERE scope_kind = ? AND scope_id = ? AND key = ?').get(input.scope.kind, scopeId, key);
      if (Number(row?.revision ?? 0) !== expectedRevision) throw new Error('Memory revision conflict.');
      const id = row ? String(row.id) : randomUUID(), now = new Date().toISOString();
      this.db.prepare(`INSERT INTO memories (id,scope_kind,scope_id,key,taxonomy,content,source_ref,revision,enabled,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,1,1,?,?) ON CONFLICT(scope_kind,scope_id,key) DO UPDATE SET
        taxonomy=excluded.taxonomy,content=excluded.content,source_ref=excluded.source_ref,
        revision=memories.revision+1,updated_at=excluded.updated_at`)
        .run(id, input.scope.kind, scopeId, key, input.taxonomy, content, source, now, now);
      return decode(this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id)!);
    });
  }

  list(scope: MemoryScope): Memory[] {
    return this.db.prepare('SELECT * FROM memories WHERE scope_kind = ? AND scope_id = ? ORDER BY updated_at DESC, id').all(scope.kind, scopeKey(scope)).map(decode);
  }

  setEnabled(scope: MemoryScope, id: string, enabled: boolean): void {
    const result = this.db.prepare('UPDATE memories SET enabled = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND scope_kind = ? AND scope_id = ?')
      .run(Number(enabled), new Date().toISOString(), id, scope.kind, scopeKey(scope));
    if (!result.changes) throw new Error('Memory not found in scope.');
  }

  delete(scope: MemoryScope, id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ? AND scope_kind = ? AND scope_id = ?').run(id, scope.kind, scopeKey(scope));
  }

  /** Explicit allowlist only: callers must decide which personal/team/task scopes are authorized.
   * Literal lexical retrieval; Latin words + Han bigrams, no embedding or remote model calls.
   */
  search(scopes: MemoryScope[], query: string, limit = 10): MemoryMatch[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || scopes.length > 32) throw new Error('Invalid search bounds.');
    const normalized = query.normalize('NFKC').toLowerCase().trim();
    if (!normalized) return [];
    const tokens = new Set(normalized.match(/[\p{L}\p{N}]+/gu) ?? []);
    for (const run of normalized.match(/\p{Script=Han}+/gu) ?? []) {
      for (let index = 0; index < run.length - 1; index++) tokens.add(run.slice(index, index + 2));
    }
    const candidates = new Map<string, Memory>();
    for (const scope of scopes) for (const memory of this.list(scope)) if (memory.enabled) candidates.set(memory.id, memory);
    return [...candidates.values()].map(memory => {
      const body = `${memory.key} ${memory.content}`.normalize('NFKC').toLowerCase();
      let score = body.includes(normalized) ? 5 : 0;
      for (const token of tokens) if (body.includes(token)) score += 1;
      return { memory, score };
    }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id)).slice(0, limit);
  }

  /** Whole records only; retain provenance, never silently truncate an authored fact. */
  context(scopes: MemoryScope[], query: string, maxCharacters = 8_000): { records: Memory[]; text: string } {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 0 || maxCharacters > 100_000) throw new Error('Invalid context budget.');
    const records: Memory[] = [], sections: string[] = [];
    let size = 0;
    for (const { memory } of this.search(scopes, query, 100)) {
      const section = JSON.stringify({ id: memory.id, scope: memory.scope, taxonomy: memory.taxonomy, source: memory.sourceRef, content: memory.content });
      const addition = section.length + (sections.length ? 1 : 0);
      if (size + addition > maxCharacters) continue;
      records.push(memory); sections.push(section); size += addition;
    }
    return { records, text: sections.join('\n') };
  }
}
