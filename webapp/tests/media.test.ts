/**
 * Several files on one post, a picture on a profile, and the bytes a device
 * keeps.
 *
 * These run against a real host on a throwaway data directory, because every
 * rule under test lives in the request path: the entry ceiling, the byte
 * total, the size a client claims against the size on disk, and what the
 * collector considers referenced. A copy of those rules would prove nothing.
 *
 * What each group is defending, in one line:
 *   - the playlist cap: `media.length > 2` was the single thing standing
 *     between this network and an album, and it answered 'bad media'.
 *   - the byte total: the entry count had been doing capacity work as a side
 *     effect. Twelve files at the per-file cap is 144 MB — half the instance.
 *   - `s`: a size shown to a reader before they download must be a number the
 *     host measured, never one the composer sent.
 *   - the profile picture: a new kind of media reference. The collector and
 *     the mirror both walked `a.media` and nothing else, so a picture under a
 *     new field would have been deleted an hour after upload and would have
 *     been permanently missing from the fallback host.
 *   - Range: the route answered 200 with the whole body to every request. A
 *     seek re-downloaded the track, and Safari refuses to play media at all
 *     from a source that will not answer 206.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const PORT = 5317;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = resolve(__dirname, '..');

let child: ChildProcess;
let dir: string;
let mediaDir: string;

const pinHash = (id: string, pin: string) => createHash('sha256').update(`${id}:${pin}`, 'utf8').digest('hex');

async function post(path: string, body: unknown) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}
const get = async (path: string) => (await fetch(BASE + path)).json() as Promise<Record<string, unknown>>;
const total = async () => (await get('/api/acts')).total as number;
const act = async (a: Record<string, unknown>) => post('/api/act', { ...a, since: await total() });

/** Put bytes in the store the way the app does, and get back what it gets. */
async function upload(bytes: Buffer, mime: string) {
  const r = await fetch(BASE + '/api/media', { method: 'POST', headers: { 'Content-Type': mime }, body: bytes });
  const body = (await r.json()) as { h: string; m: string; size: number; error?: string };
  // Fail loudly here rather than three assertions later. An upload that was
  // refused yields an entry with no hash, and every test downstream then reads
  // 'bad media entry' and blames the rule it was actually trying to check.
  if (!r.ok) throw new Error('upload refused (' + r.status + '): ' + body.error);
  return { status: r.status, body };
}
/** Distinct bytes per call: the store is content-addressed, so identical
 *  payloads would collapse to one blob and a 'twelve files' test would be a
 *  one-file test wearing a hat. */
let seq = 0;
const blob = (n = 64) => Buffer.concat([Buffer.from(`peer-test-${seq++}-`), Buffer.alloc(n, 7)]);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'peer-media-test-'));
  mediaDir = join(dir, 'server-data', 'media');
  mkdirSync(mediaDir, { recursive: true });
  writeFileSync(join(dir, 'server-data', 'acts.jsonl'), [
    { t: 'register', id: 'u_a', handle: 'Ayla', seed: 1, epoch: 0, pinHash: pinHash('u_a', '1234') },
    { t: 'register', id: 'u_b', handle: 'Bo', seed: 1, epoch: 0 },
    ...Array.from({ length: 8 }, () => ({ t: 'btcBurn', id: 'u_a', txid: '07588b0256a26c4ace258691cfe9ebbb3bf77828faf82142d4a4a7de5011fefa', sats: 10000, addr: 'bc1qdead' })),
    { t: 'btcBurn', id: 'u_b', txid: 'fc593ba831429fca8f864d7e66af8aabeff6538c05fe11b3e353198f614c98e5', sats: 10000, addr: 'bc1qdead' },
  ].map((a) => JSON.stringify(a)).join('\n') + '\n');

  child = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(PORT)], {
    cwd: ROOT,
    // Both limiters raised: this file uploads well over forty blobs in under a
    // minute, and a 429 masquerading as a validation result is exactly the kind
    // of green-looking failure these tests exist to prevent.
    env: { ...process.env, PEER_ACT_RATE: '400', PEER_MEDIA_RATE: '400', PEER_DATA_DIR: join(dir, 'server-data') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/api/acts'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('host did not come up');
}, 20000);

