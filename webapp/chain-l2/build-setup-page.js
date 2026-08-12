// An alias, not a second builder.
//
// setup.html and deploy.html are written by ONE program, chain-l2/build-deploy-page.js,
// because they embed the same bytecode and share the same helpers — the
// last-moment chain re-read, the receipt wait, the is-this-really-an-ERC-20
// probe. Two builders for two pages that must agree about those is two chances
// for one of them to stop agreeing, and the one that stopped would be the one
// whose page deploys a contract nobody checked.
//
// This file exists because setup-all.ps1 tells an operator to run
// "node chain-l2\build-setup-page.js" when the page is missing or stale, and an
// instruction printed at the moment something is already wrong has to work. It
// runs the real builder and adds nothing of its own: no bytecode, no
// fingerprint, no template. Delete it the day that message names the other
// file, and nothing is lost.
//
//   node chain-l2/build-setup-page.js     ==     node chain-l2/build-deploy-page.js
//
// Both write chain-l2/deploy.html AND chain-l2/setup.html, and both must be run
// from the webapp directory — the builder reads chain-l2/*.build.json by
// relative path, so the working directory is part of the command.
import './build-deploy-page.js';
