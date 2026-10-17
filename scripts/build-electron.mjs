import { build } from 'esbuild';

await build({
  entryPoints: { main: 'src/desktop/main.ts', preload: 'src/desktop/preload.ts' },
  outdir: 'dist-electron', outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron'], sourcemap: true,
});

// Pi is ESM and ships runtime resources. Keep it as an installed dependency in its worker.
await build({
  entryPoints: ['src/desktop/agent-worker.ts'], outfile: 'dist-electron/agent-worker.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  packages: 'external', sourcemap: true,
});
