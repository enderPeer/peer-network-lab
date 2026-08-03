/**
 * The live-stream relay: a small media server inside the host.
 *
 * WHY THIS REPLACES THE PEER-TO-PEER PATH
 *
 * Live streaming used to be a WebRTC mesh: the broadcaster opened one peer
 * connection per viewer and uploaded the video once per viewer. It failed in
 * the field exactly as reported — viewers joined, the picture stayed black —
 * and the host's own /api/ice endpoint said why: `"relay": "none"`. Without a
 * TURN server, two ends behind carrier-grade NAT (which is most mobile
 * networks) have no path to each other at all. No amount of retrying finds a
 * route that does not exist. The mesh had a second problem even when it did
 * connect: N viewers meant N uploads from one home connection.
 *
 * So the video now takes the one path that is already proven to work for
 * every viewer: an HTTPS connection to this host. They are all reaching it
 * anyway — that is how they loaded the app and read the feed.
 *
 * WHY WEBSOCKET AND NOT A CHUNKED HTTP RESPONSE
 *
 * Measured, not assumed. Through the Cloudflare quick tunnel this host runs
 * behind, a never-ending chunked HTTP response is released in ~128 KB bursts
 * regardless of how often the server flushes:
 *
 *   4 KB every 250ms  ->  first 34 frames arrived together after 8.65s
 *   48 KB every 250ms ->  released in groups of three, lag 370-1150ms
 *
 * A quiet webcam scene compresses small, so chunked HTTP would have put a live
 * stream ten seconds behind and called it live. The same frames over a
 * WebSocket through the same tunnel:
 *
 *   4 KB every 250ms  ->  flat 430ms, zero bursts
 *   48 KB every 250ms ->  flat 405ms, zero bursts
 *
 * The tunnel proxies a WebSocket as a raw duplex stream and stops trying to be
 * clever. Hence the ~150 lines of RFC 6455 below rather than a dependency: the
 * host takes no third-party runtime packages, and this is the whole reason the
 * feature works.
 *
 * WHAT THE RELAY ACTUALLY DOES
 *
 * The broadcaster's browser encodes with MediaRecorder and sends the pieces.
 * The host does not transcode — it has no ffmpeg and needs none. It forwards
 * bytes, and it does one piece of real work: it watches the byte stream go
 * past and remembers where the container's segment boundaries are, so that
 * somebody who arrives in the middle can be handed the initialisation header
 * followed by a clean starting point. That is the difference between a late
 * joiner seeing the stream and a late joiner seeing nothing, which is the
 * whole complaint this module exists to answer.
 *
 * Bytes are forwarded the instant they arrive. Boundaries are only remembered,
 * never waited for, so nobody pays latency for the bookkeeping.
 */
import crypto from 'node:crypto';

// ── Limits ───────────────────────────────────────────────────────────────
//
// These are derived from what this machine actually does, measured through
// the tunnel: ~18-20 MB/s sustained out, which is ~95 viewers at 1.5 Mbps or
// ~250 at 600 kbps. The caps sit below the point where the host would start
// failing at its real job, which is serving the network.
export const LIMITS = {
  maxStreams: 8,              // concurrent live streams on one host
  maxViewersPerStream: 200,
  maxViewersTotal: 400,
  maxFrameBytes: 8 * 1024 * 1024,   // one WebSocket message
  maxBitrateBps: 4_000_000,   // sustained push rate; above this the push is closed
  bitrateWindowMs: 10_000,
  ringMs: 12_000,             // how far back a late joiner may start
  ringBytes: 8 * 1024 * 1024,
  viewerHighWater: 4 * 1024 * 1024,  // socket backlog that means "this viewer is behind"
  viewerStallMs: 8_000,       // ...and how long it may stay behind before being dropped
  maxStreamMs: 4 * 60 * 60 * 1000,
  idleEndMs: 20_000,          // no bytes for this long and the stream is over
  keyTtlMs: 120_000,          // a push key must be used promptly
  pingMs: 20_000,
};

// ═════════════════════════════════════════════════════════════════════════
// RFC 6455, the part of it this needs
// ═════════════════════════════════════════════════════════════════════════

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function isWebSocketUpgrade(req) {
  return String(req.headers.upgrade || '').toLowerCase() === 'websocket'
    && /(^|,)\s*upgrade\s*(,|$)/i.test(String(req.headers.connection || ''));
}

/** Frame a payload for sending. Server -> client frames are never masked. */
function frame(payload, opcode) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2); head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;            // FIN set: this library never fragments
  return Buffer.concat([head, payload]);
}

