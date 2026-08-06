// Producer keys: Ed25519 via node:crypto, nothing else.
//
// The producer key signs epoch blocks and does only that. It is NOT value
// custody — this codebase still holds no wallet and no spendable key, and the
// deliberate property established for paid placements (HOSTING.md) is
// untouched: a signature over a public record is not money.
//
// The private key lives beside the log it attests (server-data/chain/), which
// is already the directory that must never be published or synced into
// site/. The public key travels in every block as the raw 32-byte point,
// base64url — the same representation a JWK carries, so verification needs
// no DER parsing anywhere.

import {
  generateKeyPairSync, createPrivateKey, createPublicKey,
  sign as edSign, verify as edVerify,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function keyFromPem(pem) {
  const privateKey = createPrivateKey(pem);
  const pub = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  return { privateKey, pub };
}

export function loadOrCreateProducerKey(pemPath) {
  if (existsSync(pemPath)) return keyFromPem(readFileSync(pemPath, 'utf8'));
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  mkdirSync(dirname(pemPath), { recursive: true });
  writeFileSync(pemPath, pem, { mode: 0o600 });
  return keyFromPem(pem);
}

export function signDigest(privateKey, hexDigest) {
  return edSign(null, Buffer.from(hexDigest, 'hex'), privateKey).toString('base64url');
}

export function verifyDigest(pubB64u, hexDigest, sigB64u) {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pubB64u }, format: 'jwk' });
    return edVerify(null, Buffer.from(hexDigest, 'hex'), key, Buffer.from(sigB64u, 'base64url'));
  } catch {
    return false;
  }
}
