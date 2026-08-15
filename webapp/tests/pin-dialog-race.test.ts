// A PIN dialog is never torn down by a background repaint.
//
// The complaint behind this: "I cannot switch to any account." One real
// cause, reproduced deterministically: pollRemote guarded the .pin-dialog at
// DISPATCH but its RESPONSE handler called render() unguarded, and render()
// settles an open PIN dialog as cancelled. On a phone coming back from the
// reconnect banner the round trip is long enough to open "Unlock <handle>"
// inside it — and when the answer landed, the dialog vanished mid-typing with
// no toast, and the switch silently died.
//
// This test boots the built page against a fake host whose /api/acts poll is
// slow, opens the unlock dialog for a locked handle DURING the round trip,
// lets the response land with new acts (which forces a repaint), and asserts
// the dialog is still there — then that the owed repaint is paid once the
// dialog closes.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const here = (p: string) => new URL(p, import.meta.url);
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

// fnv1a32('u_al:test1234') — the page's crypto.subtle-less PIN fallback.
const AL_HASH = 'fnvbf08481a';
// Any hash works for the target: we only need the dialog to OPEN.
const BO_HASH = 'fnv00000000';

function log() {
  return [
    { t: 'seedWorld' },
    { t: 'register', id: 'u_al', handle: 'al', seed: 1, epoch: 0, pinHash: AL_HASH },
    { t: 'register', id: 'u_bo', handle: 'bo', seed: 1, epoch: 0, pinHash: BO_HASH },
    { t: 'btcBurn', id: 'u_al', sats: 60000, addr: 'bc1qdead', txid: '1'.padStart(64, '0') },
  ] as any[];
}

describe('a background repaint never dismisses an open PIN dialog', () => {
  it('keeps "Unlock <handle>" open across a slow poll that lands new acts', async () => {
    const acts = log();
    const source = fs.readFileSync(here('../public/peer-social-preview.html'), 'utf8');
    const errors: string[] = [];
    let polls = 0;
    // The tail the slow poll will return: one new act, so mergeTail reports a
    // change and the response handler wants to repaint.
    const extra = { t: 'post', author: 'u_bo', text: 'late', a: 0.8, rmen: [] };
    let releaseSlowPoll: () => void = () => {};
    const slowPollGate = new Promise<void>((r) => { releaseSlowPoll = r; });

    const dom = new JSDOM(source, {
      runScripts: 'dangerously', url: 'https://peer.test/', pretendToBeVisual: true,
      beforeParse(win: any) {
        delete win.ethereum;
        win.fetch = (url: any, init: any) => {
          const u = String(url);
          const ok = (obj: any) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(obj), text: () => Promise.resolve(JSON.stringify(obj)) });
          if (u.includes('/api/acts?since=')) {
            polls++;
            // Every interval poll is SLOW: it hangs on the gate and, once
            // released, carries a new act. Boot uses /api/acts (no since=).
            return slowPollGate.then(() => ok({ acts: [extra] }));
          }
          if (u.includes('/api/acts')) return ok({ acts, mirror: false });
          return Promise.reject(new Error('offline'));
        };
        win.addEventListener('error', (e: any) => errors.push(String(e.message)));
        win.localStorage.setItem('peer-sandbox-who-v2', JSON.stringify('u_al'));
        win.localStorage.setItem('peer-sandbox-mode-v1', JSON.stringify('geek'));
        win.sessionStorage.setItem('peer-sandbox-pins-v1', JSON.stringify({ u_al: 'test1234' }));
      },
    });
    await settle(2500);
    const win: any = dom.window;
    const doc = win.document;

    // Let a slow poll DISPATCH (it will hang on the gate) …
    await settle(5500);
    expect(polls, 'a poll is in flight').toBeGreaterThanOrEqual(1);
    // … then, inside the round trip, pick a locked handle from the switcher.
    const sel = doc.querySelector('select') as any;
    expect(sel, 'the account switcher renders').toBeTruthy();
    sel.value = 'u_bo';
    sel.dispatchEvent(new win.Event('change', { bubbles: true }));
    await settle(300);
    expect(doc.querySelector('.pin-dialog'), 'Unlock dialog opened').toBeTruthy();
    expect((doc.querySelector('.pin-card h3') as any).textContent).toContain('bo');

    // Now the poll answers with new acts, which wants a repaint.
    releaseSlowPoll();
    await settle(800);
    expect(doc.querySelector('.pin-dialog'), 'the dialog survives the poll response').toBeTruthy();
    expect(win.localStorage.getItem('peer-sandbox-who-v2')).toBe(JSON.stringify('u_al'));

    // The user cancels; the owed repaint is paid on the next safe tick and
    // the late act is on screen.
    (Array.from(doc.querySelectorAll('.pin-card button')).find((b: any) => b.textContent.trim() === 'Cancel') as any).click();
    await settle(5600);
    expect(doc.querySelector('.pin-dialog')).toBeFalsy();
    expect(doc.getElementById('root').textContent).toContain('late');
    expect(errors).toEqual([]);
  }, 60000);
});
