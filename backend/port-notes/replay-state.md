# replay.cjs — state map for the Rust port

Source: `webapp/social/replay.cjs` (2639 lines, UMD wrapper). All line numbers below refer to that file as read on 2026-08-14.

Module shape: `create(E)` (line 16) closes over the engine `E`, capturing `var THETA = E.THETA, NU = E.NU;` (line 17). It returns `{ replay: replayUncached, parseMentions: parseMentions }` (line 2635). `replayUncached(acts)` (lines 118–2633) is the pure fold this document maps.

Engine surface used (the seam the Rust engine crate must provide):

- `new E.RawGraph()` — `g.addNode({id, kind, label})`, `g.append({id, family, src, tgt, pd, pi, epoch?, tauOverride?})` (returns the edge record; `.tau` and `.weight` are read in the `opinion` chron line), `g.appendHyper(edgeA, edgeT)`, `g.nodes.get(id)`, `g.edges` (array; `.length` read for `edgeAct` fill).
- `E.solveStanding(ledgers, cells, { tilt: 1 })` → `{ ids: [..], x: [..], ... }`.
- `E.evaluateGates(snapLedgers, x, dmapMap)` → `{ epochStamp, headroom, allPass, ... }`.
- `new E.AttestationLedger({ E0: 0, zeta: 0.5, fee: 0.5, maturityCycle: 10 })` (line 190) — constructed, **never mutated**, returned as `l0`.
- `E.THETA` (act cost), `E.NU` (self-edge bond constant).

`bare()` (line 116) = `Object.create(null)` — a prototype-less map. **Every** map whose keys come from the log is `bare()`; this is a security property (see the `pools['constructor']` comment, lines 97–115). In Rust every `bare()` map becomes `IndexMap<String, _>` (insertion-ordered) unless noted otherwise below; the guard property comes for free.

JS object key-order rule that matters for parity: plain JS objects iterate **integer-like keys first, in ascending numeric order, then string keys in insertion order**. Every map keyed by act index or epoch number (`actContent`, `deletedPostIdx`, `addrAtEpoch`) therefore serializes/iterates in ascending numeric order → use `BTreeMap<u64, _>` for those. All other maps have non-numeric keys (`u_xxx`, `c12`, `0x…`, `id@epoch`, `A/B`) → `IndexMap<String, _>`.

---

## 1. Constants (all inside `replayUncached` unless noted)

| name | value | line |
|---|---|---|
| `SEED_POSTS` | `{ photo: 'Street shot from the underpass — first light.', comment: 'Grain placement is deliberate. This holds up.' }` | 19–22 (create scope) |
| `FAUCET_PER_EPOCH` | `8` | 170 |
| `FAUCET_CAP_FROM_EPOCH` | `62` | 171 |
| `TBTC_FAUCET_CLOSED_FROM` | `62` (dead — btcClaim always refused) | 174 |
| `RAW_INT` | `/^[0-9]{1,48}$/` | 242 |
| `BIG0` | `BigInt(0)` | 243 |
| `TOK_EPOCH` | `5000` | 624 |
| `TOK_DECAY` | `0.9` | 624 |
| `TOK_YEAR` | `365` | 624 |
| `TOK_CAP` | `18250000` | 624 |
| `TOK_DIM` | `0.3` | 625 |
| `TOK_SAT_UNIT` | `1000` | 630 |
| `SATS_PER_RESERVE` | `100` | 633 |
| `PEER_BURN_TWAP_MS` | `30 * 60 * 1000` | 689 |
| `PEER_BURN_TWAP_OBS` | `12` | 690 |
| `PEER_BURN_GRID` | `16` | 698 |
| `PEER_BURN_MIN_POOL_SATS` | `1000000` | 705 |
| `PEER_BURN_RESERVE_PER_EPOCH` | `100` | 717 |
| `PEER_BURN_SATS_PER_EPOCH` | `PEER_BURN_RESERVE_PER_EPOCH * SATS_PER_RESERVE` (= 10000) | 723 |
| `PEER_BURN_CAP_FROM_EPOCH` | `0` | 747 |
| `PEER_BURN_ADDR` | `'0x000000000000000000000000000000000000dead'` (lowercase) | 764 |
| `TBTC_CLAIM` | `0.01` | 807 |
| `TOK_MINLIQ` | `1e-9` | 808 |
| `AD_PEER_PER_DAY` | `10` | 856 |
| `MKT_MIN_OPTS` / `MKT_MAX_OPTS` | `2` / `7` | 932 |
| `MKT_FEE_MAX_BP` | `500` | 933 |
| `MKT_SEATS` | `{ 1: true, 3: true, 5: true }` | 934 |
| `MKT_RESOLVE_MS` | `7 * 24 * 60 * 60 * 1000` (published only, never applied) | 940 |

