// Passkeys: the only credential here that cannot be guessed, phished or
// cracked from the public log.
//
// A PIN is a shared secret whose hash is published. Slowing the hash raises the
// price of guessing it; it does not change the fact that four digits is ten
// thousand possibilities. A passkey is different in kind: the private half
// never leaves the device, the public half is useless to an attacker who has
// it, and the browser will not release a signature to a site that is not the
// one the key was made for — so it survives a convincing fake login page, which
// no PIN and no authenticator code does.
//
// What the user does: Face ID, a fingerprint, or their device unlock. That is
// the whole interaction, which is why it is the right default to offer.
//
// Verification is deliberately hand-written and small. This host has no
// dependencies, and the parts of WebAuthn that matter for signing in are a
// CBOR walk, a SHA-256, and one signature check.
import { createHash, createVerify, createPublicKey, randomBytes, timingSafeEqual, verify as edVerify } from 'node:crypto';

const b64urlToBuf = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const bufToB64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ── Minimal CBOR: enough to walk an attestation object and a COSE key ──────
function cborDecode(buf, offset = 0) {
  const first = buf[offset];
  const major = first >> 5;
  const minor = first & 31;
  let len = minor;
  let pos = offset + 1;
  if (minor === 24) { len = buf[pos]; pos += 1; }
  else if (minor === 25) { len = buf.readUInt16BE(pos); pos += 2; }
  else if (minor === 26) { len = buf.readUInt32BE(pos); pos += 4; }
  else if (minor === 27) { len = Number(buf.readBigUInt64BE(pos)); pos += 8; }

  switch (major) {
    case 0: return { value: len, pos };
    case 1: return { value: -1 - len, pos };
    case 2: return { value: buf.subarray(pos, pos + len), pos: pos + len };
    case 3: return { value: buf.subarray(pos, pos + len).toString('utf8'), pos: pos + len };
    case 4: {
      const arr = [];
      for (let i = 0; i < len; i++) { const r = cborDecode(buf, pos); arr.push(r.value); pos = r.pos; }
      return { value: arr, pos };
    }
    case 5: {
      const map = new Map();
      for (let i = 0; i < len; i++) {
        const k = cborDecode(buf, pos); pos = k.pos;
        const v = cborDecode(buf, pos); pos = v.pos;
        map.set(k.value, v.value);
      }
      return { value: map, pos };
    }
    case 7:
      if (minor === 20) return { value: false, pos };
      if (minor === 21) return { value: true, pos };
      if (minor === 22) return { value: null, pos };
      return { value: null, pos };
    default:
      throw new Error('unsupported CBOR major type ' + major);
  }
}

// ── COSE public key → SPKI, so node's verifier can use it ─────────────────
const DER = {
  seq: (...p) => tlv(0x30, Buffer.concat(p)),
  bitstr: (b) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), b])),
  oid: (b) => tlv(0x06, Buffer.from(b)),
  int: (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0x00]), v]);
    return tlv(0x02, v);
  },
};
function tlv(tag, body) {
  const len = body.length;
  let lenBuf;
  if (len < 0x80) lenBuf = Buffer.from([len]);
  else if (len < 0x100) lenBuf = Buffer.from([0x81, len]);
  else lenBuf = Buffer.from([0x82, len >> 8, len & 0xff]);
  return Buffer.concat([Buffer.from([tag]), lenBuf, body]);
}

const OID_EC = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];       // 1.2.840.10045.2.1
const OID_P256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_ED25519 = [0x2b, 0x65, 0x70];                            // 1.3.101.112

/** COSE key (as stored) → a node KeyObject, or null if the algorithm is one we do not take. */
function coseToKey(cose) {
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty === 2 && alg === -7) {                    // EC2 / ES256 / P-256
    const x = cose.get(-2), y = cose.get(-3);
    if (!x || !y || x.length !== 32 || y.length !== 32) return null;
    const point = Buffer.concat([Buffer.from([0x04]), x, y]);
    const spki = DER.seq(DER.seq(DER.oid(OID_EC), DER.oid(OID_P256)), DER.bitstr(point));
    return { key: createPublicKey({ key: spki, format: 'der', type: 'spki' }), alg: 'ES256' };
  }
  if (kty === 1 && alg === -8) {                    // OKP / EdDSA / Ed25519
    const x = cose.get(-2);
    if (!x || x.length !== 32) return null;
    const spki = DER.seq(DER.seq(DER.oid(OID_ED25519)), DER.bitstr(x));
    return { key: createPublicKey({ key: spki, format: 'der', type: 'spki' }), alg: 'EdDSA' };
  }
  return null; // RS256 and the rest: refused rather than half-supported
}

/** WebAuthn's raw (r‖s) ECDSA signature → the DER form node expects. */
function rawSigToDer(sig) {
  if (sig.length !== 64) return sig; // already DER, or Ed25519
  return DER.seq(DER.int(sig.subarray(0, 32)), DER.int(sig.subarray(32)));
}

