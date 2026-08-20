// The protocol replay: world state as a pure function of the act log.
//
// SHARED ON PURPOSE. The browser page inlines this file and the host imports
// it, so the feed a bot reads over HTTP and the feed a human sees on screen
// come from the same code. A second implementation would drift — that failure
// has already cost this project two real bugs (a PIN index that forgot setPin
// acts, and a mention parser that disagreed with the client about seed users).
//
// Usage:  var R = PeerReplay.create(PeerEngine);  var st = R.replay(acts);
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PeerReplay = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(E) {
    var THETA = E.THETA, NU = E.NU;

var SEED_POSTS = {
  photo: 'Street shot from the underpass — first light.',
  comment: 'Grain placement is deliberate. This holds up.',
};

function parseMentions(text, handles) {
  var slugToId = {};
  for (var id in handles) {
    slugToId[(handles[id] || '').toLowerCase().replace(/[^a-z0-9]/g, '')] = id;
  }
  var out = [], seen = {}, m;
  var re = /@([a-zA-Z0-9_]{1,16})/g;
  while ((m = re.exec(text)) !== null && out.length < 3) {
    var id2 = slugToId[m[1].toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (id2 && !seen[id2]) { seen[id2] = 1; out.push(id2); }
  }
  return out;
}

/**
 * One closed epoch, with its certificate deferred.
 *
 * Solving standing here — inside the replay loop, once per epoch, over every
 * cell accumulated so far — was ~89% of replay time and the reason cost grew
 * roughly n²: a longer log means both more epochs and a costlier solve each.
 * Nothing downstream reads the result; the graph, the ledgers and the final
 * solve are untouched by it, only `epochHistory.length` is consumed (as CoGra's
 * certificate count and as epochNow), and stamp/headroom/pass are rendered on
 * exactly one screen. So the inputs are snapshotted cheaply and the certificate
 * is settled on first read: identical numbers, paid for by whoever looks.
 */
function deferEpoch(E, epochNo, ledgers, cells, deltaActs) {
  var snapLedgers = ledgers.map(function (l) {
    return { id: l.id, burnBal: l.burnBal, actCount: l.actCount };
  });
  var snapDmap = new Map(Object.keys(deltaActs).map(function (k) { return [k, deltaActs[k]]; }));
  var actTotal = Object.keys(deltaActs).reduce(function (s, k) { return s + deltaActs[k]; }, 0);
  var settled = null;
  function settle() {
    if (!settled) {
      var sv = E.solveStanding(snapLedgers, cells, { tilt: 1 });
      settled = E.evaluateGates(snapLedgers, sv.x, snapDmap);
    }
    return settled;
  }
  var record = { epoch: epochNo, acts: actTotal };
  Object.defineProperties(record, {
    stamp: { enumerable: true, get: function () { return settle().epochStamp; } },
    headroom: { enumerable: true, get: function () { return settle().headroom; } },
    pass: { enumerable: true, get: function () { return settle().allPass; } },
  });
  var chron = { who: null };
  Object.defineProperty(chron, 'line', {
    enumerable: true,
    get: function () {
      var g = settle();
      return 'epoch ' + epochNo + ' closed · stamp ' + g.epochStamp.toFixed(3)
        + ' · ' + (g.allPass ? 'certificate accepted' : 'wall/door failed');
    },
  });
  return { record: record, chron: chron };
}

function compileCells(bundles, selfCells) {
  var out = (selfCells || []).slice();
  for (var k in bundles) {
    var b = bundles[k];
    var pd = Math.max(-1, Math.min(1, b.pd)), pi = Math.max(-1, Math.min(1, b.pi));
    if (pd > 0 && pi > 0) {
      out.push({ src: b.src, rcp: b.rcp, coeff: Math.sqrt(pd * pi) });
    } else {
      var c = Math.sqrt(Math.abs(pd) * Math.abs(pi));
      if (c > 0) out.push({ src: b.src, rcp: b.src, coeff: c });
    }
  }
  return out;
}

/**
 * A map whose keys come from the log — which means from strangers.
 *
 * `{}` inherits Object.prototype, so `pools['constructor']` is not undefined,
 * it is the Object constructor: truthy, and every `if (!pools[name])` guard in
 * this file waved it through. An adversarial pre-flight proved the whole
 * family before this shipped: one authenticated `poolAdd` naming
 * "constructor" was accepted at the door, persisted to the append-only log,
 * and then threw on EVERY subsequent replay — the host died on boot, the
 * browsers died with it, and nothing short of hand-editing the record could
 * bring it back. `poolRemove` with the same name killed the process inside
 * validate(), before authentication, repeatably.
 *
 * A prototype-less object has no such keys to inherit, so the guards mean what
 * they say. Every map below whose keys are act fields — symbols, pool names,
 * content ids, handles, txids — is built with this. It is one line instead of
 * a `hasOwnProperty` call at fifty lookup sites, and unlike the fifty it
 * cannot be forgotten at the fifty-first.
 */
function bare() { return Object.create(null); }

function replayUncached(acts) {
  var g = new E.RawGraph();
  var ledgers = [], ledgerById = bare(), handles = bare(), kReg = bare(), creators = bare(), payloads = bare();
  var bundles = bare(), selfCells = [], deltaActs = bare(), epochHistory = [], chron = [];
  // Who authored a node, recorded UNCONDITIONALLY. `creators` is inside the
  // payload guard, so a deleted account loses its entries — fine for display,
  // fatal for the token distribution: an epoch that closed months ago would
  // silently re-cut everyone else's share the moment one participant left.
  // Authorship is structure (the Publish edge already carries it publicly),
  // and structure survives deletion. This map is read by distribution only.
  var contentAuthor = bare();
  var reviewMeta = bare(); // commentNodeId -> {e, f}
  var mediaMeta = bare();  // contentId -> [{h, m} | {d, m}]
  var dms = [];        // {from, to, text, idx}
  var pinHash = bare();
  var counter = 0;
  var certsSoFar = 0; // certificates issued before the current act (CoGra epoch age)

  // ── Deletion pre-scan ──────────────────────────────────────────────────
  // Replay is a pure function of the whole log, so deletions are retroactive.
  //
  // Deletion removes the PAYLOAD and nothing else. The act's edges, its θ
  // debit, its weighing home and any vouch it compiled all stay exactly as
  // they were, so erasing content changes no standing, no gate and no epoch
  // certificate. That is not politeness, it is the property the whole system
  // rests on: a published certificate must still reproduce from the log
  // afterwards. The earlier version removed the RECORD, and one deleted post
  // measurably moved fifteen of twenty-nine actors' standing and invalidated
  // an already-published certificate.
  //
  // The cost, and the spec takes it deliberately: deleting a post does not
  // retract the vouches it compiled. Removal cannot be used to launder
  // standing that other people already received.
  var deletedActors = bare(), deletedPostIdx = bare();
  var seenSkel = bare(), handleTwin = bare();
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
  // Content whose payload was removed. Read for display and to refuse edits;
  // it no longer propagates, because muting is never inherited from a target.
  var mutedContent = bare();
  var actContent = bare();   // act index -> content id (posts only; edit targets)
  var postMeta = bare();
  // The faucet's ceiling. FROM_EPOCH is deliberately ahead of where the live
  // network stands, so no already-recorded standing moves; see the burn branch.
  var FAUCET_PER_EPOCH = 8;
  var FAUCET_CAP_FROM_EPOCH = 62;
  // The epoch the tBTC faucet shuts for good. Ahead of the record on
  // purpose: see the btcClaim branch.
  var TBTC_FAUCET_CLOSED_FROM = 62;
  var faucetCount = bare();   // (id '@' epoch) -> how many this epoch
  var events = bare();        // cid -> {host, at, place, fee, cur, cap, idx}
  var eventInvites = bare();  // cid -> { invitee: act index of the invite }
  var eventGoing = bare();    // cid -> { attendee: true }
  // (actor '>' creator) pairs where money moved this epoch. Cleared with the
  // engagement records at close.
  var paidTo = bare();
  function countGoing(cid) { return Object.keys(eventGoing[cid] || {}).length; }
  function fmtAmt(x) { return (Math.round(x * 1e6) / 1e6).toString(); }
  // Attention, recorded but never scored. See the 'follow' branch below.
  var follows = bare();     // follower -> { followee: true }
  var followers = bare();   // followee -> { follower: true }
  var profiles = {};    // id -> { bio, link, pic, idx }     // cid -> {idx, ts, edited} for the edit/delete UI
  // Layer 0: the attestation ledger (Peer Attestation v0.6.0). The L1 seam:
  // every attestation increment feeds the actor's residual burn balance.
  var l0 = new E.AttestationLedger({ E0: 0, zeta: 0.5, fee: 0.5, maturityCycle: 10 });
  function l0safe(fn) { try { return fn(); } catch (e) { return null; } }

  // `handles` keeps the REAL handle — mention slugs resolve against it and
  // must stay deterministic forever. Node labels are what humans see, so a
  // deleted actor is labelled '[deleted]' there and nowhere leaks its name
  // into the graph view or the JSON export.
  function addActor(id, handle, burn, count, epoch, label) {
    var lab = label || handle;
    g.addNode({ id: id, kind: 'Actor', label: lab });
    g.addNode({ id: 'prof_' + id, kind: 'Profile', label: lab });
    var l = { id: id, burnBal: burn, actCount: count };
    ledgers.push(l); ledgerById[id] = l; handles[id] = handle; kReg[id] = epoch;
  }
  // Name for human-readable chronicle text: never the real handle of a
  // deleted account — the Record is served to everyone.
  // Handles registered AFTER an existing one whose readable shape they share.
  // Registration refuses these now, but two were created before the check
  // existed — both wearing "Ender133" — and one of them posted. Deleting them
  // would rewrite the log; the honest alternative is to stop the record from
  // repeating their claim, so a later namesake is shown with its own id.
  function skel(hh) {
    var out = '', prev = '';
    var low = String(hh || '').toLowerCase();
    for (var si = 0; si < low.length; si++) {
      var c = low[si];
      if (c === '0') c = 'o'; else if (c === '1' || c === 'i' || c === 'l') c = 'l';
      else if (c === '5') c = 's'; else if (c === '8') c = 'b'; else if (c === '2') c = 'z';
      if (!/[a-z0-9]/.test(c) || c === prev) continue;
      out += c; prev = c;
    }
    return out;
  }
  function dispName(id) {
    if (deletedActors[id]) return '[deleted]';
    var hh = handles[id] || id;
    // A namesake is never shown as the name alone: the whole point of the
    // record is that a name on an act identifies one person.
    return handleTwin[id] ? hh + ' (' + id + ', not the original)' : hh;
  }
  // An act naming an actor that never registered is not a protocol event, it
  // is noise in the file. It used to reach here and throw, which took the
  // whole host down — a replay that crashes on input is a denial of service
  // with extra steps. Unknown actors are skipped, everywhere, always.
  function known(id) { return !!ledgerById[id]; }
  // ── Pricing a PEER burn from the numbers the act carries ────────────────
  //
  // A raw token amount as the chain states it: an unsigned decimal integer.
  // Kept as a STRING through the act and into BigInt, never through a double
  // — an 18-decimal amount does not survive Number() intact, and two honest
  // hosts that both round it would still have to agree on how, which is a
  // thing no comment can enforce.
  var RAW_INT = /^[0-9]{1,48}$/;
  var BIG0 = BigInt(0);
  /**
   * What the pool says N PEER is worth, in satoshis, from three recorded
   * numbers and nothing else.
   *
   *   sats = floor( amt · resBtc / (resPeer + amt) )
   *
   * That is the constant-product OUTPUT, not the marginal ratio
   * resBtc/resPeer. The two agree for a small burn and diverge for a large
   * one, and the divergence is exactly the point: the marginal ratio is a
   * price no trade can actually get, so paying it for a burn big enough to
   * move the pool would credit satoshis nobody could ever have realised. The
   * operator's sentence was "ask the pool what N PEER is worth" — this is the
   * pool's answer to that question, and the marginal ratio is the answer to a
   * different, easier one. It also carries a ceiling PER ACT for free: no
   * single burn, however enormous, can be worth more than the pool's whole
   * bitcoin side.
   *
   * That is true of one act and it is NOT true of a log, which is worth being
   * exact about because the sentence used to be written without the two words
   * "per act" and read as a promise about the network. The reserves never move
   * — the PEER is destroyed, not sold — so a hundred burns are each priced as
   * if they were the first, and the total reserve a pool can create in an epoch
   * is unbounded by this expression alone. Measured, at the minimum permitted
   * depth: three hundred accounts each filling the per-account ceiling once
   * created 27,100 reserve — 2,710,000 satoshis of "value destroyed" — against
   * a pool whose entire bitcoin side was 1,000,000 satoshis, and whose PEER
   * side could only have realised about 749,600 of them. What bounds the total
   * is PEER_BURN_POOL_CAP below, which is a separate rule and had to be.
   *
   * No swap fee is applied. The PEER is DESTROYED, not sold — the reserves do
   * not move and nobody makes a market — so charging a fee would invent a
   * cost as surely as ignoring the slippage would invent a price.
   *
   * The units need no scaling constant, which is the reason this pair was
   * worth choosing: cbBTC has 8 decimals, so a raw cbBTC unit IS a satoshi,
   * and PEER's 18 decimals cancel between numerator and denominator. There is
   * no 1e18 anywhere for a host to get subtly and silently wrong.
   */
  function peerBurnSats(amtRaw, resPeerRaw, resBtcRaw) {
    // Strings, not numbers, and this is checked rather than hoped for: a raw
    // 18-decimal amount written into the log as a JSON number is ALREADY
    // rounded by the time anyone reads it, and two logs that look identical
    // would then price the same burn differently.
    if (typeof amtRaw !== 'string' || typeof resPeerRaw !== 'string' || typeof resBtcRaw !== 'string') return null;
    if (!RAW_INT.test(amtRaw) || !RAW_INT.test(resPeerRaw) || !RAW_INT.test(resBtcRaw)) return null;
    var amt = BigInt(amtRaw), rp = BigInt(resPeerRaw), rb = BigInt(resBtcRaw);
    if (amt <= BIG0 || rp <= BIG0 || rb <= BIG0) return null;
    // Floor, so rounding never runs in the burner's favour.
    var n = Number((amt * rb) / (rp + amt));
    if (!Number.isSafeInteger(n)) return null; // more satoshis than will ever exist
    return n;
  }
  /** 18 raw units to one PEER, as text, without going through a double. */
  function peerText(raw) {
    var s = String(raw).replace(/[^0-9]/g, '') || '0';
    while (s.length < 19) s = '0' + s;
    var whole = s.slice(0, s.length - 18).replace(/^0+(?=\d)/, '');
    var frac = s.slice(s.length - 18).replace(/0+$/, '').slice(0, 6);
    return whole + (frac ? '.' + frac : '');
  }
  /**
   * WHICH BLOCKS THE PRICE WAS SAMPLED AT — derived, not asserted.
   *
   * The host cannot read every block of a half-hour window (nine hundred
   * blocks, two chain calls each, per burn), so it samples. WHICH blocks it
   * samples is the whole security of the average, and the first version of
   * this door got it wrong in a way worth writing down: the samples were laid
   * on a fixed arithmetic grid, `floor(refBlock / stride) * stride` counting
   * back by `stride`. That grid is public arithmetic. An attacker who picks
   * the block of their own burn knows all sixteen of the blocks that will be
   * read, so they do not have to hold a false price across the window at all —
   * they pump and dump sixteen times, once per sampled block, and the average
   * comes out ~100% manipulated while the pool sits at its true price for
   * 98.6% of the window. Measured against a fake chain: 16 blocks read out of
   * ~1125 in the window, 1.4% of it, at a round-trip fee cost of roughly
   * 864,000 sat at the minimum permitted depth — after which reserve costs
   * about 1 satoshi a unit instead of a hundred.
   *
   * So the grid is SEEDED BY THE REFERENCE BLOCK'S HASH, which nobody knows
   * until that block exists. The window [startsAt, endsAt) is cut into `n`
   * equal buckets and one block is read from each, its position inside the
   * bucket taken from four hex characters of the hash. An attacker must now
   * either hold the false price across a whole bucket to be sure of hitting
   * its sample — which is holding it across the window, at their own expense,
   * against every arbitrageur, which is what a time-weighted price is FOR — or
   * accept that a pump lasting f of the window is sampled about f of the time.
   * Cost becomes proportional to duration, which is the property the window
   * was always claimed to have and did not.
   *
   * It is deterministic and re-derivable: the act records startsAt, endsAt,
   * the reference hash and the blocks, so this function reproduces the same
   * list from the log alone, forever, and a reader can re-fetch poolInfo at
   * exactly those blocks and recompute the two reserves.
   *
   * BE EXACT ABOUT WHAT REPLAY CAN AND CANNOT CHECK HERE. It can check that
   * the recorded blocks are the ones this seed produces — that is arithmetic,
   * and it is done below. It cannot check that the seed is the real hash of
   * block endsAt, because that would be a chain read during replay and replay
   * asks nothing of any chain. A reader with a Base endpoint can, in one call,
   * and the act carries the hash for exactly that reason.
   */
  function peerBurnGrid(startsAt, endsAt, refHash, n) {
    var out = [];
    if (!Number.isInteger(startsAt) || !Number.isInteger(endsAt) || !Number.isInteger(n)) return out;
    var width = endsAt - startsAt;
    if (!(width > 0) || !(n > 0) || n > 64) return out;
    var hex = String(refHash == null ? '' : refHash).replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) return out;
    for (var i = 0; i < n; i++) {
      var lo = startsAt + Math.floor((width * i) / n);
      var hi = startsAt + Math.floor((width * (i + 1)) / n);
      if (hi <= lo) hi = lo + 1;
      var r = parseInt(hex.slice((i % 16) * 4, (i % 16) * 4 + 4), 16);
      var b = lo + (r % (hi - lo));
      if (!out.length || b > out[out.length - 1]) out.push(b);
    }
    return out;
  }
  /**
   * Every reason replay will refuse a peerBurn, as a sentence, or null.
   *
   * Exposed on the returned state for the same reason tokenActError is: the
   * screen and the host door should ask this question in these words BEFORE
   * anything claims to have happened, rather than filing an act that replay
   * will then quietly ignore. Note carefully what a refusal here means once
   * an act is already in the log — a host that recorded a price and a value
   * which do not match each other is either broken or lying, and replay is
   * where that gets CAUGHT rather than trusted.
   *
   * It reads only the act's own fields, the bindings already in the log, and
   * the epoch counter. No clock, no network, no pool.
   */
  function peerBurnActError(a, epoch) {
    if (!a || !known(a.id)) return 'unknown actor';
    if (typeof a.txid !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(a.txid)) return 'a PEER burn is identified by its Base transaction hash, and this one is not a transaction hash';
    // ONE SPELLING, decided here and used for every table below.
    //
    // The pattern above accepts upper-case hex because a hash is a number and
    // wallets disagree about how to print one. The dedupe table used to be
    // keyed on the raw string, so 0xABAB… and 0xabab… were one transaction to
    // Base and two keys here: the same burn credited twice, measured at 19.98
    // reserve where the burn was worth 9.99. Folded once, at the top, and
    // nothing below is allowed to look at a.txid again.
    var txk = a.txid.toLowerCase();
    // The destination is part of what makes this a burn at all. Recorded on
    // the act — like btcBurn's addr — so that changing the sink later cannot
    // make an old burn ambiguous about where its value went.
    if (String(a.addr || '').toLowerCase() !== PEER_BURN_ADDR) {
      return 'a PEER burn must pay ' + PEER_BURN_ADDR + ' — the deployed token refuses address(0) on purpose, so the sink is a dead-but-nonzero address and nothing else counts';
    }
    // ── Whose burn this is ───────────────────────────────────────────────
    //
    // The act names the address the coins left, and the log decides who that
    // address belongs to. This check lives HERE, not at the host door, and
    // the reason is a hole that was demonstrated end to end against the real
    // server: the door asked only "did this transfer come from the address
    // bound to the claiming handle", and a bindAddress act needs nothing but
    // the BINDING handle's own PIN. So a stranger bound somebody else's
    // address, claimed their burn, and took the reserve — 200 OK, 24.99
    // reserve — while the person who actually destroyed the PEER got
    // PEERBURN_ALREADY_CLAIMED, permanently, on every host. The pending list
    // published the target set and the route's own note recommended the
    // vulnerable flow.
    //
    // Two rules close it, and both are rules of the LOG:
    //
    //   1. AN ADDRESS BOUND BY MORE THAN ONE HANDLE BELONGS TO NOBODY here.
    //      Not to the first, not to the newest. First-binder-wins would make
    //      pre-binding a stranger's address a silent theft; newest-wins is
    //      what the hole above was. Ambiguity is refused, so the worst a
    //      griefer can do by binding your address is close THIS door against
    //      it — never take what comes through it. Binding is otherwise
    //      untouched: epoch earnings still pay the handle's own newest
    //      binding, and two handles may still name one address, which is a
    //      real state in the live log and must keep meaning what it meant.
    //   2. THE BINDING MUST PREDATE THE BURN. Otherwise the pending list is a
    //      shopping list: a burn from an unbound address sits there, and
    //      whoever binds that address first collects it. With this rule a
    //      binding filed after the coins were destroyed cannot reach them —
    //      by anybody, including their owner, which is the honest cost and is
    //      said in those words at the door and on the card. Bind first, then
    //      burn.
    //
    // What is NOT closed, said plainly: an attacker who binds an address
    // before its owner ever does, and before the burn, is that address's only
    // binder. They cannot be detected by this file. What they can be detected
    // by is the owner's own bind attempt — which succeeds, makes the address
    // ambiguous, and shuts the door rather than handing it over. Proving key
    // control would close it properly and needs a signature this codebase
    // cannot verify without a keccak library it does not have.
    var src = String(a.from == null ? '' : a.from).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(src)) return 'a PEER burn must record the address the coins were sent from, and this one does not';
    var own = addrBinders[src];
    if (!own || own.n === 0) {
      return 'no handle had bound ' + src + ' when those coins were destroyed, so this burn belongs to nobody — a burn is credited by a binding that was already in the log, never by one filed afterwards';
    }
    if (own.n > 1) {
      return 'more than one handle has bound ' + src + ', so whose burn this is cannot be decided from the log — an ambiguous address closes this door rather than guessing which handle to pay';
    }
    if (own.id !== a.id) {
      return src + ' is bound to ' + own.id + ' and this act credits ' + a.id + ' — a burn is credited to whoever destroyed the coins, and the log says who that was';
    }
    if (!Number.isInteger(a.blockMs) || a.blockMs <= 0) {
      return 'a PEER burn must record the timestamp of the block that destroyed the coins, and this one does not';
    }
    if (!(typeof own.ts === 'number' && own.ts <= a.blockMs)) {
      return own.ts === null
        ? src + ' was bound by an act that carries no time, so nothing here can say the binding came before the burn'
        : src + ' was bound after those coins were destroyed, so the binding cannot reach them — bind the address first, then burn from it';
    }
    // ── Which pool these reserves came out of ────────────────────────────
    //
    // A pool id ALONE is not an identity and this act used to carry only the
    // id. PeerPools indexes by id and lets two creators claim one name, so
    // "the reserves were 3 and 4" is checkable only if it also says WHOSE
    // contract's pool 3 — and a reader replaying the log saw `pool: 0` and
    // could not tell the operator's PEER/cbBTC pool from one anybody deployed
    // an hour earlier. The factory address is recorded for that reason.
    //
    // The engine does NOT pin a particular factory. It cannot honestly: no
    // pools factory is deployed anywhere yet, so a constant here would be an
    // address this codebase invented. What it does is make the choice VISIBLE
    // in every act, which is the difference between host configuration a
    // reader can audit and host configuration a reader cannot see.
    if (!Number.isInteger(a.pool) || a.pool < 0) return 'a PEER burn must name the pool it was priced against';
    if (typeof a.factory !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a.factory)) {
      return 'a PEER burn must name the factory contract the pool lives in — a pool id with no factory behind it is not an identity, because two factories both have a pool ' + a.pool;
    }
    var sats = peerBurnSats(a.amtRaw, a.resPeerRaw, a.resBtcRaw);
    if (sats === null) return 'the recorded amount and pool reserves are not three positive whole numbers, so there is no price to check';
    // ── The two cross-checks that make the act self-proving ──────────────
    // The act states a satoshi value and a reserve credit. Both are RECOMPUTED
    // here from the reserves the same act recorded, and any disagreement
    // refuses the whole thing. This is what makes "the act carries what was
    // verified" a checkable statement instead of a promise.
    if (a.sats !== sats) {
      return 'this act records ' + a.sats + ' sat but its own reserves price the burn at ' + sats + ' sat — a host that disagrees with itself is not evidence of anything';
    }
    if (a.reserve !== sats / SATS_PER_RESERVE) {
      return 'this act records ' + a.reserve + ' reserve for ' + sats + ' sat, and the rate is ' + SATS_PER_RESERVE + ' sat per unit for BOTH doors';
    }
    // ── The anti-manipulation floors, checked against what was recorded ───
    // The host does the time-weighting; replay cannot, and should not try.
    // What replay CAN do is refuse an act whose own record admits it was
    // priced from too short a window, too few samples, a pool too thin to have
    // a price — or a sample grid that is not the one its own recorded seed
    // produces, which is the check that makes the window mean anything.
    if (!(BigInt(a.resBtcRaw) >= BigInt(PEER_BURN_MIN_POOL_SATS))) {
      return 'the pool held ' + a.resBtcRaw + ' sat of bitcoin and a burn needs at least ' + PEER_BURN_MIN_POOL_SATS + ' — below that a pool has no price, only a last trade';
    }
    if (!(Number(a.twapMs) >= PEER_BURN_TWAP_MS)) {
      return 'the price was averaged over ' + a.twapMs + ' ms and at least ' + PEER_BURN_TWAP_MS + ' is required — a spot price is whatever the last trade left behind';
    }
    if (!(Number(a.obs) >= PEER_BURN_TWAP_OBS)) {
      return 'the price came from ' + a.obs + ' observation(s) and at least ' + PEER_BURN_TWAP_OBS + ' are required';
    }
    // Where the window sat, and which blocks inside it were actually read.
    if (!Number.isInteger(a.startsAt) || !Number.isInteger(a.endsAt) || a.startsAt < 0 || a.endsAt <= a.startsAt) {
      return 'a PEER burn must record the block range its price was averaged over, and this one does not';
    }
    if (typeof a.refHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(a.refHash)) {
      return 'a PEER burn must record the hash of the block its window ends at — that hash is what decides which blocks were sampled, and without it the sampling is unauditable';
    }
    if (!Array.isArray(a.blocks) || a.blocks.length !== Number(a.obs)) {
      return 'a PEER burn must list the blocks its price was read at, one per observation it claims';
    }
    var grid = peerBurnGrid(a.startsAt, a.endsAt, a.refHash, PEER_BURN_GRID);
    var gi = 0;
    for (var bi = 0; bi < a.blocks.length; bi++) {
      var bb = a.blocks[bi];
      if (!Number.isInteger(bb)) return 'a PEER burn lists a sampled block that is not a whole number';
      while (gi < grid.length && grid[gi] < bb) gi++;
      if (gi >= grid.length || grid[gi] !== bb) {
        // Not on the grid its own seed produces. That is either a host that
        // sampled where it liked — the whole attack this seeding exists to
        // stop — or a host running different sampling rules from the network's.
        return 'block ' + bb + ' is not one the recorded window and block hash select, so these readings were not sampled by the rule this network uses';
      }
      gi++;
    }
    // ── The ceilings ─────────────────────────────────────────────────────
    //
    // Counted in SATOSHIS rather than in reserve. Reserve is a divided number
    // and accumulating it drifted (99.99000000000252 against a cap of 100 was
    // measured); satoshis are integers all the way and two hosts adding them
    // in different orders still agree.
    if (!Number.isInteger(a.creditsSats) || a.creditsSats <= 0 || a.creditsSats > sats) {
      return 'a PEER burn must state how many of its own satoshis this act converts to reserve, between 1 and ' + sats;
    }
    // 1. ONE TRANSACTION, CREDITED UP TO ITS OWN VALUE AND NEVER PAST IT.
    //
    //    This used to be "claimed once, ever", the promise burnedTx makes for
    //    bitcoin, and it made a burn LARGER than one epoch's allowance
    //    permanently worthless: the ceiling test refused the act whole, `used`
    //    resets every epoch, so `0 + reserve > 100` was true in every epoch
    //    that will ever exist. Against the project's own fixture pool that
    //    line is crossed at about 1,101 PEER — an ordinary amount — and the
    //    refusal said 'claim the rest next epoch' when there was no rest and
    //    no such epoch. The engine now credits a transaction ACROSS epochs and
    //    each act states its own slice, so the property that mattered ("the
    //    act says what it credited") is kept without the lie beside it.
    var doneSats = peerBurnTxSats[txk] || 0;
    if (doneSats > 0 && peerBurnTxBy[txk] !== a.id) {
      return 'that transaction has already been claimed, by ' + peerBurnTxBy[txk] + ' — a burn is claimed once, ever';
    }
    if (doneSats + a.creditsSats > sats) {
      return 'that transaction is worth ' + sats + ' sat and ' + doneSats + ' of it has already been credited, so this act cannot credit another ' + a.creditsSats + ' — a burn is claimed once, ever, up to its own value';
    }
    // 2. THE PER-ACCOUNT PER-EPOCH CEILING.
    if (epoch >= PEER_BURN_CAP_FROM_EPOCH) {
      var used = peerBurnEpochUse[a.id + '@' + epoch] || 0;
      if (used + a.creditsSats > PEER_BURN_SATS_PER_EPOCH) {
        var leftR = (PEER_BURN_SATS_PER_EPOCH - used) / SATS_PER_RESERVE;
        return 'burning PEER creates at most ' + PEER_BURN_RESERVE_PER_EPOCH + ' reserve per account per epoch and this handle has ' + leftR + ' left — the burn stays valid and what is left of it is claimable after the next epoch closes';
      }
      // 3. THE PER-POOL PER-EPOCH AGGREGATE.
      //
      //    Without this the per-account ceiling bounds nothing at all, because
      //    handles are free and open at zero: three hundred of them filling
      //    the allowance against a pool holding 1,000,000 sat created
      //    2,710,000 sat of "value destroyed", 3.6x what selling the same PEER
      //    into that pool could ever have realised, and it scales linearly
      //    with the number of accounts. Reserve is defined as value destroyed
      //    measured in satoshis; a door that mints more of them than existed
      //    on the bitcoin side it is priced against is not measuring anything.
      //
      //    The bound is the pool's OWN bitcoin side, as this act recorded it:
      //    in one epoch, a pool cannot create more reserve than it holds
      //    bitcoin. It is still generous — the pool could not actually pay
      //    that out — and it is a CHOICE, like every number in this block. It
      //    is first come, first served within an epoch, which is a real cost:
      //    a busy pool can be exhausted by early burners. The alternative was
      //    a queue, and a queue would decide the price of speech by who was
      //    awake.
      var pk = String(a.factory).toLowerCase() + '#' + a.pool + '@' + epoch;
      var poolUsed = peerBurnPoolUse[pk] || 0;
      // Reserve is sats ÷ SATS_PER_RESERVE, so "no more reserve than the pool
      // holds bitcoin" is, in satoshis, exactly the pool's bitcoin side.
      var poolCap = Number(BigInt(a.resBtcRaw));
      if (!Number.isSafeInteger(poolCap)) return 'the pool records more satoshis than will ever exist';
      if (poolUsed + a.creditsSats > poolCap) {
        return 'pool ' + a.pool + ' at ' + String(a.factory).toLowerCase() + ' held ' + a.resBtcRaw
          + ' sat and has already created ' + (poolUsed / SATS_PER_RESERVE) + ' reserve this epoch — one pool cannot create more reserve in an epoch than it holds bitcoin, so the rest of this burn is claimable after the next epoch closes';
      }
    }
    return null;
  }
  function debit(id) {
    var l = ledgerById[id];
    if (!l) return;
    l.burnBal -= THETA; l.actCount += 1; deltaActs[id] = (deltaActs[id] || 0) + 1;
  }
  function vouch(author, target, p, r) {
    var key = author + '>' + target;
    var b = bundles[key] || (bundles[key] = { src: author, rcp: target, pd: 0, pi: 0 });
    b.pd += p; b.pi += r;
  }
  // ── The PEER token and its pools ──────────────────────────────────────────
  //
  // Ported from the poolsite economy (github.com/enderPeer/poolsite), mapped
  // onto the epoch machinery: what poolsite distributed per DAY, this network
  // distributes per EPOCH CLOSE. 5000 PEER per epoch in year one, emission
  // decaying 0.9 per 365 epochs, hard cap 18,250,000 — poolsite's own curve.
  //
  // Distribution follows engagement, not headcount: reactions (1.0), comments
  // (1.2) and dislikes (0.3) on someone ELSE's content weigh toward that
  // creator, damped per actor->creator pair (1/(1+0.3·(n−1)) — the tenth nudge
  // from the same fan is worth a fraction of the first) and scaled by the
  // actor's commitment rate λ(α̂)=α̂/(1+α̂), gated at α̂ ≥ 0.2. An account that
  // never burned cannot weigh; a swarm of empty accounts distributes nothing.
  // Self-engagement never counts. Rounding dust and empty epochs carry over.
  //
  // Tokens are VALUE, not standing. No token act creates a graph edge, no
  // balance enters any score, and the feed cannot see any of this — the same
  // wall that keeps paid placements outside the protocol keeps the token
  // market outside the reputation system. Money and standing touch nowhere.
  //
  // tBTC is a test asset with a bitcoin-shaped name: one small claim per
  // account, no backing, no bridge, no custody — the host holds no keys, so
  // real BTC cannot live here and the symbol says so honestly.
  var TOK_EPOCH = 5000, TOK_DECAY = 0.9, TOK_YEAR = 365, TOK_CAP = 18250000;
  var TOK_DIM = 0.3;
  // One "unit" of committed value, in satoshis. Only the RATIO between
  // burners matters for who gets what share of an epoch, so this number sets
  // no price and promises nothing — it exists so the weights print as small
  // readable numbers rather than tens of thousands.
  var TOK_SAT_UNIT = 1000;
  // Satoshis per unit of reserve — the price of the energy acts are debited
  // from, when that energy comes from a real burn. See the btcBurn branch.
  var SATS_PER_RESERVE = 100;
  // ── The second door: PEER destroyed, priced by the pool ────────────────
  //
  // Reserve is VALUE DESTROYED. Until now the only way to destroy value here
  // was to destroy bitcoin, and that is a large part of why this network has
  // twelve actors: demanding real BTC before anyone may say a word is a toll
  // most people will not pay to try something out. So a second door opens —
  // burn PEER, and get reserve worth the same as the bitcoin that PEER was
  // worth. The first door is untouched: every btcBurn already in the log
  // credits exactly what it credited yesterday.
  //
  // Both doors buy reserve at SATS_PER_RESERVE, the SAME constant, and that
  // sharing is the whole design rather than a convenience. If the two doors
  // priced reserve differently, one of them would be a discount on speech and
  // this network would have two classes of speaker.
  //
  // THE PRICE COMES FROM THE POOL, AND REACHES REPLAY ONLY THROUGH THE ACT.
  // The official pair is PEER/cbBTC, so the pool already quotes PEER in
  // satoshis and no currency oracle is needed at all. A euro figure is a
  // DISPLAY conversion for humans and never enters any arithmetic below: if
  // the euro source is down a screen loses a caption and not one number here
  // moves. And a price fetched DURING replay would end this engine's central
  // claim — that anyone can recompute the world from the public log without
  // asking any host or any chain — and would stop every published epoch
  // certificate from reproducing. So the act RECORDS the reserves the host
  // read, and replay does arithmetic on those recorded numbers and nothing
  // else. Exactly the btcBurn discipline: the act carries what was verified,
  // the chain carries the proof.
  //
  // ── What a thin pool would otherwise let you buy ───────────────────────
  //
  // Constant-product price is whatever the last trade left behind. With a
  // shallow pool an attacker pumps it, burns PEER at the inflated rate,
  // harvests reserve, and lets the price fall back. That is the ordinary
  // oracle attack, except that here it is pointed at the one thing this
  // network says cannot be bought. Six defences answer it, and every one of
  // them is a CHOICE about the price of speech rather than a measurement of
  // anything. Nobody should read these numbers as discoveries.
  //
  // 1. The price must be TIME-WEIGHTED over at least this long, from at least
  //    this many observations — never the spot price of one block. Thirty
  //    minutes on a two-second chain is roughly nine hundred blocks.
  //
  //    Be careful with the sentence that used to sit here. It said an attacker
  //    "has to hold a false price across all of them", and that was FALSE as
  //    written, because a window is only as good as where inside it the host
  //    looks. Sixteen readings on a publicly derivable arithmetic grid meant
  //    holding the price for 1.4% of the window, not all of it. What makes the
  //    sentence true is peerBurnGrid above: the sampled blocks are chosen by
  //    the reference block's own hash, so they cannot be known in advance and
  //    a pump that lasts f of the window is caught about f of the time. The
  //    window is the claim; the seeded grid is what makes the claim hold.
  //
  //    A longer window costs an honest burner accuracy; a shorter one costs
  //    the network its defence. There is no market setting this and no theory
  //    that picks it.
  var PEER_BURN_TWAP_MS = 30 * 60 * 1000;
  var PEER_BURN_TWAP_OBS = 12;
  //    ...and this many buckets are cut across the window, one sampled block
  //    per bucket. Declared HERE rather than in the host's chain reader for
  //    the reason every other floor is: replay re-derives the grid and refuses
  //    an act whose blocks are not on it, so the number the host samples with
  //    and the number replay checks with have to be one number. Sixteen
  //    against an observation floor of twelve, so a few unreadable blocks cost
  //    accuracy rather than the whole quote.
  var PEER_BURN_GRID = 16;
  // 2. Below this much bitcoin in the pool a burn is REFUSED IN WORDS rather
  //    than priced badly. 0.01 cbBTC, in satoshis. A pool this shallow does
  //    not have a price; it has a last trade, and treating one as the other
  //    would mint the right to speak out of somebody's rounding error. Note
  //    what this means today: there is no PEER/cbBTC pool at all, so this
  //    door is shut and says so, which is the honest state and not a bug.
  var PEER_BURN_MIN_POOL_SATS = 1000000;
  // 3. The most reserve ONE ACCOUNT can create this way in ONE EPOCH. 100
  //    reserve is 10,000 satoshis' worth — deliberately the same example the
  //    SATS_PER_RESERVE comment above already uses, about 190 acts at
  //    θ ≈ 0.0528. Enough to speak freely for an epoch; not enough for one
  //    manipulated half-hour to buy a year of it.
  //
  //    The bitcoin door carries no such ceiling and needs none. Nobody
  //    manipulates the price of bitcoin to themselves, and a BTC burn
  //    destroys exactly the number of satoshis it says it destroys — there is
  //    no price in it to be wrong about. This ceiling exists precisely
  //    because the PEER door has a price, and a price can be lied to.
  var PEER_BURN_RESERVE_PER_EPOCH = 100;
  // The same ceiling in satoshis, which is the unit it is actually counted in.
  // Reserve is a divided number; adding divided numbers drifted (a measured
  // 99.99000000000252 against a cap of 100), and while that drift happened to
  // run in the network's favour, "happens to round the right way" is not a
  // rule. Satoshis are integers from the pool read to the ledger.
  var PEER_BURN_SATS_PER_EPOCH = PEER_BURN_RESERVE_PER_EPOCH * SATS_PER_RESERVE;
  //
  // 4. THE PER-POOL PER-EPOCH AGGREGATE. The per-account ceiling on its own
  //    bounds one account and nothing else, and accounts are free — a handle
  //    "opens at zero, nothing granted", so three hundred of them cost three
  //    hundred registrations. Measured: 300 handles each filling the ceiling
  //    once against a pool at exactly the minimum depth created 27,100
  //    reserve, 2,710,000 satoshis of value-destroyed, against a pool holding
  //    1,000,000 satoshis in total and able to realise about 749,600 of them.
  //    So one pool creates at most as many satoshis of reserve in one epoch as
  //    it holds satoshis of bitcoin. See the check in peerBurnActError; the
  //    figure is the pool's own recorded bitcoin side, not a constant, because
  //    a constant would be this file guessing how deep a pool ought to be.
  //
  //    ...and it binds from epoch 0, which is the one place this departs from
  //    FAUCET_CAP_FROM_EPOCH. That bound had to start ahead of the live
  //    record, because applying it backwards would have recomputed standings
  //    already sealed inside published epoch certificates. This one has no
  //    history to rewrite: `peerBurn` is a new act type and there is not one
  //    of them in any log anywhere, so "from epoch 0" and "from a future
  //    epoch" name the same set of acts — the empty one. The constant is
  //    written out rather than inlined as `always` so that a LATER tightening
  //    has somewhere to start that is ahead of the record, the way the
  //    faucet's did.
  var PEER_BURN_CAP_FROM_EPOCH = 0;
  // 5. The burn must be a REAL, VERIFIED, ON-CHAIN DESTRUCTION — and this is
  //    where the two doors stop being equals. SAY SO WHEREVER THEY ARE SHOWN
  //    TOGETHER. The bitcoin address is a P2WSH commitment to a script that
  //    cannot be satisfied: unspendable by ARITHMETIC, and anyone can check
  //    the arithmetic themselves. This address is unspendable only because
  //    nobody knows a key for it — a far weaker claim, resting on the size of
  //    a search space rather than on a proof. Both are called "burns"; only
  //    one of them is provable, and an interface that prints them side by
  //    side without that sentence is lying on the chain's behalf.
  //
  //    address(0) is not an option: the deployed PeerToken REFUSES transfers
  //    to it, deliberately, so that its supply figure keeps exactly one
  //    meaning. The destination is therefore the conventional dead address —
  //    chosen because it is the most-watched non-zero sink on every EVM chain
  //    and the one a reader recognises without being told what it is.
  //    Lowercase here because every comparison below folds case first.
  var PEER_BURN_ADDR = '0x000000000000000000000000000000000000dead';
  // 6. AND IT MUST BE YOURS, decided by the log rather than by whoever asks.
  //    The address the coins left has to have been bound by exactly one handle
  //    — that handle — before the block that destroyed them. See the ownership
  //    block inside peerBurnActError for the theft this answers and for what
  //    it still does not close.
  //
  // Base tx hash (LOWER CASE) -> account, so one PEER burn is claimed by
  // exactly one handle, ever — the promise burnedTx makes for bitcoin, kept in
  // a SEPARATE table because these are different chains. Sharing one table
  // would make a bitcoin txid and a Base transaction hash interchangeable
  // inside the one structure whose entire job is to say which burn was already
  // paid for.
  var peerBurnTxBy = bare();
  // ...and, beside it, HOW MUCH of that transaction has been converted so far,
  // in satoshis. Two tables rather than one boolean because a burn worth more
  // than an epoch's allowance is credited across several epochs: the promise is
  // "claimed once, ever, up to its own value", not "claimed once and the rest
  // is forfeit". The old shape made a 100,000 PEER burn worth nothing at all,
  // permanently, while telling the burner to come back next epoch.
  var peerBurnTxSats = bare();
  // (id '@' epoch) -> SATOSHIS this account has already converted to reserve by
  // burning PEER in that epoch. Satoshis, not reserve: see
  // PEER_BURN_SATS_PER_EPOCH.
  var peerBurnEpochUse = bare();
  // (factory '#' pool '@' epoch) -> satoshis that pool has created this epoch.
  // The aggregate bound, which is the one that makes the per-account ceiling
  // mean something on a network where accounts are free.
  var peerBurnPoolUse = bare();
  // id -> raw PEER destroyed, all-time. Display only: it is deliberately NOT
  // burnedSats and it weighs NOTHING. See the peerBurn branch.
  var peerBurnedRaw = bare();
  // address -> who may claim burns from it, decided by the bindings in the log.
  //   { n: how many distinct handles have ever bound it,
  //     id: that handle when n === 1, else null,
  //     ts: that handle's EARLIEST binding time, else null,
  //     seen: handle -> earliest binding time }
  // Filled in the bindAddress branch, which is otherwise unchanged: this map is
  // read only by the PEER door, so nothing about where epoch earnings are paid
  // moves. That separation is deliberate — the live log already contains one
  // address bound by two handles, and making binding itself first-come would
  // have rewritten an earnings root that is already published.
  var addrBinders = bare();
  var TBTC_CLAIM = 0.01;
  var TOK_MINLIQ = 1e-9; // locked forever at pool birth — kills the classic
                         // first-depositor share-inflation attack
  var tokenBal = bare();     // sym -> { actor -> amount }
  var tokenMeta = Object.assign(bare(), { PEER: { name: 'Peer epoch token', creator: null },
                    // tBTC is gone. It was a bitcoin-shaped name on a number
                    // this code invented, and after the restart there is no
                    // supply of it and no way to claim any. Kept in the table
                    // only so a pre-restart log still replays; it can hold no
                    // balance, because none was ever minted after genesis.
                    tBTC: { name: 'retired — never real bitcoin, no supply, nothing mints it', creator: null } });
  var tokenSupply = Object.assign(bare(), { PEER: 0, tBTC: 0 });
  var btcClaimed = bare();
  var pools = bare();        // 'A/B' -> { a, b, resA, resB, totalShares, shares: {actor->amt} }
  var tokenDist = [];    // per epoch: { epoch, minted, carried, to: {id: amt} }
  // ── Adverts ───────────────────────────────────────────────────────────
  //
  // An advert is now an ACT, paid for in tBTC, and it goes up the moment it
  // lands. That is a deliberate reversal of the earlier design, which quoted a
  // real bitcoin price and waited for a person to approve it: on a test
  // network, play money and instant publication are honest, while real money
  // and a review queue were ceremony around something nobody could actually
  // buy. Publish-then-moderate, not moderate-then-publish — the author or the
  // operator can stop one afterwards.
  //
  // What has NOT changed, and must not: an advert mints no node, creates no
  // edge, compiles no vouch and holds no standing. Being in the log makes its
  // payment verifiable; it does not put it in the graph. Money still buys a
  // box and nothing else.
  //
  // The tBTC paid is BURNED rather than transferred. Advertising should
  // destroy value the way every other commitment here does — routing it to an
  // operator would make the one party who cannot be voted out the only party
  // who profits from attention.
  // An advert costs PEER, and the PEER is DESTROYED — not paid to the
  // operator, not paid to anyone. It used to be priced in tBTC, which was a
  // faucet asset, so a placement cost its buyer nothing real and the
  // "burn" reduced a supply that had been conjured anyway.
  //
  // PEER is the network's own scarce thing now: minted only by the epoch
  // distribution, and obtainable by anyone else only from a pool INSIDE
  // this log. It is NOT the ERC-20 called PEER on Base. That token shares
  // the name and the symbol and nothing else: there is no bridge in either
  // direction, and nothing in this engine, on any host, or on any chain
  // credits this balance from anything held in a wallet. tokCredit at the
  // epoch close and an in-log poolSwap are the only two writers there are.
  // So buying attention means buying PEER from people who earned it and
  // then destroying it, which is the one arrangement where advertising
  // pays the network's participants rather than its operator.
  var AD_PEER_PER_DAY = 10;
  var adverts = [];      // {id, by, text, url, days, paid, at, until, aim, stopped}
  var adSeq = 0;
  var earnedBurn = bare();   // burn an account acquired, EXCLUDING the register grant
  // Value this account destroyed on the Bitcoin chain, in satoshis, proven by
  // a txid anyone can check. Not a balance and not a claim: the coins are
  // gone, paid to a script that can never be satisfied. This is the ONLY
  // thing that weighs in the token distribution now — see TOK_SAT_UNIT.
  var burnedSats = bare();
  var burnedTx = bare();     // txid -> account, so one burn is claimed exactly once
  var tokenEpoch0 = 0;   // epochs before a resetTokens act pay nobody
  var tokenCarry = 0;
  var tokEpochN = 0;
  var epochEngage = [];  // {actor, creator, base} since the last close

  // ── Where an epoch's earnings can actually be paid ─────────────────────
  //
  // tokenDist pays NETWORK IDENTITIES (u_ender). An on-chain claim pays an
  // ETHEREUM ADDRESS. A 'bindAddress' act is the whole bridge: signed with
  // the handle's own credential like every other act, newest one winning.
  //
  // Two maps, because one is not enough. `addrOf` is the binding as it stands
  // NOW — what a screen should show, and what the next epoch will pay to.
  // `addrAtEpoch` is a snapshot taken at each close, keyed by the same epoch
  // number tokenDist carries, and it is what an earnings tree must be built
  // from: a root published for epoch 12 cannot change when somebody rebinds
  // in epoch 13, and building from the live map would silently recompute a
  // root that is already public and already anchored. Rebinding is allowed
  // and takes effect FORWARD ONLY, and this pair is what makes that true
  // rather than merely stated.
  var addrOf = {};
  var addrAtEpoch = {};
  // Shape-checked HERE and not only at the host door, for the reason the
  // retired Layer-0 branches give: this file is what a foreign, mirrored or
  // hand-edited log passes through, and a rule enforced at one door is not a
  // rule. Lowercase because that is the exact byte string the claim leaf
  // hashes (chain/earnings.mjs, PeerClaim._hex); the zero address is refused
  // because a leaf paying it is PEER nobody can ever claim.
  function bindableAddress(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(s)) return '';
    if (s === '0x0000000000000000000000000000000000000000') return '';
    return s;
  }

  // ── Prender Markets ───────────────────────────────────────────────────────
  //
  // A bet is a POST. It mints a Content node through the same path a note, a
  // gathering or a broadcast takes, so reactions, comments, quotes and tags
  // land on it unchanged and the epoch mint sees it without knowing markets
  // exist at all. What hangs off that node is a parimutuel pool and a jury.
  //
  // The whole shape in one paragraph. Whoever asks the question names two to
  // seven answers, the asset stakes are denominated in, the bond a moderator
  // must post, and a resolution fee capped at 5% — all of it visible on the
  // card before anybody stakes a satoshi's worth. Anyone may back an answer;
  // stakes leave their balance and sit in escrow. Anyone may STAND for a
  // moderator seat by posting the bond, and the community elects the seats by
  // approval vote. Seated moderators each certify one answer, and a strict
  // majority resolves the market the moment it lands.
  //
  // Then value moves once, in one direction: backers of the resolved answer
  // split the pool pro rata, a moderator who certified AGAINST the resolution
  // forfeits their bond into that same pool, and the fee is split half to the
  // question's author and half among the moderators who called it right.
  //
  // WHAT WEIGHS A VOTE, and why it is not standing. Seats are elected with
  // satoshis the voter proved they destroyed — the same weight the epoch mint
  // uses, and the only scarce thing here that cannot be bought back, borrowed,
  // or split across puppets. Standing is deliberately not consulted. Money
  // must never buy reputation, and reputation must never be the thing that
  // decides who gets paid: the wall only holds if neither side crosses it.
  //
  // No market act appends an edge, compiles a vouch, or enters a certificate.
  // Being right about the future is evidence of nothing, and this network says
  // so in code rather than in a paragraph.
  var MKT_MIN_OPTS = 2, MKT_MAX_OPTS = 7;
  var MKT_FEE_MAX_BP = 500;                     // 5% of the pool, and no more
  var MKT_SEATS = { 1: true, 3: true, 5: true }; // odd only: a majority must exist
  // How long a jury has to certify once betting closes. NOTHING in this file
  // applies it — a replay that consulted a clock would stop being a pure
  // function of the log. It is published here because the host enforces it and
  // the screen draws it, and two copies of one number drift: a card offering a
  // 'call time' button the door then refuses is the interface lying.
  var MKT_RESOLVE_MS = 7 * 24 * 60 * 60 * 1000;
  var markets = bare();      // cid -> the record built in the 'market' branch

  function round6(x) { return Math.round(x * 1e6) / 1e6; }
  function balOf(sym, id) { return (tokenBal[sym] && tokenBal[sym][id]) || 0; }
  function tokCredit(sym, id, amt) {
    if (!(amt > 0)) return;
    var m = tokenBal[sym] || (tokenBal[sym] = bare());
    m[id] = (m[id] || 0) + amt;
  }
  function tokDebit(sym, id, amt) {
    // Was a bare `tokenBal[sym][id] -= amt`, which throws a TypeError for a
    // symbol nobody has ever held — and a replay that throws takes the host
    // down with it, because every request replays the log. It also happily
    // subtracted a negative amount, which is a credit wearing a debit's name:
    // with a negative fee, debit-then-credit mints currency out of nothing.
    // Both are refused here as well as at the door, because this file is the
    // last thing a foreign or hand-edited log passes through.
    if (!(amt > 0)) return;
    var m = tokenBal[sym] || (tokenBal[sym] = bare());
    m[id] = (m[id] || 0) - amt;
  }
  function poolId(x, y) { return x < y ? x + '/' + y : y + '/' + x; }

  /**
   * Can this token act apply against the current state? One function, used by
   * the host to refuse and by the replay to skip, so the two can never
   * disagree about what a log means. Returns null or a sentence.
   */
  function tokenActError(a) {
    var who = a.author;
    // Deliberately NOT gated on deletedActors. Deletion is retroactive in this
    // replay, so rejecting here would erase the whole token history of anyone
    // who later left — including pools other people funded and traded in, and
    // including the epoch shares everybody else was measured against. Removal
    // takes the payload, never the record, and a value transfer IS record. The
    // host refuses NEW acts from a deleted account one layer up, where the
    // question is 'may this happen now' rather than 'did this happen'.
    if (!ledgerById[who]) return 'unknown actor';
    if (ledgerById[who].burnBal < THETA) return 'not enough energy';
    if (a.t === 'burn') {
      // Asked by the host before it accepts one, so a refusal arrives as a
      // sentence rather than as an act that silently does nothing.
      if (certsSoFar < FAUCET_CAP_FROM_EPOCH) return null;
      var used = faucetCount[who + '@' + certsSoFar] || 0;
      if (used >= FAUCET_PER_EPOCH) {
        return 'the faucet gives ' + FAUCET_PER_EPOCH + ' per epoch and this handle has taken them all — burn live units through Layer 0 instead, or wait for the next epoch';
      }
      return null;
    }
    if (a.t === 'rsvp') {
      var rev = events[a.cid];
      if (!rev) return 'no such event';
      if (rev.host === who) return 'the host is already at their own event';
      // Capacity first: it applies whether or not there is money involved. It
      // was behind the fee check, so a free event had no capacity at all.
      if (rev.cap > 0 && countGoing(a.cid) >= rev.cap && !(eventGoing[a.cid] || {})[who]) {
        return 'this event is full — ' + rev.cap + ' places, all taken';
      }
      if (!(rev.fee > 0)) return null;              // free entry, nothing to move
      // The act must NAME what it is paying and to whom. Reading the price out
      // of state at apply time would let the organiser reprice between the
      // moment somebody reads the card and the moment their answer lands —
      // the same reason poolSwap carries minOut.
      if (a.cur !== rev.cur || round6(a.amt) !== round6(rev.fee) || a.to !== rev.host) {
        return 'this event now asks ' + fmtAmt(rev.fee) + ' ' + rev.cur + ' — the price moved';
      }
      if (balOf(rev.cur, who) < rev.fee) {
        return 'you hold ' + fmtAmt(balOf(rev.cur, who)) + ' ' + rev.cur + ' and entry is ' + fmtAmt(rev.fee);
      }
      if (rev.cap > 0 && countGoing(a.cid) >= rev.cap && !(eventGoing[a.cid] || {})[who]) {
        return 'this event is full — ' + rev.cap + ' places, all taken';
      }
      return null;
    }
    if (a.t === 'advert') {
      var days = Math.floor(a.days);
      if (!(days >= 1 && days <= 90)) return 'an advert runs between 1 and 90 days';
      if (typeof a.text !== 'string' || !a.text.trim()) return 'the advert needs text';
      if (a.text.length > 280) return 'advert text is ' + a.text.length + ' characters; the limit is 280';
      if (typeof a.url !== 'string' || !/^https?:\/\/[^\s]{3,300}$/i.test(a.url)) return 'url must be a plain http(s) link';
      var cost = round6(AD_PEER_PER_DAY * days);
      if (balOf('PEER', who) < cost) {
        return 'this advert costs ' + cost + ' PEER for ' + days + ' day(s) and you hold ' + round6(balOf('PEER', who))
          + '. This PEER is the epoch token in this log: it is earned by drawing engagement, or bought in a pool inside this log. The PEER on Base is a different token that shares the name and cannot pay for a placement.';
      }
      return null;
    }
    if (a.t === 'adStop') {
      var ad = null;
      for (var ai = 0; ai < adverts.length; ai++) if (adverts[ai].id === a.ad) ad = adverts[ai];
      if (!ad) return 'no advert with id ' + a.ad;
      if (ad.by !== who && !a.operator) return 'only the advertiser can stop their own advert';
      return null;
    }
    if (a.t === 'btcClaim') {
      // The faucet is closed — from a FUTURE epoch, exactly like the faucet
      // ceiling above and for the same reason. Refusing it outright would
      // make the replay skip claims that are already in the log, which would
      // retroactively delete balances people are holding, break every pool
      // funded with them, and stop sealed epoch state from reproducing. A
      // rule that starts ahead of the record changes what happens next
      // without rewriting what happened.
      return 'tBTC is retired — it was never bitcoin. Value here comes from a verified Bitcoin burn (GET /api/burn) and from nothing else.';
    }
    if (a.t === 'assetCreate') {
      if (!/^[A-Z][A-Z0-9]{2,7}$/.test(a.sym || '')) return 'symbol must be 3-8 characters, A-Z and digits, starting with a letter';
      if (tokenMeta[a.sym]) return 'symbol ' + a.sym + ' is taken';
      if (!(a.supply > 0) || a.supply > 1e9) return 'supply must be between 0 and 1,000,000,000';
      if (typeof a.name !== 'string' || !a.name.trim() || a.name.length > 60) return 'the asset needs a name, at most 60 characters';
      return null;
    }
    if (a.t === 'tokenSend') {
      if (!tokenMeta[a.sym]) return 'no such asset: ' + a.sym;
      if (!(a.amt > 0)) return 'amount must be positive';
      if (!ledgerById[a.to]) return 'unknown recipient'; // see above: a send to someone who left still happened
      if (a.to === who) return 'sending to yourself moves nothing';
      if (balOf(a.sym, who) < a.amt) return 'balance is ' + round6(balOf(a.sym, who)) + ' ' + a.sym + ', tried to send ' + a.amt;
      return null;
    }
    if (a.t === 'poolCreate') {
      if (!tokenMeta[a.symA] || !tokenMeta[a.symB]) return 'both assets must exist';
      if (a.symA === a.symB) return 'a pool needs two different assets';
      if (pools[poolId(a.symA, a.symB)]) return 'the ' + poolId(a.symA, a.symB) + ' pool already exists — add liquidity to it instead';
      if (!(a.amtA > 0) || !(a.amtB > 0)) return 'both starting amounts must be positive';
      if (balOf(a.symA, who) < a.amtA) return 'balance is ' + round6(balOf(a.symA, who)) + ' ' + a.symA + ', tried to deposit ' + a.amtA;
      if (balOf(a.symB, who) < a.amtB) return 'balance is ' + round6(balOf(a.symB, who)) + ' ' + a.symB + ', tried to deposit ' + a.amtB;
      if (Math.sqrt(a.amtA * a.amtB) <= TOK_MINLIQ * 10) return 'starting liquidity too small';
      return null;
    }
    var pl = pools[a.pool];
    if (a.t === 'poolAdd') {
      if (!pl) return 'no such pool: ' + a.pool;
      if (!(a.amtA > 0) || !(a.amtB > 0)) return 'both amounts must be positive';
      var r = Math.min(a.amtA / pl.resA, a.amtB / pl.resB);
      if (balOf(pl.a, who) < r * pl.resA || balOf(pl.b, who) < r * pl.resB) return 'not enough balance for that deposit';
      return null;
    }
    if (a.t === 'poolRemove') {
      if (!pl) return 'no such pool: ' + a.pool;
      var own = (pl.shares[who] || 0);
      if (!(a.shares > 0) || a.shares > own + 1e-12) return 'you hold ' + round6(own) + ' shares of ' + a.pool + ', tried to remove ' + a.shares;
      return null;
    }
    if (a.t === 'poolSwap') {
      if (!pl) return 'no such pool: ' + a.pool;
      if (a.sell !== pl.a && a.sell !== pl.b) return a.pool + ' does not trade ' + a.sell;
      if (!(a.amt > 0)) return 'amount must be positive';
      if (balOf(a.sell, who) < a.amt) return 'balance is ' + round6(balOf(a.sell, who)) + ' ' + a.sell + ', tried to sell ' + a.amt;
      var rin = a.sell === pl.a ? pl.resA : pl.resB;
      var rout = a.sell === pl.a ? pl.resB : pl.resA;
      var out = rout * (a.amt * 0.997) / (rin + a.amt * 0.997);
      if (a.minOut !== undefined && out < a.minOut) return 'that trade would return ' + round6(out) + ', below your minimum of ' + a.minOut + ' — the price moved';
      return null;
    }
    return 'unknown token act';
  }

  /**
   * Who holds the moderator seats, right now, according to the log.
   *
   * Approval voting: a ballot names up to `seats` candidates and the voter's
   * whole weight backs each name. Weight is satoshis destroyed, so a stake
   * split across twenty puppets weighs exactly what one account holding it
   * weighs — the same argument that closed the sybil hole in the epoch mint.
   *
   * Ties break by bond, then by id. That is determinism, not merit: two
   * honest observers replaying the same log must seat the same people or the
   * network has two different answers to who may certify a bet.
   *
   * A candidate nobody voted for can still be seated when seats would
   * otherwise sit empty — a small market nobody campaigned in should still be
   * able to resolve — but a single vote outranks all of that silence.
   *
   * No clock appears here. The host refuses ballots after the closing time,
   * which is where wall-clock judgments belong; this function only ever reads
   * the votes that are actually in the log.
   */
  /**
   * A stake, as this record can actually hold it: floored to the micro-token.
   *
   * FLOORED, never rounded. Rounding up would debit a balance for more than it
   * holds by up to half a micro-token, and rounding at all in only one of the
   * two places — the debit and the recorded stake — leaves escrow that no
   * payout branch can hand back. The remainder simply stays in the balance.
   */
  function mktAmt(x) { return Math.floor(x * 1e6) / 1e6; }

  function mktSeats(m) {
    var w = bare(), id;
    for (id in m.cands) w[id] = 0;
    for (var v in m.votes) {
      // The weight RECORDED WITH THE BALLOT, never today's burn total.
      //
      // This read live `burnedSats[v]`, and a bitcoin burn is not a market
      // act — no door closes it when betting closes. So an ally burning after
      // the answer was already knowable re-ordered the jury: a pre-flight
      // reproduced both halves of that, seating a puppet who then certified
      // the attacker's answer (their 100 back as 196, the honest backer's 100
      // gone), and un-seating a moderator who had certified falsely so the
      // bond — the only thing a corrupt certification can cost — went home in
      // full. Ballots are already refused after the close, so recording the
      // weight when the ballot is cast freezes the election at the close by
      // construction, with no clock anywhere near this file.
      var ballot = m.votes[v], wt = ballot.wt || 0;
      if (wt <= 0) continue;                    // no proven burn, no weight
      for (var k = 0; k < ballot.for.length; k++) {
        if (w[ballot.for[k]] !== undefined) w[ballot.for[k]] += wt;
      }
    }
    var order = Object.keys(m.cands).sort(function (x, y) {
      if (w[y] !== w[x]) return w[y] - w[x];
      if (m.cands[y] !== m.cands[x]) return m.cands[y] - m.cands[x];
      return x < y ? -1 : 1;
    });
    return { order: order, weight: w, seated: order.slice(0, m.seats) };
  }

  /**
   * Can this market act apply against the current state? One function, asked
   * by the host before it accepts and by the replay before it applies — the
   * same discipline tokenActError follows, for the same reason: a host that
   * accepts what the replay skips has written a log that means one thing to
   * it and another to everyone else.
   *
   * Every check here reads STRUCTURE, never payload. Deleting a bet redacts
   * its question and blanks its answer labels but keeps the answer count, so
   * nothing in this function can start refusing an act it once allowed —
   * which would re-cut escrow that was settled months ago.
   */
  function marketActError(a) {
    var who = a.author;
    if (!ledgerById[who]) return 'unknown actor';
    if (ledgerById[who].burnBal < THETA) return 'not enough energy';
    if (a.t === 'market') {
      var opts = Array.isArray(a.opts) ? a.opts : [];
      if (opts.length < MKT_MIN_OPTS || opts.length > MKT_MAX_OPTS) {
        return 'a bet needs between ' + MKT_MIN_OPTS + ' and ' + MKT_MAX_OPTS
          + ' answers; this one names ' + opts.length;
      }
      if (!tokenMeta[a.cur]) return 'no such asset: ' + a.cur;
      if (!MKT_SEATS[a.seats]) return 'a jury is 1, 3 or 5 seats — an even jury cannot reach a majority';
      if (!(a.bond > 0) || a.bond > 1e9) return 'a seat needs a bond: it is the only thing a corrupt certification can cost';
      if (!(a.feeBp >= 0) || a.feeBp > MKT_FEE_MAX_BP) {
        return 'the resolution fee is at most ' + (MKT_FEE_MAX_BP / 100) + '% of the pool';
      }
      return null;
    }
    var m = markets[a.cid];
    if (!m) return 'no such bet: ' + a.cid;
    // Settled is settled. Every branch below moves value, and a market that
    // has paid out has no value left to move.
    if (m.state !== 'open') {
      return m.state === 'void'
        ? 'that bet was voided — the stakes went back and nothing more moves'
        : 'that bet is already resolved — the pool has been paid out';
    }
    if (a.t === 'bet') {
      // The two roles that can shape the answer are the two that may not hold
      // a position on it. The author takes a fee whichever answer wins, and a
      // moderator certifies; either of them betting turns a market into a
      // machine for paying its own referee.
      if (who === m.by) return 'the author of a bet does not hold a position on it — they are paid a fee whichever answer wins';
      if (m.cands[who] !== undefined) return 'a moderator cannot back an answer they may be asked to certify';
      if (!(a.opt >= 0) || a.opt >= m.n || Math.floor(a.opt) !== a.opt) return 'there is no answer ' + a.opt + ' on this bet';
      // Against the QUANTIZED stake, which is what will actually be taken.
      // Everything in this record is kept to the micro-token; a stake finer
      // than that used to be debited in full and recorded rounded, and the
      // difference is escrow that no payout branch could ever hand back.
      var v = mktAmt(a.amt);
      if (!(v > 0)) {
        return a.amt > 0 ? 'the smallest stake this record can hold is 0.000001 ' + m.cur : 'a stake must be positive';
      }
      if (balOf(m.cur, who) < v) {
        return 'balance is ' + round6(balOf(m.cur, who)) + ' ' + m.cur + ', tried to stake ' + a.amt;
      }
      return null;
    }
    if (a.t === 'modStand') {
      if (a.on === false) {
        if (m.cands[who] === undefined) return 'you are not standing in this bet';
        return null;                            // stand down, bond returned in full
      }
      if (who === m.by) return 'the author of a bet cannot also certify it';
      if (m.byBettor[who] !== undefined) return 'you hold a position on this bet, so you cannot certify it';
      if (m.cands[who] !== undefined) return 'you are already standing, and the bond is already posted';
      if (balOf(m.cur, who) < m.bond) {
        return 'the bond is ' + fmtAmt(m.bond) + ' ' + m.cur + ' and you hold ' + fmtAmt(balOf(m.cur, who));
      }
      return null;
    }
    if (a.t === 'modVote') {
      var ballot = Array.isArray(a.for) ? a.for : [];
      if (ballot.length > m.seats) return 'this jury has ' + m.seats + ' seat(s); a ballot names at most that many';
      for (var i = 0; i < ballot.length; i++) {
        if (ballot[i] === who) return 'nobody votes themselves onto a jury';
        if (ballot.indexOf(ballot[i]) !== i) return 'that ballot names the same candidate twice';
        if (m.cands[ballot[i]] === undefined) return 'nobody by that name is standing in this bet';
      }
      if ((burnedSats[who] || 0) <= 0) {
        return 'a vote weighs the satoshis you proved you destroyed, and this handle has destroyed none';
      }
      return null;
    }
    if (a.t === 'attest') {
      if (mktSeats(m).seated.indexOf(who) < 0) return 'only a seated moderator certifies a bet, and this handle holds no seat';
      if (m.attests[who] !== undefined) {
        return 'you have already certified this bet — a certification is final, which is what makes the bond mean anything';
      }
      if (a.opt !== -1 && (!(a.opt >= 0) || a.opt >= m.n || Math.floor(a.opt) !== a.opt)) {
        return 'there is no answer ' + a.opt + ' on this bet';
      }
      return null;
    }
    if (a.t === 'marketVoid') {
      // The DEADLINE is checked at the host's door and nowhere else, exactly
      // like an event that has already happened: a wall-clock comparison in
      // here would be retroactive by construction, and a replay that changed
      // its mind about a settled market as the day moved on would not be a
      // pure function of the log. What this file guarantees is the part that
      // matters for value: a void refunds every stake in full and pays no fee
      // to anybody, so a host that voids early can cancel a market but can
      // never take from one.
      return null;
    }
    if (a.t === 'marketClose') {
      // The author shuts betting before the stated closing time. This is the
      // one lever the author holds over a running bet, and it only ever
      // TIGHTENS the market: no new stakes, no new candidates, no new ballots
      // from the moment it lands — exactly what the closing time would have
      // done later. It cannot pay anyone, cannot pick an answer, and cannot
      // reach a stake already placed. Whether the bet is already past its
      // closing time is a clock question, and the host answers it at the
      // door; here only the shape and the author are checked.
      if (who !== m.by) return 'only the author of a bet closes betting on it early';
      if (m.closedEarly) return 'betting on this bet was already closed early';
      return null;
    }
    return 'unknown market act';
  }

  /**
   * Settle a bet, once, forever.
   *
   * `outcome` is the answer index a majority certified, or −1 for a void. The
   * arithmetic is deliberately dull: floor every division, hand the remainder
   * to the author with the fee, and let no branch return a bond to a
   * moderator it was taken from.
   *
   * Silence and dissent are not the same failure and are not priced the same,
   * and WHICH of them costs the bond turns on one thing only: whether the
   * deadline passed.
   *
   * While a jury is still sitting — `byDeadline` false, a verdict reached by
   * agreement — a moderator who certified an answer the jury did not reach
   * loses the bond. That is the striking this whole mechanism exists for. A
   * moderator who has not certified yet keeps the bond and earns no fee:
   * their colleagues simply got there first, and slowness is not corruption.
   *
   * Past the deadline — `byDeadline` true, nobody agreed with anybody — it is
   * the other way round. Whoever certified did the job they bonded for and
   * takes the bond home; the seats that never spoke are the reason the market
   * failed, and they pay for it.
   */
  function mktSettle(m, outcome, byDeadline) {
    var seated = mktSeats(m).seated, i;
    var honest = [], guilty = [];
    for (i = 0; i < seated.length; i++) {
      var said = m.attests[seated[i]];
      if (said === undefined) { if (byDeadline) guilty.push(seated[i]); continue; }
      if (byDeadline) continue;                  // certified; the jury just never agreed
      if (said === outcome) honest.push(seated[i]); else guilty.push(seated[i]);
    }
    // Bonds first. Everyone standing gets theirs back except the struck —
    // including candidates the community never seated, who risked nothing and
    // therefore lose nothing.
    var slashed = 0, cands = Object.keys(m.cands).sort();
    for (i = 0; i < cands.length; i++) {
      if (guilty.indexOf(cands[i]) >= 0) {
        slashed = round6(slashed + m.cands[cands[i]]);
        m.struck[cands[i]] = m.cands[cands[i]];
      } else {
        tokCredit(m.cur, cands[i], m.cands[cands[i]]);
      }
    }
    var fee = 0, dust = 0, j;
    var winTotal = outcome >= 0 ? (m.totals[outcome] || 0) : 0;
    if (winTotal > 0) {
      // The pool, less the fee, plus every struck bond — the people a corrupt
      // certification was aimed at are the people it is paid to.
      fee = Math.floor(m.pool * m.feeBp / 10000 * 1e6) / 1e6;
      var pot = round6(m.pool - fee + slashed), paid = 0;
      var backers = Object.keys(m.stakes[outcome]).sort();
      for (j = 0; j < backers.length; j++) {
        var got = Math.floor(pot * m.stakes[outcome][backers[j]] / winTotal * 1e6) / 1e6;
        if (got > 0) {
          tokCredit(m.cur, backers[j], got);
          m.paid[backers[j]] = got;
          paid = round6(paid + got);
        }
      }
      dust = round6(pot - paid);
    } else {
      // Either the market voided, or the answer that won had no backers at
      // all. Nobody was right, so nobody is paid and NO FEE IS TAKEN: every
      // stake goes back to whoever made it, to the micro-token.
      for (i = 0; i < m.n; i++) {
        var back = Object.keys(m.stakes[i]).sort();
        for (j = 0; j < back.length; j++) {
          tokCredit(m.cur, back[j], m.stakes[i][back[j]]);
          m.refunded[back[j]] = round6((m.refunded[back[j]] || 0) + m.stakes[i][back[j]]);
        }
      }
      // A struck bond never goes home — but only where somebody was actually
      // kept waiting. With stakes to compensate, it is spread across every one
      // of them pro rata. With NO stakes at all there is no victim, so there
      // is nothing to compensate and nothing is taken: the bonds go back.
      // (They used to fall to the author with the dust, which put the author
      // of a bet nobody backed in the position of collecting from a jury that
      // stayed quiet — a shape worth removing even though a review found the
      // full attack it suggested does not close.)
      if (slashed > 0 && m.pool > 0) {
        var comp = 0, all = Object.keys(m.byBettor).sort();
        for (i = 0; i < all.length; i++) {
          var share = Math.floor(slashed * m.byBettor[all[i]] / m.pool * 1e6) / 1e6;
          if (share > 0) {
            tokCredit(m.cur, all[i], share);
            m.paid[all[i]] = round6((m.paid[all[i]] || 0) + share);
            comp = round6(comp + share);
          }
        }
        dust = round6(slashed - comp);
      } else if (slashed > 0) {
        for (i = 0; i < seated.length; i++) {
          if (m.struck[seated[i]] === undefined) continue;
          tokCredit(m.cur, seated[i], m.struck[seated[i]]);
          delete m.struck[seated[i]];
        }
        slashed = 0;
        guilty = [];
      }
    }
    // Half the fee to the author, half split among the moderators who called
    // it right. A jury that all stayed silent earns nothing and its half goes
    // to the author too — the work is what is paid for, not the seat.
    var modPot = Math.floor(fee / 2 * 1e6) / 1e6;
    var toAuthor = round6(fee - modPot + dust);
    if (honest.length && modPot > 0) {
      var each = Math.floor(modPot / honest.length * 1e6) / 1e6;
      for (i = 0; i < honest.length; i++) {
        if (each > 0) { tokCredit(m.cur, honest[i], each); m.earned[honest[i]] = each; }
      }
      toAuthor = round6(toAuthor + (modPot - round6(each * honest.length)));
    } else {
      toAuthor = round6(toAuthor + modPot);
    }
    if (toAuthor > 0) {
      tokCredit(m.cur, m.by, toAuthor);
      m.earned[m.by] = round6((m.earned[m.by] || 0) + toAuthor);
    }
    m.state = outcome >= 0 ? 'resolved' : 'void';
    m.outcome = outcome;
    m.jury = seated; m.honest = honest; m.guilty = guilty;
    m.feePaid = fee; m.slashedTotal = slashed;
    return { fee: fee, slashed: slashed, honest: honest, guilty: guilty };
  }

  /** Has a strict majority of the seated jury said the same thing? */
  function mktVerdict(m) {
    var seated = mktSeats(m).seated, tally = {}, need = Math.floor(seated.length / 2) + 1;
    for (var i = 0; i < seated.length; i++) {
      var said = m.attests[seated[i]];
      if (said === undefined) continue;
      tally[said] = (tally[said] || 0) + 1;
      if (tally[said] >= need) return said;
    }
    return null;
  }

  function weighHome(author, pd, pi) {
    var c = Math.sqrt(Math.abs(pd) * Math.abs(pi));
    if (c > 0) selfCells.push({ src: author, rcp: author, coeff: Math.min(1, c) });
  }
  function typeNode(name) {
    var id = 'type_' + name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!g.nodes.get(id)) g.addNode({ id: id, kind: 'Type', label: '#' + name });
    return id;
  }

  // Which act appended which edge: edgeAct[appendIndex] = act index.
  //
  // The graph numbers edges by append order and the log numbers acts by
  // append order, and those are not the same scale — one act appends zero
  // edges, one, or two. Anything that has to interleave a graph-derived
  // record with an act-derived one needs a key both can be read on, and the
  // act index is the one both genuinely have; the alerts list had been
  // comparing the two scales directly and getting a fixed, permanent
  // mis-order out of it.
  //
  // Kept beside the graph rather than ON the edge record, deliberately: an
  // edge is material the epoch hash commits to, and a field added to it would
  // change what an already-published epoch reproduces.
  var edgeAct = [];
  for (var i = 0; i < acts.length; i++) {
    // Everything appended since the last time round the loop came from the
    // act before this one — which is why the fill sits at the TOP of the body
    // rather than the bottom, where the branch's `continue`s would skip it.
    // At i = 0 anything already there predates the log and is left at -1.
    while (edgeAct.length < g.edges.length) edgeAct.push(i - 1);
    var a = acts[i];
    // An act is muted only when its OWN author removed it — by deleting that
    // act, or by deleting the account that authored it. It is never muted
    // because of what it points at.
    //
    // The cascade that used to live here mutedeverything targeting deleted
    // content, so deleting one post erased every comment other people had
    // written under it, and a message was blanked for being addressed to
    // someone who left. Those are other authors' records. Commentary outlives
    // its subject: a comment quoting a payload persists through that payload's
    // removal, because the surviving record is the reviewer's own act.
    var payloadGone = !!(deletedActors[a.author] || deletedActors[a.from] || deletedActors[a.id] ||
      deletedPostIdx[i]);
    if (a.t === 'seedWorld') {
      addActor('alice', 'Alice', 3, 10, 0);
      addActor('bob', 'Bob', 2, 8, 0);
      addActor('carol', 'Carol', 4, 12, 0);
      addActor('dave', 'Dave', 1, 5, 0);
      g.addNode({ id: 'photo', kind: 'Content', label: 'Photo' });
      g.addNode({ id: 'comment', kind: 'Comment', label: 'Comment' });
      g.addNode({ id: 'streetart', kind: 'Type', label: '#StreetArt' });
      g.addNode({ id: 'sneakers', kind: 'Item', label: 'Sneakers' });
      g.append({ id: 'e1', family: 'SelfDeclaration', src: 'alice', tgt: 'prof_alice', pd: 1, pi: 0.75 });
      g.append({ id: 'e1r', family: 'SelfReputation', src: 'prof_alice', tgt: 'alice', pd: 1, pi: 0.75 });
      g.append({ id: 'e2', family: 'Opinion', src: 'alice', tgt: 'photo', pd: 0.9, pi: 0.7 });
      g.append({ id: 'e3', family: 'ReviewA', src: 'bob', tgt: 'photo', pd: 0.7, pi: 0.8 });
      g.append({ id: 'e4', family: 'ReviewT', src: 'photo', tgt: 'comment', pd: 0.8, pi: 0.7 });
      g.append({ id: 'e5', family: 'TagA', src: 'carol', tgt: 'comment', pd: 0.8, pi: 0.9 });
      g.append({ id: 'e6', family: 'TagT', src: 'comment', tgt: 'streetart', pd: 0.9, pi: 0.8 });
      g.append({ id: 'e7', family: 'Affinity', src: 'alice', tgt: 'streetart', pd: 0.6, pi: 0.8 });
      g.append({ id: 'e8', family: 'Owner', src: 'bob', tgt: 'sneakers', pd: 0.7, pi: 1.0 });
      creators.photo = 'alice'; creators.comment = 'bob'; creators.sneakers = 'bob'; creators.streetart = 'carol';
      payloads.photo = SEED_POSTS.photo; payloads.comment = SEED_POSTS.comment;
      reviewMeta.comment = { e: 0.7, f: 0.8 };
      // The seed actors get no Layer-0 fortune either. They exist to make the
      // graph legible from the first act, not to hold value nobody deposited.
      chron.push({ who: 'alice', line: 'posted Photo — seed world', to: 'photo' });
      chron.push({ who: 'bob', line: 'reviewed Photo, minting a Comment — seed world', to: 'comment' });
    } else if (a.t === 'register') {
      // The LABEL is what every screen renders — standings, the graph, the
      // feed byline. A later namesake must never render as the bare name it
      // copied, or the interface repeats the impersonation on every surface.
      // Registering grants NOTHING spendable. The act carries a `seed` and
      // that used to become the new account's reserve — roughly eighteen
      // free acts, minted from nowhere, which is the same fiction as the
      // faucet wearing a different name. It reads as a burn in the
      // chronicle and no bitcoin was ever destroyed for it.
      //
      // The grant is exactly the θ this registration act costs, so the two
      // cancel and a new account opens at zero. You can exist here for
      // free; speaking is what costs, and it is paid for with bitcoin
      // somebody actually destroyed.
      addActor(a.id, a.handle, THETA, 0, a.epoch,
        payloadGone ? '[deleted]' : (handleTwin[a.id] ? a.handle + ' (' + a.id + ', not the original)' : a.handle));
      if (a.pinHash) pinHash[a.id] = a.pinHash;
      g.append({ id: 'reg_' + a.id, family: 'Registration', src: a.id, tgt: 'prof_' + a.id, pd: 1, pi: 1 });
      debit(a.id); weighHome(a.id, 1, 1);
      // No onboarding fortune any more. Registering used to hand out ten
      // units of "external reserve" and two "live" units from an operator
      // who had never deposited anything — invented value, dressed as an
      // economy. Everything spendable here now comes from bitcoin somebody
      // actually destroyed, so arriving grants you a name and nothing else.
      if (payloadGone) ledgerById[a.id].deleted = true;
      else chron.push({ who: a.id, line: 'registered · opens at zero, nothing granted' + (a.pinHash ? ' · PIN-secured' : '') });
    } else if (a.t === 'burn') {
      if (!known(a.id)) continue;
      // ── The faucet, and why it now has a ceiling ────────────────────────
      //
      // This act credits burnBal AND earnedBurn, is not priced, and had no
      // limit of any kind. Measured: two hundred calls took an account to
      // fifty-two times its standing with an act count of one, and drove α̂ to
      // its maximum, which is the eligibility that decides who earns a share
      // of an epoch. Free maximum weight. The app said in four places that
      // nothing mints standing; this minted it.
      //
      // The bound is per account per epoch, and it starts at a FUTURE epoch
      // on purpose. Applying it to the whole log would recompute every
      // standing on the network and invalidate epoch certificates that are
      // already published — a retroactive rewrite is exactly what an
      // append-only record exists to prevent. Sixty epochs are closed as this
      // ships and the heaviest account has averaged about one burn per epoch,
      // so this constrains nobody who is using it as intended.
      // The faucet is gone, not rationed. It called itself "burn" and
      // destroyed nothing: it minted reserve from nowhere, which is the
      // exact fiction this network is being taken out of. A `burn` act in
      // the record from before the restart still replays — history is not
      // rewritten — but nothing credits one now. Reserve comes from
      // btcBurn, and from nowhere else.
      if (!payloadGone) chron.push({ who: a.id, line: 'a faucet burn, from before the restart — credits nothing' });
    } else if (a.t === 'btcBurn') {
      // Value destroyed on the Bitcoin chain, recorded only after the host
      // verified the transaction against public explorers. What makes this
      // trustworthy is not the host's word: the txid is in the log, the
      // output pays a script that provably cannot be spent, and anybody can
      // check both without asking anyone. Replay does NOT re-fetch — a
      // replay that needed the internet would not be a pure function of the
      // log — so the act carries what was verified and the chain carries the
      // proof.
      if (!known(a.id)) continue;
      // Keyed on ONE spelling. A transaction hash is a number and two
      // spellings of one number are one burn; keying on the raw string made
      // 0xABAB… and 0xabab… two entries in the table whose entire job is to
      // say which burn was already paid for. Verified before changing it: no
      // btcBurn in this network's log carries an upper-case hash, so every
      // existing burn credits exactly what it credited yesterday and no
      // published epoch certificate moves.
      var btcTx = String(a.txid == null ? '' : a.txid).toLowerCase();
      if (burnedTx[btcTx]) continue;             // a burn is claimed once, ever
      burnedTx[btcTx] = a.id;
      burnedSats[a.id] = (burnedSats[a.id] || 0) + a.sats;
      // …and it buys the right to speak, not only a share of the mint.
      //
      // This was missing and it inverted the whole point: a real burn granted
      // WEIGHT but no reserve, while the free faucet granted reserve — the
      // energy every act is debited from — but no weight. Destroying bitcoin
      // therefore bought strictly less participation than clicking a button,
      // which is the fake currency outranking the real one in the dimension
      // that decides whether you can post at all.
      //
      // The rate is a CHOICE, not a discovery: nothing about a satoshi says
      // what a sentence should cost. At 100 sat per unit of reserve and
      // θ ≈ 0.0528 an act, roughly 190 acts come from 10,000 sat. Change the
      // constant and you change the price of speech here; there is no market
      // setting it and this comment exists so nobody mistakes it for one.
      var gained = a.sats / SATS_PER_RESERVE;
      ledgerById[a.id].burnBal += gained;
      if (!payloadGone) {
        chron.push({ who: a.id, line: 'burned ' + a.sats + ' sat to the dead address → +' + gained.toFixed(4)
          + ' reserve · tx ' + String(a.txid).slice(0, 12) + '… (irreversible, verifiable by anyone)' });
      }
    } else if (a.t === 'peerBurn') {
      // The SECOND door into reserve: PEER destroyed on Base, priced by the
      // official PEER/cbBTC pool, credited at the SAME SATS_PER_RESERVE the
      // bitcoin door uses. See the constant block above for why one price for
      // both doors is the design and not a shortcut.
      //
      // Everything below is arithmetic on numbers this act carries. Replay
      // fetches nothing — not the pool, not the chain, not a euro rate — for
      // the reason the btcBurn branch gives: a replay that needed the
      // internet would not be a pure function of the log, and every published
      // epoch certificate would stop reproducing the day a price moved.
      if (!known(a.id)) continue;
      var pbWhy = peerBurnActError(a, certsSoFar);
      if (pbWhy) {
        // Refused, and SAID SO. A silent skip here would leave a burner
        // staring at destroyed PEER and an unchanged balance with no account
        // of why — and would hide the far more serious case, which is a host
        // that recorded a price and a value that do not match each other.
        if (!payloadGone) chron.push({ who: a.id, line: 'a PEER burn was refused by replay — ' + pbWhy });
        continue;
      }
      var pbTx = String(a.txid).toLowerCase();   // one spelling; see the checker
      peerBurnTxBy[pbTx] = a.id;                 // a burn is claimed by one handle, ever
      peerBurnTxSats[pbTx] = (peerBurnTxSats[pbTx] || 0) + a.creditsSats;
      peerBurnedRaw[a.id] = String(BigInt(peerBurnedRaw[a.id] || '0') + BigInt(a.amtRaw));
      var pbKey = a.id + '@' + certsSoFar;
      peerBurnEpochUse[pbKey] = (peerBurnEpochUse[pbKey] || 0) + a.creditsSats;
      var pbPool = String(a.factory).toLowerCase() + '#' + a.pool + '@' + certsSoFar;
      peerBurnPoolUse[pbPool] = (peerBurnPoolUse[pbPool] || 0) + a.creditsSats;
      // Reserve, and reserve ONLY.
      //
      // Note what is deliberately absent: burnedSats is not touched. That map
      // is the weight in the epoch mint and in the writer election, and it is
      // documented as value destroyed ON THE BITCOIN CHAIN, proven by a txid
      // anyone can check against an asset whose price nobody here can move.
      // A PEER burn has a PRICE, and a price can be lied to — which is
      // precisely the attack the ceilings and the seeded window exist to
      // bound. So what a manipulated half-hour can buy is BOUNDED SPEECH: at
      // most one epoch's ceiling for an account, at most one pool's own
      // bitcoin side across everybody. It can never buy a share of the mint
      // and never a vote for the writer.
      //
      // What it does NOT say — and what an earlier version of this comment
      // claimed — is "never standing that was not earned". That sentence was
      // contradicted ninety lines up by this file's own account of the faucet:
      // reserve buys acts, acts append the graph edges CoGra solves standing
      // over, and two hundred faucet calls once took an account to fifty-two
      // times its standing. One epoch's ceiling here is about 1,894 acts at
      // θ ≈ 0.0528, which is an order of magnitude more activity than that.
      // The two clauses above are true and this one was not, so it is gone
      // rather than softened.
      var pbGained = a.creditsSats / SATS_PER_RESERVE;
      ledgerById[a.id].burnBal += pbGained;
      if (!payloadGone) {
        var pbPart = a.creditsSats < a.sats
          ? ' (' + a.creditsSats + ' of the burn’s ' + a.sats + ' sat — the rest after the next epoch closes)'
          : '';
        chron.push({ who: a.id, line: 'burned ' + peerText(a.amtRaw) + ' PEER → ' + a.sats + ' sat → +'
          + pbGained.toFixed(4) + ' reserve' + pbPart + ' · tx ' + pbTx.slice(0, 12)
          + '… (priced by the pool, dead-address burn — unspendable because no key is known for it, not provably unspendable like the bitcoin burn beside it)' });
      }
    } else if (a.t === 'resetTokens') {
      // The ledger starts again. Nothing is rewritten: every act that ever
      // happened is still here and still replays. What changes is which
      // epochs pay — the balances minted while weight was free were farmed
      // by a faucet, and carrying them forward would price that farming in
      // permanently.
      tokenEpoch0 = certsSoFar;
      for (var rsym in tokenBal) tokenBal[rsym] = bare();
      if (!payloadGone) chron.push({ who: a.id || null, line: 'the token ledger was reset to zero at epoch ' + certsSoFar + ' — free-minted balances stop here' });
    } else if (a.t === 'deposit') {
      // Layer 0 is retired. This branch used to apply deposits,
      // attestations and redemptions against a reserve nobody had funded,
      // and credited burnBal - a second, unpriced source of the energy
      // every act is debited from, sitting beside the bitcoin burn.
      //
      // Refused HERE and not only at the host door, because this file is
      // what a foreign or hand-edited log passes through: mirrors, the
      // published archive and every browser replay a log this host did
      // not author. A rule enforced only at one door is not a rule.
      // Acts already in a log still parse; they simply do nothing.
    } else if (a.t === 'burnL0') {
      // Layer 0 is retired. This branch used to apply deposits,
      // attestations and redemptions against a reserve nobody had funded,
      // and credited burnBal - a second, unpriced source of the energy
      // every act is debited from, sitting beside the bitcoin burn.
      //
      // Refused HERE and not only at the host door, because this file is
      // what a foreign or hand-edited log passes through: mirrors, the
      // published archive and every browser replay a log this host did
      // not author. A rule enforced only at one door is not a rule.
      // Acts already in a log still parse; they simply do nothing.
    } else if (a.t === 'redeem') {
      // Layer 0 is retired. This branch used to apply deposits,
      // attestations and redemptions against a reserve nobody had funded,
      // and credited burnBal - a second, unpriced source of the energy
      // every act is debited from, sitting beside the bitcoin burn.
      //
      // Refused HERE and not only at the host door, because this file is
      // what a foreign or hand-edited log passes through: mirrors, the
      // published archive and every browser replay a log this host did
      // not author. A rule enforced only at one door is not a rule.
      // Acts already in a log still parse; they simply do nothing.
    } else if (a.t === 'transferL0') {
      // Layer 0 is retired. This branch used to apply deposits,
      // attestations and redemptions against a reserve nobody had funded,
      // and credited burnBal - a second, unpriced source of the energy
      // every act is debited from, sitting beside the bitcoin burn.
      //
      // Refused HERE and not only at the host door, because this file is
      // what a foreign or hand-edited log passes through: mirrors, the
      // published archive and every browser replay a log this host did
      // not author. A rule enforced only at one door is not a rule.
      // Acts already in a log still parse; they simply do nothing.
    } else if (a.t === 'setPin') {
      if (ledgerById[a.id] && a.pinHash) {
        pinHash[a.id] = a.pinHash; // newest wins — add or change
        // An operator reset is not the owner securing their own handle, and
        // the record must not read as though it were. Whoever holds the
        // operator token can take over any handle here; the least this can do
        // is say so out loud, in the same place everything else is said.
        if (!payloadGone) {
          chron.push({ who: a.id, line: a.byOperator
            ? 'had its PIN reset by the instance operator — not by the account holder'
            : 'secured the handle with a PIN' });
        }
      }
    } else if (a.t === 'dm') {
      if (!known(a.from) || !known(a.to)) continue;
      if (ledgerById[a.from] && ledgerById[a.to] && ledgerById[a.from].burnBal >= THETA) {
        var pair = [a.from, a.to].sort();
        var chatId = 'chat_' + pair[0] + '_' + pair[1];
        if (!g.nodes.get(chatId)) {
          g.addNode({ id: chatId, kind: 'Chat', label: 'Chat' });
        }
        counter++;
        var msgId = 'm' + counter;
        g.addNode({ id: msgId, kind: 'Message', label: 'Message' });
        g.appendHyper(
          { id: 'snA' + counter, family: 'SendA', src: a.from, tgt: chatId, pd: 0.8, pi: 0.8, epoch: certsSoFar },
          { id: 'snT' + counter, family: 'SendT', src: chatId, tgt: msgId, pd: 0.8, pi: 0.8, epoch: certsSoFar }
        );
        debit(a.from); weighHome(a.from, 0.8, 0.8);
        if (!payloadGone) dms.push({ from: a.from, to: a.to, text: a.text, idx: i });
      }
    } else if (a.t === 'closeCycle') {
      // Layer 0 is retired. This branch used to apply deposits,
      // attestations and redemptions against a reserve nobody had funded,
      // and credited burnBal - a second, unpriced source of the energy
      // every act is debited from, sitting beside the bitcoin burn.
      //
      // Refused HERE and not only at the host door, because this file is
      // what a foreign or hand-edited log passes through: mirrors, the
      // published archive and every browser replay a log this host did
      // not author. A rule enforced only at one door is not a rule.
      // Acts already in a log still parse; they simply do nothing.
    } else if (a.t === 'stream') {
      if (!known(a.author)) continue;
      // A stream is a Publish like any other: it mints a Content node, costs
      // θ, and weighs home. That is the whole point — reactions and comments
      // during a broadcast are ordinary Opinion and Review acts targeting this
      // node, so live participation is priced and recorded exactly like every
      // other gesture instead of living in a parallel, unscored channel. The
      // video itself is peer-to-peer and never enters the record.
      counter++;
      var scid = 'c' + counter;
      actContent[i] = scid;
      contentAuthor[scid] = a.author;
      if (payloadGone) mutedContent[scid] = true;
      g.addNode({ id: scid, kind: 'Content', label: payloadGone ? '[deleted]' : 'Stream ' + counter });
      g.append({ id: 'pub' + counter, family: 'Publish', src: a.author, tgt: scid, pd: a.a, pi: 1, epoch: certsSoFar });
      debit(a.author); weighHome(a.author, a.a, 1);
      if (!payloadGone) {
        creators[scid] = a.author; payloads[scid] = a.text;
        postMeta[scid] = { idx: i, ts: a.ts, edited: false, stream: true };
        chron.push({ who: a.author, line: 'went live · ' + a.text.slice(0, 60), to: scid });
      }
    } else if (a.t === 'event') {
      if (!known(a.author)) continue;
      // ── An event is CONTENT, and that is the whole integration ──────────
      //
      // It mints a Content node through the same path a post or a stream
      // takes, so reactions, comments, quotes, tags and vouches land on it
      // unchanged — and those already feed CoGra, the standing solve and the
      // epoch distribution. Nothing in the distribution code has to know that
      // events exist; one line, contentAuthor, buys all of it.
      //
      // What does NOT happen here is equally deliberate: attending does not
      // mint standing, and a fee is a transfer of tokens that already exist.
      // Money never reaches burnBal or earnedBurn, which are the only two
      // things standing and the α̂ gate read.
      counter++;
      var ecid = 'c' + counter;
      actContent[i] = ecid;
      contentAuthor[ecid] = a.author;   // unconditional: a departure must not re-cut a closed epoch
      if (payloadGone) mutedContent[ecid] = true;
      g.addNode({ id: ecid, kind: 'Content', label: payloadGone ? '[deleted]' : 'Event ' + counter });
      g.append({ id: 'pub' + counter, family: 'Publish', src: a.author, tgt: ecid, pd: 0.8, pi: 1, epoch: certsSoFar });
      debit(a.author); weighHome(a.author, 0.8, 1);
      events[ecid] = {
        host: a.author,
        at: typeof a.at === 'number' ? a.at : 0,
        // The place is redacted with the payload. It is a physical address:
        // where a named person will be, at a named time.
        place: payloadGone ? '' : String(a.place || '').slice(0, 120),
        fee: a.fee > 0 ? round6(a.fee) : 0,
        cur: a.fee > 0 ? String(a.cur || '') : '',
        cap: a.cap > 0 ? Math.floor(a.cap) : 0,
        idx: i,
      };
      if (!payloadGone) {
        creators[ecid] = a.author; payloads[ecid] = a.text;
        postMeta[ecid] = { idx: i, ts: a.ts, edited: false, event: true };
        chron.push({ who: a.author, line: 'announced an event · ' + String(a.text).slice(0, 60)
          + (events[ecid].fee ? ' · entry ' + fmtAmt(events[ecid].fee) + ' ' + events[ecid].cur : ' · free'), to: ecid });
      }
    } else if (a.t === 'invite') {
      // Recorded, unscored, free — the same shape as a follow.
      if (!known(a.from) || !known(a.to)) continue;
      var iev = events[a.cid];
      if (!iev || iev.host !== a.from || a.to === a.from) continue;
      // The act index, not `true`: every reader only asks whether the key
      // exists (and an invite is never act 0 — that is the seed world), and
      // the alerts list needs to know WHEN the invitation happened to say
      // whether it is newer than the last look.
      (eventInvites[a.cid] || (eventInvites[a.cid] = {}))[a.to] = i;
      chron.push({ who: a.from, line: 'invited ' + (handles[a.to] || a.to) + ' to an event', to: a.cid });
    } else if (a.t === 'rsvp') {
      if (!known(a.from)) continue;
      var rev2 = events[a.cid];
      if (!rev2) continue;
      var rerr = tokenActError({ t: 'rsvp', author: a.from, cid: a.cid, amt: a.amt, cur: a.cur, to: a.to });
      if (a.on === false) {
        // Leaving is always allowed and never refunds: the fee already moved,
        // and this record does not reverse value. Said on screen too.
        if ((eventGoing[a.cid] || {})[a.from]) delete eventGoing[a.cid][a.from];
        chron.push({ who: a.from, line: 'withdrew from an event', to: a.cid });
        continue;
      }
      if (rerr !== null) continue;                 // the host refused it too
      if (rev2.fee > 0) {
        tokDebit(rev2.cur, a.from, rev2.fee);
        tokCredit(rev2.cur, rev2.host, rev2.fee);
        // Money moved from this actor to this creator in this epoch. Their
        // engagement toward that creator is worth nothing for the rest of it:
        // otherwise a fee buys reactions, and reactions mint PEER.
        paidTo[a.from + '>' + rev2.host] = true;
      }
      (eventGoing[a.cid] || (eventGoing[a.cid] = {}))[a.from] = true;
      chron.push({ who: a.from, line: rev2.fee > 0
        ? 'paid ' + fmtAmt(rev2.fee) + ' ' + rev2.cur + ' to ' + (handles[rev2.host] || rev2.host) + ' and joined an event'
        : 'joined an event', to: a.cid });
    } else if (a.t === 'post') {
      if (!known(a.author)) continue;   // a ghost author writes nothing
      // Minting is a role this record plays, not a property of its family: an
      // act mints when its terminal target is its own mint, and names an
      // existing node otherwise. A post carrying `target` is therefore an
      // UPDATE — it mints nothing, leaves creator, comments, reactions and
      // references untouched, and only supersedes the payload. That is the
      // only way to revise anything when records are immutable.
      var isUpdate = Number.isInteger(a.target) && actContent[a.target] !== undefined;
      var cid;
      if (isUpdate) {
        cid = actContent[a.target];
        // Deliberately no counter++: the node already exists, and advancing it
        // here would shift every later content id in logs already written.
        g.append({ id: 'pubu' + i, family: 'Publish', src: a.author, tgt: cid, pd: a.a, pi: 1, epoch: certsSoFar });
        debit(a.author); weighHome(a.author, a.a, 1);
        if (payloadGone) {
          // The tombstone named this revision rather than the mint. A revision
          // is one of the acts that writes text into the node, so removing it
          // has to remove the node's payload — otherwise "delete" silently
          // un-edited the post back to its pre-revision text and left it up.
          mutedContent[cid] = true;
          delete payloads[cid]; delete mediaMeta[cid];
          var pn = g.nodes.get(cid); if (pn) pn.label = '[deleted]';
        } else if (payloads[cid] !== undefined) {
          payloads[cid] = a.text;               // log order gives latest-wins
          if (a.media && a.media.length) mediaMeta[cid] = a.media;
          if (postMeta[cid]) postMeta[cid].edited = true;
          chron.push({ who: a.author, line: 'revised a post — a further record about it, the original stands', to: cid });
        }
      } else {
        counter++;
        cid = 'c' + counter;
        actContent[i] = cid;
        contentAuthor[cid] = a.author;
        if (payloadGone) mutedContent[cid] = true;
        g.addNode({ id: cid, kind: 'Content', label: payloadGone ? '[deleted]' : 'Post ' + counter });
        g.append({ id: 'pub' + counter, family: 'Publish', src: a.author, tgt: cid, pd: a.a, pi: 1, epoch: certsSoFar });
        debit(a.author); weighHome(a.author, a.a, 1);
        if (!payloadGone) {
          creators[cid] = a.author; payloads[cid] = a.text;
          if (a.media && a.media.length) mediaMeta[cid] = a.media;
          postMeta[cid] = { idx: i, ts: a.ts, edited: !!a.edited };
          chron.push({ who: a.author, line: 'posted · attachment ' + a.a.toFixed(2), to: cid });
        }
      }
      // References belong to the node, and a revision does not re-make the node.
      // Re-running these legs paid the same person-vouch a second time: two
      // edits saturated a bundle at the compile clamp, so anyone could lift a
      // friend's standing by editing one post twice. A revision is a further
      // record *about* existing content — it leaves creator, comments,
      // reactions and references where the genesis act put them.
      if (isUpdate) continue;
      // Quote reference: one Reference hyper act (A-leg into the post, Full-tier
      // citation T-leg to the target) — its own θ-debit.
      if (a.ref && g.nodes.get(a.ref) && ledgerById[a.author] && ledgerById[a.author].burnBal >= THETA) {
        counter++;
        g.appendHyper(
          { id: 'rfA' + counter, family: 'ReferenceA', src: a.author, tgt: cid, pd: 0.8, pi: 0.9, epoch: certsSoFar },
          { id: 'rfT' + counter, family: 'ReferenceT', src: cid, tgt: a.ref, pd: 0.9, pi: 0.8, epoch: certsSoFar }
        );
        debit(a.author); weighHome(a.author, 0.8, 0.9);
        if (!payloadGone) chron.push({ who: a.author, line: 'referenced ' + ((g.nodes.get(a.ref) || {}).label || a.ref) + ' — content-intrinsic citation', to: a.ref });
      }
      // @mentions: References whose target is the person's Profile (max 3, priced).
      // The server stamps rmen (resolved ids) on accepted posts so redaction
      // can blank text without shifting the counter; parse only legacy acts.
      var mentioned = a.rmen !== undefined ? a.rmen : parseMentions(a.text, handles);
      for (var mi = 0; mi < mentioned.length; mi++) {
        var mid = mentioned[mi];
        if (mid === a.author || !ledgerById[a.author] || ledgerById[a.author].burnBal < THETA) continue;
        counter++;
        g.appendHyper(
          { id: 'rfA' + counter, family: 'ReferenceA', src: a.author, tgt: cid, pd: 0.7, pi: 0.8, epoch: certsSoFar },
          { id: 'rfT' + counter, family: 'ReferenceT', src: cid, tgt: 'prof_' + mid, pd: 0.8, pi: 0.7, epoch: certsSoFar }
        );
        // def:epoch:standing-recipient-resolution — a positive Reference to a
        // Profile compiles a person-vouch to that actor (cam's spec review).
        debit(a.author); vouch(a.author, mid, 0.7, 0.8);
        if (!payloadGone) {
          chron.push({ who: a.author, line: 'mentioned ' + dispName(mid) + ' — person-vouch compiled', to: cid, refs: [{ label: dispName(mid), id: mid }] });
        }
      }
    } else if (a.t === 'opinion') {
      if (!known(a.author)) continue;
      counter++;
      // Structure is unconditional. A reaction by someone who has since left
      // still happened: its edge, its vouch and its weighing stay, or removing
      // an account would silently rewrite everyone else's standing — which it
      // did, until a test caught this branch still gating them.
      var rec = g.append({ id: 'op' + counter, family: 'Opinion', src: a.author, tgt: a.target, pd: a.p, pi: a.r, epoch: certsSoFar });
      var owner = a.target.indexOf('prof_') === 0 ? a.target.slice(5) : null;
      if (owner && owner !== a.author) vouch(a.author, owner, a.p, a.r);
      else weighHome(a.author, a.p, a.r);
      // Token distribution watches engagement it did not cause: a reaction to
      // someone else's content weighs toward that creator at the next epoch
      // close. Records only — all gates and damping apply at close, where the
      // actor's commitment rate is read once, for everyone alike.
      if (!owner && contentAuthor[a.target] && contentAuthor[a.target] !== a.author
          && !paidTo[a.author + '>' + contentAuthor[a.target]]) {
        epochEngage.push({ actor: a.author, creator: contentAuthor[a.target], base: a.p >= 0 ? 1.0 : 0.3, cid: a.target, kind: a.p >= 0 ? 'reaction' : 'dislike' });
      }
      if (!payloadGone) {
        chron.push({
            who: a.author,
            line: (owner ? 'vouched on ' + dispName(owner) + '’s profile' : 'reacted to ' + ((g.nodes.get(a.target) || {}).label || a.target)) + ' (' + a.p.toFixed(2) + ', ' + a.r.toFixed(2) + ') · τ ' + rec.tau.toFixed(2) + ' · w ' + rec.weight.toFixed(3),
            to: a.target,
            refs: owner
              ? [{ label: dispName(owner), id: owner }]
              : [{ label: (g.nodes.get(a.target) || {}).label || a.target, id: a.target }],
          });
      }
      debit(a.author);
    } else if (a.t === 'review') {
      if (!known(a.author)) continue;
      // Review/T may name an existing Comment instead of minting a fresh one,
      // exactly like Publish on a post: the act is then a revision of that
      // comment. Same rule, same branch shape.
      var isCmtUpdate = Number.isInteger(a.upd) && actContent[a.upd] !== undefined;
      var cmid;
      if (isCmtUpdate) {
        cmid = actContent[a.upd];
        g.appendHyper(
          { id: 'rvAu' + i, family: 'ReviewA', src: a.author, tgt: a.target, pd: a.e, pi: a.f, epoch: certsSoFar },
          { id: 'rvTu' + i, family: 'ReviewT', src: a.target, tgt: cmid, pd: a.f, pi: a.e, epoch: certsSoFar }
        );
        weighHome(a.author, a.e, a.f);
        if (!payloadGone && payloads[cmid] !== undefined) {
          payloads[cmid] = a.text;
          reviewMeta[cmid] = { e: a.e, f: a.f };
          if (postMeta[cmid]) postMeta[cmid].edited = true;
          chron.push({ who: a.author, line: 'revised a comment — a further record, the original stands', to: cmid });
        }
        debit(a.author);
      } else {
      counter++;
      cmid = 'c' + counter;
      actContent[i] = cmid;
      contentAuthor[cmid] = a.author;
      if (payloadGone) mutedContent[cmid] = true;
      g.addNode({ id: cmid, kind: 'Comment', label: payloadGone ? '[deleted]' : 'Review ' + counter });
      g.appendHyper(
        { id: 'rvA' + counter, family: 'ReviewA', src: a.author, tgt: a.target, pd: a.e, pi: a.f, epoch: certsSoFar },
        { id: 'rvT' + counter, family: 'ReviewT', src: a.target, tgt: cmid, pd: a.f, pi: a.e, epoch: certsSoFar }
      );
      weighHome(a.author, a.e, a.f);
      if (contentAuthor[a.target] && contentAuthor[a.target] !== a.author
          && !paidTo[a.author + '>' + contentAuthor[a.target]]) {
        epochEngage.push({ actor: a.author, creator: contentAuthor[a.target], base: 1.2, cid: a.target, kind: 'comment' });
      }
      if (!payloadGone) {
        creators[cmid] = a.author; payloads[cmid] = a.text;
        reviewMeta[cmid] = { e: a.e, f: a.f };
        postMeta[cmid] = { idx: i, ts: a.ts, edited: false, comment: true };
        chron.push({
          who: a.author,
          line: 'reviewed ' + ((g.nodes.get(a.target) || {}).label || 'something since removed') + ' → minted a Comment · one act, two legs',
          to: cmid,
          refs: [{ label: (g.nodes.get(a.target) || {}).label || 'something since removed', id: a.target }],
        });
      }
      debit(a.author);
      }
    } else if (a.t === 'follow') {
      // ── Following, and why it is not an edge ───────────────────────────
      //
      // This network's premise is that influence is transported commitment,
      // not attention, and it holds that line in code rather than in prose:
      // view counts are kept out of the log, the graph and every score.
      //
      // A follow is attention. So it is recorded — it has to be, or it would
      // not survive a reload or agree between two clients — and it is written
      // into a plain map that NOTHING downstream reads. It mints no node, adds
      // no edge, touches no ledger and appears in no certificate. Standing is
      // computed from ledger triples and fold cells only; neither can see this.
      //
      // WHAT IT COSTS, said accurately after getting it wrong once. This
      // branch does NOT debit θ, and the test pins that. The comment that used
      // to sit here claimed it did, the host W1-gates it as though it did, and
      // the bot API advertises that it does — three statements against one
      // silent implementation. The implementation is the truthful one and the
      // words were wrong, so the words are fixed here and at the other two
      // sites rather than the behaviour: a follow that debited θ would let a
      // crowded event or a busy day quietly dilute somebody's own rate, and
      // θ is a standing input. Following is free, and rate-limited like any
      // other write.
      if (known(a.from) && known(a.to) && a.from !== a.to) {
        var fset = follows[a.from] || (follows[a.from] = {});
        var bset = followers[a.to] || (followers[a.to] = {});
        if (a.on === false) { delete fset[a.to]; delete bset[a.from]; }
        else { fset[a.to] = true; bset[a.from] = true; }
        chron.push({ who: a.from, line: (a.on === false ? 'stopped following ' : 'started following ')
          + (handles[a.to] || a.to) + ' — recorded, and in no score' });
      }
    } else if (a.t === 'profile') {
      // Self-declared, public by nature, and owned: the host checks that the
      // signer is the subject. Kept out of every score for the same reason a
      // follow is — what you say about yourself is not commitment transported.
      if (known(a.id)) {
        profiles[a.id] = {
          bio: typeof a.bio === 'string' ? a.bio : '',
          link: typeof a.link === 'string' ? a.link : '',
          // The picture is the hash of bytes in the media store, and the
          // latest profile act wins outright — including one that clears it.
          // Nothing on screen may read a picture from anywhere but here, or a
          // portrait somebody removed would survive in a cache keyed by handle.
          pic: typeof a.pic === 'string' ? a.pic : '',
          idx: i,
        };
        chron.push({ who: a.id, line: 'updated their profile' });
      }
    } else if (a.t === 'bindAddress') {
      // The handle says where its epoch earnings should be paid on Base.
      //
      // RECORDED UNCONDITIONALLY, exactly like contentAuthor above and for the
      // same reason. `payloadGone` is true for every act of a deleted account,
      // and a binding inside that guard would vanish the moment somebody
      // removed a post or left the network — stranding earnings the log still
      // says they are owed. Deleted accounts keep their tokens here (the
      // distribution comment says so in as many words: "the tokens sit unspent,
      // like their standing does"), so they keep the address those tokens can
      // be paid to. Deletion removes payload; this is not payload. It is where
      // money goes, and it is public by design — the act is in the log, in the
      // clear, and anyone can read which address a handle named.
      //
      // NOT DEBITED, and this is the one act where free is the careful choice
      // rather than the lazy one. Binding is what turns a number in this log
      // into money somebody can actually take. An account that earned a large
      // share and then ran out of reserve — which is normal, since earning
      // needs no reserve and speaking does — must still be able to say where
      // its earnings go, or the network would owe it PEER it could never reach.
      // So there is no θ here and the host does not W1-gate it; a PIN and the
      // ordinary rate limiter are what stand in a spammer's way, and a rebind
      // costs the spammer the same nothing it costs everyone else.
      if (known(a.id)) {
        var boundTo = bindableAddress(a.addr);
        if (boundTo) {
          addrOf[a.id] = boundTo;                 // newest wins, forward only
          // ...and, separately, WHO MAY CLAIM A PEER BURN FROM IT.
          //
          // Not the same question, and answered with a different rule on
          // purpose. Earnings flow OUT to a bound address, so a handle naming
          // an address it does not hold only hurts itself and newest-wins is
          // right. A PEER burn flows IN from one, so the same rule would let a
          // stranger bind your address and take the reserve your destroyed
          // coins bought — which is exactly what was demonstrated. Recorded
          // here as a COUNT of distinct binders and the earliest time each
          // one said it: an address two handles have named belongs to neither,
          // and a binding filed after a burn cannot reach it.
          //
          // `ts` is the host's stamp on the act. A host could backdate one —
          // but the act sits at a fixed position in an append-only log that
          // everybody has, so a binding dated before burns that were recorded
          // before it is visible to any reader. That is the same standard the
          // rest of this file holds a recorded number to.
          var bnd = addrBinders[boundTo] || (addrBinders[boundTo] = { n: 0, id: null, ts: null, seen: bare() });
          if (!(a.id in bnd.seen)) {
            bnd.seen[a.id] = typeof a.ts === 'number' && isFinite(a.ts) ? a.ts : null;
            bnd.n += 1;
            bnd.id = bnd.n === 1 ? a.id : null;
            bnd.ts = bnd.n === 1 ? bnd.seen[a.id] : null;
          }
          if (!payloadGone) {
            chron.push({ who: a.id, line: 'bound epoch earnings to ' + boundTo.slice(0, 10) + '…' + boundTo.slice(-6)
              + ' on Base — takes effect at the NEXT epoch close; roots already published cannot change' });
          }
        }
      }
    } else if (a.t === 'tag') {
      if (!known(a.author)) continue;
      counter++;
      var tid = typeNode(a.name);
      g.appendHyper(
        { id: 'tgA' + counter, family: 'TagA', src: a.author, tgt: a.target, pd: a.r, pi: a.c, epoch: certsSoFar },
        { id: 'tgT' + counter, family: 'TagT', src: a.target, tgt: tid, pd: a.c, pi: a.r, epoch: certsSoFar }
      );
      weighHome(a.author, a.r, a.c);
      if (!payloadGone) {
        chron.push({
          who: a.author,
          line: 'tagged ' + ((g.nodes.get(a.target) || {}).label || 'something since removed') + ' as #' + a.name,
          to: a.target,
          refs: [{ label: (g.nodes.get(a.target) || {}).label || 'something since removed', id: a.target }],
        });
      }
      debit(a.author);
    } else if (a.t === 'call') {
      // Recorded by the caller after the call ended; the voice itself was
      // peer-to-peer and never touched the record. Priced like a dm.
      if (ledgerById[a.from] && ledgerById[a.to] && ledgerById[a.from].burnBal >= THETA) {
        debit(a.from);
        if (!payloadGone) {
          dms.push({ from: a.from, to: a.to, text: '', call: { outcome: a.outcome, dur: a.dur || 0 }, idx: i });
          var cline = a.outcome === 'completed' ? '☎ call with ' + dispName(a.to) + ' · ' + Math.floor((a.dur || 0) / 60) + ':' + ('0' + ((a.dur || 0) % 60)).slice(-2)
            : a.outcome === 'missed' ? '☎ called ' + dispName(a.to) + ' — no answer'
            : a.outcome === 'declined' ? '☎ called ' + dispName(a.to) + ' — declined'
            : '☎ call to ' + dispName(a.to) + ' failed to connect';
          chron.push({ who: a.from, line: cline });
        }
      }
    } else if (a.t === 'editPost') {
      // Applies only inside the server-enforced 5-minute window; replay just
      // swaps the payload of the (still-visible) target.
      var ecid = actContent[a.target];
      if (ecid && !mutedContent[ecid] && payloads[ecid] !== undefined) {
        payloads[ecid] = a.text;
        if (postMeta[ecid]) postMeta[ecid].edited = true;
        chron.push({ who: a.author, line: 'edited a post — within the 5-minute window', to: ecid });
      }
    } else if (a.t === 'deletePost') {
      chron.push({ who: a.author, line: 'deleted a post — content redacted from the served record' });
    } else if (a.t === 'deleteAccount') {
      chron.push({ who: a.id, line: 'account deleted — content redacted, handle stays reserved' });
    } else if (a.t === 'btcClaim' || a.t === 'assetCreate' || a.t === 'tokenSend'
        || a.t === 'poolCreate' || a.t === 'poolAdd' || a.t === 'poolRemove' || a.t === 'poolSwap'
        || a.t === 'advert' || a.t === 'adStop') {
      // The host refuses invalid token acts at the door with the same
      // tokenActError the replay consults, so a served log contains only
      // applicable ones. The check runs here anyway: a hand-edited or foreign
      // log must degrade to skipped acts, never to NaN balances.
      if (tokenActError(a) === null) {
        debit(a.author); // an act like any other: θ down, N up — and no edge,
                         // no vouch, no weighing. Value moves; standing does not.
        if (a.t === 'advert') {
          adSeq++;
          var adDays = Math.floor(a.days);
          var adCost = round6(AD_PEER_PER_DAY * adDays);
          tokDebit('PEER', a.author, adCost);
          tokenSupply.PEER = round6(tokenSupply.PEER - adCost);  // burned, not moved
          adverts.push({
            id: 'ad' + adSeq, by: a.author, text: a.text.trim(), url: a.url,
            days: adDays, paid: adCost, at: a.ts || 0,
            until: (a.ts || 0) + adDays * 86400000,
            aim: {
              placement: Array.isArray(a.placement) ? a.placement : [],
              tags: Array.isArray(a.tags) ? a.tags : [],
              people: Array.isArray(a.people) ? a.people : [],
              posts: Array.isArray(a.posts) ? a.posts : [],
              regions: Array.isArray(a.regions) ? a.regions : [],
            },
            stopped: false,
          });
          if (!payloadGone) chron.push({ who: a.author, line: 'bought a placement for ' + adDays + ' day(s) · burned ' + adCost + ' tBTC · it holds no standing and ranks nothing' });
        } else if (a.t === 'adStop') {
          for (var as = 0; as < adverts.length; as++) if (adverts[as].id === a.ad) adverts[as].stopped = true;
          if (!payloadGone) chron.push({ who: a.author, line: 'stopped advert ' + a.ad });
        } else if (a.t === 'btcClaim') {
          btcClaimed[a.author] = true;
          tokCredit('tBTC', a.author, TBTC_CLAIM);
          tokenSupply.tBTC = round6(tokenSupply.tBTC + TBTC_CLAIM);
          if (!payloadGone) chron.push({ who: a.author, line: 'claimed ' + TBTC_CLAIM + ' tBTC — sandbox value, one claim per account' });
        } else if (a.t === 'assetCreate') {
          tokenMeta[a.sym] = { name: a.name.trim(), creator: a.author };
          tokenSupply[a.sym] = a.supply;
          tokCredit(a.sym, a.author, a.supply);
          if (!payloadGone) chron.push({ who: a.author, line: 'minted ' + a.supply + ' ' + a.sym + ' — “' + a.name.trim() + '” — a fun asset, worth what a pool says it is', refs: [{ label: dispName(a.author), id: a.author }] });
        } else if (a.t === 'tokenSend') {
          tokDebit(a.sym, a.author, a.amt);
          tokCredit(a.sym, a.to, a.amt);
          if (!payloadGone) chron.push({ who: a.author, line: 'sent ' + a.amt + ' ' + a.sym + ' to ' + dispName(a.to), refs: [{ label: dispName(a.to), id: a.to }] });
        } else if (a.t === 'poolCreate') {
          var pid = poolId(a.symA, a.symB);
          var A = pid.split('/')[0], B = pid.split('/')[1];
          var depA = A === a.symA ? a.amtA : a.amtB;
          var depB = A === a.symA ? a.amtB : a.amtA;
          tokDebit(A, a.author, depA); tokDebit(B, a.author, depB);
          var s0 = Math.sqrt(depA * depB);
          var sh = bare(); sh[a.author] = s0 - TOK_MINLIQ; sh['_locked'] = TOK_MINLIQ;
          pools[pid] = { a: A, b: B, resA: depA, resB: depB, totalShares: s0, shares: sh, swaps: 0, volA: 0, volB: 0 };
          if (!payloadGone) chron.push({ who: a.author, line: 'opened the ' + pid + ' pool with ' + round6(depA) + ' ' + A + ' + ' + round6(depB) + ' ' + B });
        } else if (a.t === 'poolAdd') {
          var pl = pools[a.pool];
          var r = Math.min(a.amtA / pl.resA, a.amtB / pl.resB);
          var useA = r * pl.resA, useB = r * pl.resB;
          tokDebit(pl.a, a.author, useA); tokDebit(pl.b, a.author, useB);
          var minted = r * pl.totalShares;
          pl.resA += useA; pl.resB += useB;
          pl.totalShares += minted;
          pl.shares[a.author] = (pl.shares[a.author] || 0) + minted;
          if (!payloadGone) chron.push({ who: a.author, line: 'added liquidity to ' + a.pool + ' (' + round6(useA) + ' ' + pl.a + ' + ' + round6(useB) + ' ' + pl.b + ')' });
        } else if (a.t === 'poolRemove') {
          var pl2 = pools[a.pool];
          var frac = a.shares / pl2.totalShares;
          var outA = frac * pl2.resA, outB = frac * pl2.resB;
          pl2.shares[a.author] -= a.shares;
          pl2.totalShares -= a.shares;
          pl2.resA -= outA; pl2.resB -= outB;
          tokCredit(pl2.a, a.author, outA); tokCredit(pl2.b, a.author, outB);
          if (!payloadGone) chron.push({ who: a.author, line: 'withdrew from ' + a.pool + ' (' + round6(outA) + ' ' + pl2.a + ' + ' + round6(outB) + ' ' + pl2.b + ')' });
        } else if (a.t === 'poolSwap') {
          var pl3 = pools[a.pool];
          var inA = a.sell === pl3.a;
          var rin = inA ? pl3.resA : pl3.resB;
          var rout = inA ? pl3.resB : pl3.resA;
          // Uniswap-V2 arithmetic: 0.3% of the way in stays with the pool,
          // which is how liquidity providers get paid — k grows on every swap.
          var eff = a.amt * 0.997;
          var out = rout * eff / (rin + eff);
          tokDebit(a.sell, a.author, a.amt);
          if (inA) { pl3.resA += a.amt; pl3.resB -= out; } else { pl3.resB += a.amt; pl3.resA -= out; }
          var buySym = inA ? pl3.b : pl3.a;
          tokCredit(buySym, a.author, out);
          pl3.swaps++;
          if (inA) { pl3.volA += a.amt; } else { pl3.volB += a.amt; }
          if (!payloadGone) chron.push({ who: a.author, line: 'swapped ' + round6(a.amt) + ' ' + a.sell + ' → ' + round6(out) + ' ' + buySym + ' in ' + a.pool });
        }
      }
    } else if (a.t === 'market') {
      if (!known(a.author)) continue;
      // The node is minted UNCONDITIONALLY once the author is known, exactly
      // as an event or a stream is, and the market record is built only if
      // the parameters hold up. Every later content id is measured from this
      // counter, so nothing that could ever change its mind — a balance, a
      // validation rule, a redaction — may decide whether it ticks. A
      // malformed bet is therefore a post with no market attached to it,
      // never a hole in the ids.
      var mErr = marketActError({ t: 'market', author: a.author, opts: a.opts, cur: a.cur,
        seats: a.seats, bond: a.bond, feeBp: a.feeBp });
      counter++;
      var mcid = 'c' + counter;
      actContent[i] = mcid;
      contentAuthor[mcid] = a.author;   // unconditional: a departure must not re-cut a closed epoch
      if (payloadGone) mutedContent[mcid] = true;
      g.addNode({ id: mcid, kind: 'Content', label: payloadGone ? '[deleted]' : 'Bet ' + counter });
      g.append({ id: 'pub' + counter, family: 'Publish', src: a.author, tgt: mcid, pd: 0.8, pi: 1, epoch: certsSoFar });
      debit(a.author); weighHome(a.author, 0.8, 1);
      if (!mErr) {
        // The labels are payload and go with a deletion; the COUNT is
        // structure and stays, because stakes name an answer by number and
        // an escrow that forgot how many answers it had could not pay out.
        var mopts = [], mstakes = [], mtotals = [];
        for (var mo = 0; mo < a.opts.length; mo++) {
          mopts.push(payloadGone ? '' : String(a.opts[mo]).slice(0, 60));
          mstakes.push(bare()); mtotals.push(0);
        }
        markets[mcid] = {
          cid: mcid, by: a.author, cur: a.cur, n: mopts.length, opts: mopts,
          at: typeof a.at === 'number' ? a.at : 0,
          // The closing time as the author FIRST stated it. `at` moves when the
          // author closes early; this never does, and the jury window is
          // measured from whichever is later — an early close must not shorten
          // the time the question itself needs to become answerable, or honest
          // seats get struck for a silence they could not lawfully break.
          statedAt: typeof a.at === 'number' ? a.at : 0,
          seats: a.seats, bond: round6(a.bond), feeBp: Math.floor(a.feeBp),
          // Who the author asked. A nomination is an invitation and nothing
          // more: it puts a name on the card, and that name still has to post
          // the bond and win the vote like anybody else who stands.
          nominees: (Array.isArray(a.mods) ? a.mods : []).filter(function (x) {
            return ledgerById[x] && x !== a.author;
          }).slice(0, 8),
          stakes: mstakes, totals: mtotals, pool: 0, byBettor: bare(),
          cands: bare(), votes: bare(), attests: bare(),
          state: 'open', outcome: -1,
          paid: bare(), refunded: bare(), struck: bare(), earned: bare(),
          jury: [], honest: [], guilty: [], feePaid: 0, slashedTotal: 0,
          idx: i,
          // Display state only. What happened to this bet, in log order, each
          // entry carrying the index of the act that did it — so a screen can
          // tell a nominee they were named, a backer that the bet settled, or
          // a seated juror that a certification is due, and can say which of
          // those is newer than the last thing the reader looked at. Nothing
          // reads it back into value: settlement is decided by the maps above.
          hist: [{ i: i, t: 'asked', who: a.author }],
          closedEarly: false,
        };
      }
      if (!payloadGone) {
        creators[mcid] = a.author; payloads[mcid] = a.text;
        postMeta[mcid] = { idx: i, ts: a.ts, edited: false, market: true };
        chron.push({ who: a.author, line: 'asked a bet · ' + String(a.text).slice(0, 60)
          + (mErr ? ' — no market opened: ' + mErr
            : ' · ' + markets[mcid].n + ' answers · ' + markets[mcid].seats + '-seat jury · bond '
              + fmtAmt(markets[mcid].bond) + ' ' + markets[mcid].cur), to: mcid });
      }
    } else if (a.t === 'bet') {
      if (marketActError({ t: 'bet', author: a.author, cid: a.cid, opt: a.opt, amt: a.amt }) !== null) continue;
      var bm = markets[a.cid];
      // ONE quantity, debited and recorded. The two must be the same number or
      // the escrow does not add up to what it will be asked to pay.
      var stake = mktAmt(a.amt);
      tokDebit(bm.cur, a.author, stake);
      bm.stakes[a.opt][a.author] = round6((bm.stakes[a.opt][a.author] || 0) + stake);
      bm.totals[a.opt] = round6(bm.totals[a.opt] + stake);
      bm.pool = round6(bm.pool + stake);
      bm.byBettor[a.author] = round6((bm.byBettor[a.author] || 0) + stake);
      debit(a.author);
      // Money is moving from this account toward the author of the bet, so
      // engagement between them earns nothing for the rest of the epoch — the
      // same rule an entry fee triggers, for the same reason: a payment must
      // not be able to buy the reactions that mint PEER.
      paidTo[a.author + '>' + bm.by] = true;
      bm.hist.push({ i: i, t: 'bet', who: a.author, opt: a.opt, amt: stake });
      if (!payloadGone) {
        chron.push({ who: a.author, line: 'staked ' + fmtAmt(a.amt) + ' ' + bm.cur + ' on “'
          + (bm.opts[a.opt] || 'answer ' + (a.opt + 1)) + '” — escrowed, and in no score', to: a.cid });
      }
    } else if (a.t === 'modStand') {
      if (marketActError({ t: 'modStand', author: a.author, cid: a.cid, on: a.on }) !== null) continue;
      var sm = markets[a.cid];
      debit(a.author);
      sm.hist.push({ i: i, t: a.on === false ? 'down' : 'stand', who: a.author });
      if (a.on === false) {
        var backBond = sm.cands[a.author];
        delete sm.cands[a.author];
        tokCredit(sm.cur, a.author, backBond);
        // Ballots naming somebody who has stood down simply stop counting for
        // them: mktSeats reads the candidate map, so nothing has to be
        // rewritten and no vote already cast is silently re-pointed.
        if (!payloadGone) {
          chron.push({ who: a.author, line: 'stood down from a jury — bond returned in full', to: a.cid });
        }
      } else {
        tokDebit(sm.cur, a.author, sm.bond);
        sm.cands[a.author] = sm.bond;
        if (!payloadGone) {
          chron.push({ who: a.author, line: 'stood for a jury seat · bonded ' + fmtAmt(sm.bond) + ' ' + sm.cur
            + ' — forfeit if they certify against the jury', to: a.cid });
        }
      }
    } else if (a.t === 'modVote') {
      if (marketActError({ t: 'modVote', author: a.author, cid: a.cid, for: a.for }) !== null) continue;
      var vm = markets[a.cid];
      // Latest ballot wins outright, and an empty one withdraws support. That
      // is what makes a seat recallable: the community can move its weight to
      // somebody else at any point the host is still taking ballots, without
      // any separate machinery for throwing a moderator out.
      // The ballot carries the weight it was cast with. `for` is defaulted
      // exactly as marketActError defaults it: the rulebook accepted an act
      // with no `for` field and this line then threw on a.for.slice(), which
      // is a host-and-replay divergence even though the HTTP door refuses it
      // today. The two must read the same act the same way.
      vm.votes[a.author] = { for: (Array.isArray(a.for) ? a.for : []).slice(), wt: burnedSats[a.author] || 0 };
      debit(a.author);
      vm.hist.push({ i: i, t: 'vote', who: a.author, n: vm.votes[a.author].for.length });
      if (!payloadGone) {
        chron.push({ who: a.author, line: vm.votes[a.author].for.length
          ? 'voted for ' + vm.votes[a.author].for.map(dispName).join(', ') + ' on a jury · weight '
            + (burnedSats[a.author] || 0) + ' sat destroyed'
          : 'withdrew their jury ballot', to: a.cid });
      }
    } else if (a.t === 'attest') {
      if (marketActError({ t: 'attest', author: a.author, cid: a.cid, opt: a.opt }) !== null) continue;
      var am = markets[a.cid];
      am.attests[a.author] = a.opt;
      debit(a.author);
      am.hist.push({ i: i, t: 'attest', who: a.author, opt: a.opt });
      if (!payloadGone) {
        chron.push({ who: a.author, line: 'certified “' + (a.opt === -1 ? 'no answer — void' : (am.opts[a.opt] || 'answer ' + (a.opt + 1)))
          + '” on a bet · bond at risk until the jury agrees', to: a.cid });
      }
      // The verdict is reached by an ACT landing, never by a clock ticking:
      // that is what keeps settlement a pure function of the log.
      var verdict = mktVerdict(am);
      if (verdict !== null) {
        var out = mktSettle(am, verdict);
        am.hist.push({ i: i, t: verdict === -1 ? 'void' : 'settled', outcome: verdict, who: a.author });
        chron.push({ line: 'a bet resolved to “'
          + (verdict === -1 ? 'no answer — void, every stake returned' : (am.opts[verdict] || 'answer ' + (verdict + 1)))
          + '” · pool ' + fmtAmt(am.pool) + ' ' + am.cur
          + ' · fee ' + fmtAmt(out.fee)
          + (out.slashed > 0 ? ' · ' + out.guilty.length + ' bond(s) struck for ' + fmtAmt(out.slashed) : ''), to: a.cid });
      }
    } else if (a.t === 'marketVoid') {
      if (marketActError({ t: 'marketVoid', author: a.author, cid: a.cid }) !== null) continue;
      var zm = markets[a.cid];
      debit(a.author);
      var zout = mktSettle(zm, -1, true);
      zm.hist.push({ i: i, t: 'void', who: a.author, outcome: -1 });
      chron.push({ who: a.author, line: 'called time on a bet the jury never settled — every stake returned in full'
        + (zout.slashed > 0 ? ', ' + zout.guilty.length + ' silent seat(s) struck for ' + fmtAmt(zout.slashed) : ''), to: a.cid });
    } else if (a.t === 'marketClose') {
      if (marketActError({ t: 'marketClose', author: a.author, cid: a.cid }) !== null) continue;
      var cm = markets[a.cid];
      debit(a.author);
      // The closing time moves to the moment this act landed. `ts` is the
      // stamp the host wrote on the act before appending it — a number in the
      // log like `at` itself, not a clock consulted here — so every replay of
      // this record moves the same closing time to the same instant, and every
      // door that reads `at` (the host refusing late stakes and ballots, the
      // card saying betting is closed, the jury deadline measured from the
      // close) follows without knowing anything changed. Only ever earlier:
      // a close that would move the time LATER is not a close.
      if (typeof a.ts === 'number' && a.ts > 0 && (!(cm.at > 0) || a.ts < cm.at)) {
        cm.at = a.ts;
        cm.closedEarly = true;
        cm.hist.push({ i: i, t: 'close', who: a.author });
        chron.push({ who: a.author, line: 'closed betting early on their bet — no more stakes; the jury certifies from here', to: a.cid });
      }
    } else if (a.t === 'closeEpoch') {
      // The certificate for a closed epoch is a full standing solve, and it
      // used to run here, inside the loop — once per epoch, over every cell
      // accumulated so far. That single line was ~89% of replay time and the
      // whole reason cost grew ~n²: more acts meant both more epochs and a
      // costlier solve each.
      //
      // Nothing downstream consumes it. The graph, the ledgers and the final
      // solve are unaffected; only epochHistory.length is read (as CoGra's
      // certificate count and as epochNow), and stamp/headroom/pass are read
      // by exactly one screen. So snapshot the cheap inputs and settle the
      // certificate on first access — same numbers, paid for only by whoever
      // actually looks at them.
      // Built in its own function: `var` is function-scoped, so snapshotting
      // inline would give every epoch's getter the LAST epoch's data.
      var ep = deferEpoch(E, a.epoch, ledgers, compileCells(bundles, selfCells), deltaActs);
      epochHistory.push(ep.record);
      chron.push(ep.chron);
      deltaActs = {};
      certsSoFar++;

      // ── PEER distribution for the epoch that just closed ────────────────
      tokEpochN++;
      // The bindings this epoch pays to, frozen at the close and never
      // consulted again. A COPY per epoch, not a shared reference: two epochs
      // pointing at one object would mean a caller touching last month's map
      // silently rewrote this month's, which is precisely the class of quiet
      // rewrite the whole chain exists to make impossible. The copy is a
      // handful of short strings per closed epoch; the aliasing bug it avoids
      // would be unfindable.
      var addrSnap = {};
      for (var ak in addrOf) addrSnap[ak] = addrOf[ak];
      addrAtEpoch[tokEpochN] = addrSnap;
      var emission = tokenSupply.PEER >= TOK_CAP ? 0
        : Math.min(TOK_EPOCH * Math.pow(TOK_DECAY, Math.floor((tokEpochN - 1) / TOK_YEAR)), TOK_CAP - tokenSupply.PEER);
      var tokPool = round6(emission + tokenCarry);
      var tw = bare(), twTotal = 0, pairN = bare(), twDetail = bare();
      for (var te = 0; te < epochEngage.length; te++) {
        var ev = epochEngage[te];
        var al = ledgerById[ev.actor];
        if (!al || al.actCount === 0) continue;
        // Weight comes from burn the account ACQUIRED, never from the
        // registration grant. Registering hands out burnBal so a newcomer can
        // act at all; treating that as evidence of commitment made a fresh
        // puppet weigh MORE than a real participant (measured: alpha-hat 9.47
        // against 1.83, and twenty free registrations took 55.9% of an epoch
        // from twenty burned, active users). A grant is a starter, not a
        // stake. An account that has burned nothing now weighs nothing.
        // ── Weight is linear in value actually destroyed ──────────────────
        //
        // It used to be λ(α̂)=α̂/(1+α̂) over FAUCET burn, and TOKEN.md said
        // plainly what that meant: λ saturates per account, so splitting a
        // stake across twenty puppets beat concentrating it (measured 59.6%
        // capture), and the stake itself was free — the cost of weight was
        // the cost of registering. Both halves are gone now. Weight is the
        // satoshis an account proved it destroyed, counted linearly, so
        // twenty accounts holding a stake between them weigh exactly what
        // one account holding all of it weighs. Sybils stop paying.
        //
        // The faucet still exists and still buys the energy to act — nobody
        // is locked out of speaking — it just does not buy a share of the
        // mint any more.
        var sats = burnedSats[ev.actor] || 0;
        if (sats <= 0) continue;                         // no real burn, no weight
        var ahat = sats / TOK_SAT_UNIT;
        // A creator who later deleted their account still earned their share.
        // Skipping them here would silently re-cut every OTHER creator's slice
        // of an epoch that closed long ago — the same defect as a deletion that
        // moves everyone's standing. The tokens sit unspent, like their
        // standing does.
        var pk = ev.actor + '>' + ev.creator;
        pairN[pk] = (pairN[pk] || 0) + 1;
        var damp = 1 / (1 + TOK_DIM * (pairN[pk] - 1));
        var lam = ahat;                                  // linear, not saturating
        var w = ev.base * damp * lam;
        tw[ev.creator] = (tw[ev.creator] || 0) + w;
        twTotal += w;
        // Keep the arithmetic, not just the total. "You earned 2,341 PEER" is
        // a number to take on trust; "because bob commented on c123, weight
        // 1.2 x damping 1.00 x their rate factor 0.65" is a number anyone can
        // check against the same log. Capped per creator so one very popular
        // epoch cannot make the state unbounded.
        var det = twDetail[ev.creator] || (twDetail[ev.creator] = []);
        if (det.length < 40) {
          det.push({ actor: ev.actor, kind: ev.kind, cid: ev.cid,
            base: ev.base, damp: round6(damp), lambda: round6(lam),
            nth: pairN[pk], weight: round6(w) });
        }
      }
      // Epochs that closed before the reset pay nobody: their weights were
      // computed under the free-faucet rule this reset exists to retire. The
      // pool they would have paid is not lost — it carries, like any epoch
      // nobody engaged in, and reaches the people who burn for real.
      if (certsSoFar <= tokenEpoch0) twTotal = 0;
      if (twTotal > 0 && tokPool > 0) {
        var credited = 0, distTo = bare();
        for (var tk in tw) {
          // Round DOWN, always. round6 rounds to nearest, so summing the
          // per-creator shares could exceed the epoch pool by up to half a
          // micro-token each — which quietly minted past the emission
          // schedule and past the 18.25M cap (the live log had already
          // drifted 4e-6 over 55 epochs). Flooring can only under-distribute,
          // and the remainder carries to the next epoch like any other dust.
          var amt = Math.floor(tokPool * tw[tk] / twTotal * 1e6) / 1e6;
          if (amt <= 0) continue;
          tokCredit('PEER', tk, amt);
          distTo[tk] = amt;
          credited = round6(credited + amt);
        }
        tokenSupply.PEER = round6(tokenSupply.PEER + credited);
        tokenCarry = Math.max(0, round6(tokPool - credited));
        tokenDist.push({
          epoch: tokEpochN, minted: credited, carried: tokenCarry, to: distTo,
          pool: tokPool, emission: round6(emission), totalWeight: round6(twTotal),
          weights: tw, why: twDetail,
        });
        chron.push({ line: 'epoch ' + tokEpochN + ' minted ' + credited + ' PEER across ' + Object.keys(distTo).length + ' creator(s) — engagement-weighted, α̂-gated, never standing' });
      } else {
        tokenCarry = tokPool; // an epoch nobody engaged in mints for the next
        tokenDist.push({
          epoch: tokEpochN, minted: 0, carried: tokenCarry, to: {},
          pool: tokPool, emission: round6(emission), totalWeight: 0,
          weights: {}, why: {},
          // Nobody who engaged this epoch cleared the commitment gate, so the
          // whole pool rolls forward rather than being lost.
          note: 'no eligible engagement',
        });
      }
      epochEngage = [];
    paidTo = {};
    }
  }

  // The last act's edges, which no next iteration will claim. Edges appended
  // AFTER this point — the self-declaration and self-reputation pair below,
  // recomputed from the solved standing — belong to no act and get no entry,
  // which is the honest answer for them.
  while (edgeAct.length < g.edges.length) edgeAct.push(acts.length - 1);

  // Deleted actors leave the standings solve entirely: their vouches (given
  // and received) and self-cells are dropped before compilation.
  // Deleted actors STAY in the solve. Removing their vouches retroactively
  // rewrote everyone else's standing and broke already-published epoch
  // certificates; the spec is explicit that erasing payload "changes no
  // standing, title, or reward". Leaving is a payload right, not a way to
  // withdraw commitments already transported to other people.

  var cells = compileCells(bundles, selfCells);
  var solved = E.solveStanding(ledgers, cells, { tilt: 1 });
  var xById = {};
  solved.ids.forEach(function (id, i) { xById[id] = solved.x[i]; });

  var epochNow = epochHistory.length + 1;
  for (var id2 in ledgerById) {
    if (id2 === 'alice') continue;
    var S = NU * (xById[id2] || 0);
    var bond = S / (NU + S);
    var tenure = 1 - 1 / (epochNow - kReg[id2] + 1);
    if (bond > 0) {
      g.append({ id: 'dec_' + id2, family: 'SelfDeclaration', src: id2, tgt: 'prof_' + id2, pd: 1, pi: bond, tauOverride: tenure });
      g.append({ id: 'rep_' + id2, family: 'SelfReputation', src: 'prof_' + id2, tgt: id2, pd: 1, pi: bond, tauOverride: tenure });
    }
  }
  // Raw handles stayed intact for mention determinism; the UI sees '[deleted]'.
  var dispHandles = {};
  for (var hk in handles) dispHandles[hk] = deletedActors[hk] ? '[deleted]' : handles[hk];
  // The per-epoch PEER-burn use, divided into reserve for the surfaces that
  // speak in reserve. Derived here, once, from the integer satoshis the rule
  // is actually enforced on — never accumulated as reserve, which is how the
  // drift this replaces got in.
  var peerBurnUsedReserve = bare();
  for (var pbk in peerBurnEpochUse) peerBurnUsedReserve[pbk] = peerBurnEpochUse[pbk] / SATS_PER_RESERVE;
  return {
    follows: follows, followers: followers, profiles: profiles,
    events: events, eventInvites: eventInvites, eventGoing: eventGoing,
    g: g, ledgers: ledgers, ledgerById: ledgerById, handles: dispHandles, creators: creators,
    payloads: payloads, bundles: bundles, cells: cells, solved: solved, xById: xById,
    deltaActs: deltaActs, dmap: new Map(Object.keys(deltaActs).map(function (k) { return [k, deltaActs[k]]; })),
    epochHistory: epochHistory, chron: chron, epochNow: epochNow,
    reviewMeta: reviewMeta, mediaMeta: mediaMeta, dms: dms, pinHash: pinHash, l0: l0,
    deleted: deletedActors, postMeta: postMeta,
    tokens: { bal: tokenBal, meta: tokenMeta, supply: tokenSupply, claimed: btcClaimed,
      dist: tokenDist, carry: tokenCarry, epochN: tokEpochN },
    // handle -> Base address, as it stands now; and the same map as it stood
    // at each epoch close. An earnings tree is built from the SNAPSHOT of the
    // epoch it pays (chain/earnings.mjs) — never from the live map, or a
    // rebinding today would recompute a root published last month.
    addresses: addrOf,
    addressesAt: addrAtEpoch,
    pools: pools,
    markets: markets,
    // Exposed for the same reason tokenActError is: the screen asks the same
    // question the host will ask, in the same words, before it claims anything
    // happened. A button that says 'Staked.' at somebody the host is about to
    // refuse is a lie the interface told on the network's behalf.
    marketActError: marketActError,
    marketSeats: mktSeats,
    marketLimits: { minOpts: MKT_MIN_OPTS, maxOpts: MKT_MAX_OPTS, maxFeeBp: MKT_FEE_MAX_BP,
      seats: [1, 3, 5], resolveMs: MKT_RESOLVE_MS },
    adverts: adverts,
    adPricePerDay: AD_PEER_PER_DAY,
    tokenActError: tokenActError,
    // ── The PEER door, as the log leaves it ────────────────────────────────
    // `by` is raw PEER destroyed per account and `tx` is who claimed which
    // Base transaction. Neither is a balance and neither weighs anything: the
    // mint and the writer election read burnedSats, which this door does not
    // write. `usedThisEpoch` is what the ceiling is measured against, keyed
    // (id '@' epoch), so a screen can show somebody their remaining headroom
    // instead of letting them burn into a refusal.
    //
    // `limits` is published for the same reason marketLimits is: the page and
    // the host door must refuse in the same words, using the same numbers,
    // that replay will use — a button that says 'Burned.' at a burn replay is
    // about to ignore is a lie the interface told on the network's behalf.
    peerBurn: {
      by: peerBurnedRaw,
      tx: peerBurnTxBy,
      // How many satoshis of each transaction have been converted so far, and
      // by whom. Published because the host's watcher has to know the
      // difference between "already credited" and "credited as far as this
      // epoch allowed" — a burn bigger than one epoch's ceiling is finished
      // over several, and a watcher that treated the first act as the end of
      // it would strand the remainder forever.
      txCreditedSats: peerBurnTxSats,
      // Counted in satoshis; `usedThisEpoch` is the same numbers divided, kept
      // because every screen and the host door already read it as reserve.
      usedSatsThisEpoch: peerBurnEpochUse,
      usedThisEpoch: peerBurnUsedReserve,
      poolUsedSatsThisEpoch: peerBurnPoolUse,
      // Who may claim a burn from which address, as the log decides it. `n`
      // above one means nobody: see the ownership block in peerBurnActError.
      binders: addrBinders,
      limits: {
        satsPerReserve: SATS_PER_RESERVE,
        reservePerEpoch: PEER_BURN_RESERVE_PER_EPOCH,
        satsPerEpoch: PEER_BURN_SATS_PER_EPOCH,
        capFromEpoch: PEER_BURN_CAP_FROM_EPOCH,
        minPoolSats: PEER_BURN_MIN_POOL_SATS,
        twapMs: PEER_BURN_TWAP_MS,
        twapObs: PEER_BURN_TWAP_OBS,
        // How many buckets the window is cut into. The host samples with this
        // number and replay re-derives the grid with it, so it is one number
        // and not two that happen to agree today.
        twapGrid: PEER_BURN_GRID,
        addr: PEER_BURN_ADDR,
        // Written out so no screen has to phrase it from memory. The two
        // doors are not equally provable and every surface that shows them
        // together owes the reader this sentence.
        provenance: 'A bitcoin burn pays a P2WSH commitment to a script that cannot be satisfied — unspendable by arithmetic, checkable by anyone. A PEER burn pays a dead address that is unspendable only because nobody knows a key for it. Both destroy value; only one of them is a proof.',
      },
    },
    peerBurnActError: peerBurnActError,
    // Handed out rather than transcribed into the chain reader. The host has
    // to sample the blocks replay will insist on, and a second copy of this
    // arithmetic is a rule that will one day be enforced at one place and not
    // the other — which here would mean a host that reads honestly and files
    // acts replay throws away.
    peerBurnGrid: peerBurnGrid,
    // appendIndex -> act index, for anything that has to put a graph-derived
    // record and an act-derived one in one order. Sparse at the end on
    // purpose: the self edges appended after the log was consumed have no act.
    edgeAct: edgeAct,
    // act index -> the node that act minted. Exposed because API clients were
    // deriving ids themselves and deriving them wrong — the counter also ticks
    // for hyperedge legs (quotes, mentions), which nothing documented, so a
    // client that counted posts landed one id off and its replies went nowhere.
    actContent: actContent,
  };
}

    return { replay: replayUncached, parseMentions: parseMentions };
  }

  return { create: create };
}));
