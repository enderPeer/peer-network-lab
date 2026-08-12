// Compile PeerAnchor.sol and PeerClaim.sol into their build.json artifacts —
// reproducibly, and on exactly the terms build-pools.js already set.
//
// The artifacts this writes are what deploy tooling and the on-chain tests run
// against, so the compile is pinned to what DEPLOY.md tells a human to click in
// Remix: solc 0.8.24, optimizer ON, 200 runs (the settings PeerToken.build.json
// and PeerPools.build.json were produced with). Anyone can rerun this script and
// diff the bytecode byte for byte; if the solc in node_modules is not 0.8.24 the
// script refuses to build rather than produce an artifact that quietly disagrees
// with the runbook.
//
// The two contracts are compiled in two SEPARATE solc invocations, one source
// unit each, rather than together in one input. Neither file imports anything,
// so the split costs nothing — and it keeps each artifact the output of exactly
// the compile a human reproduces by opening that one file in Remix, with no
// second source in the unit that could ever show up in the metadata.
//
// The `hashes` table is the compiler's own methodIdentifiers — the 4-byte
// selectors, straight from solc rather than from any JS keccak library. That is
// the house rule everywhere in this repo: pages and onchain.mjs hardcode
// selectors with the signature in a comment, and this table is where an auditor
// checks them against the compiler's word.
//
// Run from anywhere: node webapp/chain-l2/build-epoch.js
import fs from 'node:fs';
import solc from 'solc';

const here = (f) => new URL(f, import.meta.url);

const version = solc.version();
if (!version.startsWith('0.8.24+')) {
  console.error('refusing to build: solc is ' + version + ', the artifacts are pinned to 0.8.24');
  process.exit(1);
}

// [source file, contract name]. The file name is also the source-unit key, so
// it is what appears in the compiler's own diagnostics below.
const targets = [
  ['PeerAnchor.sol', 'PeerAnchor'],
  ['PeerClaim.sol', 'PeerClaim'],
];

for (const [file, name] of targets) {
  const source = fs.readFileSync(here(file), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { [file]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.methodIdentifiers'] } },
    },
  };

  const out = JSON.parse(solc.compile(JSON.stringify(input)));

  // Zero errors AND zero warnings. A warning the build tolerates today is one
  // nobody reads tomorrow, and these contracts' whole pitch is that reading
  // them settles every question.
  const diagnostics = out.errors || [];
  if (diagnostics.length) {
    for (const d of diagnostics) console.error(d.formattedMessage || d.message);
    console.error(
      'refusing to build ' + name + ': the compile must be clean, and it produced ' + diagnostics.length + ' diagnostic(s)',
    );
    process.exit(1);
  }

  const c = out.contracts[file][name];
  const artifact = {
    abi: c.abi,
    bytecode: '0x' + c.evm.bytecode.object,
    hashes: c.evm.methodIdentifiers,
  };
  const artifactFile = name + '.build.json';
  fs.writeFileSync(here(artifactFile), JSON.stringify(artifact, null, 2) + '\n');
  console.log('wrote chain-l2/' + artifactFile);
  console.log('  solc      ' + version);
  console.log('  bytecode  ' + ((artifact.bytecode.length - 2) / 2) + ' bytes');
  for (const [sig, hash] of Object.entries(artifact.hashes)) console.log('  ' + hash + '  ' + sig);
}