/**
 * A live WebSocket connection.
 *
 * Deliberately small: binary and text in, binary and text out, ping/pong, and
 * a close that always fires exactly once. Continuation frames are reassembled
 * because browsers are allowed to send them, and a receiver that ignored them
 * would corrupt an upload for no visible reason.
 */
class WsConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;         // {opcode, parts:[]} while a message is fragmented
    this.closed = false;
    this.onMessage = null;    // (data: Buffer, isBinary: boolean) => void
    this.onClose = null;
    socket.setNoDelay(true);
    socket.on('data', (c) => this._feed(c));
    socket.on('error', () => this.close());
    socket.on('close', () => this._fireClose());
    // An upgraded socket is left HALF-OPEN by Node: when the peer sends FIN,
    // 'end' fires and 'close' does not, because this side is still allowed to
    // write. A first version watched only for 'close', so a broadcaster who
    // walked away was noticed only by the idle sweep twenty seconds later,
    // and every viewer sat on a frozen frame until then — which is the exact
    // symptom this module exists to remove. Found by a test, not by a viewer.
    socket.on('end', () => this.close(1000, 'the other end went away'));
    this.pinger = setInterval(() => {
      if (!this.closed) this._send(Buffer.alloc(0), 0x9);   // ping
    }, LIMITS.pingMs);
  }

  /** How many bytes are queued in the kernel/Node for this socket. */
  get backlog() { return this.socket.writableLength || 0; }

  send(data) { this._send(Buffer.isBuffer(data) ? data : Buffer.from(data), 0x2); }
  sendText(s) { this._send(Buffer.from(String(s), 'utf8'), 0x1); }

  _send(payload, opcode) {
    if (this.closed) return;
    try { this.socket.write(frame(payload, opcode)); }
    catch { this.close(); }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    // Say why, when there is a why: the client shows it to the viewer instead
    // of a silent stall, which is the failure mode this whole feature had.
    try {
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2, 'utf8');
      this.socket.write(frame(body, 0x8));
    } catch { /* the socket is already gone; nothing to say and nobody to say it to */ }
    this.closed = true;
    clearInterval(this.pinger);
    try { this.socket.end(); } catch { /* already ended */ }
    this._fireClose();
  }

  _fireClose() {
    if (this._closeFired) return;
    this._closeFired = true;
    this.closed = true;
    clearInterval(this.pinger);
    if (this.onClose) { const f = this.onClose; this.onClose = null; f(); }
  }

  _feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const f = this._readFrame();
      if (!f) return;
      if (f.opcode === 0x8) { this.close(); return; }       // close
      if (f.opcode === 0x9) { this._send(f.payload, 0xA); continue; }  // ping -> pong
      if (f.opcode === 0xA) continue;                        // pong
      if (f.opcode === 0x0) {                                // continuation
        if (!this.frag) continue;
        this.frag.parts.push(f.payload);
        if (f.fin) { const m = this.frag; this.frag = null; this._deliver(m.opcode, Buffer.concat(m.parts)); }
        continue;
      }
      if (!f.fin) { this.frag = { opcode: f.opcode, parts: [f.payload] }; continue; }
      this._deliver(f.opcode, f.payload);
    }
  }

  _deliver(opcode, payload) {
    if (this.onMessage) this.onMessage(payload, opcode === 0x2);
  }

  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(LIMITS.maxFrameBytes)) { this.close(1009, 'frame too large'); return null; }
      len = Number(big); off = 10;
    }
    if (len > LIMITS.maxFrameBytes) { this.close(1009, 'frame too large'); return null; }
    const need = off + (masked ? 4 : 0) + len;
    if (b.length < need) return null;
    let payload;
    if (masked) {
      const key = b.slice(off, off + 4);
      payload = Buffer.allocUnsafe(len);
      const start = off + 4;
      for (let i = 0; i < len; i++) payload[i] = b[start + i] ^ key[i & 3];
    } else {
      payload = Buffer.from(b.slice(off, off + len));
    }
    this.buf = b.slice(need);
    return { fin, opcode, payload };
  }
}

/**
 * Complete the handshake and hand back a live connection, or null if the
 * request was not a valid upgrade.
 */
export function acceptUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers['sec-websocket-version'] !== '13') {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* gone */ }
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const conn = new WsConn(socket);
  // Node hands over any bytes that arrived in the same packet as the upgrade
  // request. Dropping them loses whatever the client said first — which here
  // is the authentication message, so the broadcast would fail with no reason
  // given, occasionally, depending on packet timing.
  if (head && head.length) conn._feed(Buffer.from(head));
  return conn;
}

