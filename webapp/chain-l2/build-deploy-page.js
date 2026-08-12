// ESM because webapp/package.json says "type": "module" — require() stopped
// resolving here the day that landed, so this uses import like the rest.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const build = JSON.parse(fs.readFileSync('chain-l2/PeerToken.build.json', 'utf8'));
const pools = JSON.parse(fs.readFileSync('chain-l2/PeerPools.build.json', 'utf8'));
const anchor = JSON.parse(fs.readFileSync('chain-l2/PeerAnchor.build.json', 'utf8'));
const claim = JSON.parse(fs.readFileSync('chain-l2/PeerClaim.build.json', 'utf8'));
// One line that says WHICH factory this page deploys, for a person and for a
// script. It is not a security property — anyone who can rewrite the page can
// rewrite the tag too — it exists to catch the mistake that is actually
// likely: an older copy of deploy.html, from a worktree or a stale checkout,
// answering on port 8899 and embedding the PREVIOUS immutable contract. The
// deployment signature cannot be undone, so "which contract is this?" has to
// be answerable before signing rather than after.
//
// Trimmed and lowercased before hashing so that auto-deploy.ps1, computing the
// same fingerprint from PeerPools.build.json in .NET, hashes the same bytes.
// solc already emits lowercase hex with no surrounding space, so today that
// normalisation changes nothing; it is there so the two sides cannot drift
// apart if that ever stops being true. The bytecode itself is embedded
// verbatim below — the fingerprint describes it, it does not rewrite it.
const fingerprint = (b) => createHash('sha256').update(String(b).trim().toLowerCase(), 'ascii').digest('hex');
const poolsFp = fingerprint(pools.bytecode);
// The two epoch contracts get the same treatment, for the same reason and with
// the same stakes: PeerClaim is deployed once against an immutable token and an
// immutable steward, and PeerAnchor's rows can never be revised. A stale copy
// of this page deploys a previous contract, silently.
const anchorFp = fingerprint(anchor.bytecode);
const claimFp = fingerprint(claim.bytecode);
// Constructor encodings, hardcoded, no library:
//   PeerToken(uint256 wholeTokens)      -> one 32-byte word, hex, left-padded.
//   PeerPools(address peer, address btc) -> two 32-byte words, the 20 address
//   bytes right-aligned in each.
//   PeerAnchor()                        -> nothing at all; there is no
//   constructor argument, so the deployment data IS the bytecode.
//   PeerClaim(address token, address steward) -> two address words again.
// That is the entire ABI these pages need.

// ── THE HELPERS BOTH PAGES RUN ON ─────────────────────────────────────────
// This block used to live once, inside deploy.html, which was correct while
// there was one page. setup.html then needed the same four things — the
// last-moment chain re-read, the receipt wait, the is-this-really-an-ERC-20
// probe, and the word encoders — and a second copy of them is not a saving:
// the copies would drift, and the one that drifted would be the one that
// stopped refusing something. They are hard-won. probeToken exists because a
// wallet address pasted as a token produced a factory that can never trade;
// requireBase exists because the check that counts is the one with nothing
// between it and the signature; mined's block number exists because a log
// scan with no start block is one most public RPCs refuse.
//
// So: ONE definition, embedded into both pages verbatim. String.raw because
// the regexes below carry backslashes that a plain template literal would
// eat, and no backtick appears anywhere inside for the same reason.
//
// Each page must declare, before this runs: `let account`, `let chainId`,
// and a `renderWho()` that redraws its own connected row. Those three are
// where the pages genuinely differ, so they stay with the pages.
const SHARED_JS = String.raw`
const BASE_CHAIN_ID = '0x2105'; // 8453
const BASE_CHAIN_NUM = 8453;   // compared numerically: '0x2105' and '0X2105' are the same chain

const onBase = () => !!chainId && parseInt(chainId, 16) === BASE_CHAIN_NUM;

// Read the chain from the wallet on the line before we hand it a transaction.
// Everything else on these pages describes the past: the switch at connect
// time is a request that already returned, and chainChanged is news of a
// change that has already happened. Sending is the one irreversible act here
// — on the wrong chain it spends real gas and leaves a contract at an address
// this host will never point at, with no undo — so the check that counts is
// the one with nothing in between.
const requireBase = async (out) => {
  let now = null;
  try { now = await window.ethereum.request({ method: 'eth_chainId' }); }
  catch (e) { out('Could not read the wallet chain: ' + (e.message || e) + '. Nothing was sent.', 'bad'); return false; }
  chainId = now; renderWho();
  if (!onBase()) {
    // Sending is disabled the moment we learn this, so the instruction has to
    // be one the operator can still follow: switching back re-enables it via
    // chainChanged where the wallet sends that event, and Connect re-reads
    // everything where it does not.
    out('The wallet is on chain ' + parseInt(now, 16) + ', not Base (' + BASE_CHAIN_NUM + '). Nothing was sent — switch to Base in MetaMask; the connected row updates itself, and if it does not, press Connect again.', 'bad');
    return false;
  }
  return true;
};

// Wait for a transaction, then say what came of it — in ONE place. Several
// cards send a deployment, and the two-second polling, the four-minute
// give-up, the failed-on-chain case and the address/block printout are
// identical for all of them. Separate copies of that is a chance for one of
// them to quietly stop matching the others, and the one that stops matching
// is the one whose contract address somebody writes down wrong.
//
// The block number matters as much as the address here. The host finds pools,
// anchors and epochs by asking for logs, and a log query with no start block
// covers the whole chain — a range most public RPCs refuse outright, which
// shows up as an empty list on a contract that works perfectly. The receipt is
// the only place that number is free; after this you are hunting for it on an
// explorer.
const mined = async (tx, out) => {
  out('Transaction sent: ' + tx);
  out('Waiting for it to be mined…');
  let receipt = null;
  for (let i = 0; i < 120 && !receipt; i++) {
    await new Promise(r => setTimeout(r, 2000));
    receipt = await window.ethereum.request({ method: 'eth_getTransactionReceipt', params: [tx] });
  }
  if (!receipt) { out('Still not mined after four minutes. Check the hash on basescan.org — it may yet land.', 'bad'); return null; }
  if (receipt.status !== '0x1') { out('The transaction failed on chain. Nothing was deployed; you paid gas.', 'bad'); return null; }
  out('');
  if (receipt.contractAddress) {
    out('DEPLOYED: ' + receipt.contractAddress, 'ok');
    if (receipt.blockNumber) out('IN BLOCK: ' + Number(BigInt(receipt.blockNumber)), 'ok');
    out('<a href="https://basescan.org/address/' + receipt.contractAddress + '" target="_blank" rel="noopener">View on Basescan</a>');
  } else {
    // Not a deployment: an approve, an openEpoch, a createPool. The same wait,
    // the same failure handling, and a link to the transaction rather than to
    // a contract that this one did not create.
    out('CONFIRMED in block ' + (receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : '?'), 'ok');
    out('<a href="https://basescan.org/tx/' + tx + '" target="_blank" rel="noopener">View on Basescan</a>');
  }
  out('');
  return receipt;
};

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// Does an ERC-20 actually live there? This existed as a comment saying a
// 40-hex check "cannot catch a wrong-but-real address — MetaMask's
// confirmation screen and the basescan link afterwards are what catch that."
// They do not. Pasting a WALLET address here sailed through both: MetaMask
// shows a constructor argument without knowing what it is meant to be, and
// basescan shows a contract that deployed perfectly. The factory came out
// immutably paired to an address with no token at it, so every createPool
// reverted with empty data, and the only repair was deploying it again.
//
// The chain can be asked, for free, before the irreversible signature. That
// is the same rule the pools card follows for its own refusals, applied to
// the one transaction here that cannot be taken back.
// Three outcomes, not two. "That address holds no token" and "I could not
// reach the chain to find out" are different facts, and collapsing them
// would build a second trap on top of the first: a public RPC answering
// "over rate limit" would refuse a PERFECTLY GOOD address in the words of a
// bad one, and whoever hit it would go hunting for a fault in their paste.
// Measured, not imagined - three quick reads against a public endpoint is
// enough to be rate-limited.
const SEL = { decimals: '0x313ce567', symbol: '0x95d89b41', totalSupply: '0x18160ddd' };
const BAD = (why) => ({ ok: false, sure: true, why: why });    // the chain answered: not a token
const UNSURE = (why) => ({ ok: false, sure: false, why: why }); // could not ask
async function probeToken(addr, label) {
  let code;
  try {
    code = await window.ethereum.request({ method: 'eth_getCode', params: [addr, 'latest'] });
  } catch (e) { return UNSURE('could not read the chain: ' + (e.message || e)); }
  if (!code || code === '0x') {
    return BAD('nothing is deployed at that address on Base. '
      + (account && addr.toLowerCase() === account.toLowerCase()
        ? 'That is THIS WALLET’s address, not a token — the token address is the one the deploy step printed, not the account you deployed from.'
        : 'Check you pasted the ' + label + ' CONTRACT address rather than a wallet, and that it was deployed on Base.'));
  }
  const call = (data) => window.ethereum.request({ method: 'eth_call', params: [{ to: addr, data: data }, 'latest'] });
  let dec, sup, sym = '';
  try {
    const d = await call(SEL.decimals); const s = await call(SEL.totalSupply);
    // An empty answer from a contract that DOES have code is the chain
    // telling us the function is not there - that is an answer, not a
    // failure, so it is a definite no.
    if (!d || d === '0x' || !s || s === '0x') return BAD('there is a contract there, but it does not answer decimals() and totalSupply() — so it is not an ERC-20.');
    dec = parseInt(d, 16); sup = BigInt(s);
    try {
      const y = await call(SEL.symbol);
      if (y && y.length > 130) {
        const n = parseInt(y.slice(66, 130), 16);
        for (let i = 0; i < n; i++) sym += String.fromCharCode(parseInt(y.slice(130 + i * 2, 132 + i * 2), 16));
      }
    } catch (e) { /* symbol() is decoration; having decimals and supply is the check */ }
  } catch (e) { return UNSURE('the chain did not answer an ERC-20 call: ' + (e.message || e)); }
  const whole = dec <= 30 ? (sup / (10n ** BigInt(dec))).toString() : sup.toString();
  return { ok: true, decimals: dec, symbol: sym, supply: sup, note: (sym || '?') + ' · ' + dec + ' decimals · supply ' + whole };
}

// A read of the chain that costs nothing and changes nothing. The from
// argument is optional and only matters for a dry run: a view call does not care who is
// asking, but simulating a STATE-CHANGING function does — openEpoch reverts
// for anybody who is not the steward, and the whole point of asking first is
// to get that answer for free instead of paying gas for it.
const ethCall = (to, data, from) => window.ethereum.request({
  method: 'eth_call',
  params: [from ? { from: from, to: to, data: data } : { to: to, data: data }, 'latest'],
});

// ---- the whole ABI encoder, by hand ----
// Four 32-byte shapes and no library, which is the house rule: an address
// right-aligned in a word, a uint256, a bytes32, and the reverse — cutting a
// return value back into words. Anything more complicated than this (the one
// dynamic bytes32[] argument, in checkClaim) is written out at its call site
// where the offset can be counted by eye.
const addrWord = (a) => String(a).replace(/^0x/i, '').toLowerCase().padStart(64, '0');
const u256Word = (v) => BigInt(v).toString(16).padStart(64, '0');
const b32Word = (h) => String(h).replace(/^0x/i, '').toLowerCase().padStart(64, '0');
const wordsOf = (ret) => {
  const s = String(ret || '').replace(/^0x/i, '');
  const out = [];
  for (let i = 0; i + 64 <= s.length; i += 64) out.push(s.slice(i, i + 64));
  return out;
};
// A bare 64-hex word is not a decimal number, and BigInt would read it as one
// — silently, for any word that happens to be all digits. Every conversion
// goes through here so that cannot happen once.
const bigWord = (w) => BigInt('0x' + String(w === undefined || w === null || w === '' ? '0' : w).replace(/^0x/i, ''));
// Raw units to a decimal string, exactly — no Number anywhere on the path. A
// uint256 of PEER does not fit in a double, and an amount that loses its low
// digits on the way to the screen is the one thing this pipeline exists to
// avoid.
const units = (raw, dec) => {
  const v = BigInt(raw), d = Number(dec), base = 10n ** BigInt(d);
  const frac = (v % base).toString().padStart(d, '0').replace(/0+$/, '');
  return (v / base).toString() + (frac ? '.' + frac : '');
};
const scan = (kind, id) => '<a href="https://basescan.org/' + kind + '/' + id + '" target="_blank" rel="noopener">' + id + '</a>';
`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Deploy PEER — Peer Network</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="peerpools-build" content="sha256:${poolsFp}">
<meta name="peeranchor-build" content="sha256:${anchorFp}">
<meta name="peerclaim-build" content="sha256:${claimFp}">
<style>
  :root{--paper:#131110;--ink:#EFE7DB;--muted:#9C8E7E;--ember:#B84525;--ok:#3f7d4e;--line:#2a2622}
  body{background:var(--paper);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:28px 18px 80px}
  main{max-width:640px;margin:0 auto}
  h1{font-size:22px;margin:0 0 4px} .sub{color:var(--muted);margin:0 0 22px}
  h2{font-size:19px;margin:36px 0 4px}
  .card{border:1px solid var(--line);border-radius:10px;padding:16px;margin:14px 0;background:#181513}
  .step{display:flex;gap:10px;align-items:baseline}
  .n{color:var(--ember);font-weight:700;min-width:1.2em}
  button{background:var(--ember);color:#fff;border:0;border-radius:7px;padding:11px 18px;font-size:15px;cursor:pointer}
  button:disabled{background:#3a3531;color:#7d746c;cursor:not-allowed}
  button.sec{background:#2a2622;color:var(--ink)}
  code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all}
  .ok{color:var(--ok)} .bad{color:var(--ember)} .muted{color:var(--muted)}
  #log{white-space:pre-wrap;margin-top:10px}
  input{background:#0f0d0c;border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:9px;width:100%;box-sizing:border-box;font-family:ui-monospace,monospace}
  a{color:var(--ember)}
</style></head><body><main>
<h1>Deploy PEER</h1>
<p class="sub">Your key never leaves MetaMask. This page holds no secret, asks for none, and signs nothing — it hands MetaMask a transaction and MetaMask asks you.</p>

<div class="card">
  <div class="step"><span class="n">1</span><div>
    <b>Connect</b><div class="muted">Read-only until you press Deploy.</div>
    <p><button id="conn">Connect MetaMask</button></p>
    <div id="who" class="mono muted"></div>
  </div></div>
</div>

<div class="card">
  <div class="step"><span class="n">2</span><div>
    <b>Supply</b><div class="muted">Whole tokens. 18,250,000 is the cap TOKEN.md sets for the epoch emission schedule.</div>
    <p><input id="supply" value="18250000"></p>
  </div></div>
</div>

<div class="card">
  <div class="step"><span class="n">3</span><div>
    <b>Deploy</b>
    <div class="muted">One transaction on Base. Roughly $0.04 of gas. MetaMask will show you the exact cost before anything happens.</div>
    <p><button id="go" disabled>Deploy PEER</button></p>
  </div></div>
  <div id="log" class="mono"></div>
</div>

<h2>Deploy the pools factory</h2>
<p class="sub">PeerPools holds every named PEER/cbBTC pool in one contract — same posture as the token: no owner, no fee switch, nothing privileged. Uses the same Connect from step 1.</p>

<div class="card">
  <div class="step"><span class="n">4</span><div>
    <b>Addresses</b>
    <div class="muted">The PEER address is the one step 3 printed — paste it. The BTC address is cbBTC on Base, prefilled; change it only if you know exactly why.</div>
    <p><input id="peerAddr" placeholder="0x… your PEER token from step 3" spellcheck="false"></p>
    <p><input id="btcAddr" value="0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" spellcheck="false"></p>
  </div></div>
</div>

<div class="card">
  <div class="step"><span class="n">5</span><div>
    <b>Deploy</b>
    <div class="muted">One transaction on Base. Roughly $0.08 of gas — the factory is bigger than the token. MetaMask will show you the exact cost before anything happens.</div>
    <p><button id="goPools" disabled>Deploy PeerPools</button></p>
    <div class="muted" style="font-size:13px">
      Factory build fingerprint — SHA-256 of the PeerPools bytecode <i>this page</i> will deploy:
      <div class="mono" style="margin:4px 0">${poolsFp}</div>
      The same number comes out of <code>chain-l2/PeerPools.build.json</code>, and
      <code>auto-deploy.ps1</code> compares them before it opens this page. If they differ, the
      page you are looking at is an older copy of this repository — a different, and permanent,
      contract. Check it if you did not open this page from that script.
    </div>
  </div></div>
  <div id="log2" class="mono"></div>
</div>

<h2>Deploy the epoch contracts</h2>
<p class="sub">These two put the epoch chain on Base. <b>PeerAnchor</b> timestamps each closed epoch's block id and earnings root, so a result cannot be quietly rewritten afterwards. <b>PeerClaim</b> pays those earnings out as real PEER against a published merkle root. Both are optional and independent — the network runs without either. Same Connect from step 1.</p>

<div class="card">
  <div class="step"><span class="n">6</span><div>
    <b>PeerAnchor</b>
    <div class="muted">No constructor arguments, no owner, no allowlist, nothing privileged: anyone may post, records are keyed by (poster, epoch), and a row can never be revised. One transaction, roughly $0.02 of gas.</div>
    <p><button id="goAnchor" disabled>Deploy PeerAnchor</button></p>
    <div class="muted" style="font-size:13px">
      Build fingerprint — SHA-256 of the PeerAnchor bytecode <i>this page</i> will deploy:
      <div class="mono" style="margin:4px 0">${anchorFp}</div>
      The same number comes out of <code>chain-l2/PeerAnchor.build.json</code>.
    </div>
  </div></div>
  <div id="log3" class="mono"></div>
</div>

<div class="card">
  <div class="step"><span class="n">7</span><div>
    <b>PeerClaim</b>
    <div class="muted">
      Two addresses, <b>both immutable once deployed</b>. The token is the PEER from step 3 — the coin every claim pays out in. The steward is the account that opens epochs and is refunded whatever nobody claims: it must be a key <i>you hold</i>, because nothing here can ever change it.
    </div>
    <p><input id="claimPeer" placeholder="0x… your PEER token from step 3" spellcheck="false"></p>
    <p><input id="claimSteward" placeholder="0x… the steward — normally this wallet" spellcheck="false"></p>
    <div class="muted" style="font-size:13px">
      The steward can open an epoch — publish a root, a total and a deadline, once per epoch number, funded with PEER they deposit themselves — and reclaim what nobody claimed after the deadline. The steward <b>can also</b> publish a root whose leaves add up to more than the deposit, which makes that epoch first-come and reverts everyone after the money runs out: nothing on-chain holds the leaves, so no contract can check that sum and this one does not pretend to. Check it off-chain, against the leaf list published beside the root. The steward <b>cannot</b> mint (there is no mint), alter or re-open a published root, take back a claim already made, reach into an open epoch to stop one named claimant (no pause, no allowlist), or sweep early — <code>sweep</code> reverts before the deadline for everyone, and a claim window must be between 7 and 365 days. Deploying moves no coins; funding an epoch is a later, separate transaction you approve yourself.
    </div>
    <p><button id="goClaim" disabled>Deploy PeerClaim</button></p>
    <div class="muted" style="font-size:13px">
      Build fingerprint — SHA-256 of the PeerClaim bytecode <i>this page</i> will deploy:
      <div class="mono" style="margin:4px 0">${claimFp}</div>
      The same number comes out of <code>chain-l2/PeerClaim.build.json</code>.
    </div>
  </div></div>
  <div id="log4" class="mono"></div>
</div>

<p class="muted" style="font-size:13px">
Contracts: no owner, no mint function, no pause, no blacklist, no proxy. The token's whole supply is created once to you and after that it can only do what an ERC-20 does; the factory only does constant-product math on pools anyone can open; the anchor stores two hashes per poster per epoch; the claim contract can only ever pay out PEER that was deposited into it.
Compiled from <code>PeerToken.sol</code>, <code>PeerPools.sol</code>, <code>PeerAnchor.sol</code> and <code>PeerClaim.sol</code> with solc 0.8.24, optimizer on, 200 runs. All four bytecodes are embedded in this page; nothing is fetched.
</p>
</main>
<script>
const BYTECODE = ${JSON.stringify(build.bytecode)};
const BYTECODE_POOLS = ${JSON.stringify(pools.bytecode)};
const BYTECODE_ANCHOR = ${JSON.stringify(anchor.bytecode)};
const BYTECODE_CLAIM = ${JSON.stringify(claim.bytecode)};
const log = (m, cls, id) => { const d=document.getElementById(id||'log'); d.innerHTML += '<div class="'+(cls||'')+'">'+m+'</div>'; };
const log2 = (m, cls) => log(m, cls, 'log2');
const log3 = (m, cls) => log(m, cls, 'log3');
const log4 = (m, cls) => log(m, cls, 'log4');
let account = null;
let chainId = null;   // the last chain the WALLET reported — never what we asked for
let sending = false;  // a request is in MetaMask right now
let peerSent = false, poolsSent = false; // a deployment hash exists; do not offer a second
let anchorSent = false, claimSent = false;
${SHARED_JS}
// The connected row is rebuilt from state rather than written once, because
// the wallet moves underneath it: the user switches network in MetaMask, or
// another tab switches it for them. A row still saying "Base" while the wallet
// says otherwise is worse than no row at all — it is the row somebody trusts
// on the way to signing.
const renderWho = () => {
  const el = document.getElementById('who');
  if (!account) { el.textContent = ''; return; }
  el.innerHTML = account + '  ·  chain ' + (chainId ? parseInt(chainId, 16) : '?') +
    (onBase() ? ' <span class="ok">— Base</span>'
              : ' <span class="bad">— NOT Base. Switch to Base (8453); deploying is disabled.</span>');
  // The steward field starts as the connected account, because that is the
  // right answer almost every time and an empty field is where a wrong paste
  // goes. Only ever filled when EMPTY: overwriting a steward somebody typed
  // deliberately, every time the wallet fires accountsChanged, would be worse
  // than leaving it blank — the value is immutable once deployed.
  const sw = document.getElementById('claimSteward');
  if (sw && !sw.value.trim()) { sw.value = account; claimReady(); }
};

// Both Deploy buttons answer to the same conditions, so they are set together
// from one place rather than toggled at each site that changes one of them.
const syncButtons = () => {
  document.getElementById('go').disabled = !(account && onBase()) || sending || peerSent;
  poolsReady();
  // PeerAnchor takes no arguments, so there is nothing to validate — only the
  // same connected/on-Base/idle conditions every other button here answers to.
  document.getElementById('goAnchor').disabled = !(account && onBase()) || sending || anchorSent;
  claimReady();
};

document.getElementById('conn').onclick = async () => {
  if (!window.ethereum) { log('No wallet found in this browser. Open this page in a browser with MetaMask.', 'bad'); return; }
  try {
    const accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
    account = accs[0];
    chainId = await window.ethereum.request({ method: 'eth_chainId' });
    renderWho();
    if (!onBase()) {
      log('That is not Base. Asking MetaMask to switch…', 'bad');
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_ID }] });
        // Believe the wallet, not the resolved promise. A switch request that
        // returns means the dialog closed, which is not the same claim.
        chainId = await window.ethereum.request({ method: 'eth_chainId' });
        renderWho();
        if (!onBase()) { log('The wallet is still not on Base. Switch it by hand, then press Connect again.', 'bad'); return; }
        log('Switched to Base.', 'ok');
      } catch (e) { log('Could not switch: ' + (e.message||e) + ' — switch to Base by hand, then reconnect.', 'bad'); return; }
    }
    // Balance, so you find out you are short BEFORE signing rather than after.
    const bal = await window.ethereum.request({ method: 'eth_getBalance', params: [account, 'latest'] });
    const eth = Number(BigInt(bal)) / 1e18;
    log('Balance on Base: ' + eth.toFixed(6) + ' ETH');
    if (eth < 0.00005) log('That may be too little for gas. Deployment needs roughly 0.00002 ETH.', 'bad');
    syncButtons();
  } catch (e) { log('Connect failed: ' + (e.message || e), 'bad'); }
};

