# replay.cjs — complete act dispatch for the Rust port

Companion to `replay-state.md`. Line numbers refer to `webapp/social/replay.cjs`. All arithmetic is copied **verbatim** — evaluation order and operator grouping are part of the spec (`Math.floor(pool*tw/twTotal*1e6)/1e6` is a four-op chain and must stay one).

## Loop preamble (every iteration, lines 1430–1448)

```js
while (edgeAct.length < g.edges.length) edgeAct.push(i - 1);   // fill at TOP: last act's edges
var a = acts[i];
var payloadGone = !!(deletedActors[a.author] || deletedActors[a.from] || deletedActors[a.id] ||
  deletedPostIdx[i]);
```

`payloadGone` is true when the act's own author (any of the three author-ish fields) deleted their account, or the act itself (by index) was delete-posted. Muting is **never** inherited from the target. An act whose `t` matches no branch does nothing at all (no chron, no error). An act naming an unregistered actor is skipped everywhere (`known()`), never a throw.

The deletion pre-scan (before the loop, lines 153–162) is documented in replay-state.md §2; it makes deletion retroactive: deletion removes PAYLOAD only — edges, θ debits, weighing homes, vouches all stay.

---

## `seedWorld` (1449–1473)

No guards. Mutations in order:
1. `addActor('alice','Alice',3,10,0)`, `addActor('bob','Bob',2,8,0)`, `addActor('carol','Carol',4,12,0)`, `addActor('dave','Dave',1,5,0)` (no label arg → label = handle).
2. `g.addNode` ×4: `{id:'photo',kind:'Content',label:'Photo'}`, `{id:'comment',kind:'Comment',label:'Comment'}`, `{id:'streetart',kind:'Type',label:'#StreetArt'}`, `{id:'sneakers',kind:'Item',label:'Sneakers'}`.
3. `g.append` ×9, verbatim ids/families/weights (NO `epoch` field on any):
   - `e1` SelfDeclaration alice→prof_alice pd 1 pi 0.75
   - `e1r` SelfReputation prof_alice→alice pd 1 pi 0.75
   - `e2` Opinion alice→photo pd 0.9 pi 0.7
   - `e3` ReviewA bob→photo pd 0.7 pi 0.8
   - `e4` ReviewT photo→comment pd 0.8 pi 0.7
   - `e5` TagA carol→comment pd 0.8 pi 0.9
   - `e6` TagT comment→streetart pd 0.9 pi 0.8
   - `e7` Affinity alice→streetart pd 0.6 pi 0.8
   - `e8` Owner bob→sneakers pd 0.7 pi 1.0
4. `creators.photo='alice'; creators.comment='bob'; creators.sneakers='bob'; creators.streetart='carol';`
5. `payloads.photo = SEED_POSTS.photo; payloads.comment = SEED_POSTS.comment;`
6. `reviewMeta.comment = { e: 0.7, f: 0.8 };`
7. chron ×2 (unconditional): `{who:'alice', line:'posted Photo — seed world', to:'photo'}`, `{who:'bob', line:'reviewed Photo, minting a Comment — seed world', to:'comment'}`.

No debit, no counter tick, no actContent, no contentAuthor.

## `register` (1474–1499)

No `known` guard (it CREATES the actor; a duplicate register would push a second ledger record and overwrite `ledgerById` — hosts prevent this, replay does not).
1. `addActor(a.id, a.handle, THETA, 0, a.epoch, payloadGone ? '[deleted]' : (handleTwin[a.id] ? a.handle + ' (' + a.id + ', not the original)' : a.handle));` — burnBal starts at THETA, actCount 0, kReg = `a.epoch`. addActor (197–203) does: `g.addNode({id, kind:'Actor', label: lab})`, `g.addNode({id:'prof_'+id, kind:'Profile', label: lab})`, push ledger `{id, burnBal, actCount}`, set `ledgerById`, `handles[id] = handle` (REAL handle, even for twins/deleted), `kReg[id] = epoch`.
2. `if (a.pinHash) pinHash[a.id] = a.pinHash;`
3. `g.append({ id: 'reg_' + a.id, family: 'Registration', src: a.id, tgt: 'prof_' + a.id, pd: 1, pi: 1 });` (no epoch field).
4. `debit(a.id); weighHome(a.id, 1, 1);` — grant THETA and debit THETA cancel: opens at zero.
5. `if (payloadGone) ledgerById[a.id].deleted = true; else chron.push({ who: a.id, line: 'registered · opens at zero, nothing granted' + (a.pinHash ? ' · PIN-secured' : '') });`

## `burn` (1500–1524) — retired faucet

Guard: `if (!known(a.id)) continue;`. Credits **nothing**. Only: `if (!payloadGone) chron.push({ who: a.id, line: 'a faucet burn, from before the restart — credits nothing' });` No debit. (`faucetCount` is never incremented anywhere.)

## `btcBurn` (1525–1565)

Guard: `if (!known(a.id)) continue;`
```js
var btcTx = String(a.txid == null ? '' : a.txid).toLowerCase();
if (burnedTx[btcTx]) continue;             // a burn is claimed once, ever
burnedTx[btcTx] = a.id;
burnedSats[a.id] = (burnedSats[a.id] || 0) + a.sats;
var gained = a.sats / SATS_PER_RESERVE;
ledgerById[a.id].burnBal += gained;
```
No debit, no edge, no deltaActs. Chron (if `!payloadGone`):
```js
chron.push({ who: a.id, line: 'burned ' + a.sats + ' sat to the dead address → +' + gained.toFixed(4)
  + ' reserve · tx ' + String(a.txid).slice(0, 12) + '… (irreversible, verifiable by anyone)' });
```

## `peerBurn` (1566–1626)

Guard: `if (!known(a.id)) continue;` then `var pbWhy = peerBurnActError(a, certsSoFar);` — if non-null: `if (!payloadGone) chron.push({ who: a.id, line: 'a PEER burn was refused by replay — ' + pbWhy }); continue;`

Accepted-path mutations in order:
```js
var pbTx = String(a.txid).toLowerCase();
peerBurnTxBy[pbTx] = a.id;
peerBurnTxSats[pbTx] = (peerBurnTxSats[pbTx] || 0) + a.creditsSats;
peerBurnedRaw[a.id] = String(BigInt(peerBurnedRaw[a.id] || '0') + BigInt(a.amtRaw));
var pbKey = a.id + '@' + certsSoFar;
peerBurnEpochUse[pbKey] = (peerBurnEpochUse[pbKey] || 0) + a.creditsSats;
var pbPool = String(a.factory).toLowerCase() + '#' + a.pool + '@' + certsSoFar;
peerBurnPoolUse[pbPool] = (peerBurnPoolUse[pbPool] || 0) + a.creditsSats;
var pbGained = a.creditsSats / SATS_PER_RESERVE;
ledgerById[a.id].burnBal += pbGained;
```
**`burnedSats` is deliberately NOT touched** (no mint weight, no writer-election weight). No debit. Chron (if `!payloadGone`):
```js
var pbPart = a.creditsSats < a.sats
  ? ' (' + a.creditsSats + ' of the burn’s ' + a.sats + ' sat — the rest after the next epoch closes)'
  : '';
chron.push({ who: a.id, line: 'burned ' + peerText(a.amtRaw) + ' PEER → ' + a.sats + ' sat → +'
  + pbGained.toFixed(4) + ' reserve' + pbPart + ' · tx ' + pbTx.slice(0, 12)
  + '… (priced by the pool, dead-address burn — unspendable because no key is known for it, not provably unspendable like the bitcoin burn beside it)' });
```

## `resetTokens` (1627–1635)

No guards at all.
```js
tokenEpoch0 = certsSoFar;
for (var rsym in tokenBal) tokenBal[rsym] = bare();
if (!payloadGone) chron.push({ who: a.id || null, line: 'the token ledger was reset to zero at epoch ' + certsSoFar + ' — free-minted balances stop here' });
```
Note `who: a.id || null`.

## Retired L0 branches: `deposit` (1636), `burnL0` (1647), `redeem` (1658), `transferL0` (1669), `closeCycle` (1711)

All five are matched by the else-if chain and do **nothing** (comment-only bodies). Acts parse; no chron, no debit, no state change.

## `setPin` (1680–1692)

Guard: `if (ledgerById[a.id] && a.pinHash)` — both required, else nothing.
```js
pinHash[a.id] = a.pinHash;   // newest wins
if (!payloadGone) chron.push({ who: a.id, line: a.byOperator
  ? 'had its PIN reset by the instance operator — not by the account holder'
  : 'secured the handle with a PIN' });
```

