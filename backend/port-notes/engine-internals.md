# Engine internals — bit-exact porting notes (per module)

Companion to `engine-api.md`. This file records every data structure, every
float computation VERBATIM (JS evaluation order is law), every iteration whose
order affects float accumulation, and every piece of mutable state.

## Global rules for the Rust port

1. **All numbers are IEEE-754 f64.** No f32 anywhere, no extended precision.
2. **Evaluation order of every expression must match the JS source.** JS
   evaluates left-to-right with standard precedence; e.g.
   `l.burnBal / Math.max(l.actCount, 1) / NU` is TWO divisions,
   `(burnBal / max) / NU`, not `burnBal / (max * NU)`.
3. **Math.* inventory** (every transcendental site is listed per module below).
   `Math.sqrt` is IEEE exact-rounded (safe everywhere). `Math.exp`, `Math.log`,
   `Math.pow`, `Math.tanh` are implementation-defined per spec — the port must
   use whatever mapping the byte-parity harness has already fixed against V8
   (see backend/ARCHITECTURE.md); do NOT silently substitute `f64::exp` etc.
   without parity tests. Sites: **exp** (sigmoid, boltzmann, cogra path
   magnitude `Math.exp(-cost)`), **log** (BETA constant, binaryEntropy,
   cogra cost `-Math.log(gamma*w)`, attestCap), **tanh** (fpm, Q),
   **pow** (vouchAct, hopMatrix tilt, cogra recency `Math.pow(0.5, dt/hl)`),
   **sqrt** (HALF_FLOOR, coherence, frobenius, detScore, singularValues2, Q),
   plus one `** 2` (singularValues2 — JS `**` is Number::exponentiate, i.e.
   Math.pow semantics; for exponent exactly 2 V8 result equals `x*x`, but flag
   it for the parity harness).
4. **JS Map iteration order = insertion order** (spec-guaranteed).
   `Map.set` on an existing key keeps the ORIGINAL insertion position. Rust
   port: use an insertion-ordered map (e.g. IndexMap) wherever a Map's values
   are iterated (flagged per site below).
5. **Array.prototype.sort is stable** (ES2019+). Ties keep prior order — this
   is observable in `cograRank` and `rankFeed` outputs.
6. **`Math.max(...arr)`** on a non-empty array = plain max fold. `Math.sign(x) || 1`:
   `Math.sign` returns 0 for +0, -0 for -0; both are falsy so `|| 1` yields 1.
   `Math.sign(negative)` = -1.
7. **`??` vs `||`**: `a ?? b` substitutes only for `undefined`/`null` (0 passes
   through); noted per site.

---

## 1. constants.ts

No structures. All values in engine-api.md §1. Porting notes:

- `BETA = 2 * Math.log(2)` — compute `ln(2)` with the harness's log, then
  multiply by 2 (exact in f64: exponent increment).
- `HALF_FLOOR = Math.sqrt(0.05)` — IEEE sqrt of the f64 nearest to 0.05.
- `SAFE_FLOOR = 0.0528066 / 0.1` — one f64 division of the two literal
  roundings. Do NOT write `0.528066` as a literal; `0.0528066/0.1` in f64 is
  `0.528066` only up to the division's rounding; keep the expression.
- `PART_FLOOR = Math.max(1, SAFE_FLOOR)` = exactly `1.0`.
- `TILT_SHAPE`, `DEPTH_MASS` entries are exact dyadic rationals (1, 0.5, 0.25,
  0.125) — exactly representable.

## 2. kernels.ts

All pure functions; no state.

```js
sigmoid(x)       = 1 / (1 + Math.exp(-x))
fpl(x)           = sigmoid(BETA * x)                       // note: BETA*x first, one multiply
fpm(x)           = sigmoid(BETA * Math.abs(x)) * Math.tanh(x)
binaryEntropy(t) : if (t <= 0 || t >= 1) return 0;
                   return -t * Math.log(t) - (1 - t) * Math.log(1 - t);
                   // evaluation: A = (-t)*log(t); B = (1-t)*log(1-t); result A - B
                   // literally: (-t * Math.log(t)) - ((1 - t) * Math.log(1 - t))
boltzmann(tau)   = Math.exp(-BETA * binaryEntropy(tau))    // argument: (-BETA) * H
coherence(tau)   = Math.sqrt(1 + tau * tau)
```

Reference values baked into comments (useful as parity probes, not constants):
`fpl(1) = 4/5` exactly-ish (sigmoid(2 ln 2) = 1/(1+1/4)); `boltzmann(0.5) ≈ 0.383`.

## 3. tensor.ts

### DOMAIN_MASKS
Plain record; masks are 4-tuples of 0/1 (see engine-api.md). Promotion is
handled in graph.ts/cogra.ts by substituting the Tribal mask.

### sentimentSlice(pd, pi, mask) → 3×3 row-major `number[][]`

```js
const [a00, a01, a10, a11] = mask;
const apd = Math.abs(pd);
const api = Math.abs(pi);
return [
  [a00 * fpm(pi * pd),  a01 * fpm(pi * apd), fpm(pi)],
  [a10 * fpm(api * pd), a11 * fpl(api * apd), fpl(api)],
  [fpm(pd),             fpl(apd),             fpl(1)],
];
```
Mask zeroes bilinear (upper-left 2×2) entries only; marginals (row 2 / col 2)
and the `fpl(1)` = 0.8 corner are always live. Products inside fpm/fpl args:
`pi * pd`, `pi * apd`, `api * pd`, `api * apd` — each a single multiply before
the kernel call.

### frobenius(m)

```js
let s = 0;
for (const row of m) for (const v of row) s += v * v;   // row-major accumulation order
return Math.sqrt(s);
```
Accumulation order = row 0 left→right, row 1, row 2. Sum then one sqrt.

### pathView(pd, pi, mask, tier) → 2×2

```js
let s;   // [s00, s01, s10, s11]
if (tier === 'half') {
  s = [HALF_FLOOR, HALF_FLOOR, HALF_FLOOR, 1];
} else {
  const [a00, a01, a10, a11] = mask;
  s = [a00 + (1 - a00) * ETA,
       a01 + (1 - a01) * ETA,
       a10 + (1 - a10) * ETA,
       a11 + (1 - a11) * ETA];   // a=1 → 1; a=0 → ETA (softening)
}
const apd = Math.abs(pd);
const api = Math.abs(pi);
return [
  [s[0] * fpm(pi * pd),  s[1] * fpm(pi * apd)],
  [s[2] * fpm(api * pd), s[3] * fpl(api * apd)],
];
```
Note the half tier IGNORES the mask entirely (√η, √η, √η, 1), while full and
marginal tiers use the softened mask. `tier === 'half'` is a string compare.

