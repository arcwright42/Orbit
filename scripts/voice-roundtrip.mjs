// Opt-in official API test. Pass mono 16 kHz WAV paths: wake phrase, then task query.
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/voice-roundtrip.mjs <wake.wav> <query.wav>');
import {_electron as electron} from '@playwright/test';
import {createRequire} from 'node:module';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import{join}from'node:path';
const require=createRequire(import.meta.url);const {readWave}=require('sherpa-onnx-node');
const dir=await mkdtemp(join(tmpdir(),'orbit-voice-'));const env={...process.env,ORBIT_DATA_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;let app;
try{app=await electron.launch({args:['.'],cwd:process.cwd(),env});const page=await app.firstWindow();
await page.evaluate(()=>{window.ev=[];window.chunks=0;window.orbit.onVoice(e=>{if(e.type==='audio')window.chunks++;else window.ev.push(e)});return window.orbit.voiceStart(true)});
async function feed(path){const w=readWave(path);const a=new Float32Array(w.samples.length+16000);a.set(w.samples);for(let i=0;i<a.length;i+=640){const b=Buffer.alloc(1280);for(let j=0;j<640;j++)b.writeInt16LE(Math.round((a[i+j]||0)*32767),j*2);await page.evaluate(data=>window.orbit.voiceAudio(new Uint8Array(data)),[...b]);await new Promise(r=>setTimeout(r,40));}}
await feed(process.argv[2]);await page.waitForFunction(()=>window.ev.some(e=>e.type==='state'&&e.state==='listening'),{},{timeout:15000});await feed(process.argv[3]);
await page.waitForFunction(()=>window.ev.some(e=>e.type==='transcript'&&e.role==='assistant'),{},{timeout:15000});console.log(await page.evaluate(()=>({events:window.ev,audioChunks:window.chunks})));}
finally{if(app)await app.close();await rm(dir,{recursive:true,force:true})}
