import { build } from 'esbuild';
import { copyFileSync, mkdirSync, existsSync } from 'fs';

const outdir = 'dist';
if (!existsSync(outdir)) mkdirSync(outdir);

await build({
  entryPoints: ['src/content.ts'],
  outfile: `${outdir}/content.js`,
  bundle: true,
  format: 'iife',
  sourcemap: true,
  target: ['chrome110'],
});

copyFileSync('manifest.json', `${outdir}/manifest.json`);
try { copyFileSync('icon128.png', `${outdir}/icon128.png`); } catch {}
console.log('Built extension to dist/'); 