// ═════════════════════════════════════════════════════════════════════════
// Container awareness: where can a late joiner start?
// ═════════════════════════════════════════════════════════════════════════
//
// A viewer who arrives mid-stream cannot simply be handed the bytes flowing
// past. Every container needs an initialisation header first, and then a
// starting point the decoder can actually begin at. Get this wrong and the
// picture stays black — the exact symptom being fixed here — so this part is
// parsed properly rather than guessed at with a byte scan.

const EBML_UNKNOWN = -1;

/** Read an EBML variable-length integer. Returns null when more bytes are needed. */
function readVint(buf, pos, keepMarker) {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  if (first === 0) return { bad: true };
  let width = 1;
  for (let m = 0x80; m; m >>= 1, width++) if (first & m) break;
  if (width > 8) return { bad: true };
  if (pos + width > buf.length) return null;
  let value;
  if (keepMarker) {
    value = 0;
    for (let i = 0; i < width; i++) value = value * 256 + buf[pos + i];
  } else {
    value = first & (0xff >> width);
    let allOnes = value === (0xff >> width);
    for (let i = 1; i < width; i++) {
      value = value * 256 + buf[pos + i];
      if (buf[pos + i] !== 0xff) allOnes = false;
    }
    if (allOnes) value = EBML_UNKNOWN;   // "size unknown", which live muxers use
  }
  return { value, width };
}

const ID_SEGMENT = 0x18538067;
const ID_CLUSTER = 0x1f43b675;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_REFERENCE_BLOCK = 0xfb;
const ID_TIMECODE = 0xe7;

// Everything that may legally appear directly inside a Cluster. When a live
// muxer writes a Cluster with unknown size — Chrome's MediaRecorder does —
// the only correct way to find its end is to walk its children until an ID
// turns up that is not one of these. Scanning for the next Cluster ID as raw
// bytes would eventually match inside compressed video and split the stream
// in a place no decoder can recover from.
const CLUSTER_CHILDREN = new Set([ID_TIMECODE, ID_SIMPLE_BLOCK, ID_BLOCK_GROUP, 0x5854, 0xa7, 0xab, 0xaf]);

/**
 * Watches a WebM byte stream go past and reports where the header ends and
 * where each cluster begins — without holding anything back.
 */
