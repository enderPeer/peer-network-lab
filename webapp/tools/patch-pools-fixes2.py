# -*- coding: utf-8 -*-
# Second review pass over the on-chain named-pools card in template.html.
# Four confirmed findings, two of which are ways the card could tell somebody
# a false sentence about their own money.
#
#   1. THE LIST AND THE CARD ARE NOT THE SAME THING. Any error under
#      namedPools collapsed the entire card and returned — which took the
#      "open a pool" form, the wallet row and everything else down with a
#      failure none of them depend on. The log scan is the fragile part (most
#      public RPCs refuse a wide getLogs), so the moment it fails a user could
#      not even create the first pool. Now a SCAN failure degrades: the
#      endpoint's own sentence is shown where the list would be, and
#      everything that talks to Base directly keeps working. A factory that
#      did not answer poolCount() at all still collapses, because then there
#      is no factory to open a pool in — and that is a different sentence.
#
#   2. "NOTHING ELSE WAS SIGNED" WAS SAID OVER TWO CASES WHERE MONEY MOVED.
#      The ledger recorded only CONFIRMED legs, so a leg that was broadcast
#      and never observed (the receipt poll gave up) and a leg that reverted
#      after the gas was paid both reported that nothing happened. Each leg
#      now carries its own state — attempted / rejected / sent / reverted /
#      confirmed — and the failure sentence names which one it stopped in. A
#      hash that went out and was not confirmed is printed, because looking it
#      up is the only thing that settles an unknown, and because a user told
#      "nothing happened" will press again and pay twice.
#
#   3. A CACHE THAT OUTLIVED WHAT IT WAS TRUE OF. ocGetTokens remembered the
#      factory's peer()/btc() without remembering WHICH factory answered, so a
#      tab left open across a PEER_POOLS_ADDR change would approve the old
#      factory's tokens to the new one. Keyed on the factory address now — and
#      so is MIN_LIQ, which had the identical hole one function down.
#
#   4. TWO KNOWABLE REFUSALS THAT WERE NOT FREE. Swap and Add liquidity signed
#      an approval before asking whether the wallet holds the coins at all.
#      balanceOf is a free eth_call; an approval is gas plus a standing
#      permission. Both now ask first, and so does createPool, which had the
#      same gap behind its two other pre-checks.
#
#   5. A PROMISE WITH NO DOOR, AND A WARNING THAT OVERSTATED ITS OWN REACH.
#      The reader's truncation note ends "still perfectly usable by anyone who
#      has its id" and the card offered no way to use an id. It does now: a
#      free poolInfo(uint256) read through the wallet's own connection, drawn
#      as the same row with the same buttons. And the shared-name warning
#      compares only the pools on the page, which it now says out loud instead
#      of letting an unmarked name read as a unique one.
#
# Discipline (see the 0-byte truncation incident): every anchor must match
# EXACTLY once, all patches are applied to the in-memory string, and the
# encode happens on its own line BEFORE any file is opened for writing.
import io

TP = r'C:/Users/User/Desktop/ToRuleThemAll/webapp/social/template.html'
s = io.open(TP, 'r', encoding='utf-8').read()
orig_len = len(s)
applied = []


def once(old, new, label):
    global s
    n = s.count(old)
    assert n == 1, 'anchor for %s matches %d times, need exactly 1' % (label, n)
    s = s.replace(old, new)
    applied.append(label)


# ── 1. two more read selectors: an id lookup and a balance ──────────────────
once(
    r'''        sharesOf: '0xe78307ca',        // sharesOf(uint256,address)
        taken: '0xd174c832',           // taken(address,bytes32)''',
    r'''        sharesOf: '0xe78307ca',        // sharesOf(uint256,address)
        // The two READ selectors this card grew. poolInfo is how a pool the
        // host's scan never reached can still be opened here by its id — the
        // reader's own note promises exactly that, and a promise with no door
        // is worse than no promise. balanceOf is how a wallet that cannot
        // cover a trade finds out before it signs an approval for one. Both
        // are copied from the table in chain-l2/onchain.mjs, which took them
        // from the compiler's own methodIdentifiers rather than from memory.
        poolInfo: '0x1526fe27',        // poolInfo(uint256)
        balanceOf: '0x70a08231',       // balanceOf(address)
        taken: '0xd174c832',           // taken(address,bytes32)''',
    'selectors: poolInfo + balanceOf')