## `dm` (1693–1710)

Guards: `if (!known(a.from) || !known(a.to)) continue;` then `if (ledgerById[a.from] && ledgerById[a.to] && ledgerById[a.from].burnBal >= THETA)` (redundant but verbatim).
```js
var pair = [a.from, a.to].sort();          // default JS string sort
var chatId = 'chat_' + pair[0] + '_' + pair[1];
if (!g.nodes.get(chatId)) g.addNode({ id: chatId, kind: 'Chat', label: 'Chat' });
counter++;
var msgId = 'm' + counter;
g.addNode({ id: msgId, kind: 'Message', label: 'Message' });
g.appendHyper(
  { id: 'snA' + counter, family: 'SendA', src: a.from, tgt: chatId, pd: 0.8, pi: 0.8, epoch: certsSoFar },
  { id: 'snT' + counter, family: 'SendT', src: chatId, tgt: msgId, pd: 0.8, pi: 0.8, epoch: certsSoFar }
);
debit(a.from); weighHome(a.from, 0.8, 0.8);
if (!payloadGone) dms.push({ from: a.from, to: a.to, text: a.text, idx: i });
```
No actContent, no contentAuthor, no epochEngage.

## `stream` (1722–1742)

Guard: `if (!known(a.author)) continue;`
```js
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
```

## `event` (1743–1781)

Guard: `if (!known(a.author)) continue;` Same mint skeleton as stream (counter++, `ecid = 'c'+counter`, actContent, contentAuthor unconditional, mutedContent, node label `'Event ' + counter`, Publish `pd: 0.8, pi: 1`, `debit; weighHome(a.author, 0.8, 1)`), then:
```js
events[ecid] = {
  host: a.author,
  at: typeof a.at === 'number' ? a.at : 0,
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
```

## `invite` (1782–1788)

Guards: `if (!known(a.from) || !known(a.to)) continue;` then `var iev = events[a.cid]; if (!iev || iev.host !== a.from || a.to === a.from) continue;`
```js
(eventInvites[a.cid] || (eventInvites[a.cid] = {}))[a.to] = true;
chron.push({ who: a.from, line: 'invited ' + (handles[a.to] || a.to) + ' to an event', to: a.cid });
```
Chron is **unconditional** (no payloadGone guard). Free — no debit.

## `rsvp` (1789–1813)

Guards: `if (!known(a.from)) continue;` `var rev2 = events[a.cid]; if (!rev2) continue;` Then:
```js
var rerr = tokenActError({ t: 'rsvp', author: a.from, cid: a.cid, amt: a.amt, cur: a.cur, to: a.to });
if (a.on === false) {
  if ((eventGoing[a.cid] || {})[a.from]) delete eventGoing[a.cid][a.from];
  chron.push({ who: a.from, line: 'withdrew from an event', to: a.cid });
  continue;                                  // withdraw IGNORES rerr, no refund, no debit
}
if (rerr !== null) continue;
if (rev2.fee > 0) {
  tokDebit(rev2.cur, a.from, rev2.fee);
  tokCredit(rev2.cur, rev2.host, rev2.fee);
  paidTo[a.from + '>' + rev2.host] = true;
}
(eventGoing[a.cid] || (eventGoing[a.cid] = {}))[a.from] = true;
chron.push({ who: a.from, line: rev2.fee > 0
  ? 'paid ' + fmtAmt(rev2.fee) + ' ' + rev2.cur + ' to ' + (handles[rev2.host] || rev2.host) + ' and joined an event'
  : 'joined an event', to: a.cid });
```
**No `debit()`** anywhere in rsvp. Chron unconditional.

## `post` (1814–1896)

Guard: `if (!known(a.author)) continue;`

```js
var isUpdate = Number.isInteger(a.target) && actContent[a.target] !== undefined;
```

**Update path** (mints nothing, no counter tick):
```js
cid = actContent[a.target];
g.append({ id: 'pubu' + i, family: 'Publish', src: a.author, tgt: cid, pd: a.a, pi: 1, epoch: certsSoFar });
debit(a.author); weighHome(a.author, a.a, 1);
if (payloadGone) {
  mutedContent[cid] = true;
  delete payloads[cid]; delete mediaMeta[cid];
  var pn = g.nodes.get(cid); if (pn) pn.label = '[deleted]';
} else if (payloads[cid] !== undefined) {
  payloads[cid] = a.text;                   // log order gives latest-wins
  if (a.media && a.media.length) mediaMeta[cid] = a.media;
  if (postMeta[cid]) postMeta[cid].edited = true;
  chron.push({ who: a.author, line: 'revised a post — a further record about it, the original stands', to: cid });
}
```
**Mint path**: counter++, `cid = 'c'+counter`, `actContent[i] = cid`, `contentAuthor[cid] = a.author`, muted if payloadGone, `g.addNode({id: cid, kind:'Content', label: payloadGone ? '[deleted]' : 'Post ' + counter})`, `g.append({id:'pub'+counter, family:'Publish', src:a.author, tgt:cid, pd:a.a, pi:1, epoch:certsSoFar})`, `debit; weighHome(a.author, a.a, 1)`, then if `!payloadGone`: `creators[cid]=a.author; payloads[cid]=a.text;` `if (a.media && a.media.length) mediaMeta[cid]=a.media;` `postMeta[cid] = { idx: i, ts: a.ts, edited: !!a.edited };` chron `{ who: a.author, line: 'posted · attachment ' + a.a.toFixed(2), to: cid }`.

Then `if (isUpdate) continue;` — references belong to the mint only.

**Quote reference** (mint path only):
```js
if (a.ref && g.nodes.get(a.ref) && ledgerById[a.author] && ledgerById[a.author].burnBal >= THETA) {
  counter++;
  g.appendHyper(
    { id: 'rfA' + counter, family: 'ReferenceA', src: a.author, tgt: cid, pd: 0.8, pi: 0.9, epoch: certsSoFar },
    { id: 'rfT' + counter, family: 'ReferenceT', src: cid, tgt: a.ref, pd: 0.9, pi: 0.8, epoch: certsSoFar }
  );
  debit(a.author); weighHome(a.author, 0.8, 0.9);
  if (!payloadGone) chron.push({ who: a.author, line: 'referenced ' + ((g.nodes.get(a.ref) || {}).label || a.ref) + ' — content-intrinsic citation', to: a.ref });
}
```
**Mentions** (mint path only; `rmen` = server-resolved ids, else legacy parse):
```js
var mentioned = a.rmen !== undefined ? a.rmen : parseMentions(a.text, handles);
for (var mi = 0; mi < mentioned.length; mi++) {
  var mid = mentioned[mi];
  if (mid === a.author || !ledgerById[a.author] || ledgerById[a.author].burnBal < THETA) continue;
  counter++;
  g.appendHyper(
    { id: 'rfA' + counter, family: 'ReferenceA', src: a.author, tgt: cid, pd: 0.7, pi: 0.8, epoch: certsSoFar },
    { id: 'rfT' + counter, family: 'ReferenceT', src: cid, tgt: 'prof_' + mid, pd: 0.8, pi: 0.7, epoch: certsSoFar }
  );
  debit(a.author); vouch(a.author, mid, 0.7, 0.8);
  if (!payloadGone) {
    chron.push({ who: a.author, line: 'mentioned ' + dispName(mid) + ' — person-vouch compiled', to: cid, refs: [{ label: dispName(mid), id: mid }] });
  }
}
```
Note: mentions do NOT check `ledgerById[mid]` here — `rmen` ids are trusted; `parseMentions` only yields registered ids. A mention is the only post leg that compiles a **person-vouch** (no weighHome).

## `opinion` (1897–1926)