function parseAuthData(buf) {
  if (buf.length < 37) return null;
  const rpIdHash = buf.subarray(0, 32);
  const flags = buf[32];
  const signCount = buf.readUInt32BE(33);
  const out = { rpIdHash, flags, signCount, userPresent: !!(flags & 0x01), userVerified: !!(flags & 0x04) };
  if (flags & 0x40) {                                  // attested credential data
    const credIdLen = buf.readUInt16BE(53);
    out.credId = buf.subarray(55, 55 + credIdLen);
    const rest = buf.subarray(55 + credIdLen);
    out.cose = cborDecode(rest).value;
  }
  return out;
}

/**
 * Read a registration response and return what must be stored.
 *
 * The attestation statement is deliberately ignored: it says which brand of
 * authenticator this is, which matters to an enterprise deciding whose
 * hardware to trust and not at all to a test network deciding whether someone
 * can sign in later. What matters is the credential id and its public key.
 */
export function readRegistration({ clientDataJSON, attestationObject }, { challenge, origin, rpId }) {
  let clientData;
  try { clientData = JSON.parse(b64urlToBuf(clientDataJSON).toString('utf8')); }
  catch { return { error: 'unreadable client data' }; }
  if (clientData.type !== 'webauthn.create') return { error: 'wrong ceremony type' };
  if (clientData.challenge !== challenge) return { error: 'challenge does not match — this response is for a different request' };
  if (origin && clientData.origin !== origin) return { error: 'origin mismatch: ' + clientData.origin };

  let att;
  try { att = cborDecode(b64urlToBuf(attestationObject)).value; }
  catch { return { error: 'unreadable attestation object' }; }
  const authData = parseAuthData(att.get('authData'));
  if (!authData || !authData.cose) return { error: 'no credential in the response' };
  if (!authData.userPresent) return { error: 'the authenticator reported nobody was there' };

  const expectRp = createHash('sha256').update(rpId, 'utf8').digest();
  if (!authData.rpIdHash.equals(expectRp)) return { error: 'this credential belongs to a different site' };

  const parsed = coseToKey(authData.cose);
  if (!parsed) return { error: 'unsupported key type — this host takes ES256 or Ed25519 passkeys' };

  // Store the COSE key bytes rather than a parsed object: it is what the
  // authenticator actually said, and re-parsing it later is cheap.
  const coseEntries = [];
  for (const [k, v] of authData.cose) coseEntries.push([k, Buffer.isBuffer(v) ? bufToB64url(v) : v]);
  return {
    credId: bufToB64url(authData.credId),
    cose: coseEntries,
    signCount: authData.signCount,
    userVerified: authData.userVerified,
  };
}

function restoreCose(entries) {
  const m = new Map();
  for (const [k, v] of entries) m.set(k, typeof v === 'string' ? b64urlToBuf(v) : v);
  return m;
}

/**
 * Verify a sign-in. Returns null when it is genuine, or a sentence.
 *
 * The signature covers authenticatorData ‖ sha256(clientDataJSON), and the
 * client data carries the challenge and the origin — which is exactly why a
 * passkey cannot be phished: a page on another origin gets a signature the
 * real site will refuse.
 */
export function verifyAssertion(resp, stored, { challenge, origin, rpId }) {
  let clientData;
  try { clientData = JSON.parse(b64urlToBuf(resp.clientDataJSON).toString('utf8')); }
  catch { return 'unreadable client data'; }
  if (clientData.type !== 'webauthn.get') return 'wrong ceremony type';
  const want = Buffer.from(challenge), got = Buffer.from(String(clientData.challenge));
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    return 'challenge does not match — a replayed or stale sign-in';
  }
  if (origin && clientData.origin !== origin) return 'origin mismatch: ' + clientData.origin;

  const authDataBuf = b64urlToBuf(resp.authenticatorData);
  const authData = parseAuthData(authDataBuf);
  if (!authData) return 'unreadable authenticator data';
  if (!authData.userPresent) return 'the authenticator reported nobody was there';
  const expectRp = createHash('sha256').update(rpId, 'utf8').digest();
  if (!authData.rpIdHash.equals(expectRp)) return 'this credential belongs to a different site';

  const parsed = coseToKey(restoreCose(stored.cose));
  if (!parsed) return 'stored key is unusable';

  const signed = Buffer.concat([authDataBuf, createHash('sha256').update(b64urlToBuf(resp.clientDataJSON)).digest()]);
  const sig = b64urlToBuf(resp.signature);

  let ok = false;
  try {
    if (parsed.alg === 'EdDSA') {
      ok = edVerify(null, signed, parsed.key, sig);
    } else {
      const v = createVerify('SHA256');
      v.update(signed);
      v.end();
      ok = v.verify(parsed.key, rawSigToDer(sig));
    }
  } catch { return 'signature could not be checked'; }
  if (!ok) return 'signature does not verify';

  // A counter that goes backwards means the credential was cloned. Many real
  // authenticators (Apple's included) always report zero, so a zero counter is
  // not evidence of anything and must not be treated as one.
  if (authData.signCount > 0 && stored.signCount > 0 && authData.signCount <= stored.signCount) {
    return 'this passkey replayed an old counter, which is what a cloned credential looks like';
  }
  return null;
}

export { bufToB64url, b64urlToBuf };
export const newChallenge = () => bufToB64url(randomBytes(32));