# ── 2. a bytes32 name, decoded the way the reader decodes it ────────────────
once(
    r'''      function ocShort(a) {
        var t = String(a == null ? '' : a);
        return /^0x[0-9a-fA-F]{40}$/.test(t) ? t.slice(0, 6) + '\u2026' + t.slice(-4) : '';
      }
''',
    r'''      function ocShort(a) {
        var t = String(a == null ? '' : a);
        return /^0x[0-9a-fA-F]{40}$/.test(t) ? t.slice(0, 6) + '\u2026' + t.slice(-4) : '';
      }

      // A bytes32 name as text: UTF-8 bytes up to the first NUL. This is
      // chain-l2/onchain.mjs's bytes32Name transcribed rather than
      // reinvented, so a pool read here by id renders under exactly the same
      // name the list gives it — two spellings of one pool would be a worse
      // bug than no lookup at all. Nothing is stripped, for the same reason:
      // the name on screen is the name on chain. It reaches the page only
      // through textContent, so bytes chosen by a stranger stay text.
      function ocName(hexWord) {
        var bytes = [];
        for (var i = 0; i + 2 <= hexWord.length && i < 64; i += 2) {
          var b = parseInt(hexWord.slice(i, i + 2), 16);
          if (!b) break;
          bytes.push(b);
        }
        return new TextDecoder().decode(new Uint8Array(bytes));
      }
''',
    'ocName — bytes32 to text, mirroring the reader')

# ── 3. the ledger records every leg's STATE, not only its successes ─────────
once(
    r'''      // Where a half-finished sequence actually left somebody. Approving a
      // token and then refusing the next signature does not undo the
      // approval: it landed, it cost gas, and it still stands. A catch that
      // says "did not go through" about the whole press tells a user their
      // coins are un-approved when they are not — which is how the same
      // approval gets signed, and paid for, twice. Each leg that lands is
      // recorded as a clause the failure reads back.
      function ocLedger() {
        var landed = [];
        return {
          landed: function (clause) { if (clause) landed.push(clause); },
          sentence: function (headline, e) {
            var head = headline + ': ' + ocErr(e);
            if (!landed.length) return head + ' Nothing else was signed, so nothing else of yours moved.';
            return head + ' What DID land and still stands: ' + landed.join('; ') + '. Pressing again reuses it \u2014 your wallet will not ask for that approval a second time.';
          }
        };
      }
''',
    r'''      // Where a half-finished sequence actually left somebody, and in WHICH
      // of five states each leg of it stopped. Approving a token and then
      // refusing the next signature does not undo the approval: it landed, it
      // cost gas, and it still stands.
      //
      // The first version of this ledger recorded only the legs that
      // CONFIRMED, and that left the two failures where money actually moved
      // both saying "nothing else was signed":
      //
      //   · a leg that was broadcast and whose receipt was never observed —
      //     the poll gave up after four minutes, and the transaction may be
      //     in the mempool right now;
      //   · a leg that reverted on chain, which costs the gas whatever it
      //     does with the coins.
      //
      // Telling somebody nothing happened while their transaction is pending
      // is how the same trade gets signed, and paid for, twice. So every leg
      // is opened before the wallet is asked and carries its own state:
      //
      //   attempted — opened; nothing broadcast yet
      //   rejected  — no hash ever came back, so nothing went out
      //   sent      — broadcast, no receipt seen: UNKNOWN, which is not failed
      //   reverted  — mined and refused: coins stayed, gas did not
      //   confirmed — mined and accepted
      //
      // An unknown is never collapsed into "nothing happened", and a leg in
      // `sent` keeps its hash on screen, because looking that hash up is the
      // only thing that can settle it.
      function ocLedger() {
        var legs = [];
        function inState(st) { return legs.filter(function (l) { return l.state === st; }); }
        function clauses(st) {
          return inState(st).map(function (l) { return l.what + (l.tx ? ' \u2014 ' + l.tx : ''); }).join('; ');
        }
        return {
          open: function (what) {
            var leg = { what: what || 'that step', state: 'attempted', tx: null };
            legs.push(leg);
            return leg;
          },
          sentence: function (headline, e) {
            var parts = [headline + ': ' + ocErr(e)];
            // Worst-known first: an unknown outranks a plain failure, because
            // it is the one the reader has to act on.
            if (inState('sent').length) parts.push('SENT AND NOT CONFIRMED, so this may still land and must not be treated as undone: ' + clauses('sent') + '. Look that hash up on basescan.org before pressing anything again \u2014 pressing again can pay for the same thing twice.');
            if (inState('reverted').length) parts.push('Refused by the chain, which costs the gas and moves no coins: ' + clauses('reverted') + '.');
            if (inState('confirmed').length) parts.push('Landed and still stands: ' + clauses('confirmed') + '. An approval that stands is not asked for twice \u2014 your wallet reuses it.');
            if (parts.length === 1) parts.push('Nothing was broadcast, so nothing of yours moved and no gas was spent.');
            return parts.join(' ');
          }
        };
      }
''',
    'ocLedger records attempted / rejected / sent / reverted / confirmed')

