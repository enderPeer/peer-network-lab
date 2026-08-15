# Engine API surface — porting map (bundle exports + consumed surface)

Source of truth: `C:/Users/User/Desktop/ToRuleThemAll/webapp/src/engine/*.ts`, bundled via
`bundle-entry.ts` as the browser global `window.PeerEngine` (referred to as `E` by
`webapp/social/replay.cjs`). `bundle-entry.ts` is a pure re-export barrel:

```ts
export * from './constants';
export * from './kernels';
export * from './tensor';
export * from './families';
export * from './graph';
export * from './traversal';
export * from './feed';
export * from './standing';
export * from './attestation';
export * from './can';
export * from './cogra';
export * from './community';
export * from './fixtures';
```

Everything below is therefore a public export of the bundle.

---

## 1. constants.ts — exported constants (exact defining expressions)

The *expressions* are law; the port must compute them the same way in f64, not
paste rounded decimals (except where the source itself is a literal).

| Export | Defining expression (verbatim) | Value notes |
|---|---|---|
| `BETA` | `2 * Math.log(2)` | ≈ 1.3862943611198906. `Math.log(2)` then doubled (exact ×2 in f64). |
| `ETA` | `0.05` | literal |
| `HALF_FLOOR` | `Math.sqrt(ETA)` | ≈ 0.22360679774997896 (IEEE sqrt, exact-rounded) |
| `NU` | `0.1` | literal |
| `THETA` | `0.0528066` | literal |
| `SAFE_FLOOR` | `THETA / NU` | ≈ 0.528066 (one f64 division of the two literals) |
| `POL_FLOOR` | `1` | literal |
| `PART_FLOOR` | `Math.max(POL_FLOOR, SAFE_FLOOR)` | = 1 (since SAFE_FLOOR < 1) |
| `HOP_MAX` | `4` | integer |
| `FEED_DEPTH` | `4` | integer |
| `ACT_EXPONENT` | `0.25` | literal (chartered; NOT derived from HOP_MAX) |
| `TILT_SHAPE` | `[1, 0.5, 0.25, 0.125] as const` | readonly 4-tuple |
| `DEPTH_MASS` | `[0.5, 0.25, 0.125, 0.125] as const` | readonly 4-tuple, sums to 1 |
| `KAPPA_SELF` | `1` | literal |
| `OMEGA_DOMAIN` | `1` | literal (exported but referenced nowhere in engine code — comment-only "ω_D = 1 uniform reference") |

## 2. kernels.ts — exported functions

```ts
export function sigmoid(x: number): number        // 1 / (1 + Math.exp(-x))
export function fpl(x: number): number            // sigmoid(BETA * x)
export function fpm(x: number): number            // sigmoid(BETA * Math.abs(x)) * Math.tanh(x)
export function binaryEntropy(t: number): number  // 0 if t<=0 || t>=1, else -t*Math.log(t) - (1-t)*Math.log(1-t)
export function boltzmann(tau: number): number    // Math.exp(-BETA * binaryEntropy(tau))
export function coherence(tau: number): number    // Math.sqrt(1 + tau*tau)
```

## 3. tensor.ts — exported types, constants, functions

Types:
```ts
export type Mask = readonly [number, number, number, number];  // (a00,a01,a10,a11)
export type Domain = 'Tribal' | 'Identity' | 'Epistemic' | 'Economic' | 'Relational' | 'Minimal';
export type Tier = 'full' | 'half' | 'marginal';
export type Mat3 = number[][];
export type Mat2 = number[][];
```

Constant:
```ts
export const DOMAIN_MASKS: Record<Domain, Mask> = {
  Tribal:     [1, 1, 1, 1],
  Identity:   [1, 0, 0, 1],
  Epistemic:  [0, 1, 0, 1],
  Economic:   [0, 0, 1, 1],
  Relational: [0, 0, 1, 1],
  Minimal:    [0, 0, 0, 1],
};
```

