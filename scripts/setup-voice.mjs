import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const name = 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20';
const dir = await mkdtemp(join(tmpdir(), 'orbit-wake-'));
try {
  const response = await fetch(`https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${name}.tar.bz2`);
  if (!response.ok) throw Error(`Download failed: ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(archive).digest('hex') !== '68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6') throw Error('Model checksum mismatch');
  await writeFile(join(dir, 'model.tar.bz2'), archive);
  execFileSync('tar', ['-xjf', join(dir, 'model.tar.bz2'), '-C', dir]);
  await mkdir('assets/voice', { recursive: true });
  for (const [to, from] of Object.entries({ 'encoder.onnx': 'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx', 'decoder.onnx': 'decoder-epoch-13-avg-2-chunk-16-left-64.onnx', 'joiner.onnx': 'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx', 'tokens.txt': 'tokens.txt' })) {
    await writeFile(`assets/voice/${to}`, await readFile(join(dir, name, from)));
  }
  console.log('Local wake model ready.');
} finally { await rm(dir, { recursive: true, force: true }); }
