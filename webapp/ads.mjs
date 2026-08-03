// Paid placements — deliberately outside the protocol.
//
// This network's whole claim is that influence is transported commitment, not
// attention. Advertising is attention bought with money, so the only honest
// way to have it here is to keep it structurally incapable of touching the
// thing being claimed. An ad therefore:
//
//   - is NOT an act. It mints no node, appends nothing to the log, and costs
//     no θ. The act log stays a record of what participants did.
//   - has NO standing, and can never acquire any. It is not in the graph, so
//     no path reaches it, so no feed score exists for it.
//   - cannot be reacted to, commented on, tagged or quoted through the
//     protocol, because there is no node to name.
//   - is always labelled as paid, in the interface and in this API.
//
// If any of that stops being true, the network's central claim becomes
// marketing copy. It lives in its own file, in its own storage, for exactly
// that reason: the separation should be visible, not remembered.
//
// ── Targeting, and the one line it must not cross ─────────────────────────
//
// An advertiser picks WHERE (which tab) and WHAT SUBJECT (which commons tags).
// Both are matched IN THE READER'S BROWSER, against the act log that browser
// already holds — because everything here is public, the client can answer
// "have I engaged with #photography?" without anyone telling the server who it
// is. So:
//
//   - no profile is built anywhere, server-side or otherwise;
//   - the host never learns which reader matched which advert;
//   - the reader can see exactly why they were shown something, and the card
//     says so;
//   - it keeps working in the offline sandbox, where there is no server at all.
//
// The line it must not cross: the address watcher exists for abuse control and
// is never a targeting input. Targeting people by where they connect from is
// precisely the surveillance business this network is an argument against, and
// the IP data is deliberately kept where no advertising code can reach it.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

// ── Bitcoin address validation ────────────────────────────────────────────
// A mistyped address is not a rejected payment, it is money sent into a void
// nobody holds the key to. Both encodings carry a checksum precisely so this
// is checkable before anyone pays, so it is checked.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58checkOk(addr) {
  let num = 0n;
  for (const ch of addr) {
    const i = B58.indexOf(ch);
    if (i < 0) return false;
    num = num * 58n + BigInt(i);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let bytes = Buffer.from(hex, 'hex');
  // Leading '1's are leading zero bytes that BigInt cannot carry.
  let pad = 0;
  for (const ch of addr) { if (ch === '1') pad++; else break; }
  bytes = Buffer.concat([Buffer.alloc(pad), bytes]);
  if (bytes.length !== 25) return false;
  const body = bytes.subarray(0, 21);
  const sum = createHash('sha256').update(createHash('sha256').update(body).digest()).digest();
  return bytes.subarray(21).equals(sum.subarray(0, 4));
}

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32PolymodOk(addr, constant) {
  const pos = addr.lastIndexOf('1');
  if (pos < 1 || pos + 7 > addr.length) return false;
  const hrp = addr.slice(0, pos);
  const data = [];
  for (const ch of addr.slice(pos + 1)) {
    const i = BECH32.indexOf(ch);
    if (i < 0) return false;
    data.push(i);
  }
  const values = [];
  for (const c of hrp) values.push(c.charCodeAt(0) >> 5);
  values.push(0);
  for (const c of hrp) values.push(c.charCodeAt(0) & 31);
  values.push(...data);
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk === constant;
}

/** True only for an address whose own checksum verifies. */
export function validBtcAddress(addr) {
  if (typeof addr !== 'string') return false;
  const a = addr.trim();
  if (a.length < 26 || a.length > 90) return false;
  if (/^(bc1|tb1)/i.test(a)) {
    const low = a.toLowerCase();
    if (a !== low && a !== a.toUpperCase()) return false; // mixed case is invalid
    // bech32 (v0, constant 1) or bech32m (v1+/taproot, constant 0x2bc830a3)
    return bech32PolymodOk(low, 1) || bech32PolymodOk(low, 0x2bc830a3);
  }
  if (/^[13mn2]/.test(a)) return base58checkOk(a);
  return false;
}

// ── Storage: its own file, never the act log ──────────────────────────────
const PLACEMENTS = ['feed', 'live', 'record'];
const MAX_TEXT = 280;
const MAX_ADS = 500;

export { PLACEMENTS };

