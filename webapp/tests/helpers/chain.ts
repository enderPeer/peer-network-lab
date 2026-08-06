/**
 * Test seam for the epoch chain.
 *
 * The chain modules are plain .mjs (they run on the host with zero deps), so
 * they are imported natively by absolute file URL and typed here, once — the
 * same discipline world.ts applies to replay.cjs: cast at the seam, nowhere
 * else. Keys are generated fresh per call; a fixture key checked into a repo
 * would be a producer key with a public private half.
 */
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import * as engine from '../../src/engine/bundle-entry';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const replayMod = require('../../social/replay.cjs') as {
  create: (e: unknown) => { replay: (acts: unknown[]) => any; parseMentions: (text: string, handles: Record<string, string>) => string[] };
};

export const R = replayMod.create(engine);

export type Block = Record<string, any>;
interface ChainApi {
  buildBlocks(opts: Record<string, unknown>): { blocks: Block[]; sealed: number; pendingActs: number };
  verifyChain(opts: Record<string, unknown>): {
    ok: boolean; height: number; tombstoned: number;
    blocks: Array<{ height: number; ok: boolean; notes: string[]; tombstoned?: number }>;
    errors: string[]; warnings: string[];
  };
  findEpochCloses(acts: unknown[]): Array<{ idx: number; epoch: number }>;
}

const load = (f: string) => import(pathToFileURL(join(here, '..', '..', 'chain', f)).href);
export const chainMod = (await load('chain.mjs')) as ChainApi;
export const blockMod = (await load('block.mjs')) as {
  blockHash(b: Block): string; verifyBlockSignature(b: Block): boolean;
};
export const canonicalMod = (await load('canonical.mjs')) as {
  canonical(v: unknown): string; quantize(x: number): number;
};
const keysMod = (await load('keys.mjs')) as {
  keyFromPem(pem: string): { privateKey: unknown; pub: string };
};

export function newKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return keysMod.keyFromPem(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
}

export const EDITIONS = { engine: 'test-engine-edition', replay: 'test-replay-edition' };
export const CONSTANTS = {
  theta: (engine as { THETA: number }).THETA, nu: (engine as { NU: number }).NU,
  tokEpoch: 5000, tokDecay: 0.9, tokYear: 365, tokCap: 18250000, quantum: 1e-9,
};

/** Seal a chain over a FILE act log (no seedWorld line — the chain prepends its own). */
export function build(fileActs: unknown[], key = newKey(), existing: Block[] = []) {
  return chainMod.buildBlocks({ fileActs, R, editions: EDITIONS, constants: CONSTANTS, key, existing });
}

export function verify(fileActs: unknown[], blocks: Block[], opts: Record<string, unknown> = {}) {
  return chainMod.verifyChain({ fileActs, blocks, R, editions: EDITIONS, ...opts });
}
