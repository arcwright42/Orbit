import { build } from 'esbuild';

await build({
  entryPoints: { main: 'src/desktop/main.ts', preload: 'src/desktop/preload.ts' },
  outdir: 'dist-electron', outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai/*'], sourcemap: true,
});
