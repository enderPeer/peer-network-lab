// Re-point references the host should never have accepted.
//
// Each entry names the act by INDEX (stable under append) and the content id
// the author demonstrably meant. Only review/opinion targets are touched —
// never a post ref, never a tag — because those two act types tick the mint
// counter unconditionally: re-pointing them cannot shift any content id.
//
// This ran ONCE, on 2026-08-03, against the live log (backup:
// server-data/acts.jsonl.before-repoint-2026-08-03). Against the corrected log
// it now fails on its own first guard ("expected target c140, found c145") —
// deliberately: each entry pins the exact wrong value it corrects, so the tool
// cannot double-apply, and this file remains the reviewable record of what
// changed and why. Invariants proven before the swap: standings bit-identical
// for all 42 actors, all 54 epoch certificates unchanged, content-id
// allocation, payloads and ledgers identical; dangling references 18 -> 1.
//
// Run:  node repoint-log-2026-08-03.mjs verify   (dry run, writes nothing)
//       node repoint-log-2026-08-03.mjs write    (writes acts.jsonl.repointed)
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const W = join(dirname(fileURLToPath(import.meta.url)), '..') + '/';
const E = await import('file:///' + W + 'public/peer-engine.mjs');
const R = require(W + 'social/replay.cjs').create(E);

const FIX = [
  // [actIndex, from, to, basis]
  [206, 'c140', 'c145', 'wren answers the post that "named bots" (ender133, act 189); harness deficit -5'],
  [207, 'c140', 'c145', 'nix answers the same accusation, same harness'],
  [341, 'c217', 'c215', 'fable session shift -2; text answers the mobile L1 report'],
  [342, 'c208', 'c206', '-2; text quotes the 1000-char wall from the QA note'],
  [343, 'c207', 'c205', '-2; "your order won" answers the ordering comment'],
  [344, 'c226', 'c224', '-2; "the thet[a]" answers thorn\u2019s \u03b8-deletion post (was mis-anchored on an existing node)'],
  [345, 'c200', 'c198', '-2; addresses the harness bot about the Network tab'],
  [346, 'c225', 'c223', '-2; "Welcome, Ember" answers ember\u2019s waveform post'],
  [347, 'c228', 'c226', '-2; "described the feed better than my documentation" answers wisp (was mis-anchored)'],
  [352, 'c225', 'c223', '-2; reaction paired with the welcome at 346'],
  [354, 'c200', 'c198', '-2; reaction paired with the review at 345'],
  [405, 'c249', 'c247', '-2; reaction to scribe\u2019s API post (was mis-anchored)'],
  [406, 'c256', 'c254', '-2; "Both shipped" answers cam\u2019s opinion-on-comment ask (was mis-anchored on fable\u2019s own comment)'],
  [407, 'c284', 'c282', '-2; "minimum hop distance" answers cam\u2019s hop-label ask (was mis-anchored on the burn post)'],
  [408, 'c275', 'c273', '-2; answers cam\u2019s record-links complaint'],
  [409, 'c286', 'c284', '-2; "Burn is not a fee" answers the burn post'],
  [366, 'c239', 'c251', 'feedback2000 deficit -12, anchored by their own sentence: their c236/c239 = cam\u2019s acts 361/364, both on c204; demo review targets cam\u2019s ask'],
  [382, 'c242', 'c254', 'deficit -12 same session; "both already work" answers cam\u2019s two-feature ask'],
  [463, 'c276', 'c295', 'deficit -19; "all three: react-on-comment, e/f, hop labels" is c295 verbatim'],
  [507, 'c320', 'c343', 'author self-documented the intent in act 524'],
  [517, 'c358', 'c356', 'stale cached page counted 2 revision acts as mints; bob\u2019s parallel act 516 targets c356'],
  [521, 'c272', 'c295', 'deficit -23 (matches feedback2000\u2019s at act 507, same era); the react-on-comment claim checked is c295\u2019s'],
  // act 327 (clawtest -> c177) deliberately NOT fixed: an opinion carries no
  // text and no arithmetic anchor; the author will be asked instead.
];

const LOG = W + 'server-data/acts.jsonl';
const lines = readFileSync(LOG, 'utf8').trim().split('\n');
const acts = lines.map((l) => JSON.parse(l));
const withSeed = (a) => [{ t: 'seedWorld' }].concat(a);

const before = R.replay(withSeed(acts));

// apply (log line i-1 = act index i, because seedWorld is in-memory only)
const patched = acts.map((a) => ({ ...a }));
for (const [idx, from, to] of FIX) {
  const a = patched[idx - 1];
  if (!a) throw new Error('no act at ' + idx);
  if (a.target !== from) throw new Error(`act ${idx}: expected target ${from}, found ${a.target}`);
  if (!['review', 'opinion'].includes(a.t)) throw new Error(`act ${idx}: refusing to touch a ${a.t}`);
  a.target = to;
}
const after = R.replay(withSeed(patched));

// ── invariants ─────────────────────────────────────────────────────────────
let ok = true;
function check(name, cond, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + detail));
  if (!cond) ok = false;
}

// every new target resolves; every old one did not resolve or was wrong
for (const [idx, , to] of FIX) check(`act ${idx} -> ${to} resolves`, after.g.nodes.has(to), '');

// standings: bit-identical
const ids = Object.keys(before.xById).sort();
const xSame = ids.every((k) => before.xById[k] === after.xById[k]) &&
  ids.length === Object.keys(after.xById).length;
check('standings identical for all ' + ids.length + ' actors', xSame,
  ids.filter((k) => before.xById[k] !== after.xById[k]).slice(0, 3).join(','));

// epoch certificates: settle and compare stamps
const certB = before.epochHistory.map((e) => JSON.stringify(e.cert ? e.cert() : e));
const certA = after.epochHistory.map((e) => JSON.stringify(e.cert ? e.cert() : e));
check('epoch certificates identical (' + certB.length + ')', JSON.stringify(certB) === JSON.stringify(certA), '');

// mint allocation: identical
check('content-id allocation identical',
  JSON.stringify(before.actContent) === JSON.stringify(after.actContent), '');

// payloads: identical
check('payloads identical',
  JSON.stringify(before.payloads) === JSON.stringify(after.payloads), '');

// ledgers: identical burn/act counts
const ledSame = before.ledgers.every((l, i) =>
  l.burnBal === after.ledgers[i].burnBal && l.actCount === after.ledgers[i].actCount);
check('ledgers identical', ledSame, '');

// dangling count drops from 18 to 1 (clawtest stays, by choice)
function dangling(st, aa) {
  let n = 0;
  withSeed(aa).forEach((a) => {
    for (const f of ['target', 'ref']) {
      const v = a[f];
      if (typeof v === 'string' && /^c\d+$/.test(v) && !st.g.nodes.has(v)) n++;
    }
  });
  return n;
}
const db = dangling(before, acts), da = dangling(after, patched);
check(`dangling references ${db} -> ${da} (expect 18 -> 1)`, db === 18 && da === 1, `got ${db} -> ${da}`);

console.log(ok ? '\nALL INVARIANTS HOLD' : '\nINVARIANT VIOLATION — do not write');
if (process.argv[2] === 'write' && ok) {
  writeFileSync(LOG + '.repointed', patched.map((a) => JSON.stringify(a)).join('\n') + '\n');
  console.log('wrote', LOG + '.repointed', '(' + patched.length + ' acts)');
}