---

## 2. State variables of `replayUncached`

Legend: **W** = written by, **R** = read by, **It** = iterated (order-sensitive site).

### Graph & ledgers

- **`g`** (line 119) — `new E.RawGraph()`. Rust: the engine's `RawGraph`. W: every graph-touching branch (seedWorld, register, dm, stream, event, post, opinion, review, tag, market, final self-edge loop). R: `g.nodes.get` in post(ref), opinion/review/tag chron labels, editPost via `typeNode`, `edgeAct` fill (`g.edges.length`). Returned live.
- **`ledgers`** (120) — `[]` array of ledger records `{ id: String, burnBal: f64, actCount: u64, deleted?: true }` in **registration/seed push order**. Rust: `Vec<Ledger>` where the same records are shared with `ledgerById` (use indices or `Rc<RefCell>`; in Rust prefer `Vec<Ledger>` + `IndexMap<String, usize>` index map). W: `addActor` push; `debit` mutates `burnBal`/`actCount`; btcBurn/peerBurn mutate `burnBal`; register-payloadGone sets `.deleted = true`. R: `deferEpoch` snapshot at every closeEpoch, final `E.solveStanding(ledgers, …)`. **It:** array order = solve input order.
- **`ledgerById`** (120) — `bare()`, id → same ledger record. W: `addActor`. R: `known()`, `debit`, dm/call energy checks, tokenActError, marketActError, peerBurnActError, market `nominees` filter, closeEpoch engagement loop, btcBurn/peerBurn credit. **It:** final self-edge loop `for (var id2 in ledgerById)` (lines 2518–2527) — **insertion order decides the append order of the final `dec_`/`rep_` edges**, which is graph-material. `IndexMap<String, …>`.
- **`handles`** (120) — `bare()`, id → real handle string. W: `addActor`. R: `dispName`, rsvp/invite/follow chron, `parseMentions` (legacy posts). **It:** (a) `parseMentions` builds `slugToId` with `for (var id in handles)` — later registrations whose slug collides **overwrite** earlier ones, so insertion order decides mention resolution; (b) final `for (var hk in handles)` builds `dispHandles` (output order). `IndexMap<String, String>`.
- **`kReg`** (120) — `bare()`, id → registration epoch (`a.epoch` for register, `0` for seed actors). W: `addActor`. R: final self-edge loop (`tenure`). `IndexMap<String, f64>` (epoch comes from the act; treat as number).
- **`creators`** (120) — `bare()`, contentId → author id, **payload-guarded** (deleted authors lose entries). W: seedWorld (photo/comment/sneakers/streetart), stream, event, post-mint, review-mint, market — only when `!payloadGone`. R: nothing inside replay (display only). Returned. `IndexMap<String, String>`.
- **`payloads`** (120) — `bare()`, contentId → text. W: seedWorld, stream, event, post (mint + update, latest-wins), review (mint + update), market, editPost; **deleted** in post-update-delete (`delete payloads[cid]`). R: post/review update guards (`payloads[cid] !== undefined`), editPost guard. `IndexMap<String, String>`.

### Vouch compilation

- **`bundles`** (121) — `bare()`, key `author + '>' + target` → `{ src, rcp, pd: f64, pi: f64 }`. W: `vouch()` (register-mention, opinion-on-profile). R/**It:** `compileCells` `for (var k in bundles)` — called at **every closeEpoch** (line 2380) and once at the end (2512); insertion order = cell order = solve input order. `IndexMap<String, Bundle>`.
- **`selfCells`** (121) — `[]` of `{ src, rcp, coeff }` (src === rcp). W: `weighHome()`. R: `compileCells` prefix (`(selfCells || []).slice()`). `Vec<Cell>` — cells appear **before** bundle cells in the compiled list.

### Epoch machinery

- **`deltaActs`** (121) — starts `bare()`, **reassigned to a plain `{}` at every closeEpoch** (line 2383). id → act count since last close. W: `debit`. R/**It:** `deferEpoch` — `Object.keys` twice (Map build in insertion order + `reduce` sum); return-time `dmap` Map build. `IndexMap<String, u64>` (the bare-vs-plain distinction is irrelevant in Rust; keys are known actor ids).
- **`epochHistory`** (121) — `[]` of deferred epoch records (see §3). R: `epochNow = epochHistory.length + 1`. `Vec<EpochRecord>`.
- **`chron`** (121) — `[]` of chronicle entries. Shapes observed (byte-parity: **absent key ≠ null key**):
  - `{ who, line }`
  - `{ who, line, to }`
  - `{ who, line, to, refs: [{ label, id }] }`
  - deferEpoch entry: `{ who: null, line: <lazy getter> }` — `who` present and null.
  - settle/mint lines: `{ line, to }` (attest-settle) and `{ line }` (epoch PEER mint) — **no `who` key at all**.
  Rust: `struct ChronEntry { who: Option<Option<String>> /* or explicit presence flag */, line: LazyOrString, to: Option<String>, refs: Option<Vec<Ref>> }`.
- **`certsSoFar`** (134) — `0`; ++ in closeEpoch (line 2384). R: every `epoch: certsSoFar` edge stamp, peerBurn keys (`id@epoch`, `factory#pool@epoch`), `peerBurnActError(a, certsSoFar)`, tokenActError `burn` branch, resetTokens (`tokenEpoch0 = certsSoFar`), closeEpoch reset-guard (`certsSoFar <= tokenEpoch0`). `u64`.