### det2 / detScore / detSign / singularValues2 / dampedWeight

```js
det2(m)      = m[0][0]*m[1][1] - m[0][1]*m[1][0]      // (r0[0]*r1[1]) - (r0[1]*r1[0])
detScore(pv) = Math.sqrt(Math.abs(det2(pv)))
detSign(pv)  = det2(pv) >= 0 ? 1 : -1                 // +0 and -0 both give +1 (−0 >= 0 is true)
singularValues2(m):
  const [a, b] = m[0]; const [c, d] = m[1];
  const e = (a*a + b*b + c*c + d*d) / 2;              // sum order: ((a*a + b*b) + c*c) + d*d, then /2
  const f = Math.sqrt(Math.max(0, e*e - det2(m) ** 2));
  return [Math.sqrt(Math.max(0, e + f)), Math.sqrt(Math.max(0, e - f))];
dampedWeight(score, tau) = score * coherence(tau) * boltzmann(tau)
  // evaluation: (score * coherence(tau)) * boltzmann(tau)
```

## 4. families.ts

Pure data (table in engine-api.md §4). Rust: a static map; lookup by family
string. Missing-family fallbacks exist in graph.ts (`?? 'Tribal'`, `?? 'full'`,
`spec?.signForced` → undefined → falsy → detSign used) and cogra.ts
(`foldedWeight` returns 0 for unknown family).

## 5. graph.ts — RawGraph

### Storage & order

- `nodes: Map<string, NodeInfo>` — **insertion order matters** downstream
  (cograRank candidate iteration, rankFeed entry iteration → stable-sort ties).
  Re-`addNode` of an existing id REPLACES the value but keeps the original
  position. Rust: IndexMap with insert-or-update semantics preserving index.
- `edges: EdgeRecord[]` — append-only array; `appendIndex` is the position.
  **Append order is the master order** for: traversal edge scans, cogra fold
  accumulation, T-leg pairing (`edges[appendIndex - 1]`), community fold
  accumulation, contentNorm means.
- `preDeg: Map<string, number>` (private) — endpoint incidence counts,
  monotonically increasing, never reset. `degree(id)` = `preDeg.get(id) ?? 0`.

### τ (maturity) formula — verbatim

```js
tau = input.tauOverride ?? 1 - 1 / (1 + Math.max(this.degree(src), this.degree(tgt)))
```
Precedence: `1 - (1 / (1 + max))`. `tauOverride` uses `??` — an override of `0`
IS honored (0 is not nullish). Pre-degrees are read STRICTLY BEFORE the act's
own bumps.

### buildRecord(input, tau)

```js
const spec  = FAMILIES[input.family];                 // may be undefined
const domain = input.domain ?? spec?.domain ?? 'Tribal';
const tier   = input.tier ?? spec?.tier ?? 'full';
const mask   = resolveMask(input.family, domain);     // promoted → DOMAIN_MASKS.Tribal, else DOMAIN_MASKS[domain]
const slice  = sentimentSlice(input.pd, input.pi, mask);
const pv     = pathView(input.pd, input.pi, mask, tier);
const score  = detScore(pv);
const sign   = spec?.signForced ? 1 : detSign(pv);
// fields: ..., epoch: input.epoch ?? 0, frob: frobenius(slice),
// weight: dampedWeight(score, tau), appendIndex: this.edges.length  (pre-push length)
```
NOTE: `input.domain`/`input.tier` overrides do NOT change the mask choice
beyond `resolveMask(family, domain)` — a domain override changes the mask, a
tier override changes only the pathView tier.

### append / appendHyper — mutation order

`append`: compute tau (pre-state) → buildRecord → push → `bump(src)` → `bump(tgt)`.

`appendHyper(aLeg, tLeg)`: **both taus computed first from the same pre-state**
(tauA then tauT), then recA built (appendIndex = len) and pushed, then recT
built (appendIndex = len+1) and pushed, then bumps in order
aLeg.src, aLeg.tgt, tLeg.src, tLeg.tgt. The legs do NOT mature each other.
`bump` increments by 1 per endpoint per leg — shared endpoints (e.g. carrier
node appearing in both legs) get +2 total.

### outgoing / incoming

`edges.filter(e => e.src === nodeId)` / `(e.tgt === nodeId)` — preserve append
order. Fresh arrays each call.

### Resets

Nothing ever resets. RawGraph is built once per replay and only grows.

## 6. traversal.ts

### hopDistance(graph, sourceId, depth = 4)

```js
const dist = new Map([[sourceId, 0]]);
let frontier = new Set([sourceId]);
for (let d = 1; d <= depth && frontier.size; d++) {
  const next = new Set();
  for (const e of graph.edges) {          // FULL edge scan per layer, append order
    if (e.weight <= 0) continue;          // admissibility: weight > 0
    if (!frontier.has(e.src)) continue;   // directed: src → tgt only
    if (dist.has(e.tgt)) continue;        // first arrival is the minimum
    dist.set(e.tgt, d);
    next.add(e.tgt);
  }
  frontier = next;
}
return dist;   // nodes beyond depth are ABSENT
```
Note admissibility here is `e.weight <= 0 → skip` (a NaN weight would NOT be
skipped; community.ts uses the opposite-polarity test — see §12).

### doubleCoverBFS(graph, sourceId, depth = 4)

Depth-layered max-product over the signed double cover. Verbatim:

```js
const reg = new Map();                          // cumulative registers
get(id) lazily inserts { pos: 0, neg: 0 };
get(sourceId).pos = 1;

let layer = new Map([[sourceId, { pos: 1, neg: 0 }]]);
for (let d = 1; d <= depth; d++) {
  const next = new Map();
  for (const e of graph.edges) {                // append order, full scan per layer
    if (e.weight <= 0) continue;                // routing-inert
    const from = layer.get(e.src);
    if (!from) continue;
    let t = next.get(e.tgt);                    // lazy {pos:0, neg:0}
    if (e.sign > 0) {
      t.pos = Math.max(t.pos, from.pos * e.weight);
      t.neg = Math.max(t.neg, from.neg * e.weight);
    } else {                                    // sign −1 swaps registers
      t.pos = Math.max(t.pos, from.neg * e.weight);
      t.neg = Math.max(t.neg, from.pos * e.weight);
    }
  }
  for (const [id, w] of next) {                 // merge layer into cumulative, Map order
    const r = get(id);
    r.pos = Math.max(r.pos, w.pos);
    r.neg = Math.max(r.neg, w.neg);
  }
  layer = next;
}
return reg;
```
Because it is max-product (not sum), edge-scan order does not change values,
only Map insertion order of `reg` (irrelevant to feed, which looks up by id).
Source keeps `pos = 1` in the result. No pruning threshold.

