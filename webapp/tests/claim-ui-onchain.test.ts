// The claim button, executed by the contract it is claiming from.
//
// Everything else about a claim is checked somewhere: earnings.mjs has its own
// tests for the tree, epoch-onchain.test.ts drives PeerClaim directly with
// proofs built in JS. What NOTHING checked until now is the seam between them
// — the calldata the PAGE hand-encodes. That seam is the likeliest thing to
// drift and the least likely to be noticed, because it breaks silently: the
// tree is right, the contract is right, and every claim reverts.
//
// It is a seam worth this much machinery because the encoding is unusual.
// chain/merkle.mjs hashes position-dependently (N+left+right is not
// N+right+left), so a proof has to carry direction, and claim(uint256,
// uint256, bytes32[]) has nowhere to put it except the array — so proof[0] is
// a PATH WORD, not a hash, and the siblings follow it bottom-first, with
// carried-up levels contributing none. A hand-written encoder gets that wrong
// in a dozen quiet ways, none of which a type checker or a unit test on either
// side would catch.
//
// So this test builds a real distribution into a real tree, deploys the real
// compiled PeerToken and PeerClaim on a real EVM, loads the BUILT page, wires
// its window.ethereum to that EVM, and presses the button. The assertion is a
// token balance: the leaf amount, to the wei, moved by the page's own bytes.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { createVM } from '@ethereumjs/vm';
import { createBlock } from '@ethereumjs/block';
import { createAddressFromString, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { replay } from './helpers/world';

const here = (p: string) => new URL(p, import.meta.url);
const tokenBuild = JSON.parse(fs.readFileSync(here('../chain-l2/PeerToken.build.json'), 'utf8'));
const claimBuild = JSON.parse(fs.readFileSync(here('../chain-l2/PeerClaim.build.json'), 'utf8'));

const uint = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a: string) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const NOW = 1800000000n;
const AL = '0x' + 'a'.repeat(40);
const BO = '0x' + 'b1'.repeat(20);

/** The act log both the page and this test replay. Two earners, so the proof
 *  carries a real sibling and a real path bit rather than the degenerate
 *  single-word case a broken encoder would still pass. */
function log() {
  const acts: any[] = [{ t: 'seedWorld' }];
  // The txid has to be real hex: a burn with a malformed txid is refused, the
  // account never gets reserve, its reactions never land, and the epoch
  // distributes nothing — which looks exactly like a broken claim card.
  ['al', 'bo', 'cy', 'di'].forEach((id, i) => {
    acts.push({ t: 'register', id: 'u_' + id, handle: id, seed: 1, epoch: 0 });
    acts.push({ t: 'btcBurn', id: 'u_' + id, sats: 60000, addr: 'bc1qdead', txid: (i + 1).toString(16).padStart(64, '0') });
  });
  acts.push({ t: 'bindAddress', id: 'u_al', addr: AL });
  acts.push({ t: 'bindAddress', id: 'u_bo', addr: BO });
  acts.push({ t: 'post', author: 'u_al', text: 'A', a: 0.8, rmen: [] });   // c1
  acts.push({ t: 'post', author: 'u_bo', text: 'B', a: 0.8, rmen: [] });   // c2
  acts.push({ t: 'opinion', author: 'u_cy', target: 'c1', p: 0.8, r: 0.8 });
  acts.push({ t: 'opinion', author: 'u_di', target: 'c1', p: 0.8, r: 0.8 });
  acts.push({ t: 'opinion', author: 'u_cy', target: 'c2', p: 0.8, r: 0.8 });
  acts.push({ t: 'closeEpoch', epoch: 1 });
  return acts;
}

