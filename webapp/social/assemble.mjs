// Builds the self-contained social sandbox page:
//   1. esbuild-bundles the engine as an IIFE global (PeerEngine)
//   2. inlines it into template.html at the /*__ENGINE__*/ marker
//   3. inlines social/replay.cjs at /*__REPLAY__*/ — the SAME file the host
//      imports, so the page and the bot API can never disagree about state
//   4. emits public/peer-engine.mjs, the engine as a Node module for the host
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

// The host needs the engine too (for the bot API's server-side replay). Same
// sources, Node target — one engine, two consumers.
const nodeBundle = await build({
  entryPoints: [resolve(here, '../src/engine/bundle-entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const enginePath = resolve(here, '../public/peer-engine.mjs');
mkdirSync(dirname(enginePath), { recursive: true });
writeFileSync(enginePath, nodeBundle.outputFiles[0].text, 'utf8');

// .cjs so the host can require() it unambiguously (this package is type:module);
// the page just inlines its text, so the extension is irrelevant there.
const replay = readFileSync(resolve(here, 'replay.cjs'), 'utf8');
if (replay.includes('</script')) throw new Error('replay.cjs contains </script — cannot inline');

const template = readFileSync(resolve(here, 'template.html'), 'utf8');
if (!template.includes('/*__ENGINE__*/')) throw new Error('template marker missing');
if (!template.includes('/*__REPLAY__*/')) throw new Error('replay marker missing');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, template
  .replace('/*__ENGINE__*/', () => engine)
  .replace('/*__REPLAY__*/', () => replay), 'utf8');
console.log('wrote', out, '(engine', engine.length, '+ replay', replay.length, 'bytes)');
console.log('wrote', enginePath, '(node engine', nodeBundle.outputFiles[0].text.length, 'bytes)');
