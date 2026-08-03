/**
 * A WebSocket client, hand-written for the same reason the server side is:
 * this package takes no runtime dependencies, and a test that pulled one in
 * would be testing a different program than the one that ships.
 *
 * Client -> server frames MUST be masked. A server that ignored the mask would
 * pass a test written against an unmasked client and then fail against every
 * real browser, so the masking here is not a formality.
 */
import http from 'node:http';
import crypto from 'node:crypto';

export interface WsClient {
  send(data: Buffer): void;
  sendText(s: string): void;
  close(): void;
  /** Everything received, in order. */
  binary: Buffer[];
  text: string[];
  closed: boolean;
  closeReason: string;
  /** Resolves once `p` is true, or rejects after `ms`. */
  until(p: (c: WsClient) => boolean, ms?: number, label?: string): Promise<void>;
}

function maskFrame(payload: Buffer, opcode: number): Buffer {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let head: Buffer;
  if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, masked]);
}

export function wsConnect(url: string, origin?: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const headers: Record<string, string> = {
      Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
    };
    if (origin) headers.Origin = origin;
    const req = http.request(url, { headers });
    req.on('upgrade', (_res, socket) => {
      let buf = Buffer.alloc(0);
      const c: WsClient = {
        binary: [], text: [], closed: false, closeReason: '',
        send: (d) => socket.write(maskFrame(d, 0x2)),
        sendText: (s) => socket.write(maskFrame(Buffer.from(s, 'utf8'), 0x1)),
        close: () => { try { socket.end(); } catch { /* already gone */ } },
        until: (p, ms = 4000, label = 'condition') => new Promise<void>((ok, bad) => {
          const t0 = Date.now();
          const tick = () => {
            if (p(c)) return ok();
            if (Date.now() - t0 > ms) return bad(new Error(`timed out waiting for ${label}`));
            setTimeout(tick, 15);
          };
          tick();
        }),
      };
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) break;
          const opcode = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) break;
          const payload = buf.subarray(off, off + len);
          if (opcode === 0x2) c.binary.push(Buffer.from(payload));
          else if (opcode === 0x1) c.text.push(payload.toString('utf8'));
          else if (opcode === 0x8) {
            c.closed = true;
            c.closeReason = len > 2 ? payload.subarray(2).toString('utf8') : '';
          } else if (opcode === 0x9) socket.write(maskFrame(Buffer.from(payload), 0xA));
          buf = buf.subarray(off + len);
        }
      });
      socket.on('close', () => { c.closed = true; });
      resolve(c);
    });
    req.on('response', (r) => reject(new Error('upgrade refused: HTTP ' + r.statusCode)));
    req.on('error', reject);
    req.end();
  });
}

// ── A WebM stream, shaped like the ones this host will actually carry ──────
//
// The structure is copied from real Chrome MediaRecorder output captured on
// this machine: a Segment with UNKNOWN size, Clusters with UNKNOWN size, and
// frames wrapped in BlockGroup rather than SimpleBlock — with a
// ReferenceBlock on everything except the first frame of each cluster. Every
// one of those details broke a first version of the parser.

const UNKNOWN_SIZE = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

function sizeVint(n: number): Buffer {
  if (n < 0x7f) return Buffer.from([0x80 | n]);
  if (n < 0x3fff) return Buffer.from([0x40 | (n >> 8), n & 0xff]);
  return Buffer.from([0x20 | (n >> 16), (n >> 8) & 0xff, n & 0xff]);
}
function el(id: number[], payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id), sizeVint(payload.length), payload]);
}
function openEl(id: number[]): Buffer {
  return Buffer.concat([Buffer.from(id), UNKNOWN_SIZE]);
}

/** A Block for track 1: [track vint][int16 timecode][flags][data] */
function block(ms: number, bytes: number): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0x81;                       // track number 1
  head.writeInt16BE(ms, 1);
  head[3] = 0;
  return Buffer.concat([head, Buffer.alloc(bytes, 0x42)]);
}

export function webmHeader(): Buffer {
  return Buffer.concat([
    el([0x1a, 0x45, 0xdf, 0xa3], Buffer.from([0x42, 0x86, 0x81, 0x01])),   // EBML
    openEl([0x18, 0x53, 0x80, 0x67]),                                       // Segment, unknown size
    el([0x15, 0x49, 0xa9, 0x66], Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40])), // Info
    el([0x16, 0x54, 0xae, 0x6b], el([0xae], Buffer.concat([               // Tracks
      el([0xd7], Buffer.from([1])),          // TrackNumber 1
      el([0x83], Buffer.from([1])),          // TrackType 1 = video
    ]))),
  ]);
}

/** One cluster: a keyframe group, then `follow` groups that reference it. */
export function webmCluster(timecode: number, follow = 2, bytes = 300): Buffer {
  const parts = [
    openEl([0x1f, 0x43, 0xb6, 0x75]),                    // Cluster, unknown size
    el([0xe7], Buffer.from([timecode & 0xff])),          // Timecode
    el([0xa0], el([0xa1], block(0, bytes))),             // BlockGroup, no ReferenceBlock => keyframe
  ];
  for (let i = 1; i <= follow; i++) {
    parts.push(el([0xa0], Buffer.concat([
      el([0xa1], block(i * 33, bytes)),
      el([0xfb], Buffer.from([0x01])),                   // ReferenceBlock => not a keyframe
    ])));
  }
  return Buffer.concat(parts);
}
