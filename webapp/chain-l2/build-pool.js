// Compile PeerPool.sol into PeerPool.build.json — reproducibly.
//
// Singular. This is the build for THE pool (one address, no names, no ids, no
// factory); build-pools.js next to it builds the superseded multi-pool
// PeerPools.sol and is kept only so the dead deployment on Base can still be
// read against the source it came from.
//
// The artifact this writes is what deploy tooling and the on-chain tests run
// against, so the compile is pinned to exactly what DEPLOY.md tells a human to
// click in Remix: solc 0.8.24, optimizer ON, 200 runs (the same settings
// PeerToken.build.json was produced with). Anyone can rerun this script and
// diff the bytecode byte for byte; if the solc in node_modules is not 0.8.24
// the script refuses to build rather than produce an artifact that quietly
// disagrees with the runbook.
//
// The `hashes` table is the compiler's own methodIdentifiers — the 4-byte
// selectors, straight from solc rather than from any JS keccak library. That is
// the house rule everywhere in this repo: pages and onchain.mjs hardcode
// selectors with the signature in a comment, and this table is where an auditor
// checks them against the compiler's word.
//
// `deployed` is the RUNTIME code — what eth_getCode answers at a deployed pool,
// as opposed to `bytecode`, which is the creation code a wallet is handed. With
// one pool the whole identity argument is "the address IS the answer"
// (PeerPool.sol), and until this was emitted nothing could check that: the host
// asked the address three questions and believed any contract that answered
// them plausibly. onchain.mjs now compares eth_getCode against this, and needs
// two things from the artifact to do it honestly:
//
//   `deployed.immutables` — the byte ranges solc left as zeros for `peer` and
//     `btc`, filled in at construction. Real deployed code differs from this
//     artifact at exactly those ten words, so they are masked out of the
//     comparison; their VALUES are checked separately, against peer() and
//     btc(), which is the same question asked where it can be answered.
//   `deployed.metaLen` — solc appends a CBOR blob ending in the length of
//     itself, and it contains a hash of the SOURCE. Editing a comment in
//     PeerPool.sol changes it while changing no instruction, so it is stripped
//     rather than compared: a live host must not start refusing burns because
//     somebody improved a sentence. What survives the strip is the executable
//     code, which is the thing the check is actually about.
//
// Run from anywhere: node webapp/chain-l2/build-pool.js
import fs from 'node:fs';
import solc from 'solc';

const here = (f) => new URL(f, import.meta.url);

const version = solc.version();
if (!version.startsWith('0.8.24+')) {
  console.error('refusing to build: solc is ' + version + ', the artifact is pinned to 0.8.24');
  process.exit(1);
}

const source = fs.readFileSync(here('PeerPool.sol'), 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'PeerPool.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      '*': {
        '*': [
          'abi',
          'evm.bytecode.object',
          'evm.deployedBytecode.object',
          'evm.deployedBytecode.immutableReferences',
          'evm.methodIdentifiers',
        ],
      },
    },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));

// Zero errors AND zero warnings. A warning the build tolerates today is one
// nobody reads tomorrow, and this contract's whole pitch is that reading it
// settles every question.
const diagnostics = out.errors || [];
if (diagnostics.length) {
  for (const d of diagnostics) console.error(d.formattedMessage || d.message);
  console.error('refusing to build: the compile must be clean, and it produced ' + diagnostics.length + ' diagnostic(s)');
  process.exit(1);
}

const c = out.contracts['PeerPool.sol'].PeerPool;

// The immutable ranges, flattened out of solc's per-AST-node map into a plain
// sorted list of {start, length}: onchain.mjs only ever needs "which bytes are
// not this file's to predict", and the AST ids are a compiler detail that would
// change under an edit that moved nothing.
const runtime = c.evm.deployedBytecode.object;
const immutables = Object.values(c.evm.deployedBytecode.immutableReferences || {})
  .flat()
  .map((r) => ({ start: r.start, length: r.length }))
  .sort((a, b) => a.start - b.start);
// The last two bytes of the CBOR trailer are its own length, big-endian, which
// is the only way to find where it starts. Refuse rather than guess: a trailer
// this script mismeasured would make the host compare the wrong bytes and
// report a real mismatch as agreement, or the reverse.
const metaLen = parseInt(runtime.slice(-4), 16) + 2;
if (!(metaLen > 2) || metaLen * 2 >= runtime.length) {
  console.error('refusing to build: the runtime code does not end in a readable metadata length (' + runtime.slice(-4) + ')');
  process.exit(1);
}
for (const r of immutables) {
  if ((r.start + r.length) * 2 > runtime.length - metaLen * 2) {
    console.error('refusing to build: an immutable range runs past the end of the code');
    process.exit(1);
  }
}

const artifact = {
  abi: c.abi,
  bytecode: '0x' + c.evm.bytecode.object,
  deployed: { object: '0x' + runtime, immutables, metaLen },
  hashes: c.evm.methodIdentifiers,
};
fs.writeFileSync(here('PeerPool.build.json'), JSON.stringify(artifact, null, 2) + '\n');
console.log('wrote chain-l2/PeerPool.build.json');
console.log('  solc      ' + version);
console.log('  bytecode  ' + ((artifact.bytecode.length - 2) / 2) + ' bytes');
console.log('  deployed  ' + (runtime.length / 2) + ' bytes, ' + immutables.length + ' immutable words, ' + metaLen + ' bytes of metadata');
for (const [sig, hash] of Object.entries(artifact.hashes)) console.log('  ' + hash + '  ' + sig);