# ── 4. every send is a leg, and its state is written as the chain answers ───
once(
    r'''      async function ocSend(to, data, label) {
        var chain = await ocEth('eth_chainId');
        if (chain !== OC_CHAIN) {
          l2Wallet = null;
          l2Tokens = null;
          if (l2Redraw) l2Redraw();
          throw new Error('the wallet is on chain ' + chain + ', not Base (' + OC_CHAIN + ') \u2014 nothing was signed. Put it back on Base and connect again.');
        }
        toast(label + ' \u2014 approve it in the wallet.');
        var tx = await ocEth('eth_sendTransaction', [{ from: l2Wallet, to: to, data: data, chainId: OC_CHAIN }]);
        var rc = null;
        for (var i = 0; i < 120 && !rc; i++) {
          await new Promise(function (res) { setTimeout(res, 2000); });
          rc = await ocEth('eth_getTransactionReceipt', [tx]);
        }
        if (!rc) throw new Error('not mined after four minutes \u2014 check ' + tx + ' on basescan.org, it may yet land');
        if (rc.status !== '0x1') throw new Error('reverted on chain \u2014 nothing moved, gas was paid (' + tx + ')');
        return rc;
      }''',
    r'''      // `led` and `what` are how this send reaches the sentence a failure
      // further down the sequence prints. The leg is opened BEFORE the wallet
      // is asked, so a press that dies at any point still has a record of
      // where it died — a leg written only on success is exactly the ledger
      // that reported "nothing was signed" over a pending transaction.
      async function ocSend(to, data, label, led, what) {
        var leg = (led || ocLedger()).open(what || label);
        var chain = await ocEth('eth_chainId');
        if (chain !== OC_CHAIN) {
          l2Wallet = null;
          l2Tokens = null;
          if (l2Redraw) l2Redraw();
          leg.state = 'rejected';
          throw new Error('the wallet is on chain ' + chain + ', not Base (' + OC_CHAIN + ') \u2014 nothing was signed. Put it back on Base and connect again.');
        }
        toast(label + ' \u2014 approve it in the wallet.');
        var tx;
        try {
          tx = await ocEth('eth_sendTransaction', [{ from: l2Wallet, to: to, data: data, chainId: OC_CHAIN }]);
        } catch (e) {
          // No hash came back, so nothing left the wallet. This is the one
          // branch where "nothing happened" is a true sentence.
          leg.state = 'rejected';
          throw e;
        }
        leg.tx = tx;
        // Broadcast. From here on the honest state is `sent` — not failed,
        // not done — and it stays that way until a receipt says otherwise.
        leg.state = 'sent';
        var rc = null;
        for (var i = 0; i < 120 && !rc; i++) {
          await new Promise(function (res) { setTimeout(res, 2000); });
          // A provider that throws mid-poll throws out of here with the leg
          // still in `sent`, which is the truth: the transaction went out and
          // this page stopped being able to watch it.
          rc = await ocEth('eth_getTransactionReceipt', [tx]);
        }
        // Both messages below leave the hash to the ledger, which prints it
        // once, beside the state that makes it worth looking up.
        if (!rc) throw new Error('not mined after four minutes \u2014 it may still be waiting in the mempool');
        if (rc.status !== '0x1') { leg.state = 'reverted'; throw new Error('reverted on chain \u2014 the coins stayed where they were, the gas did not'); }
        leg.state = 'confirmed';
        return rc;
      }''',
    'ocSend opens a leg and writes its state through send / mine / revert')

# ── 5. the allowance leg goes through the ledger, and a free balance check ──
once(
    r'''      async function ocAllow(token, spender, need, symbol, dec) {
        var have = ocUint(await ocEth('eth_call', [{ to: token, data: OC_SEL.allowance + ocAddr(l2Wallet) + ocAddr(spender) }, 'latest']), 'the ' + symbol + ' allowance');
        if (have >= need) return null;
        await ocSend(token, OC_SEL.approve + ocAddr(spender) + ocWord(need), 'Approving ' + symbol);
        return 'your approval of ' + ocFmt(need, dec) + ' ' + symbol + ' to the pools contract';
      }''',
    r'''      async function ocAllow(token, spender, need, symbol, dec, led) {
        var have = ocUint(await ocEth('eth_call', [{ to: token, data: OC_SEL.allowance + ocAddr(l2Wallet) + ocAddr(spender) }, 'latest']), 'the ' + symbol + ' allowance');
        if (have >= need) return;
        // The clause travels with the send now rather than being handed back
        // afterwards, so an approval that is broadcast and never confirmed is
        // recorded too \u2014 the old shape could only report the ones that
        // finished, which is precisely the case that did not need reporting.
        await ocSend(token, OC_SEL.approve + ocAddr(spender) + ocWord(need), 'Approving ' + symbol, led,
          'your approval of ' + ocFmt(need, dec) + ' ' + symbol + ' to the pools contract');
      }

      // Can this wallet even pay? A free eth_call, asked before the first
      // signature on every path that pulls a token. An approval signed by a
      // wallet that cannot cover the trade costs real gas and buys nothing:
      // the pull reverts a moment later, and a standing permission over coins
      // the user does not have is left behind. createPool already spends two
      // free reads to make its knowable refusals free; this is the third, and
      // it belongs to swapping and depositing just as much.
      //
      // It is a snapshot and not a guarantee \u2014 a balance can move between
      // this read and the pull, and the contract stays the authority on that.
      // All it can do is turn a failure somebody paid for into one they did
      // not.
      async function ocHave(token, need, symbol, dec) {
        var have = ocUint(await ocEth('eth_call', [{ to: token, data: OC_SEL.balanceOf + ocAddr(l2Wallet) }, 'latest']), 'your ' + symbol + ' balance');
        if (have >= need) return;
        throw new Error('that wallet holds ' + ocFmt(have, dec) + ' ' + symbol + ' and this needs ' + ocFmt(need, dec) + ' \u2014 nothing was signed');
      }''',
    'ocAllow reports through the ledger + ocHave balance pre-check')

