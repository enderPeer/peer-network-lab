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
  for (var pre = 0; pre < acts.length; pre++) {
    var pact = acts[pre];
    if (pact.t === 'deleteAccount') deletedActors[pact.id] = true;
    else if (pact.t === 'deletePost') deletedPostIdx[pact.target] = true;
  }
  // Content whose payload was removed. Read for display and to refuse edits;
  // it no longer propagates, because muting is never inherited from a target.
  var mutedContent = {};
  var actContent = {};   // act index -> content id (posts only; edit targets)
  var postMeta = {};     // cid -> {idx, ts, edited} for the edit/delete UI
  // Layer 0: the attestation ledger (Peer Attestation v0.6.0). The L1 seam:
  // every attestation increment feeds the actor's residual burn balance.
  var l0 = new E.AttestationLedger({ E0: 100, zeta: 0.5, fee: 0.5, maturityCycle: 10 });
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
  function dispName(id) { return deletedActors[id] ? '[deleted]' : (handles[id] || id); }
  function debit(id) { var l = ledgerById[id]; l.burnBal -= THETA; l.actCount += 1; deltaActs[id] = (deltaActs[id] || 0) + 1; }
  function vouch(author, target, p, r) {
    var key = author + '>' + target;
    var b = bundles[key] || (bundles[key] = { src: author, rcp: target, pd: 0, pi: 0 });
    b.pd += p; b.pi += r;
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
      // Layer-0 seed: residents get an external-reserve faucet and a starter
      // grant of live units from the operator (the genesis holder).
      ['alice', 'bob', 'carol', 'dave'].forEach(function (id) {
        l0.faucet(id, 10);
        l0safe(function () { l0.transfer('op', id, 2, 'live'); });
      });
      chron.push({ who: 'alice', line: 'posted Photo — seed world', to: 'photo' });
      chron.push({ who: 'bob', line: 'reviewed Photo, minting a Comment — seed world', to: 'comment' });
    } else if (a.t === 'register') {
      addActor(a.id, a.handle, a.seed, 0, a.epoch, payloadGone ? '[deleted]' : a.handle);
      if (a.pinHash) pinHash[a.id] = a.pinHash;
      g.append({ id: 'reg_' + a.id, family: 'Registration', src: a.id, tgt: 'prof_' + a.id, pd: 1, pi: 1 });
      debit(a.id); weighHome(a.id, 1, 1);
      // Layer-0 onboarding: external-reserve faucet + operator starter grant.
      // Muted actors keep full economic parity — only visibility goes.
      l0.faucet(a.id, 10);
      l0safe(function () { l0.transfer('op', a.id, 2, 'live'); });
      if (payloadGone) ledgerById[a.id].deleted = true;
      else chron.push({ who: a.id, line: 'registered · genesis attestation ' + a.seed.toFixed(2) + ' · θ-debit' + (a.pinHash ? ' · PIN-secured' : '') });
    } else if (a.t === 'burn') {
      // legacy faucet-burn (pre-economy acts in the shared log)
      ledgerById[a.id].burnBal += a.amt;
      if (!payloadGone) chron.push({ who: a.id, line: 'burned +' + a.amt.toFixed(2) + ' reserve (legacy faucet)' });
    } else if (a.t === 'deposit') {
      if (l0safe(function () { l0.deposit(a.id, a.amt); return true; }) && !payloadGone) {
        chron.push({ who: a.id, line: 'deposited ' + a.amt.toFixed(2) + ' reserve → escrow (mints at the next cycle boundary)' });
      }
    } else if (a.t === 'burnL0') {
      var dA = l0safe(function () { return l0.burn(a.id, a.x); });
      if (dA != null && ledgerById[a.id]) {
        ledgerById[a.id].burnBal += dA; // the L1 seam: attestation is burn_val
        if (!payloadGone) chron.push({ who: a.id, line: 'burned ' + a.x.toFixed(2) + ' live units → attestation +' + dA.toFixed(3) + ' at settled floor φ ' + l0.settledFloor.toFixed(3) });
      }
    } else if (a.t === 'redeem') {
      var pay = l0safe(function () { return l0.redeem(a.id, a.x); });
      if (pay != null && !payloadGone) {
        chron.push({ who: a.id, line: 'redeemed ' + a.x.toFixed(2) + ' live units → ' + pay.toFixed(3) + ' reserve (floor-preserving)' });
      }
    } else if (a.t === 'transferL0') {
      if (l0safe(function () { l0.transfer(a.from, a.to, a.x, a.cls === 'tlock' ? 'tlock' : 'live'); return true; }) && !payloadGone) {
        chron.push({ who: a.from, line: 'sent ' + a.x.toFixed(2) + ' ' + (a.cls === 'tlock' ? 'time-locked' : 'live') + ' units to ' + dispName(a.to) });
      }
    } else if (a.t === 'setPin') {
      if (ledgerById[a.id] && a.pinHash) {
        pinHash[a.id] = a.pinHash; // newest wins — add or change
        if (!payloadGone) chron.push({ who: a.id, line: 'secured the handle with a PIN' });
      }
    } else if (a.t === 'dm') {
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
      var cyc = l0.closeCycle();
      chron.push({ who: null, line: 'L0 cycle ' + l0.cycle + ' processed · minted ' + cyc.minted.toFixed(2) + ' receipt units · settled floor φ ' + cyc.floor.toFixed(4) + (l0.cycle === 10 ? ' · maturity conversion: all time-locked units are now live' : '') });
    } else if (a.t === 'stream') {
      // A stream is a Publish like any other: it mints a Content node, costs
      // θ, and weighs home. That is the whole point — reactions and comments
      // during a broadcast are ordinary Opinion and Review acts targeting this
      // node, so live participation is priced and recorded exactly like every
      // other gesture instead of living in a parallel, unscored channel. The
      // video itself is peer-to-peer and never enters the record.
      counter++;
      var scid = 'c' + counter;
      actContent[i] = scid;
      if (payloadGone) mutedContent[scid] = true;
      g.addNode({ id: scid, kind: 'Content', label: payloadGone ? '[deleted]' : 'Stream ' + counter });
      g.append({ id: 'pub' + counter, family: 'Publish', src: a.author, tgt: scid, pd: a.a, pi: 1, epoch: certsSoFar });
      debit(a.author); weighHome(a.author, a.a, 1);
      if (!payloadGone) {
        creators[scid] = a.author; payloads[scid] = a.text;
        postMeta[scid] = { idx: i, ts: a.ts, edited: false, stream: true };
        chron.push({ who: a.author, line: 'went live · ' + a.text.slice(0, 60), to: scid });
      }
    } else if (a.t === 'post') {
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
        if (!payloadGone && payloads[cid] !== undefined) {
          payloads[cid] = a.text;               // log order gives latest-wins
          if (a.media && a.media.length) mediaMeta[cid] = a.media;
          if (postMeta[cid]) postMeta[cid].edited = true;
          chron.push({ who: a.author, line: 'revised a post — a further record about it, the original stands', to: cid });
        }
      } else {
        counter++;
        cid = 'c' + counter;
        actContent[i] = cid;
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
          chron.push({ who: a.author, line: 'mentioned ' + dispName(mid) + ' — person-vouch compiled', to: cid });
        }
      }
    } else if (a.t === 'opinion') {
      counter++;
      if (!payloadGone) {
        var rec = g.append({ id: 'op' + counter, family: 'Opinion', src: a.author, tgt: a.target, pd: a.p, pi: a.r, epoch: certsSoFar });
        var owner = a.target.indexOf('prof_') === 0 ? a.target.slice(5) : null;
        if (owner && owner !== a.author) vouch(a.author, owner, a.p, a.r);
        else weighHome(a.author, a.p, a.r);
        chron.push({ who: a.author, line: (owner ? 'vouched on ' + dispName(owner) + '’s profile' : 'reacted to ' + ((g.nodes.get(a.target) || {}).label || a.target)) + ' (' + a.p.toFixed(2) + ', ' + a.r.toFixed(2) + ') · τ ' + rec.tau.toFixed(2) + ' · w ' + rec.weight.toFixed(3), to: a.target });
      }
      debit(a.author);
    } else if (a.t === 'review') {
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
      if (payloadGone) mutedContent[cmid] = true;
      g.addNode({ id: cmid, kind: 'Comment', label: payloadGone ? '[deleted]' : 'Review ' + counter });
      g.appendHyper(
        { id: 'rvA' + counter, family: 'ReviewA', src: a.author, tgt: a.target, pd: a.e, pi: a.f, epoch: certsSoFar },
        { id: 'rvT' + counter, family: 'ReviewT', src: a.target, tgt: cmid, pd: a.f, pi: a.e, epoch: certsSoFar }
      );
      weighHome(a.author, a.e, a.f);
      if (!payloadGone) {
        creators[cmid] = a.author; payloads[cmid] = a.text;
        reviewMeta[cmid] = { e: a.e, f: a.f };
        postMeta[cmid] = { idx: i, ts: a.ts, edited: false, comment: true };
        chron.push({ who: a.author, line: 'reviewed ' + ((g.nodes.get(a.target) || {}).label || '') + ' → minted a Comment · one act, two legs', to: cmid });
      }
      debit(a.author);
      }
    } else if (a.t === 'tag') {
      counter++;
      var tid = typeNode(a.name);
      g.appendHyper(
        { id: 'tgA' + counter, family: 'TagA', src: a.author, tgt: a.target, pd: a.r, pi: a.c, epoch: certsSoFar },
        { id: 'tgT' + counter, family: 'TagT', src: a.target, tgt: tid, pd: a.c, pi: a.r, epoch: certsSoFar }
      );
      weighHome(a.author, a.r, a.c);
      if (!payloadGone) {
        chron.push({ who: a.author, line: 'tagged ' + ((g.nodes.get(a.target) || {}).label || '') + ' as #' + a.name, to: a.target });
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
    g: g, ledgers: ledgers, ledgerById: ledgerById, handles: dispHandles, creators: creators,
    payloads: payloads, bundles: bundles, cells: cells, solved: solved, xById: xById,
    deltaActs: deltaActs, dmap: new Map(Object.keys(deltaActs).map(function (k) { return [k, deltaActs[k]]; })),
    epochHistory: epochHistory, chron: chron, epochNow: epochNow,
    reviewMeta: reviewMeta, mediaMeta: mediaMeta, dms: dms, pinHash: pinHash, l0: l0,
    deleted: deletedActors, postMeta: postMeta,
  };
}

    return { replay: replayUncached, parseMentions: parseMentions };
  }

  return { create: create };
}));
