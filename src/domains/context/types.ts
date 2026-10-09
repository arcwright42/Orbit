export type Taxonomy = 'world' | 'lore' | 'skills' | 'mission';
export type Situation = 'fresh' | 'handover' | 'post-compaction';
export type Runtime = 'claude' | 'codex';
export type Source = 'library' | 'project' | 'mission' | 'seat';
export type ContextSource = 'project' | 'mission' | 'seat' | 'slice';
export interface Atom {
  id: string; address: string; taxonomy: Taxonomy; situations: Situation[];
  purpose: 'depth' | 'width'; runtime: Runtime | 'any'; order: number;
  priority: 'core' | 'recommended' | 'optional'; requires?: string[]; profileOnly?: boolean;
  regions?: string[]; probe?: { prompt: string; expect: string; expectedPatterns?: string[]; rubric?: string };
}
export interface Profile { id: string; situations: Situation[]; runtimes: Runtime[]; phases: Array<{ id: string; atoms?: string[]; context?: ContextSource[] }> }
export interface Manifest {
  name: string; version: string; taxonomy: Taxonomy; purpose?: string; estimatedTokens?: number;
  files: Array<{ path: string; role: string; summary?: string }>; atoms: Atom[]; profiles: Profile[];
}
export interface ContextPack { directory: string; manifest: Manifest }
export interface Provenance { ref: string; source: Source; root: string; realPath: string }
export interface Piece extends Provenance {
  atomId: string; address: string; taxonomy: Taxonomy; priority: Atom['priority']; order: number;
  text: string; estimatedTokens: number; phaseId?: string;
}
export interface Composition {
  situation: Situation; runtime: Runtime; profileId?: string; pieces: Piece[]; totalEstimatedTokens: number;
  phases?: Array<{ id: string; kind: 'atoms' | 'context'; pieces: Piece[] }>;
  skipped: Array<{ atomId: string; address: string; reason: string }>;
  budget?: { limitTokens: number; overageTokens: number; dropCandidates: Array<{ atomId: string; priority: Atom['priority']; estimatedTokens: number }> };
}
export class ContextError extends Error {
  constructor(public code: 'manifest' | 'path' | 'missing' | 'address' | 'compose', message: string) { super(message); this.name = 'ContextError'; }
}