# ── 6. both caches remember WHICH factory answered them ─────────────────────
once(
    r'''      async function ocGetTokens(factory) {
        if (l2Tokens) return l2Tokens;
        var pw = await ocEth('eth_call', [{ to: factory, data: OC_SEL.peer }, 'latest']);
        var bw = await ocEth('eth_call', [{ to: factory, data: OC_SEL.btc }, 'latest']);
        var pa = ocUint(pw, 'the factory\u2019s peer() address'), ba = ocUint(bw, 'the factory\u2019s btc() address');
        if (pa === 0n || ba === 0n || pa >> 160n !== 0n || ba >> 160n !== 0n) throw new Error('that factory did not answer with two token addresses \u2014 nothing was signed');
        l2Tokens = { peer: '0x' + pa.toString(16).padStart(40, '0'), btc: '0x' + ba.toString(16).padStart(40, '0') };
        return l2Tokens;
      }''',
    r'''      // The cache is keyed on the factory that answered it. It used to be
      // keyed on nothing, which made it true of "some factory, once": a tab
      // left open while the operator repointed PEER_POOLS_ADDR would go on
      // approving the OLD factory's tokens \u2014 to the NEW factory's address,
      // over coins the new one never pulls, one signature and one standing
      // permission spent on nothing. The address is normalised because a
      // checksummed and a lowercase spelling of one address must not read as
      // two.
      async function ocGetTokens(factory) {
        var key = String(factory || '').toLowerCase();
        if (l2Tokens && l2Tokens.factory === key) return l2Tokens;
        var pw = await ocEth('eth_call', [{ to: factory, data: OC_SEL.peer }, 'latest']);
        var bw = await ocEth('eth_call', [{ to: factory, data: OC_SEL.btc }, 'latest']);
        var pa = ocUint(pw, 'the factory\u2019s peer() address'), ba = ocUint(bw, 'the factory\u2019s btc() address');
        if (pa === 0n || ba === 0n || pa >> 160n !== 0n || ba >> 160n !== 0n) throw new Error('that factory did not answer with two token addresses \u2014 nothing was signed');
        l2Tokens = { factory: key, peer: '0x' + pa.toString(16).padStart(40, '0'), btc: '0x' + ba.toString(16).padStart(40, '0') };
        return l2Tokens;
      }''',
    'ocGetTokens keys its cache on the factory address')

once(
    r'''      var ocMin = null;
      async function ocMinLiq(factory) {
        if (ocMin === null) ocMin = ocUint(await ocEth('eth_call', [{ to: factory, data: OC_SEL.minLiq }, 'latest']), 'the factory\u2019s MIN_LIQ');
        return ocMin;
      }''',
    r'''      // Keyed on the factory for the same reason ocGetTokens is: MIN_LIQ is
      // a number one deployment answers with, and pre-checking a deposit
      // against a different contract's floor is a pre-check that agrees with
      // nothing. Two factories can legitimately lock different amounts.
      var ocMin = null;
      async function ocMinLiq(factory) {
        var key = String(factory || '').toLowerCase();
        if (!ocMin || ocMin.factory !== key) {
          ocMin = { factory: key, value: ocUint(await ocEth('eth_call', [{ to: factory, data: OC_SEL.minLiq }, 'latest']), 'the factory\u2019s MIN_LIQ') };
        }
        return ocMin.value;
      }''',
    'ocMinLiq keys its cache on the factory address')

# ── 7. a scan that failed is not a card that failed ─────────────────────────
once(
    r'''        var np = d.namedPools;
        if (np.error) {
          // The factory address is set but did not answer like a factory.
          // That is the endpoint's own sentence too, and "unreadable" must
          // not be dressed up as "empty" — an empty factory invites a
          // deposit; an unreadable one is a misconfiguration to fix first.
          ocBody.appendChild(h('p', { class: 'smallnote', text: np.error }));
          return;
        }
        var factory = np.factory;''',
    r'''        var np = d.namedPools;
        // One field, np.error, carries two failures that deserve opposite
        // treatment, and telling them apart is the difference between a card
        // that degrades and a card that disappears:
        //
        //   · the address answered poolCount() but the POOL SCAN failed. The
        //     scan is the fragile part — most public RPCs refuse a getLogs
        //     range this wide — and NOTHING else on this card is derived from
        //     it. Collapsing the whole card here meant that the moment the
        //     scan broke, a user could not open a pool either, on a form that
        //     never touched the scan. So it degrades: the endpoint's own
        //     sentence goes where the list would be, and everything that
        //     speaks to Base directly keeps working.
        //
        //   · nothing at that address answered poolCount() at all. Then there
        //     is no factory: no decimals to scale an amount by, and nothing
        //     for a create to create in. That one still collapses, and says
        //     which of the two it is.
        //
        // The test is whether the factory answered anything before the scan.
        // A host that later reports its scan under new names still trips it,
        // because tokens/total/decimals are read off the factory itself.
        var answered = np.total != null || np.tokens != null || np.pools != null ||
          np.peerDecimals != null || np.btcDecimals != null || np.scan != null;
        if (np.error && !answered) {
          // The factory address is set but did not answer like a factory.
          // That is the endpoint's own sentence too, and "unreadable" must
          // not be dressed up as "empty" — an empty factory invites a
          // deposit; an unreadable one is a misconfiguration to fix first.
          ocBody.appendChild(h('p', { class: 'smallnote', text: np.error }));
          return;
        }
        // Held, not returned on. drawPools prints it in place of the list.
        var scanError = np.error || null;
        var factory = np.factory;''',
    'ocRender separates a scan failure from a factory that never answered')

