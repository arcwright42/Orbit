import { join } from 'node:path';
import { loadContextPack, assembleContextPack, composeContextPack } from '../domains/context';
import type { ContextSource, Situation } from '../domains/context/types';
import type { Seat } from '../domains/teams/registry';
import type { QueueItem } from '../domains/orchestration/types';

export function runtimeContext(seat: Seat, item: QueueItem, directory: string | undefined, seatRoot: string, situation: Situation): string {
  if(!directory) return '';
  const pack=loadContextPack(directory);
  if(!pack.manifest.atoms.length) return assembleContextPack(pack).text;
  const profileId=seat.context_profiles?.[situation] ?? pack.manifest.profiles.find(p => p.situations.includes(situation) && p.runtimes.includes('codex'))?.id;
  const contextAtoms = Object.fromEntries(Object.entries(seat.context_atoms ?? {}).map(([source,ids]) => [source,ids.map(id => { const atom=pack.manifest.atoms.find(a=>a.id===id); if(!atom) throw new Error(`未知上下文 atom: ${id}`); return atom; })])) as Parameters<typeof composeContextPack>[1]['contextAtoms'];
  const composition=composeContextPack(pack,{situation,runtime:'codex',profileId,contextAtoms,budgetTokens:16000,roots:{project:seat.workspace,mission:join(seat.workspace,'.orbit',item.taskId),seat:seatRoot}});
  const advisories = [
    composition.budget ? `[context budget advisory]\n${JSON.stringify(composition.budget)}\n预算仅供参考，未截断已选上下文。` : '',
    composition.skipped.length ? `[context source advisories]\n${JSON.stringify(composition.skipped)}` : '',
  ].filter(Boolean);
  return [...advisories, ...composition.pieces.map(p=>`[${p.source}:${p.address}; ${p.taxonomy}; ${situation}; ${profileId ?? 'default'}]\n${p.text}`)].join('\n\n');
}
export type ContextSelections = Partial<Record<ContextSource,string[]>>;