## 7. feed.ts (legacy/default L2 readout)

```js
STANCE_FAMILIES = Set { 'Opinion', 'Publish' }   // ReviewA deliberately excluded

contentNorm(graph, nodeId):
  stance = graph.incoming(nodeId).filter(e => STANCE_FAMILIES.has(e.family));  // append order
  if (stance.length === 0) return 0;
  pd = stance.reduce((s, e) => s + e.pd, 0) / stance.length;   // left-to-right sum, then divide
  pi = stance.reduce((s, e) => s + e.pi, 0) / stance.length;
  return frobenius(sentimentSlice(pd, pi, DOMAIN_MASKS.Tribal));  // FULL mask regardless of family

rankFeed(graph, viewerId, standingOf, creatorOf):
  reg = doubleCoverBFS(graph, viewerId);         // depth = FEED_DEPTH = 4
  for (const node of graph.nodes.values()) {     // node-Map insertion order
    if (node.kind === 'Actor' || node.kind === 'Profile') continue;
    bfsWeight = reg.get(node.id)?.pos ?? 0;
    if (bfsWeight <= 0) continue;                // unreachable → absent
    creator = creatorOf(node.id);
    amplifier = creator ? 1 + standingOf(creator) / NU : 1;   // note: truthy test — creator '' or null → 1
    norm = contentNorm(graph, node.id);
    relevance = bfsWeight * amplifier * norm;    // (bfs * amp) * norm
  }
  entries.sort((a, b) => b.relevance - a.relevance);   // stable; ties keep node order
```

## 8. standing.ts — the epoch solve

### Scalar kernels — verbatim

```js
refRate(l)  = l.burnBal / Math.max(l.actCount, 1) / NU     // ((burn / max) / NU) — two divisions
emission(l) = Math.min(1, refRate(l) / SAFE_FLOOR)
mobius(x)   = x / (1 + x)
Q(p): const t = Math.tanh(p);
      return sigmoid(BETA * p) * Math.sqrt(t * (1 - ETA * ETA * t));
      // inner: t * (1 - ((ETA*ETA) * t));  ETA*ETA = 0.05*0.05 (one multiply, ≈0.0025000000000000005)
const Q1 = Q(1);                                           // MODULE-LEVEL, computed once
vouchAct(x): if (x <= 0) return 0;
             return Math.pow(Q(mobius(x)) / Q1, ACT_EXPONENT);   // pow(ratio, 0.25)
wallAct(x) = vouchAct(Math.max(x, SAFE_FLOOR))
```

### baseScoreMatrix(ids, cells) → n×n dense `number[][]`

```js
const idx = new Map(ids.map((id, i) => [id, i]));   // duplicate ids: LAST index wins (Map.set overwrites value)
base = n×n matrix, base[u][j] = (u === j ? KAPPA_SELF : 0);
for (const cell of cells) {                          // CELLS ARRAY ORDER = accumulation order
  const u = idx.get(cell.src);
  if (u === undefined) continue;                     // unknown source: cell dropped
  const j = idx.get(cell.rcp) ?? u;                  // unknown recipient → SELF channel (diagonal)
  base[u][j] += cell.coeff;
}
```

### hopMatrix(base, x, hop, tilt) — private

```js
const exp = tilt * TILT_SHAPE[hop - 1];              // hop ∈ 1..4 → tilt·{1, .5, .25, .125}
for (let u = 0; u < n; u++) {
  let sum = 0;
  for (let j = 0; j < n; j++) {                      // j ascending — sum accumulation order
    const s = u === j ? base[u][j]
                      : base[u][j] * Math.pow(wallAct(x[j]), exp);   // self unmodulated
    row[j] = s;
    sum += s;
  }
  for (let j = 0; j < n; j++) row[j] /= sum;          // row-normalize in place, j ascending
}
```
`Math.pow(wallAct(x[j]), exp)` is recomputed per (u, j) — n times per column
per hop. Do NOT cache/deduplicate unless bitwise-identical (pure function of
(x[j], exp), so a per-j cache within one hopMatrix call IS safe — same inputs,
same call — but keep the accumulation order).

### matMul(a, b) — private — LOOP ORDER i-k-j with zero-skip

```js
out = n×n zeros;
for (let i = 0; i < n; i++)
  for (let k = 0; k < n; k++) {
    const aik = a[i][k];
    if (aik === 0) continue;        // exact-zero skip — does not change sums (adding 0*b is exact) but port it anyway
    for (let j = 0; j < n; j++) out[i][j] += aik * b[k][j];
  }
```
**Accumulation order over k is ascending for each (i, j)** — this fixes the
float sum order. (Skipping aik === 0 is float-safe: contributions would be
±0 or, if b[k][j] is ±Infinity/NaN, different — with row-stochastic finite
matrices this never occurs; port the skip verbatim regardless.)

### transport(base, x, emissions, tilt) — verbatim

```js
mix = n×n zeros;
let product = null;
for (let m = 1; m <= HOP_MAX; m++) {                 // m = 1..4
  const lam = hopMatrix(base, x, m, tilt);
  product = product ? matMul(product, lam) : lam;    // LEFT-ASSOCIATED: ((Λ1·Λ2)·Λ3)·Λ4
  const mass = DEPTH_MASS[m - 1];                    // 0.5, 0.25, 0.125, 0.125
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) mix[i][j] += mass * product[i][j];
}
pi = n×n zeros;
for (let u = 0; u < n; u++) {
  for (let j = 0; j < n; j++) pi[u][j] = emissions[u] * mix[u][j];
  pi[u][u] += 1 - emissions[u];
}
```
Note m=1 uses lam DIRECTLY as product (no identity multiply).

### solveStanding(ledgers, cells, opts) — the fixed-point iteration