class WebmWatcher {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.base = 0;            // absolute offset of buf[0] in the whole stream
    this.pos = 0;             // parse cursor, relative to buf
    this.state = 'top';       // top -> segment -> cluster
    this.initEnd = null;      // absolute offset where the header ends
    this.videoTrack = null;
    this.pendingTracks = null;
    this.kind = 'webm';
  }

  /**
   * @returns {{initEnd:(number|null), starts:number[]}} absolute offsets of
   * cluster starts found in this chunk. A cluster start is a safe place for a
   * new viewer to begin.
   */
  observe(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const starts = [];
    for (;;) {
      const before = this.pos;
      if (!this._step(starts)) { this._compact(before); return { initEnd: this.initEnd, starts }; }
    }
  }

  _compact(keepFrom) {
    // Only the unparsed tail needs keeping; the rest has been forwarded and
    // must not sit in memory for the length of a four-hour broadcast.
    if (keepFrom > 0) {
      this.buf = this.buf.slice(keepFrom);
      this.base += keepFrom;
      this.pos -= keepFrom;
    }
  }

  _step(starts) {
    const h = this._header(this.pos);
    if (h === null) return false;
    if (h.bad) { this.state = 'lost'; return false; }

    if (this.state === 'cluster' && !CLUSTER_CHILDREN.has(h.id)) {
      this.state = 'segment';    // the cluster ended; re-read this element there
    }

    if (this.state === 'cluster') {
      // Inside a cluster every child carries a known size, so skipping is exact.
      if (h.size === EBML_UNKNOWN) { this.state = 'lost'; return false; }
      const end = this.pos + h.head + h.size;
      if (end > this.buf.length) return false;
      if (h.id === ID_SIMPLE_BLOCK) this._noteBlock(this.pos + h.head, h.size);
      else if (h.id === ID_BLOCK_GROUP) this._noteBlockGroup(this.pos + h.head, h.size);
      this.pos = end;
      return true;
    }

    if (h.id === ID_SEGMENT) {
      // A Segment in a live stream has unknown size and is never closed.
      this.pos += h.head;
      this.state = 'segment';
      return true;
    }

    if (h.id === ID_CLUSTER) {
      if (this.initEnd === null) {
        this.initEnd = this.base + this.pos;
        if (this.pendingTracks) { this._readTracks(this.pendingTracks); this.pendingTracks = null; }
      }
      starts.push({ at: this.base + this.pos, key: null });
      this.currentStart = starts[starts.length - 1];
      this.pos += h.head;
      this.state = 'cluster';
      return true;
    }

    // Any other element (EBML header, Info, Tracks, SeekHead, Void, Cues,
    // Tags) has a known size and belongs to the initialisation header.
    if (h.size === EBML_UNKNOWN) { this.state = 'lost'; return false; }
    const end = this.pos + h.head + h.size;
    if (end > this.buf.length) return false;
    if (h.id === ID_TRACKS) this.pendingTracks = Buffer.from(this.buf.slice(this.pos + h.head, end));
    this.pos = end;
    return true;
  }

  _header(pos) {
    const id = readVint(this.buf, pos, true);
    if (id === null) return null;
    if (id.bad) return { bad: true };
    const size = readVint(this.buf, pos + id.width, false);
    if (size === null) return null;
    if (size.bad) return { bad: true };
    return { id: id.value, head: id.width + size.width, size: size.value };
  }

  /**
   * A SimpleBlock names its track and says whether it is a keyframe. Only the
   * video track's keyframes make a safe starting point; audio blocks all
   * carry the keyframe flag and would happily mark a place where the video
   * decoder has nothing to start from.
   */
  _noteBlock(at, size) {
    if (!this.currentStart || this.currentStart.key !== null) return;
    const t = readVint(this.buf, at, false);
    if (!t || t.bad) return;
    const flagsAt = at + t.width + 2;
    if (flagsAt >= this.buf.length || flagsAt >= at + size) return;
    if (this.videoTrack !== null && t.value !== this.videoTrack) return;
    this.currentStart.key = (this.buf[flagsAt] & 0x80) !== 0;
  }

  /**
   * The other way a frame can be written. Chrome's VP8/VP9 muxer does not use
   * SimpleBlock at all — it wraps every frame in a BlockGroup — so a keyframe
   * test that only read SimpleBlock flags learned nothing about the most
   * common stream this host will carry. That was caught by running this parser
   * over real MediaRecorder output rather than by reading the specification.
   *
   * A BlockGroup holds a keyframe exactly when it carries no ReferenceBlock:
   * a frame that references nothing is a frame that needs nothing. Verified
   * against captured bytes — the first group in each cluster has Block plus
   * BlockAdditions and no 0xFB, every later group has one.
   */
  _noteBlockGroup(at, size) {
    if (!this.currentStart || this.currentStart.key !== null) return;
    const end = Math.min(this.buf.length, at + size);
    let p = at, isVideo = null, hasReference = false;
    while (p < end) {
      const h = this._header(p);
      if (h === null || h.bad || h.size === EBML_UNKNOWN) return;
      if (h.id === ID_BLOCK) {
        const t = readVint(this.buf, p + h.head, false);
        if (!t || t.bad) return;
        isVideo = this.videoTrack === null || t.value === this.videoTrack;
      }
      if (h.id === ID_REFERENCE_BLOCK) hasReference = true;
      p += h.head + h.size;
    }
    if (isVideo === null) return;          // no Block here; say nothing
    if (!isVideo) return;                  // an audio group proves nothing about the picture
    this.currentStart.key = !hasReference;
  }

  /** Find the video track number inside a Tracks element. */
  _readTracks(tracks) {
    let p = 0;
    const hdr = (buf, pos) => {
      const id = readVint(buf, pos, true);
      if (!id || id.bad) return null;
      const size = readVint(buf, pos + id.width, false);
      if (!size || size.bad) return null;
      return { id: id.value, head: id.width + size.width, size: size.value };
    };
    while (p < tracks.length) {
      const h = hdr(tracks, p);
      if (!h) return;
      if (h.id === ID_TRACK_ENTRY) {
        let q = p + h.head, num = null, type = null;
        const entryEnd = Math.min(tracks.length, q + h.size);
        while (q < entryEnd) {
          const c = hdr(tracks, q);
          if (!c) break;
          const dataAt = q + c.head;
          if (c.id === ID_TRACK_NUMBER) num = tracks.readUIntBE(dataAt, Math.min(c.size, 6));
          if (c.id === ID_TRACK_TYPE) type = tracks[dataAt];
          q = dataAt + c.size;
        }
        if (type === 1 && num !== null) { this.videoTrack = num; return; }
      }
      p += h.head + h.size;
    }
  }
}