Functions:
```ts
export function sentimentSlice(pd: number, pi: number, mask: Mask): Mat3
export function frobenius(m: number[][]): number
export function pathView(pd: number, pi: number, mask: Mask, tier: Tier): Mat2
export function det2(m: Mat2): number
export function detScore(pv: Mat2): number          // Math.sqrt(Math.abs(det2(pv)))
export function detSign(pv: Mat2): number           // det2(pv) >= 0 ? 1 : -1
export function singularValues2(m: Mat2): [number, number]
export function dampedWeight(score: number, tau: number): number  // score * coherence(tau) * boltzmann(tau)
```

## 4. families.ts — exported interface + registry

```ts
export interface FamilySpec {
  family: string;
  domain: Domain;
  promoted: boolean;          // promoted => stored mask is (1,1,1,1) regardless of domain
  tier: Tier;
  paramLabels: [string, string];
  signForced: boolean;        // det_sign forced +1
  vouchCandidate: boolean;
}
export const FAMILIES: Record<string, FamilySpec>
```

Full registry (family: domain / promoted / tier / signForced / vouchCandidate / paramLabels):

| family | domain | promoted | tier | signForced | vouchCandidate | paramLabels |
|---|---|---|---|---|---|---|
| Opinion | Tribal | false | full | false | **true** | ['polarity p', 'reaction r'] |
| Affinity | Epistemic | false | marginal | false | false | ['association a', 'attraction t'] |
| Owner | Economic | **true** | full | false | false | ['attachment a', '(fixed 1)'] |
| Publish | Economic | **true** | full | false | false | ['attachment a', '(fixed 1)'] |
| Participant | Relational | **true** | full | false | false | ['interactivity i', 'responsibility r'] |
| Registration | Identity | false | full | **true** | false | ['(fixed 1)', '(fixed 1)'] |
| SelfDeclaration | Identity | false | full | false | false | ['(fixed 1)', 'bond p_i'] |
| SelfReputation | Identity | false | full | false | false | ['(fixed 1)', 'bond p_i'] |
| JoinRequest | Relational | **true** | **half** | false | false | ['urgency u', 'formality f'] |
| Accept | Relational | **true** | **half** | false | **true** | ['comfort c', 'equity e'] |
| Ratify | Relational | **true** | **half** | false | **true** | ['comfort c', 'equity e'] |
| ReviewA | Tribal | false | full | false | false | ['enthusiasm e', 'effort f'] |
| ReviewT | Epistemic | false | marginal | false | false | ['effort f', 'enthusiasm e'] |
| SendA | Relational | **true** | full | false | false | ['directness d', 'intensity i'] |
| SendT | Minimal | false | marginal | false | false | ['intensity i', 'directness d'] |
| ReferenceA | Epistemic | false | marginal | false | false | ['endorsement e', 'fidelity f'] |
| ReferenceT | Tribal | false | full | false | false | ['fidelity f', 'endorsement e'] |
| TagA | Epistemic | false | marginal | false | false | ['relevance r', 'confidence c'] |
| TagT | Epistemic | false | marginal | false | false | ['confidence c', 'relevance r'] |
| Control | Minimal | false | marginal | **true** | false | ['(fixed 1)', '(fixed 1)'] |

## 5. graph.ts — exported types + class

