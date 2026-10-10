import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readdirSync, statSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { transaction } from '../../infrastructure/database';
import type { QueueItem } from './types';
export type WatchdogPolicy = 'unclaimed' | 'stalled' | 'periodic-reminder' | 'context-usage-threshold' | 'artifact-pool-ready' | 'edge-artifact-required';
export interface WatchdogSpec { id:string; policy:WatchdogPolicy; after_seconds:number; interval_seconds:number; threshold?:number; paths?:string[]; step_ids?:string[] }
export const defaultWatchdogs: WatchdogSpec[] = [
  {id:'unclaimed',policy:'unclaimed',after_seconds:180,interval_seconds:180},
  {id:'stalled',policy:'stalled',after_seconds:180,interval_seconds:180},
];
export interface WatchdogFacts { item:QueueItem; lastActivity:number; workspace:string; context?:{used?:number;window?:number;sampledAt?:string} }
export interface WatchdogWake { policy:WatchdogPolicy; note:string; receipt:string }
export function validateWatchdogs(specs: WatchdogSpec[]) {
  if(!Array.isArray(specs) || specs.length>32) throw new Error('Invalid watchdogs'); const ids=new Set<string>();
  for(const s of specs) {
    if(!/^[a-zA-Z][\w-]{0,79}$/.test(s.id) || ids.has(s.id) || !['unclaimed','stalled','periodic-reminder','context-usage-threshold','artifact-pool-ready','edge-artifact-required'].includes(s.policy)) throw new Error('Invalid watchdog policy'); ids.add(s.id);
    if(Object.keys(s).some(k=>!['id','policy','after_seconds','interval_seconds','threshold','paths','step_ids'].includes(k))) throw new Error('Unknown watchdog setting');
    if(!Number.isInteger(s.after_seconds) || s.after_seconds<1 || s.after_seconds>604800 || !Number.isInteger(s.interval_seconds) || s.interval_seconds<1 || s.interval_seconds>604800) throw new Error('Invalid watchdog interval');
    if(s.step_ids && (!Array.isArray(s.step_ids) || s.step_ids.some(id=>typeof id!=='string'))) throw new Error('Invalid watchdog steps');
    if(s.policy==='context-usage-threshold' && (typeof s.threshold!=='number' || s.threshold<=0 || s.threshold>1)) throw new Error('Invalid context threshold');
    if(['artifact-pool-ready','edge-artifact-required'].includes(s.policy) && (!Array.isArray(s.paths) || !s.paths.length || s.paths.some(p => typeof p!=='string' || isAbsolute(p) || p.split(/[\\/]/).includes('..')))) throw new Error('Watchdog paths must be workspace-relative');
  }
}
function artifacts(facts: WatchdogFacts, paths:string[]) {
  const root=realpathSync(facts.workspace), entries:string[]=[];
  for(const path of paths) try {
    const target=realpathSync(resolve(root,path)), rel=relative(root,target); if(rel.startsWith('..') || isAbsolute(rel)) continue;
    const files=statSync(target).isDirectory() ? readdirSync(target).slice(0,1000).map(n=>resolve(target,n)) : [target];
    for(const file of files) { const real=realpathSync(file), r=relative(root,real); if(r.startsWith('..') || isAbsolute(r)) continue; const s=statSync(real); if(s.isFile()) entries.push(`${r}:${s.size}:${s.mtimeMs}`); }
  } catch { /* Missing artifacts are a condition, not proof of failed work. */ }
  return entries.sort();
}
export class Watchdog {
  constructor(private db:DatabaseSync) { db.exec(`CREATE TABLE IF NOT EXISTS watchdog_jobs (id TEXT PRIMARY KEY,item_id TEXT NOT NULL,generation TEXT,spec TEXT NOT NULL,due_at INTEGER NOT NULL,last_receipt TEXT,status TEXT NOT NULL); CREATE TABLE IF NOT EXISTS watchdog_history (seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,outcome TEXT NOT NULL,detail TEXT NOT NULL,at INTEGER NOT NULL)`); }
  scan(facts:WatchdogFacts,specs:WatchdogSpec[],deliver:(wake:WatchdogWake)=>void,now=Date.now()) {
    validateWatchdogs(specs);
    for(const spec of specs) transaction(this.db,()=> {
      const item=facts.item,id=`${item.id}:${item.generation ?? 'pending'}:${spec.id}`;
      const live=this.db.prepare('SELECT generation,state,cancel_requested FROM execution_queue WHERE id=?').get(item.id);
      if(!live || live.generation!==item.generation || live.state!==item.state || Boolean(live.cancel_requested)!==item.cancelRequested) return;
      this.db.prepare("UPDATE watchdog_jobs SET status='superseded' WHERE item_id=? AND id<>? AND generation IS NOT ?").run(item.id,id,item.generation);
      this.db.prepare("INSERT OR IGNORE INTO watchdog_jobs VALUES (?,?,?,?,?,NULL,'active')").run(id,item.id,item.generation,JSON.stringify(spec),facts.lastActivity+spec.after_seconds*1000);
      const job=this.db.prepare('SELECT * FROM watchdog_jobs WHERE id=?').get(id)!;
      if(job.status!=='active' || Number(job.due_at)>now) return;
      this.db.prepare('UPDATE watchdog_jobs SET due_at=? WHERE id=?').run(now+spec.interval_seconds*1000,id);
      if(!['pending','in-progress','blocked'].includes(item.state)) { this.db.prepare("UPDATE watchdog_jobs SET status='terminal' WHERE id=?").run(id); this.history(id,'terminal',item.state,now); return; }
      if(item.cancelRequested || item.blockedOn==='runtime:unknown' || item.blockedOn==='application:paused') { this.history(id,'skip','unreconciled or paused',now); return; }
      const age=now-facts.lastActivity, due=age>=spec.after_seconds*1000;
      let condition=false, fingerprint='';
      switch(spec.policy) {
        case 'unclaimed': condition=item.state==='pending' && due; fingerprint=String(facts.lastActivity); break;
        case 'stalled': condition=item.state==='in-progress' && due; fingerprint=String(facts.lastActivity); break;
        case 'periodic-reminder': condition=true; fingerprint=String(Math.floor(now/(spec.interval_seconds*1000))); break;
        case 'context-usage-threshold': { const c=facts.context; condition=!!c?.sampledAt && now-Date.parse(c.sampledAt)<300000 && (c.used ?? 0)/(c.window ?? Infinity)>=spec.threshold!; fingerprint=String(c?.sampledAt); break; }
        case 'artifact-pool-ready': { const files=artifacts(facts,spec.paths!); condition=files.length>0; fingerprint=files.join('|'); break; }
        case 'edge-artifact-required': { const missing=spec.paths!.filter(path=>artifacts(facts,[path]).length===0); condition=missing.length>0 && due; fingerprint=missing.join('|'); break; }
      }
      if(!condition) { this.db.prepare('UPDATE watchdog_jobs SET last_receipt=NULL WHERE id=?').run(id); return; }
      const receipt=createHash('sha256').update(`${spec.policy}:${fingerprint}`).digest('hex'); if(job.last_receipt===receipt) return;
      // Delivery and the receipt share the application database transaction. Failure is retried.
      deliver({policy:spec.policy,note:`Watchdog ${spec.policy}：${item.id}`,receipt});
      this.db.prepare('UPDATE watchdog_jobs SET last_receipt=? WHERE id=?').run(receipt,id); this.history(id,'delivered',receipt,now);
    });
  }
  private history(id:string,outcome:string,detail:string,now:number) { this.db.prepare('INSERT INTO watchdog_history (job_id,outcome,detail,at) VALUES (?,?,?,?)').run(id,outcome,detail,now); }
}