Guard: `if (!known(a.author)) continue;` — target NOT existence-checked.
```js
counter++;
var rec = g.append({ id: 'op' + counter, family: 'Opinion', src: a.author, tgt: a.target, pd: a.p, pi: a.r, epoch: certsSoFar });
var owner = a.target.indexOf('prof_') === 0 ? a.target.slice(5) : null;
if (owner && owner !== a.author) vouch(a.author, owner, a.p, a.r);
else weighHome(a.author, a.p, a.r);
if (!owner && contentAuthor[a.target] && contentAuthor[a.target] !== a.author
    && !paidTo[a.author + '>' + contentAuthor[a.target]]) {
  epochEngage.push({ actor: a.author, creator: contentAuthor[a.target], base: a.p >= 0 ? 1.0 : 0.3, cid: a.target, kind: a.p >= 0 ? 'reaction' : 'dislike' });
}
```
Chron (if `!payloadGone`) — uses the returned edge record's `tau`/`weight`:
```js
chron.push({
    who: a.author,
    line: (owner ? 'vouched on ' + dispName(owner) + '’s profile' : 'reacted to ' + ((g.nodes.get(a.target) || {}).label || a.target)) + ' (' + a.p.toFixed(2) + ', ' + a.r.toFixed(2) + ') · τ ' + rec.tau.toFixed(2) + ' · w ' + rec.weight.toFixed(3),
    to: a.target,
    refs: owner
      ? [{ label: dispName(owner), id: owner }]
      : [{ label: (g.nodes.get(a.target) || {}).label || a.target, id: a.target }],
  });
```
Then `debit(a.author);` — debit comes **after** chron here.

## `review` (1927–1976)

Guard: `if (!known(a.author)) continue;`
```js
var isCmtUpdate = Number.isInteger(a.upd) && actContent[a.upd] !== undefined;
```
**Comment-update path** (no counter tick, edge ids use act index `i`):
```js
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
```
No epochEngage on the update path.

**Mint path**: counter++, `cmid = 'c'+counter`, `actContent[i]=cmid`, `contentAuthor[cmid]=a.author`, muted if payloadGone, `g.addNode({id:cmid, kind:'Comment', label: payloadGone ? '[deleted]' : 'Review ' + counter})`, then:
```js
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
```

## `follow` (1977–2007)

Guard: `if (known(a.from) && known(a.to) && a.from !== a.to)`. **No debit — following is free** (deliberate; the test pins it).
```js
var fset = follows[a.from] || (follows[a.from] = {});
var bset = followers[a.to] || (followers[a.to] = {});
if (a.on === false) { delete fset[a.to]; delete bset[a.from]; }
else { fset[a.to] = true; bset[a.from] = true; }
chron.push({ who: a.from, line: (a.on === false ? 'stopped following ' : 'started following ')
  + (handles[a.to] || a.to) + ' — recorded, and in no score' });
```
Chron unconditional; no `to` field.

## `profile` (2008–2024)

Guard: `if (known(a.id))`. No debit.
```js
profiles[a.id] = {
  bio: typeof a.bio === 'string' ? a.bio : '',
  link: typeof a.link === 'string' ? a.link : '',
  pic: typeof a.pic === 'string' ? a.pic : '',
  idx: i,
};
chron.push({ who: a.id, line: 'updated their profile' });
```

## `bindAddress` (2025–2081)

Guard: `if (known(a.id))`, then `var boundTo = bindableAddress(a.addr); if (boundTo) { … }`. **Never debited, recorded unconditionally** (survives deletion — not payload).
```js
addrOf[a.id] = boundTo;                     // newest wins, forward only
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
```
Note: a handle re-binding to a NEW address adds it to that address's `seen` (first bind time per handle per address); rebinding to the SAME address is a no-op for `addrBinders`. `ts` on the binder record is the earliest binding time of the sole binder, null once ambiguous.

## `tag` (2082–2099)

Guard: `if (!known(a.author)) continue;`
```js
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
```
`typeNode` may `g.addNode` a `Type` node (see helpers) — that node insert happens before the hyper edges.

## `call` (2100–2113)

Guard: `if (ledgerById[a.from] && ledgerById[a.to] && ledgerById[a.from].burnBal >= THETA)`.
```js
debit(a.from);
if (!payloadGone) {
  dms.push({ from: a.from, to: a.to, text: '', call: { outcome: a.outcome, dur: a.dur || 0 }, idx: i });
  var cline = a.outcome === 'completed' ? '☎ call with ' + dispName(a.to) + ' · ' + Math.floor((a.dur || 0) / 60) + ':' + ('0' + ((a.dur || 0) % 60)).slice(-2)
    : a.outcome === 'missed' ? '☎ called ' + dispName(a.to) + ' — no answer'
    : a.outcome === 'declined' ? '☎ called ' + dispName(a.to) + ' — declined'
    : '☎ call to ' + dispName(a.to) + ' failed to connect';
  chron.push({ who: a.from, line: cline });
}
```
No graph writes, no weighHome.

## `editPost` (2114–2122)

No known() guard.
```js
var ecid = actContent[a.target];
if (ecid && !mutedContent[ecid] && payloads[ecid] !== undefined) {
  payloads[ecid] = a.text;
  if (postMeta[ecid]) postMeta[ecid].edited = true;
  chron.push({ who: a.author, line: 'edited a post — within the 5-minute window', to: ecid });
}
```
No debit, no edge. (The 5-minute window is host-enforced only.)

## `deletePost` (2123–2124) / `deleteAccount` (2125–2126)

Effects happen via the pre-scan; here only chron (unconditional):
```js
chron.push({ who: a.author, line: 'deleted a post — content redacted from the served record' });
chron.push({ who: a.id, line: 'account deleted — content redacted, handle stays reserved' });
```

## Token group (2127–2220): `btcClaim | assetCreate | tokenSend | poolCreate | poolAdd | poolRemove | poolSwap | advert | adStop`

Single gate: `if (tokenActError(a) === null) { debit(a.author); …sub-branch… }` — a refused act does nothing (no chron). `btcClaim` is **permanently refused** by tokenActError, so its sub-branch (`btcClaimed[a.author] = true; tokCredit('tBTC', a.author, TBTC_CLAIM); tokenSupply.tBTC = round6(tokenSupply.tBTC + TBTC_CLAIM);` + chron `'claimed ' + TBTC_CLAIM + ' tBTC — sandbox value, one claim per account'`) is dead code — port it or assert-unreachable, but it can never run.

All sub-branch chrons are `if (!payloadGone)`.

**advert**:
```js
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
```
Chron (verbatim — the stale "tBTC" wording is part of the record): `'bought a placement for ' + adDays + ' day(s) · burned ' + adCost + ' tBTC · it holds no standing and ranks nothing'`.

**adStop**: `for (var as = 0; as < adverts.length; as++) if (adverts[as].id === a.ad) adverts[as].stopped = true;` chron `'stopped advert ' + a.ad`.

**assetCreate**: `tokenMeta[a.sym] = { name: a.name.trim(), creator: a.author }; tokenSupply[a.sym] = a.supply; tokCredit(a.sym, a.author, a.supply);` chron `'minted ' + a.supply + ' ' + a.sym + ' — “' + a.name.trim() + '” — a fun asset, worth what a pool says it is'` with `refs: [{ label: dispName(a.author), id: a.author }]`.

**tokenSend**: `tokDebit(a.sym, a.author, a.amt); tokCredit(a.sym, a.to, a.amt);` chron `'sent ' + a.amt + ' ' + a.sym + ' to ' + dispName(a.to)` with `refs: [{ label: dispName(a.to), id: a.to }]`.

**poolCreate**:
```js
var pid = poolId(a.symA, a.symB);
var A = pid.split('/')[0], B = pid.split('/')[1];
var depA = A === a.symA ? a.amtA : a.amtB;
var depB = A === a.symA ? a.amtB : a.amtA;
tokDebit(A, a.author, depA); tokDebit(B, a.author, depB);
var s0 = Math.sqrt(depA * depB);
var sh = bare(); sh[a.author] = s0 - TOK_MINLIQ; sh['_locked'] = TOK_MINLIQ;
pools[pid] = { a: A, b: B, resA: depA, resB: depB, totalShares: s0, shares: sh, swaps: 0, volA: 0, volB: 0 };
```
Chron: `'opened the ' + pid + ' pool with ' + round6(depA) + ' ' + A + ' + ' + round6(depB) + ' ' + B`.

**poolAdd**:
```js
var pl = pools[a.pool];
var r = Math.min(a.amtA / pl.resA, a.amtB / pl.resB);
var useA = r * pl.resA, useB = r * pl.resB;
tokDebit(pl.a, a.author, useA); tokDebit(pl.b, a.author, useB);
var minted = r * pl.totalShares;
pl.resA += useA; pl.resB += useB;
pl.totalShares += minted;
pl.shares[a.author] = (pl.shares[a.author] || 0) + minted;
```
Chron: `'added liquidity to ' + a.pool + ' (' + round6(useA) + ' ' + pl.a + ' + ' + round6(useB) + ' ' + pl.b + ')'`.

