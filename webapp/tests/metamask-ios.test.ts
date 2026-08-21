// MetaMask on an iPhone, end to end in emulation.
//
// The complaint that produced this suite: "trying to connect MetaMask on iOS
// — the wallet rejected connecting." Two facts compounded into that dead end.
// First, a fresh phone wallet's network list starts at Ethereum and has never
// met Base, so wallet_switchEthereumChain fails (MetaMask: 4902) and the page
// gave up with "switch it by hand" — an instruction most phone readers cannot
// follow. Second, the wallet door reopened this page inside MetaMask's
// browser and then forgot why it had been opened: the reader had to find
// Connect a second time, on a lane they had already left once.
//
// No test here talks to a phone. What an iPhone contributes is a user agent,
// the absence of window.ethereum outside the wallet's own browser, and a
// provider with MetaMask-mobile's documented behaviours inside it — all three
// of which JSDOM can wear. The provider mock below answers exactly like
// MetaMask with a fresh wallet: accounts on request, chain 0x1, 4902 for a
// switch to a chain it was never given, and a switch as part of a successful
// wallet_addEthereumChain. The page under test is the BUILT page, same as
// every other UI test in this directory (run `node social/assemble.mjs`
// after editing the template, or these tests exercise yesterday's page).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const here = (p: string) => new URL(p, import.meta.url);
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ADDR = '0xAbCdEf0123456789aBcDeF0123456789ABCDEF01';
const BASE = '0x2105';
const TOKEN = '0x' + '7'.repeat(40);
// Safari on an iPhone (outside any wallet) and MetaMask's own in-app browser.
// The page's phone test is /iP(hone|ad|od)|Android/ — both must pass it.
const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IOS_METAMASK = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MetaMaskMobile';

/**
 * window.ethereum the way MetaMask iOS serves it: EIP-1193 request(), the
 * event channel, and a fresh wallet's answers. `opts.rejectAccounts` is the
 * reader pressing Cancel on the connect sheet (4001); `opts.rejectSwitch`
 * is the reader pressing Cancel on the switch sheet (4001, and the page must
 * NOT answer that with a second prompt); everything else models a wallet
 * that has simply never met Base: 4902 on switch, and — like the real app —
 * a successful wallet_addEthereumChain moves the wallet onto the new chain.
 */
function metamask(opts: { rejectAccounts?: boolean; rejectSwitch?: boolean; chain?: string } = {}) {
  let chain = opts.chain || '0x1';
  const known = ['0x1'];
  const calls: { method: string; params: any }[] = [];
  const handlers: Record<string, Function[]> = {};
  const emit = (ev: string, arg: any) => (handlers[ev] || []).forEach((f) => f(arg));
  const err = (code: number, message: string) => Object.assign(new Error(message), { code });
  const eth = {
    isMetaMask: true,
    on(ev: string, fn: Function) { (handlers[ev] = handlers[ev] || []).push(fn); },
    removeListener(ev: string, fn: Function) { handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn); },
    async request({ method, params }: { method: string; params?: any }) {
      calls.push({ method, params });
      switch (method) {
        case 'eth_requestAccounts':
          if (opts.rejectAccounts) throw err(4001, 'User rejected the request.');
          return [ADDR];
        case 'eth_accounts':
          return opts.rejectAccounts ? [] : [ADDR];
        case 'eth_chainId':
          return chain;
        case 'wallet_switchEthereumChain': {
          const want = String(params[0].chainId);
          if (opts.rejectSwitch) throw err(4001, 'User rejected the request.');
          if (known.indexOf(want) < 0) throw err(4902, 'Unrecognized chain ID "' + want + '". Try adding the chain using wallet_addEthereumChain first.');
          if (chain !== want) { chain = want; emit('chainChanged', chain); }
          return null;
        }
        case 'wallet_addEthereumChain': {
          const p = params[0];
          known.push(String(p.chainId));
          if (chain !== p.chainId) { chain = String(p.chainId); emit('chainChanged', chain); }
          return null;
        }
        case 'wallet_watchAsset':
          return true;
        case 'eth_call':
          return '0x' + '0'.repeat(64);
        case 'eth_getBlockByNumber':
          return { number: '0x1', timestamp: '0x6b49d200' };
        default:
          throw err(-32601, 'unhandled in mock: ' + method);
      }
    },
  };
  return { eth, calls, chainNow: () => chain, count: (m: string) => calls.filter((c) => c.method === m).length };
}

function log() {
  return [
    { t: 'seedWorld' },
    { t: 'register', id: 'u_al', handle: 'al', seed: 1, epoch: 0 },
    { t: 'btcBurn', id: 'u_al', sats: 60000, addr: 'bc1qdead', txid: '1'.padStart(64, '0') },
  ];
}

