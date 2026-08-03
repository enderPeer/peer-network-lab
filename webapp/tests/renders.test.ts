/**
 * Does the page actually draw?
 *
 * The build learned to parse every script block after a missing bracket
 * shipped a blank app. This is the next lesson from the same afternoon: a
 * *reference* to a function that does not exist is perfectly valid syntax, so
 * the parse gate passed it, every API answered, all 220 tests were green — and
 * the app rendered its top bar and then nothing, because the geek view threw a
 * ReferenceError inside a promise chain where no error handler could see it.
 *
 * Syntax proves the file is JavaScript. Only running it proves it is an
 * application. So this boots the built page in a real DOM, logs in, and
 * requires something to be on the screen.
 *
 * A first version of this file tried to find undefined identifiers by reading
 * the source with regexes. It reported ninety-three, every one of them prose
 * in a comment or a method in an object literal. Deleted: a check nobody can
 * trust is worse than no check, because it trains you to ignore it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const PAGE = resolve(__dirname, '../public/peer-social-preview.html');

/** Boot the built page offline, optionally already signed in. */
async function boot(seed: Record<string, string> = {}, fetchImpl?: (url: string) => Promise<unknown>) {
  const source = readFileSync(PAGE, 'utf8');
  const dom = new JSDOM(source, {
    runScripts: 'dangerously',
    url: 'https://peer.test/',
    pretendToBeVisual: true,
    beforeParse(win) {
      // No host, so the app falls back to its own in-browser copy of the
      // network: deterministic, and no sockets in a test.
      (win as unknown as { fetch: unknown }).fetch = fetchImpl
        ?? (() => Promise.reject(new Error('offline')));
      for (const [k, v] of Object.entries(seed)) win.localStorage.setItem(k, v);
    },
  });

  const errors: string[] = [];
  dom.window.addEventListener('error', (e) => errors.push(String((e as unknown as { message: string }).message)));
  dom.window.addEventListener('unhandledrejection', (e) =>
    errors.push(String((e as unknown as { reason: unknown }).reason)));
  // The app catches its own render errors in places, so also watch what it logs.
  const origErr = dom.window.console.error;
  dom.window.console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); origErr(...args); };

  await new Promise((r) => setTimeout(r, 1200));
  return { dom, errors, root: dom.window.document.getElementById('root') };
}

