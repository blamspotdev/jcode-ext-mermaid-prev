// Production build for the Mermaid Preview extension.
// Type-checks with tsc, then bundles + minifies TypeScript/CSS into the deployable www/.
// `jext pack` runs this (npm run build) before packaging; www/ is the only output that ships.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

const OUT = 'www';
const win = process.platform === 'win32';

// 1. Type-check (fails the build on any TS error — this is a production build).
const tc = spawnSync('npx', ['tsc', '--noEmit'], { stdio: 'inherit', shell: win });
if (tc.status !== 0) process.exit(tc.status || 1);

// 2. Fresh output dir.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 3. Bundle + minify the app (marked is bundled in) and styles.
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2019',
  legalComments: 'none',
  outfile: `${OUT}/main.js`,
});
await build({
  entryPoints: ['src/styles.css'],
  bundle: true,
  minify: true,
  outfile: `${OUT}/styles.css`,
});

// 4. Ship the HTML shell verbatim and the vendored Mermaid engine (kept out of the esbuild
//    graph — it is a self-contained 3.4 MB UMD bundle loaded via its own <script> tag, and is
//    also what JCode's built-in Markdown preview loads for inline fence rendering).
copyFileSync('src/index.html', `${OUT}/index.html`);
copyFileSync('vendor/mermaid.min.js', `${OUT}/mermaid.min.js`);

console.log('✓ built src/ → www/ (index.html, main.js, styles.css, mermaid.min.js)');