### Deletion pre-scan (lines 151–162)

- **`deletedActors`** (151) — `bare()`, actor id → `true`. W: pre-scan on `t === 'deleteAccount'` (`pact.id`). R: `payloadGone`, `dispName`, final `dispHandles`. Returned as `deleted`. `IndexMap<String, bool>`.
- **`deletedPostIdx`** (151) — `bare()`, **act index** (`pact.target`, an integer) → `true`. W: pre-scan on `t === 'deletePost'`. R: `payloadGone` (`deletedPostIdx[i]`). Not returned. `BTreeMap<u64, bool>` (numeric keys) — never iterated, so a HashSet<u64> works too.
- **`seenSkel`** (152) — `bare()`, skeleton → first registrant id. W/R: pre-scan only. `IndexMap<String, String>`.
- **`handleTwin`** (152) — `bare()`, id → `true` for later namesakes. W: pre-scan (`register` acts with a handle whose `skel` was already claimed by a different id). R: register label, `dispName`. `IndexMap<String, bool>`.

Pre-scan verbatim (153–162):

```js
for (var pre = 0; pre < acts.length; pre++) {
  var pact = acts[pre];
  if (pact.t === 'deleteAccount') deletedActors[pact.id] = true;
  else if (pact.t === 'deletePost') deletedPostIdx[pact.target] = true;
  else if (pact.t === 'register' && pact.handle) {
    var sk = skel(pact.handle);
    if (sk && seenSkel[sk] && seenSkel[sk] !== pact.id) handleTwin[pact.id] = true;
    else if (sk) seenSkel[sk] = pact.id;
  }
}
```

### Content bookkeeping

- **`contentAuthor`** (128) — `bare()`, contentId → author. W: **unconditionally** at every mint (stream, event, post-mint, review-mint, market) — survives deletion; read by distribution only. R: opinion/review `epochEngage` guards. `IndexMap<String, String>`.
- **`reviewMeta`** (129) — `bare()`, commentNodeId → `{ e, f }`. W: seedWorld (`reviewMeta.comment = { e: 0.7, f: 0.8 }`), review mint + update (payload-guarded). Returned. `IndexMap<String, {e: f64, f: f64}>`.
- **`mediaMeta`** (130) — `bare()`, contentId → the act's `media` array (`[{h,m}|{d,m}]`). W: post mint/update when `a.media && a.media.length`; deleted in post-update-delete. Returned. `IndexMap<String, serde_json::Value>` (opaque payload).
- **`dms`** (131) — `[]` of `{ from, to, text, idx }` (dm) or `{ from, to, text: '', call: { outcome, dur }, idx }` (call). Payload-guarded pushes. `Vec<Dm>`.
- **`pinHash`** (132) — `bare()`, id → hash string. W: register (`a.pinHash` truthy), setPin (newest wins). Returned. `IndexMap<String, String>`.
- **`counter`** (133) — `0`. See §5 for allocation rules. `u64`.
- **`mutedContent`** (165) — `bare()`, contentId → `true`. W: every mint when `payloadGone`; post-update-delete. R: **only** the editPost guard. Not returned. `IndexMap<String, bool>`.
- **`actContent`** (166) — `bare()`, **act index → contentId** (mints only). W: stream/event/post-mint/review-mint/market (`actContent[i] = cid`). R: post update check (`actContent[a.target]`), review update check (`actContent[a.upd]`), editPost. Returned. **Numeric keys → `BTreeMap<u64, String>`** (JSON output is in ascending act-index order).
- **`postMeta`** (167) — `bare()`, contentId → `{ idx, ts, edited: bool }` plus one optional flag: `stream: true` | `event: true` | `comment: true` | `market: true` (none for a plain post). W: mints (payload-guarded), `.edited = true` on updates/editPost. Returned. `IndexMap<String, PostMeta>`.