# ── 8. the reader's own account of its reading, whatever it grows ───────────
once(
    r'''        var listBox = h('div', {});
        ocBody.appendChild(listBox);
        function drawPools() {''',
    r'''        var listBox = h('div', {});
        ocBody.appendChild(listBox);

        // Everything the reader says about its own reading gets said again
        // here, in its words rather than this page's summary of them. The
        // reader knows things about its scan that this card cannot: how many
        // windows it walked, how many an endpoint refused, how far behind the
        // backfill still is, how many pools it saw but had no reads left for.
        //
        // OC_SAID is the set of keys this card already has a sentence for.
        // Anything else the reader reports is a host NEWER than this page —
        // and it is printed under the reader's own key name rather than
        // dropped, because the alternative is a page that silently hides the
        // one counter that would have explained a short list. Objects are
        // skipped; only scalars are safe to render as a name and a value.
        var OC_SAID = {
          factory: 1, error: 1, tokens: 1, tokensNote: 1, mismatch: 1, peerDecimals: 1,
          btcDecimals: 1, fromBlock: 1, fromBlockIgnored: 1, discoveredBy: 1, rankedBy: 1,
          pools: 1, discovered: 1, returned: 1, total: 1, skipped: 1, unread: 1,
          truncated: 1, note: 1, scan: 1, count: 1
        };
        function ocExtras(o, known) {
          var bits = [];
          Object.keys(o || {}).forEach(function (k) {
            if (known && known[k]) return;
            var v = o[k], t = typeof v;
            if (t === 'string') { if (v) bits.push(k + ' \u2014 ' + v.slice(0, 240)); }
            else if (t === 'number' || t === 'boolean') bits.push(k + ': ' + v);
          });
          return bits;
        }
        // `shown` is how many rows this card is about to draw, or null when
        // it is drawing none because the scan failed. The counted sentence is
        // only a fallback: where the reader wrote its own note, that is what
        // appears, because it is the one that knows why.
        function drawScanState(box, shown) {
          var total = np.total == null ? (np.count == null ? null : Number(np.count)) : Number(np.total);
          var seen = np.returned == null ? shown : Number(np.returned);
          var skipped = Array.isArray(np.skipped) ? np.skipped.length : Number(np.skipped || 0);
          var unread = Number(np.unread || 0);
          if (np.note) {
            box.appendChild(h('p', { class: 'smallnote', text: np.note }));
          } else if (seen != null && (np.truncated || (total != null && total > seen))) {
            box.appendChild(h('p', { class: 'smallnote', text: 'Showing ' + seen + ' of ' + total + ' pools on this factory \u2014 the rest exist on chain and are simply not in this list. Any of them can still be reached below by its id.' + (skipped ? ' ' + skipped + ' would not decode.' : '') + (unread ? ' ' + unread + ' were seen but not read this round.' : '') }));
          } else if (seen != null && skipped > 0) {
            box.appendChild(h('p', { class: 'smallnote', text: skipped + ' pool' + (skipped === 1 ? '' : 's') + ' on this factory would not decode and ' + (skipped === 1 ? 'was' : 'were') + ' skipped \u2014 what is here is the rest, not all of it.' }));
          }
          var said = [];
          if (np.scan && typeof np.scan === 'object') said = said.concat(ocExtras(np.scan, null));
          said = said.concat(ocExtras(np, OC_SAID));
          if (said.length) box.appendChild(h('p', { class: 'smallnote', text: 'This host also reported, in its own names: ' + said.slice(0, 16).join(' \u00b7 ') + '.' }));
        }

        // How many pools ON THIS PAGE carry one pool's name — the honest
        // scope of the shared-name warning, and the number the row prints.
        // It counts the list this card was given and nothing else; a factory
        // the scan only half reached can hold a third pool of the same name
        // that nobody here can see.
        function ocSharing(p) {
          var k = String(p.nameRaw || p.name || ''), n = 0, listed = false;
          (np.pools || []).forEach(function (q) {
            if (String(q.nameRaw || q.name || '') === k) n++;
            if (String(q.id) === String(p.id)) listed = true;
          });
          return listed ? n : n + 1;
        }

        function drawPools() {''',
    'drawScanState / ocExtras / ocSharing')