// The wallet tells us when the ground moves; without these the row above and
// the enabled buttons keep describing a wallet state that stopped being true.
// Not every provider implements .on, so this is an addition to requireBase and
// never a replacement for it.
if (window.ethereum && window.ethereum.on) {
  window.ethereum.on('chainChanged', (id) => {
    chainId = id; renderWho(); syncButtons();
    log(onBase() ? 'Wallet switched to Base.' : 'Wallet switched away from Base — deploying is disabled until it is back.', onBase() ? 'ok' : 'bad');
  });
  window.ethereum.on('accountsChanged', (accs) => {
    account = (accs && accs[0]) || null;
    renderWho(); syncButtons();
    log(account ? 'Account changed to ' + account + '.' : 'Wallet disconnected.', account ? '' : 'bad');
  });
}

document.getElementById('go').onclick = async () => {
  const raw = document.getElementById('supply').value.trim();
  if (!/^[0-9]+$/.test(raw) || BigInt(raw) <= 0n) { log('Supply must be a whole number greater than zero.', 'bad'); return; }
  // ABI-encode one uint256: 32 bytes, big-endian, left-padded. That is the
  // entire encoder this page needs, so it needs no library.
  const arg = BigInt(raw).toString(16).padStart(64, '0');
  sending = true; syncButtons();
  if (!(await requireBase(log))) { sending = false; syncButtons(); return; }
  log('Sending the deployment to MetaMask — approve it there.');
  try {
    const tx = await window.ethereum.request({
      method: 'eth_sendTransaction',
      // chainId in the params is a second lock on the same door: MetaMask
      // refuses a transaction whose chainId is not the selected network, which
      // closes the sliver between the check above and the signature. Wallets
      // that do not know the field ignore it, so it is the belt and the
      // re-read is the braces — not the other way round.
      params: [{ from: account, chainId: BASE_CHAIN_ID, data: BYTECODE + arg }],
    });
    peerSent = true;
    const receipt = await mined(tx, log);
    if (!receipt) return;
    log('Give this address to the host as PEER_TOKEN_ADDR, then GET /api/token/onchain reports it live.');
  } catch (e) {
    log('Refused or failed: ' + (e.message || e), 'bad');
  } finally {
    // Refused or failed leaves peerSent false, so the button comes back. Once
    // a hash exists it stays disabled even on the "not mined yet" path: an
    // unmined deployment is still a deployment, and a second press would buy
    // you two contracts and one address you wrote down.
    sending = false; syncButtons();
  }
};

// ---- pools factory ----
const peerIn = document.getElementById('peerAddr');
const btcIn = document.getElementById('btcAddr');
// Enabled only once connected, on Base, idle, and both fields look like
// addresses. A 40-hex check cannot catch a wrong-but-real address — MetaMask's
// confirmation screen and the basescan link afterwards are what catch that.
const poolsReady = () => {
  document.getElementById('goPools').disabled =
    !(account && onBase() && !sending && !poolsSent &&
      ADDR_RE.test(peerIn.value.trim()) && ADDR_RE.test(btcIn.value.trim()));
};
peerIn.oninput = poolsReady; btcIn.oninput = poolsReady;

document.getElementById('goPools').onclick = async () => {
  const peer = peerIn.value.trim(), btc = btcIn.value.trim();
  // The constructor would revert on equal addresses anyway — but a revert on
  // deployment still costs gas, so refuse here where refusing is free.
  if (peer.toLowerCase() === btc.toLowerCase()) { log2('PEER and BTC are the same address. The constructor rejects that; fix the paste.', 'bad'); return; }
  // Both sides are checked against the chain before anything is signed. The
  // pairing is immutable: a wrong address here is a contract that can never
  // trade, only be abandoned and redeployed.
  log2('Checking both addresses against Base before signing…');
  for (const t of [{ a: peer, n: 'PEER' }, { a: btc, n: 'BTC' }]) {
    let r = await probeToken(t.a, t.n);
    // One retry, only for the could-not-ask case: a public endpoint that
    // rate-limited the first read will usually answer the second.
    if (!r.ok && !r.sure) { await new Promise((s) => setTimeout(s, 1200)); r = await probeToken(t.a, t.n); }
    if (!r.ok && r.sure) {
      log2('The ' + t.n + ' address is not a token: ' + r.why, 'bad');
      log2('Nothing was signed and nothing was spent. The pairing is immutable, so this is worth getting right.', 'muted');
      return;
    }
    if (!r.ok) {
      log2('Could not check the ' + t.n + ' address — ' + r.why, 'bad');
      log2('This is not a verdict on your address; the chain simply did not answer. Press Deploy again to retry.', 'muted');
      return;
    }
    log2('  ' + t.n + ' ' + t.a + ' — ' + r.note, 'ok');
  }
  // ABI-encode two addresses: each one 32-byte word, the 20 address bytes
  // right-aligned. Appended to the bytecode, same scheme as the uint256 above.
  const word = (a) => a.slice(2).toLowerCase().padStart(64, '0');
  sending = true; syncButtons();
  // Same re-read as the token, for the same reason and with more at stake: the
  // factory is the contract other people's cbBTC ends up inside.
  if (!(await requireBase(log2))) { sending = false; syncButtons(); return; }
  log2('Sending the deployment to MetaMask — approve it there.');
  try {
    const tx = await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from: account, chainId: BASE_CHAIN_ID, data: BYTECODE_POOLS + word(peer) + word(btc) }],
    });
    poolsSent = true;
    const receipt = await mined(tx, log2);
    if (!receipt) return;
    const blk = receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : null;
    log2('The host wants both: the address as PEER_POOLS_ADDR' + (blk !== null ? ', the block as PEER_POOLS_FROM_BLOCK' : '') + '. Then GET /api/token/onchain lists the named pools live.');
    log2('Write them down now — this page keeps nothing.', 'muted');
  } catch (e) {
    log2('Refused or failed: ' + (e.message || e), 'bad');
  } finally {
    sending = false; syncButtons();
  }
};

// ---- the epoch contracts ----