### Events

- **`faucetCount`** (175) — `bare()`, `id + '@' + epoch` → count. **Never written anywhere** (faucet retired); read only by tokenActError `burn`. Dead but keep for fidelity. `IndexMap<String, u64>`.
- **`events`** (176) — `bare()`, cid → `{ host, at: f64, place: String (≤120 chars, '' when redacted), fee: f64 (round6'd, 0 if not > 0), cur: String ('' if free), cap: u64 (floor, 0 if not > 0), idx }`. W: event branch. R: invite, rsvp, tokenActError rsvp. Returned. `IndexMap<String, Event>`.
- **`eventInvites`** (177) — `bare()`, cid → `{ invitee: true }` (inner map is a **plain `{}`**). W: invite. Returned. `IndexMap<String, IndexMap<String, bool>>`.
- **`eventGoing`** (178) — `bare()`, cid → `{ attendee: true }` (inner **plain `{}`**). W: rsvp (set / `delete` on withdraw). R: `countGoing(cid)` = `Object.keys(eventGoing[cid] || {}).length`. Returned. `IndexMap<String, IndexMap<String, bool>>`.
- **`paidTo`** (181) — starts `bare()`, **reassigned plain `{}` at every closeEpoch** (line 2494). Key `actor + '>' + creator` → `true`. W: rsvp with fee, bet. R: opinion/review `epochEngage` guards. Not returned. `IndexMap<String, bool>`.

### Social / profile

- **`follows`** (185) — `bare()`, follower → `{ followee: true }` (inner **plain `{}`**, created as `follows[a.from] || (follows[a.from] = {})`). W: follow (set/delete). Returned; read by nothing. `IndexMap<String, IndexMap<String, bool>>`.
- **`followers`** (186) — `bare()`, followee → `{ follower: true }` (inner plain `{}`). Same. `IndexMap<String, IndexMap<String, bool>>`.
- **`profiles`** (187) — **plain `{}`** (not bare — keys are known actor ids). id → `{ bio, link, pic, idx }` (all strings defaulted `''`, `idx` = act index; whole record replaced each profile act). Returned. `IndexMap<String, Profile>`.

### Layer 0

- **`l0`** (190) — `new E.AttestationLedger({ E0: 0, zeta: 0.5, fee: 0.5, maturityCycle: 10 })`. **Never touched again** — all five L0 branches (`deposit`, `burnL0`, `redeem`, `transferL0`, `closeCycle`) are documented no-ops. Returned live as `l0`. Rust: construct the equivalent ledger with the same config purely so the serialized state matches; no mutation path exists.
- **`l0safe`** (191) — `function l0safe(fn) { try { return fn(); } catch (e) { return null; } }` — defined, **never called**. Dead.

### PEER-burn door

- **`peerBurnTxBy`** (777) — `bare()`, lowercase Base tx hash → claiming id. W: peerBurn. R: peerBurnActError (dedupe/ownership). Returned as `peerBurn.tx`. `IndexMap<String, String>`.
- **`peerBurnTxSats`** (784) — `bare()`, lowercase tx → satoshis credited so far (accumulated `+= a.creditsSats`). W: peerBurn. R: peerBurnActError. Returned as `peerBurn.txCreditedSats`. `IndexMap<String, u64>`.
- **`peerBurnEpochUse`** (788) — `bare()`, `id + '@' + epoch` → sats converted this epoch. W: peerBurn. R: peerBurnActError ceiling 2. **It:** final loop building `peerBurnUsedReserve` (`for (var pbk in peerBurnEpochUse)` line 2536) — output order. Returned as `peerBurn.usedSatsThisEpoch`. `IndexMap<String, u64>`.
- **`peerBurnPoolUse`** (792) — `bare()`, `factoryLower + '#' + pool + '@' + epoch` → sats. W: peerBurn. R: peerBurnActError ceiling 3. Returned as `peerBurn.poolUsedSatsThisEpoch`. `IndexMap<String, u64>`.
- **`peerBurnedRaw`** (795) — `bare()`, id → raw PEER destroyed all-time as a **decimal string** (BigInt addition: `String(BigInt(peerBurnedRaw[a.id] || '0') + BigInt(a.amtRaw))`). Display only. Returned as `peerBurn.by`. `IndexMap<String, String>` (values computed with u128/BigUint — up to 48-digit inputs, so **use a big-int type, not u128 alone** (48 digits > u128 max of ~3.4e38); `num_bigint::BigUint` or a 256-bit int).
- **`addrBinders`** (806) — `bare()`, lowercase address → `{ n: u32, id: Option<String>, ts: Option<f64>, seen: bare() id → ts|null }`. W: bindAddress. R: peerBurnActError ownership rules. Returned as `peerBurn.binders`. `IndexMap<String, Binder>` with `seen: IndexMap<String, Option<f64>>`.

