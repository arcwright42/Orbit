import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Identity { sessionId:string; generation:string }
interface Challenge extends Identity { challengeId:string; contractHash:string; mode:'none'|'authenticated'; nativeId?:string; status:'missing'|'verified'|'rejected'|'n-a' }
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const expected=(c:Challenge)=>hash(`${c.challengeId}:${c.contractHash}`).slice(0,32);
/** Evidence of content receipt from a bound launch, never evidence of understanding or task success. */
export class StartupProof {
  private challenge:Challenge;
  private file:string;
  private events:string;
  private latest:string;
  constructor(root:string,attempt:string,identity:Identity,contract:string,mode:Challenge['mode'],private current:()=>boolean) {
    mkdirSync(root,{recursive:true});this.file=join(root,`${attempt}.startup-proof.json`);this.events=join(root,`${attempt}.startup-proof.events.jsonl`);
    this.latest=StartupProof.pointer(root,identity);
    this.challenge={sessionId:identity.sessionId,generation:identity.generation,challengeId:randomBytes(16).toString('hex'),contractHash:hash(contract),mode,status:mode==='authenticated' ? 'missing' : 'n-a'};
    this.persist();this.event(mode==='authenticated' ? 'challenged' : 'skipped');
  }
  private static pointer(root:string,identity:Identity) {return join(root,`startup-orientation-${hash(identity.sessionId+':'+identity.generation)}.json`);}
  static needsOrientation(root:string,identity:Identity & {nativeId?:string|null}) {
    try {const previous=JSON.parse(readFileSync(this.pointer(root,identity),'utf8'));return previous.mode==='authenticated' && (previous.status!=='verified' || identity.nativeId!==undefined && previous.nativeId!==identity.nativeId);}
    catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT') return false;throw new Error('Startup orientation receipt is unreadable');}
  }
  get required() {return this.challenge.mode==='authenticated';}
  get verified() {return this.challenge.status==='verified' && this.current();}
  get submission() {return {challengeId:this.challenge.challengeId,answer:expected(this.challenge),sessionId:this.challenge.sessionId,generation:this.challenge.generation};}
  bindNative(nativeId:string) {
    if(!this.current() || JSON.parse(readFileSync(this.latest,'utf8')).challengeId!==this.challenge.challengeId) throw new Error('Startup generation or challenge changed');
    this.challenge.nativeId=nativeId;this.persist();
  }
  prompt(command:string) {return this.required ? `\nStartup orientation challenge (receipt only, distinct from READY):\nAfter reading all startup instructions/files, submit this exact authenticated tool request before work.\nORBIT_STARTUP_PROOF ${JSON.stringify(this.submission)}\nRun: ${command} startup_proof '${JSON.stringify(this.submission)}'\nA bare READY does not satisfy this challenge.\n` : '';}
  verify(input:Record<string,unknown>) {
    if(!this.current()) throw new Error('Startup generation changed or launch canceled');
    const current=JSON.parse(readFileSync(this.latest,'utf8')) as Challenge;
    const reject=(code:string):never=> {this.challenge.status='rejected';this.persist();this.event('rejected',{reason:code});throw new Error(`Startup proof rejected: ${code}`);};
    if(!this.challenge.nativeId || input.sessionId!==undefined && input.sessionId!==this.challenge.sessionId || input.generation!==undefined && input.generation!==this.challenge.generation || input.nativeId!==undefined && input.nativeId!==this.challenge.nativeId) throw new Error('Startup proof identity mismatch or unbound native session');
    if(!this.required || current.challengeId!==this.challenge.challengeId) throw new Error('Startup proof challenge stale');
    if(input.challengeId!==current.challengeId) reject('challenge_stale');
    const answer=typeof input.answer==='string' ? input.answer.trim() : '';
    if(['','ack','ok','ready','done','oriented','acknowledged'].includes(answer.toLowerCase())) reject('bare_ack');
    if(answer!==expected(current)) reject('contract_mismatch');
    this.challenge.status='verified';this.persist();this.event('verified');
    return {verified:true,challengeId:this.challenge.challengeId,sessionId:this.challenge.sessionId,nativeId:this.challenge.nativeId};
  }
  private persist() {
    const data=JSON.stringify(this.challenge);
    for(const file of [this.file,this.latest]) {const temp=`${file}.${randomBytes(8).toString('hex')}.tmp`;try {writeFileSync(temp,data,{mode:0o600});renameSync(temp,file);} finally {rmSync(temp,{force:true});}}
  }
  private event(type:string,extra={}) {appendFileSync(this.events,JSON.stringify({type,...this.challenge,...extra,at:new Date().toISOString()})+'\n',{mode:0o600});}
}