**poolRemove**:
```js
var pl2 = pools[a.pool];
var frac = a.shares / pl2.totalShares;
var outA = frac * pl2.resA, outB = frac * pl2.resB;
pl2.shares[a.author] -= a.shares;
pl2.totalShares -= a.shares;
pl2.resA -= outA; pl2.resB -= outB;
tokCredit(pl2.a, a.author, outA); tokCredit(pl2.b, a.author, outB);
```
Chron: `'withdrew from ' + a.pool + ' (' + round6(outA) + ' ' + pl2.a + ' + ' + round6(outB) + ' ' + pl2.b + ')'`.

**poolSwap**:
```js
var pl3 = pools[a.pool];
var inA = a.sell === pl3.a;
var rin = inA ? pl3.resA : pl3.resB;
var rout = inA ? pl3.resB : pl3.resA;
var eff = a.amt * 0.997;
var out = rout * eff / (rin + eff);
tokDebit(a.sell, a.author, a.amt);
if (inA) { pl3.resA += a.amt; pl3.resB -= out; } else { pl3.resB += a.amt; pl3.resA -= out; }
var buySym = inA ? pl3.b : pl3.a;
tokCredit(buySym, a.author, out);
pl3.swaps++;
if (inA) { pl3.volA += a.amt; } else { pl3.volB += a.amt; }
```
Chron: `'swapped ' + round6(a.amt) + ' ' + a.sell + ' → ' + round6(out) + ' ' + buySym + ' in ' + a.pool`.
(tokenActError's own out-check computes `rout * (a.amt * 0.997) / (rin + a.amt * 0.997)` — same value, keep both spellings.)

## `market` (2221–2274)

Guard: `if (!known(a.author)) continue;` Then `var mErr = marketActError({ t: 'market', author: a.author, opts: a.opts, cur: a.cur, seats: a.seats, bond: a.bond, feeBp: a.feeBp });` — but **the node mints unconditionally** (counter must tick regardless):

```js
counter++;
var mcid = 'c' + counter;
actContent[i] = mcid;
contentAuthor[mcid] = a.author;
if (payloadGone) mutedContent[mcid] = true;
g.addNode({ id: mcid, kind: 'Content', label: payloadGone ? '[deleted]' : 'Bet ' + counter });
g.append({ id: 'pub' + counter, family: 'Publish', src: a.author, tgt: mcid, pd: 0.8, pi: 1, epoch: certsSoFar });
debit(a.author); weighHome(a.author, 0.8, 1);
```
If `!mErr`, build the market record (see replay-state.md for full shape):
```js
var mopts = [], mstakes = [], mtotals = [];
for (var mo = 0; mo < a.opts.length; mo++) {
  mopts.push(payloadGone ? '' : String(a.opts[mo]).slice(0, 60));
  mstakes.push(bare()); mtotals.push(0);
}
markets[mcid] = {
  cid: mcid, by: a.author, cur: a.cur, n: mopts.length, opts: mopts,
  at: typeof a.at === 'number' ? a.at : 0,
  seats: a.seats, bond: round6(a.bond), feeBp: Math.floor(a.feeBp),
  nominees: (Array.isArray(a.mods) ? a.mods : []).filter(function (x) {
    return ledgerById[x] && x !== a.author;
  }).slice(0, 8),
  stakes: mstakes, totals: mtotals, pool: 0, byBettor: bare(),
  cands: bare(), votes: bare(), attests: bare(),
  state: 'open', outcome: -1,
  paid: bare(), refunded: bare(), struck: bare(), earned: bare(),
  jury: [], honest: [], guilty: [], feePaid: 0, slashedTotal: 0,
  idx: i,
};
```
Chron (if `!payloadGone`):
```js
creators[mcid] = a.author; payloads[mcid] = a.text;
postMeta[mcid] = { idx: i, ts: a.ts, edited: false, market: true };
chron.push({ who: a.author, line: 'asked a bet · ' + String(a.text).slice(0, 60)
  + (mErr ? ' — no market opened: ' + mErr
    : ' · ' + markets[mcid].n + ' answers · ' + markets[mcid].seats + '-seat jury · bond '
      + fmtAmt(markets[mcid].bond) + ' ' + markets[mcid].cur), to: mcid });
```

## `bet` (2275–2295)

Gate: `if (marketActError({ t: 'bet', author: a.author, cid: a.cid, opt: a.opt, amt: a.amt }) !== null) continue;`
```js
var bm = markets[a.cid];
var stake = mktAmt(a.amt);
tokDebit(bm.cur, a.author, stake);
bm.stakes[a.opt][a.author] = round6((bm.stakes[a.opt][a.author] || 0) + stake);
bm.totals[a.opt] = round6(bm.totals[a.opt] + stake);
bm.pool = round6(bm.pool + stake);
bm.byBettor[a.author] = round6((bm.byBettor[a.author] || 0) + stake);
debit(a.author);
paidTo[a.author + '>' + bm.by] = true;
```
Chron (if `!payloadGone`) — note it prints the **raw** `a.amt`:
```js
chron.push({ who: a.author, line: 'staked ' + fmtAmt(a.amt) + ' ' + bm.cur + ' on “'
  + (bm.opts[a.opt] || 'answer ' + (a.opt + 1)) + '” — escrowed, and in no score', to: a.cid });
```

## `modStand` (2296–2317)

Gate: `marketActError({ t: 'modStand', author: a.author, cid: a.cid, on: a.on }) !== null → continue`. Then `var sm = markets[a.cid]; debit(a.author);` (debit FIRST). Stand down (`a.on === false`):
```js
var backBond = sm.cands[a.author];
delete sm.cands[a.author];
tokCredit(sm.cur, a.author, backBond);
```
chron: `'stood down from a jury — bond returned in full'`, to a.cid. Stand:
```js
tokDebit(sm.cur, a.author, sm.bond);
sm.cands[a.author] = sm.bond;
```
chron: `'stood for a jury seat · bonded ' + fmtAmt(sm.bond) + ' ' + sm.cur + ' — forfeit if they certify against the jury'`, to a.cid. Both chrons payload-guarded.

## `modVote` (2318–2337)

Gate via marketActError (`{t:'modVote', author, cid, for: a.for}`). Then:
```js
var vm = markets[a.cid];
vm.votes[a.author] = { for: (Array.isArray(a.for) ? a.for : []).slice(), wt: burnedSats[a.author] || 0 };
debit(a.author);
```
Latest ballot wins; the **weight is frozen at cast time** (`wt`), never re-read. Chron (payload-guarded):
```js
chron.push({ who: a.author, line: vm.votes[a.author].for.length
  ? 'voted for ' + vm.votes[a.author].for.map(dispName).join(', ') + ' on a jury · weight '
    + (burnedSats[a.author] || 0) + ' sat destroyed'
  : 'withdrew their jury ballot', to: a.cid });
```

## `attest` (2338–2357)

Gate via marketActError (`{t:'attest', author, cid, opt: a.opt}`). Then:
```js
var am = markets[a.cid];
am.attests[a.author] = a.opt;               // may be -1 (void)
debit(a.author);
```
Chron (payload-guarded): `'certified “' + (a.opt === -1 ? 'no answer — void' : (am.opts[a.opt] || 'answer ' + (a.opt + 1))) + '” on a bet · bond at risk until the jury agrees'`, to a.cid.
Then settlement-by-act:
```js
var verdict = mktVerdict(am);
if (verdict !== null) {
  var out = mktSettle(am, verdict);          // byDeadline undefined → falsy
  chron.push({ line: 'a bet resolved to “'
    + (verdict === -1 ? 'no answer — void, every stake returned' : (am.opts[verdict] || 'answer ' + (verdict + 1)))
    + '” · pool ' + fmtAmt(am.pool) + ' ' + am.cur
    + ' · fee ' + fmtAmt(out.fee)
    + (out.slashed > 0 ? ' · ' + out.guilty.length + ' bond(s) struck for ' + fmtAmt(out.slashed) : ''), to: a.cid });
}
```
The settle chron has **no `who` key** and is unconditional. Note `verdict` can be `-1` (majority certified void) — settles as void via `mktSettle(am, -1)` with byDeadline falsy.

## `marketVoid` (2358–2364)

Gate via marketActError (`{t:'marketVoid', author, cid}` — only checks actor/energy/market-exists/open). Then:
```js
var zm = markets[a.cid];
debit(a.author);
var zout = mktSettle(zm, -1, true);          // byDeadline TRUE: silence is struck
chron.push({ who: a.author, line: 'called time on a bet the jury never settled — every stake returned in full'
  + (zout.slashed > 0 ? ', ' + zout.guilty.length + ' silent seat(s) struck for ' + fmtAmt(zout.slashed) : ''), to: a.cid });
```
Chron unconditional.

## `marketClose` (added 2026-08-15, follows `marketVoid`)

Gate via marketActError (`{t:'marketClose', author, cid}`): actor/energy/market-exists/open, then `who !== m.by` → `'only the author of a bet closes betting on it early'`, then `m.closedEarly` → `'betting on this bet was already closed early'`. Whether the clock already closed it is host-only. Then:
```js
var cm = markets[a.cid];
debit(a.author);
if (typeof a.ts === 'number' && a.ts > 0 && (!(cm.at > 0) || a.ts < cm.at)) {
  cm.at = a.ts;                 // the closing time moves to the act's own host stamp — only ever earlier
  cm.closedEarly = true;
  cm.hist.push({ i: i, t: 'close', who: a.author });   // JS display state, not ported
  chron.push({ who: a.author, line: 'closed betting early on their bet — no more stakes; the jury certifies from here', to: a.cid });
}
```
`ts` is read as data (the host stamped it before appending) — this is not a clock consulted in replay. Debit happens even when the stamp is missing and nothing moves. `hist` (an array on every market: asked/bet/stand/down/vote/attest/close/settled/void entries with the act index) is display state consumed by the interface and `/api/v1/markets.history`; no epoch package reads it, so the Rust port carries `closed_early` only.

## `closeEpoch` (2365–2495) — full sequence, in order

```js
var ep = deferEpoch(E, a.epoch, ledgers, compileCells(bundles, selfCells), deltaActs);
epochHistory.push(ep.record);
chron.push(ep.chron);
deltaActs = {};
certsSoFar++;

// ── PEER distribution for the epoch that just closed ────────────────
tokEpochN++;
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
  var sats = burnedSats[ev.actor] || 0;
  if (sats <= 0) continue;                         // no real burn, no weight
  var ahat = sats / TOK_SAT_UNIT;
  var pk = ev.actor + '>' + ev.creator;
  pairN[pk] = (pairN[pk] || 0) + 1;
  var damp = 1 / (1 + TOK_DIM * (pairN[pk] - 1));
  var lam = ahat;                                  // linear, not saturating
  var w = ev.base * damp * lam;
  tw[ev.creator] = (tw[ev.creator] || 0) + w;
  twTotal += w;
  var det = twDetail[ev.creator] || (twDetail[ev.creator] = []);
  if (det.length < 40) {
    det.push({ actor: ev.actor, kind: ev.kind, cid: ev.cid,
      base: ev.base, damp: round6(damp), lambda: round6(lam),
      nth: pairN[pk], weight: round6(w) });
  }
}
if (certsSoFar <= tokenEpoch0) twTotal = 0;
if (twTotal > 0 && tokPool > 0) {
  var credited = 0, distTo = bare();
  for (var tk in tw) {
    var amt = Math.floor(tokPool * tw[tk] / twTotal * 1e6) / 1e6;   // FOUR-OP CHAIN, floor
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
  tokenCarry = tokPool;
  tokenDist.push({
    epoch: tokEpochN, minted: 0, carried: tokenCarry, to: {},
    pool: tokPool, emission: round6(emission), totalWeight: 0,
    weights: {}, why: {},
    note: 'no eligible engagement',
  });
}
epochEngage = [];
paidTo = {};
```

Order-sensitivity notes: (1) `deferEpoch` snapshots ledgers/cells/deltaActs **before** `deltaActs = {}` — the certificate sees the epoch's own act counts; (2) `certsSoFar` increments before the `certsSoFar <= tokenEpoch0` reset-guard is evaluated; (3) `for (var tk in tw)` runs in first-engagement-per-creator insertion order — `credited` is a round6 running sum, so **distribution order changes the dust** (must be IndexMap order); (4) the "mint" chron only appears in the paying branch; (5) `twTotal += w` accumulates in epochEngage order (float order matters); (6) engagement eligibility reads `al.actCount === 0` (lifetime count) and live `burnedSats` at close time, not at engagement time.

---

## Refusal logic — exact sentences

### `tokenActError(a)` (969–1096)

Common gates (all token acts): `if (!ledgerById[who]) return 'unknown actor';` `if (ledgerById[who].burnBal < THETA) return 'not enough energy';` (`who = a.author`). Deliberately NOT gated on deletedActors.

- **burn**: `if (certsSoFar < FAUCET_CAP_FROM_EPOCH) return null;` then `var used = faucetCount[who + '@' + certsSoFar] || 0; if (used >= FAUCET_PER_EPOCH)` → `'the faucet gives ' + FAUCET_PER_EPOCH + ' per epoch and this handle has taken them all — burn live units through Layer 0 instead, or wait for the next epoch'`; else null. (Never actually consulted by the `burn` branch — only hosts call it.)
- **rsvp**: `'no such event'` · `'the host is already at their own event'` · capacity (checked BEFORE fee, and again after balance): `if (rev.cap > 0 && countGoing(a.cid) >= rev.cap && !(eventGoing[a.cid] || {})[who])` → `'this event is full — ' + rev.cap + ' places, all taken'` · `if (!(rev.fee > 0)) return null;` · price pin: `if (a.cur !== rev.cur || round6(a.amt) !== round6(rev.fee) || a.to !== rev.host)` → `'this event now asks ' + fmtAmt(rev.fee) + ' ' + rev.cur + ' — the price moved'` · `if (balOf(rev.cur, who) < rev.fee)` → `'you hold ' + fmtAmt(balOf(rev.cur, who)) + ' ' + rev.cur + ' and entry is ' + fmtAmt(rev.fee)` · second capacity check (same sentence).
- **advert**: `var days = Math.floor(a.days); if (!(days >= 1 && days <= 90))` → `'an advert runs between 1 and 90 days'` · `if (typeof a.text !== 'string' || !a.text.trim())` → `'the advert needs text'` · `if (a.text.length > 280)` → `'advert text is ' + a.text.length + ' characters; the limit is 280'` · `if (typeof a.url !== 'string' || !/^https?:\/\/[^\s]{3,300}$/i.test(a.url))` → `'url must be a plain http(s) link'` · `var cost = round6(AD_PEER_PER_DAY * days); if (balOf('PEER', who) < cost)` → `'this advert costs ' + cost + ' PEER for ' + days + ' day(s) and you hold ' + round6(balOf('PEER', who)) + '. This PEER is the epoch token in this log: it is earned by drawing engagement, or bought in a pool inside this log. The PEER on Base is a different token that shares the name and cannot pay for a placement.'`
- **adStop**: linear scan `for (var ai = 0; ai < adverts.length; ai++) if (adverts[ai].id === a.ad) ad = adverts[ai];` → `'no advert with id ' + a.ad` · `if (ad.by !== who && !a.operator)` → `'only the advertiser can stop their own advert'`
- **btcClaim** (unconditional): `'tBTC is retired — it was never bitcoin. Value here comes from a verified Bitcoin burn (GET /api/burn) and from nothing else.'`
- **assetCreate**: `if (!/^[A-Z][A-Z0-9]{2,7}$/.test(a.sym || ''))` → `'symbol must be 3-8 characters, A-Z and digits, starting with a letter'` · `if (tokenMeta[a.sym])` → `'symbol ' + a.sym + ' is taken'` · `if (!(a.supply > 0) || a.supply > 1e9)` → `'supply must be between 0 and 1,000,000,000'` · `if (typeof a.name !== 'string' || !a.name.trim() || a.name.length > 60)` → `'the asset needs a name, at most 60 characters'`
- **tokenSend**: `'no such asset: ' + a.sym` · `if (!(a.amt > 0))` → `'amount must be positive'` · `if (!ledgerById[a.to])` → `'unknown recipient'` · `if (a.to === who)` → `'sending to yourself moves nothing'` · `if (balOf(a.sym, who) < a.amt)` → `'balance is ' + round6(balOf(a.sym, who)) + ' ' + a.sym + ', tried to send ' + a.amt`
- **poolCreate**: `if (!tokenMeta[a.symA] || !tokenMeta[a.symB])` → `'both assets must exist'` · `if (a.symA === a.symB)` → `'a pool needs two different assets'` · `if (pools[poolId(a.symA, a.symB)])` → `'the ' + poolId(a.symA, a.symB) + ' pool already exists — add liquidity to it instead'` · `if (!(a.amtA > 0) || !(a.amtB > 0))` → `'both starting amounts must be positive'` · balances → `'balance is ' + round6(balOf(a.symA, who)) + ' ' + a.symA + ', tried to deposit ' + a.amtA` (and symB variant) · `if (Math.sqrt(a.amtA * a.amtB) <= TOK_MINLIQ * 10)` → `'starting liquidity too small'`
- **poolAdd** (`var pl = pools[a.pool]` looked up before the branch): `if (!pl)` → `'no such pool: ' + a.pool` · `if (!(a.amtA > 0) || !(a.amtB > 0))` → `'both amounts must be positive'` · `var r = Math.min(a.amtA / pl.resA, a.amtB / pl.resB); if (balOf(pl.a, who) < r * pl.resA || balOf(pl.b, who) < r * pl.resB)` → `'not enough balance for that deposit'`
- **poolRemove**: `'no such pool: ' + a.pool` · `var own = (pl.shares[who] || 0); if (!(a.shares > 0) || a.shares > own + 1e-12)` → `'you hold ' + round6(own) + ' shares of ' + a.pool + ', tried to remove ' + a.shares`
- **poolSwap**: `'no such pool: ' + a.pool` · `if (a.sell !== pl.a && a.sell !== pl.b)` → `a.pool + ' does not trade ' + a.sell` · `'amount must be positive'` · `'balance is ' + round6(balOf(a.sell, who)) + ' ' + a.sell + ', tried to sell ' + a.amt` · `var rin = a.sell === pl.a ? pl.resA : pl.resB; var rout = a.sell === pl.a ? pl.resB : pl.resA; var out = rout * (a.amt * 0.997) / (rin + a.amt * 0.997); if (a.minOut !== undefined && out < a.minOut)` → `'that trade would return ' + round6(out) + ', below your minimum of ' + a.minOut + ' — the price moved'`
- fallthrough: `'unknown token act'`

### `marketActError(a)` (1170–1266)

Common: `'unknown actor'` · `'not enough energy'` (same expressions). For `t === 'market'`:
- opts count: `var opts = Array.isArray(a.opts) ? a.opts : []; if (opts.length < MKT_MIN_OPTS || opts.length > MKT_MAX_OPTS)` → `'a bet needs between ' + MKT_MIN_OPTS + ' and ' + MKT_MAX_OPTS + ' answers; this one names ' + opts.length`
- `if (!tokenMeta[a.cur])` → `'no such asset: ' + a.cur`
- `if (!MKT_SEATS[a.seats])` → `'a jury is 1, 3 or 5 seats — an even jury cannot reach a majority'`
- `if (!(a.bond > 0) || a.bond > 1e9)` → `'a seat needs a bond: it is the only thing a corrupt certification can cost'`
- `if (!(a.feeBp >= 0) || a.feeBp > MKT_FEE_MAX_BP)` → `'the resolution fee is at most ' + (MKT_FEE_MAX_BP / 100) + '% of the pool'` (prints `5%`)

Then `var m = markets[a.cid]; if (!m) return 'no such bet: ' + a.cid;` and state gate:
```js
if (m.state !== 'open') {
  return m.state === 'void'
    ? 'that bet was voided — the stakes went back and nothing more moves'
    : 'that bet is already resolved — the pool has been paid out';
}
```
- **bet**: `if (who === m.by)` → `'the author of a bet does not hold a position on it — they are paid a fee whichever answer wins'` · `if (m.cands[who] !== undefined)` → `'a moderator cannot back an answer they may be asked to certify'` · `if (!(a.opt >= 0) || a.opt >= m.n || Math.floor(a.opt) !== a.opt)` → `'there is no answer ' + a.opt + ' on this bet'` · `var v = mktAmt(a.amt); if (!(v > 0))` → `a.amt > 0 ? 'the smallest stake this record can hold is 0.000001 ' + m.cur : 'a stake must be positive'` · `if (balOf(m.cur, who) < v)` → `'balance is ' + round6(balOf(m.cur, who)) + ' ' + m.cur + ', tried to stake ' + a.amt`
- **modStand**: stand-down (`a.on === false`): `if (m.cands[who] === undefined)` → `'you are not standing in this bet'` else null. Standing: `if (who === m.by)` → `'the author of a bet cannot also certify it'` · `if (m.byBettor[who] !== undefined)` → `'you hold a position on this bet, so you cannot certify it'` · `if (m.cands[who] !== undefined)` → `'you are already standing, and the bond is already posted'` · `if (balOf(m.cur, who) < m.bond)` → `'the bond is ' + fmtAmt(m.bond) + ' ' + m.cur + ' and you hold ' + fmtAmt(balOf(m.cur, who))`
- **modVote**: `var ballot = Array.isArray(a.for) ? a.for : []; if (ballot.length > m.seats)` → `'this jury has ' + m.seats + ' seat(s); a ballot names at most that many'` · per entry: self → `'nobody votes themselves onto a jury'`, dup (`ballot.indexOf(ballot[i]) !== i`) → `'that ballot names the same candidate twice'`, not standing (`m.cands[ballot[i]] === undefined`) → `'nobody by that name is standing in this bet'` · `if ((burnedSats[who] || 0) <= 0)` → `'a vote weighs the satoshis you proved you destroyed, and this handle has destroyed none'`
- **attest**: `if (mktSeats(m).seated.indexOf(who) < 0)` → `'only a seated moderator certifies a bet, and this handle holds no seat'` · `if (m.attests[who] !== undefined)` → `'you have already certified this bet — a certification is final, which is what makes the bond mean anything'` · `if (a.opt !== -1 && (!(a.opt >= 0) || a.opt >= m.n || Math.floor(a.opt) !== a.opt))` → `'there is no answer ' + a.opt + ' on this bet'`
- **marketVoid**: `return null;` (deadline is host-side only)
- fallthrough: `'unknown market act'`

### `peerBurnActError(a, epoch)` (376–590)

Reads only the act's fields, log-derived tables, and `epoch` (= certsSoFar at call). Checks IN ORDER; each returns a sentence:

1. `if (!a || !known(a.id)) return 'unknown actor';`
2. txid shape `/^0x[0-9a-fA-F]{64}$/` → `'a PEER burn is identified by its Base transaction hash, and this one is not a transaction hash'`. Then `var txk = a.txid.toLowerCase();` — ONE spelling for every table.
3. sink: `if (String(a.addr || '').toLowerCase() !== PEER_BURN_ADDR)` → `'a PEER burn must pay ' + PEER_BURN_ADDR + ' — the deployed token refuses address(0) on purpose, so the sink is a dead-but-nonzero address and nothing else counts'`
4. `var src = String(a.from == null ? '' : a.from).toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(src))` → `'a PEER burn must record the address the coins were sent from, and this one does not'`
5. ownership `var own = addrBinders[src];`
   - `if (!own || own.n === 0)` → `'no handle had bound ' + src + ' when those coins were destroyed, so this burn belongs to nobody — a burn is credited by a binding that was already in the log, never by one filed afterwards'`
   - `if (own.n > 1)` → `'more than one handle has bound ' + src + ', so whose burn this is cannot be decided from the log — an ambiguous address closes this door rather than guessing which handle to pay'`
   - `if (own.id !== a.id)` → `src + ' is bound to ' + own.id + ' and this act credits ' + a.id + ' — a burn is credited to whoever destroyed the coins, and the log says who that was'`
6. `if (!Number.isInteger(a.blockMs) || a.blockMs <= 0)` → `'a PEER burn must record the timestamp of the block that destroyed the coins, and this one does not'`
7. binding-predates-burn: `if (!(typeof own.ts === 'number' && own.ts <= a.blockMs)) return own.ts === null ? src + ' was bound by an act that carries no time, so nothing here can say the binding came before the burn' : src + ' was bound after those coins were destroyed, so the binding cannot reach them — bind the address first, then burn from it';`
8. `if (!Number.isInteger(a.pool) || a.pool < 0)` → `'a PEER burn must name the pool it was priced against'`
9. factory shape `/^0x[0-9a-fA-F]{40}$/` → `'a PEER burn must name the factory contract the pool lives in — a pool id with no factory behind it is not an identity, because two factories both have a pool ' + a.pool`
10. `var sats = peerBurnSats(a.amtRaw, a.resPeerRaw, a.resBtcRaw); if (sats === null)` → `'the recorded amount and pool reserves are not three positive whole numbers, so there is no price to check'`
11. `if (a.sats !== sats)` → `'this act records ' + a.sats + ' sat but its own reserves price the burn at ' + sats + ' sat — a host that disagrees with itself is not evidence of anything'`
12. `if (a.reserve !== sats / SATS_PER_RESERVE)` → `'this act records ' + a.reserve + ' reserve for ' + sats + ' sat, and the rate is ' + SATS_PER_RESERVE + ' sat per unit for BOTH doors'`
13. `if (!(BigInt(a.resBtcRaw) >= BigInt(PEER_BURN_MIN_POOL_SATS)))` → `'the pool held ' + a.resBtcRaw + ' sat of bitcoin and a burn needs at least ' + PEER_BURN_MIN_POOL_SATS + ' — below that a pool has no price, only a last trade'`
14. `if (!(Number(a.twapMs) >= PEER_BURN_TWAP_MS))` → `'the price was averaged over ' + a.twapMs + ' ms and at least ' + PEER_BURN_TWAP_MS + ' is required — a spot price is whatever the last trade left behind'`
15. `if (!(Number(a.obs) >= PEER_BURN_TWAP_OBS))` → `'the price came from ' + a.obs + ' observation(s) and at least ' + PEER_BURN_TWAP_OBS + ' are required'`
16. `if (!Number.isInteger(a.startsAt) || !Number.isInteger(a.endsAt) || a.startsAt < 0 || a.endsAt <= a.startsAt)` → `'a PEER burn must record the block range its price was averaged over, and this one does not'`
17. refHash shape `/^0x[0-9a-fA-F]{64}$/` → `'a PEER burn must record the hash of the block its window ends at — that hash is what decides which blocks were sampled, and without it the sampling is unauditable'`
18. `if (!Array.isArray(a.blocks) || a.blocks.length !== Number(a.obs))` → `'a PEER burn must list the blocks its price was read at, one per observation it claims'`
19. grid subset check:
```js
var grid = peerBurnGrid(a.startsAt, a.endsAt, a.refHash, PEER_BURN_GRID);
var gi = 0;
for (var bi = 0; bi < a.blocks.length; bi++) {
  var bb = a.blocks[bi];
  if (!Number.isInteger(bb)) return 'a PEER burn lists a sampled block that is not a whole number';
  while (gi < grid.length && grid[gi] < bb) gi++;
  if (gi >= grid.length || grid[gi] !== bb) {
    return 'block ' + bb + ' is not one the recorded window and block hash select, so these readings were not sampled by the rule this network uses';
  }
  gi++;
}
```
(i.e. `a.blocks` must be an ordered subsequence of the derived grid.)
20. `if (!Number.isInteger(a.creditsSats) || a.creditsSats <= 0 || a.creditsSats > sats)` → `'a PEER burn must state how many of its own satoshis this act converts to reserve, between 1 and ' + sats`
21. tx ceiling: `var doneSats = peerBurnTxSats[txk] || 0; if (doneSats > 0 && peerBurnTxBy[txk] !== a.id)` → `'that transaction has already been claimed, by ' + peerBurnTxBy[txk] + ' — a burn is claimed once, ever'` · `if (doneSats + a.creditsSats > sats)` → `'that transaction is worth ' + sats + ' sat and ' + doneSats + ' of it has already been credited, so this act cannot credit another ' + a.creditsSats + ' — a burn is claimed once, ever, up to its own value'`
22. per-account ceiling (`if (epoch >= PEER_BURN_CAP_FROM_EPOCH)` — always true at 0): `var used = peerBurnEpochUse[a.id + '@' + epoch] || 0; if (used + a.creditsSats > PEER_BURN_SATS_PER_EPOCH) { var leftR = (PEER_BURN_SATS_PER_EPOCH - used) / SATS_PER_RESERVE; return 'burning PEER creates at most ' + PEER_BURN_RESERVE_PER_EPOCH + ' reserve per account per epoch and this handle has ' + leftR + ' left — the burn stays valid and what is left of it is claimable after the next epoch closes'; }`
23. per-pool ceiling: `var pk = String(a.factory).toLowerCase() + '#' + a.pool + '@' + epoch; var poolUsed = peerBurnPoolUse[pk] || 0; var poolCap = Number(BigInt(a.resBtcRaw)); if (!Number.isSafeInteger(poolCap)) return 'the pool records more satoshis than will ever exist'; if (poolUsed + a.creditsSats > poolCap)` → `'pool ' + a.pool + ' at ' + String(a.factory).toLowerCase() + ' held ' + a.resBtcRaw + ' sat and has already created ' + (poolUsed / SATS_PER_RESERVE) + ' reserve this epoch — one pool cannot create more reserve in an epoch than it holds bitcoin, so the rest of this burn is claimable after the next epoch closes'`
24. `return null;`

Note step 11/12 use `!==` on JSON numbers — the act's `sats` must be exactly the recomputed integer, `reserve` exactly `sats/100` as an f64.

---

## Helpers (verbatim)

```js
function round6(x) { return Math.round(x * 1e6) / 1e6; }
function mktAmt(x) { return Math.floor(x * 1e6) / 1e6; }     // FLOOR, never round
function fmtAmt(x) { return (Math.round(x * 1e6) / 1e6).toString(); }  // JS Number.toString formatting!
function balOf(sym, id) { return (tokenBal[sym] && tokenBal[sym][id]) || 0; }
function poolId(x, y) { return x < y ? x + '/' + y : y + '/' + x; }   // JS string <
function countGoing(cid) { return Object.keys(eventGoing[cid] || {}).length; }
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
function weighHome(author, pd, pi) {
  var c = Math.sqrt(Math.abs(pd) * Math.abs(pi));
  if (c > 0) selfCells.push({ src: author, rcp: author, coeff: Math.min(1, c) });
}
function typeNode(name) {
  var id = 'type_' + name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!g.nodes.get(id)) g.addNode({ id: id, kind: 'Type', label: '#' + name });
  return id;
}
function tokCredit(sym, id, amt) {
  if (!(amt > 0)) return;
  var m = tokenBal[sym] || (tokenBal[sym] = bare());
  m[id] = (m[id] || 0) + amt;
}
function tokDebit(sym, id, amt) {
  if (!(amt > 0)) return;                    // refuses negative "debits" (mint vector)
  var m = tokenBal[sym] || (tokenBal[sym] = bare());
  m[id] = (m[id] || 0) - amt;
}
```

`fmtAmt` note for the port: the output is JS `Number.prototype.toString()` — shortest round-trip decimal (e.g. `0.1`, `2.5e-7` never occurs at these magnitudes, but `1e21`+ would go exponential). Rust must use a shortest-repr float formatter (Ryū, `format!("{}", x)` on f64 matches for these values) to keep chron bytes identical.

### `compileCells(bundles, selfCells)` (82–95)

```js
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
```
Clamp to [-1,1] per component; mixed/negative bundles collapse to a self-cell on the SOURCE.

### `parseMentions(text, handles)` (24–36)

```js
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
```
Max 3 distinct, first-come; slug collisions resolve to the LAST-registered handle (insertion order of `handles`). Regex is greedy up to 16 word-chars — note `@`+17 chars matches its first 16.

### `skel(hh)` (211–222)

```js
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
```
Confusable-fold + dedupe of consecutive repeats. Note `prev` only updates on KEPT chars, so `'ab-a'` → `'aba'` but `'a-a'` → `'a'` (the second `a` equals prev). Non-ASCII lowercasing must match JS `toLowerCase()` (Unicode).

### `dispName(id)` (223–229)

```js
if (deletedActors[id]) return '[deleted]';
var hh = handles[id] || id;
return handleTwin[id] ? hh + ' (' + id + ', not the original)' : hh;
```

### `bindableAddress(v)` (894–899)

```js
var s = String(v == null ? '' : v).trim().toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(s)) return '';
if (s === '0x0000000000000000000000000000000000000000') return '';
return s;
```

### `peerBurnSats(amtRaw, resPeerRaw, resBtcRaw)` (282–295)

```js
if (typeof amtRaw !== 'string' || typeof resPeerRaw !== 'string' || typeof resBtcRaw !== 'string') return null;
if (!RAW_INT.test(amtRaw) || !RAW_INT.test(resPeerRaw) || !RAW_INT.test(resBtcRaw)) return null;
var amt = BigInt(amtRaw), rp = BigInt(resPeerRaw), rb = BigInt(resBtcRaw);
if (amt <= BIG0 || rp <= BIG0 || rb <= BIG0) return null;
var n = Number((amt * rb) / (rp + amt));     // BigInt division = trunc/floor for positives
if (!Number.isSafeInteger(n)) return null;
return n;
```
Rust: `BigUint` arithmetic (inputs up to 48 digits), floor-divide, then check ≤ 2^53−1. `Number(bigint)` for a non-safe integer still converts (rounding) — the safe-int check happens on the converted value; for parity convert exactly when ≤ 2^53−1, else return null (any value > 2^53−1 fails `isSafeInteger` regardless of rounding direction — a rounded conversion can't fall back below 2^53, so a plain magnitude check on the BigUint is equivalent).

### `peerText(raw)` (297–303)

```js
var s = String(raw).replace(/[^0-9]/g, '') || '0';
while (s.length < 19) s = '0' + s;
var whole = s.slice(0, s.length - 18).replace(/^0+(?=\d)/, '');
var frac = s.slice(s.length - 18).replace(/0+$/, '').slice(0, 6);
return whole + (frac ? '.' + frac : '');
```
18-decimal fixed-point to text: pad to ≥19 digits, split, strip leading zeros of whole (keep one digit), strip trailing zeros of frac then truncate to 6.

### `peerBurnGrid(startsAt, endsAt, refHash, n)` (345–361)

```js
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
```
Hash-seeded bucket sampling; strictly-increasing filter can drop blocks (result length ≤ n). Four hex chars per bucket, wrapping at 16 buckets.

### `mktSeats(m)` (1128–1156)

```js
var w = bare(), id;
for (id in m.cands) w[id] = 0;
for (var v in m.votes) {
  var ballot = m.votes[v], wt = ballot.wt || 0;
  if (wt <= 0) continue;
  for (var k = 0; k < ballot.for.length; k++) {
    if (w[ballot.for[k]] !== undefined) w[ballot.for[k]] += wt;
  }
}
var order = Object.keys(m.cands).sort(function (x, y) {
  if (w[y] !== w[x]) return w[y] - w[x];        // weight desc
  if (m.cands[y] !== m.cands[x]) return m.cands[y] - m.cands[x];  // bond desc
  return x < y ? -1 : 1;                        // id asc
});
return { order: order, weight: w, seated: order.slice(0, m.seats) };
```
Float accumulation order = votes insertion order (first-cast position survives re-votes). A candidate who stood down is absent from `cands` — stale ballot names are skipped by the `!== undefined` guard.

### `mktVerdict(m)` (1395–1404)

```js
var seated = mktSeats(m).seated, tally = {}, need = Math.floor(seated.length / 2) + 1;
for (var i = 0; i < seated.length; i++) {
  var said = m.attests[seated[i]];
  if (said === undefined) continue;
  tally[said] = (tally[said] || 0) + 1;
  if (tally[said] >= need) return said;
}
return null;
```
Note `tally` keys are the attested option numbers (including `-1`); returns the option (possibly -1) or null.

### `mktSettle(m, outcome, byDeadline)` (1291–1392) — full algorithm

```js
var seated = mktSeats(m).seated, i;
var honest = [], guilty = [];
for (i = 0; i < seated.length; i++) {
  var said = m.attests[seated[i]];
  if (said === undefined) { if (byDeadline) guilty.push(seated[i]); continue; }
  if (byDeadline) continue;                  // certified; the jury just never agreed
  if (said === outcome) honest.push(seated[i]); else guilty.push(seated[i]);
}
// Bonds: everyone standing except the struck (sorted candidate order)
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
  fee = Math.floor(m.pool * m.feeBp / 10000 * 1e6) / 1e6;      // five-op chain
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
  // void, or winning answer had no backers: refund all stakes (per option, sorted backers)
  for (i = 0; i < m.n; i++) {
    var back = Object.keys(m.stakes[i]).sort();
    for (j = 0; j < back.length; j++) {
      tokCredit(m.cur, back[j], m.stakes[i][back[j]]);
      m.refunded[back[j]] = round6((m.refunded[back[j]] || 0) + m.stakes[i][back[j]]);
    }
  }
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
    // no stakes at all: struck bonds go BACK (iterates seated order)
    for (i = 0; i < seated.length; i++) {
      if (m.struck[seated[i]] === undefined) continue;
      tokCredit(m.cur, seated[i], m.struck[seated[i]]);
      delete m.struck[seated[i]];
    }
    slashed = 0;
    guilty = [];
  }
}
// Fee split: half to moderators who called it right, half + dust to author
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
```
Semantics: `byDeadline` falsy (attest path) → dissenters are struck, silent seats keep bonds; `byDeadline` true (marketVoid path) → silent seats struck, certifiers keep bonds. All Object.keys iterations here are `.sort()`ed (lexicographic) — deterministic regardless of insertion, but the round6 running sums follow sorted order.

### `deferEpoch` / `bare` / `addActor`

See replay-state.md §3, §2. `addActor` (197–203) verbatim:
```js
function addActor(id, handle, burn, count, epoch, label) {
  var lab = label || handle;
  g.addNode({ id: id, kind: 'Actor', label: lab });
  g.addNode({ id: 'prof_' + id, kind: 'Profile', label: lab });
  var l = { id: id, burnBal: burn, actCount: count };
  ledgers.push(l); ledgerById[id] = l; handles[id] = handle; kReg[id] = epoch;
}
```

---

## Math.* call-site index

| call | sites |
|---|---|
| `Math.floor` | mktAmt; advert days (checker + apply); event `cap`; feeBp (`Math.floor(a.feeBp)`); bet/attest opt integer checks (`Math.floor(a.opt) !== a.opt`); mktVerdict `need`; mktSettle fee/got/share/modPot-each chains; token distribution `Math.floor(tokPool * tw[tk] / twTotal * 1e6) / 1e6`; emission decay exponent `Math.floor((tokEpochN - 1) / TOK_YEAR)`; peerBurnGrid `lo`/`hi`; call chron minutes `Math.floor((a.dur || 0) / 60)` |
| `Math.round` | round6, fmtAmt |
| `Math.sqrt` | compileCells (both arms), weighHome, poolCreate `s0`, poolCreate min-liq check (`Math.sqrt(a.amtA * a.amtB)`) |
| `Math.min` | compileCells clamp, weighHome coeff clamp `Math.min(1, c)`, poolAdd ratio `Math.min(a.amtA / pl.resA, a.amtB / pl.resB)` (checker + apply), emission `Math.min(TOK_EPOCH * Math.pow(...), TOK_CAP - tokenSupply.PEER)` |
| `Math.max` | compileCells clamp `Math.max(-1, Math.min(1, …))`, `tokenCarry = Math.max(0, round6(tokPool - credited))` |
| `Math.pow` | emission `Math.pow(TOK_DECAY, Math.floor((tokEpochN - 1) / TOK_YEAR))` |
| `Math.abs` | compileCells else-arm, weighHome |
| `.toFixed` | chron only: btcBurn/peerBurn `gained.toFixed(4)`, post `a.a.toFixed(2)`, opinion `p/r.toFixed(2)`, `rec.tau.toFixed(2)`, `rec.weight.toFixed(3)`, deferEpoch line `epochStamp.toFixed(3)` |

## Object-key-iteration order — the definitive list of result-affecting sites

1. `parseMentions` slug map build over `handles` (mention resolution on legacy posts).
2. `compileCells` `for (k in bundles)` — cell order into every epoch certificate solve and the final solve.
3. `deferEpoch` `Object.keys(deltaActs)` — Map insertion order into `evaluateGates`.
4. closeEpoch `for (ak in addrOf)` — snapshot copy order (output bytes).
5. closeEpoch `for (tk in tw)` — distribution order: per-creator floor amounts are order-independent, but `credited` (round6 running sum) and therefore `tokenCarry`, `tokenSupply.PEER` and the chron line depend on it; `distTo` output order too.
6. `mktSeats` `for (v in m.votes)` — weight float-accumulation order; `for (id in m.cands)` — `weight` map output order.
7. Final self-edge loop `for (id2 in ledgerById)` — graph edge append order.
8. Final `for (hk in handles)` (dispHandles), `for (pbk in peerBurnEpochUse)` (usedThisEpoch) — output order.
9. resetTokens `for (rsym in tokenBal)` — symbol order of the rebuilt empty maps (output order).
10. `mktSettle`/`mktVerdict` iterations are sorted or Vec-ordered — insertion-independent, but keep the lexicographic `.sort()` (JS default string sort = UTF-16 code-unit order).