### Token economy

- **`tokenBal`** (810) — `bare()`, sym → `bare()` actor → amount (f64). W: `tokCredit`/`tokDebit` (rsvp, advert, btcClaim(dead), assetCreate, tokenSend, pools, bets, bonds, settles, epoch mint). **It:** resetTokens `for (var rsym in tokenBal) tokenBal[rsym] = bare();` (values replaced, order irrelevant to values but output order = insertion order of symbols). Returned as `tokens.bal`. `IndexMap<String, IndexMap<String, f64>>`.
- **`tokenMeta`** (811) — `Object.assign(bare(), { PEER: { name: 'Peer epoch token', creator: null }, tBTC: { name: 'retired — never real bitcoin, no supply, nothing mints it', creator: null } })`. W: assetCreate. R: tokenActError, marketActError. Returned as `tokens.meta`. `IndexMap<String, {name: String, creator: Option<String>}>`.
- **`tokenSupply`** (818) — `Object.assign(bare(), { PEER: 0, tBTC: 0 })`. W: advert (`PEER -= adCost`, round6), btcClaim (dead), assetCreate (`= a.supply`), closeEpoch (`PEER += credited`, round6). Returned as `tokens.supply`. `IndexMap<String, f64>`.
- **`btcClaimed`** (819) — `bare()`, id → true. W: btcClaim branch — **unreachable** (tokenActError always refuses btcClaim). Returned as `tokens.claimed` (always empty for post-restart logs; a pre-restart log replayed under THIS code also leaves it empty because the refusal is unconditional). `IndexMap<String, bool>`.
- **`pools`** (820) — `bare()`, `'A/B'` (alphabetical via `poolId`) → `{ a, b, resA: f64, resB: f64, totalShares: f64, shares: bare() actor→f64 (plus '_locked' key), swaps: u64, volA: f64, volB: f64 }`. W: poolCreate/Add/Remove/Swap. R: tokenActError. Returned. `IndexMap<String, Pool>` with `shares: IndexMap<String, f64>`.
- **`tokenDist`** (821) — `[]`, per closed epoch: either `{ epoch, minted, carried, to: IndexMap, pool, emission, totalWeight, weights, why }` or the no-engagement shape `{ epoch, minted: 0, carried, to: {}, pool, emission, totalWeight: 0, weights: {}, why: {}, note: 'no eligible engagement' }`. `Vec<TokenDist>`. NOTE: `weights: tw` and `why: twDetail` are the **live** accumulation maps (not copies) — safe because they are rebuilt fresh each close, but in the paying case `to`, `weights`, `why` iterate in first-engagement-per-creator insertion order.
- **`adverts`** (857) — `[]` of `{ id: 'ad'+seq, by, text (trimmed), url, days: u64, paid: f64, at: f64, until: f64, aim: { placement, tags, people, posts, regions: Vec }, stopped: bool }`. W: advert, adStop. Returned. `Vec<Advert>`.
- **`adSeq`** (858) — `0`; ++ in advert. `u64`.
- **`earnedBurn`** (859) — `bare()`; **declared, never written, never read, never returned. Dead.**
- **`burnedSats`** (864) — `bare()`, id → satoshis destroyed on Bitcoin (`+= a.sats`). W: btcBurn. R: closeEpoch engagement weight, modVote (`wt` + chron), marketActError modVote gate. **Not returned.** `IndexMap<String, f64>` (values come from `a.sats`, a JSON number — keep f64 to match `+` semantics; in practice integers).
- **`burnedTx`** (865) — `bare()`, lowercase txid → id. W/R: btcBurn dedupe. Not returned. `IndexMap<String, String>`.
- **`tokenEpoch0`** (866) — `0`; W: resetTokens (`= certsSoFar`). R: closeEpoch (`if (certsSoFar <= tokenEpoch0) twTotal = 0`). `u64`.
- **`tokenCarry`** (867) — `0.0`; W/R: closeEpoch. `f64`.
- **`tokEpochN`** (868) — `0`; ++ per closeEpoch; keys `addrAtEpoch` and `tokenDist.epoch`. Returned as `tokens.epochN`. `u64`.
- **`epochEngage`** (869) — `[]` of `{ actor, creator, base: f64 (1.0 | 0.3 | 1.2), cid, kind: 'reaction'|'dislike'|'comment' }`. W: opinion, review. Consumed + cleared (`= []`) at closeEpoch. `Vec<Engage>`.