once(
    r'''        function drawPools() {
          listBox.innerHTML = '';
          var list = (np.pools || []).slice();
          if (!list.length) {
            listBox.appendChild(h('p', { class: 'smallnote', text: 'The factory is live and empty. The first pool is opened below \u2014 its starting ratio IS its starting price.' }));
            return;
          }''',
    r'''        function drawPools() {
          listBox.innerHTML = '';
          // The scan failed, the card did not. Its sentence goes where the
          // list would be, and everything below it \u2014 the wallet row, the id
          // lookup, opening a pool \u2014 goes on working, because none of them
          // read a log.
          if (scanError) {
            listBox.appendChild(h('p', { class: 'smallnote', style: 'border-left:2px solid var(--ember); padding-left:9px', text: 'The pool list could not be read: ' + scanError }));
            listBox.appendChild(h('p', { class: 'smallnote', text: 'That is this host\u2019s scan of the pool log, and only that. The wallet row, opening a pool and looking a pool up by its id all ask Base directly, so they are unaffected \u2014 what is missing here is the list, not the pools.' }));
          }
          var list = (np.pools || []).slice();
          if (!list.length) {
            // "Empty" and "could not be read" are the two sentences this card
            // must never blur: an empty factory invites the first deposit, an
            // unreadable one is a host to fix first. So the invitation is
            // printed only when the scan actually came back empty.
            if (!scanError) listBox.appendChild(h('p', { class: 'smallnote', text: 'The factory is live and empty. The first pool is opened below \u2014 its starting ratio IS its starting price.' }));
            drawScanState(listBox, scanError ? null : 0);
            return;
          }''',
    'drawPools degrades to the scan sentence and keeps the rest of the card')

once(
    r'''          listBox.appendChild(h('p', { class: 'smallnote', text: 'Deepest BTC reserve first. A pool\u2019s name was chosen by whoever opened it and is claimed per creator \u2014 two different people can each have one called \u201cmain\u201d, and both are legitimate. A name carries no trust and no endorsement here: read the creator and the reserves, and note that the id beside it is what every button below actually sends.' }));

          // What this list is NOT. The reader stops fetching past its own cap
          // and reports the cap it hit; a partial list drawn as though it
          // were the whole factory is exactly the omission that sends a
          // deposit into the wrong pool.
          var total = np.total == null ? np.count : np.total;
          var shown = np.returned == null ? list.length : Number(np.returned);
          var skipped = Array.isArray(np.skipped) ? np.skipped.length : Number(np.skipped || 0);
          if (np.truncated || (total != null && Number(total) > shown)) {
            // Where the reader wrote its own account of what is missing and
            // why \u2014 seen but not read this round, unreadable, or never seen
            // at all \u2014 it is shown verbatim, because it knows things about
            // its own scan that this page does not. The counted sentence is
            // the fallback for a host older than this card.
            listBox.appendChild(h('p', { class: 'smallnote', text: np.note ? np.note : ('Showing ' + shown + ' of ' + total + ' pools on this factory \u2014 this host stops reading at its own cap, so the rest exist on chain and are simply not here.' + (skipped > 0 ? ' Another ' + skipped + ' would not decode and were skipped.' : '')) }));
          } else if (skipped > 0) {
            listBox.appendChild(h('p', { class: 'smallnote', text: skipped + ' pool' + (skipped === 1 ? '' : 's') + ' on this factory would not decode and ' + (skipped === 1 ? 'was' : 'were') + ' skipped \u2014 what follows is the rest, not all of it.' }));
          }

          list.forEach''',
    r'''          listBox.appendChild(h('p', { class: 'smallnote', text: 'Deepest BTC reserve first. A pool\u2019s name was chosen by whoever opened it and is claimed per creator \u2014 two different people can each have one called \u201cmain\u201d, and both are legitimate. A name carries no trust and no endorsement here: read the creator and the reserves, and note that the id beside it is what every button below actually sends. Where two pools ON THIS PAGE carry one name the row says so \u2014 but this page is all it can compare, so an unmarked name is not a proven unique one.' }));

          // What this list is NOT, in the reader's own account of its scan:
          // the windows it walked, the ones an endpoint refused, the pools it
          // saw and had no reads left for. A partial list drawn as though it
          // were the whole factory is exactly the omission that sends a
          // deposit into the wrong pool.
          drawScanState(listBox, list.length);

          list.forEach''',
    'the list header owns its scope, and the scan account is one function')

# ── 9. the row: provenance, honest clash wording, id-found marking ──────────
once(
    r'''        function poolRow(p, sharing) {''',
    r'''        // `foundById` marks a row that was read from the chain a second ago
        // by id rather than served by this host's scan \u2014 different
        // provenance, so it says so rather than sitting in the list's voice.
        function poolRow(p, sharing, foundById) {''',
    'poolRow takes foundById')