export function createAdStore(file, opts = {}) {
  const priceSatsPerDay = Math.max(1, Number(opts.priceSatsPerDay) || 20000);
  let ads = [];
  try { ads = JSON.parse(readFileSync(file, 'utf8')); } catch { ads = []; }
  if (!Array.isArray(ads)) ads = [];

  function save() {
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(ads, null, 2));
    renameSync(tmp, file);
  }

  const now = () => Date.now();

  /**
   * One address, many advertisers: each ad is quoted a price with a unique
   * few-hundred-sat offset, so an incoming payment identifies which ad it
   * settles. This is how a small merchant does it without deriving a fresh
   * address per invoice from an xpub, and it needs no key material at all —
   * the host never holds a private key, only an address to display.
   */
  function quote(days, seq) {
    const base = priceSatsPerDay * days;
    return base + (seq % 997) + 1;
  }

  function publicView(a) {
    return {
      id: a.id, text: a.text, url: a.url, label: 'paid placement',
      // Sent to every reader, matched by none of them on the server. The
      // browser decides whether this applies to it, which is why nobody has to
      // be identified for targeting to work.
      placement: a.placement || [],
      tags: a.tags || [],
      startsAt: a.startsAt, endsAt: a.endsAt,
      note: 'Paid, not earned. This is not an act: it has no standing, no place in the graph and no effect on any feed score. Nothing here can be bought with money except this box.',
    };
  }

  function expire() {
    let changed = false;
    for (const a of ads) {
      if (a.status === 'live' && a.endsAt && a.endsAt < now()) { a.status = 'expired'; changed = true; }
      if (a.status === 'paid' && a.startsAt && a.startsAt <= now()) { a.status = 'live'; changed = true; }
    }
    if (changed) save();
  }

  return {
    /** What the app renders. Live ads only, no advertiser details. */
    live() {
      expire();
      return ads.filter((a) => a.status === 'live').map(publicView);
    },

    /** Everything, for the operator. */
    all() { expire(); return ads.slice(); },

    get(id) { return ads.find((a) => a.id === id) || null; },

    submit({ text, url, days, contact, placement: wantPlacement, tags: wantTags }, address) {
      if (!address) {
        return { error: 'this instance is not accepting paid placements — the operator has set no payment address' };
      }
      const t = String(text ?? '').trim();
      const u = String(url ?? '').trim();
      const d = Math.min(90, Math.max(1, Math.floor(Number(days) || 7)));
      if (!t) return { error: 'the advert needs text' };
      if (t.length > MAX_TEXT) return { error: 'advert text is ' + t.length + ' characters; the limit is ' + MAX_TEXT };
      if (!/^https?:\/\/[^\s]+$/i.test(u)) return { error: 'url must be a plain http(s) link' };
      if (u.length > 300) return { error: 'url is ' + u.length + ' characters; the limit is 300' };
      if (ads.length >= MAX_ADS) return { error: 'the advert queue is full' };
      // Placement: which tabs. Empty means everywhere.
      const places = Array.isArray(wantPlacement) ? wantPlacement : [];
      const placement = places
        .map((x) => String(x).toLowerCase().trim())
        .filter((x) => PLACEMENTS.includes(x));
      if (places.length && !placement.length) {
        return { error: 'placement must be any of: ' + PLACEMENTS.join(', ') };
      }
      // Subject: commons tags the reader has engaged with. Names only — the
      // matching happens in their browser, and the host never learns the answer.
      const rawTags = Array.isArray(wantTags) ? wantTags : [];
      const tags = [];
      for (const t of rawTags.slice(0, 6)) {
        const clean = String(t).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20);
        if (clean && !tags.includes(clean)) tags.push(clean);
      }
      const seq = ads.length + 1;
      const id = 'ad' + seq + '-' + createHash('sha256').update(seq + ':' + t + ':' + u).digest('hex').slice(0, 8);
      const ad = {
        id, text: t, url: u, days: d,
        placement, tags,
        contact: String(contact ?? '').slice(0, 120),
        priceSats: quote(d, seq),
        address,
        status: 'pending',      // pending -> approved -> paid -> live -> expired
        createdAt: now(),
        paidAt: null, startsAt: null, endsAt: null,
        reviewNote: '',
      };
      ads.push(ad);
      save();
      return { ad };
    },

    /** Operator decisions. Approval is a human reading the text, on purpose. */
    review(id, action, note) {
      const a = ads.find((x) => x.id === id);
      if (!a) return { error: 'no advert with id ' + id };
      if (action === 'approve') {
        if (a.status !== 'pending') return { error: 'advert ' + id + ' is ' + a.status + ', not pending' };
        a.status = 'approved';
      } else if (action === 'reject') {
        a.status = 'rejected';
      } else if (action === 'paid') {
        if (a.status !== 'approved') return { error: 'approve advert ' + id + ' before marking it paid — it is ' + a.status };
        a.status = 'paid';
        a.paidAt = now();
        a.startsAt = now();
        a.endsAt = now() + a.days * 86400_000;
      } else if (action === 'stop') {
        a.status = 'expired';
        a.endsAt = now();
      } else {
        return { error: 'unknown action: ' + action };
      }
      if (typeof note === 'string') a.reviewNote = note.slice(0, 300);
      save();
      return { ad: a };
    },

    /** Amounts the operator is waiting for, so a payment can be matched. */
    awaiting() {
      return ads.filter((a) => a.status === 'approved')
        .map((a) => ({ id: a.id, priceSats: a.priceSats, since: a.createdAt }));
    },

    stats() {
      expire();
      const by = {};
      for (const a of ads) by[a.status] = (by[a.status] ?? 0) + 1;
      const earned = ads.filter((a) => a.paidAt).reduce((s, a) => s + a.priceSats, 0);
      return { total: ads.length, byStatus: by, satsSettled: earned, priceSatsPerDay };
    },
  };
}
