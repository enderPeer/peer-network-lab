// Binding an address without a wallet extension.
//
// The complaint that produced this test: "I cannot claim my tokens — there is
// no way to enter an address." True, and by design of an earlier shape: the
// earnings card read the address off window.ethereum and REFUSED to bind
// without one, so every phone and every wallet-less browser saw one note and
// no button. The host never needed a wallet — bindAddress is shape-checked
// (0x + 40 hex, not the zero address) and PIN-gated, and nothing else — so a
// share earned by someone who could not open the app in MetaMask went unbound
// and returned to the steward at every sweep.
//
// What replaces the wallet's guarantee against a typo is a second entry that
// must match to the character, then the same full-address read-back the
// wallet path uses. This test boots the BUILT page with NO window.ethereum,
// types an address twice, confirms, and asserts the host received a
// bindAddress act carrying that address, lowercased — the byte string the
// claim leaf hashes.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const here = (p: string) => new URL(p, import.meta.url);
const ADDR = '0xAbCdEf0123456789aBcDeF0123456789ABCDEF01';
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The page's own PIN check runs before an act leaves it. JSDOM has no
// crypto.subtle, so the page takes its documented fallback: 'fnv' +
// fnv1a32(id + ':' + pin). This is fnv1a32('u_al:test1234') — recompute with
// the loop in template.html sha256hex() if the fixture ever changes.
const PIN = 'test1234';
const PIN_HASH = 'fnvbf08481a';

function log() {
  const acts: any[] = [{ t: 'seedWorld' }];
  acts.push({ t: 'register', id: 'u_al', handle: 'al', seed: 1, epoch: 0, pinHash: PIN_HASH });
  acts.push({ t: 'btcBurn', id: 'u_al', sats: 60000, addr: 'bc1qdead', txid: '1'.padStart(64, '0') });
  return acts;
}

/** The built page against a fake host, with NO wallet in the window. */
function page(acts: any[], posted: any[]) {
  const source = fs.readFileSync(here('../public/peer-social-preview.html'), 'utf8');
  const body = acts.map((a) => JSON.stringify(a)).join('\n') + '\n';
  const errors: string[] = [];
  const dom = new JSDOM(source, {
    runScripts: 'dangerously', url: 'https://peer.test/', pretendToBeVisual: true,
    beforeParse(win: any) {
      // Definitely no wallet: the point of the test.
      delete win.ethereum;
      win.fetch = (url: any, init: any) => {
        const u = String(url);
        const ok = (obj: any) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(obj), text: () => Promise.resolve(JSON.stringify(obj)) });
        if (u.includes('archive/manifest.json')) return ok({ acts: acts.length, sha256: 'x'.repeat(64), at: Date.now() });
        if (u.includes('archive/acts.jsonl')) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
        if (u.includes('/api/auth/status')) return ok({ hasPin: true, passkeys: [] });
        // A live host: /api/acts answers in the host's own shape, so the page
        // runs REMOTE and records through POST /api/act — the path the
        // complaint is about. (Offline it would queue to the outbox instead,
        // which is honest but not what is under test here.)
        if (u.includes('/api/acts')) return ok({ acts, mirror: false });
        if (/\/api\/act(\?|$)/.test(u) && init && init.method === 'POST') {
          const act = JSON.parse(String(init.body));
          posted.push(act);
          return ok({ ok: true, index: acts.length, tail: [] });
        }
        if (u.includes('/api/v1/epoch/')) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ code: 'EPOCH_NOT_CLOSED' }) });
        return Promise.reject(new Error('offline'));
      };
      win.addEventListener('error', (e: any) => errors.push(String(e.message)));
      win.addEventListener('unhandledrejection', (e: any) => errors.push(String(e.reason)));
      win.localStorage.setItem('peer-sandbox-who-v2', JSON.stringify('u_al'));
      win.localStorage.setItem('peer-sandbox-mode-v1', JSON.stringify('geek'));
      win.localStorage.setItem('peer-sandbox-view-v1', JSON.stringify({ tab: 'econ', lqView: 'feed', econView: 'money' }));
      // A signed-in reader whose PIN this session already remembers — the
      // state of anyone who unlocked once and then went to the Economy tab,
      // which is who files this complaint. Where it is stored is the page's
      // own choice (LS_PINS, sessionStorage), read at boot.
      win.sessionStorage.setItem('peer-sandbox-pins-v1', JSON.stringify({ u_al: PIN }));
    },
  });
  return { dom, errors };
}

function type(win: any, el: any, v: string) {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, v);
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
}

describe('binding an address without a wallet extension', () => {
  it('offers a typed path, refuses the mistakes that matter, and sends the lowercased address to the host', async () => {
    const acts = log();
    const posted: any[] = [];
    const { dom, errors } = page(acts, posted);
    await settle(2500);
    const win: any = dom.window;
    const root = win.document.getElementById('root');
    const btn = (re: RegExp) => Array.from(root.querySelectorAll('button')).find((b: any) => re.test(b.textContent.trim())) as any;

    // The old dead end is gone; the manual path is on screen.
    expect(root.textContent).not.toContain('the address is never typed here');
    const open = btn(/^Type the address to bind$/);
    expect(open, 'a wallet-less browser must be offered a way to type the address').toBeTruthy();
    open.click();

    const a1 = root.querySelector('input[placeholder^="0x"]');
    const a2 = root.querySelector('input[placeholder^="type it again"]');
    expect(a1 && a2, 'two entries, compared exactly').toBeTruthy();
    const cont = btn(/^Continue$/);
    const err = () => {
      const p = Array.from(root.querySelectorAll('p.smallnote')).find((e: any) => e.style.display !== 'none' && /^(That is not|The zero|The two|That address|Enter the)/.test(e.textContent)) as any;
      return p ? p.textContent : '';
    };

    type(win, a1, '0x1234'); type(win, a2, '0x1234'); cont.click();
    expect(err()).toMatch(/not an address/);
    const zero = '0x' + '0'.repeat(40);
    type(win, a1, zero); type(win, a2, zero); cont.click();
    expect(err()).toMatch(/zero address/);
    type(win, a1, ADDR); type(win, a2, ADDR.slice(0, -1) + '2'); cont.click();
    expect(err()).toMatch(/two entries differ/);
    expect(posted, 'nothing reaches the host before a valid, matching pair').toEqual([]);

    // A valid matching pair reaches the same read-it-back confirmation the
    // wallet path uses, showing the FULL address, lowercased.
    type(win, a1, ADDR); type(win, a2, ADDR); cont.click();
    const conf = root.querySelector('[data-confirm]');
    expect(conf, 'the full-address confirmation must appear').toBeTruthy();
    expect(conf.textContent).toContain(ADDR.toLowerCase());
    const bind = Array.from(conf.querySelectorAll('button')).find((b: any) => /^Bind 0x/.test(b.textContent.trim())) as any;
    expect(bind).toBeTruthy();
    bind.click();
    await settle(2000);

    // The host got exactly one bindAddress act, for this handle, with the
    // lowercased address — the byte string the claim leaf hashes.
    const binds = posted.filter((a) => a.t === 'bindAddress');
    expect(binds.length, 'exactly one binding act').toBe(1);
    expect(binds[0].id).toBe('u_al');
    expect(binds[0].addr).toBe(ADDR.toLowerCase());
    expect(errors, 'the page must not throw').toEqual([]);
  }, 60000);
});