```js
const { tilt = 1, maxIter = 200, tol = 1e-13 } = opts;
const ids    = ledgers.map(l => l.id);
const base   = baseScoreMatrix(ids, cells);
const rates  = ledgers.map(refRate);
const counts = ledgers.map(l => Math.max(l.actCount, 1));
const emis   = ledgers.map(emission);

let x = rates.slice();                       // x⁰ = source-rate vector
const trace = [x.slice()];
let residual = Infinity;
let iter = 0;
let pi = transport(base, x, emis, tilt);     // computed once BEFORE the loop…
while (iter < maxIter) {
  pi = transport(base, x, emis, tilt);       // …and RECOMPUTED at the top of every pass
  const next = new Array(ids.length);
  for (let i = 0; i < ids.length; i++) {     // i = target index
    let num = 0;
    let den = 0;
    for (let u = 0; u < ids.length; u++) {   // u ascending — accumulation order
      const m = pi[u][i] * counts[u];
      num += m * rates[u];
      den += m;
    }
    next[i] = den > 0 ? num / den : rates[i];
  }
  residual = Math.max(...next.map((v, i) => Math.abs(v - x[i])));
  x = next;
  trace.push(x.slice());
  iter++;
  if (residual < tol) break;                 // STRICT <; test AFTER updating x/trace/iter
}
return { ids, x, pi, iterations: iter, residual, trace };
```
No damping/relaxation — plain Picard iteration of the mediant map
`F_i(x) = Σ_u Π[u][i]·N_u·rate_u / Σ_u Π[u][i]·N_u`. The returned `pi` is the
transport at the LAST computed x-input (i.e. the x before the final update),
because pi is recomputed at loop top, not after convergence. If maxIter were 0
the pre-loop pi (at x⁰) is returned. `trace` holds x⁰ plus every iterate.
NOTE: `rates`, `counts`, `emis` are frozen from the input ledgers; only x
evolves; emissions do NOT track x.

### evaluateGates(ledgers, x, deltaActs) — verbatim

```js
w1  = ledgers.map(l => ({ id: l.id, burnBal: l.burnBal, pass: l.burnBal >= 0 }));
w2a = ledgers
  .map((l, i) => ({ id: l.id, stamp: x[i], delta: deltaActs.get(l.id) ?? 0 }))
  .filter(e => e.delta > 0)                          // only authors with new acts
  .map(e => ({ id: e.id, stamp: e.stamp, pass: e.stamp >= SAFE_FLOOR }));
let mSum = 0, stampSum = 0, headroom = 0;
ledgers.forEach((l, i) => {                          // LEDGER ORDER = accumulation order
  const m = deltaActs.get(l.id) ?? 0;
  if (m <= 0) return;
  mSum += m;
  stampSum += m * x[i];
  headroom += m * (x[i] - PART_FLOOR);
});
epochStamp = mSum > 0 ? stampSum / mSum : 0;
w2bPass = mSum === 0 || epochStamp >= PART_FLOOR;
allPass = w1.every(e => e.pass) && w2a.every(e => e.pass) && w2bPass;
```
`x` is indexed by ledger position — the caller MUST pass the same ledger order
used for solveStanding.

### debitAct(l)

Pure: `{ ...l, burnBal: l.burnBal - THETA, actCount: l.actCount + 1 }` — returns
a NEW ledger; does not mutate. (replay.cjs has its own inline debit; this
export is used by tests/UI.)

## 9. attestation.ts — AttestationLedger (class, mutable)

### Instance state

| Field | Init | Mutated by |
|---|---|---|
| `cfg` | `{ ...L0_DEFAULTS, ...cfg }` | never |
| `omega` | `E0` | `redeem` (−payout), `closeCycle` (+dOmega) |
| `yLive` | `zeta * E0` | `burn` (−x), `redeem` (−x), `closeCycle` (+…), maturity (+yLock) |
| `yLock` | `(1 - zeta) * E0` | `closeCycle` (+…), maturity (→0) |
| `cycle` | 0 | `closeCycle` (+1) |
| `settledFloor` | 1 | `closeCycle` end (`= this.floor()`) |
| `escrow` | `[]` | `deposit` (push), `closeCycle` (cleared to `[]` iff dOmega > 0) |
| `balances` | Map; constructor seeds OPERATOR `{live: yLive, tlock: yLock}` | `bal()` lazy-insert; all ops |

Constructor order: `omega = E0; yLive = zeta*E0; yLock = (1-zeta)*E0;`
`op = bal('op'); op.live = this.yLive; op.tlock = this.yLock;`
With replay's `E0: 0`: everything 0, `floor()` hits the `totalSupply > 0 ? … : 1`
fallback → 1, `attestCap = 0 * Math.log(1/(1-0.5)) = 0`.

### Operations — verbatim arithmetic

```js
floor() = totalSupply > 0 ? omega / totalSupply : 1     // totalSupply = yLive + yLock
attestCap = cfg.E0 * Math.log(1 / (1 - cfg.zeta))

faucet(addr, amount):  bal(addr).reserve += amount

deposit(addr, delta):
  if (delta <= 0 || b.reserve < delta - 1e-12) throw Error('insufficient reserve');
  b.reserve -= delta;
  escrow.push({ addr, amount: delta });                 // mint deferred to cycle boundary

burn(addr, x, favor = addr):
  if (x <= 0 || b.live < x - 1e-12) throw Error('insufficient live units');
  b.live -= x;  yLive -= x;
  const deltaA = x * settledFloor;                      // SETTLEMENT-PINNED, not current floor
  bal(favor).attest += deltaA;
  return deltaA;                                        // Ω unchanged ⇒ floor rises

redeem(addr, x):
  if (x <= 0 || b.live < x - 1e-12) throw Error('insufficient live units');
  const payout = x * this.floor();                      // CURRENT floor
  b.live -= x;  yLive -= x;  omega -= payout;  b.reserve += payout;
  return payout;

transfer(from, to, x, cls = 'live'):
  if (x <= 0 || f[cls] < x - 1e-12) throw Error('insufficient units');
  f[cls] -= x;  bal(to)[cls] += x;
```

### closeCycle() — exact step order

```js
const preFloor = this.floor();                          // A.0 — φ⁻ BEFORE issuance
const dOmega = escrow.reduce((s, e) => s + e.amount, 0);// A.1 — escrow array order
const boot = this.cycle + 1 < cfg.maturityCycle;        // NOTE: cycle+1 (the cycle being closed INTO)
let minted = 0;
if (dOmega > 0) {
  const dY = dOmega / preFloor;                         // A.2
  minted = dY;
  for (const e of escrow) {                             // escrow order
    const share = (1 - fee) * (e.amount / dOmega) * dY; // ((1-fee) * (amount/dOmega)) * dY
    if (boot) { b.live += share * zeta; b.tlock += share * (1 - zeta); }
    else      { b.live += share; }
  }
  const op = bal(OPERATOR);
  if (boot) {
    op.live  += fee * zeta * dY;                        // (fee * zeta) * dY
    op.tlock += fee * (1 - zeta) * dY;
    yLive += zeta * dY;  yLock += (1 - zeta) * dY;
  } else {
    op.live += fee * dY;  yLive += dY;
  }
  omega += dOmega;                                      // A.3
  escrow = [];
}
cycle += 1;
if (cycle === cfg.maturityCycle) {                      // A.3½ — one-time relabel
  for (const b of balances.values()) { b.live += b.tlock; b.tlock = 0; }  // Map insertion order (values only moved, no arithmetic coupling)
  yLive += yLock;  yLock = 0;
}
settledFloor = this.floor();                            // settlement commits the floor
return { minted, floor: settledFloor };
```
If `dOmega === 0` (empty escrow — deposits guarantee amount > 0, so nonempty
escrow ⇒ dOmega > 0), the mint block is skipped and escrow is left as-is
(vacuously empty). `boot` uses `cycle + 1`, but the maturity relabel fires when
the post-increment cycle EQUALS maturityCycle — both semantics must be ported
exactly.