```ts
export type NodeKind = 'Actor' | 'Profile' | 'Content' | 'Comment' | 'Type'
                     | 'Item' | 'Chat' | 'Offer' | 'Message';

export interface NodeInfo { id: string; kind: NodeKind; label: string; }

export interface EdgeInput {
  id: string; family: string; src: string; tgt: string;
  pd: number; pi: number;
  domain?: Domain;        // override family domain
  tier?: Tier;            // override family tier
  tauOverride?: number;   // fix τ instead of pre-degree derivation
  epoch?: number;         // default 0
}

export interface EdgeRecord {
  id: string; family: string; src: string; tgt: string;
  pd: number; pi: number;
  domain: Domain; mask: Mask; tier: Tier;
  tau: number; epoch: number;
  slice: Mat3; pv: Mat2;
  frob: number; score: number; sign: number; weight: number;
  appendIndex: number;
}

export class RawGraph {
  // public mutable state
  nodes = new Map<string, NodeInfo>();
  edges: EdgeRecord[] = [];
  // private mutable state
  private preDeg = new Map<string, number>();

  addNode(node: NodeInfo): this
  degree(nodeId: string): number
  private buildRecord(input: EdgeInput, tau: number): EdgeRecord
  private bump(nodeId: string, by = 1): void
  append(input: EdgeInput): EdgeRecord
  appendHyper(aLeg: EdgeInput, tLeg: EdgeInput): [EdgeRecord, EdgeRecord]
  outgoing(nodeId: string): EdgeRecord[]
  incoming(nodeId: string): EdgeRecord[]
}
```

Non-exported module helper: `resolveMask(family, domain): Mask` (promoted → Tribal mask, else `DOMAIN_MASKS[domain]`).

## 6. traversal.ts

```ts
export interface CoverRegisters { pos: number; neg: number; }
export function hopDistance(graph: RawGraph, sourceId: string, depth = FEED_DEPTH): Map<string, number>
export function doubleCoverBFS(graph: RawGraph, sourceId: string, depth = FEED_DEPTH): Map<string, CoverRegisters>
```

## 7. feed.ts

```ts
export interface FeedEntry {
  node: NodeInfo; bfsWeight: number; amplifier: number;
  contentNorm: number; relevance: number;
}
export function contentNorm(graph: RawGraph, nodeId: string): number
export function rankFeed(
  graph: RawGraph, viewerId: string,
  standingOf: (actorId: string) => number,
  creatorOf: (nodeId: string) => string | null,
): FeedEntry[]
```

Non-exported: `const STANCE_FAMILIES = new Set(['Opinion', 'Publish'])` (ReviewA deliberately excluded — Appendix F content norm 1.798 certification).

## 8. standing.ts

```ts
export interface Ledger { id: string; burnBal: number; actCount: number; }
export interface FoldCell { src: string; rcp: string; coeff: number; }

export function refRate(l: Ledger): number      // l.burnBal / Math.max(l.actCount, 1) / NU
export function emission(l: Ledger): number     // Math.min(1, refRate(l) / SAFE_FLOOR)
export function mobius(x: number): number       // x / (1 + x)
export function Q(p: number): number            // sigmoid(BETA*p) * Math.sqrt(t*(1 - ETA*ETA*t)), t = Math.tanh(p)
export function vouchAct(x: number): number     // x<=0 ? 0 : Math.pow(Q(mobius(x))/Q1, ACT_EXPONENT)
export function wallAct(x: number): number      // vouchAct(Math.max(x, SAFE_FLOOR))
export function baseScoreMatrix(ids: string[], cells: FoldCell[]): number[][]
export function transport(base: number[][], x: number[], emissions: number[], tilt: number): number[][]

export interface SolveResult {
  ids: string[]; x: number[]; pi: number[][];
  iterations: number; residual: number; trace: number[][];
}
export function solveStanding(
  ledgers: Ledger[], cells: FoldCell[],
  opts: { tilt?: number; maxIter?: number; tol?: number } = {},
): SolveResult    // defaults tilt=1, maxIter=200, tol=1e-13

export interface GateReport {
  w1: { id: string; burnBal: number; pass: boolean }[];
  w2a: { id: string; stamp: number; pass: boolean }[];
  epochStamp: number; headroom: number; w2bPass: boolean; allPass: boolean;
}
export function evaluateGates(ledgers: Ledger[], x: number[], deltaActs: Map<string, number>): GateReport
export function debitAct(l: Ledger): Ledger     // { ...l, burnBal: l.burnBal - THETA, actCount: l.actCount + 1 }
```

Non-exported module state: `const Q1 = Q(1)` (computed once at module load) and
`function hopMatrix(base, x, hop, tilt)` and `function matMul(a, b)`.

