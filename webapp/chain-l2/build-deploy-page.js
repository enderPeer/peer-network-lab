// ESM because webapp/package.json says "type": "module" — require() stopped
// resolving here the day that landed, so this uses import like the rest.
import fs from 'node:fs';
const build = JSON.parse(fs.readFileSync('chain-l2/PeerToken.build.json', 'utf8'));
const pools = JSON.parse(fs.readFileSync('chain-l2/PeerPools.build.json', 'utf8'));
// Constructor encodings, hardcoded, no library:
//   PeerToken(uint256 wholeTokens)      -> one 32-byte word, hex, left-padded.
//   PeerPools(address peer, address btc) -> two 32-byte words, the 20 address
//   bytes right-aligned in each. That is the entire ABI this page needs.
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Deploy PEER — Peer Network</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
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
const log = (m, cls, id) => { const d=document.getElementById(id||'log'); d.innerHTML += '<div class="'+(cls||'')+'">'+m+'</div>'; };
const log2 = (m, cls) => log(m, cls, 'log2');
let account = null;

document.getElementById('conn').onclick = async () => {
  if (!window.ethereum) { log('No wallet found in this browser. Open this page in a browser with MetaMask.', 'bad'); return; }
  try {
    const accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
    account = accs[0];
    const chain = await window.ethereum.request({ method: 'eth_chainId' });
    document.getElementById('who').textContent = account + '  ·  chain ' + parseInt(chain, 16);
    if (chain !== BASE_CHAIN_ID) {
      log('That is not Base. Asking MetaMask to switch…', 'bad');
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_ID }] });
        log('Switched to Base.', 'ok');
      } catch (e) { log('Could not switch: ' + (e.message||e) + ' — switch to Base by hand, then reconnect.', 'bad'); return; }
    }
    // Balance, so you find out you are short BEFORE signing rather than after.
    const bal = await window.ethereum.request({ method: 'eth_getBalance', params: [account, 'latest'] });
    const eth = Number(BigInt(bal)) / 1e18;
    log('Balance on Base: ' + eth.toFixed(6) + ' ETH');
    if (eth < 0.00005) log('That may be too little for gas. Deployment needs roughly 0.00002 ETH.', 'bad');
    document.getElementById('go').disabled = false;
    poolsReady();
  } catch (e) { log('Connect failed: ' + (e.message || e), 'bad'); }
};

document.getElementById('go').onclick = async () => {
  const raw = document.getElementById('supply').value.trim();
  if (!/^[0-9]+$/.test(raw) || BigInt(raw) <= 0n) { log('Supply must be a whole number greater than zero.', 'bad'); return; }
  // ABI-encode one uint256: 32 bytes, big-endian, left-padded. That is the
  // entire encoder this page needs, so it needs no library.
  const arg = BigInt(raw).toString(16).padStart(64, '0');
  document.getElementById('go').disabled = true;
  log('Sending the deployment to MetaMask — approve it there.');
  try {
    const tx = await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from: account, data: BYTECODE + arg }],
    });
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
    document.getElementById('go').disabled = false;
  }
};

// ---- pools factory ----
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const peerIn = document.getElementById('peerAddr');
const btcIn = document.getElementById('btcAddr');
// Enabled only once connected and both fields look like addresses. A 40-hex
// check cannot catch a wrong-but-real address — MetaMask's confirmation
// screen and the basescan link afterwards are what catch that.
const poolsReady = () => {
  document.getElementById('goPools').disabled =
    !(account && ADDR_RE.test(peerIn.value.trim()) && ADDR_RE.test(btcIn.value.trim()));
};
peerIn.oninput = poolsReady; btcIn.oninput = poolsReady;

document.getElementById('goPools').onclick = async () => {
  const peer = peerIn.value.trim(), btc = btcIn.value.trim();
  // The constructor would revert on equal addresses anyway — but a revert on
  // deployment still costs gas, so refuse here where refusing is free.
  if (peer.toLowerCase() === btc.toLowerCase()) { log2('PEER and BTC are the same address. The constructor rejects that; fix the paste.', 'bad'); return; }
  // ABI-encode two addresses: each one 32-byte word, the 20 address bytes
  // right-aligned. Appended to the bytecode, same scheme as the uint256 above.
  const word = (a) => a.slice(2).toLowerCase().padStart(64, '0');
  document.getElementById('goPools').disabled = true;
  log2('Sending the deployment to MetaMask — approve it there.');
  try {
    const tx = await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from: account, data: BYTECODE_POOLS + word(peer) + word(btc) }],
    });
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
    log2('');
    log2('DEPLOYED: ' + addr, 'ok');
    log2('<a href="https://basescan.org/address/' + addr + '" target="_blank" rel="noopener">View on Basescan</a>');
    log2('');
    log2('Give this address to the host as PEER_POOLS_ADDR, then GET /api/token/onchain lists the named pools live.');
  } catch (e) {
    log2('Refused or failed: ' + (e.message || e), 'bad');
    poolsReady();
  }
};
</script></body></html>`;
fs.writeFileSync('chain-l2/deploy.html', html);
console.log('wrote chain-l2/deploy.html (' + html.length + ' bytes, bytecode embedded)');