## 10. can.ts

Pure functions, no state:

```js
transmission(childNorms):
  if (length === 0) return 0;
  const m = childNorms.reduce((a, b) => a + b, 0) / childNorms.length;  // array-order sum
  return m / (1 + m);

dependencyWeights(childNorms):
  const sum = childNorms.reduce((a, b) => a + b, 0);
  return childNorms.map(n => (sum > 0 ? n / sum : 0));

canValue(node):
  const t = transmission(node.childNorms);
  const w = dependencyWeights(node.childNorms);
  let mix = 0;
  for (let i = 0; i < w.length; i++) mix += w[i] * (node.childValues[i] ?? 0);  // index order
  return t * mix;
```
`childValues[i] ?? 0` — missing entries count as 0.

## 11. cogra.ts — CoGra feed ranking

### Module constants

```js
COGRA_DEFAULTS = { k: 5, gamma: 1, chi: 1e-4, halfLifeEpochs: 4 }
NEVER_TRAVERSED = Set { 'SelfDeclaration', 'SelfReputation', 'Registration', 'Control' }
T_LEGS = { ReviewT: 'ReviewA', TagT: 'TagA', ReferenceT: 'ReferenceA' }
clip(v) = Math.max(-1, Math.min(1, v))
```

### foldedWeight(family, pd, pi, tau)

```js
const spec = FAMILIES[family];
if (!spec) return 0;
const mask = spec.promoted ? DOMAIN_MASKS.Tribal : DOMAIN_MASKS[spec.domain];
const pv = pathView(pd, pi, mask, spec.tier);
return dampedWeight(detScore(pv), tau);
```
Same pipeline as RawGraph.buildRecord, minus sign forcing (sign handled by
pdSign/piNegative separately).

### foldBundles(edges) — sum-then-clip

```js
const bundles = new Map();                    // key = src + '|' + tgt + '|' + family
for (const e of edges) {                      // INPUT ARRAY ORDER (append order)
  // lazy init: { family, src, tgt, pd: 0, pi: 0, tau: e.tau, epoch: e.epoch ?? 0, weight: 0, key }
  b.pd += e.pd;                               // accumulation order = append order
  b.pi += e.pi;
  if (e.appendIndex >= 0) {                   // ALWAYS true for RawGraph records
    b.tau = e.tau;                            // τ of the LAST (≺-newest) member
    b.epoch = Math.max(b.epoch, e.epoch ?? 0);
  }
}
for (const b of bundles.values()) {           // Map insertion order
  b.pd = clip(b.pd);
  b.pi = clip(b.pi);
  b.weight = b.pd === 0 || b.pi === 0 ? 0     // EXACT === 0 test after clip; (0,0) nets are inert
           : foldedWeight(b.family, b.pd, b.pi, b.tau);
}
```
Note: a fold summing to exactly 0.0 (e.g. +0.5 + −0.5) is inert; −0 also
`=== 0`. Bundle Map insertion order (first appearance of the key in append
order) drives hop-list order downstream.

### buildHops(graph, opts) — verbatim structure

```js
kindOf(id) = graph.nodes.get(id)?.kind ?? 'Content';

// 1) Partition raw edges, append order:
for (const e of graph.edges) {
  if (NEVER_TRAVERSED.has(e.family)) continue;
  if (T_LEGS[e.family]) {
    const prev = graph.edges[e.appendIndex - 1];           // adjacency pairing (v0 rule)
    tLegs.push({ t: e, a: prev && prev.family === T_LEGS[e.family] ? prev : null });
  } else ordinary.push(e);
}

// 2) bundles = foldBundles(ordinary)

// 3) push closure (applies to every candidate hop):
push(h):
  if (h.weight <= 0) return;                 // zero is inert
  if (kindOf(h.from) === 'Type') return;     // Types are sinks
  const from = opts.personOf(h.from);
  const to   = opts.personOf(h.to);
  if (from === to) return;                   // intra-person is not a hop
  hops.get(from) push { ...h, from, to };    // LIST ORDER = push order (matters for Dijkstra queue)

// 4) ordinary bundles → hops, in bundles.values() order:
push({ from: b.src, to: b.tgt, weight: b.weight,
       pdSign: Math.sign(b.pd) || 1, piNegative: b.pi < 0,
       epoch: b.epoch, key: b.key });

// 5) A-leg fold per (src|tgt|family) over tLegs' paired a-legs (append order):
aFold: f.pd += a.pd; f.pi += a.pi;           // NOT clipped here; clipped at use

// 6) channel-gated T-legs, in tLegs order:
for (const { t, a } of tLegs) {
  const author = a ? a.src : null;
  const carrier = t.src;
  const creator = opts.creatorOf(carrier);
  if (author && creator && opts.personOf(author) === opts.personOf(creator)) {
    // content-intrinsic: free continuation carrier → t.tgt at t.weight
    push({ from: carrier, to: t.tgt, weight: t.weight,
           pdSign: Math.sign(t.pd) || 1, piNegative: t.pi < 0,
           epoch: t.epoch ?? 0, key: t.id });
  } else if (author && a) {
    // initiator-owned: composite author → t.tgt at foldedAWeight * t.weight
    const f = aFold.get(a.src + '|' + a.tgt + '|' + a.family);   // always present
    const fpd = clip(f.pd);  const fpi = clip(f.pi);
    const aWeight = fpd === 0 || fpi === 0 ? 0 : foldedWeight(a.family, fpd, fpi, a.tau);
    // NOTE: a.tau here is THIS leg's tau (not the newest bundle member's) — verbatim
    push({ from: author, to: t.tgt, weight: aWeight * t.weight,
           pdSign: (Math.sign(fpd) || 1) * (Math.sign(t.pd) || 1),
           piNegative: fpi < 0 || t.pi < 0,
           epoch: Math.max(a.epoch ?? 0, t.epoch ?? 0),
           key: a.id + '+' + t.id });
  }
  // a === null and no creator match ⇒ the T-leg is unreachable (dropped)
}
```
Hops Map: key = folded person/node id, value = Vec<Hop> in push order.
Rust: IndexMap or HashMap is fine for the MAP (looked up by key), but the
per-key Vec ORDER is load-bearing (queue insertion order → tie behavior).