## 9. attestation.ts

```ts
export interface L0Config { E0: number; zeta: number; fee: number; maturityCycle: number; }
export const L0_DEFAULTS: L0Config = { E0: 100, zeta: 0.5, fee: 0.5, maturityCycle: 10 };
export interface L0Balance { reserve: number; live: number; tlock: number; attest: number; }
export const OPERATOR = 'op';

export class AttestationLedger {
  cfg: L0Config;
  omega: number;
  yLive = 0;
  yLock = 0;
  cycle = 0;
  settledFloor = 1;
  escrow: { addr: string; amount: number }[] = [];
  balances = new Map<string, L0Balance>();

  constructor(cfg: Partial<L0Config> = {})
  bal(addr: string): L0Balance
  get totalSupply(): number            // yLive + yLock
  floor(): number                      // totalSupply > 0 ? omega / totalSupply : 1
  get bootstrapping(): boolean         // cycle < cfg.maturityCycle
  get attestCap(): number              // cfg.E0 * Math.log(1 / (1 - cfg.zeta))
  faucet(addr: string, amount: number): void
  deposit(addr: string, delta: number): void          // throws 'insufficient reserve'
  burn(addr: string, x: number, favor = addr): number // throws 'insufficient live units'; returns x * settledFloor
  redeem(addr: string, x: number): number             // throws 'insufficient live units'; returns payout
  transfer(from: string, to: string, x: number, cls: 'live' | 'tlock' = 'live'): void // throws 'insufficient units'
  closeCycle(): { minted: number; floor: number }
}
```

## 10. can.ts

```ts
export interface CanNode { childNorms: number[]; childValues: number[]; }
export function transmission(childNorms: number[]): number      // m/(1+m), m = mean; 0 for empty
export function dependencyWeights(childNorms: number[]): number[] // n_i / sum, 0s if sum<=0
export function canValue(node: CanNode): number                 // transmission * Σ w_i * childValues[i]
```

## 11. cogra.ts

```ts
export interface CograConfig { k: number; gamma: number; chi: number; halfLifeEpochs: number; }
export const COGRA_DEFAULTS: CograConfig = { k: 5, gamma: 1, chi: 1e-4, halfLifeEpochs: 4 };

export interface Hop {
  from: string; to: string; weight: number;
  pdSign: number; piNegative: boolean; epoch: number; key: string;
}
export interface CograPath {
  nodes: string[]; hops: Hop[]; m: number; sigma: number; f: number; term: number;
}
export interface CograScore { node: NodeInfo; S: number; paths: CograPath[]; }

// BuildOpts (interface NOT exported, but part of the callable surface):
//   { personOf: (nodeId: string) => string; creatorOf: (nodeId: string) => string | null }

export function buildHops(graph: RawGraph, opts: BuildOpts): Map<string, Hop[]>
export function scoreCandidate(
  hops: Map<string, Hop[]>, viewer: string, target: string,
  certCount: number, cfg: CograConfig = COGRA_DEFAULTS,
): { S: number; paths: CograPath[] }
export function cograRank(
  graph: RawGraph, viewer: string, certCount: number,
  opts: BuildOpts & { candidates?: (n: NodeInfo) => boolean; cfg?: Partial<CograConfig> },
): CograScore[]
```

Non-exported module constants:
`NEVER_TRAVERSED = new Set(['SelfDeclaration','SelfReputation','Registration','Control'])`,
`T_LEGS: Record<string,string> = { ReviewT: 'ReviewA', TagT: 'TagA', ReferenceT: 'ReferenceA' }`,
plus helpers `clip`, `foldedWeight`, `foldBundles`, `strongestPath`.

## 12. community.ts

```ts
export interface CommunityNode { id: string; }
export interface CommunityEdge { src: string; tgt: string; weight: number; }
export interface CommunityResult {
  of: Record<string, number>;
  sizes: number[];
  strength: Record<string, number>;
  links: Record<string, number>;
  q: number;
  count: number;
}
export function communities(
  nodes: CommunityNode[], edges: CommunityEdge[],
  personOf: (id: string) => string = (id) => id,
): CommunityResult
```

