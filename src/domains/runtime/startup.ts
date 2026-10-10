import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { readSource, relativePath } from '../context/files';
import type { Seat } from '../teams/registry';

export type StartupSituation = 'fresh_start' | 'restore';
interface Applicability { applies_on?: StartupSituation[] }
export interface StartupFile extends Applicability { path: string; delivery_hint?: 'auto'|'send_text'|'guidance_merge'|'skill_install'; required?: boolean }
export interface StartupAction extends Applicability { type: 'send_text'|'startup_proof'; value: string; idempotent: boolean; phase?: 'after_files'|'after_ready' }
export interface StartupBlock { files?: StartupFile[]; actions?: StartupAction[] }
export interface StartupLayers { source_root?: string; agent?: StartupBlock; profile?: StartupBlock; culture_file?: string; team?: StartupBlock; pod?: StartupBlock; operator?: StartupBlock }
function keys(value: unknown, allowed: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key=>!allowed.includes(key))) throw new Error('Invalid startup fields');
}
function applicable(value: Applicability, situation: StartupSituation) { return (value.applies_on ?? ['fresh_start','restore']).includes(situation); }
function validateApplicability(value: Applicability) {
  if (value.applies_on!==undefined && (!Array.isArray(value.applies_on) || value.applies_on.some(s=>!['fresh_start','restore'].includes(s)))) throw new Error('Invalid startup applies_on');
}
export function validateStartupBlock(block: StartupBlock) {
  keys(block,['files','actions']);
  if (block.files!==undefined && (!Array.isArray(block.files) || block.files.length>100) || block.actions!==undefined && (!Array.isArray(block.actions) || block.actions.length>100)) throw new Error('Invalid startup files/actions');
  for (const file of block.files ?? []) {
    keys(file,['path','delivery_hint','required','applies_on']); if(typeof file.path!=='string') throw new Error('Invalid startup file'); relativePath(file.path); validateApplicability(file);
    if (file.delivery_hint!==undefined && !['auto','send_text','guidance_merge','skill_install'].includes(file.delivery_hint) || file.required!==undefined && typeof file.required!=='boolean') throw new Error('Invalid startup file delivery');
  }
  for (const action of block.actions ?? []) {
    keys(action,['type','value','idempotent','phase','applies_on']); validateApplicability(action);
    if(!['send_text','startup_proof'].includes(action.type) || typeof action.value!=='string' || !action.value.trim() || action.value.length>16000 || typeof action.idempotent!=='boolean' || action.phase!==undefined && !['after_files','after_ready'].includes(action.phase)) throw new Error('Invalid startup action; exec supports send_text and startup_proof');
    if (!action.idempotent && applicable(action,'restore')) throw new Error('Non-idempotent startup action cannot apply on restore');
    if (action.type==='startup_proof' && (!action.idempotent || !['authenticated','none'].includes(action.value))) throw new Error('Invalid startup proof selection');
  }
}
export function validateStartupLayers(layers: StartupLayers) {
  keys(layers,['source_root','agent','profile','culture_file','team','pod','operator']);
  if(layers.source_root!==undefined && (typeof layers.source_root!=='string' || !isAbsolute(layers.source_root))) throw new Error('Startup source_root must be an absolute directory');
  if(layers.culture_file!==undefined) { if(typeof layers.culture_file!=='string') throw new Error('Invalid culture file'); relativePath(layers.culture_file); }
  for (const key of ['agent','profile','team','pod','operator'] as const) if(layers[key]!==undefined) validateStartupBlock(layers[key]!);
}
/** Same additive precedence as upstream startup-resolver; duplicate delivery is intentional. */
export function resolveStartup(layers: StartupLayers = {}, member: StartupBlock = {}, situation: StartupSituation) {
  validateStartupLayers(layers); validateStartupBlock(member);
  const blocks=[layers.agent,layers.profile,layers.culture_file ? {files:[{path:layers.culture_file}]} : undefined,layers.team,layers.pod,member,layers.operator];
  const files=blocks.flatMap(b=>b?.files ?? []).map((file,order)=>({...file,order})).filter(f=>applicable(f,situation));
  const actions=blocks.flatMap(b=>b?.actions ?? []).filter(a=>applicable(a,situation));
  let proof:'none'|'authenticated'='none'; for(const action of actions) if(action.type==='startup_proof') proof=action.value as typeof proof;
  return {files,actions,proof};
}
const hash=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
interface ProjectedFile { path:string; bytes:Buffer; mode:number }
interface Projection { files: Record<string,string>; guidance?: string; guidanceEntries?: {order:number;text:string}[] }
interface Manifest extends Projection { pending?: Projection }
function atomic(path:string, bytes:string|Buffer, mode=0o600) { mkdirSync(dirname(path),{recursive:true}); const temporary=`${path}.${randomUUID()}.tmp`; try {writeFileSync(temporary,bytes,{mode});renameSync(temporary,path);} finally {rmSync(temporary,{force:true});} }
/** Refuse linked targets: resources are owned local copies, never arbitrary writes through links. */
function target(workspace:string,path:string) {
  relativePath(path); let current=workspace;
  for(const segment of path.split('/')) { current=join(current,segment); try { if(lstatSync(current).isSymbolicLink()) throw new Error(`Startup projection conflict: symbolic link at ${path}`); } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; } }
  return current;
}
export function prepareStartup(seat:Seat,layers:StartupLayers|undefined,evidenceRoot:string,attempt:string,situation:StartupSituation) {
  const resolved=resolveStartup(layers,seat.startup,situation),root=layers?.source_root ?? seat.workspace;
  const files=new Map<string,ProjectedFile>(),guidance:{order:number;text:string}[]=[],parts:string[]=[],warnings:string[]=[],sources:unknown[]=[];
  let bytes=0,count=0;
  for(const file of resolved.files) {
    let source:ReturnType<typeof readSource>;
    try {source=readSource(root,file.path,file.path,'project');}
    catch(error) {if(file.required===false && (error as {code?:string}).code==='missing') {warnings.push(`Optional startup file absent: ${file.path}`);continue;} throw error;}
    const hint=file.delivery_hint && file.delivery_hint!=='auto' ? file.delivery_hint : basename(file.path)==='SKILL.md' ? 'skill_install' : basename(file.path)==='AGENTS.md' ? 'guidance_merge' : 'send_text';
    sources.push({path:file.path,sha256:hash(source.text),delivery:hint,source:source.provenance.realPath});
    if(hint==='send_text') parts.push(`Startup file: ${file.path}\n${source.text}`);
    if(hint==='guidance_merge') guidance.push({order:file.order,text:`Source: ${file.path}\n${source.text}`});
    if(hint==='skill_install') {
      if(basename(file.path)!=='SKILL.md' || dirname(file.path)==='.') throw new Error('skill_install requires a directory containing SKILL.md');
      const skillRoot=dirname(file.path),name=basename(skillRoot);
      if(!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid local skill directory name');
      const destination=`.agents/skills/orbit-${seat.id}-${name}`;
      const walk=(dir:string,depth:number)=> {
        if(depth>32) throw new Error('Startup skill tree too deep');
        for(const entry of readdirSync(join(root,dir),{withFileTypes:true})) {
          const path=`${dir}/${entry.name}`;if(entry.isSymbolicLink()) throw new Error(`Startup skill must not contain symbolic links: ${path}`);
          if(entry.isDirectory()) walk(path,depth+1);
          else {
            const read=readSource(root,path,path,'project'),data=readFileSync(read.provenance.realPath);
            if(++count>1000 || (bytes+=data.length)>16*1024*1024) throw new Error('Startup resources exceed 1000 files / 16 MiB');
            const projected=`${destination}/${path.slice(skillRoot.length+1)}`,prior=files.get(projected);
            if(prior && !prior.bytes.equals(data)) throw new Error(`Startup projection conflict: duplicate ${projected}`);
            files.set(projected,{path:projected,bytes:data,mode:statSync(read.provenance.realPath).mode & 0o777});
          }
        }
      };walk(skillRoot,0);
      parts.push(`Startup skill installed at ${destination}/SKILL.md. Read this skill and its referenced resources before applicable work.`);
    }
  }
  for(const phase of ['after_files','after_ready']) for(const action of resolved.actions) if(action.type==='send_text' && (action.phase ?? 'after_files')===phase) parts.push(`Startup action (${phase}):\n${action.value}`);
  const text=parts.join('\n\n'); if(Buffer.byteLength(text)+Buffer.byteLength(guidance.map(g=>g.text).join('\n'))>512*1024) throw new Error('Startup text exceeds 512 KiB; use skills or context references');
  const manifestPath=join(evidenceRoot,`startup-resources-${hash(seat.workspace+':'+seat.id)}.json`);
  const old:Manifest=existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath,'utf8')) : {files:{}};
  // applies_on controls redelivery. A native restore must not uninstall fresh-only skills/guidance.
  const priorEntries=situation==='restore' ? old.pending?.guidanceEntries ?? old.guidanceEntries ?? [] : [];
  const entries=new Map(priorEntries.map(g=>[g.order,g]));for(const g of guidance) entries.set(g.order,g);
  const planned:Manifest={files:{...(situation==='restore' ? {...old.files,...old.pending?.files} : {}),...Object.fromEntries([...files].map(([path,file])=>[path,hash(file.bytes)]))},guidanceEntries:[...entries.values()].sort((a,b)=>a.order-b.order)};
  const known=new Set([...Object.keys(old.files),...Object.keys(old.pending?.files ?? {}),...files.keys()]);
  // Preflight every target before changing any user-visible file; pending hashes allow crash recovery.
  for(const path of known) {
    if(!path.startsWith(`.agents/skills/orbit-${seat.id}-`)) throw new Error('Invalid startup ownership receipt');
    const dest=target(seat.workspace,path);
    if(existsSync(dest) && ![old.files[path],old.pending?.files[path]].includes(hash(readFileSync(dest)))) throw new Error(`Startup projection conflict: ${path} was not installed by Orbit or has local edits`);
  }
  const manageGuidance=!!(planned.guidanceEntries?.length || old.guidance || old.pending?.guidance);
  const guidePath=manageGuidance ? target(seat.workspace,'AGENTS.md') : join(seat.workspace,'AGENTS.md'),original=manageGuidance && existsSync(guidePath) ? readFileSync(guidePath,'utf8') : '';
  const start=`<!-- orbit:startup:${seat.id}:begin -->`,end=`<!-- orbit:startup:${seat.id}:end -->`;
  const begin=original.indexOf(start),finish=original.indexOf(end);
  if((begin<0)!==(finish<0) || begin>=0 && (finish<begin || original.indexOf(start,begin+start.length)>=0 || original.indexOf(end,finish+end.length)>=0)) throw new Error('Startup guidance conflict: damaged managed block');
  if(begin>=0 && ![old.guidance,old.pending?.guidance].includes(hash(original.slice(begin,finish+end.length)))) throw new Error('Startup guidance conflict: managed block has local edits');
  const block=planned.guidanceEntries?.length ? `${start}\n## Orbit startup for ${seat.role} (${seat.id})\nApplies only to this seat.\n${planned.guidanceEntries.map(g=>g.text).join('\n\n')}\n${end}` : '';
  planned.guidance=block ? hash(block) : undefined;
  const merged=begin>=0 ? original.slice(0,begin)+block+original.slice(finish+end.length) : block ? original+(original && !original.endsWith('\n') ? '\n' : '')+block+'\n' : original;
  atomic(manifestPath,JSON.stringify({...old,pending:planned}));
  for(const path of known) {const file=files.get(path),dest=target(seat.workspace,path);if(file) atomic(dest,file.bytes,file.mode);else if(!planned.files[path]) rmSync(dest,{force:true});}
  if(merged!==original) atomic(guidePath,merged,existsSync(guidePath) ? statSync(guidePath).mode & 0o777 : 0o600);
  atomic(manifestPath,JSON.stringify(planned));
  atomic(join(evidenceRoot,`${attempt}.startup-delivery.json`),JSON.stringify({situation,sources,projection:planned,warnings,proof:resolved.proof}));
  return {text,proof:resolved.proof,warnings,contract:JSON.stringify({sources,projection:planned,text,identity:{role:seat.role,instructions:seat.instructions}})};
}
