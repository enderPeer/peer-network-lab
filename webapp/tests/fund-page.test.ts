// fund.html — the scoped epoch-funding page, pressed in emulation.
//
// setup.html funds every unopened epoch in one bound sequence; fund.html
// exists because the live network needed a CHOICE: an epoch whose only leaf
// pays a contract must never be opened, an epoch paying an address its handle
// abandoned needs a human decision, and an epoch paying only the steward is
// gas spent on a round trip. This test boots the page against a host modeled
// on the real one — one epoch of each kind — wires window.ethereum to a
// recorder, presses the button, and asserts the BYTES handed to MetaMask:
// the one approve for exactly the ticked sum, one openEpoch per ticked epoch
// with the right words in the right order, and nothing at all for the epochs
// the page must refuse.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const here = (p: string) => new URL(p, import.meta.url);
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STEWARD = '0x8af0e5f458d99a255092a3b6c9874dd153ab3714';
const TOKEN = '0x5d63786095d09210011fd382c0710a7a1bc90e6f';
const CLAIM = '0xb97d8bd33bc0dc83379b11edf0921750c9a29db8';
const EGO_NEW = '0xecc37e43a31b6030ad3f32ad6da815f5e862342f';
const EGO_OLD = '0xa96bc5bcfa7507c4205954156b38bef07c02ec3c';
const WREN = '0xff89242d1e9d1f367e4310d7f99aef9edbf0f82a';

const E18 = 10n ** 18n;
const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
const aword = (a: string) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const CHAIN_NOW = 1787000000;
const NINETY_DAYS = 90 * 24 * 3600;

// One epoch of each kind, contiguous from 1 — the page walks until a 404.
const mkRoot = (n: number) => n.toString(16).padStart(2, '0').repeat(32).slice(0, 64);
const EPOCHS: Record<number, any> = {
  1: { leaves: [], total: 0n },                                                  // nothing to claim
  2: { leaves: [[STEWARD, 100n * E18, ['u_ender']]], total: 100n * E18, openOnChain: true },
  3: { leaves: [[EGO_OLD, 5000n * E18, ['u_egoplayer']]], total: 5000n * E18 },  // stale binding
  4: { leaves: [[STEWARD, 15n * E18, ['u_ender']], [WREN, 25n * E18, ['u_wren']]], total: 40n * E18 },
  5: { leaves: [[STEWARD, 200n * E18, ['u_ender']]], total: 200n * E18 },        // steward round trip
  6: { leaves: [[TOKEN, 300n * E18, ['u_egoplayer']]], total: 300n * E18 },      // leaf pays a contract
  7: { leaves: [[STEWARD, 10n * E18, ['u_ender']], [EGO_NEW, 20n * E18, ['u_egoplayer']], [WREN, 5n * E18, ['u_wren']]], total: 35n * E18 },
};
const epochJson = (n: number) => {
  const e = EPOCHS[n];
  return {
    epoch: n,
    root: mkRoot(n), root0x: '0x' + mkRoot(n),
    total: e.total.toString(), totalPeer: Number(e.total / E18), decimals: 18,
    leafCount: e.leaves.length,
    leaves: e.leaves.map(([address, amount, handles]: any, index: number) => ({ index, address, amount: amount.toString(), peer: Number(amount / E18), handles })),
  };
};

function acts() {
  return [
    { t: 'register', id: 'u_ender', handle: 'ender' },
    { t: 'register', id: 'u_egoplayer', handle: 'egoplayer' },
    { t: 'register', id: 'u_wren', handle: 'Wren' },
    { t: 'bindAddress', id: 'u_ender', addr: STEWARD },
    { t: 'bindAddress', id: 'u_egoplayer', addr: EGO_NEW },  // epoch 3's leaf pays EGO_OLD
    { t: 'bindAddress', id: 'u_wren', addr: WREN },
  ];
}