Non-exported: `MAX_LEVELS = 10`, `MAX_PASSES = 20`, `EPS = 1e-12`, interface `Csr`,
helpers `csrFrom`, `fold`, `oneLevel`, `compact`, `aggregate`, `modularity`, `canonicalise`.

## 13. fixtures.ts

```ts
export function referenceGraph(): RawGraph
export const REFERENCE_SEEDS: Ledger[]
export const REFERENCE_CREATORS: Record<string, string>
export const REFERENCE_EPOCH: {
  ledgers: Ledger[]; cells: FoldCell[]; deltaActs: Map<string, number>;
  expectedX: number[]; expectedEpochStamp: number; expectedHeadroom: number;
}
```

(Exact fixture contents are reproduced in engine-internals.md §13.)

---

## Consumed surface — what replay.cjs actually calls

`webapp/social/replay.cjs` receives the bundle as `E` (UMD `create(E)`). Every
`E.` reference in the file (grep `\bE\.` — 7 hits):

| Line | Reference | Use |
|---|---|---|
| 17 | `E.THETA`, `E.NU` | destructured to local `THETA`, `NU` (act pricing, DM gate `burnBal >= THETA`, various displays) |
| 59 | `E.solveStanding(snapLedgers, cells, { tilt: 1 })` | epoch-close snapshot solve |
| 60 | `E.evaluateGates(snapLedgers, sv.x, snapDmap)` | epoch-close gate check |
| 119 | `new E.RawGraph()` | the replayed graph |
| 190 | `new E.AttestationLedger({ E0: 0, zeta: 0.5, fee: 0.5, maturityCycle: 10 })` | Layer 0 ledger — **constructed but retired**: the `deposit`/`burnL0`/`redeem`/`transferL0`/`closeCycle` act branches in replay.cjs are deliberate no-ops ("Layer 0 is retired"); the instance is exposed as `state.l0` for the template's read-only L0 panel |
| 2513 | `E.solveStanding(ledgers, cells, { tilt: 1 })` | final standing solve of the whole replay |

So the full consumed export surface via `E.` is exactly:
**`THETA`, `NU`, `solveStanding`, `evaluateGates`, `RawGraph` (constructor), `AttestationLedger` (constructor)**.

Member-level usage on those instances inside replay.cjs:

- `RawGraph`: `g.addNode(...)`, `g.append(...)`, `g.appendHyper(aLeg, tLeg)`, `g.nodes.get(...)` / `g.nodes` reads, `g.edges` reads. (`degree`, `outgoing`, `incoming` are NOT called by replay.cjs; `outgoing`/`incoming` are used by feed.ts internally — `incoming` — and by UI code.)
- `AttestationLedger`: constructor only in replay.cjs; the template (`social/template.html` / built `public/peer-social-preview.html`) reads `l0.bal(...)`, `l0.escrow`, `l0.omega`, `l0.yLive`, `l0.yLock`, `l0.floor()`, `l0.settledFloor`, `l0.cycle`, `l0.bootstrapping`, `l0.attestCap`, `l0.balances` — read-only display. With `E0: 0` the constructor gives `omega = 0`, `yLive = 0`, `yLock = 0`, `floor() = 1` (totalSupply 0 branch), `attestCap = 0`.
- `solveStanding` result: `.x`, `.ids` consumed (`solved.ids.forEach((id,i) => xById[id] = solved.x[i])`).
- `evaluateGates` result: consumed as the epoch record's gate report.

Everything else in the bundle (kernels, tensor, families, traversal, feed, cogra,
community, can, fixtures, remaining constants) is exported and consumed by the
webapp UI/tests/tester artifact, not by replay.cjs. For byte-parity of `replay`
output only the consumed surface above matters, but the port should keep the whole
surface because the template and tests link against the same bundle.
