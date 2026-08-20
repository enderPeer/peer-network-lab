/**
 * The live-stream relay.
 *
 * The feature this replaces failed in the field with the least useful symptom
 * a program can have: the viewer joins, the picture stays black, and nothing
 * anywhere says why. So these tests are written against the things that were
 * actually silent — a container boundary read wrongly, a late joiner started
 * at a frame that references one it never received, a viewer who cannot
 * decode the format being left to time out.
 *
 * The WebM shapes here are copied from real Chrome MediaRecorder output
 * captured on this machine, not from the specification: unknown-size Segments
 * and Clusters, and frames in BlockGroup rather than SimpleBlock. A parser
 * written from the specification alone found zero keyframes in that stream.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { wsConnect, webmHeader, webmCluster } from './helpers/ws';

const require = createRequire(import.meta.url);
const { createHub, watcherFor } = require('../stream.mjs') as typeof import('../stream.mjs');

const WEBM = 'video/webm;codecs=vp8,opus';
const MP4 = 'video/mp4;codecs=avc1.42E01E';

// ── A stand-in for a socket. The hub only ever asks four things of one. ────
function fakeConn() {
  return {
    closed: false, backlog: 0, sent: [] as Buffer[], raw: [] as Buffer[], texts: [] as string[],
    onClose: null as null | (() => void),
    // `raw` keeps the reference, `sent` keeps a copy: one is for asserting
    // what arrived, the other for asserting that nothing was duplicated.
    send(b: Buffer) { this.raw.push(b); this.sent.push(Buffer.from(b)); },
    sendText(s: string) { this.texts.push(s); },
    close(_c?: number, reason?: string) { this.closed = true; if (reason) this.texts.push('CLOSE:' + reason); },
    get bytes() { return this.sent.reduce((n, b) => n + b.length, 0); },
    msg(t: string) { return this.texts.map((x) => { try { return JSON.parse(x); } catch { return {}; } }).find((m) => m.t === t); },
  };
}

describe('reading the container', () => {
  it('finds the header and every cluster in a stream shaped like Chrome output', () => {
    const w = watcherFor(WEBM);
    const head = webmHeader();
    const r1 = w.observe(head);
    expect(r1.initEnd, 'a header alone must not look complete').toBe(null);

    const c1 = webmCluster(0);
    const r2 = w.observe(c1);
    expect(r2.initEnd, 'the header ends where the first cluster begins').toBe(head.length);
    expect(r2.starts.length).toBe(1);
    expect(r2.starts[0].at).toBe(head.length);
    expect(r2.starts[0].key, 'the first group carries no ReferenceBlock, so it is a keyframe').toBe(true);

    const r3 = w.observe(webmCluster(1));
    expect(r3.starts.length).toBe(1);
    expect(r3.starts[0].at).toBe(head.length + c1.length);
    expect(r3.starts[0].key).toBe(true);
  });

  it('does not care where the chunk boundaries fall', () => {
    // Firefox does not align its blobs to cluster boundaries, and a WebSocket
    // frame is whatever the network made of it. A parser that only worked on
    // tidy input would work in testing and fail on somebody's phone.
    const whole = Buffer.concat([webmHeader(), webmCluster(0), webmCluster(1), webmCluster(2)]);
    for (const size of [1, 7, 64, 1000]) {
      const w = watcherFor(WEBM);
      const starts: number[] = [];
      let init: number | null = null;
      for (let i = 0; i < whole.length; i += size) {
        const r = w.observe(whole.subarray(i, i + size));
        if (r.initEnd !== null && init === null) init = r.initEnd;
        for (const s of r.starts) starts.push(s.at);
      }
      expect(init, `header lost at chunk size ${size}`).toBe(webmHeader().length);
      expect(starts.length, `clusters lost at chunk size ${size}`).toBe(3);
    }
  });

  it('reports an unreadable container instead of inventing boundaries', () => {
    const w = watcherFor('audio/wav');
    const r = w.observe(Buffer.alloc(5000, 7));
    expect(r.initEnd).toBe(null);
    expect(r.starts).toEqual([]);
  });
});

describe('the relay', () => {
  const head = webmHeader();

  function live(now = () => 1000) {
    const hub = createHub({ now });
    const o = hub.open({ id: 'c1', owner: 'u_a', title: 'test', can: [WEBM, MP4] });
    const s = hub.claimKey(o.key!, 'c1')!;
    return { hub, s };
  }

  it('hands a joiner the header and starts them at a keyframe', () => {
    const { hub, s } = live();
    hub.push(s, WEBM, head);
    hub.push(s, WEBM, webmCluster(0));
    hub.push(s, WEBM, webmCluster(1));

    const c = fakeConn();
    const r = hub.watch('c1', c as never, [WEBM]);
    expect(r.ok).toBe(true);
    expect(c.msg('start').mime).toBe(WEBM);
    // First the header, then bytes from the newest keyframe — not from the
    // beginning (that would be a recording, not a live stream) and not from
    // wherever the stream happened to be (that would be the black screen).
    expect(c.sent[0].equals(head), 'the header must come first').toBe(true);
    const after = Buffer.concat(c.sent.slice(1));
    expect(after.equals(webmCluster(1)), 'a joiner starts at the newest keyframe').toBe(true);
  });

  it('never starts a joiner at bytes it no longer has', () => {
    // A cluster header can span two chunks, so the piece that REPORTS a
    // boundary is not always the piece the boundary lies in. Once the earlier
    // piece has been evicted, resuming there hands the decoder a stream that
    // begins in the middle of a frame. That reached a real browser as
    // "Unexpected element ID 0x50a2", and joining at every offset against an
    // evicting ring reproduced it nine times out of thirteen.
    const HEAD = webmHeader();
    for (let joinAfter = 2; joinAfter <= 10; joinAfter++) {
      let t = 1000;
      // A ring far too small to hold a keyframe interval: the pathological
      // case, so the rule is exercised rather than merely present.
      const hub = createHub({ now: () => t, limits: { ringBytes: 1500, ringMs: 900_000 } });
      const o = hub.open({ id: 'c1', owner: 'u_a', title: 't', can: [WEBM] });
      const s = hub.claimKey(o.key!, 'c1')!;
      const feed = (b: Buffer) => {
        // in thirds, the way a network delivers it
        const third = Math.floor(b.length / 3);
        hub.push(s, WEBM, b.subarray(0, third));
        hub.push(s, WEBM, b.subarray(third, third * 2));
        hub.push(s, WEBM, b.subarray(third * 2));
        t += 100;
      };
      feed(HEAD);
      for (let i = 0; i < joinAfter; i++) feed(webmCluster(i, 6, 400));

      const c = fakeConn();
      expect(hub.watch('c1', c as never, [WEBM]).ok).toBe(true);
      const held = !!c.msg('hold');
      for (let i = 0; i < 3; i++) feed(webmCluster(100 + i, 6, 400));

      const got = Buffer.concat(c.sent);
      expect(got.subarray(0, HEAD.length).equals(HEAD),
        `join after ${joinAfter}: the header must come first`).toBe(true);
      const media = got.subarray(HEAD.length);
      expect(media.length, `join after ${joinAfter}: nothing arrived after the header`).toBeGreaterThan(0);
      expect([...media.subarray(0, 4)],
        `join after ${joinAfter} (held=${held}): media must begin exactly at a cluster`)
        .toEqual([0x1f, 0x43, 0xb6, 0x75]);
    }
  });

  it('holds a joiner until the next keyframe rather than sending a partial one', () => {
    let t = 1000;
    const hub = createHub({ now: () => t, limits: { ringBytes: 1200, ringMs: 900_000 } });
    const o = hub.open({ id: 'c1', owner: 'u_a', title: 't', can: [WEBM] });
    const s = hub.claimKey(o.key!, 'c1')!;
    hub.push(s, WEBM, head);
    // Delivered in pieces, so the ring ends up holding only the tail of the
    // cluster — the start is gone and there is nowhere safe to begin.
    const first = webmCluster(0, 8, 400);
    for (let i = 0; i < first.length; i += 500) hub.push(s, WEBM, first.subarray(i, i + 500));

    const c = fakeConn();
    hub.watch('c1', c as never, [WEBM]);
    expect(c.msg('hold'), 'the viewer must be told it is waiting, not left silent').toBeTruthy();
    expect(Buffer.concat(c.sent).equals(head), 'only the header so far').toBe(true);

    const next = webmCluster(1, 2, 400);
    hub.push(s, WEBM, next);
    const media = Buffer.concat(c.sent).subarray(head.length);
    expect(media.equals(next), 'admitted at the next cluster, whole').toBe(true);
  });

  it('forwards new bytes to everyone attached, without copying per viewer', () => {
    const { hub, s } = live();
    hub.push(s, WEBM, head);
    hub.push(s, WEBM, webmCluster(0));
    const a = fakeConn(); const b = fakeConn();
    hub.watch('c1', a as never, [WEBM]);
    hub.watch('c1', b as never, [WEBM]);
    const before = { a: a.raw.length, b: b.raw.length };
    const next = webmCluster(1);
    hub.push(s, WEBM, next);
    expect(a.raw[before.a].equals(next)).toBe(true);
    expect(b.raw[before.b].equals(next)).toBe(true);
    // The same Buffer instance, not a copy each: with two hundred viewers a
    // per-viewer copy would multiply the host's memory by the audience.
    expect(a.raw[before.a]).toBe(b.raw[before.b]);
    expect(a.raw[before.a]).toBe(next);
  });

  it('refuses a key twice, and refuses one that is not the stream it names', () => {
    const hub = createHub();
    const o = hub.open({ id: 'c1', owner: 'u_a', title: 't', can: [WEBM] });
    expect(hub.claimKey(o.key!, 'c9'), 'a key is bound to its stream').toBe(null);
    expect(hub.claimKey(o.key!, 'c1')).not.toBe(null);
    expect(hub.claimKey(o.key!, 'c1'), 'one use only').toBe(null);
  });

  it('lets a key go stale', () => {
    let t = 1000;
    const hub = createHub({ now: () => t });
    const o = hub.open({ id: 'c1', owner: 'u_a', title: 't', can: [WEBM] });
    t += 10 * 60_000;
    expect(hub.claimKey(o.key!, 'c1')).toBe(null);
  });

  it('closes a broadcast that pushes more than the host will carry', () => {
    let t = 1000;
    const hub = createHub({ now: () => t, limits: { maxBitrateBps: 100_000 } });
    const o = hub.open({ id: 'c1', owner: 'u_a', title: 't', can: [WEBM] });
    const s = hub.claimKey(o.key!, 'c1')!;
    let last: { ok: boolean; why?: string } = { ok: true };
    for (let i = 0; i < 12; i++) { last = hub.push(s, WEBM, Buffer.alloc(60_000)); t += 1000; }
    expect(last.ok).toBe(false);
    expect(last.why, 'the refusal must name the ceiling').toMatch(/kbps/);
  });

  it('drops a viewer that stays behind, rather than growing without limit', () => {
    let t = 1000;
    const hub = createHub({ now: () => t, limits: { viewerHighWater: 100, viewerStallMs: 3000 } });
    const o = hub.open({ id: 'c1', owner: 'u_a', title: 't', can: [WEBM] });
    const s = hub.claimKey(o.key!, 'c1')!;
    hub.push(s, WEBM, head); hub.push(s, WEBM, webmCluster(0));
    const c = fakeConn();
    hub.watch('c1', c as never, [WEBM]);
    c.backlog = 5000;                       // this viewer stopped reading
    hub.push(s, WEBM, webmCluster(1));
    expect(c.closed, 'not dropped immediately — a hiccup is not a failure').toBe(false);
    t += 5000;
    hub.push(s, WEBM, webmCluster(2));
    expect(c.closed).toBe(true);
    expect(c.texts.join(' ')).toMatch(/keep up/);
  });

  it('ends a stream whose broadcaster vanished, and tells the viewers', () => {
    let t = 1000;
    const hub = createHub({ now: () => t });
    const o = hub.open({ id: 'c1', owner: 'u_a', title: 't', can: [WEBM] });
    const s = hub.claimKey(o.key!, 'c1')!;
    hub.push(s, WEBM, head); hub.push(s, WEBM, webmCluster(0));
    const c = fakeConn();
    hub.watch('c1', c as never, [WEBM]);
    t += 60_000;
    hub.sweep();
    expect(c.closed).toBe(true);
    expect(c.texts.join(' ')).toMatch(/stopped sending/);
    expect(hub.list()).toEqual([]);
  });

  it('asks the broadcaster for a format the viewer can actually play', () => {
    // The iPhone case. The stream is WebM; this viewer decodes only MP4. The
    // old behaviour for "cannot decode" was a spinner until the timeout.
    const { hub, s } = live();
    const pusher = fakeConn();
    hub.attachPusher(s, pusher as never);
    hub.push(s, WEBM, head);
    hub.push(s, WEBM, webmCluster(0));

    const c = fakeConn();
    const r = hub.watch('c1', c as never, [MP4]);
    expect(r.ok, 'the viewer is kept, not refused').toBe(true);
    expect(c.msg('wait').mime).toBe(MP4);
    expect(pusher.msg('need').mime, 'the broadcaster is asked for it').toBe(MP4);
    expect(c.sent.length, 'and is sent nothing it cannot decode').toBe(0);

    // The broadcaster starts the second format; the waiting viewer is attached.
    hub.push(s, MP4, Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.alloc(0x10),
      Buffer.from([0, 0, 0, 0x10]), Buffer.from('moof'), Buffer.alloc(8),
    ]));
    expect(c.msg('start').mime).toBe(MP4);
    expect(c.sent.length).toBeGreaterThan(0);
  });

  it('stops the extra format when nobody needs it, and never the first one', () => {
    let t = 1000;
    const hub = createHub({ now: () => t });
    const o = hub.open({ id: 'c1', owner: 'u_a', title: 't', can: [WEBM, MP4] });
    const s = hub.claimKey(o.key!, 'c1')!;
    const pusher = fakeConn();
    hub.attachPusher(s, pusher as never);
    hub.push(s, WEBM, head);
    hub.push(s, WEBM, webmCluster(0));

    const c = fakeConn();
    hub.watch('c1', c as never, [MP4]);
    hub.push(s, MP4, Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.alloc(0x10),
      Buffer.from([0, 0, 0, 0x10]), Buffer.from('moof'), Buffer.alloc(8),
    ]));
    expect(c.msg('start').mime).toBe(MP4);

    // The WebM rendition now has no viewers at all — but it is the one the
    // broadcast started in, and the broadcaster will not stop its own first
    // encoder. Asking would make the host forget it and the next byte would
    // bring it straight back: a drop/recreate loop for as long as the stream
    // ran. So it is left alone.
    t += 120_000;
    hub.sweep();
    expect(pusher.texts.filter((x) => x.includes('"drop"')).length,
      'the first format must never be dropped').toBe(0);

    // The extra one, once its viewer has gone, is another matter.
    c.closed = true;
    c.onClose?.();
    t += 120_000;
    hub.sweep();
    const drop = pusher.msg('drop');
    expect(drop, 'the extra format should be dropped when unwatched').toBeTruthy();
    expect(drop.mime).toBe(MP4);
  });

  it('says so plainly when no format can work', () => {
    const hub = createHub();
    const o = hub.open({ id: 'c1', owner: 'u_a', title: 't', can: [WEBM] });
    const s = hub.claimKey(o.key!, 'c1')!;
    hub.push(s, WEBM, head); hub.push(s, WEBM, webmCluster(0));
    const c = fakeConn();
    const r = hub.watch('c1', c as never, ['video/ogg']);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/cannot play/);
  });

  it('matches formats by what they mean, not by how they are spelled', () => {
    const hub = createHub();
    expect(hub.sameFormat('video/webm;codecs="vp8,opus"', 'video/webm;codecs=vp8,opus')).toBe(true);
    expect(hub.sameFormat('video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1.4d401f')).toBe(true);
    expect(hub.sameFormat('video/webm;codecs=vp8', 'video/mp4;codecs=avc1')).toBe(false);
    expect(hub.sameFormat('video/webm;codecs=vp9', 'video/webm;codecs=vp8')).toBe(false);
  });

  it('counts what an operator needs and nothing about a person', () => {
    const { hub, s } = live();
    hub.push(s, WEBM, head);
    hub.push(s, WEBM, webmCluster(0));
    hub.watch('c1', fakeConn() as never, [WEBM]);
    const st = hub.stats();
    expect(st.streams).toBe(1);
    expect(st.viewers).toBe(1);
    expect(st.bytesIn).toBeGreaterThan(0);
    const text = JSON.stringify(st);
    expect(text, 'no addresses may appear in stream metrics').not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(Object.keys(st)).not.toContain('ips');
  });
});

// ── The whole path, through a real server process ─────────────────────────

// 5323, not 5317: media.test.ts already owns that port, and when vitest ran
// the two files at once one suite silently spoke to the OTHER suite's host
// and its own data directory went unread. Ports here are hand-assigned, so
// they have to stay unique by hand.
const PORT = 5323;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = resolve(__dirname, '..');
let child: ChildProcess;
let dir: string;

const pinHash = (id: string, pin: string) => createHash('sha256').update(`${id}:${pin}`, 'utf8').digest('hex');

async function post(path: string, body: unknown) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

describe('a broadcast through the host', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-stream-test-'));
    mkdirSync(join(dir, 'server-data'), { recursive: true });
    // Registered WITH energy, in the seed file: the relay refuses a cid that
    // is not the caller's own stream node now, so these tests publish real
    // stream acts — and a stream act is W1-gated, which an account opened at
    // zero through the API could never afford.
    const seedLog = [
      { t: 'register', id: 'u_bee', handle: 'bee', seed: 1, epoch: 0, pinHash: pinHash('u_bee', '1234') },
      { t: 'btcBurn', id: 'u_bee', sats: 40000, addr: 'bc1qdead', txid: 'bee'.padEnd(64, 'abcdef0123456789') },
      { t: 'register', id: 'u_nopin', handle: 'nopin', seed: 1, epoch: 0 },
    ];
    writeFileSync(join(dir, 'server-data', 'acts.jsonl'), seedLog.map((a) => JSON.stringify(a)).join(String.fromCharCode(10)) + String.fromCharCode(10));
    child = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(PORT)], {
      stdio: 'ignore',
      env: { ...process.env, PEER_DATA_DIR: join(dir, 'server-data') },
    });
    for (let i = 0; i < 100; i++) {
      try { await fetch(BASE + '/api/live'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
  }, 30000);

  /** Publish a stream act as u_bee and read back the node it minted. */
  async function mintStream(title: string): Promise<string> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const total = ((await (await fetch(BASE + '/api/acts')).json()) as { total: number }).total;
      const r = await post('/api/act', { t: 'stream', author: 'u_bee', text: title, a: 0.8, auth: '1234', since: total });
      if (r.status !== 200) { await new Promise((res) => setTimeout(res, 100)); continue; }   // engine may still be warming
      for (let i = 0; i < 50; i++) {
        const ev = (await (await fetch(BASE + '/api/v1/events?since=' + total)).json()) as { events?: Array<{ node?: string }> };
        const node = ev.events && ev.events[0] && ev.events[0].node;
        if (node) return node;
        await new Promise((res) => setTimeout(res, 100));
      }
      break;
    }
    throw new Error('stream node never minted');
  }

  afterAll(() => {
    child?.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows holds files open briefly */ }
  });

  it('refuses to broadcast from a handle with no PIN', async () => {
    const r = await post('/api/stream/open', { as: 'u_nopin', cid: 'c1' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('STREAM_NEEDS_PIN');
    expect(r.body.why, 'the catalogue explanation must be attached').toBeTruthy();
  });

  it('refuses the wrong PIN', async () => {
    const r = await post('/api/stream/open', { as: 'u_bee', auth: '9999', cid: 'c1' });
    expect(r.status).toBe(401);
  });

  it('carries real bytes from a broadcaster to a viewer', async () => {
    const cid = await mintStream('kitchen');
    const open = await post('/api/stream/open', { as: 'u_bee', auth: '1234', cid, title: 'kitchen', can: [WEBM] });
    expect(open.status).toBe(200);
    expect(open.body.key).toBeTruthy();

    const push = await wsConnect(`${BASE}/api/stream/ws?role=push&s=${cid}`);
    push.sendText(JSON.stringify({ t: 'auth', key: open.body.key, mime: WEBM }));
    await push.until((c) => c.text.some((t) => t.includes('ready')), 4000, 'the host to accept the key');

    // Rendition 0, one byte of prefix, then the media itself.
    const send = (b: Buffer) => push.send(Buffer.concat([Buffer.from([0]), b]));
    send(webmHeader());
    send(webmCluster(0));
    await new Promise((r) => setTimeout(r, 150));

    const live = await (await fetch(BASE + '/api/live')).json() as { live: Array<Record<string, unknown>> };
    expect(live.live[0], 'the broadcast must appear in the live list').toMatchObject({ author: 'u_bee', cid, relay: true });

    const watch = await wsConnect(`${BASE}/api/stream/ws?role=watch&s=${cid}`);
    watch.sendText(JSON.stringify({ t: 'can', list: [WEBM] }));
    await watch.until((c) => c.binary.length >= 2, 4000, 'header and first cluster');
    expect(watch.binary[0].equals(webmHeader()), 'the header arrives first').toBe(true);

    // And live bytes keep flowing to a viewer who was already there.
    const beforeLive = watch.binary.length;
    send(webmCluster(1));
    await watch.until((c) => c.binary.length > beforeLive, 4000, 'live bytes');

    // When the broadcaster goes, the viewer is told — not left on a frozen frame.
    push.close();
    await watch.until((c) => c.closed, 6000, 'the viewer to be told the broadcast ended');
    expect(watch.closeReason).toMatch(/broadcaster/);
  }, 30000);

  it('refuses a socket opened by a page from somewhere else', async () => {
    await expect(wsConnect(`${BASE}/api/stream/ws?role=watch&s=c7`, 'https://evil.example'))
      .rejects.toThrow();
  });

  it('tells a viewer plainly when the stream is not there', async () => {
    const w = await wsConnect(`${BASE}/api/stream/ws?role=watch&s=nosuch`);
    w.sendText(JSON.stringify({ t: 'can', list: [WEBM] }));
    await w.until((c) => c.text.length > 0, 4000, 'a refusal');
    expect(JSON.parse(w.text[0]).why).toMatch(/not live/);
  }, 15000);
  it('refuses to open a relay on a node that is not the caller’s own broadcast', async () => {
    const r = await post('/api/stream/open', { as: 'u_bee', auth: '1234', cid: 'c999', title: 'hijack', can: [WEBM] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('NOT_YOURS');
  });

  it('POST /api/live {stop} with the PIN ends the relayed stream, and the pusher is told why', async () => {
    const cid = await mintStream('pocket');
    const open = await post('/api/stream/open', { as: 'u_bee', auth: '1234', cid, title: 'pocket', can: [WEBM] });
    expect(open.status).toBe(200);
    const push = await wsConnect(`${BASE}/api/stream/ws?role=push&s=${cid}`);
    push.sendText(JSON.stringify({ t: 'auth', key: open.body.key, mime: WEBM }));
    await push.until((c) => c.text.some((t) => t.includes('ready')), 4000, 'the host to accept the key');
    push.send(Buffer.concat([Buffer.from([0]), webmHeader()]));
    await new Promise((r) => setTimeout(r, 100));
    type LiveDoc = { live: Array<Record<string, unknown>>; capacity: Record<string, unknown> };
    let live = await (await fetch(BASE + '/api/live')).json() as LiveDoc;
    expect(live.live.some((e) => e.cid === cid)).toBe(true);
    // The read carries capacity now, so a client can refuse to mint a stream
    // act the relay would not carry.
    expect(live.capacity).toMatchObject({ full: false });
    expect(typeof live.capacity.maxStreams).toBe('number');

    // The wrong PIN ends nothing.
    const bad = await post('/api/live', { as: 'u_bee', auth: '9999', stop: true });
    expect(bad.status).toBe(401);
    live = await (await fetch(BASE + '/api/live')).json() as LiveDoc;
    expect(live.live.some((e) => e.cid === cid)).toBe(true);

    // The right one ends the relay, not just the legacy heartbeat entry.
    const ok = await post('/api/live', { as: 'u_bee', auth: '1234', stop: true });
    expect(ok.status).toBe(200);
    expect((ok.body as unknown as { ended: number }).ended).toBe(1);
    await push.until((c) => c.closed, 4000, 'the pusher to be closed');
    expect(push.closeReason).toMatch(/another session/);
    live = await (await fetch(BASE + '/api/live')).json() as LiveDoc;
    expect(live.live.some((e) => e.cid === cid)).toBe(false);
  }, 20000);

});