/** window.ethereum for the steward: answers reads from the model, records sends. */
function stewardWallet() {
  const sent: any[] = [];
  const eth: any = {
    isMetaMask: true,
    selectedAddress: STEWARD,
    on() {},
    removeListener() {},
    async request({ method, params }: any) {
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return [STEWARD];
        case 'eth_chainId': return '0x2105';
        case 'eth_getCode': return String(params[0]).toLowerCase() === TOKEN ? '0x6080' : '0x';
        case 'eth_getBalance': return '0x0';
        case 'eth_getBlockByNumber': return { number: '0x1', timestamp: '0x' + CHAIN_NOW.toString(16) };
        case 'eth_sendTransaction': { sent.push(params[0]); return '0x' + 'ab'.repeat(32); }
        case 'eth_getTransactionReceipt': return { status: '0x1', blockNumber: '0x2' };
        case 'eth_call': {
          const data = String(params[0].data || '');
          const sel = data.slice(0, 10);
          if (sel === '0x637eea19') return '0x' + aword(STEWARD);                 // steward()
          if (sel === '0x52b65c4b') return '0x' + word(604800);                    // MIN_WINDOW
          if (sel === '0xdeb96634') return '0x' + word(31536000);                  // MAX_WINDOW
          if (sel === '0xdd62ed3e') return '0x' + word(0);                         // allowance
          if (sel === '0x70a08231') return '0x' + word(18000000n * E18);           // balanceOf
          if (sel === '0x3894228e') {                                              // epochInfo(n)
            const n = Number(BigInt('0x' + data.slice(10, 74)));
            if (EPOCHS[n] && EPOCHS[n].openOnChain) {
              return '0x' + mkRoot(n) + word(EPOCHS[n].total) + word(0) + word(CHAIN_NOW + 999999) + word(1);
            }
            return '0x' + word(0) + word(0) + word(0) + word(0) + word(0);
          }
          if (sel === '0x65574c78') return '0x' + word(1);                         // checkClaim -> yes
          if (sel === '0x02179e67') return '0x';                                   // openEpoch dry-run passes
          throw new Error('unhandled eth_call ' + sel);
        }
        default: throw new Error('unhandled ' + method);
      }
    },
  };
  return { eth, sent };
}

function page(eth: any) {
  const source = fs.readFileSync(here('../chain-l2/fund.html'), 'utf8');
  const errors: string[] = [];
  const dom = new JSDOM(source, {
    runScripts: 'dangerously', url: 'http://127.0.0.1:8901/fund.html', pretendToBeVisual: true,
    beforeParse(win: any) {
      win.ethereum = eth;
      win.fetch = (url: any) => {
        const u = String(url);
        const ok = (obj: any) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(obj)) });
        if (u.includes('/api/acts')) return ok({ acts: acts() });
        if (u.includes('/api/token/onchain')) return ok({ token: TOKEN, decimals: 18, claimState: { contract: CLAIM, steward: STEWARD } });
        const m = u.match(/\/api\/v1\/epoch\/(\d+)\/claim(\?address=(0x[0-9a-fA-F]{40}))?/);
        if (m) {
          const n = Number(m[1]);
          if (!EPOCHS[n]) return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('{"code":"EPOCH_NOT_CLOSED"}') });
          const j: any = epochJson(n);
          if (m[3]) j.claimant = { address: m[3].toLowerCase(), amount: (EPOCHS[n].leaves.find((l: any) => l[0] === m[3].toLowerCase()) || [0, 0n])[1].toString(), proof: ['0x' + word(0)] };
          return ok(j);
        }
        return Promise.reject(new Error('offline: ' + u));
      };
      win.addEventListener('error', (e: any) => errors.push(String(e.message)));
      win.addEventListener('unhandledrejection', (e: any) => errors.push(String(e.reason)));
    },
  });
  return { dom, errors };
}