/** Everything standing up: tree, chain, contracts, funded epoch. */
async function world(acts: any[]) {
  const { earningsTree } = await import(here('../chain/earnings.mjs').href);
  // The distribution comes from the SAME replay the page runs, not from a
  // number written here. A hand-written one would drift from the engine and
  // the card — which cross-checks the two — would refuse before the encoder
  // was ever exercised, quietly turning this into a test of nothing.
  const st: any = replay(acts);
  const dist = (st.tokens.dist as any[]).find((d) => d.epoch === 1);
  expect(dist, 'epoch 1 must have distributed something').toBeTruthy();
  expect(Object.keys(dist.to).sort()).toEqual(['u_al', 'u_bo']);
  const tree = earningsTree(dist, { u_al: AL, u_bo: BO });
  expect(tree.leaves.length, 'two leaves, so the proof has a sibling').toBe(2);
  const leaf = tree.leaves.find((l: any) => l.address === AL.toLowerCase());
  const proof = tree.proofs[leaf.address];

  const vm = await createVM();
  const evm = vm.evm;
  const block = createBlock({ header: { number: 1n, timestamp: NOW } });
  const steward = createAddressFromString('0x' + '5'.repeat(40));
  const run = async (from: any, to: any, dataHex: string) => {
    const r = await evm.runCall({
      caller: from, origin: from, to, block,
      data: hexToBytes(dataHex.startsWith('0x') ? dataHex : '0x' + dataHex),
      gasLimit: 50000000n,
    });
    return {
      ok: !r.execResult.exceptionError,
      ret: r.execResult.returnValue,
      created: r.createdAddress,
    };
  };
  const deploy = async (bytecode: string, args: string) => {
    const r = await run(steward, undefined, bytecode + args);
    if (!r.ok || !r.created) throw new Error('deploy failed');
    return r.created;
  };
  const peer = await deploy(tokenBuild.bytecode, uint(18250000n));
  const claimC = await deploy(claimBuild.bytecode, addrWord(peer.toString()) + addrWord(steward.toString()));
  const SEL = claimBuild.hashes;
  const until = NOW + 30n * 86400n;
  await run(steward, peer, '0x095ea7b3' + addrWord(claimC.toString()) + uint(tree.total));
  const opened = await run(steward, claimC, '0x' + SEL['openEpoch(uint256,bytes32,uint256,uint64)']
    + uint(1n) + String(tree.root).padStart(64, '0') + uint(tree.total) + uint(until));
  expect(opened.ok, 'the epoch must open, or nothing downstream means anything').toBe(true);

  const balOf = async (a: string) =>
    BigInt(bytesToHex((await run(steward, peer, '0x70a08231' + addrWord(a))).ret) || '0x0');
  return { tree, leaf, proof, run, peer, claimC, steward, until, balOf };
}

/** The built page, its wallet answering from that EVM. */
function page(w: any, acts: any[], claimBody: any, sent: string[][]) {
  const source = fs.readFileSync(here('../public/peer-social-preview.html'), 'utf8');
  const body = acts.map((a) => JSON.stringify(a)).join('\n') + '\n';
  const errors: string[] = [];

  const dom = new JSDOM(source, {
    runScripts: 'dangerously', url: 'https://peer.test/', pretendToBeVisual: true,
    beforeParse(win: any) {
      win.fetch = (url: any) => {
        const u = String(url);
        if (u.includes('archive/manifest.json')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ acts: acts.length, sha256: 'x'.repeat(64), at: Date.now() }) });
        if (u.includes('archive/acts.jsonl')) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
        if (u.includes('/api/v1/epoch/1/claim')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(claimBody) });
        if (u.includes('/api/v1/epoch/')) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ code: 'EPOCH_NOT_CLOSED', error: 'nothing distributed in that epoch' }) });
        return Promise.reject(new Error('offline'));
      };
      const from = createAddressFromString(AL);
      win.ethereum = {
        on() {},
        async request({ method, params }: any) {
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [AL];
          if (method === 'eth_chainId') return '0x2105';
          if (method === 'eth_call') {
            sent.push(['call', params[0].data]);
            return bytesToHex((await w.run(from, createAddressFromString(params[0].to), params[0].data)).ret);
          }
          if (method === 'eth_sendTransaction') {
            sent.push(['send', params[0].data]);
            win.__ok = (await w.run(from, createAddressFromString(params[0].to), params[0].data)).ok;
            return '0x' + 'd'.repeat(64);
          }
          if (method === 'eth_getTransactionReceipt') return { status: win.__ok ? '0x1' : '0x0' };
          return null;
        },
      };
      win.addEventListener('error', (e: any) => errors.push(String(e.message)));
      win.addEventListener('unhandledrejection', (e: any) => errors.push(String(e.reason)));
      win.localStorage.setItem('peer-sandbox-who-v2', JSON.stringify('u_al'));
      win.localStorage.setItem('peer-sandbox-mode-v1', JSON.stringify('geek'));
      win.localStorage.setItem('peer-sandbox-view-v1', JSON.stringify({ tab: 'econ', lqView: 'feed', econView: 'wallet' }));
    },
  });
  return { dom, errors };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hostAnswer(w: any, amount: bigint) {
  return {
    epoch: 1, root: w.tree.root, root0x: '0x' + w.tree.root,
    total: String(w.tree.total), totalPeer: w.tree.totalPeer, decimals: w.tree.decimals, minted: 4000,
    leafCount: w.tree.leaves.length, leaves: [], unbound: { count: 0, total: '0', totalPeer: 0, handles: [] },
    claimant: {
      as: 'u_al', address: w.leaf.address, handles: ['al'], index: w.leaf.index,
      amount: String(amount), peer: w.leaf.peer, leaf: w.leaf.hex,
      proof: w.proof.words, pathWord: w.proof.words[0], payable: true, call: 'PeerClaim.claim(...)',
    },
    claimantNote: null,
    onchain: {
      configured: true, contract: w.claimC.toString(), chainId: 8453, epoch: '1',
      opened: true, open: true, root: w.tree.root, totalRaw: String(w.tree.total), paidRaw: '0',
      remainingRaw: String(w.tree.total), claimUntil: Number(w.until), rootMatches: true,
    },
  };
}

