// ESM because webapp/package.json says "type": "module" — require() stopped
// resolving here the day that landed, so this uses import like the rest.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const build = JSON.parse(fs.readFileSync('chain-l2/PeerToken.build.json', 'utf8'));
const pools = JSON.parse(fs.readFileSync('chain-l2/PeerPools.build.json', 'utf8'));
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
const poolsFp = createHash('sha256')
  .update(String(pools.bytecode).trim().toLowerCase(), 'ascii')
  .digest('hex');
// Constructor encodings, hardcoded, no library:
//   PeerToken(uint256 wholeTokens)      -> one 32-byte word, hex, left-padded.
//   PeerPools(address peer, address btc) -> two 32-byte words, the 20 address
//   bytes right-aligned in each. That is the entire ABI this page needs.
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Deploy PEER — Peer Network</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="peerpools-build" content="sha256:${poolsFp}">
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

<p class="muted" style="font-size:13px">
Contracts: no owner, no mint function, no pause, no blacklist, no proxy. The token's whole supply is created once to you and after that it can only do what an ERC-20 does; the factory only does constant-product math on pools anyone can open.
Compiled from <code>PeerToken.sol</code> and <code>PeerPools.sol</code> with solc 0.8.24, optimizer on, 200 runs. Both bytecodes are embedded in this page; nothing is fetched.
</p>
</main>
<script>
const BYTECODE = ${JSON.stringify(build.bytecode)};
const BYTECODE_POOLS = ${JSON.stringify(pools.bytecode)};
const BASE_CHAIN_ID = '0x2105'; // 8453
const BASE_CHAIN_NUM = 8453;   // compared numerically: '0x2105' and '0X2105' are the same chain
const log = (m, cls, id) => { const d=document.getElementById(id||'log'); d.innerHTML += '<div class="'+(cls||'')+'">'+m+'</div>'; };
const log2 = (m, cls) => log(m, cls, 'log2');
let account = null;
let chainId = null;   // the last chain the WALLET reported — never what we asked for
let sending = false;  // a request is in MetaMask right now
let peerSent = false, poolsSent = false; // a deployment hash exists; do not offer a second

const onBase = () => !!chainId && parseInt(chainId, 16) === BASE_CHAIN_NUM;

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
};

// Both Deploy buttons answer to the same conditions, so they are set together
// from one place rather than toggled at each site that changes one of them.
const syncButtons = () => {
  document.getElementById('go').disabled = !(account && onBase()) || sending || peerSent;
  poolsReady();
};

// Read the chain from the wallet on the line before we hand it a deployment.
// Everything else on this page describes the past: the switch in card 1 is a
// request that already returned, and chainChanged is news of a change that has
// already happened. Deploying is the one irreversible signature here — on the
// wrong chain it spends real gas and leaves a contract at an address this host
// will never point at, with no undo — so the check that counts is the one with
// nothing in between.
const requireBase = async (out) => {
  let now = null;
  try { now = await window.ethereum.request({ method: 'eth_chainId' }); }
  catch (e) { out('Could not read the wallet chain: ' + (e.message || e) + '. Nothing was sent.', 'bad'); return false; }
  chainId = now; renderWho();
  if (!onBase()) {
    // Deploy is disabled the moment we learn this, so the instruction has to
    // be one the operator can still follow: switching back re-enables it via
    // chainChanged where the wallet sends that event, and Connect re-reads
    // everything where it does not.
    out('The wallet is on chain ' + parseInt(now, 16) + ', not Base (' + BASE_CHAIN_NUM + '). Nothing was sent — switch to Base in MetaMask; the row in card 1 updates itself, and if it does not, press Connect again.', 'bad');
    return false;
  }
  return true;
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
    log('Transaction sent: ' + tx);
    log('Waiting for it to be mined…');
    let receipt = null;
    for (let i = 0; i < 120 && !receipt; i++) {
      await new Promise(r => setTimeout(r, 2000));
      receipt = await window.ethereum.request({ method: 'eth_getTransactionReceipt', params: [tx] });
    }
    if (!receipt) { log('Still not mined after four minutes. Check the hash on basescan.org — it may yet land.', 'bad'); return; }
    if (receipt.status !== '0x1') { log('The transaction failed on chain. Nothing was deployed; you paid gas.', 'bad'); return; }
    const addr = receipt.contractAddress;
    log('');
    log('DEPLOYED: ' + addr, 'ok');
    log('<a href="https://basescan.org/address/' + addr + '" target="_blank" rel="noopener">View on Basescan</a>');
    log('');
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
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
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
  return { ok: true, note: (sym || '?') + ' · ' + dec + ' decimals · supply ' + whole };
}

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
    log2('Transaction sent: ' + tx);
    log2('Waiting for it to be mined…');
    let receipt = null;
    for (let i = 0; i < 120 && !receipt; i++) {
      await new Promise(r => setTimeout(r, 2000));
      receipt = await window.ethereum.request({ method: 'eth_getTransactionReceipt', params: [tx] });
    }
    if (!receipt) { log2('Still not mined after four minutes. Check the hash on basescan.org — it may yet land.', 'bad'); return; }
    if (receipt.status !== '0x1') { log2('The transaction failed on chain. Nothing was deployed; you paid gas.', 'bad'); return; }
    const addr = receipt.contractAddress;
    // The block matters as much as the address here. The host finds pools by
    // asking for this factory's PoolCreated logs, and a log query with no
    // start block covers the whole chain — a range most public RPCs refuse
    // outright, which shows up as an empty pool list on a factory that works
    // perfectly. This receipt is the only place the number is free; after
    // this you are hunting for it on an explorer.
    const blk = receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : null;
    log2('');
    log2('DEPLOYED: ' + addr, 'ok');
    if (blk !== null) log2('IN BLOCK: ' + blk, 'ok');
    log2('<a href="https://basescan.org/address/' + addr + '" target="_blank" rel="noopener">View on Basescan</a>');
    log2('');
    log2('The host wants both: the address as PEER_POOLS_ADDR' + (blk !== null ? ', the block as PEER_POOLS_FROM_BLOCK' : '') + '. Then GET /api/token/onchain lists the named pools live.');
    log2('Write them down now — this page keeps nothing.', 'muted');
  } catch (e) {
    log2('Refused or failed: ' + (e.message || e), 'bad');
  } finally {
    sending = false; syncButtons();
  }
};
</script></body></html>`;
fs.writeFileSync('chain-l2/deploy.html', html);
// Say the fingerprint here too, so the number an operator is asked to compare
// has been seen coming out of the build once, in the terminal that made it.
console.log('wrote chain-l2/deploy.html (' + html.length + ' bytes, bytecode embedded)');
console.log('PeerPools build fingerprint sha256:' + poolsFp);