once(
    r'''          var who = ocShort(p.creator);
          var prov = who ? 'opened by ' + who : 'opened by an address this host did not report';
          if (sharing > 1) prov += ' \u00b7 ' + sharing + ' pools in this list share the name \u201c' + (p.name || '') + '\u201d \u2014 different pools with different creators, one word between them';
          box.appendChild(h('p', { class: 'smallnote', text: prov }));''',
    r'''          var who = ocShort(p.creator);
          var prov = who ? 'opened by ' + who : 'opened by an address this host did not report';
          if (foundById) prov += ' \u00b7 read from Base just now by its id, not from this host\u2019s scan';
          // Only ever "on this page". The old wording said "in this list",
          // which invited the reading that a name unmarked here is a name
          // nobody else took \u2014 and where the scan reached part of the
          // factory, that is a guarantee this card cannot make.
          if (sharing > 1) prov += ' \u00b7 ' + sharing + ' of the pools on this page carry the name \u201c' + (p.name || '') + '\u201d \u2014 different pools, different creators, one word between them';
          box.appendChild(h('p', { class: 'smallnote', text: prov }));''',
    'row provenance: id-found marking + honest clash scope')

# ── 10. swap: balance asked before the approval, legs through the ledger ────
once(
    r'''                  var toks = await ocGetTokens(factory);
                  led.landed(await ocAllow(q.sellPeer ? toks.peer : toks.btc, factory, q.vin, q.sellPeer ? 'PEER' : 'cbBTC', q.sellPeer ? pdec : bdec));''',
    r'''                  var toks = await ocGetTokens(factory);
                  var sellTok = q.sellPeer ? toks.peer : toks.btc;
                  var sellSym = q.sellPeer ? 'PEER' : 'cbBTC';
                  var sellDec = q.sellPeer ? pdec : bdec;
                  // Free, and asked first: a wallet that cannot cover the
                  // trade used to find that out one approval too late, having
                  // paid gas for a permission it could not use.
                  await ocHave(sellTok, q.vin, sellSym, sellDec);
                  await ocAllow(sellTok, factory, q.vin, sellSym, sellDec, led);''',
    'swap checks the balance before the approval')

once(
    r'''                  await ocSend(factory, data, 'Swapping in ' + label);''',
    r'''                  await ocSend(factory, data, 'Swapping in ' + label, led, 'the swap of ' + ocFmt(q.vin, sellDec) + ' ' + sellSym + ' in ' + label);''',
    'swap send carries its ledger clause')

# ── 11. add liquidity: both balances first, both legs recorded ──────────────
once(
    r'''                  led.landed(await ocAllow(toks.peer, factory, vp, 'PEER', pdec));
                  led.landed(await ocAllow(toks.btc, factory, vb, 'cbBTC', bdec));''',
    r'''                  // Both sides asked for free before either is approved:
                  // approving PEER and then discovering the wallet has no
                  // cbBTC leaves a paid-for permission and no deposit.
                  await ocHave(toks.peer, vp, 'PEER', pdec);
                  await ocHave(toks.btc, vb, 'cbBTC', bdec);
                  await ocAllow(toks.peer, factory, vp, 'PEER', pdec, led);
                  await ocAllow(toks.btc, factory, vb, 'cbBTC', bdec, led);''',
    'add liquidity checks both balances before either approval')

once(
    r'''                  await ocSend(factory, OC_SEL.addLiquidity + ocWord(p.id) + ocWord(vp) + ocWord(vb) + ocWord(ocGuard(expect)) + ocWord(await ocDeadline()), 'Adding liquidity to ' + label);''',
    r'''                  await ocSend(factory, OC_SEL.addLiquidity + ocWord(p.id) + ocWord(vp) + ocWord(vb) + ocWord(ocGuard(expect)) + ocWord(await ocDeadline()), 'Adding liquidity to ' + label, led, 'the deposit into ' + label);''',
    'add liquidity send carries its ledger clause')

# ── 12. withdrawing: the leg the ledger was created for ─────────────────────
once(
    r'''                      await ocSend(factory, OC_SEL.removeLiquidity + ocWord(p.id) + ocWord(sh) + ocWord(ocGuard(expP)) + ocWord(ocGuard(expB)), 'Withdrawing from ' + label);''',
    r'''                      await ocSend(factory, OC_SEL.removeLiquidity + ocWord(p.id) + ocWord(sh) + ocWord(ocGuard(expP)) + ocWord(ocGuard(expB)), 'Withdrawing from ' + label, led, 'the withdrawal of your whole share of ' + label);''',
    'withdraw send carries its ledger clause')

