/**
 * Test helpers for the shared replay.
 *
 * `replay.cjs` is the one file the browser page and the host both run, so it is
 * where every regression this project has shipped ended up living. These
 * helpers build small act logs by hand, because a fixture that mirrors the live
 * network would only prove that today's data still behaves like today's data.
 */
import { createRequire } from 'node:module';
import * as engine from '../../src/engine/bundle-entry';

const require = createRequire(import.meta.url);
// .cjs, loaded through createRequire: the package is type:module, so a plain
// import would treat it as ESM and the UMD export branch would never run.
const { create } = require('../../social/replay.cjs') as {
  create: (e: unknown) => { replay: (acts: unknown[]) => WorldState };
};

export interface WorldState {
  g: { nodes: Map<string, { id: string; kind: string; label: string }>; edges: Edge[]; incoming(id: string): Edge[] };
  ledgers: Array<{ id: string; burnBal: number; actCount: number; deleted?: boolean }>;
  ledgerById: Record<string, { id: string; burnBal: number; actCount: number; deleted?: boolean }>;
  handles: Record<string, string>;
  creators: Record<string, string>;
  payloads: Record<string, string>;
  postMeta: Record<string, { idx: number; ts?: number; edited?: boolean; stream?: boolean; comment?: boolean }>;
  chron: Array<{ who: string | null; line: string; to?: string; refs?: Array<{ label: string; id: string }> }>;
  dms: Array<{ from: string; to: string; text: string; call?: unknown; idx: number }>;
  xById: Record<string, number>;
  epochHistory: Array<{ epoch: number; acts: number; stamp: number; headroom: number; pass: boolean }>;
  deleted: Record<string, boolean>;
  epochNow: number;
}
interface Edge { id: string; family: string; src: string; tgt: string; pd: number; pi: number; appendIndex: number; weight: number; sign: number; tau: number }

const R = create(engine);
export const replay = (acts: unknown[]): WorldState => R.replay(acts);

/** Two actors with enough reserve to act, and nothing else. */
export function seed(...ids: string[]): Record<string, unknown>[] {
  const acts: Record<string, unknown>[] = [{ t: 'seedWorld' }];
  for (const id of ids) {
    acts.push({ t: 'register', id: `u_${id}`, handle: id, seed: 1, epoch: 0 });
    // A proven Bitcoin burn, because registering now opens an account at
    // exactly zero — the grant it used to hand out was invented value, and
    // the faucet that replaced it is closed. Reserve comes from destroyed
    // bitcoin or from nowhere, in fixtures as on the live network.
    // 30,000 sat at 100 sat per unit is 300 reserve: room to act freely in
    // a short test without any fixture thinking about the price of speech.
    acts.push({ t: 'btcBurn', id: `u_${id}`, sats: 30000, addr: 'bc1qdead',
      txid: `seed${id}`.padEnd(32, '0').split('')
        .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').slice(0, 64).padEnd(64, 'e') });
  }
  return acts;
}

/** Every actor's standing, rounded to a comparable precision. */
export function standings(st: WorldState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of Object.keys(st.xById).sort()) out[id] = +st.xById[id].toFixed(9);
  return out;
}

/** The content ids that carry readable text, in order. */
export function contentIds(st: WorldState): string[] {
  return Object.keys(st.payloads).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}
