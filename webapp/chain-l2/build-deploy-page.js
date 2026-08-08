const fs = require('fs');
const build = JSON.parse(fs.readFileSync('chain-l2/PeerToken.build.json', 'utf8'));
// The constructor argument is a single uint256, ABI-encoded as 32 bytes.
// Hardcoded encoding, no library: 18,250,000 -> hex, left-padded.
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Deploy PEER — Peer Network</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--paper:#131110;--ink:#EFE7DB;--muted:#9C8E7E;--ember:#B84525;--ok:#3f7d4e;--line:#2a2622}
  body{background:var(--paper);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:28px 18px 80px}
  main{max-width:640px;margin:0 auto}
  h1{font-size:22px;margin:0 0 4px} .sub{color:var(--muted);margin:0 0 22px}
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

<p class="muted" style="font-size:13px">
Contract: no owner, no mint function, no pause, no blacklist, no proxy — the whole supply is created once to you and after that it can only do what an ERC-20 does.
Compiled from <code>PeerToken.sol</code> with solc 0.8.24, optimizer on, 200 runs. Bytecode is embedded in this page; nothing is fetched.
</p>
</main>
<script>
const BYTECODE = ${JSON.stringify(build.bytecode)};
const BASE_CHAIN_ID = '0x2105'; // 8453
const log = (m, cls) => { const d=document.getElementById('log'); d.innerHTML += '<div class="'+(cls||'')+'">'+m+'</div>'; };
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
</script></body></html>`;
fs.writeFileSync('chain-l2/deploy.html', html);
console.log('wrote chain-l2/deploy.html (' + html.length + ' bytes, bytecode embedded)');