document.getElementById('goAnchor').onclick = async () => {
  sending = true; syncButtons();
  // Same last-moment re-read as every other deployment here. There is nothing
  // else to check: PeerAnchor takes no arguments, so there is no paste to get
  // wrong and no pairing to fix forever.
  if (!(await requireBase(log3))) { sending = false; syncButtons(); return; }
  log3('Sending the deployment to MetaMask — approve it there.');
  try {
    const tx = await window.ethereum.request({
      method: 'eth_sendTransaction',
      // No constructor argument, so the data IS the bytecode with nothing
      // appended — not an empty argument list, which would be the same bytes
      // written in a way that invites somebody to "fix" it later.
      params: [{ from: account, chainId: BASE_CHAIN_ID, data: BYTECODE_ANCHOR }],
    });
    anchorSent = true;
    const receipt = await mined(tx, log3);
    if (!receipt) return;
    log3('Give the host this address as PEER_ANCHOR_ADDR, and the block above as PEER_EPOCH_FROM_BLOCK.');
    log3('One from-block covers both epoch contracts, so if you deploy PeerClaim too, use the LOWER of the two block numbers. Err low: too low costs a little scanning, too high silently hides everything anchored before it.', 'muted');
    log3('Write them down now — this page keeps nothing.', 'muted');
  } catch (e) {
    log3('Refused or failed: ' + (e.message || e), 'bad');
  } finally {
    sending = false; syncButtons();
  }
};

const claimPeerIn = document.getElementById('claimPeer');
const claimStewardIn = document.getElementById('claimSteward');
const claimReady = () => {
  document.getElementById('goClaim').disabled =
    !(account && onBase() && !sending && !claimSent &&
      ADDR_RE.test(claimPeerIn.value.trim()) && ADDR_RE.test(claimStewardIn.value.trim()));
};
claimPeerIn.oninput = claimReady; claimStewardIn.oninput = claimReady;