describe('fund.html, pressed by the steward', () => {
  it('ticks only the epochs worth funding, refuses the traps, and hands MetaMask exactly the right bytes', async () => {
    const { eth, sent } = stewardWallet();
    const { dom, errors } = page(eth);
    await settle(1200); // boot: host reads + chain refinement
    const doc = dom.window.document;
    const cb = (n: number) => doc.querySelector('input[data-ep="' + n + '"]') as any;

    // The verdicts, epoch by epoch: 1 unfundable, 2 already open (chain fact,
    // disabled), 3 stale binding (offered, unticked), 4 and 7 ticked, 5
    // steward-only (unticked), 6 contract leaf (disabled by the chain).
    expect(cb(1).disabled, 'an epoch with no leaves offers nothing to tick').toBe(true);
    expect(cb(1).checked).toBe(false);
    expect(cb(2).disabled, 'already open on-chain must be untickable').toBe(true);
    expect(cb(3).checked, 'a stale binding is a human decision, never a default').toBe(false);
    expect(cb(3).disabled).toBe(false);
    expect(cb(4).checked).toBe(true);
    expect(cb(5).checked, 'the steward paying itself is not a default').toBe(false);
    expect(cb(6).checked).toBe(false);
    expect(cb(6).disabled, 'a leaf paying a contract must be untickable').toBe(true);
    expect(cb(7).checked).toBe(true);
    const text = doc.body.textContent!;
    expect(text).toContain('LEAF PAYS A CONTRACT');
    expect(text).toContain('has since rebound');
    expect(text).toContain('every leaf pays the steward');

    // The dust card knows who cannot pay claim gas: the two non-steward
    // claimants of the ticked epochs, each once.
    const dustRows = Array.from(doc.querySelectorAll('button[data-dust]')).map((b: any) => b.getAttribute('data-dust'));
    expect(dustRows.sort()).toEqual([EGO_NEW, WREN].sort());

    // Press. The run is: one approve for 40+35 PEER, then openEpoch(4), then
    // openEpoch(7) — each mined poll costs the page's own two seconds.
    (doc.getElementById('go') as any).click();
    await settle(9000);

    expect(errors).toEqual([]);
    expect(sent.length, 'approve + two openEpoch, nothing else').toBe(3);

    const approve = sent[0];
    expect(approve.to.toLowerCase()).toBe(TOKEN);
    expect(approve.data).toBe('0x095ea7b3' + aword(CLAIM) + word(75n * E18));

    const open4 = sent[1];
    expect(open4.to.toLowerCase()).toBe(CLAIM);
    expect(open4.data).toBe('0x02179e67' + word(4) + mkRoot(4) + word(40n * E18) + word(CHAIN_NOW + NINETY_DAYS));

    const open7 = sent[2];
    expect(open7.to.toLowerCase()).toBe(CLAIM);
    expect(open7.data).toBe('0x02179e67' + word(7) + mkRoot(7) + word(35n * E18) + word(CHAIN_NOW + NINETY_DAYS));

    // The read-back ran a real checkClaim and said yes.
    expect(doc.getElementById('log')!.textContent).toContain('checkClaim says YES');
  }, 60000);

  it('sends gas dust as a plain transfer, and refuses an amount that is not dust', async () => {
    const { eth, sent } = stewardWallet();
    const { dom, errors } = page(eth);
    await settle(1200);
    const doc = dom.window.document;
    const btn = doc.querySelector('button[data-dust="' + EGO_NEW + '"]') as any;
    expect(btn).toBeTruthy();

    // A fat-fingered 0.5 ETH is refused before MetaMask ever asks.
    const amt = doc.querySelector('input[data-dust-amt="' + EGO_NEW + '"]') as any;
    amt.value = '0.5';
    btn.click();
    await settle(300);
    expect(sent.length).toBe(0);
    expect(doc.getElementById('log')!.textContent).toContain('Refused');

    amt.value = '0.00005';
    btn.click();
    await settle(2600); // the page's own mined() poll
    expect(errors).toEqual([]);
    expect(sent.length).toBe(1);
    expect(sent[0].to.toLowerCase()).toBe(EGO_NEW);
    expect(BigInt(sent[0].value)).toBe(50000000000000n); // 0.00005 ETH in wei
    expect(sent[0].data).toBeUndefined();
  }, 60000);
});
