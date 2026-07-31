// Builds the self-contained social sandbox page:
//   1. esbuild-bundles the engine as an IIFE global (PeerEngine)
//   2. inlines it into template.html at the /*__ENGINE__*/ marker
// Usage: node social/assemble.mjs [outFile]
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? resolve(here, '../public/peer-social-preview.html'));

const bundle = await build({
  entryPoints: [resolve(here, '../src/engine/bundle-entry.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'PeerEngine',
  minify: true,
  write: false,
});
const engine = bundle.outputFiles[0].text;
if (engine.includes('</script')) throw new Error('engine bundle contains </script — cannot inline');

const template = readFileSync(resolve(here, 'template.html'), 'utf8');
if (!template.includes('/*__ENGINE__*/')) throw new Error('template marker missing');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, template.replace('/*__ENGINE__*/', () => engine), 'utf8');
console.log('wrote', out, '(engine', engine.length, 'bytes)');