/** The built page: a fake host, a chosen user agent, and maybe a wallet. */
function page(opts: { url: string; ua: string; eth?: any; view?: any }) {
  const source = fs.readFileSync(here('../public/peer-social-preview.html'), 'utf8');
  const acts = log();
  const body = acts.map((a) => JSON.stringify(a)).join('\n') + '\n';
  const errors: string[] = [];
  const dom = new JSDOM(source, {
    runScripts: 'dangerously', url: opts.url, pretendToBeVisual: true,
    beforeParse(win: any) {
      Object.defineProperty(win.navigator, 'userAgent', { value: opts.ua, configurable: true });
      if (opts.eth) win.ethereum = opts.eth;
      else delete win.ethereum;
      win.fetch = (url: any, init: any) => {
        const u = String(url);
        const ok = (obj: any) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(obj), text: () => Promise.resolve(JSON.stringify(obj)) });
        if (u.includes('archive/manifest.json')) return ok({ acts: acts.length, sha256: 'x'.repeat(64), at: Date.now() });
        if (u.includes('archive/acts.jsonl')) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
        if (u.includes('/api/auth/status')) return ok({ hasPin: true, passkeys: [] });
        if (u.includes('/api/acts')) return ok({ acts, mirror: false });
        // The ERC-20 card renders from this answer — which is what puts a
        // second wallet door on the lane, so the door election has a real
        // choice to make in the tests below.
        if (u.includes('/api/token/onchain')) return ok({ token: TOKEN, btc: null, decimals: 18, totalSupplyRaw: '18250000' + '0'.repeat(18), chainId: 8453 });
        if (u.includes('/api/v1/epoch/')) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ code: 'EPOCH_NOT_CLOSED' }) });
        return Promise.reject(new Error('offline'));
      };
      win.addEventListener('error', (e: any) => errors.push(String(e.message)));
      win.addEventListener('unhandledrejection', (e: any) => errors.push(String(e.reason)));
      win.localStorage.setItem('peer-sandbox-who-v2', JSON.stringify('u_al'));
      win.localStorage.setItem('peer-sandbox-view-v1', JSON.stringify(opts.view || { tab: 'econ', econView: 'money' }));
    },
  });
  return { dom, errors };
}

const doors = (root: any) => Array.from(root.querySelectorAll('[data-wallet-door]')) as any[];
const anchor = (root: any, text: RegExp) => Array.from(root.querySelectorAll('a')).find((a: any) => text.test(a.textContent.trim())) as any;
const button = (root: any, text: RegExp) => Array.from(root.querySelectorAll('button')).find((b: any) => text.test(b.textContent.trim())) as any;

describe('the wallet door, on an iPhone with no wallet in the browser', () => {
  it('offers universal links that carry this page and the connect marker, and elects one door to explain', async () => {
    const { dom, errors } = page({ url: 'https://peer.test/', ua: IOS_SAFARI });
    await settle(2500);
    const root = dom.window.document.getElementById('root');

    // The MetaMask link is the page's own address in MetaMask's /dapp/
    // format, marker and all — the marker is what turns the reopened page
    // into a connect attempt instead of a second scavenger hunt.
    const mm = anchor(root, /^Open in MetaMask$/);
    expect(mm, 'an https page on a phone must offer the MetaMask door').toBeTruthy();
    expect(mm.getAttribute('href')).toBe('https://link.metamask.io/dapp/peer.test/#econ-connect');
    const cb = anchor(root, /^Open in Base app$/);
    expect(cb).toBeTruthy();
    expect(cb.getAttribute('href')).toBe('https://go.cb-w.com/dapp?cb_url=' + encodeURIComponent('https://peer.test/#econ-connect'));
    expect(anchor(root, /^Open in OKX$/)).toBeTruthy();

    // Two cards on the lane hold doors (the token card and the bind row);
    // exactly one explains, decided by document position, and the copy row
    // rides with the explanation.
    const all = doors(root);
    expect(all.length, 'the money lane holds more than one door').toBeGreaterThan(1);
    expect(all[0].getAttribute('data-wallet-door')).toBe('full');
    for (const d of all.slice(1)) expect(d.getAttribute('data-wallet-door')).toBe('compact');
    expect(button(all[0], /Copy this page/)).toBeTruthy();
    expect(errors).toEqual([]);
  }, 60000);

  it('hides the MetaMask door on an http origin, whose /dapp/ format would reopen as unreachable https', async () => {
    const { dom, errors } = page({ url: 'http://192.168.7.9:5199/', ua: IOS_SAFARI });
    await settle(2500);
    const root = dom.window.document.getElementById('root');
    expect(anchor(root, /^Open in MetaMask$/)).toBeFalsy();
    expect(anchor(root, /^Open in Base app$/)).toBeTruthy();
    expect(anchor(root, /^Open in OKX$/)).toBeTruthy();
    expect(errors).toEqual([]);
  }, 60000);
});

