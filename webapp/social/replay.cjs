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

function replayUncached(acts) {
  var g = new E.RawGraph();
  var ledgers = [], ledgerById = {}, handles = {}, kReg = {}, creators = {}, payloads = {};
  var bundles = {}, selfCells = [], deltaActs = {}, epochHistory = [], chron = [];
  // Who authored a node, recorded UNCONDITIONALLY. `creators` is inside the
  // payload guard, so a deleted account loses its entries — fine for display,
  // fatal for the token distribution: an epoch that closed months ago would
  // silently re-cut everyone else's share the moment one participant left.
  // Authorship is structure (the Publish edge already carries it publicly),
  // and structure survives deletion. This map is read by distribution only.
  var contentAuthor = {};
  var reviewMeta = {}; // commentNodeId -> {e, f}
  var mediaMeta = {};  // contentId -> [{h, m} | {d, m}]
  var dms = [];        // {from, to, text, idx}
  var pinHash = {};
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
  var deletedActors = {}, deletedPostIdx = {};
  var seenSkel = {}, handleTwin = {};
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
  var mutedContent = {};
  var actContent = {};   // act index -> content id (posts only; edit targets)
  var postMeta = {};
  // The faucet's ceiling. FROM_EPOCH is deliberately ahead of where the live
  // network stands, so no already-recorded standing moves; see the burn branch.
  var FAUCET_PER_EPOCH = 8;
  var FAUCET_CAP_FROM_EPOCH = 62;
  // The epoch the tBTC faucet shuts for good. Ahead of the record on
  // purpose: see the btcClaim branch.
  var TBTC_FAUCET_CLOSED_FROM = 62;
  var faucetCount = {};   // (id '@' epoch) -> how many this epoch
  var events = {};        // cid -> {host, at, place, fee, cur, cap, idx}
  var eventInvites = {};  // cid -> { invitee: true }
  var eventGoing = {};    // cid -> { attendee: true }
  // (actor '>' creator) pairs where money moved this epoch. Cleared with the
  // engagement records at close.
  var paidTo = {};
  function countGoing(cid) { return Object.keys(eventGoing[cid] || {}).length; }
  function fmtAmt(x) { return (Math.round(x * 1e6) / 1e6).toString(); }
  // Attention, recorded but never scored. See the 'follow' branch below.
  var follows = {};     // follower -> { followee: true }
  var followers = {};   // followee -> { follower: true }
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
  var TBTC_CLAIM = 0.01;
  var TOK_MINLIQ = 1e-9; // locked forever at pool birth — kills the classic
                         // first-depositor share-inflation attack
  var tokenBal = {};     // sym -> { actor -> amount }
  var tokenMeta = { PEER: { name: 'Peer epoch token', creator: null },
                    // tBTC is gone. It was a bitcoin-shaped name on a number
                    // this code invented, and after the restart there is no
                    // supply of it and no way to claim any. Kept in the table
                    // only so a pre-restart log still replays; it can hold no
                    // balance, because none was ever minted after genesis.
                    tBTC: { name: 'retired — never real bitcoin, no supply, nothing mints it', creator: null } };
  var tokenSupply = { PEER: 0, tBTC: 0 };
  var btcClaimed = {};
  var pools = {};        // 'A/B' -> { a, b, resA, resB, totalShares, shares: {actor->amt} }
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
  var earnedBurn = {};   // burn an account acquired, EXCLUDING the register grant
  // Value this account destroyed on the Bitcoin chain, in satoshis, proven by
  // a txid anyone can check. Not a balance and not a claim: the coins are
  // gone, paid to a script that can never be satisfied. This is the ONLY
  // thing that weighs in the token distribution now — see TOK_SAT_UNIT.
  var burnedSats = {};
  var burnedTx = {};     // txid -> account, so one burn is claimed exactly once
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
  var markets = {};      // cid -> the record built in the 'market' branch

  function round6(x) { return Math.round(x * 1e6) / 1e6; }
  function balOf(sym, id) { return (tokenBal[sym] && tokenBal[sym][id]) || 0; }
  function tokCredit(sym, id, amt) {
    if (!(amt > 0)) return;
    var m = tokenBal[sym] || (tokenBal[sym] = {});
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
    var m = tokenBal[sym] || (tokenBal[sym] = {});
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
    var w = {}, id;
    for (id in m.cands) w[id] = 0;
    for (var v in m.votes) {
      var wt = burnedSats[v] || 0;
      if (wt <= 0) continue;                    // no proven burn, no weight
      var ballot = m.votes[v];
      for (var k = 0; k < ballot.length; k++) {
        if (w[ballot[k]] !== undefined) w[ballot[k]] += wt;
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
      // A struck bond never goes home. With stakes to compensate it is spread
      // across every one of them pro rata; with no stakes at all there is
      // nobody to compensate, and it falls to the author with the dust.
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
      } else {
        dust = slashed;
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

  for (var i = 0; i < acts.length; i++) {
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
      if (burnedTx[a.txid]) continue;            // a burn is claimed once, ever
      burnedTx[a.txid] = a.id;
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
    } else if (a.t === 'resetTokens') {
      // The ledger starts again. Nothing is rewritten: every act that ever
      // happened is still here and still replays. What changes is which
      // epochs pay — the balances minted while weight was free were farmed
      // by a faucet, and carrying them forward would price that farming in
      // permanently.
      tokenEpoch0 = certsSoFar;
      for (var rsym in tokenBal) tokenBal[rsym] = {};
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
      (eventInvites[a.cid] || (eventInvites[a.cid] = {}))[a.to] = true;
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
          var sh = {}; sh[a.author] = s0 - TOK_MINLIQ; sh['_locked'] = TOK_MINLIQ;
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
          mstakes.push({}); mtotals.push(0);
        }
        markets[mcid] = {
          cid: mcid, by: a.author, cur: a.cur, n: mopts.length, opts: mopts,
          at: typeof a.at === 'number' ? a.at : 0,
          seats: a.seats, bond: round6(a.bond), feeBp: Math.floor(a.feeBp),
          // Who the author asked. A nomination is an invitation and nothing
          // more: it puts a name on the card, and that name still has to post
          // the bond and win the vote like anybody else who stands.
          nominees: (Array.isArray(a.mods) ? a.mods : []).filter(function (x) {
            return ledgerById[x] && x !== a.author;
          }).slice(0, 8),
          stakes: mstakes, totals: mtotals, pool: 0, byBettor: {},
          cands: {}, votes: {}, attests: {},
          state: 'open', outcome: -1,
          paid: {}, refunded: {}, struck: {}, earned: {},
          jury: [], honest: [], guilty: [], feePaid: 0, slashedTotal: 0,
          idx: i,
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
      if (!payloadGone) {
        chron.push({ who: a.author, line: 'staked ' + fmtAmt(a.amt) + ' ' + bm.cur + ' on “'
          + (bm.opts[a.opt] || 'answer ' + (a.opt + 1)) + '” — escrowed, and in no score', to: a.cid });
      }
    } else if (a.t === 'modStand') {
      if (marketActError({ t: 'modStand', author: a.author, cid: a.cid, on: a.on }) !== null) continue;
      var sm = markets[a.cid];
      debit(a.author);
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
      vm.votes[a.author] = a.for.slice();
      debit(a.author);
      if (!payloadGone) {
        chron.push({ who: a.author, line: a.for.length
          ? 'voted for ' + a.for.map(dispName).join(', ') + ' on a jury · weight '
            + (burnedSats[a.author] || 0) + ' sat destroyed'
          : 'withdrew their jury ballot', to: a.cid });
      }
    } else if (a.t === 'attest') {
      if (marketActError({ t: 'attest', author: a.author, cid: a.cid, opt: a.opt }) !== null) continue;
      var am = markets[a.cid];
      am.attests[a.author] = a.opt;
      debit(a.author);
      if (!payloadGone) {
        chron.push({ who: a.author, line: 'certified “' + (a.opt === -1 ? 'no answer — void' : (am.opts[a.opt] || 'answer ' + (a.opt + 1)))
          + '” on a bet · bond at risk until the jury agrees', to: a.cid });
      }
      // The verdict is reached by an ACT landing, never by a clock ticking:
      // that is what keeps settlement a pure function of the log.
      var verdict = mktVerdict(am);
      if (verdict !== null) {
        var out = mktSettle(am, verdict);
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
      chron.push({ who: a.author, line: 'called time on a bet the jury never settled — every stake returned in full'
        + (zout.slashed > 0 ? ', ' + zout.guilty.length + ' silent seat(s) struck for ' + fmtAmt(zout.slashed) : ''), to: a.cid });
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
      var tw = {}, twTotal = 0, pairN = {}, twDetail = {};
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
        var credited = 0, distTo = {};
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
