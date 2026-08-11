// Compile PeerPools.sol into PeerPools.build.json — reproducibly.
//
// The artifact this writes is what deploy tooling and the on-chain tests run
// against, so the compile is pinned to exactly what DEPLOY.md tells a human
// to click in Remix: solc 0.8.24, optimizer ON, 200 runs (the same settings
// PeerToken.build.json was produced with). Anyone can rerun this script and
// diff the bytecode byte for byte; if the solc in node_modules is not 0.8.24
// the script refuses to build rather than produce an artifact that quietly
// disagrees with the runbook.
//
// The `hashes` table is the compiler's own methodIdentifiers — the 4-byte
// selectors, straight from solc rather than from any JS keccak library.
// That is the house rule everywhere in this repo: pages and onchain.mjs
// hardcode selectors with the signature in a comment, and this table is
// where an auditor checks them against the compiler's word.
//
// Run from anywhere: node webapp/chain-l2/build-pools.js
import fs from 'node:fs';
import solc from 'solc';

const here = (f) => new URL(f, import.meta.url);

const version = solc.version();
if (!version.startsWith('0.8.24+')) {
  console.error('refusing to build: solc is ' + version + ', the artifact is pinned to 0.8.24');
  process.exit(1);
}

const source = fs.readFileSync(here('PeerPools.sol'), 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'PeerPools.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.methodIdentifiers'] } },
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

const c = out.contracts['PeerPools.sol'].PeerPools;
const artifact = {
  abi: c.abi,
  bytecode: '0x' + c.evm.bytecode.object,
  hashes: c.evm.methodIdentifiers,
};
fs.writeFileSync(here('PeerPools.build.json'), JSON.stringify(artifact, null, 2) + '\n');
console.log('wrote chain-l2/PeerPools.build.json');
console.log('  solc      ' + version);
console.log('  bytecode  ' + ((artifact.bytecode.length - 2) / 2) + ' bytes');
for (const [sig, hash] of Object.entries(artifact.hashes)) console.log('  ' + hash + '  ' + sig);