afterAll(() => {
  child?.kill();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('a post carries a playlist', () => {
  it('accepts twelve files on one post', async () => {
    const entries = [];
    for (let i = 0; i < 12; i++) {
      const up = await upload(blob(128), 'audio/mpeg');
      expect(up.status).toBe(200);
      entries.push({ h: up.body.h, m: 'audio/mpeg', n: `track ${i + 1}.mp3`, s: up.body.size });
    }
    const r = await act({ t: 'post', author: 'u_a', text: 'an album', a: 0.8, auth: '1234', media: entries });
    expect(r.status).toBe(200);
  });

  it('keeps all twelve, in the order they were sent', async () => {
    const d = await get('/api/acts');
    const acts = d.acts as Array<Record<string, unknown>>;
    const album = acts.filter((a) => a.t === 'post' && Array.isArray(a.media) && (a.media as unknown[]).length > 1).pop();
    const media = album!.media as Array<{ n: string }>;
    expect(media).toHaveLength(12);
    expect(media.map((m) => m.n)).toEqual(Array.from({ length: 12 }, (_, i) => `track ${i + 1}.mp3`));
  });

  it('refuses a thirteenth, and says both numbers', async () => {
    const entries = [];
    for (let i = 0; i < 13; i++) {
      const up = await upload(blob(64), 'audio/mpeg');
      entries.push({ h: up.body.h, m: 'audio/mpeg' });
    }
    const r = await act({ t: 'post', author: 'u_a', text: 'one too many', a: 0.8, auth: '1234', media: entries });
    expect(r.status).toBe(400);
    // A refusal that says 'bad media' sends an author deleting text to fix an
    // attachment problem. It has to name the ceiling and what was sent.
    expect(r.body.error).toContain('12');
    expect(r.body.error).toContain('13');
  });

  it('refuses a size the client made up, and says both figures', async () => {
    const up = await upload(blob(300), 'audio/mpeg');
    const r = await act({
      t: 'post', author: 'u_a', text: 'a small lie', a: 0.8, auth: '1234',
      media: [{ h: up.body.h, m: 'audio/mpeg', s: 99_999_999 }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('99999999');
    expect(r.body.error).toContain(String(up.body.size));
  });

  it('accepts the size the host itself measured', async () => {
    const up = await upload(blob(512), 'audio/mpeg');
    const r = await act({
      t: 'post', author: 'u_a', text: 'an honest one', a: 0.8, auth: '1234',
      media: [{ h: up.body.h, m: 'audio/mpeg', s: up.body.size }],
    });
    expect(r.status).toBe(200);
  });
});

describe('a profile carries a picture', () => {
  let picHash = '';

  it('stores it, and the field survives sanitize', async () => {
    // sanitize is a hard whitelist that deletes unlisted keys and still answers
    // 200. A picture missing from ACT_FIELDS would leave somebody told
    // 'Profile saved.' with nothing saved at all.
    const up = await upload(blob(200), 'image/jpeg');
    picHash = up.body.h;
    const r = await act({ t: 'profile', id: 'u_a', bio: 'me', link: '', pic: picHash, auth: '1234' });
    expect(r.status).toBe(200);
    const d = await get('/api/acts');
    const acts = d.acts as Array<Record<string, unknown>>;
    const saved = acts.filter((a) => a.t === 'profile').pop();
    expect(saved!.pic).toBe(picHash);
  });

  it('refuses a hash nothing was uploaded for', async () => {
    const r = await act({ t: 'profile', id: 'u_a', bio: 'me', pic: 'a'.repeat(64), auth: '1234' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/upload first/i);
  });

  it('refuses bytes that are not an image', async () => {
    const up = await upload(blob(128), 'audio/mpeg');
    const r = await act({ t: 'profile', id: 'u_a', bio: 'me', pic: up.body.h, auth: '1234' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/image/i);
  });

  it('refuses an unresized photo, and names the ceiling', async () => {
    // The mark is 42 CSS px at its largest and is fetched beside every handle
    // on every screen. A phone photo in that slot is bytes paid for hundreds
    // of times over — so the host refuses it even though the post pipeline
    // would happily store the same file as an attachment.
    const up = await upload(Buffer.alloc(400 * 1024, 3), 'image/jpeg');
    expect(up.status).toBe(200);
    const r = await act({ t: 'profile', id: 'u_a', bio: 'me', pic: up.body.h, auth: '1234' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('256 KB');
  });

  it('the replay both sides run reports the picture', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const E = require('../public/peer-engine.mjs');
    const R = require('../social/replay.cjs').create(E.default ?? E);
    const d = await get('/api/acts');
    const st = R.replay([{ t: 'seedWorld' }, ...(d.acts as unknown[])]);
    expect(st.profiles.u_a.pic).toBe(picHash);
  });

  it('the collector does not eat it', async () => {
    // gcMedia unions every blob an act points at and unlinks the rest. It read
    // `a.media` only; a picture referenced by a profile act and nothing else
    // was a blob with no referrer, and would have vanished — everywhere at
    // once — an hour after it was uploaded.
    expect(existsSync(join(mediaDir, picHash))).toBe(true);
    // Force a collection the way a deletion does, then look again.
    await act({ t: 'post', author: 'u_b', text: 'unrelated', a: 0.5 });
    const idx = ((await get('/api/acts')).total as number) - 1;
    await act({ t: 'deletePost', author: 'u_b', target: idx });
    expect(existsSync(join(mediaDir, picHash))).toBe(true);
    expect(JSON.parse(readFileSync(join(mediaDir, picHash + '.meta'), 'utf8')).mime).toBe('image/jpeg');
  });

  it('clears with an empty picture, because the latest act wins', async () => {
    const r = await act({ t: 'profile', id: 'u_a', bio: 'me', pic: '', auth: '1234' });
    expect(r.status).toBe(200);
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const E = require('../public/peer-engine.mjs');
    const R = require('../social/replay.cjs').create(E.default ?? E);
    const d = await get('/api/acts');
    const st = R.replay([{ t: 'seedWorld' }, ...(d.acts as unknown[])]);
    expect(st.profiles.u_a.pic).toBe('');
  });
});

describe('serving the bytes', () => {
  let h = '';
  let size = 0;

  beforeAll(async () => {
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
    const up = await upload(bytes, 'audio/mpeg');
    h = up.body.h; size = up.body.size;
    expect(size).toBe(1000);
  });

  it('answers a range with 206 and the right slice', async () => {
    const r = await fetch(`${BASE}/api/media/${h}`, { headers: { Range: 'bytes=100-199' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 100-199/${size}`);
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.length).toBe(100);
    expect(buf[0]).toBe(100 % 251);
    expect(buf[99]).toBe(199 % 251);
  });

  it('answers an open-ended range', async () => {
    const r = await fetch(`${BASE}/api/media/${h}`, { headers: { Range: 'bytes=990-' } });
    expect(r.status).toBe(206);
    expect(Buffer.from(await r.arrayBuffer()).length).toBe(10);
  });

  it('answers a suffix range', async () => {
    const r = await fetch(`${BASE}/api/media/${h}`, { headers: { Range: 'bytes=-20' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 980-999/${size}`);
  });

  it('refuses a range past the end rather than inventing bytes', async () => {
    const r = await fetch(`${BASE}/api/media/${h}`, { headers: { Range: 'bytes=5000-6000' } });
    expect(r.status).toBe(416);
    expect(r.headers.get('content-range')).toBe(`bytes */${size}`);
  });

  it('still answers a plain GET with the whole thing, and says it takes ranges', async () => {
    const r = await fetch(`${BASE}/api/media/${h}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect(Buffer.from(await r.arrayBuffer()).length).toBe(size);
  });

  it('answers HEAD with the headers and no body', async () => {
    // HEAD used to 404, so there was no way to learn what a download would
    // cost without paying for it.
    const r = await fetch(`${BASE}/api/media/${h}`, { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe(String(size));
    expect(Buffer.from(await r.arrayBuffer()).length).toBe(0);
  });

  it('is fetchable cross-origin, which is what saving offline needs', async () => {
    // A media element fetches no-cors and yields an opaque response the page
    // cannot store honestly. Saving uses an explicit CORS fetch instead, and
    // that only works because the host says so.
    const r = await fetch(`${BASE}/api/media/${h}`);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('the bot API can write what the app can write', () => {
  it('takes an ordered list of attachments', async () => {
    const a = await upload(blob(64), 'audio/mpeg');
    const b = await upload(blob(64), 'audio/mpeg');
    const r = await post('/api/v1/post', {
      as: 'u_a', pin: '1234', text: 'two tracks',
      attachments: [{ h: a.body.h, m: 'audio/mpeg', n: 'one.mp3' }, { h: b.body.h, m: 'audio/mpeg', n: 'two.mp3' }],
    });
    expect(r.status).toBe(200);
    const d = await get('/api/acts');
    const acts = d.acts as Array<Record<string, unknown>>;
    const last = acts.filter((x) => x.t === 'post' && x.text === 'two tracks').pop();
    expect((last!.media as Array<{ n: string }>).map((m) => m.n)).toEqual(['one.mp3', 'two.mp3']);
  });

  it('takes a profile picture', async () => {
    const up = await upload(blob(180), 'image/png');
    const r = await post('/api/v1/profile', { as: 'u_a', pin: '1234', bio: 'via a bot', picture: up.body.h });
    expect(r.status).toBe(200);
    const d = await get('/api/acts');
    const acts = d.acts as Array<Record<string, unknown>>;
    expect(acts.filter((x) => x.t === 'profile').pop()!.pic).toBe(up.body.h);
  });
});

describe('an album carries a cover', () => {
  it('accepts one image marked cv:1 beside the tracks', async () => {
    const img = await upload(blob(220), 'image/jpeg');
    const a = await upload(blob(64), 'audio/mpeg');
    const b = await upload(blob(64), 'audio/mpeg');
    const r = await act({
      t: 'post', author: 'u_a', text: 'an EP with a sleeve', a: 0.8, auth: '1234',
      media: [
        { h: img.body.h, m: 'image/jpeg', n: 'sleeve.jpg', s: img.body.size, cv: 1 },
        { h: a.body.h, m: 'audio/mpeg', n: 'A side.mp3', s: a.body.size },
        { h: b.body.h, m: 'audio/mpeg', n: 'B side.mp3', s: b.body.size },
      ],
    });
    expect(r.status).toBe(200);
    const d = await get('/api/acts');
    const acts = d.acts as Array<Record<string, unknown>>;
    const post = acts.filter((x) => x.text === 'an EP with a sleeve').pop();
    expect((post!.media as Array<{ cv?: number }>)[0].cv).toBe(1);
  });

  it('refuses a second cover, and counts them', async () => {
    const one = await upload(blob(90), 'image/jpeg');
    const two = await upload(blob(91), 'image/jpeg');
    const a = await upload(blob(64), 'audio/mpeg');
    const r = await act({
      t: 'post', author: 'u_a', text: 'two sleeves', a: 0.8, auth: '1234',
      media: [
        { h: one.body.h, m: 'image/jpeg', cv: 1 },
        { h: two.body.h, m: 'image/jpeg', cv: 1 },
        { h: a.body.h, m: 'audio/mpeg' },
      ],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('one cover');
    expect(r.body.error).toContain('2');
  });

  it('refuses a cover that is not an image', async () => {
    const a = await upload(blob(64), 'audio/mpeg');
    const r = await act({
      t: 'post', author: 'u_a', text: 'a song as its own sleeve', a: 0.8, auth: '1234',
      media: [{ h: a.body.h, m: 'audio/mpeg', cv: 1 }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/cover has to be an image/i);
  });

  it('refuses cv set to anything but the number 1', async () => {
    // Truthiness would reopen the nested channel the whitelist closes: a
    // string, an object or a number carries an author-controlled payload into
    // an append-only log that is published and hashed.
    const img = await upload(blob(95), 'image/jpeg');
    const a = await upload(blob(64), 'audio/mpeg');
    for (const bad of ['yes', true, 2, { deep: true }]) {
      const r = await act({
        t: 'post', author: 'u_a', text: 'cv abuse ' + JSON.stringify(bad), a: 0.8, auth: '1234',
        media: [{ h: img.body.h, m: 'image/jpeg', cv: bad }, { h: a.body.h, m: 'audio/mpeg' }],
      });
      expect(r.status, 'cv=' + JSON.stringify(bad) + ' was accepted').toBe(400);
    }
  });
});

describe('what a media entry may say at all', () => {
  it('refuses an unknown field rather than writing it to the log forever', async () => {
    // sanitize() whitelists TOP-LEVEL keys only, so before this rule an entry
    // could carry anything and the host answered 200. The log is append-only,
    // public, mirrored, and hashed into the archive manifest.
    const a = await upload(blob(64), 'audio/mpeg');
    const r = await act({
      t: 'post', author: 'u_a', text: 'smuggling', a: 0.8, auth: '1234',
      media: [{ h: a.body.h, m: 'audio/mpeg', payload: 'x'.repeat(200) }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('payload');
  });

  it('refuses a control character inside an attachment name', async () => {
    // hasControlChars() walks Object.values(act) and never descends, so the
    // identical character was refused in act.text and accepted in media[0].n.
    const a = await upload(blob(64), 'audio/mpeg');
    const r = await act({
      t: 'post', author: 'u_a', text: 'unprintable name', a: 0.8, auth: '1234',
      media: [{ h: a.body.h, m: 'audio/mpeg', n: 'bad\u0001name.mp3' }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/unprintable/i);
  });

  it('refuses a post that calls a picture a song', async () => {
    // The declared type used to be checked against an allow-list and nothing
    // else, so `m` was the author's claim about their own bytes. A reader got
    // a player that silently refuses to decode.
    const img = await upload(blob(120), 'image/png');
    const r = await act({
      t: 'post', author: 'u_a', text: 'definitely a song', a: 0.8, auth: '1234',
      media: [{ h: img.body.h, m: 'audio/mpeg', n: 'Definitely A Song.mp3' }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('image/png');
    expect(r.body.error).toContain('audio/mpeg');
  });

  it('still accepts a sibling type of the same family', async () => {
    // MIME_ALIASES folds audio/mp3 to audio/mpeg on upload; a client naming a
    // sibling of the same top-level type is describing the same bytes.
    const a = await upload(blob(77), 'audio/wav');
    const r = await act({
      t: 'post', author: 'u_a', text: 'a wav called audio', a: 0.8, auth: '1234',
      media: [{ h: a.body.h, m: 'audio/mpeg' }],
    });
    expect(r.status).toBe(200);
  });
});