/**
 * The same job for fragmented MP4, which is what Safari's MediaRecorder
 * produces. Boxes carry their own length, so this is far simpler: everything
 * before the first `moof` is the header, and each `moof` starts a fragment.
 *
 * Honest limitation: this does not read `trun` sample flags, so it treats
 * every fragment as a possible starting point. In practice Safari emits one
 * fragment per timeslice beginning with a sync sample; where that does not
 * hold, a late joiner sees a moment of blocking before the next keyframe
 * rather than nothing at all.
 */
class Mp4Watcher {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.base = 0;
    this.pos = 0;
    this.initEnd = null;
    this.kind = 'mp4';
  }

  observe(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const starts = [];
    for (;;) {
      if (this.pos + 8 > this.buf.length) break;
      let size = this.buf.readUInt32BE(this.pos);
      const type = this.buf.toString('latin1', this.pos + 4, this.pos + 8);
      let head = 8;
      if (size === 1) {
        if (this.pos + 16 > this.buf.length) break;
        size = Number(this.buf.readBigUInt64BE(this.pos + 8));
        head = 16;
      }
      if (size < head) break;                     // malformed; stop parsing
      if (type === 'moof') {
        if (this.initEnd === null) this.initEnd = this.base + this.pos;
        // `key: null` means "a fragment boundary, keyframe status unread".
        // Claiming true here would be an assumption dressed as a measurement:
        // proving it needs the sample flags inside trun, and Safari's output
        // could not be captured from this machine to check against.
        starts.push({ at: this.base + this.pos, key: null });
      }
      if (this.pos + size > this.buf.length) break;
      this.pos += size;
    }
    if (this.pos > 0) { this.buf = this.buf.slice(this.pos); this.base += this.pos; this.pos = 0; }
    return { initEnd: this.initEnd, starts };
  }
}

/**
 * A container this host does not understand. Everything still reaches the
 * viewers who were already watching; only mid-stream joining is degraded,
 * and the stream says so rather than pretending.
 */
class BlindWatcher {
  constructor() { this.initEnd = null; this.kind = 'opaque'; }
  observe() { return { initEnd: null, starts: [] }; }
}

export function watcherFor(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('webm') || m.includes('matroska')) return new WebmWatcher();
  if (m.includes('mp4')) return new Mp4Watcher();
  return new BlindWatcher();
}

// ═════════════════════════════════════════════════════════════════════════
// The hub
// ═════════════════════════════════════════════════════════════════════════

let seq = 0;

/**
 * Holds the live streams.
 *
 * WHY A STREAM CAN HAVE MORE THAN ONE TRACK OF BYTES
 *
 * No single container reaches every browser. Measured on this machine against
 * real MediaRecorder output:
 *
 *   WebM/VP8   - Chrome, Firefox, Android play it. iPhone Safari cannot: it
 *                has no MediaSource before iOS 17.1 and its ManagedMediaSource
 *                does not accept VP8. Chunks arrive every 400ms.
 *   fMP4/H.264 - everything plays it, iPhone included. But a fragment cannot
 *                be emitted until its whole group of pictures is encoded, so
 *                chunks arrive every ~1.5-2s and every viewer pays that.
 *
 * Picking one means either losing iPhones or making everybody wait. So the
 * broadcaster says which containers it *could* produce, streams the fast one,
 * and only starts the second when a viewer turns up who cannot play the
 * first. Nobody's upload is spent on a format nobody is watching.
 */