### Address bindings

- **`addrOf`** (886) — **plain `{}`**, id → lowercase Base address, newest wins. W: bindAddress. **It:** closeEpoch snapshot copy `for (var ak in addrOf)`. Returned as `addresses`. `IndexMap<String, String>`.
- **`addrAtEpoch`** (887) — **plain `{}`**, epoch number (`tokEpochN`) → frozen copy of addrOf. W: closeEpoch. Returned as `addressesAt`. **Numeric keys → `BTreeMap<u64, IndexMap<String, String>>`.**

### Markets

- **`markets`** (941) — `bare()`, cid → market record built in the `market` branch:

```
{ cid, by, cur, n: usize, opts: Vec<String>,        // labels '' when redacted, count is structure
  at: f64, seats: u64, bond: f64 (round6), feeBp: u64 (Math.floor),
  nominees: Vec<String> (filtered, max 8),
  stakes: Vec<IndexMap<String, f64>>,               // one bare() per option
  totals: Vec<f64>, pool: f64,
  byBettor: IndexMap<String, f64>,                  // bare()
  cands: IndexMap<String, f64>,                     // bare(): candidate -> bond posted
  votes: IndexMap<String, {for: Vec<String>, wt: f64}>, // bare(); reassignment keeps original slot
  attests: IndexMap<String, i64>,                   // bare(); value may be -1
  state: String ('open'|'resolved'|'void'), outcome: i64 (-1 initial/void),
  paid: IndexMap<String, f64>, refunded: IndexMap<String, f64>,
  struck: IndexMap<String, f64>, earned: IndexMap<String, f64>,   // all bare()
  jury: Vec<String>, honest: Vec<String>, guilty: Vec<String>,
  feePaid: f64, slashedTotal: f64, idx: u64 }
```

  **It sites:** `mktSeats` — `for (id in m.cands)` (zero-init of `w`, insertion order = output order of `weight`), `for (var v in m.votes)` (**float accumulation order** of `w[cand] += wt` follows votes insertion order; JS object reassignment `votes[a.author] = …` keeps the FIRST insertion position — IndexMap `insert` matches), `Object.keys(m.cands).sort(comparator)` (deterministic sort, see helper). `mktSettle` — `Object.keys(m.cands).sort()`, `Object.keys(m.stakes[outcome]).sort()`, `Object.keys(m.stakes[i]).sort()`, `Object.keys(m.byBettor).sort()` — all lexicographically sorted, order-insensitive to insertion but **round6 running-sum order = sorted key order**. `mktVerdict` iterates `seated` (Vec order).

### Edge/act correlation

- **`edgeAct`** (1429) — `[]`, append-index → act index. Filled at loop top: `while (edgeAct.length < g.edges.length) edgeAct.push(i - 1);` and after the loop with `acts.length - 1` (line 2502) **before** the final self-edges are appended, so `edgeAct.length < g.edges.length` in the returned state ("sparse at the end on purpose"). `Vec<i64>` (holds `-1`).

---

## 3. deferEpoch — the deferred certificate (lines 50–80, called at 2380)

Called as `deferEpoch(E, a.epoch, ledgers, compileCells(bundles, selfCells), deltaActs)` — note `epochNo` is **the act's own `epoch` field**, not `certsSoFar`.

Snapshotted eagerly at close time:

```js
var snapLedgers = ledgers.map(function (l) {
  return { id: l.id, burnBal: l.burnBal, actCount: l.actCount };
});                                       // value copies at close; `deleted` flag NOT copied
var snapDmap = new Map(Object.keys(deltaActs).map(function (k) { return [k, deltaActs[k]]; }));
var actTotal = Object.keys(deltaActs).reduce(function (s, k) { return s + deltaActs[k]; }, 0);
```

`cells` is the array `compileCells` returned **at close time** — fresh objects, so later vouches cannot leak in.

Lazy settle (memoized):

```js
function settle() {
  if (!settled) {
    var sv = E.solveStanding(snapLedgers, cells, { tilt: 1 });
    settled = E.evaluateGates(snapLedgers, sv.x, snapDmap);
  }
  return settled;
}
```