### strongestPath(hops, source, target, banned, usedHops, gamma) — max-product Dijkstra

```js
// Entry { node, cost, keys, path }; cost = Σ −ln(γ·w); keys = '/'-joined hop keys
const best = new Map();                       // node → { cost, keys }
const queue = [{ node: source, cost: 0, keys: '', path: [] }];
let found = null;
while (queue.length) {
  // linear min-scan; strict improvement rule with 1e-15 epsilon, key-string tiebreak:
  let bi = 0;
  for (let i = 1; i < queue.length; i++) {
    if (q.cost < b.cost - 1e-15
        || (Math.abs(q.cost - b.cost) <= 1e-15 && q.keys < b.keys)) bi = i;
  }
  const cur = queue.splice(bi, 1)[0];
  const seen = best.get(cur.node);
  if (seen && (seen.cost < cur.cost - 1e-15
        || (Math.abs(seen.cost - cur.cost) <= 1e-15 && seen.keys <= cur.keys))) continue;
  best.set(cur.node, { cost: cur.cost, keys: cur.keys });
  if (cur.node === target) { found = cur; break; }
  for (const h of hops.get(cur.node) ?? []) {          // hop-list order
    if (banned.has(h.to)) continue;                    // interior of an extracted path
    if (usedHops.has(h.key)) continue;                 // hop-distinctness across extracted paths
    if (cur.path.some(p => p.to === h.to || p.from === h.to)) continue;  // no revisit
    const cost = cur.cost - Math.log(gamma * h.weight);
    queue.push({ node: h.to, cost, keys: cur.keys + '/' + h.key, path: cur.path.concat(h) });
  }
}
if (!found) return null;
return { nodes: [source, ...found.path.map(h => h.to)], hops: found.path,
         m: Math.exp(-found.cost) };
```
Critical port details:
- `q.keys < b.keys` / `seen.keys <= cur.keys` are **JS string comparisons**
  (UTF-16 code-unit lexicographic). Keys are built from edge/bundle ids joined
  with `/` and `+`/`|` — Rust byte-wise `str` comparison matches for ASCII ids.
  Note `<=` (not `<`) in the settled-node skip: equal keys also skip.
- The min-scan takes the FIRST queue index unless a later one is strictly
  better under the (epsilon, keys) rule — queue insertion order (BFS-ish push
  order) is therefore observable. Port as an explicit Vec with linear scan;
  a BinaryHeap would break tie behavior.
- The revisit check scans `cur.path` — source can never be re-entered because
  every path hop has `from` starting at source or a previously visited node
  (check is `p.to === h.to || p.from === h.to`; the source appears as
  `path[0].from` once path is nonempty).
- Cost accumulates as repeated f64 subtraction of `Math.log(gamma * h.weight)`
  in path order; `m = Math.exp(-cost)` at the end (NOT the product of weights —
  exp/log round-trip differences are part of the certified values).

### scoreCandidate(hops, viewer, target, certCount, cfg)

```js
const banned = new Set();  const usedHops = new Set();  const paths = [];
for (let i = 0; i < cfg.k; i++) {
  const p = strongestPath(hops, viewer, target, banned, usedHops, cfg.gamma);
  if (!p || p.m < cfg.chi) break;                       // dust floor χ, STRICT <
  const balance = p.hops.reduce((s, h) => s * h.pdSign, 1);   // ∏ sgn(p̄_d)
  const tainted = p.hops.some(h => h.piNegative);             // absorbing taint
  const sigma = balance > 0 && !tainted ? 1 : -1;
  const terminal = p.hops[p.hops.length - 1];
  const dt = Math.max(0, certCount - terminal.epoch);
  const f = cfg.halfLifeEpochs === Infinity ? 1 : Math.pow(0.5, dt / cfg.halfLifeEpochs);
  paths.push({ ..., term: sigma * p.m * f });                 // (sigma * m) * f
  for (const n of p.nodes.slice(1, -1)) banned.add(n);        // delete INTERIOR only
  for (const h of p.hops) usedHops.add(h.key);
}
return { S: paths.reduce((s, p) => s + p.term, 0), paths };   // extraction-order sum
```

### cograRank(graph, viewer, certCount, opts)

```js
const cfg = { ...COGRA_DEFAULTS, ...(opts.cfg ?? {}) };
const hops = buildHops(graph, opts);
const wanted = opts.candidates ?? (n => n.kind === 'Content');
for (const node of graph.nodes.values()) {            // NODE MAP INSERTION ORDER
  if (!wanted(node)) continue;
  const { S, paths } = scoreCandidate(hops, opts.personOf(viewer), node.id, certCount, cfg);
  if (paths.length === 0) continue;                   // unreachable → absent
  out.push({ node, S, paths });
}
out.sort((a, b) => b.S - a.S);                        // STABLE sort; equal S keeps node order
```

## 12. community.ts — Louvain over the folded undirected graph

### Csr structure

```
n: node count
off: Int32Array(n+1)  — row start offsets
nbr: Int32Array(total) — neighbor index per slot
wgt: Float64Array(total) — link weight per slot
deg: Float64Array(n)  — weighted degree (self-loops counted TWICE)
m2: number            — Σ deg = 2m
```
Rust: `Vec<i32>` / `Vec<f64>` (or usize); keep f64 for wgt/deg/m2.

### Pair-key encoding