async function pressClaim(dom: any) {
  const root = dom.window.document.getElementById('root');
  const find = (re: RegExp) => Array.from(root.querySelectorAll('button')).find((b: any) => re.test(b.textContent.trim())) as any;
  const conn = find(/^Connect a wallet$/); if (conn) { conn.click(); await settle(1500); }
  // Case-SENSITIVE, and it must name an amount. term() renders its glossary
  // chips as <button> too, so a loose /^claim/i matches "claim deadline" —
  // the hover next to the button — and then clicks a tooltip, sends nothing,
  // and reports a green "no gas spent" for entirely the wrong reason.
  const claim = find(/^Claim [\d,.]+ PEER$/);
  if (claim) { claim.click(); await settle(4000); }
  return { root, hadButton: !!claim };
}

describe('the claim button and the contract agree, byte for byte', () => {
  it('pays exactly the leaf amount, using calldata the page encoded itself', async () => {
    const acts = log();
    const w = await world(acts);
    expect(await w.balOf(AL), 'nobody is paid before the button').toBe(0n);
    const sent: string[][] = [];
    const { dom, errors } = page(w, acts, hostAnswer(w, w.leaf.amount), sent);
    await settle(2500);
    const { root, hadButton } = await pressClaim(dom);

    expect(hadButton, 'the card must offer a Claim button for a funded, open epoch').toBe(true);
    expect(errors, 'the page must not throw while claiming').toEqual([]);
    expect(root.textContent).toContain(AL);
    // The whole point: the money moved, and it moved by the page's own bytes.
    expect(await w.balOf(AL)).toBe(w.leaf.amount);
    expect(sent.some((c) => c[0] === 'send'), 'a claim must actually be sent').toBe(true);
    dom.window.close();
  }, 60000);

  it('spends no gas when the dry run says the claim would fail', async () => {
    const acts = log();
    const w = await world(acts);
    const sent: string[][] = [];
    // One wei more than the leaf commits to: the proof no longer verifies, and
    // checkClaim is supposed to catch that BEFORE anyone signs anything.
    const { dom } = page(w, acts, hostAnswer(w, w.leaf.amount + 1n), sent);
    await settle(2500);
    const { hadButton } = await pressClaim(dom);

    // Guard against passing vacuously: if the card never offered a button, the
    // "nothing was sent" assertion below would be true for the wrong reason.
    expect(hadButton, 'the card must still offer the button — this checks the dry run, not its absence').toBe(true);
    expect(sent.some((c) => c[0] === 'send'), 'a doomed claim must never reach eth_sendTransaction').toBe(false);
    expect(await w.balOf(AL), 'and must move nothing').toBe(0n);
    dom.window.close();
  }, 60000);
});