`record` **before** settle: `{ epoch: epochNo, acts: actTotal }` plus three **enumerable getters** defined via `Object.defineProperties`:
- `stamp` → `settle().epochStamp`
- `headroom` → `settle().headroom`
- `pass` → `settle().allPass`

`chron` entry: `{ who: null }` plus enumerable getter `line`:

```js
return 'epoch ' + epochNo + ' closed · stamp ' + g.epochStamp.toFixed(3)
  + ' · ' + (g.allPass ? 'certificate accepted' : 'wall/door failed');
```

Consequences for the port: (a) `epochHistory.length` is consumed without settling (`epochNow`, CoGra certificate count); (b) any JSON serialization of an epoch record or its chron line **forces settle** (getters are enumerable), producing identical numbers to an eager solve. The Rust port may settle lazily (OnceCell) or eagerly at serialization; the observable bytes are the same. `who: null` must serialize as an explicit null.

epochHistory entry **after settle** (as JSON): `{ "epoch": …, "acts": …, "stamp": f64, "headroom": …, "pass": bool }` (property order: epoch, acts, then the three getters in definition order stamp, headroom, pass).

---

## 4. The l0 AttestationLedger seam

`var l0 = new E.AttestationLedger({ E0: 0, zeta: 0.5, fee: 0.5, maturityCycle: 10 });` (line 190). Comment describes the historical L1 seam ("every attestation increment feeds the actor's residual burn balance") but **all writers are retired**: `deposit` (1636), `burnL0` (1647), `redeem` (1658), `transferL0` (1669), `closeCycle` (1711) are comment-only no-op branches — the acts parse and do nothing (no chron, no debit, nothing). `l0safe` is never called. `l0` is returned live in the state object. The Rust port needs only a freshly-constructed ledger with the same config so that the serialized shape agrees.

---

## 5. Counter / content-id allocation rules

`counter` starts at 0 and ticks (`counter++`) at exactly these sites, in dispatch order:

| site | ids minted from the new value |
|---|---|
| dm (per accepted message) | `'m'+counter` Message node, `'snA'+counter`/`'snT'+counter` edges |
| stream | `'c'+counter` Content, `'pub'+counter` edge |
| event | `'c'+counter` Content, `'pub'+counter` edge |
| post (mint path only) | `'c'+counter` Content, `'pub'+counter` edge |
| post quote-reference (after mint, if `a.ref` valid & energy) | `'rfA'+counter`/`'rfT'+counter` edges |
| post @mention (per accepted mention, up to 3) | `'rfA'+counter`/`'rfT'+counter` edges |
| opinion (always, even though no node) | `'op'+counter` edge |
| review (mint path only) | `'c'+counter` Comment, `'rvA'+counter`/`'rvT'+counter` edges |
| tag | `'tgA'+counter`/`'tgT'+counter` edges (type node id is derived, not counted) |
| market | `'c'+counter` Content, `'pub'+counter` edge |

**Never ticks** on: post update (edge id `'pubu'+i`), review update (`'rvAu'+i`/`'rvTu'+i`), register (`'reg_'+a.id`), seedWorld (fixed ids), follow/profile/bindAddress/call/editPost/token acts/bet/modStand/modVote/attest/marketVoid/closeEpoch. The market node mints **unconditionally** once the author is known — a malformed bet still ticks the counter (a post with no market attached). `adSeq` is a separate counter (`'ad'+adSeq`).

Mint order inside `post`: node mint first (one tick), then quote-ref (one tick), then mentions (one tick each) — so a post with a quote and two mentions consumes 4 counter values.

---

## 6. EXACT return object of `replayUncached` (lines 2537–2632)

Property order as written (byte-parity for JSON.stringify of the whole object follows this order). "live" = the internal mutable object itself, not a copy.