An undirected pair (a, b), a ≤ b indices, is keyed `lo * n + hi` in a
`Map<number, number>` accumulator. Decode: `lo = Math.floor(key / n)`,
`hi = key % n`. **f64 hazard**: keys are JS numbers; for n up to ~94M keys stay
exact integers in f64 — port with u64/usize arithmetic (`lo * n + hi` exact),
which matches as long as JS never exceeded 2^53 (it doesn't at this scale).

### csrFrom(n, acc)

```js
const keys = Array.from(acc.keys()).sort((x, y) => x - y);   // NUMERIC ascending — canonical order
// counts pass: self-pair (lo === hi) counts 1 slot, others 1 slot per endpoint
// off = prefix sums; cursor = off.slice
// fill pass, in sorted-key order:
//   self: nbr[cursor[lo]] = lo; wgt = w; deg[lo] += 2*w; m2 += 2*w
//   else: both directions stored; deg[lo] += w; deg[hi] += w; m2 += 2*w
```
Note the sort is on the keys array — Map iteration order is discarded here
(deliberately: "never derived from object key enumeration"). Because slots are
filled in ascending key order, each row's neighbor list is sorted ascending
too — `oneLevel`'s `touched` encounter order depends on this before its
explicit sort.

`m2` accumulation order = sorted-key order (float-relevant).
`deg[i]` accumulation order = sorted-key order restricted to keys touching i.

### fold(nodes, edges, personOf)

```js
// index: first-appearance order over `nodes` array of personOf(node.id)
for (const node of nodes) { pid = personOf(node.id); if new → index.set(pid, ids.length), ids.push(pid); }

// accumulate undirected weights, EDGES ARRAY ORDER:
for (const e of edges) {
  if (!(e.weight > 0)) continue;            // NOTE: skips weight <= 0 AND NaN (unlike traversal.ts)
  const a = index.get(personOf(e.src));
  const b = index.get(personOf(e.tgt));
  if (a === undefined || b === undefined || a === b) continue;  // self-pairs dropped
  key = min*n + max;  acc.set(key, (acc.get(key) ?? 0) + e.weight);   // parallel acts sum, edge order
}
// links[i]: count of incident folded links, over acc.keys() (Map insertion order — counts only)
```

### oneLevel(g) — the determinism-critical inner loop

```js
com[i] = i;  ktot[i] = deg[i];                        // every node its own community
linkW = Float64Array(n);                              // dense scratch, zeroed between nodes

for (pass = 0; pass < MAX_PASSES /*20*/; pass++) {
  moved = 0;
  for (i = 0; i < n; i++) {                           // RULE 1: index order (= first-appearance)
    ci = com[i];
    touched = [];
    for (t = off[i]; t < off[i+1]; t++) {             // CSR slot order (ascending neighbor)
      c = com[nbr[t]];
      if (linkW[c] === 0) touched.push(c);            // exact-zero occupancy test
      linkW[c] += wgt[t];                             // includes self-loop slot (c = com[i])
    }
    if (linkW[ci] === 0) touched.push(ci);            // incumbent always a candidate
    touched.sort((x, y) => x - y);                    // RULE 2: ascending community index

    ktot[ci] -= deg[i];                               // remove i before scoring
    best = ci;
    bestGain = linkW[ci] - (ktot[ci] * deg[i]) / m2;  // incumbent seeded as best
    for (const cc of touched) {                       // ascending index (incumbent included, re-scored — equal, no move)
      gain = linkW[cc] - (ktot[cc] * deg[i]) / m2;
      if (gain > bestGain + EPS /*1e-12*/) { bestGain = gain; best = cc; }   // RULE 3: strict
    }
    ktot[best] += deg[i];
    if (best !== ci) { com[i] = best; moved++; }
    for (const c of touched) linkW[c] = 0;            // reset scratch
  }
  if (!moved) break;
}
return com;
```
Gain expression: `linkW[cc] - ((ktot[cc] * deg[i]) / m2)` — one multiply, one
divide, one subtract, in that order.

### compact(com)

Renumber to 0..k−1 by first appearance (index order). Returns `{ com, count }`.

### aggregate(g, com, count)

```js
for (i = 0; i < g.n; i++) {                 // node index order
  a = com[i];
  for (t = off[i]; t < off[i+1]; t++) {     // slot order
    b = com[nbr[t]];
    key = min(a,b)*count + max(a,b);
    acc.set(key, (acc.get(key) ?? 0) + g.wgt[t] / 2);   // halve: each undirected link visited from both rows
  }
}
return csrFrom(count, acc);
```
Every level re-collapses the ORIGINAL folded csr by the current partition
(never aggregates the aggregate) — see `communities` below.

### modularity(g, com, count)

```js
if (g.m2 <= 0) return 0;
// per node index order: totW[com[i]] += deg[i];
//   per slot: if (com[nbr[t]] === com[i]) inW[com[i]] += wgt[t];
q = 0;
for (c = 0; c < count; c++) {
  tc = totW[c] / m2;
  q += inW[c] / m2 - tc * tc;               // ((inW/m2) - (tc*tc)), accumulated in c order
}
```
Self-loops: stored once in CSR, visited once → inW gets w (but deg got 2w) —
matches Σin convention with the aggregate()'s halving.

### canonicalise(com, count, ids)

```js
// sizes[c]: member counts; minId[c]: lexicographically smallest member id (JS string <)
order = [0..count).sort((a, b) => {
  if (sizes[b] !== sizes[a]) return sizes[b] - sizes[a];   // larger first
  return minId[a] < minId[b] ? -1 : minId[a] > minId[b] ? 1 : 0;  // then smallest member id
});
// rank[c] = position in order; out[i] = rank[com[i]]; sizes remapped to order
```

### communities(nodes, edges, personOf = id => id) — orchestration

```js
{ csr, ids, links } = fold(...);
strength[id] = csr.deg[i];  linkCount[id] = links[i];    // built in index order
if (n === 0 || csr.m2 <= 0) → every node its own community (of[id] = i), sizes all 1, q = 0, count = n;

part = compact(oneLevel(csr));                            // level 0 on real nodes
for (level = 0; level < MAX_LEVELS /*10*/ && part.count > 1; level++) {
  agg = aggregate(csr, part.com, part.count);             // ALWAYS from the original csr
  if (!agg.m2) break;
  lifted = compact(oneLevel(agg));
  if (lifted.count === part.count) break;                 // nothing merged; settled
  raised[i] = lifted.com[part.com[i]];
  part = compact(raised);
}
q = modularity(csr, part.com, part.count);                // on the ORIGINAL csr
canon = canonicalise(part.com, part.count, ids);
of[id] = canon.com[i];
return { of, sizes: canon.sizes, strength, links: linkCount, q, count: part.count };
```
NOTE (verbatim quirk): the returned `count` is `part.count` (pre-canonicalise),
and `q` is computed on the pre-canonicalise labels — identical numerically since
canonicalise only permutes labels, but keep the call order.
`of`/`strength`/`links` are `Object.create(null)` records — in Rust just maps;
their key order is never iterated by the engine.

No randomness, no wall-clock anywhere. Bounds: MAX_LEVELS = 10, MAX_PASSES = 20,
EPS = 1e-12.

## 13. fixtures.ts — certified reference data

### referenceGraph()

Nodes (insertion order):
```
alice/Actor 'Alice', bob/Actor 'Bob', carol/Actor 'Carol', dave/Actor 'Dave',
profA/Profile 'Profile_A', photo/Content 'Photo', comment/Comment 'Comment',
streetart/Type 'StreetArt', sneakers/Item 'Sneakers'
```
Edges via `g.append` (sequential — the fixture deliberately matures e3→e4
sequentially even though a normative Review is a hyper act):
```
e1  SelfDeclaration alice→profA   pd=1.0 pi=0.75
e1r SelfReputation  profA→alice   pd=1.0 pi=0.75
e2  Opinion         alice→photo   pd=0.9 pi=0.7
e3  ReviewA         bob→photo     pd=0.7 pi=0.8
e4  ReviewT         photo→comment pd=0.8 pi=0.7
e5  TagA            carol→comment pd=0.8 pi=0.9
e6  TagT            comment→streetart pd=0.9 pi=0.8
e7  Affinity        alice→streetart   pd=0.6 pi=0.8
e8  Owner           bob→sneakers      pd=0.7 pi=1.0
```
τ values follow the pre-degree formula from this exact order.

### REFERENCE_SEEDS
```
alice: burnBal 3, actCount 10
bob:   burnBal 2, actCount 8
carol: burnBal 4, actCount 12
dave:  burnBal 1, actCount 5
```

### REFERENCE_CREATORS
`{ photo: 'alice', comment: 'bob', streetart: 'carol', sneakers: 'bob' }`

### REFERENCE_EPOCH
```
ledgers (order matters — index-aligned with expectedX):
  alice 1.2944/12, bob 1.2472/11, carol 1.1472/10, dave 0.2/2, eve 0.9/8
cells (array order):
  alice→bob 0.8638, alice→carol 0.635, alice→eve 0.3969,
  bob→carol 0.7742, bob→dave 0.6841, bob→eve 0.5062,
  carol→dave 0.8085, carol→eve 0.7329, dave→eve 0.772
deltaActs (Map insertion order): alice 2, bob 1, carol 1, dave 2, eve 0
expectedX = [1.0786557, 1.1051839, 1.1201615, 1.1159692, 1.1171834]  // tilt = 1
expectedEpochStamp = 1.102
expectedHeadroom   = 0.615
```
These are the certified equilibrium probes for solveStanding + evaluateGates
(expected values are rounded for display; the solver itself converges to
tol = 1e-13).

---

## Appendix A — iteration-order sensitivity index (quick audit list)

| Site | Order that is law |
|---|---|
| `frobenius` | row-major element sum |
| `sentimentSlice`/`pathView` | fixed expressions, no loops |
| `RawGraph.edges` | append order; `appendIndex` = position |
| `RawGraph.nodes` | Map insertion order (re-add keeps position) |
| `appendHyper` | tauA, tauT from shared pre-state; push A then T; bump aSrc, aTgt, tSrc, tTgt |
| `hopDistance`/`doubleCoverBFS` | full edge scan per depth layer, append order (values order-independent due to max/first-arrival; map orders are not) |
| `contentNorm` | incoming-edge order (append) for pd/pi mean sums |
| `rankFeed` | nodes Map order pre-sort; stable sort by relevance desc |
| `baseScoreMatrix` | cells array order for `+=` |
| `hopMatrix` | j-ascending row sums, then in-place normalize |
| `matMul` | i-k-j; k-ascending accumulation into out[i][j]; `aik === 0` skip |
| `transport` | m = 1..4; product left-associated; mass-mix accumulation i, j ascending |
| `solveStanding` | u-ascending num/den sums; residual via Math.max spread; pi recomputed at loop top |
| `evaluateGates` | ledger order for mSum/stampSum/headroom |
| `foldBundles` | append order accumulation; Map-insertion-order finalize |
| `buildHops` | append-order partition; bundles.values() order; tLegs order; per-person hop-list push order |
| `strongestPath` | queue insertion order + linear min-scan with (1e-15, key-string) tiebreak; neighbor expansion in hop-list order |
| `scoreCandidate` | extraction order sum for S |
| `cograRank` | nodes Map order; stable sort by S desc |
| `csrFrom` | numerically sorted pair keys — canonical; deg/m2 sums in that order |
| `fold` (community) | nodes array first-appearance; edges array accumulation |
| `oneLevel` | node index order; touched sorted ascending; strict-gain EPS rule |
| `aggregate` | node index × slot order, wgt/2 accumulation |
| `modularity` | node/slot order for inW/totW; c-ascending q sum |
| `canonicalise` | sort comparator (size desc, minId asc) |
| `AttestationLedger.closeCycle` | escrow array order; balances Map order at maturity |
| `canValue` | index-ascending mix sum |

## Appendix B — mutable state & reset summary

| Object | State | Lifetime/reset |
|---|---|---|
| `RawGraph` | nodes Map, edges Vec, preDeg Map | grows only; new instance per replay |
| `AttestationLedger` | omega, yLive, yLock, cycle, settledFloor, escrow, balances | escrow cleared inside closeCycle iff dOmega > 0; settledFloor recommitted every closeCycle; maturity relabel fires once when cycle === maturityCycle |
| standing.ts `Q1` | module-level `Q(1)` | computed once at load; port as lazy-static using the SAME Q code path |
| Everything else | pure functions / fresh locals | n/a |

## Appendix C — JS semantics traps checked

- `??` sites honoring falsy-but-present values: `tauOverride ?? …` (0 honored),
  `input.epoch ?? 0`, `e.epoch ?? 0`, `deltaActs.get(id) ?? 0`,
  `idx.get(rcp) ?? u`, `childValues[i] ?? 0`, `hops.get(node) ?? []`,
  `opts.cfg ?? {}`, `personOf` default param.
- Truthy tests (NOT nullish): `spec?.signForced ? 1 : detSign(pv)`,
  `creator ? 1 + standing/NU : 1` (empty-string creator → amplifier 1),
  `author && creator && …`, `if (!agg.m2) break` (m2 === 0 → break).
- `detSign`: `det >= 0 ? 1 : -1` — −0 maps to +1.
- `Math.sign(x) || 1`: ±0 → 1.
- `b.pd === 0` after clip: exact float equality including −0.
- `halfLifeEpochs === Infinity` exact compare (f64 infinity).
- String comparisons: cogra `keys` tiebreaks and community `minId` use JS `<`
  on strings = UTF-16 code-unit order; ASCII ids ⇒ byte order in Rust matches.
  If ids can contain non-ASCII, compare by UTF-16 code units, not bytes.
- Weight admissibility differs by module: traversal skips `weight <= 0`;
  cogra push skips `weight <= 0`; community skips `!(weight > 0)` (also NaN).
- Errors: AttestationLedger ops throw `Error` with the exact messages
  'insufficient reserve' / 'insufficient live units' / 'insufficient units';
  replay wraps calls in try/catch (`l0safe`), so throwing must not corrupt
  prior state (all guards run before any mutation — keep that ordering).