# ── 13. opening a pool: the third free refusal, and the leg ─────────────────
once(
    r'''                var toks = await ocGetTokens(factory);
                led.landed(await ocAllow(toks.peer, factory, vp, 'PEER', pdec));
                led.landed(await ocAllow(toks.btc, factory, vb, 'cbBTC', bdec));
                await ocSend(factory, OC_SEL.createPool + hexName + ocWord(vp) + ocWord(vb), 'Opening \u201c' + nm + '\u201d');''',
    r'''                var toks = await ocGetTokens(factory);
                // The third knowable refusal, and the one that was missing:
                // MIN_LIQ and the name claim were already asked for free, but
                // a wallet without the coins still paid for two approvals
                // before the pull reverted.
                await ocHave(toks.peer, vp, 'PEER', pdec);
                await ocHave(toks.btc, vb, 'cbBTC', bdec);
                await ocAllow(toks.peer, factory, vp, 'PEER', pdec, led);
                await ocAllow(toks.btc, factory, vb, 'cbBTC', bdec, led);
                await ocSend(factory, OC_SEL.createPool + hexName + ocWord(vp) + ocWord(vb), 'Opening \u201c' + nm + '\u201d', led, 'opening the pool \u201c' + nm + '\u201d');''',
    'createPool checks both balances for free and records its leg')

# ── 14. the id lookup the truncation note promises ──────────────────────────
once(
    r'''        // ── open a pool ──
        // The pair is preset: every pool this factory can make is PEER''',
    r'''        // ── find a pool by its id ──
        // The list above is what this host's scan reached, and when that is
        // less than the whole factory the reader says so in its own words —
        // ending, quite correctly, that a pool missing from the list "is
        // still perfectly usable by anyone who has its id". This is where
        // that promise is kept. Until now the card made it and offered no
        // way to act on it, which is worse than staying quiet: it told
        // somebody their pool was reachable and then hid the door.
        //
        // poolInfo(uint256) is a free read and signs nothing. It goes through
        // the WALLET's connection because a wallet is this page's only way to
        // ask Base a direct question — the host's endpoint answers with its
        // scan and nothing else, and this file will not reach for some third
        // party's RPC on a user's behalf. Without a wallet the button says so
        // rather than failing quietly.
        //
        // The row it draws is the same row the list draws, with the same
        // buttons, keyed by the same id: a pool nobody can see is not a pool
        // anybody should have to trade in blind.
        var idIn = h('input', { type: 'text', placeholder: 'pool id', style: 'width:90px', inputmode: 'numeric' });
        var idSlot = h('div', {});
        ocBody.appendChild(h('p', { class: 'eyebrow', style: 'margin:10px 0 0', text: 'find a pool by id \u2014 including one this host never listed' }));
        ocBody.appendChild(h('div', { class: 'mini-form persistent' }, idIn,
          h('button', { class: 'btn small', text: 'Look it up', onclick: function () {
            idSlot.innerHTML = '';
            var t = String(idIn.value || '').trim();
            if (!/^\d+$/.test(t)) { toast('A pool id is a whole number \u2014 the one printed beside every pool in the list.'); return; }
            if (!window.ethereum) { toast('An id lookup asks Base directly, which needs a wallet. It signs nothing; this page has no other way to reach the chain.'); return; }
            (async function () {
              try {
                var chain = await ocEth('eth_chainId');
                if (chain !== OC_CHAIN) { toast('That wallet answers for chain ' + chain + ', not Base \u2014 an id read through it would be about a different chain entirely.'); return; }
                var ret = await ocEth('eth_call', [{ to: factory, data: OC_SEL.poolInfo + ocWord(BigInt(t)) }, 'latest']);
                var body = String(ret == null ? '' : ret).replace(/^0x/, '');
                // Five static words: name, resPeer, resBtc, totalShares,
                // creator. An id past the end of the factory reverts, which
                // arrives here as an error or an empty answer \u2014 never as a
                // pool full of zeroes, which is why nothing short is decoded.
                if (body.length < 64 * 5) { toast('Nothing answered for pool #' + t + ' on this factory. An id that exists answers in five words; this answered in fewer.'); return; }
                var p = {
                  id: t,
                  name: ocName(body.slice(0, 64)),
                  nameRaw: '0x' + body.slice(0, 64),
                  resPeerRaw: BigInt('0x' + body.slice(64, 128)).toString(),
                  resBtcRaw: BigInt('0x' + body.slice(128, 192)).toString(),
                  totalSharesRaw: BigInt('0x' + body.slice(192, 256)).toString(),
                  creator: '0x' + body.slice(280, 320)
                };
                idSlot.appendChild(poolRow(p, ocSharing(p), true));
              } catch (e) { toast('Could not read pool #' + t + ': ' + ocErr(e)); }
            })();
          } }),
          h('span', { class: 'smallnote', text: window.ethereum ? 'A free read straight to Base \u2014 it signs nothing, and it works for ids this host\u2019s scan never reached.' : 'Needs a wallet: asking Base directly is the only way to reach a pool this host did not list.' })));
        ocBody.appendChild(idSlot);

        // ── open a pool ──
        // The pair is preset: every pool this factory can make is PEER''',
    'find a pool by id — the door the truncation note promises')

_data = s.encode('utf-8')
io.open(TP, 'wb').write(_data)
print('applied:', applied)
print('size: %d -> %d (+%d)' % (orig_len, len(s), len(s) - orig_len))