| property | value | type / notes |
|---|---|---|
| `follows` | live `follows` | map of maps |
| `followers` | live `followers` | map of maps |
| `profiles` | live `profiles` | map |
| `events` | live `events` | map |
| `eventInvites` | live | map of maps |
| `eventGoing` | live | map of maps |
| `g` | live RawGraph | includes the post-loop self edges |
| `ledgers` | live array | push order |
| `ledgerById` | live map | same records as `ledgers` |
| `handles` | **`dispHandles`** — fresh plain `{}`: `deletedActors[hk] ? '[deleted]' : handles[hk]`, built in `handles` insertion order | NOT the internal map |
| `creators` | live | |
| `payloads` | live | |
| `bundles` | live | |
| `cells` | final `compileCells(bundles, selfCells)` array (line 2512) | the SAME array passed to the final solve |
| `solved` | `E.solveStanding(ledgers, cells, { tilt: 1 })` result | |
| `xById` | plain `{}`: `solved.ids.forEach(function (id, i) { xById[id] = solved.x[i]; })` | order = solved.ids order |
| `deltaActs` | live map (acts since the LAST close) | |
| `dmap` | `new Map(Object.keys(deltaActs).map(k => [k, deltaActs[k]]))` — snapshot Map | insertion order |
| `epochHistory` | live array of deferred records (lazy getters) | §3 |
| `chron` | live array | one lazy entry per closed epoch |
| `epochNow` | `epochHistory.length + 1` | number |
| `reviewMeta` | live | |
| `mediaMeta` | live | |
| `dms` | live | |
| `pinHash` | live | |
| `l0` | live AttestationLedger | never mutated |
| `deleted` | live `deletedActors` | |
| `postMeta` | live | |
| `tokens` | `{ bal: tokenBal, meta: tokenMeta, supply: tokenSupply, claimed: btcClaimed, dist: tokenDist, carry: tokenCarry, epochN: tokEpochN }` | fresh wrapper, live members |
| `addresses` | live `addrOf` | |
| `addressesAt` | live `addrAtEpoch` | numeric keys |
| `pools` | live | |
| `markets` | live | |
| `marketActError` | **live closure** — answers against final state | function |
| `marketSeats` | `mktSeats` closure | function |
| `marketLimits` | `{ minOpts: 2, maxOpts: 7, maxFeeBp: 500, seats: [1, 3, 5], resolveMs: 604800000 }` | fresh literal |
| `adverts` | live | |
| `adPricePerDay` | `10` | |
| `tokenActError` | **live closure** (reads final `certsSoFar`, balances, pools…) | function |
| `peerBurn` | fresh wrapper `{ by: peerBurnedRaw, tx: peerBurnTxBy, txCreditedSats: peerBurnTxSats, usedSatsThisEpoch: peerBurnEpochUse, usedThisEpoch: peerBurnUsedReserve, poolUsedSatsThisEpoch: peerBurnPoolUse, binders: addrBinders, limits: {...} }` | see below |
| `peerBurnActError` | **live closure** | function |
| `peerBurnGrid` | pure function | function |
| `edgeAct` | live array (shorter than `g.edges`) | |
| `actContent` | live map (numeric keys) | |

`peerBurnUsedReserve` (lines 2535–2536): fresh `bare()`, every key of `peerBurnEpochUse` → `peerBurnEpochUse[pbk] / SATS_PER_RESERVE` (derived once at return, insertion order preserved).

`peerBurn.limits` verbatim: `{ satsPerReserve: 100, reservePerEpoch: 100, satsPerEpoch: 10000, capFromEpoch: 0, minPoolSats: 1000000, twapMs: 1800000, twapObs: 12, twapGrid: 16, addr: '0x000000000000000000000000000000000000dead', provenance: 'A bitcoin burn pays a P2WSH commitment to a script that cannot be satisfied — unspendable by arithmetic, checkable by anyone. A PEER burn pays a dead address that is unspendable only because nobody knows a key for it. Both destroy value; only one of them is a proof.' }`

For the Rust port, the four exported closures (`tokenActError`, `marketActError`, `peerBurnActError`, `mktSeats`) become methods on the returned state struct that borrow the final state; `peerBurnGrid` is a free function. `dmap` being a `Map` vs `deltaActs` an object matters only for callers that distinguish them (evaluateGates takes the Map form).

---

## 7. Post-loop finalization (lines 2498–2536), in order

1. `while (edgeAct.length < g.edges.length) edgeAct.push(acts.length - 1);`
2. `var cells = compileCells(bundles, selfCells);`
3. `var solved = E.solveStanding(ledgers, cells, { tilt: 1 });`
4. `xById` build.
5. `var epochNow = epochHistory.length + 1;`
6. Self-edge loop, `for (var id2 in ledgerById)` — **skips `'alice'` only**:

```js
if (id2 === 'alice') continue;
var S = NU * (xById[id2] || 0);
var bond = S / (NU + S);
var tenure = 1 - 1 / (epochNow - kReg[id2] + 1);
if (bond > 0) {
  g.append({ id: 'dec_' + id2, family: 'SelfDeclaration', src: id2, tgt: 'prof_' + id2, pd: 1, pi: bond, tauOverride: tenure });
  g.append({ id: 'rep_' + id2, family: 'SelfReputation', src: 'prof_' + id2, tgt: id2, pd: 1, pi: bond, tauOverride: tenure });
}
```

7. `dispHandles` build.
8. `peerBurnUsedReserve` build.
9. Return (§6).
