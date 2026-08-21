/**
 * The install story: the downloadable iOS file and the page that offers it.
 *
 * Two facts here are load-bearing and invisible to every other test:
 *
 *  1. The .mobileconfig must be a valid WebClip profile whose icon is the
 *     committed 180px PNG byte-for-byte and whose URL is the permanent Pages
 *     address — a profile pointing at a tunnel domain would die with the
 *     tunnel, silently, on every phone that installed it.
 *
 *  2. The host must serve it as application/x-apple-aspen-config. Safari
 *     only opens the profile installer for that exact type; GitHub Pages
 *     serves .mobileconfig as octet-stream, which is why the install page
 *     retargets its download button at the live host at all. If this header
 *     regresses, the button quietly downgrades to a file-in-Files detour and
 *     no test elsewhere would notice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const SITE = resolve(ROOT, '../site');
// Not a fixed port: test files run in parallel workers, and the fixed-port
// suites already collide with each other (5343 is claimed twice elsewhere).
let BASE = '';

/** A port nothing is listening on, from the only authority on that. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const profile = readFileSync(join(SITE, 'endernet.mobileconfig'), 'utf8');

describe('the downloadable iOS install file', () => {
  it('is a WebClip profile aimed at the permanent address, opening full-screen', () => {
    expect(profile).toContain('<string>com.apple.webClip.managed</string>');
    expect(profile).toContain('<string>https://enderpeer.github.io/peer-network-lab/app.html</string>');
    // FullScreen is what makes the icon an app rather than a bookmark.
    expect(profile).toMatch(/<key>FullScreen<\/key>\s*<true\/>/);
    // People must be able to take it off again.
    expect(profile).toMatch(/<key>IsRemovable<\/key>\s*<true\/>/);
    expect(profile).toMatch(/<key>PayloadRemovalDisallowed<\/key>\s*<false\/>/);
    // Never the tunnel: the profile outlives every tunnel domain.
    expect(profile).not.toContain('trycloudflare');
  });

  it('embeds the committed 180px icon byte-for-byte', () => {
    const m = /<data>\s*([A-Za-z0-9+/=\s]+?)\s*<\/data>/.exec(profile);
    expect(m).toBeTruthy();
    const embedded = Buffer.from(m![1].replace(/\s+/g, ''), 'base64');
    const icon = readFileSync(join(SITE, 'icons', 'icon-180.png'));
    expect(embedded.equals(icon)).toBe(true);
  });

  it('is offered by the install page, which also probes for a live host', () => {
    const page = readFileSync(join(SITE, 'install.html'), 'utf8');
    expect(page).toContain('href="endernet.mobileconfig"');
    // The retargeting logic exists — without it the Pages MIME type quietly
    // breaks the one-tap install.
    expect(page).toContain("fetch('host.json'");
    expect(page).toContain('/endernet.mobileconfig');
  });

  it('is part of the offline shell alongside the pages that explain it', () => {
    const sw = readFileSync(join(SITE, 'sw.js'), 'utf8');
    expect(sw).toContain("'./install.html'");
  });
});

describe('the host door for the install file', () => {
  let child: ChildProcess;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-webclip-'));
    const PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
    child = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(PORT)], {
      cwd: ROOT,
      env: { ...process.env, PEER_DATA_DIR: join(dir, 'server-data') },
      stdio: 'ignore',
    });
    for (let i = 0; i < 60; i++) {
      try { await fetch(BASE + '/api/acts'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error('host did not come up');
  }, 20000);

  afterAll(() => {
    child?.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file locks */ }
  });

  it('serves the profile with the MIME type Safari requires', async () => {
    const r = await fetch(BASE + '/endernet.mobileconfig');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/x-apple-aspen-config');
    expect(await r.text()).toBe(profile);
  });
});