describe('arriving through the door, inside MetaMask on the iPhone', () => {
  it('connects by itself: accounts, then 4902 on the switch, then the chain offered and taken', async () => {
    const mm = metamask();
    // The restored view points at the feed on purpose: the marker, not the
    // stored view, must decide where a door arrival lands.
    const { dom, errors } = page({ url: 'https://peer.test/#econ-connect', ua: IOS_METAMASK, eth: mm.eth, view: { tab: 'feed', econView: 'net' } });
    await settle(3000);
    const root = dom.window.document.getElementById('root');

    // Asked once, repaired once: the switch failed with 4902 because a fresh
    // wallet has never met Base, so the page offered the chain itself —
    // official RPC, reviewed in the page's own table — and MetaMask moved as
    // part of accepting it.
    expect(mm.count('eth_requestAccounts'), 'one connect prompt, ever').toBe(1);
    expect(mm.count('wallet_switchEthereumChain')).toBeGreaterThan(0);
    const added = mm.calls.find((c) => c.method === 'wallet_addEthereumChain');
    expect(added, 'the chain must be offered when the switch says 4902').toBeTruthy();
    expect(added!.params[0].chainId).toBe(BASE);
    expect(added!.params[0].rpcUrls).toEqual(['https://mainnet.base.org']);
    expect(mm.chainNow()).toBe(BASE);

    // The page landed on the money lane and shows the connected address —
    // the reader tapped one door and pressed nothing else.
    expect(root.textContent).toContain('the coin in your wallet');
    expect(root.textContent).toContain('wallet ' + ADDR.toLowerCase());

    // The marker was scrubbed: a reload of this page must arrive as #econ
    // and prompt nobody.
    expect(dom.window.location.hash).toBe('#econ');
    expect(errors).toEqual([]);
  }, 60000);

  it('takes a decline as an answer: one prompt, no retry, and the Connect button left for the reader', async () => {
    const mm = metamask({ rejectAccounts: true });
    const { dom, errors } = page({ url: 'https://peer.test/#econ-connect', ua: IOS_METAMASK, eth: mm.eth });
    await settle(3000);
    const root = dom.window.document.getElementById('root');

    expect(mm.count('eth_requestAccounts'), 'a "no" is final').toBe(1);
    expect(mm.count('wallet_addEthereumChain')).toBe(0);
    expect(root.textContent).not.toContain('wallet ' + ADDR.toLowerCase());
    expect(button(root, /^Connect a wallet$/), 'the second ask belongs to the reader').toBeTruthy();
    expect(dom.window.location.hash).toBe('#econ');
    expect(errors).toEqual([]);
  }, 60000);

  it('never prompts without the marker: #econ inside the wallet browser is a page, not a connect attempt', async () => {
    const mm = metamask();
    const { dom, errors } = page({ url: 'https://peer.test/#econ', ua: IOS_METAMASK, eth: mm.eth });
    await settle(3000);
    expect(mm.count('eth_requestAccounts')).toBe(0);
    expect(errors).toEqual([]);
  }, 60000);
});

describe('the Connect button, wherever the wallet lives', () => {
  it('repairs the missing chain the same way when pressed by hand', async () => {
    const mm = metamask();
    const { dom, errors } = page({ url: 'https://peer.test/', ua: IOS_METAMASK, eth: mm.eth });
    await settle(2500);
    const root = dom.window.document.getElementById('root');
    const btn = button(root, /^Connect a wallet$/);
    expect(btn, 'a wallet in the browser and nothing connected must offer the button').toBeTruthy();
    btn.click();
    await settle(1200);

    expect(mm.count('eth_requestAccounts')).toBe(1);
    expect(mm.count('wallet_addEthereumChain')).toBe(1);
    expect(mm.chainNow()).toBe(BASE);
    expect(root.textContent).toContain('wallet ' + ADDR.toLowerCase());
    expect(errors).toEqual([]);
  }, 60000);

  it('does not answer a refused switch with a second prompt: 4001 means no, not "ask differently"', async () => {
    const mm = metamask({ rejectSwitch: true });
    const { dom, errors } = page({ url: 'https://peer.test/', ua: IOS_METAMASK, eth: mm.eth });
    await settle(2500);
    const root = dom.window.document.getElementById('root');
    const btn = button(root, /^Connect a wallet$/);
    expect(btn).toBeTruthy();
    btn.click();
    await settle(1200);

    expect(mm.count('wallet_switchEthereumChain')).toBe(1);
    expect(mm.count('wallet_addEthereumChain'), 'a rejected switch must never become an add prompt').toBe(0);
    expect(root.textContent).not.toContain('wallet ' + ADDR.toLowerCase());
    expect(errors).toEqual([]);
  }, 60000);
});