document.getElementById('goClaim').onclick = async () => {
  const peer = claimPeerIn.value.trim(), steward = claimStewardIn.value.trim();
  // Both arguments are immutable in PeerClaim. There is no setToken, no
  // setSteward and no upgrade path — a wrong address here is a contract that
  // can only be abandoned and redeployed, so every check that is free happens
  // before the signature rather than after it.
  if (peer.toLowerCase() === steward.toLowerCase()) {
    log4('The token and the steward are the same address. One of them is a paste of the other; fix it before signing.', 'bad');
    return;
  }
  log4('Checking both addresses against Base before signing…');
  // The TOKEN is checked exactly the way the pools card checks its pair: it
  // must be a real ERC-20 on Base, and pasting a wallet here is the mistake
  // that already cost one factory redeployment.
  let t = await probeToken(peer, 'PEER');
  if (!t.ok && !t.sure) { await new Promise((s) => setTimeout(s, 1200)); t = await probeToken(peer, 'PEER'); }
  if (!t.ok && t.sure) {
    log4('The token address is not a token: ' + t.why, 'bad');
    log4('Nothing was signed and nothing was spent. The token is immutable here, so this is worth getting right.', 'muted');
    return;
  }
  if (!t.ok) {
    log4('Could not check the token address — ' + t.why, 'bad');
    log4('This is not a verdict on your address; the chain simply did not answer. Press Deploy again to retry.', 'muted');
    return;
  }
  log4('  PEER ' + peer + ' — ' + t.note, 'ok');

  // The STEWARD is checked with the SAME probe read the OTHER WAY ROUND, and
  // that inversion is the point rather than an oversight of the rule above.
  // probeToken answers one question — "is there an ERC-20 at this address" —
  // and the two arguments want opposite answers to it. The token must be a
  // token. The steward must be something that can SEND a transaction, because
  // openEpoch and nothing else is what the role does; a token contract there
  // is an epoch nobody can ever open, permanently, on a contract with no way
  // to correct it. Refusing a steward for "having no code" would be the same
  // check misapplied: an ordinary wallet has no code, which is exactly right.
  let s = await probeToken(steward, 'steward');
  if (!s.ok && !s.sure) { await new Promise((x) => setTimeout(x, 1200)); s = await probeToken(steward, 'steward'); }
  if (s.ok) {
    log4('The steward address is an ERC-20 token (' + s.note + '), not an account. Only the steward can ever open an epoch, and a token contract will never call openEpoch — this pairing is immutable, so it would be a contract nobody could use.', 'bad');
    log4('Nothing was signed and nothing was spent.', 'muted');
    return;
  }
  if (!s.sure) {
    log4('Could not check the steward address — ' + s.why, 'bad');
    log4('This is not a verdict on your address; the chain simply did not answer. Press Deploy again to retry.', 'muted');
    return;
  }
  // A definite "not a token" is the expected answer for a steward, and the
  // two shapes it comes in are not the same news. No code at all is an
  // ordinary wallet — right. Code that is not an ERC-20 might be a multisig
  // you control, which is a perfectly good steward, or it might be a paste of
  // some other contract entirely, which is not; this page cannot tell those
  // apart, so it says so instead of picking one.
  if (/does not answer decimals/.test(s.why)) {
    log4('  steward ' + steward + ' — a contract that is not a token. Fine if that is a multisig you control; wrong if you meant a wallet.', 'bad');
  } else {
    log4('  steward ' + steward + ' — an ordinary account, no contract code', 'ok');
  }
  if (account && steward.toLowerCase() !== account.toLowerCase()) {
    log4('NOTE: the steward is NOT the wallet you are deploying from. Only ' + steward + ' will ever be able to open an epoch here, and that cannot be changed afterwards. MetaMask is about to ask — refuse it if that is not what you meant.', 'bad');
  }

  const word = (a) => a.slice(2).toLowerCase().padStart(64, '0');
  sending = true; syncButtons();
  if (!(await requireBase(log4))) { sending = false; syncButtons(); return; }
  log4('Sending the deployment to MetaMask — approve it there.');
  try {
    const tx = await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from: account, chainId: BASE_CHAIN_ID, data: BYTECODE_CLAIM + word(peer) + word(steward) }],
    });
    claimSent = true;
    const receipt = await mined(tx, log4);
    if (!receipt) return;
    log4('Give the host this address as PEER_CLAIM_ADDR, and the block above as PEER_EPOCH_FROM_BLOCK (the lower of this and the PeerAnchor block).');
    log4('Deploying moved no coins. An epoch becomes claimable only when the steward approves this contract for that epoch\\'s total and calls openEpoch — two transactions you sign yourself, out of PEER you already hold.', 'muted');
    log4('Write them down now — this page keeps nothing.', 'muted');
  } catch (e) {
    log4('Refused or failed: ' + (e.message || e), 'bad');
  } finally {
    sending = false; syncButtons();
  }
};
</script></body></html>`;
fs.writeFileSync('chain-l2/deploy.html', html);

// ══════════════════════════════════════════════════════════════════════════
// setup.html — the same deployments, in one press, with the copying removed.
// ══════════════════════════════════════════════════════════════════════════
//
// deploy.html is a set of cards you work through, each one printing an
// address you then paste somewhere else. That is honest and it is also where
// the mistakes live: the address goes into the wrong file, the block number
// is skipped because it looked optional, the host is never restarted, and
// four days later the app says the claim surface is off with everything
// deployed and paid for. This page does the same deployments in one sequence
// and carries the addresses itself.
//
// What it does NOT do, and cannot: sign. The signatures stay in MetaMask,
// four of them, each named on screen before the wallet asks. Nothing in this
// repository is allowed to become a script holding a key, and "one click"
// stops exactly there — it means one command and one button, not one
// signature and no idea what it was for.
//
// ── THE CONTRACT WITH THE SETUP SCRIPT ────────────────────────────────────
// This page is a browser tab: it cannot write a file and it cannot restart a
// host. Something local has to do that, so this page and that script have to
// agree on three things. All three are written here AND in the page itself,
// because an agreement documented on one side only is an agreement until
// somebody edits the other side.
//
// 1. WHERE THE HOST IS, and where to send the addresses. The page reads, in
//    this order of precedence:
//       ?host=http://127.0.0.1:5210        query parameter, wins
//       <meta name="peer-host" content>    the script may rewrite this file
//       http://127.0.0.1:5210              the default
//    and the same three for the callback (?callback=, peer-callback,
//    defaulting to the page's own origin, which is the expected case: the
//    setup script serves this file, so callback and page are one origin and
//    no CORS question exists at all).
//    BOTH must be loopback. A ?host= pointing anywhere else is refused, in
//    words, before the button works — a link is a thing somebody can send
//    you, and the callback below writes a contract address into the config
//    of a host that serves real coins.
//
// 2. THE CALLBACK: POST {callback}/api/setup/deployed, Content-Type
//    application/json, body:
//
//    {
//      "kind": "peer-setup-deployed",   // constant; refuse anything else
//      "v": 1,                          // this shape's version
//      "nonce": "…",                    // echoed from ?nonce=, see below
//      "chainId": 8453,
//      "account": "0x…",                // the wallet that deployed
//      "token":   "0x…",                // the PEER the host already reports
//      "btc":     "0x…",                // cbBTC on Base
//      "anchor": { "address": "0x…", "block": 34567890, "tx": "0x…" },
//      "claim":  { "address": "0x…", "block": 34567891, "tx": "0x…" },
//      "pools":  { "address": "0x…", "block": 34567892, "tx": "0x…" },
//      "epochFromBlock": 34567890,      // the LOWER of anchor/claim, computed
//      "builds": { "anchor": "sha256:…", "claim": "sha256:…", "pools": "sha256:…" }
//    }
//
//    Every contract key is OPTIONAL and the script writes only what is
//    present: the page posts again when it later deploys the pools factory,
//    and a second post must not erase what the first one set. The mapping the
//    script is expected to make, each name straight out of load-config.ps1:
//
//      anchor.address  -> server-data\anchor-address.txt   PEER_ANCHOR_ADDR
//      claim.address   -> server-data\claim-address.txt    PEER_CLAIM_ADDR
//      epochFromBlock  -> server-data\epoch-from-block.txt PEER_EPOCH_FROM_BLOCK
//      pools.address   -> server-data\pools-address.txt    PEER_POOLS_ADDR
//      pools.block     -> server-data\pools-from-block.txt PEER_POOLS_FROM_BLOCK
//      btc             -> server-data\btc-token-address.txt PEER_BTC_ADDR (only if absent)
//
//    epochFromBlock is computed HERE rather than left to the script, because
//    the rule is not obvious and getting it wrong is silent: one from-block
//    covers both epoch contracts, so it must be the LOWER of the two, and
//    erring low costs a little scanning while erring high hides everything
//    opened before it. A number the page already has should not be an
//    instruction the script has to remember.
//
//    Answer 200 with {"ok":true} once the files are written. Anything else,
//    and the page shows the status and the raw body and tells the operator
//    exactly which three files to write by hand — a failed callback must
//    never look like a failed deployment, because the contracts exist either
//    way and they cost money.
//
//    THE NONCE, and why a local endpoint needs one. Any page in any tab can
//    POST to 127.0.0.1, and this endpoint points a live host at a contract
//    address. So the script generates a random nonce, opens the browser at
//    …/setup.html?nonce=<it>, and refuses any POST that does not carry it
//    back. That is the difference between "the operator pressed the button"
//    and "some page they had open in another tab did". The script should also
//    stop listening once it has taken one good callback, for the same reason.
//
// 3. THE STATUS ENDPOINT, GET {callback}/api/setup/status, which is OPTIONAL:
//       { "state": "waiting"|"writing"|"restarting"|"ready"|"error",
//         "note":  "one sentence for a person, changes as it goes",
//         "error": "…"   // only with state:error }
//    It exists so a person watching a spinner learns what is happening. It is
//    narration and never the verdict: the page decides the host is back by
//    asking THE HOST — GET /api/token/onchain until claimState.contract is
//    the address it just deployed. A script that answers 404 here is a
//    perfectly good script, and one that says "ready" while the host says
//    otherwise is not believed.
//
//    One exception to "narration only": if the script answers a non-2xx to the
//    callback with {"filesWritten": true}, the page believes that much. It
//    means the addresses WERE recorded and the failure is downstream — the host
//    did not come back — so the page must not send anybody off to write files
//    that already say the right thing.
//
// 4. WHAT THE SCRIPT ALREADY KNOWS, GET {callback}/state?nonce=…, and this one
//    is read BEFORE the first signature rather than after it:
//       { "nonceOk": true|false,      // is this tab from the run that is
//                                     // listening? Only an explicit false is a
//                                     // verdict; a script that omits the field
//                                     // is simply an older script.
//         "nonceWhy": "…",            // words for the operator when it is false
//         "configured": { "anchor": "0x…"|null, "claim": …, "pools": … },
//         "hostReports": { … },       // the same three as the HOST serves them
//         "allowReplace": true|false }
//
//    Each of those closed a hole that cost real money, and all three holes were
//    the same shape: the page knew one half of the truth and the script knew
//    the other, and neither asked.
//      nonceOk — the nonce used to be tested only when the addresses were
//        POSTed, which is after two irreversible deployments. The script takes
//        the first free port from 8930 up, so the next run usually binds the
//        port the last one used and a stale tab reloads onto a live listener
//        that will refuse it. Asked at load and again at every press.
//      configured — the page planned entirely from the host and the script
//        gated entirely on its files. In the one state where those differ —
//        files written, restart never taken — the page saw no claim contract,
//        deployed a second one, and was refused. An address server-data names
//        is ADOPTED (after eth_getCode says something is there), never deployed
//        over. Where the host and the files name DIFFERENT addresses, the page
//        stops: that is a question about which contract is real.
//      allowReplace — the operator answers "do not replace what is recorded" in
//        the terminal, before the browser opens. The page now refuses to sign
//        what the script would refuse to write, instead of finding out after.
const setupHtml = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Set everything up — Peer Network</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="peeranchor-build" content="sha256:${anchorFp}">
<meta name="peerclaim-build" content="sha256:${claimFp}">
<meta name="peerpools-build" content="sha256:${poolsFp}">
<!-- The setup script MAY rewrite these three before serving this file; a
     ?host= / ?callback= / ?nonce= in the URL wins over them. Left empty here
     because a value baked into a generated file is a value nobody chose. -->
<meta name="peer-host" content="">
<meta name="peer-callback" content="">
<meta name="peer-setup-nonce" content="">
<style>
  :root{--paper:#131110;--ink:#EFE7DB;--muted:#9C8E7E;--ember:#B84525;--ok:#3f7d4e;--line:#2a2622}
  body{background:var(--paper);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:28px 18px 80px}
  main{max-width:680px;margin:0 auto}
  h1{font-size:22px;margin:0 0 4px} .sub{color:var(--muted);margin:0 0 22px}
  h2{font-size:19px;margin:36px 0 4px}
  .card{border:1px solid var(--line);border-radius:10px;padding:16px;margin:14px 0;background:#181513}
  button{background:var(--ember);color:#fff;border:0;border-radius:7px;padding:13px 22px;font-size:16px;cursor:pointer}
  button:disabled{background:#3a3531;color:#7d746c;cursor:not-allowed}
  code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all}
  .ok{color:var(--ok)} .bad{color:var(--ember)} .muted{color:var(--muted)}
  .hd{color:var(--ink);font-weight:700;margin-top:6px}
  .now{font-size:17px;font-weight:700;margin:14px 0 6px;min-height:1.4em}
  #log{white-space:pre-wrap;margin-top:10px;max-height:60vh;overflow-y:auto}
  ol{padding-left:22px} li{margin:3px 0}
  input{background:#0f0d0c;border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:9px;width:100%;box-sizing:border-box;font-family:ui-monospace,monospace}
  a{color:var(--ember)}
  .plan{margin:8px 0 0}
</style></head><body><main>
<h1>Set everything up</h1>
<p class="sub">One button, and everything between the signatures is automatic. Your key never leaves MetaMask: this page holds no secret, asks for none, and signs nothing — it hands MetaMask a transaction and MetaMask asks you. Four of the steps below are that ask, and each one is named on screen before it arrives.</p>

<div class="card">
  <b>What one press does</b>
  <ol class="muted">
    <li>Asks the setup script whether this page belongs to the run that is listening, and what it already has recorded — before anything is signed, so a tab left over from an earlier run stops here instead of paying for two contracts nobody will record.</li>
    <li>Reads your wallet and this host: what is already deployed, how much PEER and ETH you hold, which epochs have closed and which of them have anything to claim.</li>
    <li>Deploys <b>PeerAnchor</b>, then <b>PeerClaim</b> against the PEER the host reports and you as steward — checking there is really code at each address before going on.</li>
    <li>Hands both addresses and their block numbers to the setup script, which writes them into <code>server-data</code> and restarts the host.</li>
    <li>Waits for the host to come back pointing at them, and takes the host's own answer for that rather than the script's word.</li>
    <li>Approves exactly what the epoch needs, then opens the epoch with the root and total read from the host at that moment — never a number written into this page.</li>
    <li>Reads the epoch back off the chain and checks a real proof against it, so the last line is a fact rather than a promise.</li>
  </ol>
  <div class="muted">Pressing again after a stop carries on: every step asks the chain what is already true before it does anything, so a deployed contract is adopted rather than deployed twice, an approve that landed is a standing allowance, and an epoch that is already open is left alone.</div>
</div>

<div class="card">
  <b>Where this page is pointed</b>
  <div id="cfg" class="mono muted" style="margin-top:8px"></div>
</div>

<div class="card">
  <p><button id="go">Set everything up</button></p>
  <div id="who" class="mono muted"></div>
  <div id="now" class="now"></div>
  <div id="plan" class="muted plan"></div>
</div>

<div class="card"><div id="log" class="mono">Nothing has happened yet.</div></div>

<div class="card" id="poolCard" style="display:none">
  <b>Open the first pool</b>
  <div class="muted">The factory is deployed and the host can see it. Opening a pool is the one thing here that is not setup: it puts your PEER and your cbBTC into a contract at a price you are choosing by picking the two amounts. Nothing on this page will choose them for you.</div>
  <p><input id="poolName" value="main" spellcheck="false" placeholder="pool name, up to 32 bytes"></p>
  <p><input id="poolPeer" placeholder="PEER to deposit, e.g. 100000" spellcheck="false"></p>
  <p><input id="poolBtc" placeholder="cbBTC to deposit, e.g. 0.001" spellcheck="false"></p>
  <div class="muted" style="font-size:13px">Those two amounts ARE the opening price, and the first trade will move it. Three more MetaMask prompts: approve PEER, approve cbBTC, then createPool.</div>
  <p><button id="goPool">Open this pool</button></p>
</div>

<div class="card muted" style="font-size:13px">
  <b>What this page will deploy</b> — SHA-256 of the bytecode embedded here, which is what your wallet is handed:
  <div class="mono" style="margin:6px 0">PeerAnchor  ${anchorFp}</div>
  <div class="mono" style="margin:6px 0">PeerClaim   ${claimFp}</div>
  <div class="mono" style="margin:6px 0">PeerPools   ${poolsFp}</div>
  The same numbers come out of <code>chain-l2/PeerAnchor.build.json</code>, <code>PeerClaim.build.json</code> and <code>PeerPools.build.json</code>, and the setup script compares them against this file before it opens it. If they differ, the page you are looking at is an older copy of this repository — a different, and permanent, contract.
  <p>Compiled from <code>PeerAnchor.sol</code>, <code>PeerClaim.sol</code> and <code>PeerPools.sol</code> with solc 0.8.24, optimizer on, 200 runs. No owner, no mint, no pause, no proxy. All three bytecodes are embedded here; nothing is fetched. The long form of what each contract can and cannot do is on <code>deploy.html</code> beside this file, and in the header of each .sol.</p>
</div>
</main>
<script>
const BYTECODE_ANCHOR = ${JSON.stringify(anchor.bytecode)};
const BYTECODE_CLAIM = ${JSON.stringify(claim.bytecode)};
const BYTECODE_POOLS = ${JSON.stringify(pools.bytecode)};
const FP = { anchor: '${anchorFp}', claim: '${claimFp}', pools: '${poolsFp}' };
// cbBTC on Base, 8 decimals. Only a fallback: the host names its own BTC side
// and that answer wins, because a constant in a page is a value nobody chose.
const CBBTC_FALLBACK = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';

let account = null;
let chainId = null;   // the last chain the WALLET reported — never what we asked for
${SHARED_JS}
// ---- the selectors, by hand ----
// Four bytes each, the signature beside it, taken from the "hashes" block of
// the same build.json the bytecode above came from. No ABI library and no
// keccak library on this page: the house rule, and also the reason these can
// be checked by eye against the artifact.
const S_OPEN_EPOCH  = '0x02179e67'; // openEpoch(uint256,bytes32,uint256,uint64)
const S_EPOCH_INFO  = '0x3894228e'; // epochInfo(uint256)
const S_CHECK_CLAIM = '0x65574c78'; // checkClaim(uint256,address,uint256,bytes32[])
const S_CLAIMED     = '0x120aa877'; // claimed(uint256,address)
const S_STEWARD     = '0x637eea19'; // steward()
const S_CLAIM_TOKEN = '0xfc0c546a'; // token()
const S_MIN_WINDOW  = '0x52b65c4b'; // MIN_WINDOW()
const S_MAX_WINDOW  = '0xdeb96634'; // MAX_WINDOW()
const S_APPROVE     = '0x095ea7b3'; // approve(address,uint256)
const S_ALLOWANCE   = '0xdd62ed3e'; // allowance(address,address)
const S_BALANCE_OF  = '0x70a08231'; // balanceOf(address)
const S_CREATE_POOL = '0xb3a2199d'; // createPool(bytes32,uint256,uint256)
const S_POOL_COUNT  = '0xf525cb68'; // poolCount()
const S_POOLS_PEER  = '0x11cda415'; // peer()
const S_POOLS_BTC   = '0xa28d57d8'; // btc()

const $ = (id) => document.getElementById(id);
// Everything that came from outside this page — the host's JSON, a wallet's
// error message, a name somebody typed — goes through here before it reaches
// innerHTML. The log is markup so it can carry Basescan links; a log that
// renders whatever a remote answer contains is a log that remote answer gets
// to write.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
let logStarted = false;
const log = (m, cls) => {
  const d = $('log');
  if (!logStarted) { d.innerHTML = ''; logStarted = true; }
  d.innerHTML += '<div class="' + (cls || '') + '">' + (m === '' ? '&nbsp;' : m) + '</div>';
  d.scrollTop = d.scrollHeight;
};
function renderWho() {
  const el = $('who');
  if (!account) { el.textContent = ''; return; }
  el.innerHTML = esc(account) + '  ·  chain ' + (chainId ? parseInt(chainId, 16) : '?') +
    (onBase() ? ' <span class="ok">— Base</span>'
              : ' <span class="bad">— NOT Base (8453). Nothing will be sent.</span>');
}

// ---- where this page is pointed, and the rule that it must be here ----
const QS = new URLSearchParams(location.search);
const metaOf = (n) => { const m = document.querySelector('meta[name="' + n + '"]'); return m ? String(m.content || '').trim() : ''; };
const noSlash = (u) => String(u || '').trim().replace(/\/+$/, '');
// Loopback only, and it is a rule rather than a default. This page reads a
// host's configuration and then POSTs a contract address back into it; a URL
// is a thing somebody can send you, and "open this link" must not be a way to
// point a live host at somebody else's contract. Everything here runs on the
// machine the host runs on, so nothing legitimate is lost by refusing the
// rest.
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?$/i;
function pointedAt(qkey, mkey, dflt) {
  let v = noSlash(QS.get(qkey) || ''), src = 'the ?' + qkey + '= in this page\'s URL';
  if (!v) { v = noSlash(metaOf(mkey)); src = 'the <meta name="' + mkey + '"> the setup script wrote into this file'; }
  if (!v) { v = noSlash(dflt); src = 'the built-in default'; }
  return { url: v, src: src, ok: LOOPBACK.test(v) };
}
const HOSTC = pointedAt('host', 'peer-host', 'http://127.0.0.1:5210');
const CBC = pointedAt('callback', 'peer-callback', noSlash(location.origin));
const HOST = HOSTC.url, CB = CBC.url;
const NONCE = String(QS.get('nonce') || metaOf('peer-setup-nonce') || '');

// ---- is this the run that opened this tab? ----
// The nonce used to be checked in exactly one place: the setup script, when
// the addresses were POSTed to it. That is step three of the plan — after two
// irreversible deployments — so a tab left over from an earlier run learned it
// was stale by having its hand-over refused, with the gas already spent. And
// stale is the ordinary case, not an exotic one: the script takes the first
// free port from 8930 upwards, so the next run almost always binds the port
// the last one used, and an old tab reloaded there loads the NEW page from the
// NEW listener while its URL still carries the OLD nonce.
//
// The listener answers GET before anything is signed. It always did. So the
// question is asked at load, for free, and the button is dead if the answer is
// no.
//   'unchecked' — asked, no answer yet
//   'ok'        — this run's nonce
//   'stale'     — a nonce, and not this run's: nothing this page deploys would
//                 be recorded, so nothing is deployed
//   'absent'    — no nonce at all. Not fatal and never has been: the page still
//                 works standalone (serve-deploy.mjs), the hand-over is refused,
//                 and you write the three files by hand. It says so up front.
//   'unreachable' — no setup script there. Same as absent, for the same reason.
let nonceState = NONCE ? 'unchecked' : 'absent';
let nonceWhy = '';
const cfgOk = () => HOSTC.ok && CBC.ok && nonceState !== 'stale' && nonceState !== 'unchecked';
function renderCfg() {
  const row = (label, c) => '<div>' + label + ' <b>' + esc(c.url || '(nothing)') + '</b>'
    + (c.ok ? '' : ' <span class="bad">— REFUSED: not a loopback address</span>')
    + '<div class="muted" style="font-size:12px">from ' + esc(c.src) + '</div></div>';
  let h = row('the host:', HOSTC) + row('the setup script:', CBC);
  const nonceLine = {
    unchecked: ['muted', 'A nonce was passed in, but this page has not yet confirmed with the setup script that it is the current one. Asking — nothing runs until it answers.'],
    ok: ['ok', 'The setup script confirms this nonce is the one it is listening for, so it can tell this press from any other page you have open.'],
    stale: ['bad', 'THIS TAB IS FROM AN EARLIER RUN. ' + (nonceWhy || 'The setup script listening on that port is not the one that opened this page, so it would refuse everything this page deployed — after you had paid for it. Close this tab and open the URL the running script printed.')],
    absent: ['muted', 'No nonce was passed in. The setup script may refuse the callback for that reason — it is how it tells this press apart from any other page you have open. Everything else works; you would write the three files by hand.'],
    unreachable: ['muted', 'No setup script answered at that address, so this page cannot confirm its nonce and cannot hand anything over. Everything else works; you would write the three files by hand.'],
  }[nonceState];
  h += '<div class="' + nonceLine[0] + '" style="font-size:12px;margin-top:8px">' + esc(nonceLine[1]) + '</div>';
  if (!HOSTC.ok || !CBC.ok) {
    h += '<div class="bad" style="margin-top:8px">Both must be http://127.0.0.1 or http://localhost. This page configures a running host, so it only talks to one on this machine. Nothing on this page will run until that is true.</div>';
  }
  if (location.protocol === 'file:') {
    h += '<div class="bad" style="margin-top:8px">This page was opened as a file. MetaMask does not inject into file:// pages, so there is no wallet here at all — serve it over http from the setup script, or with <code>node chain-l2/serve-deploy.mjs</code> and open http://127.0.0.1:8899/setup.html.</div>';
  }
  $('cfg').innerHTML = h;
}
renderCfg();

// ONE GET, and it answers three separate questions this page used to guess at:
// whether this tab belongs to the run that is listening, what server-data
// NAMES, and whether that run may record a different address over a recorded
// one. Called at load to settle the button, and again as the first act of every
// press — the tab could have been sitting here while one run ended and another
// took the port, and only the press-time answer is about the run that would
// actually receive the addresses.
//
// Returns the script's state, or null when there is nothing to ask.
async function readSetupScript() {
  if (!CBC.ok || !NONCE) return null;
  let st = null;
  try { st = await getJson(CB + '/state?nonce=' + encodeURIComponent(NONCE), 'asking the setup script what it already knows'); }
  catch (e) { nonceState = 'unreachable'; nonceWhy = String(e.message || e); renderCfg(); sync(); return null; }
  // An older setup script that does not answer nonceOk at all is not evidence
  // of staleness, and treating a missing field as false would brick a page that
  // is perfectly current. Only an explicit false is a verdict.
  if (st && st.nonceOk === false) {
    nonceState = 'stale'; nonceWhy = String(st.nonceWhy || '');
    renderCfg(); sync();
    return st;
  }
  if (st && st.nonceOk === true) { nonceState = 'ok'; }
  else { nonceState = 'unreachable'; nonceWhy = 'that setup script does not answer nonceOk, so this page cannot tell whether it is the current one.'; st = null; }
  renderCfg(); sync();
  return st;
}

// ---- the little that is remembered, and why ----
// Everything this page needs it re-reads from the chain or from the host on
// the next press — with ONE exception. A contract that was deployed and whose
// address was never handed over is remembered nowhere else: not by the host,
// which has not been told, and not by the chain, which cannot be asked "did
// this wallet deploy a PeerAnchor". Closing the tab there costs a redeployment
// for nothing.
//
// This used to say exactly that and then store the record in sessionStorage,
// which survives a reload and a re-press and is destroyed by the one event the
// paragraph names: closing the tab. So it is localStorage now, keyed to the
// account AND the chain, because the record is about what that account
// deployed and a different account's deployments are not an answer about this
// one. Nothing secret goes in it — a contract address is public the moment it
// is mined — and nothing in it is believed: every address is checked against
// eth_getCode, and the host's own answer wins wherever both have one.
const memKey = () => 'peer-setup-' + BASE_CHAIN_NUM + '-' + String(account || '').toLowerCase();
function remember() {
  const rec = JSON.stringify({
    account: account, anchor: S.anchor, anchorBlock: S.anchorBlock, anchorTx: S.anchorTx,
    claim: S.claim, claimBlock: S.claimBlock, claimTx: S.claimTx,
    pools: S.pools, poolsBlock: S.poolsBlock, poolsTx: S.poolsTx,
  });
  // Both stores, and neither is required. Some privacy modes throw on the very
  // first localStorage touch, and there sessionStorage is still better than
  // nothing — it at least survives the re-press.
  try { localStorage.setItem(memKey(), rec); } catch (e) { /* see below */ }
  try { sessionStorage.setItem(memKey(), rec); } catch (e) { /* the addresses are in the log either way */ }
}
function recall() {
  for (const store of [localStorage, sessionStorage]) {
    try {
      const v = JSON.parse(store.getItem(memKey()) || 'null');
      if (v) return v;
    } catch (e) { /* unavailable or unparseable: try the other, then give up */ }
  }
  return null;
}
const S = {
  anchor: null, anchorBlock: null, anchorTx: null,
  claim: null, claimBlock: null, claimTx: null,
  pools: null, poolsBlock: null, poolsTx: null,
  token: null, btc: null, btcDec: 8, peerDec: 18,
};

// ---- what has landed, what it cost ----
// Kept across presses on purpose: "what stands" is the whole session's answer,
// not this attempt's.
const DONE = [];
let spent = 0n;
let running = false;
let RUN_ACCOUNT = null;
let curLine = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stands = (line) => { DONE.push(line); };
function charge(r) {
  // Both halves or neither. A receipt missing effectiveGasPrice would
  // multiply out to zero, and "cost 0 ETH" is a worse answer than "this page
  // could not read it" — the whole point of the line is telling somebody what
  // they have already spent.
  try {
    if (!r || !r.gasUsed || !r.effectiveGasPrice) return 'an amount this page could not read off the receipt';
    const g = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice);
    spent += g;
    return units(g, 18) + ' ETH';
  } catch (e) { return 'an amount this page could not read off the receipt'; }
}
function setNow(t) { curLine = t; $('now').textContent = t; }
// A waiting step redraws the seconds beside the step line WITHOUT rewriting
// curLine — the first version appended to it and the line grew a tail of every
// tick it had ever drawn.
function tick(secs) { $('now').textContent = curLine + '  (' + secs + 's)'; }
function sync() {
  const b = $('go');
  b.disabled = running || !cfgOk();
  b.textContent = running ? 'Working — watch the line below'
    : (nonceState === 'stale' ? 'This tab is from an earlier run'
    : (nonceState === 'unchecked' ? 'Checking with the setup script…'
    : (DONE.length ? 'Carry on from where it stopped' : 'Set everything up')));
}
// The steward is fixed at deployment and the approve is granted by one
// account. A wallet that switches accounts mid-run would sign the next step as
// somebody else, and PeerClaim can never be repointed afterwards.
function sameAccount() {
  if (RUN_ACCOUNT && (!account || account.toLowerCase() !== RUN_ACCOUNT.toLowerCase())) {
    const e = new Error('the wallet switched accounts mid-run (' + RUN_ACCOUNT + ' to ' + (account || 'none') + '). Stopping rather than signing the next step as somebody else — PeerClaim fixes its steward at deployment and can never be repointed.');
    e.hard = true; throw e;
  }
}

function summary() {
  log('');
  log('— WHAT STANDS —', 'hd');
  if (!DONE.length) {
    log('Nothing was signed, so nothing was spent and nothing changed on chain.', 'muted');
  } else {
    for (const d of DONE) log('  · ' + d);
    log('');
    log('Spent in this tab so far: ' + units(spent, 18) + ' ETH.', 'muted');
  }
  log('');
  log('Pressing the button again repeats only what has NOT landed. Before each', 'muted');
  log('step it asks the chain what is already true:', 'muted');
  log('  · a contract already deployed is adopted, never deployed twice;', 'muted');
  log('  · an approve that landed is a standing allowance and is not signed', 'muted');
  log('    again while it still covers the total — it is a permission you have', 'muted');
  log('    already given to that contract, and it stays given until you change', 'muted');
  log('    it, whether or not you ever press this button again;', 'muted');
  log('  · an epoch already open is left alone. openEpoch is once per epoch', 'muted');
  log('    number, forever: a second call reverts and costs you the gas.', 'muted');
}

async function getJson(url, what) {
  let r;
  try { r = await fetch(url, { method: 'GET', cache: 'no-store' }); }
  catch (e) { const err = new Error(what + ': nothing answered at ' + url + ' (' + (e.message || e) + ')'); err.offline = true; throw err; }
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* handled below */ }
  if (!r.ok) {
    const err = new Error(what + ': ' + url + ' answered ' + r.status + ' — ' + ((j && (j.error || j.code)) || text.slice(0, 200)));
    err.status = r.status; err.body = j; throw err;
  }
  if (!j) throw new Error(what + ': that answer was not JSON — ' + text.slice(0, 200));
  return j;
}

// One deployment, start to finish, with the two checks that matter either side
// of it: the chain is re-read on the line before the signature, and the code
// is read back afterwards. A receipt with status 1 is the chain saying the
// transaction succeeded; code at the address is the chain saying the CONTRACT
// is there, and they are not the same claim — a constructor that reverts on
// its own require leaves a failed receipt, but there are enough ways to end up
// with an address and nothing at it that this is worth one free read.
async function deployOne(label, data) {
  sameAccount();
  if (!(await requireBase(log))) { const e = new Error('the wallet is not on Base — nothing was sent'); e.hard = true; throw e; }
  log('MetaMask is about to ask, and this one deploys ' + label + '. Approve it there.');
  const tx = await window.ethereum.request({
    method: 'eth_sendTransaction',
    // chainId in the params is a second lock on the same door: MetaMask
    // refuses a transaction whose chainId is not the selected network, which
    // closes the sliver between the check above and the signature.
    params: [{ from: account, chainId: BASE_CHAIN_ID, data: data }],
  });
  const r = await mined(tx, log);
  if (!r) throw new Error(label + ' did not land — see the line above. Nothing else has been sent.');
  const paid = charge(r);
  const addr = r.contractAddress;
  const blk = Number(BigInt(r.blockNumber));
  const code = await window.ethereum.request({ method: 'eth_getCode', params: [addr, 'latest'] });
  if (!code || code === '0x') {
    throw new Error(label + ' reported success but there is no code at ' + addr + '. Stop here and look at that transaction on Basescan before anything else is signed.');
  }
  log('There is code at ' + addr + ': ' + ((code.length - 2) / 2) + ' bytes. It is really there.', 'ok');
  stands(label + ' deployed at ' + addr + ' in block ' + blk + ', cost ' + paid + '. That stands; pressing again will not deploy a second one.');
  return { address: addr, block: blk, tx: tx };
}

// Hand over everything known so far. Deliberately idempotent and deliberately
// cumulative: the pools factory is deployed later than the other two, so this
// is posted more than once and the script must write what is present without
// erasing what a previous post set.
async function postToScript(what) {
  const body = {
    kind: 'peer-setup-deployed', v: 1, chainId: BASE_CHAIN_NUM,
    nonce: NONCE || null, account: account, token: S.token, btc: S.btc,
    builds: { anchor: 'sha256:' + FP.anchor, claim: 'sha256:' + FP.claim, pools: 'sha256:' + FP.pools },
  };
  if (S.anchor) body.anchor = { address: S.anchor, block: S.anchorBlock, tx: S.anchorTx };
  if (S.claim) body.claim = { address: S.claim, block: S.claimBlock, tx: S.claimTx };
  if (S.pools) body.pools = { address: S.pools, block: S.poolsBlock, tx: S.poolsTx };
  // ONE from-block covers both epoch contracts, so it is the lower of the two,
  // and it is computed here rather than left to the script: the rule is not
  // obvious and getting it wrong is silent — too low costs a little scanning,
  // too high hides everything opened before it.
  const blocks = [S.anchorBlock, S.claimBlock].filter((b) => typeof b === 'number');
  if (blocks.length) body.epochFromBlock = Math.min.apply(null, blocks);
  log('POST ' + esc(CB) + '/api/setup/deployed');
  log(esc(JSON.stringify(body, null, 1)), 'muted');
  let r, text = '';
  try {
    r = await fetch(CB + '/api/setup/deployed', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    text = await r.text();
  } catch (e) {
    handOverFailed(what, 'nothing answered at ' + CB + ' (' + (e.message || e) + ')');
  }
  // The script refuses in words — it checks these addresses against Base
  // itself before writing anything, and its reason is the useful part of the
  // answer. Pull it out rather than showing a person a JSON blob to read.
  let said = text.slice(0, 400);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { /* not JSON: the raw body is the best there is */ }
  if (parsed && (parsed.error || parsed.note)) said = parsed.error || parsed.note;
  // filesWritten is the script saying "the refusal is not about your addresses":
  // it took them, wrote them, and then the host did not come back. Sending that
  // operator off to write files that already say the right thing would be the
  // wrong instruction at the one moment they are most likely to follow it.
  if (r && !r.ok) handOverFailed(what, 'it answered ' + r.status + ' and said: ' + said, !!(parsed && parsed.filesWritten));
  log('The setup script took it: ' + esc(said || 'ok'), 'ok');
}

// A failed hand-over is not a failed deployment, and the difference is the
// whole message: those contracts exist, they are yours, they cost money, and
// the only thing missing is that a text file does not name them yet. So this
// prints the three files and the restart command rather than a stack trace.
function handOverFailed(what, why, filesWritten) {
  log('');
  log('The setup script did not finish the hand-over: ' + esc(why), 'bad');
  log('');
  log('THIS DID NOT UNDO ANYTHING. What you deployed is deployed and is yours.', 'hd');
  if (filesWritten) {
    // The files are right; the host is not running. One instruction, and it is
    // not "write these down".
    log('The setup script DID write the configuration. Nothing needs copying and nothing');
    log('needs deploying again — what is missing is the host itself, which did not come');
    log('back after the restart.');
    log('Start it by hand:  powershell -ExecutionPolicy Bypass -File .\\start-host.ps1');
    log('and read webapp\\server-data\\host.err.log if it will not stay up.');
    log('Then press the button again — it reads the host, sees the contracts, and carries on.', 'muted');
    const e = new Error(what + ': the files were written but the host did not come back');
    e.hard = true; throw e;
  }
  log('All that is missing is the host being told. Write these into webapp\\server-data\\:');
  if (S.anchor) log('  anchor-address.txt    ' + S.anchor);
  if (S.claim) log('  claim-address.txt     ' + S.claim);
  const blocks = [S.anchorBlock, S.claimBlock].filter((b) => typeof b === 'number');
  if (blocks.length) log('  epoch-from-block.txt  ' + Math.min.apply(null, blocks) + '   (the LOWER of the two deployment blocks: too low costs a little scanning, too high hides everything opened before it)');
  if (S.pools) log('  pools-address.txt     ' + S.pools);
  if (typeof S.poolsBlock === 'number') log('  pools-from-block.txt  ' + S.poolsBlock);
  log('Then restart the host:  powershell -ExecutionPolicy Bypass -File .\\start-host.ps1');
  log('Then press the button again — it reads the host, sees them, and carries on.', 'muted');
  const e = new Error(what + ': the addresses could not be handed over');
  e.hard = true; throw e;
}

// Wait for the host to say something is true — asking THE HOST, because the
// setup script's own status is narration and the host is the thing being
// configured. The check function returns true when it is so, a string when it is wrong in
// a way that waiting cannot fix, and false to keep waiting.
async function waitForHost(check, label, maxMs) {
  const t0 = Date.now();
  let lastNote = '';
  let last = null;
  while (Date.now() - t0 < maxMs) {
    try {
      const st = await getJson(CB + '/api/setup/status', 'asking the setup script');
      if (st && st.state === 'error') { const e = new Error('the setup script stopped: ' + (st.error || st.note || 'no reason given')); e.hard = true; throw e; }
      if (st && st.note && st.note !== lastNote) { lastNote = st.note; log('  the setup script says: ' + esc(st.note), 'muted'); }
    } catch (e) {
      // 404 is expected: the status endpoint is optional. Anything else here
      // is also not fatal — the host below is what decides.
      if (e.hard) throw e;
    }
    try {
      const oc = await getJson(HOST + '/api/token/onchain', 'reading the host');
      last = oc;
      const v = check(oc);
      if (v === true) return oc;
      if (typeof v === 'string') { const e = new Error(v); e.hard = true; throw e; }
    } catch (e) {
      if (e.hard) throw e;
      // A host in the middle of a restart refuses the connection. That is the
      // expected state here, not an error to report every two seconds.
    }
    tick(Math.round((Date.now() - t0) / 1000));
    await sleep(2000);
  }
  const e = new Error(label + ': ' + Math.round(maxMs / 1000) + ' seconds and the host still does not report it. Look at server-data\\host.err.log, and at whatever window the setup script is running in.');
  e.hard = true; throw e;
}

const addrOf = (v) => (ADDR_RE.test(String(v || '')) ? String(v).toLowerCase() : '');
const eqAddr = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

// The loudest fact this page can find, in one place because it is checked
// twice: once when the plan is drawn, and once on the line before the epoch
// would be funded. A root already published cannot be revised — that is the
// whole point of publishing it — so a disagreement is never something to work
// around, and the two checks must not word it differently.
const rootMismatch = (n, onChain, fromHost) =>
  'epoch ' + n + ' is ALREADY OPEN on that contract with root 0x' + onChain + ', and this host computes ' + fromHost + '. Those are different trees, so every proof this host hands out would revert against that root and every claim would fail. Nothing was signed. It means the published root came from a different log, a different binding snapshot, or a different builder — which is the thing to investigate rather than to deploy around.';

// ---- the run ----
async function sequence() {
  // ── nothing here is signed ──────────────────────────────────────────────
  setNow('Reading what is already true. Nothing is signed in this part.');
  log('');
  log('READING WHAT IS ALREADY TRUE', 'hd');

  // The setup script is asked first — before the wallet, before the plan, and
  // a long way before the first signature. It is the cheapest read in the whole
  // run and it used to be the last one: the nonce was only tested when the
  // addresses were POSTed, which is after two deployments have been paid for.
  const SETUP = await readSetupScript();
  if (nonceState === 'stale') {
    const e = new Error(nonceWhy || 'this page carries the nonce of an earlier run, and the setup script listening here is not that run. Nothing was signed — close this tab and open the URL the running script printed.');
    e.hard = true; throw e;
  }
  if (SETUP) {
    log('The setup script answers, and this page is its own.', 'ok');
  } else if (NONCE) {
    log('The setup script did not answer, so nothing can be handed over to it. Deploying would still work and the addresses would be printed here for you to write into server-data by hand — but the run is stopped instead, because that is a decision to make on purpose rather than to discover afterwards.', 'bad');
    const e = new Error('no setup script answered at ' + CB + '. Nothing was signed.');
    e.hard = true; throw e;
  } else {
    log('No setup script to ask (no nonce was passed in). Nothing will be handed over automatically; the addresses are printed here and you write the three files yourself.', 'muted');
  }

  if (!window.ethereum) throw new Error('No wallet in this browser. Open this page in the browser where MetaMask lives — over http://, because MetaMask does not inject into file:// pages.');
  const accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
  account = accs && accs[0];
  if (!account) throw new Error('MetaMask returned no account.');
  chainId = await window.ethereum.request({ method: 'eth_chainId' });
  renderWho();
  if (!onBase()) {
    log('That is not Base. Asking MetaMask to switch…');
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_ID }] });
      // Believe the wallet, not the resolved promise. A switch request that
      // returns means the dialog closed, which is not the same claim.
      chainId = await window.ethereum.request({ method: 'eth_chainId' });
      renderWho();
    } catch (e) { throw new Error('Could not switch to Base: ' + (e.message || e) + '. Switch by hand and press again.'); }
    if (!onBase()) throw new Error('The wallet is still not on Base (8453). Switch it by hand and press again.');
    log('Switched to Base.', 'ok');
  }
  RUN_ACCOUNT = account;
  log('Wallet: ' + esc(account), 'ok');

  const ethBal = BigInt(await window.ethereum.request({ method: 'eth_getBalance', params: [account, 'latest'] }));
  log('ETH on Base: ' + units(ethBal, 18));
  // Everything here costs cents on Base. This number is not a gas estimate,
  // it is the line under which the run would stop halfway, which is the worse
  // outcome — two contracts deployed and the epoch never funded.
  if (ethBal < 300000000000000n) {
    log('That is under 0.0003 ETH. The whole sequence is a few cents of gas, but stopping halfway is worse than not starting: top up first.', 'bad');
  }

  const oc = await getJson(HOST + '/api/token/onchain', 'reading the host');
  if (Number(oc.chainId) !== BASE_CHAIN_NUM) {
    throw new Error('the host is configured for chain ' + esc(String(oc.chainId)) + ' and this wallet is on ' + BASE_CHAIN_NUM + '. One of the two is pointed at the wrong network; nothing was sent.');
  }
  S.token = addrOf(oc.token);
  if (!S.token) throw new Error('the host reports no PEER token address, so there is nothing to build a claim contract around. Set PEER_TOKEN_ADDR (server-data\\token-address.txt) first — deploy.html deploys the token itself if there is none yet.');
  log('The host names PEER as ' + scan('address', S.token));
  // The exact mistake that already produced one dead contract here: an address
  // that is not a token, baked immutably into a contract that can then never
  // work. It is free to ask the chain, and this is the last moment it is free.
  let t = await probeToken(S.token, 'PEER');
  if (!t.ok && !t.sure) { await sleep(1200); t = await probeToken(S.token, 'PEER'); }
  if (!t.ok && t.sure) throw new Error('the PEER address the host reports is not a token: ' + t.why + ' Nothing was signed. Fix the host\'s PEER_TOKEN_ADDR before anything is deployed against it — that pairing is immutable.');
  if (!t.ok) throw new Error('could not check the PEER address against Base — ' + t.why + '. That is not a verdict on the address; the chain did not answer. Press again.');
  S.peerDec = t.decimals;
  log('  PEER ' + esc(t.note), 'ok');

  const peerBal = bigWord(await ethCall(S.token, S_BALANCE_OF + addrWord(account)));
  log('PEER in this wallet: ' + units(peerBal, S.peerDec));

  // The BTC side, for the pool question only. The host names it; the constant
  // is a fallback, never an override.
  S.btc = addrOf(oc.btc) || CBBTC_FALLBACK.toLowerCase();
  let btcBal = null;
  let b = await probeToken(S.btc, 'cbBTC');
  if (!b.ok && !b.sure) { await sleep(1200); b = await probeToken(S.btc, 'cbBTC'); }
  if (b.ok) {
    S.btcDec = b.decimals;
    btcBal = bigWord(await ethCall(S.btc, S_BALANCE_OF + addrWord(account)));
    log('cbBTC in this wallet: ' + units(btcBal, S.btcDec));
  } else {
    log('Could not read the cbBTC side (' + esc(b.why) + '). The pool question is left alone rather than answered wrongly.', 'muted');
  }

  // What is already deployed, from THREE sources, and the order between them is
  // the whole point.
  //
  //   this tab's memory   a contract deployed in an earlier press whose address
  //                       was never handed over. Weakest: nobody else knows it.
  //   server-data         what the setup script's files NAME. Stronger: it is a
  //                       decision somebody recorded on this machine.
  //   the host            what /api/token/onchain actually serves. Strongest,
  //                       because the app reads the host and nothing else.
  //
  // The middle one is new here, and its absence was expensive. This page used
  // to plan entirely from the host, and the setup script used to gate entirely
  // on the files — so in the one state where those disagree, which is "the
  // files were written and the restart did not take", the page saw no claim
  // contract, deployed a second one with real money, posted it, and was refused
  // for replacing a contract it had never been told about. Two contracts paid
  // for and thrown away, and the script's own header documents that state.
  const mem = recall();
  if (mem && eqAddr(mem.account, account)) {
    for (const k of ['anchor', 'claim', 'pools']) {
      if (!ADDR_RE.test(String(mem[k] || ''))) continue;
      const code = await window.ethereum.request({ method: 'eth_getCode', params: [mem[k], 'latest'] });
      if (!code || code === '0x') continue;   // nothing there: forget it silently
      S[k] = String(mem[k]).toLowerCase();
      S[k + 'Block'] = mem[k + 'Block'];
      S[k + 'Tx'] = mem[k + 'Tx'];
      log('Recovered from an earlier press by this wallet: ' + k + ' at ' + scan('address', S[k]) + ' — there is code at it, so it is real and will not be deployed again.', 'ok');
    }
  }

  // What server-data names. Adopted, not deployed over — but only after the
  // chain says there is really something at it, because a file is a claim and
  // eth_getCode is an answer.
  const CFG = (SETUP && SETUP.configured) || {};
  const ALLOW_REPLACE = !!(SETUP && SETUP.allowReplace);
  const cfgDead = [];
  for (const k of ['anchor', 'claim', 'pools']) {
    const a = addrOf(CFG[k]);
    if (!a) continue;
    let code = null;
    try { code = await window.ethereum.request({ method: 'eth_getCode', params: [a, 'latest'] }); }
    catch (e) { throw new Error('server-data names a ' + k + ' at ' + a + ' and the chain could not be asked whether there is code there (' + (e.message || e) + '). Nothing was signed; that is the RPC, not a verdict. Press again.'); }
    if (!code || code === '0x') {
      // Named in a file, absent from the chain. Never adopted, and never
      // silently deployed over either: the refusal belongs to whoever wrote
      // that file.
      cfgDead.push(k + ' ' + a);
      continue;
    }
    if (S[k] && !eqAddr(S[k], a)) {
      log('server-data names a ' + k + ' at ' + scan('address', a) + ', and this tab remembers deploying ' + scan('address', S[k]) + '. Taking the recorded one: a file on the machine outranks this tab\'s memory.', 'muted');
    }
    S[k] = a;
    log('server-data already names a ' + k + ': ' + scan('address', a) + ' — there is code at it, so it is adopted and will not be deployed again.', 'ok');
  }

  const hostAnchor = addrOf(oc.anchors && oc.anchors.contract);
  const hostClaim = addrOf(oc.claimState && oc.claimState.contract);
  const hostPools = addrOf(oc.namedPools && oc.namedPools.factory);
  // The host wins where both have an answer — but a host serving a DIFFERENT
  // address than the files name is not a precedence question, it is a broken
  // configuration, and neither answer is safe to fund against. Nobody is asked
  // to guess which one the app will be reading in five minutes.
  for (const pair of [['anchor', hostAnchor], ['claim', hostClaim], ['pools', hostPools]]) {
    const named = addrOf(CFG[pair[0]]);
    if (named && pair[1] && !eqAddr(named, pair[1])) {
      throw new Error('the host is serving ' + pair[1] + ' as its ' + pair[0] + ' and server-data\\' + pair[0] + '-address.txt names ' + named + '. Those are different contracts, and which one the app uses depends on when it was last restarted. Nothing was signed. Settle that first — pick one, put it in the file, and restart the host.');
    }
  }
  if (hostAnchor) { S.anchor = hostAnchor; log('The host already points at a PeerAnchor: ' + scan('address', hostAnchor), 'ok'); }
  if (hostClaim) { S.claim = hostClaim; log('The host already points at a PeerClaim: ' + scan('address', hostClaim), 'ok'); }
  if (hostPools) { S.pools = hostPools; log('The host already points at a pools factory: ' + scan('address', hostPools), 'ok'); }

  // The last thing before the plan is drawn: would this run's deployments be
  // REFUSED? The setup script will not record a different address over a
  // recorded one unless it was told it may, and that answer was taken in the
  // terminal before this page ever loaded. Reading it here turns "deploy, then
  // be refused" into "do not deploy" — the difference is two contracts.
  if (cfgDead.length && !ALLOW_REPLACE) {
    throw new Error('server-data names ' + cfgDead.join(' and ') + ', and there is no code at that address on Base — so it cannot be adopted. Deploying a replacement is what is needed, and this run was told not to replace what is recorded, so the setup script would refuse to write the new address after you had paid for it. Nothing was signed. Re-run the setup script with -ReplaceExisting, or clear that file.');
  }
  if (cfgDead.length) {
    log('server-data names ' + esc(cfgDead.join(' and ')) + ' with no code at it on Base. This run was told it may replace what is recorded, so a new one is deployed below and the file is rewritten.', 'bad');
  }

  // A factory is only a factory for the pair it was deployed against, and
  // that pairing is immutable. This is not a hypothetical check: a PeerPools
  // was deployed here once with the operator's WALLET address where the token
  // belonged, so peer() answers an address with no token at it and every
  // createPool on it reverts with empty data. It looks perfectly healthy on an
  // explorer. So both sides are read back and compared, and a factory that
  // fails is dropped here rather than offered as somewhere to put coins.
  if (S.pools) {
    const fp = addrOf('0x' + String(await ethCall(S.pools, S_POOLS_PEER)).slice(-40));
    const fb = addrOf('0x' + String(await ethCall(S.pools, S_POOLS_BTC)).slice(-40));
    if (!eqAddr(fp, S.token) || !eqAddr(fb, S.btc)) {
      log('That factory is NOT over this pair: its peer() is ' + esc(fp || 'unreadable') + ' and its btc() is ' + esc(fb || 'unreadable') + ', against PEER ' + esc(S.token) + ' and cbBTC ' + esc(S.btc) + '.', 'bad');
      log('Both are fixed at deployment and cannot be changed, so that contract can never trade this pair — it is dead, whatever an explorer shows. It is ignored from here; a new factory is deployed instead if there is cbBTC to open a pool with.', 'bad');
      S.pools = null;
    } else {
      log('  its peer() and btc() are this PEER and this cbBTC.', 'ok');
    }
  }

  // If a claim contract already exists, it is only usable here if its two
  // immutable arguments are the ones this run needs. Both are checked before
  // anything is planned around it, because neither can ever be changed.
  if (S.claim) {
    const tkRaw = await ethCall(S.claim, S_CLAIM_TOKEN);
    const swRaw = await ethCall(S.claim, S_STEWARD);
    // An empty answer from an address the host is pointed at is its own
    // finding, and a different one: it is not a PeerClaim at all. Collapsing
    // it into the token-mismatch message below would send somebody hunting
    // for the wrong token when the real problem is the wrong address.
    if (!tkRaw || tkRaw === '0x' || !swRaw || swRaw === '0x') {
      throw new Error('the host points at ' + S.claim + ' as its claim contract, but nothing there answers token() and steward() on Base. That address is not a PeerClaim. Nothing was signed — this is a misconfiguration to fix (server-data\\claim-address.txt) rather than something to deploy around.');
    }
    const tk = addrOf('0x' + tkRaw.slice(-40));
    const sw = addrOf('0x' + swRaw.slice(-40));
    if (!eqAddr(tk, S.token)) {
      throw new Error('the PeerClaim at ' + S.claim + ' pays out ' + tk + ', and the host\'s PEER is ' + S.token + '. Those are different coins and the pairing is immutable, so this contract cannot be used for these epochs. Nothing was signed. Either point the host at the token that contract pays, or deploy a new PeerClaim and point the host at that.');
    }
    if (!eqAddr(sw, account)) {
      throw new Error('the PeerClaim at ' + S.claim + ' has ' + sw + ' as its steward, and this wallet is ' + account + '. Only the steward can open an epoch there, and that is fixed forever at deployment. Nothing was signed. Connect the steward wallet, or deploy a new PeerClaim from this one and point the host at it.');
    }
    log('  its token() is the host\'s PEER and its steward() is this wallet.', 'ok');
  }

  // Which epochs have closed, and which of them have anything to claim. Walked
  // rather than assumed: the endpoint answers 404 for an epoch that has not
  // closed, so the first 404 is the end of the list.
  const epochs = [];
  const EPOCH_CAP = 64;
  for (let n = 1; n <= EPOCH_CAP; n++) {
    let j;
    try { j = await getJson(HOST + '/api/v1/epoch/' + n + '/claim', 'reading epoch ' + n); }
    catch (e) { if (e.status === 404) break; throw e; }
    epochs.push(j);
  }
  log('Closed epochs on this host: ' + epochs.length);
  // A cap that could hide an epoch has to say so. Silence here would look
  // exactly like "there are no more", and the epoch it stopped short of is one
  // nobody would ever be told about.
  if (epochs.length === EPOCH_CAP) {
    log('That is this page\'s limit of ' + EPOCH_CAP + ' and there may be more. Anything past it is not shown and not funded here — open those with deploy.html, or raise the limit.', 'bad');
  }
  const fundable = [];
  for (const ep of epochs) {
    const total = BigInt(ep.total || '0');
    if (!ep.leafCount || total <= 0n) {
      log('  epoch ' + ep.epoch + ': nothing to claim — ' + (ep.unbound && ep.unbound.count ? ep.unbound.count + ' handle(s) earned with no address bound when it closed, so the tree has no leaf' : 'no leaves') + '. Funding it would lock PEER against a root nobody can claim from, so it is skipped.', 'muted');
      continue;
    }
    // The one check no contract can make, made here, before the money moves.
    // PeerClaim cannot add a tree's leaves up — nothing on-chain holds them —
    // so a root that oversums its deposit pays first-come and reverts for
    // everyone after. The leaf list is published beside the root exactly so
    // this sum can be done, and this is the last free moment to do it.
    let sum = 0n;
    for (const l of (ep.leaves || [])) sum += BigInt(l.amount || '0');
    if (sum !== total) {
      // Skipped, not fatal — the same verdict setup-all.ps1 reaches from its
      // own copy of this check, and the same consequence, so the two cannot
      // tell an operator different things about the same epoch. Stopping the
      // whole run here would also strand every OTHER epoch behind one bad
      // tree, which is the dead end this page exists to remove.
      log('  epoch ' + ep.epoch + ': NOT OFFERED. Its leaves add up to ' + sum.toString() + ' raw and its total says ' + total.toString() + '.', 'bad');
      log('    A root whose leaves oversum its deposit pays first-come and then reverts for everyone after, and no contract can add a tree up — the leaves are published beside the root precisely so this sum can be done here, before the first claim. It is worth finding out why before that epoch is funded by any route.', 'bad');
      continue;
    }
    log('  epoch ' + ep.epoch + ': ' + ep.leafCount + ' leaf/leaves, ' + units(total, S.peerDec) + ' PEER, and the leaves add up to exactly that.', 'ok');
    fundable.push(ep);
  }

  // What is already open, and what is already allowed. Read HERE, before the
  // plan is printed, so that the count of MetaMask prompts the plan promises
  // is the count that actually arrives. Both are re-read inside their own
  // steps as well — that is the guard, this is the honesty.
  let allowNow = 0n;
  if (S.claim) {
    allowNow = bigWord(await ethCall(S.token, S_ALLOWANCE + addrWord(account) + addrWord(S.claim)));
    for (const ep of fundable) {
      const w = wordsOf(await ethCall(S.claim, S_EPOCH_INFO + u256Word(ep.epoch)));
      if (w.length < 5 || bigWord(w[0]) === 0n) continue;
      if (w[0] !== b32Word(ep.root0x)) throw new Error(rootMismatch(ep.epoch, w[0], ep.root0x));
      ep.alreadyOpen = true;
      log('  epoch ' + ep.epoch + ' is already open on ' + S.claim + ' with exactly this root, funded with ' + units(bigWord(w[1]), S.peerDec) + ' PEER.', 'ok');
    }
    if (allowNow > 0n) log('  standing allowance to that contract: ' + units(allowNow, S.peerDec) + ' PEER.', 'ok');
  }

  // ── the plan ────────────────────────────────────────────────────────────
  const steps = [];
  const push = (title, sign, fn) => steps.push({ title: title, sign: !!sign, fn: fn });

  if (S.anchor) push('PeerAnchor — already at ' + S.anchor + ', nothing to deploy', false, async () => { log('Adopted ' + scan('address', S.anchor) + '. No transaction.', 'ok'); });
  else push('Deploy PeerAnchor', true, stepAnchor);

  if (S.claim) push('PeerClaim — already at ' + S.claim + ', nothing to deploy', false, async () => { log('Adopted ' + scan('address', S.claim) + '. No transaction.', 'ok'); });
  else push('Deploy PeerClaim (token = the host\'s PEER, steward = this wallet)', true, stepClaim);

  const needHandover = !hostAnchor || !hostClaim;
  if (needHandover) {
    push('Hand both addresses to the setup script', false, async () => { await postToScript('handing over the addresses'); });
    push('Wait for the host to come back pointing at them', false, stepWaitHost);
  } else {
    push('The host already reports both — nothing to hand over', false, async () => { log('Both addresses are already in the host\'s configuration. Skipped.', 'ok'); });
  }

  const toOpen = fundable.filter((ep) => !ep.alreadyOpen);
  let need = 0n;
  for (const ep of toOpen) need += BigInt(ep.total);
  if (fundable.length) {
    if (!toOpen.length) {
      push('Every closed epoch with a leaf is already open — nothing to fund', false, async () => { log('Nothing to sign. openEpoch is once per epoch number, forever.', 'ok'); });
    } else if (allowNow >= need) {
      push('Approve ' + units(need, S.peerDec) + ' PEER — already allowed, nothing to sign', false, async () => { await stepApprove(need, peerBal); });
    } else {
      push('Approve ' + units(need, S.peerDec) + ' PEER for the claim contract', true, async () => { await stepApprove(need, peerBal); });
    }
    for (const ep of toOpen) push('Open epoch ' + ep.epoch + ' with ' + units(BigInt(ep.total), S.peerDec) + ' PEER behind it', true, async () => { await stepOpen(ep); });
    push('Read it back off the chain and check a real proof against it', false, async () => { await stepReadBack(fundable); });
  } else {
    push('Fund an epoch — nothing to fund', false, async () => {
      log('No closed epoch on this host has a leaf to pay, so there is nothing to open.', 'muted');
      log('That is not a fault: an epoch has leaves only for handles that had an address bound when it closed. Bind one (POST /api/v1/bind) and it counts from the NEXT epoch close — a root already published cannot change.', 'muted');
    });
  }

  // The pool tail. Only offered when the wallet actually holds the other side
  // of the pair, because a pool is two assets and nothing on this page can get
  // the second one.
  if (btcBal !== null && btcBal > 0n && S.pools) {
    push('The pools factory is already there and is over this pair', false, async () => {
      log('Adopted ' + scan('address', S.pools) + '. No transaction.', 'ok');
      $('poolCard').style.display = 'block';
      log('The card below opens a pool. It is deliberately not part of this sequence: the two amounts you put in are the price the pool opens at, and nothing here will pick them for you.', 'muted');
    });
  } else if (btcBal !== null && btcBal > 0n && !S.pools) {
    push('Deploy a new pools factory (you hold cbBTC, so a pool is possible)', true, stepPools);
    push('Hand the factory to the setup script and wait for the host', false, async () => {
      await postToScript('handing over the pools factory');
      await waitForHost((o) => {
        const f = addrOf(o.namedPools && o.namedPools.factory);
        if (!f) return false;
        if (!eqAddr(f, S.pools)) return 'the host came back pointing at a different pools factory (' + f + ') than the one just deployed (' + S.pools + '). Stopping — that is a configuration to look at, not something waiting will fix.';
        return true;
      }, 'the host taking the pools factory', 240000);
      log('The host reports the factory. It is empty, which is what a fresh factory looks like and is correct.', 'ok');
      // Revealed, not run. Opening a pool needs two amounts, and those two
      // amounts ARE the opening price — a number this page has no business
      // choosing with somebody else's coins.
      $('poolCard').style.display = 'block';
      log('A card has appeared below to open the first pool. It is deliberately not part of this sequence: the two amounts you put in are the price the pool opens at, and nothing here will pick them for you.', 'muted');
    });
  }

  log('');
  log('THE PLAN — ' + steps.length + ' steps, ' + steps.filter((s) => s.sign).length + ' of them a MetaMask prompt:', 'hd');
  let planHtml = '<ol>';
  for (const s of steps) planHtml += '<li>' + esc(s.title) + (s.sign ? ' <b>[MetaMask asks]</b>' : '') + '</li>';
  planHtml += '</ol>';
  $('plan').innerHTML = planHtml;
  steps.forEach((s, i) => log('  ' + (i + 1) + '. ' + esc(s.title) + (s.sign ? '   [MetaMask asks]' : '')));
  if (btcBal !== null && btcBal === 0n) {
    log('');
    log('NO POOL STEP, and this is the reason:', 'hd');
    log('A pool is two assets. This wallet holds PEER and no cbBTC, and no script here can get cbBTC — it has to be bought and withdrawn to Base from wherever you buy it, which is your transaction with your exchange and not something this page will ever do for you. Everything above completes without it; when you do hold some, press this button again and the pool steps appear.', 'muted');
  }

  for (let i = 0; i < steps.length; i++) {
    setNow((i + 1) + ' of ' + steps.length + ': ' + steps[i].title);
    log('');
    log('— ' + (i + 1) + ' of ' + steps.length + ' · ' + esc(steps[i].title) + ' —', 'hd');
    await steps[i].fn();
  }

  setNow('Done — ' + steps.length + ' of ' + steps.length + '.');
  log('');
  log('DONE.', 'ok');
  summary();
}

async function stepAnchor() {
  const r = await deployOne('PeerAnchor', BYTECODE_ANCHOR);
  S.anchor = r.address; S.anchorBlock = r.block; S.anchorTx = r.tx; remember();
}

async function stepClaim() {
  // Probed again, on the line before the signature, for the same reason
  // requireBase is: this is the pairing that cannot be undone. The read in the
  // first part of the run decided the plan; this one decides the signature.
  let t = await probeToken(S.token, 'PEER');
  if (!t.ok && !t.sure) { await sleep(1200); t = await probeToken(S.token, 'PEER'); }
  if (!t.ok) throw new Error('the PEER address stopped checking out just before signing (' + t.why + '). Nothing was sent.');
  log('PEER re-checked: ' + esc(t.note), 'ok');
  log('Steward will be ' + esc(account) + ' — this wallet, fixed forever at deployment. Only it can ever open an epoch on this contract, and only it is refunded what nobody claims.');
  // Two address words, the 20 bytes right-aligned in each: PeerClaim(address
  // token, address steward). That is the entire constructor encoding.
  const r = await deployOne('PeerClaim', BYTECODE_CLAIM + addrWord(S.token) + addrWord(account));
  S.claim = r.address; S.claimBlock = r.block; S.claimTx = r.tx; remember();
}

async function stepPools() {
  // The dead factory is why this is a fresh deployment rather than a reuse: a
  // PeerPools was once deployed here with the operator's WALLET as its peer
  // address instead of the token, and since that pairing is immutable every
  // createPool on it reverts. Both sides are probed here for exactly that.
  for (const t of [{ a: S.token, n: 'PEER' }, { a: S.btc, n: 'cbBTC' }]) {
    let r = await probeToken(t.a, t.n);
    if (!r.ok && !r.sure) { await sleep(1200); r = await probeToken(t.a, t.n); }
    if (!r.ok) throw new Error('the ' + t.n + ' address did not check out (' + r.why + '). Nothing was sent — the factory pairs both addresses immutably.');
    log('  ' + t.n + ' ' + esc(t.a) + ' — ' + esc(r.note), 'ok');
  }
  if (eqAddr(S.token, S.btc)) throw new Error('PEER and cbBTC are the same address. The constructor rejects that; nothing was sent.');
  const r = await deployOne('PeerPools', BYTECODE_POOLS + addrWord(S.token) + addrWord(S.btc));
  S.pools = r.address; S.poolsBlock = r.block; S.poolsTx = r.tx; remember();
}

async function stepWaitHost() {
  log('The setup script writes the files and restarts the host. A restarting host refuses connections for a few seconds; that is expected and not reported.');
  await waitForHost((o) => {
    const c = addrOf(o.claimState && o.claimState.contract);
    const a = addrOf(o.anchors && o.anchors.contract);
    if (c && !eqAddr(c, S.claim)) return 'the host came back pointing at a DIFFERENT claim contract (' + c + ') than the one just deployed (' + S.claim + '). Stopping: funding an epoch on one while the app reads the other is exactly the confusion this page exists to prevent.';
    if (a && S.anchor && !eqAddr(a, S.anchor)) return 'the host came back pointing at a different anchor contract (' + a + ') than the one just deployed (' + S.anchor + ').';
    return !!c && (!S.anchor || !!a);
  }, 'the host taking the new addresses', 240000);
  log('The host is back and reports both. That is the host\'s own answer, not the script\'s.', 'ok');
}

async function stepApprove(need, peerBal) {
  sameAccount();
  const have = bigWord(await ethCall(S.token, S_ALLOWANCE + addrWord(account) + addrWord(S.claim)));
  if (have >= need) {
    log('There is already an allowance of ' + units(have, S.peerDec) + ' PEER to ' + esc(S.claim) + ', which covers ' + units(need, S.peerDec) + '. Nothing to sign.', 'ok');
    return;
  }
  if (peerBal < need) {
    throw new Error('this wallet holds ' + units(peerBal, S.peerDec) + ' PEER and the epochs below need ' + units(need, S.peerDec) + '. openEpoch pulls the whole total up front, so an epoch is either fully funded from the first second or it does not exist. Nothing was signed.');
  }
  // Exactly what is needed, not an unlimited approval. An allowance is a
  // standing permission that outlives this page: it should be the size of the
  // thing it is for, so that if this run stops here what remains is one
  // contract allowed to take one known amount.
  log('Approving exactly ' + units(need, S.peerDec) + ' PEER — not an unlimited allowance. It is a standing permission that outlives this page, so it is the size of the thing it is for.');
  if (!(await requireBase(log))) { const e = new Error('the wallet is not on Base — nothing was sent'); e.hard = true; throw e; }
  log('MetaMask is about to ask. This one is the approve, and it moves no coins.');
  const tx = await window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{ from: account, chainId: BASE_CHAIN_ID, to: S.token, data: S_APPROVE + addrWord(S.claim) + u256Word(need) }],
  });
  const r = await mined(tx, log);
  if (!r) throw new Error('the approve did not land — see above. Nothing after it was sent.');
  stands('Approved ' + units(need, S.peerDec) + ' PEER to ' + S.claim + ', cost ' + charge(r) + '. That is a STANDING ALLOWANCE: it survives this page, and it stays until it is spent or you change it.');
}

async function stepOpen(planned) {
  sameAccount();
  const n = planned.epoch;
  // Read again, from the host as it is NOW — reconfigured and restarted since
  // the plan was made — rather than funding whatever this page happened to
  // remember. A closed epoch's tree does not change, so agreement is the
  // expected outcome; the point is that disagreement is the one thing that
  // must never be funded quietly, because the root is what every proof folds
  // up to and it can never be revised once published.
  const ep = await getJson(HOST + '/api/v1/epoch/' + n + '/claim', 'reading epoch ' + n + ' back from the reconfigured host');
  if (ep.root0x !== planned.root0x || String(ep.total) !== String(planned.total)) {
    throw new Error('epoch ' + n + ' reads differently now than when this run was planned: root ' + ep.root0x + ' / total ' + ep.total + ', against ' + planned.root0x + ' / ' + planned.total + '. Nothing was signed. Press again to re-plan from what the host says today.');
  }
  const total = BigInt(ep.total);
  const root = b32Word(ep.root0x);

  // Is it already open? openEpoch is once per epoch number forever, and a
  // second call reverts — so this is read first, every time, not only on a
  // re-press.
  const w = wordsOf(await ethCall(S.claim, S_EPOCH_INFO + u256Word(n)));
  if (w.length >= 5 && bigWord(w[0]) !== 0n) {
    if (w[0] !== root) throw new Error(rootMismatch(n, w[0], ep.root0x));
    log('Epoch ' + n + ' is already open with exactly this root, funded with ' + units(bigWord(w[1]), S.peerDec) + ' PEER, ' + units(bigWord(w[2]), S.peerDec) + ' claimed. Nothing to sign.', 'ok');
    return;
  }

  // The deadline, from the chain's clock and the contract's own constants —
  // not from this computer and not from a number written into this page. A
  // browser clock that is behind would compute a claimUntil that the contract
  // rejects as too soon; the block timestamp is the number the require() is
  // actually measured against.
  const blk = await window.ethereum.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
  const chainNow = Number(bigWord(blk.timestamp));
  const minW = Number(bigWord(await ethCall(S.claim, S_MIN_WINDOW)));
  const maxW = Number(bigWord(await ethCall(S.claim, S_MAX_WINDOW)));
  if (!(minW > 0 && maxW > minW)) throw new Error('could not read MIN_WINDOW and MAX_WINDOW off the contract, and this page will not guess a deadline it cannot check. Nothing was sent.');
  const skew = Math.abs(Math.round(Date.now() / 1000) - chainNow);
  if (skew > 300) log('This computer\'s clock is ' + skew + ' seconds from the chain\'s. The deadline below is measured from the CHAIN, which is the one the contract checks.', 'muted');
  let win = 90 * 24 * 3600;                       // a season: long past any real claim window
  if (win < minW + 7 * 24 * 3600) win = minW + 7 * 24 * 3600;  // and well clear of the floor
  if (win > maxW - 24 * 3600) win = maxW - 24 * 3600;          // and not touching the ceiling
  if (win <= minW) throw new Error('the contract\'s own MIN_WINDOW and MAX_WINDOW leave no room for a sane deadline. Nothing was sent.');
  const claimUntil = chainNow + win;
  const days = Math.round(win / 86400);
  log('The claim window: ' + days + ' days, closing ' + esc(new Date(claimUntil * 1000).toUTCString()) + '.');
  log('  Read off the contract, not decided here: MIN_WINDOW is ' + Math.round(minW / 86400) + ' days and MAX_WINDOW is ' + Math.round(maxW / 86400) + ' days, and this sits well inside both.', 'muted');
  log('  What it means for you: until that moment, anyone with a leaf in this tree can claim it and you cannot take the deposit back. After it, sweep() returns whatever nobody claimed — to you, and only to you: anyone may press it but the destination is fixed in the contract. It cannot be changed afterwards in either direction, and that is the price of it being a promise.', 'muted');
  log('  What is being published: root 0x' + esc(ep.root0x.replace(/^0x/, '')) + ' over ' + ep.leafCount + ' leaf/leaves, funded with ' + units(total, S.peerDec) + ' PEER pulled from this wallet in the same transaction.');

  const data = S_OPEN_EPOCH + u256Word(n) + root + u256Word(total) + u256Word(claimUntil);
  // Ask the chain first. It costs nothing and it answers the only question
  // that matters here — would this revert? — before the gas is spent finding
  // out. The allowance is already in place at this point, so a dry run that
  // passes is a real answer rather than a guess.
  try {
    await ethCall(S.claim, data, account);
  } catch (e) {
    throw new Error('the chain refused this before it was signed: ' + ((e && (e.message || e)) || 'no reason given') + '. Nothing was sent and nothing was spent.');
  }
  log('The chain accepts it in a dry run. Sending it for real.', 'ok');
  if (!(await requireBase(log))) { const err = new Error('the wallet is not on Base — nothing was sent'); err.hard = true; throw err; }
  log('MetaMask is about to ask. This one opens epoch ' + n + ' and moves ' + units(total, S.peerDec) + ' PEER out of this wallet into the claim contract.');
  const tx = await window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{ from: account, chainId: BASE_CHAIN_ID, to: S.claim, data: data }],
  });
  const r = await mined(tx, log);
  if (!r) throw new Error('opening epoch ' + n + ' did not land — see above.');
  stands('Epoch ' + n + ' opened on ' + S.claim + ' with ' + units(total, S.peerDec) + ' PEER deposited, cost ' + charge(r) + '. It is once per epoch number forever: pressing again will not repeat it, and cannot.');
}

async function stepReadBack(fundable) {
  for (const ep of fundable) {
    const n = ep.epoch;
    const w = wordsOf(await ethCall(S.claim, S_EPOCH_INFO + u256Word(n)));
    if (w.length < 5) { log('epoch ' + n + ': epochInfo returned nothing readable.', 'bad'); continue; }
    log('epoch ' + n + ' on ' + scan('address', S.claim) + ':');
    log('  root       0x' + w[0] + (w[0] === b32Word(ep.root0x) ? '   — the same root this host computes' : '   — NOT the root this host computes'), w[0] === b32Word(ep.root0x) ? 'ok' : 'bad');
    log('  deposited  ' + units(bigWord(w[1]), S.peerDec) + ' PEER');
    log('  claimed    ' + units(bigWord(w[2]), S.peerDec) + ' PEER');
    log('  closes     ' + esc(new Date(Number(bigWord(w[3])) * 1000).toUTCString()));
    log('  open now   ' + (bigWord(w[4]) === 1n ? 'yes' : 'no'), bigWord(w[4]) === 1n ? 'ok' : 'bad');

    // The strongest thing this page can say, and it says it by asking rather
    // than asserting: take a real claimant's real proof and ask the contract
    // whether it would pay. checkClaim folds in every check claim() makes.
    const first = (ep.leaves || [])[0];
    if (first) {
      let full = null;
      try { full = await getJson(HOST + '/api/v1/epoch/' + n + '/claim?address=' + first.address, 'reading the proof for ' + first.address); } catch (e) { /* reported below */ }
      const c = full && full.claimant;
      if (c && c.proof && c.proof.length) {
        // checkClaim(uint256,address,uint256,bytes32[]) — four static words
        // then the array: the head is 4 x 32 = 128 bytes, so the offset word
        // is 128, followed by the length and then the words themselves.
        const d = S_CHECK_CLAIM + u256Word(n) + addrWord(c.address) + u256Word(c.amount)
          + u256Word(128) + u256Word(c.proof.length) + c.proof.map(b32Word).join('');
        const ans = bigWord(wordsOf(await ethCall(S.claim, d))[0]);
        if (ans === 1n) {
          log('  checkClaim says YES for ' + scan('address', c.address) + ' — ' + units(BigInt(c.amount), S.peerDec) + ' PEER, against the proof this host just handed out.', 'ok');
          log('  That is the app\'s Claim button working: it sends exactly this call, from that address and no other, because the contract verifies the proof over msg.sender.', 'ok');
        } else {
          // checkClaim folds every reason into one false, and on a re-run the
          // commonest reason by far is the healthiest one: that address already
          // claimed. Reporting that as "look at the root" points the operator at
          // the one thing that is definitely fine and makes the last line of a
          // successful setup red. So ask the second question before speaking.
          // claimed(uint256,address) is a public mapping to bool: any non-zero
          // word is "yes".
          let already = false;
          try {
            already = bigWord(wordsOf(await ethCall(S.claim, S_CLAIMED + u256Word(n) + addrWord(c.address)))[0]) !== 0n;
          } catch (e) { /* leave it false; the honest message below is still true */ }
          if (already) {
            log('  checkClaim says no for ' + scan('address', c.address) + ' because that address has ALREADY CLAIMED this epoch — which is what a working epoch looks like after somebody has been paid. Nothing is wrong.', 'ok');
          } else {
            log('  checkClaim says NO for ' + esc(c.address) + ', and that address has not claimed. The epoch is open and funded, so look at the root line above before anybody spends gas on a claim.', 'bad');
          }
        }
      } else {
        log('  could not fetch a proof from the host to check against the contract. The epoch is open regardless; GET /api/v1/epoch/' + n + '/claim?address=… is where the app gets one.', 'muted');
      }
      // The app's own answer about this epoch, printed as the host words it.
      // Only the keys it actually returned: a host that is not configured for
      // the claim contract has no "opened" to report, and printing undefined
      // three times would read like three failures instead of one explanation.
      const o = full && full.onchain;
      if (o && o.rootMatches !== undefined) {
        log('  the host now says: opened=' + String(o.opened) + ' open=' + String(o.open) + ' rootMatches=' + String(o.rootMatches), o.rootMatches ? 'ok' : 'bad');
        if (o.rootMismatch) log('  ' + esc(o.rootMismatch), 'bad');
      } else if (o && o.why) {
        log('  the host still says: ' + esc(o.why), 'bad');
        log('  That is the host reading its own configuration, not the chain. If it says PEER_CLAIM_ADDR is unset after all this, the setup script wrote the file but the restart did not pick it up.', 'muted');
      }
    }
  }
}

// ---- the button ----
async function runAll() {
  if (running) return;
  running = true; sync();
  try {
    await sequence();
  } catch (e) {
    log('');
    // 4001 is the wallet's code for "the person said no", which is a complete
    // answer and not a fault. Everything else is reported as what it is.
    if (e && e.code === 4001) log('STOPPED: you refused that prompt in MetaMask. Nothing was sent.', 'bad');
    else log('STOPPED: ' + esc((e && (e.message || e)) || 'something went wrong'), 'bad');
    summary();
    setNow('Stopped. Nothing below the line above was attempted.');
  } finally {
    running = false; sync();
  }
}
$('go').onclick = runAll;

// The wallet tells us when the ground moves. Not every provider implements
// .on, so this is an addition to the re-read before each send and never a
// replacement for it.
if (window.ethereum && window.ethereum.on) {
  window.ethereum.on('chainChanged', (id) => { chainId = id; renderWho(); });
  window.ethereum.on('accountsChanged', (accs) => { account = (accs && accs[0]) || null; renderWho(); });
}
sync();
// Asked at load, so a tab from an earlier run is dead on arrival rather than
// after two deployments. It reaches nothing outside this machine and signs
// nothing; the button waits for it because a button that works before this
// answers is a button that can spend money on a run that will not record it.
readSetupScript();

// ---- the pool, which is not setup ----
// Deliberately behind its own button and its own numbers. Everything above is
// configuration that has one right answer; this is a price. The two amounts
// are the opening ratio of the pool and the first trade moves it, so no
// default here would be a fact — it would be this page picking a number with
// somebody else's money.
$('goPool').onclick = async () => {
  const out = log;
  const btn = $('goPool');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    if (!S.pools) throw new Error('there is no pools factory yet — run the setup first.');
    sameAccount();
    const nm = String($('poolName').value || '').trim();
    if (!nm) throw new Error('a pool needs a name; the contract refuses an empty one.');
    const bytes = new TextEncoder().encode(nm);
    if (bytes.length > 32) throw new Error('that name is ' + bytes.length + ' bytes and a bytes32 holds 32.');
    // bytes32: the utf-8 bytes, LEFT aligned and right-padded with zeros —
    // which is how Solidity holds a short string and how the host decodes one
    // back (it stops at the first zero byte).
    let nameWord = '';
    for (const b of bytes) nameWord += b.toString(16).padStart(2, '0');
    nameWord = nameWord.padEnd(64, '0');
    const amtPeer = toRaw($('poolPeer').value, S.peerDec, 'PEER');
    const amtBtc = toRaw($('poolBtc').value, S.btcDec, 'cbBTC');
    out('');
    out('— OPENING A POOL —', 'hd');
    out('Name "' + esc(nm) + '" = 0x' + nameWord);
    out('Depositing ' + units(amtPeer, S.peerDec) + ' PEER and ' + units(amtBtc, S.btcDec) + ' cbBTC. That ratio is the opening price.');
    for (const leg of [{ t: S.token, d: S.peerDec, a: amtPeer, n: 'PEER' }, { t: S.btc, d: S.btcDec, a: amtBtc, n: 'cbBTC' }]) {
      const bal = bigWord(await ethCall(leg.t, S_BALANCE_OF + addrWord(account)));
      if (bal < leg.a) throw new Error('this wallet holds ' + units(bal, leg.d) + ' ' + leg.n + ' and the pool would take ' + units(leg.a, leg.d) + '. Nothing was sent.');
      const have = bigWord(await ethCall(leg.t, S_ALLOWANCE + addrWord(account) + addrWord(S.pools)));
      if (have >= leg.a) { out(leg.n + ': the factory already has a large enough allowance. Nothing to sign.', 'ok'); continue; }
      if (!(await requireBase(out))) return;
      out('MetaMask is about to ask: approve ' + units(leg.a, leg.d) + ' ' + leg.n + ' to the factory. This moves no coins.');
      const tx = await window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [{ from: account, chainId: BASE_CHAIN_ID, to: leg.t, data: S_APPROVE + addrWord(S.pools) + u256Word(leg.a) }],
      });
      const r = await mined(tx, out);
      if (!r) throw new Error('the ' + leg.n + ' approve did not land.');
      stands('Approved ' + units(leg.a, leg.d) + ' ' + leg.n + ' to the pools factory ' + S.pools + ', cost ' + charge(r) + ' — a standing allowance.');
    }
    const data = S_CREATE_POOL + nameWord + u256Word(amtPeer) + u256Word(amtBtc);
    try { await ethCall(S.pools, data, account); }
    catch (e) { throw new Error('the chain refused createPool before it was signed: ' + ((e && (e.message || e)) || 'no reason') + '. Nothing was sent. (The usual causes: a name you already used, or starting liquidity so small that sqrt(peer x btc) does not clear MIN_LIQ.)'); }
    out('The chain accepts it in a dry run. Sending it for real.', 'ok');
    if (!(await requireBase(out))) return;
    out('MetaMask is about to ask. This one opens the pool and moves both amounts.');
    const tx = await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from: account, chainId: BASE_CHAIN_ID, to: S.pools, data: data }],
    });
    const r = await mined(tx, out);
    if (!r) throw new Error('createPool did not land.');
    // Escaped where it is STORED, not where it is printed: this line goes into
    // DONE, which the summary writes into innerHTML, and the name is the one
    // thing on this page somebody typed.
    stands('Pool "' + esc(nm) + '" opened on ' + S.pools + ' with ' + units(amtPeer, S.peerDec) + ' PEER and ' + units(amtBtc, S.btcDec) + ' cbBTC, cost ' + charge(r) + '.');
    const cnt = bigWord(await ethCall(S.pools, S_POOL_COUNT));
    out('The factory now holds ' + cnt.toString() + ' pool(s). GET /api/token/onchain lists them under namedPools.', 'ok');
  } catch (e) {
    out('STOPPED: ' + esc((e && (e.message || e)) || 'something went wrong'), 'bad');
    summary();
  } finally {
    btn.disabled = false;
  }
};

// A decimal amount to raw units, exactly, with no Number on the path: split on
// the point, pad the fraction to the token's decimals, refuse anything longer
// rather than rounding somebody's money.
function toRaw(text, dec, what) {
  const s = String(text || '').trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) throw new Error('"' + s + '" is not an amount of ' + what + '.');
  const parts = s.split('.');
  const frac = parts[1] || '';
  if (frac.length > dec) throw new Error(what + ' has ' + dec + ' decimals and "' + s + '" has ' + frac.length + '. This page will not round your money for you.');
  const raw = BigInt(parts[0] + frac.padEnd(dec, '0'));
  if (raw <= 0n) throw new Error('the ' + what + ' amount must be more than zero.');
  return raw;
}
</script></body></html>`;
fs.writeFileSync('chain-l2/setup.html', setupHtml);

