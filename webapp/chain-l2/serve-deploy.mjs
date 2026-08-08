// Serve deploy.html over http://localhost so a wallet extension will talk to it.
//
// MetaMask does not inject its provider into file:// pages — Firefox gates
// file-URL access behind a permission the extension does not ask for, so
// `window.ethereum` is simply undefined there and the page correctly reports
// that it found no wallet. Any http origin fixes it, including this one.
//
// Deliberately the smallest possible server: one directory, GET only, no
// dependency, and it binds 127.0.0.1 rather than 0.0.0.0 so nothing outside
// this machine can reach a page whose whole job is to start a transaction.
//
//   node chain-l2/serve-deploy.mjs      then open http://127.0.0.1:8899/

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DEPLOY_PORT || 8899);
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.sol': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

const server = createServer((req, res) => {
  if (req.method !== 'GET') { res.writeHead(405); res.end('GET only'); return; }
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/' || path === '') path = '/deploy.html';
  // Contain it to this directory: normalise, then refuse anything that climbs.
  const rel = normalize(path).replace(/^([/\\])+/, '');
  if (rel.includes('..')) { res.writeHead(403); res.end('no'); return; }
  const file = join(here, rel);
  if (!file.startsWith(here) || !existsSync(file)) { res.writeHead(404); res.end('not here'); return; }
  const ext = (file.match(/\.[a-z]+$/) || [''])[0];
  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
});

server.on('error', (e) => {
  console.error(e && e.code === 'EADDRINUSE'
    ? `port ${PORT} is taken — something is already serving. Try DEPLOY_PORT=8900 node chain-l2/serve-deploy.mjs`
    : 'could not listen: ' + (e && e.message));
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`deploy page: http://127.0.0.1:${PORT}/`);
  console.log('open that in the browser where MetaMask lives. Ctrl-C to stop.');
});
