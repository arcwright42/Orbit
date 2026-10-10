import { DatabaseSync } from 'node:sqlite';
import { readdirSync, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
export interface NativeContext { compactedAt?: string; used?: number; window?: number; sampledAt?: string }
const cache=new Map<string,{at:number;value:NativeContext}>();
/** Read native facts, never interpret cumulative API billing as context occupancy. */
export function codexContext(nativeId: string, home = process.env.CODEX_HOME || join(homedir(),'.codex')): NativeContext {
  const key=`${home}:${nativeId}`,cached=cache.get(key); if(cached && Date.now()-cached.at<5000) return cached.value;
  let path: string | undefined;
  try {
    for (const file of readdirSync(home).filter(f => /^state_\d+\.sqlite$/.test(f)).sort().reverse()) {
      const db=new DatabaseSync(join(home,file),{readOnly:true});
      try { path=db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(nativeId)?.rollout_path as string | undefined; } finally { db.close(); }
      if(path) break;
    }
    if(!path) return {};
    const fd=openSync(path,'r'); let content:string;
    try { const size=fstatSync(fd).size, start=Math.max(0,size-4_000_000), buffer=Buffer.alloc(size-start); readSync(fd,buffer,0,buffer.length,start); content=buffer.toString(); if(start) content=content.slice(content.indexOf('\n')+1); } finally { closeSync(fd); }
    const value=parseNativeContext(content); if(cache.size>256) cache.delete(cache.keys().next().value!); cache.set(key,{at:Date.now(),value}); return value;
  } catch { return {}; }
}
export function parseNativeContext(content: string): NativeContext {
  const result: NativeContext={};
  for (const line of content.split('\n')) try {
    const event=JSON.parse(line);
    if (event.type === 'compacted' || event.payload?.type === 'context_compacted') result.compactedAt=event.timestamp;
    if(event.type === 'event_msg' && event.payload?.type === 'token_count') {
      const info=event.payload.info, used=info?.last_token_usage?.total_tokens, window=info?.model_context_window;
      if(Number.isFinite(used) && Number.isFinite(window) && window>0) Object.assign(result,{used,window,sampledAt:event.timestamp});
    }
  } catch { /* A partial trailing record is not a lifecycle event. */ }
  return result;
}