// Say the fingerprint here too, so the number an operator is asked to compare
// has been seen coming out of the build once, in the terminal that made it.
console.log('wrote chain-l2/deploy.html (' + html.length + ' bytes, bytecode embedded)');
console.log('wrote chain-l2/setup.html (' + setupHtml.length + ' bytes, bytecode embedded)');
console.log('PeerPools  build fingerprint sha256:' + poolsFp);
console.log('PeerAnchor build fingerprint sha256:' + anchorFp);
console.log('PeerClaim  build fingerprint sha256:' + claimFp);

// Every bytecode either page will ever hand a wallet, checked against the
// artifact it came from — in the same run that wrote it. The embedding is a
// JSON.stringify into a <script>, so "it obviously matches" is true right up
// until an edit above puts a stray character inside the quotes; and the whole
// value of a fingerprint is that it describes the bytes actually there. This
// reads them back OUT of the generated HTML rather than out of the variables,
// because the variables are not what an operator's wallet is handed.
const PAGES = [
  ['chain-l2/deploy.html', html, [['PeerToken', build], ['PeerPools', pools], ['PeerAnchor', anchor], ['PeerClaim', claim]]],
  ['chain-l2/setup.html', setupHtml, [['PeerPools', pools], ['PeerAnchor', anchor], ['PeerClaim', claim]]],
];
for (const [file, text, wanted] of PAGES) {
  for (const [name, artifact] of wanted) {
    if (!text.includes(JSON.stringify(artifact.bytecode))) {
      console.error('REFUSING: the ' + name + ' bytecode in ' + file + ' is not the one in ' + name + '.build.json');
      process.exit(1);
    }
  }
  console.log(wanted.length + ' bytecodes in ' + file + ' match their build.json exactly');
}

// And the other half of "what you deploy is what you read": a page whose
// script does not parse deploys nothing at all, and a generator that writes
// one is a generator that looked like it worked. Both scripts are extracted
// and handed to the parser here, in the same run — cheap, and it catches the
// stray backtick or unbalanced brace that a template literal will otherwise
// carry all the way to a browser console nobody has open.
for (const [file, text] of PAGES) {
  const m = text.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) { console.error('REFUSING: no inline script found in ' + file); process.exit(1); }
  try { new Function(m[1]); }
  catch (e) { console.error('REFUSING: the inline script in ' + file + ' does not parse: ' + e.message); process.exit(1); }
  console.log('the inline script in ' + file + ' parses (' + m[1].length + ' chars)');
}