export function createHub(opts = {}) {
  const limits = { ...LIMITS, ...(opts.limits || {}) };
  const now = opts.now || (() => Date.now());
  const streams = new Map();     // id -> stream
  const keys = new Map();        // key -> {id, expires}
  const totals = { bytesIn: 0, bytesOut: 0, streamsOpened: 0, viewersServed: 0, dropped: 0, renditionsAsked: 0 };

  function viewerCount() {
    let n = 0;
    for (const s of streams.values()) n += s.viewers.size;
    return n;
  }

  function newRendition(mime) {
    const watcher = watcherFor(mime);
    return {
      mime, container: watcher.kind, watcher,
      init: null, initParts: [], initTarget: null,
      ring: [], ringBytes: 0, bytes: 0,
      started: now(), lastByte: now(),
      viewers: new Set(),
      // People who have the header but no safe place to start yet. They are
      // let in at the next keyframe rather than handed the middle of a frame.
      pending: new Set(),
    };
  }

  /**
   * Reserve a stream and hand back a one-time key. The key, not the account's
   * PIN, is what the pushing socket presents: a credential should not be spent
   * on a long-lived connection that does not need it, and this one expires.
   */
  function open({ id, owner, title, at, can }) {
    if (!streams.has(id) && streams.size >= limits.maxStreams) return { error: 'this host is already carrying as many live streams as it will' };
    if (streams.has(id)) end(id, 'restarted by the broadcaster');
    const key = crypto.randomBytes(24).toString('base64url');
    const s = {
      id, owner,
      title: String(title || '').slice(0, 140),
      can: (Array.isArray(can) ? can : []).map((m) => String(m).slice(0, 120)).slice(0, 6),
      started: at || now(), lastByte: at || now(),
      rends: new Map(),          // mime -> rendition
      viewers: new Set(),        // every viewer of this stream, attached or waiting
      window: [],                // push rate across all renditions
      bytes: 0, pusher: null, ended: false, key,
    };
    streams.set(id, s);
    keys.set(key, { id, expires: now() + limits.keyTtlMs });
    totals.streamsOpened += 1;
    return { key, id };
  }

  function claimKey(key, id) {
    const rec = keys.get(key);
    if (!rec || rec.id !== id) return null;
    if (rec.expires < now()) { keys.delete(key); return null; }
    keys.delete(key);            // one use only
    return streams.get(id) || null;
  }

  function attachPusher(s, conn) {
    if (s.pusher && s.pusher !== conn) s.pusher.close(1000, 'replaced by a newer broadcast');
    s.pusher = conn;
  }

  /** Bytes for one rendition of one stream. */
  function push(s, mime, chunk) {
    if (s.ended) return { ok: false, why: 'this stream has ended' };
    const t = now();
    let r = s.rends.get(mime);
    if (!r) {
      if (s.rends.size >= 3) return { ok: false, why: 'too many formats on one stream' };
      r = newRendition(mime);
      // The format the broadcast started in. The broadcaster's own encoder is
      // built around it and will not stop it on request, so asking is worse
      // than pointless: the host would forget the rendition, the next byte
      // would recreate it, and the pair would churn forever.
      r.primary = s.rends.size === 0;
      s.rends.set(mime, r);
    }
    s.lastByte = t; r.lastByte = t;
    s.bytes += chunk.length; r.bytes += chunk.length;
    totals.bytesIn += chunk.length;

    // Sustained rate, summed across every rendition: a broadcaster who
    // ignores the ceiling takes the host's upstream away from everyone else.
    s.window.push({ t, n: chunk.length });
    while (s.window.length && t - s.window[0].t > limits.bitrateWindowMs) s.window.shift();
    const span = t - s.window[0].t;
    if (span >= limits.bitrateWindowMs / 2) {
      const bps = (s.window.reduce((a, w) => a + w.n, 0) * 8000) / span;
      if (bps > limits.maxBitrateBps) {
        return { ok: false, why: `${Math.round(bps / 1000)} kbps is above this host's ${Math.round(limits.maxBitrateBps / 1000)} kbps ceiling` };
      }
    }
    if (t - s.started > limits.maxStreamMs) return { ok: false, why: 'a broadcast may run for four hours' };

    const off = r.bytes - chunk.length;
    const seen = r.watcher.observe(chunk);

    // Collect the initialisation header the first time it goes past. Everyone
    // who joins later needs it before any media makes sense.
    if (r.init === null) {
      r.initParts.push(chunk);
      if (seen.initEnd !== null) {
        r.init = Buffer.concat(r.initParts).slice(0, seen.initEnd);
        r.initParts = [];
        attachWaiting(s, r);     // people were waiting for exactly this
      } else if (r.bytes > 4 * 1024 * 1024) {
        // Four megabytes without a recognisable header: this is not a
        // container this host can start anyone else in. Keep relaying to
        // whoever is already attached and stop pretending otherwise.
        r.initParts = []; r.init = Buffer.alloc(0);
      }
    }

    // Ring buffer, so somebody arriving now can start a few seconds back.
    r.ring.push({ off, buf: chunk, t, starts: seen.starts });
    r.ringBytes += chunk.length;
    while (r.ring.length > 1
      && (r.ringBytes - r.ring[0].buf.length > limits.ringBytes || t - r.ring[0].t > limits.ringMs)) {
      r.ringBytes -= r.ring[0].buf.length;
      r.ring.shift();
    }

    // Forward at once. Nothing waits for a boundary — the boundaries are only
    // needed by people joining, and they are read, not waited for. The same
    // Buffer instance goes to every viewer; copying per viewer would multiply
    // the memory by the size of the audience for no gain.
    for (const v of [...r.viewers]) sendTo(s, r, v, chunk);
    // Only now: anyone still waiting for a clean starting point gets let in
    // from a boundary inside THIS chunk, so the bytes are exact and nobody
    // receives the same chunk twice.
    admitPending(s, r, chunk, off, seen.starts);
    return { ok: true };
  }

  function admitPending(s, r, chunk, off, starts) {
    if (!r.pending.size || !starts.length) return;
    for (const st of starts) {
      if (st.at < off || st.key === false) continue;   // must be inside this chunk
      const tail = chunk.subarray(st.at - off);
      for (const v of [...r.pending]) {
        r.pending.delete(v);
        r.viewers.add(v);
        v.conn.send(tail);
        totals.bytesOut += tail.length;
      }
      return;
    }
  }

  function sendTo(s, r, v, chunk) {
    if (v.conn.closed) { r.viewers.delete(v); s.viewers.delete(v); return; }
    const t = now();
    if (v.conn.backlog > limits.viewerHighWater) {
      // Behind. Queueing more would let one stalled mobile viewer grow the
      // host's memory without limit; skipping bytes would hand them a gap no
      // decoder recovers from. So: a few seconds of grace, then drop, and the
      // app rejoins cleanly at the live edge.
      if (!v.behindSince) v.behindSince = t;
      if (t - v.behindSince > limits.viewerStallMs) {
        totals.dropped += 1;
        r.viewers.delete(v); s.viewers.delete(v);
        v.conn.close(1013, 'your connection could not keep up — rejoining');
      }
      return;
    }
    v.behindSince = 0;
    v.conn.send(chunk);
    totals.bytesOut += chunk.length;
  }

  /** Send a joiner the header, then a clean starting point, then the live edge. */
  function startViewer(s, r, v) {
    v.mime = r.mime;
    v.conn.sendText(JSON.stringify({
      t: 'start', id: s.id, mime: r.mime, container: r.container,
      title: s.title, owner: s.owner, started: s.started,
    }));
    if (r.init && r.init.length) {
      v.conn.send(r.init);
      // Prefer the newest proven keyframe; fall back to a boundary of unknown
      // status only when the ring holds no proven one. Starting at a known
      // non-keyframe is precisely the black screen this module exists to end.
      //
      // A boundary is only usable if every byte from it onward is STILL in the
      // ring. A cluster header can span two chunks, so the piece that reported
      // the boundary is not always the piece the boundary lies in — and once
      // the earlier piece has been evicted, resuming there hands the decoder a
      // stream that begins in the middle of a frame. That failure reached a
      // real browser as "Unexpected element ID 0x50a2"; a test that joins at
      // every offset with an evicting ring reproduced it 9 times out of 13.
      const floor = r.ring.length ? r.ring[0].off : Infinity;
      let from = null;
      for (const wantProven of [true, false]) {
        for (let i = r.ring.length - 1; i >= 0 && from === null; i--) {
          const st = r.ring[i].starts;
          for (let j = st.length - 1; j >= 0; j--) {
            if (st[j].at < floor) continue;
            if (wantProven ? st[j].key === true : st[j].key !== false) { from = st[j].at; break; }
          }
        }
        if (from !== null) break;
      }
      if (from !== null) {
        for (const piece of r.ring) {
          const pieceEnd = piece.off + piece.buf.length;
          if (pieceEnd <= from) continue;
          v.conn.send(piece.off >= from ? piece.buf : piece.buf.slice(from - piece.off));
        }
        r.viewers.add(v);
        return;
      }
      // Nothing in the ring is a safe place to begin — a long keyframe
      // interval, or a boundary whose start has already been dropped. Wait for
      // the next one rather than sending something that cannot be decoded.
      v.conn.sendText(JSON.stringify({
        t: 'hold', why: 'waiting for the next full frame from the broadcaster',
      }));
      r.pending.add(v);
      return;
    }
    r.viewers.add(v);
  }

  /** A rendition just became playable; take everyone who was waiting for it. */
  function attachWaiting(s, r) {
    for (const v of s.viewers) {
      if (v.mime === null && canPlay(v, r.mime)) startViewer(s, r, v);
    }
  }

  function canPlay(v, mime) {
    return v.can.some((m) => sameFormat(m, mime));
  }

  /**
   * Two mime strings describe the same thing often enough that an exact
   * comparison would refuse formats the viewer can plainly play. Compare the
   * container and the codec names, ignoring parameter spelling and order.
   */
  function sameFormat(a, b) {
    const norm = (s2) => String(s2).toLowerCase().replace(/["\s]/g, '');
    const A = norm(a), B = norm(b);
    if (A === B) return true;
    const base = (s2) => s2.split(';')[0];
    if (base(A) !== base(B)) return false;
    const codecs = (s2) => {
      const m = s2.match(/codecs=([^;]*)/);
      return m ? m[1].split(',').map((c) => c.split('.')[0]).sort().join(',') : '';
    };
    return codecs(A) === codecs(B);
  }

  /**
   * Attach a viewer, or arrange for a format it can play.
   * @param can list of mime types the viewer's MediaSource accepts
   */
  function watch(id, conn, can) {
    const s = streams.get(id);
    if (!s || s.ended) return { ok: false, why: 'that stream is not live' };
    if (s.viewers.size >= limits.maxViewersPerStream) return { ok: false, why: 'this stream has as many viewers as it will take' };
    if (viewerCount() >= limits.maxViewersTotal) return { ok: false, why: 'this host is at its viewer limit' };

    const v = {
      conn, id: ++seq, joined: now(), behindSince: 0, mime: null,
      can: (Array.isArray(can) ? can : []).map(String).slice(0, 12),
    };
    s.viewers.add(v);
    totals.viewersServed += 1;
    conn.onClose = () => {
      s.viewers.delete(v);
      for (const r of s.rends.values()) { r.viewers.delete(v); r.pending.delete(v); }
      idleRenditions(s);
    };

    // A rendition that is already flowing and that this viewer can decode.
    for (const r of s.rends.values()) {
      if (r.init && canPlay(v, r.mime)) { startViewer(s, r, v); return { ok: true, stream: s, viewer: v }; }
    }
    // One the broadcaster could start.
    const wanted = s.can.find((m) => canPlay(v, m));
    if (wanted) {
      totals.renditionsAsked += 1;
      conn.sendText(JSON.stringify({
        t: 'wait', mime: wanted,
        why: 'asking the broadcaster to send a format your device can play',
      }));
      if (s.pusher) s.pusher.sendText(JSON.stringify({ t: 'need', mime: wanted }));
      return { ok: true, stream: s, viewer: v, waiting: true };
    }
    s.viewers.delete(v);
    return {
      ok: false,
      why: 'this broadcast is in a format your browser cannot play, and the broadcaster cannot produce one it can',
    };
  }

  /** Stop paying for a format nobody is watching any more. */
  function idleRenditions(s) {
    if (s.rends.size < 2 || !s.pusher) return;
    for (const [mime, r] of s.rends) {
      if (r.primary) continue;
      if (r.viewers.size === 0 && r.pending.size === 0 && now() - r.started > 30_000) {
        s.rends.delete(mime);
        s.pusher.sendText(JSON.stringify({ t: 'drop', mime }));
      }
    }
  }

  function end(id, why) {
    const s = streams.get(id);
    if (!s) return false;
    s.ended = true;
    for (const v of s.viewers) v.conn.close(1000, why || 'the broadcast ended');
    s.viewers.clear();
    if (s.pusher) s.pusher.close(1000, why || 'ended');
    streams.delete(id);
    return true;
  }

  /** Ends streams whose broadcaster went away without saying so. */
  function sweep() {
    const t = now();
    for (const [id, s] of [...streams]) {
      if (t - s.lastByte > limits.idleEndMs) end(id, 'the broadcaster stopped sending');
      else if (t - s.started > limits.maxStreamMs) end(id, 'a broadcast may run for four hours');
      else idleRenditions(s);
    }
    for (const [k, rec] of [...keys]) if (rec.expires < t) keys.delete(k);
  }

  function kbps(s) {
    const span = Math.max(1000, limits.bitrateWindowMs);
    return Math.round((s.window.reduce((a, w) => a + w.n, 0) * 8) / (span / 1000) / 1000);
  }

  function list() {
    return [...streams.values()].filter((s) => !s.ended).map((s) => ({
      id: s.id, owner: s.owner, title: s.title,
      started: s.started, viewers: s.viewers.size,
      formats: [...s.rends.keys()], can: s.can, kbps: kbps(s), live: true,
    }));
  }

  /**
   * Operator metrics. Counts and rates only. No addresses, no per-viewer
   * identity, nothing that turns watching into a record about a person — the
   * address watcher exists for abuse control and this subsystem does not feed
   * it, here as everywhere else.
   */
  function stats() {
    return {
      streams: streams.size,
      viewers: viewerCount(),
      renditions: [...streams.values()].reduce((n, s) => n + s.rends.size, 0),
      ...totals,
      limits: {
        maxStreams: limits.maxStreams,
        maxViewersTotal: limits.maxViewersTotal,
        maxBitrateKbps: Math.round(limits.maxBitrateBps / 1000),
      },
    };
  }

  return { open, claimKey, attachPusher, push, watch, end, sweep, list, stats, streams, limits, sameFormat };
}