describe('the built page is an application, not just valid JavaScript', () => {
  beforeAll(() => {
    expect(existsSync(PAGE), 'run `npm run build:social` first').toBe(true);
  });

  it('draws the gate for a visitor', async () => {
    const { dom, errors, root } = await boot();
    expect(root, 'no #root').not.toBeNull();
    expect(errors, 'the page threw while rendering: ' + errors.join(' | ')).toEqual([]);
    expect(root!.children.length, 'empty shell').toBeGreaterThan(0);
    expect(root!.textContent!.length).toBeGreaterThan(200);
    dom.window.close();
  }, 20000);

  it('draws the signed-in geek view — the exact surface that went blank', async () => {
    // alice is a seedWorld actor: she exists with no register act and no PIN,
    // which makes her the one account a test can always sign in as.
    const { dom, errors, root } = await boot({
      'peer-sandbox-who-v2': JSON.stringify('alice'),
      'peer-sandbox-mode-v1': JSON.stringify('geek'),
      'peer-sandbox-view-v1': JSON.stringify({ tab: 'feed', lqView: 'feed' }),
    });
    expect(errors, 'the geek view threw: ' + errors.join(' | ')).toEqual([]);
    // The outage showed the top bar and nothing under it. Require the body:
    // the composer, the cards, and enough text that a shell cannot pass.
    // (The composer is asserted by element, not by its placeholder — that
    // lives in an attribute and never appears in textContent, which cost one
    // false failure while writing this.)
    expect(root!.querySelectorAll('textarea').length, 'no composer').toBeGreaterThan(0);
    expect(root!.querySelectorAll('.card').length, 'no cards below the top bar').toBeGreaterThan(3);
    expect((root!.textContent ?? '').length, 'almost nothing rendered').toBeGreaterThan(1000);
    dom.window.close();
  }, 20000);

  it('draws every feed lane without throwing', async () => {
    // Four ways into the same content. A dead lane is the blank-page outage in
    // a smaller place, and only running it proves the lane exists.
    for (const lane of ['all', 'reels', 'music', 'gallery']) {
      const { dom, errors, root } = await boot({
        'peer-sandbox-who-v2': JSON.stringify('alice'),
        'peer-sandbox-mode-v1': JSON.stringify('geek'),
        'peer-sandbox-view-v1': JSON.stringify({ tab: 'feed', lqView: 'feed', feedLane: lane }),
      });
      expect(errors, 'the ' + lane + ' lane threw: ' + errors.join(' | ')).toEqual([]);
      // the switcher is the way back out, so it must be on screen in every lane
      expect(root!.querySelectorAll('.lane').length, 'no lane switcher in ' + lane).toBe(4);
      expect(root!.textContent!.length, 'the ' + lane + ' lane rendered nothing').toBeGreaterThan(200);
      dom.window.close();
    }
  }, 40000);

  it('reads the published archive when no host answers', async () => {
    // The point of the archive: every machine can be switched off and the
    // record is still there, on hosting nobody pays for. A snapshot that does
    // not match its manifest must be refused rather than shown, because
    // everything computed from a truncated log would be wrong and silent.
    const acts = [
      { t: 'register', id: 'u_arch', handle: 'Archived', seed: 1, epoch: 0 },
      { t: 'burn', id: 'u_arch', amt: 1 },
      { t: 'post', author: 'u_arch', text: 'this survived every host dying', a: 0.8, rmen: [] },
    ];
    const body = acts.map((a2) => JSON.stringify(a2)).join('\n') + '\n';

    const serve = (manifestActs: number) => (url: string) => {
      const u = String(url);
      if (u.includes('archive/manifest.json')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ acts: manifestActs, sha256: 'x'.repeat(64), at: Date.now() }) });
      }
      if (u.includes('archive/acts.jsonl')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
      }
      return Promise.reject(new Error('offline'));   // no host answers
    };

    // Honest manifest: the archive loads and the network is readable.
    const good = await boot({}, serve(acts.length));
    expect(good.errors, good.errors.join(' | ')).toEqual([]);
    expect(good.root!.textContent, 'archive not loaded').toMatch(/reading a published archive/i);
    expect(good.root!.textContent).toMatch(/3 acts/);
    good.dom.window.close();

    // Manifest says four acts, the file has three: refuse it.
    const bad = await boot({}, serve(acts.length + 1));
    expect(bad.root!.textContent, 'a mismatched archive was shown as real')
      .not.toMatch(/reading a published archive/i);
    bad.dom.window.close();
  }, 30000);

  it('draws every economy sub-tab without throwing', async () => {
    // The economy screen holds four unrelated jobs now. Each is a place the
    // app can go blank on its own.
    for (const view of ['wallet', 'pools', 'layer0', 'ledger']) {
      const { dom, errors, root } = await boot({
        'peer-sandbox-who-v2': JSON.stringify('alice'),
        'peer-sandbox-mode-v1': JSON.stringify('geek'),
        'peer-sandbox-view-v1': JSON.stringify({ tab: 'econ', lqView: 'feed', econView: view }),
      });
      expect(errors, 'the ' + view + ' view threw: ' + errors.join(' | ')).toEqual([]);
      expect(root!.querySelectorAll('.lane').length, 'no sub-tab bar in ' + view).toBe(4);
      expect(root!.textContent!.length, 'the ' + view + ' view rendered nothing').toBeGreaterThan(400);
      dom.window.close();
    }
  }, 40000);

  it('draws every geek tab without throwing', async () => {
    // One dead tab is the same outage in a smaller place.
    for (const tab of ['feed', 'chat', 'alerts', 'net', 'live', 'econ', 'ledger', 'guide']) {
      const { dom, errors, root } = await boot({
        'peer-sandbox-who-v2': JSON.stringify('alice'),
        'peer-sandbox-mode-v1': JSON.stringify('geek'),
        'peer-sandbox-view-v1': JSON.stringify({ tab, lqView: 'feed' }),
      });
      expect(errors, `the ${tab} tab threw: ` + errors.join(' | ')).toEqual([]);
      expect(root!.textContent!.length, `the ${tab} tab rendered nothing`).toBeGreaterThan(300);
      dom.window.close();
    }
  }, 60000);
});
