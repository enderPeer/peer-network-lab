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

  it('draws a bet: its pool, its jury, and a settled one', async () => {
    // The archive path is the only way to hand the built page an arbitrary
    // log, which is what a market needs: four accounts, an asset to stake,
    // and bets in every state a reader can meet one in.
    const day = 24 * 60 * 60 * 1000;
    const who = ['ann', 'ben', 'cal', 'dee'];
    const acts: Record<string, unknown>[] = [];
    who.forEach((n, i) => {
      acts.push({ t: 'register', id: 'u_' + n, handle: n, seed: 1, epoch: 0 });
      acts.push({ t: 'btcBurn', id: 'u_' + n, sats: 30000, addr: 'bc1qdead',
        txid: String(i + 1).repeat(64).slice(0, 64) });
    });
    acts.push({ t: 'assetCreate', author: 'u_ann', sym: 'CHIP', name: 'table stakes', supply: 1000 });
    for (const n of who.slice(1)) acts.push({ t: 'tokenSend', author: 'u_ann', sym: 'CHIP', to: 'u_' + n, amt: 200 });
    // c1: open, with money on it and an elected jury of one
    acts.push({ t: 'market', author: 'u_ann', text: 'will it rain on the parade?',
      opts: ['rain', 'shine'], cur: 'CHIP', at: Date.now() + day, seats: 1, bond: 5, feeBp: 200,
      mods: ['u_cal'] });
    acts.push({ t: 'bet', author: 'u_ben', cid: 'c1', opt: 0, amt: 50 });
    acts.push({ t: 'modStand', author: 'u_cal', cid: 'c1', on: true });
    acts.push({ t: 'modVote', author: 'u_ben', cid: 'c1', for: ['u_cal'] });
    // c2: certified and paid out
    acts.push({ t: 'market', author: 'u_ann', text: 'did the ferry sail?',
      opts: ['yes', 'no'], cur: 'CHIP', at: Date.now() + day, seats: 1, bond: 5, feeBp: 200 });
    acts.push({ t: 'bet', author: 'u_ben', cid: 'c2', opt: 1, amt: 20 });
    acts.push({ t: 'modStand', author: 'u_dee', cid: 'c2', on: true });
    acts.push({ t: 'attest', author: 'u_dee', cid: 'c2', opt: 1 });

    const body = acts.map((a) => JSON.stringify(a)).map((line) => line + '\n').join('');
    const serve = (url: string) => {
      const u = String(url);
      if (u.includes('archive/manifest.json')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ acts: acts.length, sha256: 'x'.repeat(64), at: Date.now() }) });
      }
      if (u.includes('archive/acts.jsonl')) return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
      return Promise.reject(new Error('offline'));
    };

    const { dom, errors, root } = await boot({
      'peer-sandbox-who-v2': JSON.stringify('u_ben'),
      'peer-sandbox-mode-v1': JSON.stringify('geek'),
      'peer-sandbox-view-v1': JSON.stringify({ tab: 'feed', lqView: 'feed' }),
    }, serve);
    expect(errors, 'a bet card threw: ' + errors.join(' | ')).toEqual([]);
    const text = root!.textContent ?? '';
    expect(text, 'the open bet did not draw').toMatch(/will it rain on the parade\?/);
    expect(text, 'no pool on the card').toMatch(/pool50.000000 CHIP/);
    expect(text, 'the jury is not on the card').toMatch(/seat\(s\)/);
    expect(text, 'the reader cannot see their own position').toMatch(/your position/i);
    expect(text, 'a settled bet does not say so').toMatch(/Certified as .no./);
    expect(text, 'the payout is not shown').toMatch(/you were paid/i);
    // The wall is stated on every card, because this is the screen where
    // somebody is most likely to assume money is buying them something else.
    expect(text).toMatch(/no part of this bet appends an edge/i);

    // …and the composer can ask one.
    const kindBtn = Array.from(root!.querySelectorAll('.uline button'))
      .find((b) => (b.textContent ?? '').trim() === 'Bet');
    expect(kindBtn, 'no Bet kind in the composer').toBeTruthy();
    (kindBtn as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(errors, 'the bet composer threw: ' + errors.join(' | ')).toEqual([]);
    const placeholders = Array.from(root!.querySelectorAll('input'))
      .map((i) => (i as HTMLInputElement).placeholder);
    expect(placeholders, 'no answer fields').toContain('answer 1');
    expect(placeholders).toContain('bond per seat');
    dom.window.close();
  }, 30000);

  it('draws every economy sub-tab without throwing', async () => {
    // The economy screen holds four unrelated jobs now. Each is a place the
    // app can go blank on its own.
    // 'net' joined them when the graph stopped being a tab of its own: it is a
    // way of looking at the economy, and eight tabs never fitted a phone.
    for (const view of ['wallet', 'net', 'pools', 'layer0', 'ledger']) {
      const { dom, errors, root } = await boot({
        'peer-sandbox-who-v2': JSON.stringify('alice'),
        'peer-sandbox-mode-v1': JSON.stringify('geek'),
        'peer-sandbox-view-v1': JSON.stringify({ tab: 'econ', lqView: 'feed', econView: view }),
      });
      expect(errors, 'the ' + view + ' view threw: ' + errors.join(' | ')).toEqual([]);
      expect(root!.querySelectorAll('.lane').length, 'no sub-tab bar in ' + view).toBe(5);
      expect(root!.textContent!.length, 'the ' + view + ' view rendered nothing').toBeGreaterThan(400);
      dom.window.close();
    }
  }, 40000);

  it('draws the chat tab over a world that has timestamps', async () => {
    // The sandbox seed carries no `ts` at all, so every "how long ago" path in
    // the app short-circuits and is never executed by the other tests. That is
    // exactly how a call to a function that did not exist survived a green
    // suite and then threw on the live network, taking the whole page with it.
    // This boots a world WITH stamps and opens the surface that uses them.
    const now = Date.now();
    const acts = [
      { t: 'register', id: 'u_p', handle: 'Pat', seed: 1, epoch: 0, ts: now - 86400000 },
      { t: 'register', id: 'u_q', handle: 'Quinn', seed: 1, epoch: 0, ts: now - 80000000 },
      { t: 'burn', id: 'u_p', amt: 1, ts: now - 70000000 },
      { t: 'burn', id: 'u_q', amt: 1, ts: now - 60000000 },
      { t: 'post', author: 'u_p', text: 'a stamped post', a: 0.8, rmen: [], ts: now - 50000 },
      { t: 'dm', from: 'u_p', to: 'u_q', text: 'a stamped message', ts: now - 40000 },
    ];
    const NL = String.fromCharCode(10);
    const body = acts.map((a) => JSON.stringify(a)).join(NL) + NL;
    const serve = (url: string) => {
      const u = String(url);
      if (u.includes('archive/manifest.json')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ acts: acts.length, sha256: 'x'.repeat(64), at: now }) });
      }
      if (u.includes('archive/acts.jsonl')) return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
      return Promise.reject(new Error('offline'));
    };

    const { dom, errors, root } = await boot({
      'peer-sandbox-who-v2': JSON.stringify('u_p'),
      'peer-sandbox-mode-v1': JSON.stringify('geek'),
      'peer-sandbox-view-v1': JSON.stringify({ tab: 'chat', lqView: 'feed' }),
    }, serve);
    expect(errors, 'the chat tab threw over a stamped world: ' + errors.join(' | ')).toEqual([]);

    // ...and the same for every conversation on the network, which is a
    // different code path and the one that reads the stamps.
    const everyone = [...root!.querySelectorAll('.lane')].find((b) => /Everyone/.test(b.textContent || ''));
    expect(everyone, 'no "Everyone" scope in the chat tab').toBeTruthy();
    (everyone as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 400));
    expect(errors, 'browsing every conversation threw: ' + errors.join(' | ')).toEqual([]);
    expect(root!.textContent, 'the public-chat warning must be on screen')
      .toMatch(/Everyone on this network can read and search every conversation/);
    dom.window.close();
  }, 30000);

  it('plays several tracks on one post as one playlist, and shows a picture from the archive', async () => {
    // Three things at once, because they share one path and one bug would hide
    // the others:
    //   - N audio entries render ONE player, not N. The old code mapped over
    //     the entries and appended a separate <audio> for each, so every track
    //     on a post could play at the same time as every other.
    //   - a profile picture appears beside the handle, through avatar(), which
    //     had to start taking the id before it could look anything up.
    //   - both resolve to archive/media/<hash> when no host answers. They used
    //     to resolve to /api/media/<hash> on the page's own origin, which on
    //     static hosting is a 404 by construction.
    const now = Date.now();
    const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), P = 'd'.repeat(64);
    const acts = [
      { t: 'register', id: 'u_m', handle: 'Mel', seed: 1, epoch: 0, ts: now - 90000000 },
      { t: 'burn', id: 'u_m', amt: 1, ts: now - 80000000 },
      { t: 'profile', id: 'u_m', bio: 'makes records', link: '', pic: P, ts: now - 70000 },
      { t: 'post', author: 'u_m', text: 'an album', a: 0.8, rmen: [], ts: now - 60000, media: [
        { h: A, m: 'audio/mpeg', n: 'First light', s: 3_000_000 },
        { h: B, m: 'audio/mpeg', n: 'Second wind', s: 4_100_000 },
        { h: C, m: 'audio/mpeg', n: 'Third rail', s: 2_200_000 },
      ] },
    ];
    const NL = String.fromCharCode(10);
    const body = acts.map((a) => JSON.stringify(a)).join(NL) + NL;
    const serve = (url: string) => {
      const u = String(url);
      if (u.includes('archive/manifest.json')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ acts: acts.length, sha256: 'x'.repeat(64), at: now, media: true }) });
      }
      if (u.includes('archive/acts.jsonl')) return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
      return Promise.reject(new Error('offline'));
    };

    const { dom, errors, root } = await boot({
      'peer-sandbox-who-v2': JSON.stringify('u_m'),
      'peer-sandbox-mode-v1': JSON.stringify('geek'),
      'peer-sandbox-view-v1': JSON.stringify({ tab: 'feed', lqView: 'feed' }),
    }, serve);
    expect(errors, 'a multi-track post threw: ' + errors.join(' | ')).toEqual([]);

    const players = root!.querySelectorAll('audio');
    expect(players.length, 'three tracks must be one player, not three').toBe(1);
    const rows = root!.querySelectorAll('.track-row');
    expect(rows.length, 'no track list').toBe(3);
    expect(root!.textContent).toContain('First light');
    expect(root!.textContent).toContain('Third rail');
    // The sizes come from `s` in the record — a number the host measured
    // against its own disk, not one the composer sent. Mebibytes, matching
    // every other size this codebase prints.
    expect(root!.textContent).toContain('3.9 MB');
    // Track one is selected and pointed at the published copy.
    expect(players[0].getAttribute('src')).toBe('archive/media/' + A);
    expect(rows[0].className).toContain('on');

    const pic = root!.querySelector('.ava-img') as HTMLImageElement | null;
    expect(pic, 'no profile picture beside the handle').not.toBeNull();
    expect(pic!.getAttribute('src')).toBe('archive/media/' + P);

    dom.window.close();
  }, 30000);

  it('shows an album with its cover, and a person’s music on their page', async () => {
    // Two claims at once, because they share one path:
    //   - a marked image renders as ALBUM ART inside the player, and does NOT
    //     also render as an ordinary picture below it. Nothing that counts
    //     players or track rows would catch that duplicate.
    //   - a person’s page lists what they released and plays all of it from
    //     ONE player — a player per release downloads the whole catalogue on
    //     open, which is the failure audioPlaylist was written to kill.
    const now = Date.now();
    const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
    const SLEEVE = 'd'.repeat(64), PHOTO = 'e'.repeat(64);
    const acts = [
      { t: 'register', id: 'u_m', handle: 'Mel', seed: 1, epoch: 0, ts: now - 90000000 },
      { t: 'register', id: 'u_v', handle: 'Vic', seed: 1, epoch: 0, ts: now - 89000000 },
      { t: 'burn', id: 'u_m', amt: 1, ts: now - 80000000 },
      { t: 'burn', id: 'u_v', amt: 1, ts: now - 80000000 },
      { t: 'post', author: 'u_m', text: 'Second Wind — an EP', a: 0.8, rmen: [], ts: now - 60000, media: [
        { h: SLEEVE, m: 'image/jpeg', n: 'sleeve.jpg', s: 21000, cv: 1 },
        { h: A, m: 'audio/mpeg', n: 'First light', s: 3000000 },
        { h: B, m: 'audio/mpeg', n: 'Second wind', s: 4100000 },
        { h: PHOTO, m: 'image/jpeg', n: 'in the studio.jpg', s: 90000 },
      ] },
      { t: 'post', author: 'u_m', text: 'a single', a: 0.8, rmen: [], ts: now - 30000, media: [
        { h: C, m: 'audio/mpeg', n: 'Third rail', s: 2200000 },
      ] },
    ];
    const NL = String.fromCharCode(10);
    const body = acts.map((a) => JSON.stringify(a)).join(NL) + NL;
    const serve = (url: string) => {
      const u = String(url);
      if (u.includes('archive/manifest.json')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ acts: acts.length, sha256: 'x'.repeat(64), at: now, media: true }) });
      }
      if (u.includes('archive/acts.jsonl')) return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
      return Promise.reject(new Error('offline'));
    };

    // ── the feed card ────────────────────────────────────────────────────
    const geek = await boot({
      'peer-sandbox-who-v2': JSON.stringify('u_v'),
      'peer-sandbox-mode-v1': JSON.stringify('geek'),
      'peer-sandbox-view-v1': JSON.stringify({ tab: 'feed', lqView: 'feed', feedMode: 'new' }),
    }, serve);
    expect(geek.errors, 'the feed threw over an album: ' + geek.errors.join(' | ')).toEqual([]);
    const art = geek.root!.querySelectorAll('.album-art');
    expect(art.length, 'no cover art on the card').toBe(1);
    expect((art[0] as HTMLImageElement).getAttribute('src')).toBe('archive/media/' + SLEEVE);
    // The sleeve is inside the player, and the OTHER image is not.
    expect(art[0].closest('.audio-wrap'), 'the cover is not inside the player').not.toBeNull();
    const plain = [...geek.root!.querySelectorAll('img.post-media')].map((i) => i.getAttribute('src'));
    expect(plain, 'the sleeve was drawn a second time as a plain picture')
      .toEqual(['archive/media/' + PHOTO]);
    expect(geek.root!.textContent).toContain('Second Wind');

    // ── the person page ──────────────────────────────────────────────────
    // The Profile button ON THE CARD, not the one in the account rail — that
    // one opens the editor for your own description and cost one false failure.
    const card = [...geek.root!.querySelectorAll('.post')]
      .find((c) => /Second Wind/.test(c.textContent || ''));
    expect(card, 'no album card in the feed').toBeTruthy();
    const profBtn = [...card!.querySelectorAll('button')]
      .find((b) => b.textContent === 'Profile');
    expect(profBtn, 'no way into a profile from a post card').toBeTruthy();
    (profBtn as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 400));
    const drawer = geek.dom.window.document.querySelector('.drawer');
    expect(drawer, 'no profile drawer').not.toBeNull();
    expect(drawer!.textContent, 'the drawer does not say what they released')
      .toMatch(/2 releases carrying audio, 3 tracks/);
    expect(drawer!.querySelectorAll('audio').length, 'a catalogue must be ONE player').toBe(1);
    expect(drawer!.querySelectorAll('.release-row').length).toBe(2);
    expect(drawer!.querySelectorAll('.track-row').length, 'all three tracks in one list').toBe(3);
    // Both releases are named, not just counted — the claim is that the page
    // lists what they RELEASED, and a count alone would pass over one title
    // shown twice. ('what they published' was the deleted mode's heading.)
    const titles = [...drawer!.querySelectorAll('.release-row')].map((r) => r.textContent || '');
    expect(titles.some((t) => /Second Wind/.test(t)), 'the EP is not listed').toBe(true);
    expect(titles.some((t) => /single/i.test(t)), 'the single is not listed').toBe(true);
    geek.dom.window.close();
  }, 40000);

  it('hangs each release’s own sleeve over its own tracks', async () => {
    // A catalogue is not an album. One player over several releases used to
    // show the newest sleeve that existed over every other release's music,
    // and it never changed as the tape advanced — art belonging to one record
    // presented as the art of another, for most of the tracks on the page.
    const now = Date.now();
    const OLD_ART = '1'.repeat(64), NEW_ART = '2'.repeat(64);
    const T1 = '3'.repeat(64), T2 = '4'.repeat(64), T3 = '5'.repeat(64);
    const acts = [
      { t: 'register', id: 'u_m', handle: 'Mel', seed: 1, epoch: 0 },
      { t: 'register', id: 'u_v', handle: 'Vic', seed: 1, epoch: 0 },
      { t: 'burn', id: 'u_m', amt: 1 }, { t: 'burn', id: 'u_v', amt: 1 },
      { t: 'post', author: 'u_m', text: 'Debut EP', a: 0.8, rmen: [], ts: now - 900000, media: [
        { h: OLD_ART, m: 'image/jpeg', n: 'debut.jpg', s: 21000, cv: 1 },
        { h: T1, m: 'audio/mpeg', n: 'Opener', s: 1000 },
        { h: T2, m: 'audio/mpeg', n: 'Closer', s: 1000 },
      ] },
      { t: 'post', author: 'u_m', text: 'Later Single', a: 0.8, rmen: [], ts: now - 60000, media: [
        { h: NEW_ART, m: 'image/jpeg', n: 'later.jpg', s: 21000, cv: 1 },
        { h: T3, m: 'audio/mpeg', n: 'Latest', s: 1000 },
      ] },
    ];
    const NL = String.fromCharCode(10);
    const body = acts.map((a) => JSON.stringify(a)).join(NL) + NL;
    const serve = (url: string) => {
      const u = String(url);
      if (u.includes('archive/manifest.json')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ acts: acts.length, sha256: 'x'.repeat(64), at: now, media: true }) });
      }
      if (u.includes('archive/acts.jsonl')) return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
      return Promise.reject(new Error('offline'));
    };

    // feedMode 'new' so the album card is findable by append order rather
    // than by whatever L1 happens to rank first over two posts by one author.
    const { dom, errors, root } = await boot({
      'peer-sandbox-who-v2': JSON.stringify('u_v'),
      'peer-sandbox-view-v1': JSON.stringify({ tab: 'feed', feedMode: 'new' }),
    }, serve);
    expect(errors, errors.join(' | ')).toEqual([]);
    const card = [...root!.querySelectorAll('.post')]
      .find((c) => /Later Single/.test(c.textContent || ''));
    expect(card, 'no release card in the feed').toBeTruthy();
    const profBtn = [...card!.querySelectorAll('button')].find((b) => b.textContent === 'Profile');
    expect(profBtn, 'no way into a profile from a post card').toBeTruthy();
    (profBtn as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 500));
    expect(errors, 'opening a person threw: ' + errors.join(' | ')).toEqual([]);

    // The drawer is appended to #overlay, which is OUTSIDE #root — reading
    // this from `root` returns null and fails as a bare TypeError.
    const drawer = dom.window.document.querySelector('.drawer');
    expect(drawer, 'no profile drawer').not.toBeNull();
    const player = drawer!.querySelector('.audio-wrap.playlist')!;
    const art = () => (player.querySelector('.album-art') as HTMLImageElement).getAttribute('src');
    const title = () => (player.querySelector('.album-title') as HTMLElement).textContent;
    const rows = player.querySelectorAll('.track-row');
    expect(rows.length).toBe(3);

    // Newest first: the single, then the EP's two tracks. Advance the tape by
    // clicking a TRACK row — clicking a release row clears the overlay and
    // jumps, which would destroy the drawer this player lives in.
    expect(art()).toBe('archive/media/' + NEW_ART);
    expect(title()).toBe('Later Single');
    // ...and the numbering is per release, not per catalogue.
    expect([...rows].map((r) => r.querySelector('.track-no')!.textContent)).toEqual(['1', '1', '2']);

    (rows[1] as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 300));
    expect(art(), 'the sleeve did not follow the track').toBe('archive/media/' + OLD_ART);
    expect(title()).toBe('Debut EP');

    // And it must never claim one post recorded this order.
    expect(player.textContent).toContain('3 tracks from 2 releases, newest first');
    expect(player.textContent).not.toContain('the order the post recorded them');
    dom.window.close();
  }, 30000);

  it('lands a browser saved on a deleted tab somewhere real', async () => {
    // Live, Events and Guide were tabs until the composer made two of them
    // unnecessary and the profile took the third. Anybody who was last sitting
    // on one has that name in localStorage, and an unknown tab must fall
    // through to a screen with something on it — not to a blank shell.
    for (const stale of ['live', 'events', 'guide', 'net', 'ledger']) {
      const { dom, errors, root } = await boot({
        'peer-sandbox-who-v2': JSON.stringify('alice'),
        'peer-sandbox-mode-v1': JSON.stringify('geek'),
        'peer-sandbox-view-v1': JSON.stringify({ tab: stale, lqView: 'feed' }),
      });
      expect(errors, `a saved '${stale}' tab threw: ` + errors.join(' | ')).toEqual([]);
      expect(root!.textContent!.length, `a saved '${stale}' tab rendered nothing`).toBeGreaterThan(600);
      // ...and it lands on the feed, with the feed's own button lit.
      const lit = [...root!.querySelectorAll('.topbar .tabs button.on')].map((b) => b.textContent);
      expect(lit, `a saved '${stale}' tab lit the wrong button`).toEqual(['Feed']);
      dom.window.close();
    }
  }, 40000);

  it('the profile carries your events, your music and the guide', async () => {
    // The two deleted screens each had exactly one job nothing else did:
    // 'what am I going to' and 'what was I invited to'. The feed cannot answer
    // either — an rsvp appends no edge, so a gathering somebody PAID to enter
    // still ranks at zero and never appears. If the profile does not carry
    // these lanes, being invited becomes invisible in the whole app.
    const now = Date.now();
    const acts = [
      { t: 'register', id: 'u_h', handle: 'Host', seed: 1, epoch: 0 },
      { t: 'register', id: 'u_g', handle: 'Guest', seed: 1, epoch: 0 },
      ...Array.from({ length: 4 }, () => ({ t: 'burn', id: 'u_h', amt: 1 })),
      ...Array.from({ length: 4 }, () => ({ t: 'burn', id: 'u_g', amt: 1 })),
      // one with no time on it at all — the real network's only gathering is
      // like this, and reading at:0 as 'happened in 1970' empties the screen
      { t: 'event', author: 'u_h', text: 'A gathering with no date', at: 0, place: 'somewhere', fee: 0, cur: '', cap: 0 },
      { t: 'event', author: 'u_h', text: 'Next month', at: now + 30 * 86400000, place: 'here', fee: 0, cur: '', cap: 0 },
      { t: 'event', author: 'u_h', text: 'Already happened', at: now - 30 * 86400000, place: 'there', fee: 0, cur: '', cap: 0 },
      { t: 'post', author: 'u_h', text: 'a track', a: 0.8, rmen: [], media: [{ h: 'a'.repeat(64), m: 'audio/mpeg', n: 'Song', s: 1000 }] },
    ];
    const NL = String.fromCharCode(10);
    const body = acts.map((a) => JSON.stringify(a)).join(NL) + NL;
    const serve = (url: string) => {
      const u = String(url);
      if (u.includes('archive/manifest.json')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ acts: acts.length, sha256: 'x'.repeat(64), at: now, media: true }) });
      }
      if (u.includes('archive/acts.jsonl')) return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
      return Promise.reject(new Error('offline'));
    };

    const { dom, errors, root } = await boot({
      'peer-sandbox-who-v2': JSON.stringify('u_h'),
      'peer-sandbox-mode-v1': JSON.stringify('geek'),
      'peer-sandbox-view-v1': JSON.stringify({ tab: 'profile', lqView: 'feed', eventView: 'soon' }),
    }, serve);
    expect(errors, 'the profile threw: ' + errors.join(' | ')).toEqual([]);
    const text = root!.textContent ?? '';

    expect(text, 'no events section').toContain('your events');
    // Scoped to the lanes, not the page: 'what you published' below lists
    // every post including the past event, and a whole-page assertion would
    // pass or fail for the wrong reason.
    const lanes = () => root!.querySelector('.your-events')!.textContent ?? '';
    // 'Coming up' holds the dated future one AND the undated one, and not the
    // one that has already happened.
    expect(lanes()).toContain('Next month');
    expect(lanes()).toContain('A gathering with no date');
    expect(lanes()).not.toContain('Already happened');

    expect(text, 'no music on your own profile').toContain('release');
    expect(text, 'the guide did not come with it').toContain('the guide');
    // Scoped: the posts list below renders its own card, with its own player.
    expect(root!.querySelectorAll('.your-music audio').length, 'your catalogue must be one player').toBe(1);

    // Account controls live behind one Settings door now. The button must be
    // on the profile, and the drawer it opens must carry every control that
    // used to be in the folded 'account and security' block — a door that
    // opens onto half the room is worse than the fold it replaced.
    const settings = root!.querySelector('.settings-btn') as HTMLElement | null;
    expect(settings, 'no Settings button on the profile').toBeTruthy();
    settings!.click();
    await new Promise((r) => setTimeout(r, 300));
    const drawer = dom.window.document.querySelector('#overlay .drawer');
    expect(drawer, 'Settings opened no drawer').toBeTruthy();
    const sTxt = drawer!.textContent ?? '';
    for (const control of ['Edit profile', 'Set PIN', 'Recovery code', 'Delete account']) {
      expect(sTxt, control + ' is missing from Settings').toContain(control);
    }
    // Destructive actions are the only red in the app, and they say so.
    expect(drawer!.querySelector('.btn.danger')?.textContent, 'Delete account must carry the danger rank').toContain('Delete');
    (drawer!.querySelector('.btn.ghost') as HTMLElement).click(); // ← close
    await new Promise((r) => setTimeout(r, 200));

    // The Past lane, and the boundary that decides it.
    const past = [...root!.querySelectorAll('.uline button')].find((b) => b.textContent === 'Past');
    expect(past, 'no Past lane').toBeTruthy();
    (past as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 500));
    const after = root!.querySelector('.your-events')!.textContent ?? '';
    expect(after).toContain('Already happened');
    expect(after, 'an event with no time was filed under Past').not.toContain('A gathering with no date');
    dom.window.close();
  }, 40000);

  it('draws every geek tab without throwing', async () => {
    // One dead tab is the same outage in a smaller place.
    for (const tab of ['feed', 'chat', 'alerts', 'econ', 'profile']) {
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
