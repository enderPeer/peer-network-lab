# What the PEER-burn card said, and what turned out to be true.
#
# Every change here is a sentence on screen that a review found to be an
# overclaim, and one control that could not be used safely because of one of
# them. The card is otherwise unchanged; nothing new is added for its own sake.
#
#   1. 'It also gives a ceiling for free — no burn, however enormous, is worth
#      more than the whole bitcoin side of the pool.' True of ONE burn and
#      false of a log. The reserves never move, because the PEER is destroyed
#      rather than sold, so every burn is priced as if it were the first.
#      Measured: 300 free handles each filling the per-account ceiling once
#      against a pool holding 1,000,000 sat created 2,710,000 sat of 'value
#      destroyed' — 3.6x what selling that PEER into that pool could realise.
#      There is now a per-pool per-epoch bound, and the card says both things.
#
#   2. 'A PEER burn credits reserve — the right to speak — and touches nothing
#      else.' Reserve buys acts, and acts are what the standing solve reads.
#      The two clauses that ARE true (never the epoch mint, never the writer
#      election) stay; the one that was not is replaced by what actually
#      happens.
#
#   3. 'A burn over the ceiling is not trimmed to fit and not lost … the rest
#      is claimable after the next epoch closes.' The two halves contradicted
#      each other, and the first one won: a burn worth more than one whole
#      epoch's allowance was refused entire in every epoch that will ever
#      exist, so it credited nothing, permanently. It is now credited in
#      slices, each act stating its own, and the card says so — and prints the
#      amount that fits in ONE epoch, in PEER, next to the box, because
#      'you have 100 reserve left' beside a box measured in PEER is a headroom
#      the person typing cannot use.
#
#   4. 'A PEER burn is credited to whichever handle has BOUND the address it
#      was sent from.' That was the theft: binding an address needs only the
#      binding handle's own PIN, so a stranger bound somebody else's address
#      and took their reserve. Ownership is now: exactly ONE handle must have
#      bound the address, and it must have bound it BEFORE the burn. The card
#      has to say the order out loud, because it is the whole protection and
#      it is invisible otherwise.
#
#   5. The guide says 'four fences'. There are six.
#
# Run:  python tools/patch-peer-burn-review-fixes.py && node social/assemble.mjs
import io

TP = 'social/template.html'
s = io.open(TP, encoding='utf-8').read()
before = len(s)


def once(old, new, label):
    global s
    n = s.count(old)
    assert n == 1, 'anchor %r matched %d times, expected exactly 1' % (label, n)
    s = s.replace(old, new, 1)
    print('  patched: ' + label)


# ── 1. The ceiling the arithmetic gives, and the one it does not ──────────
once(
    r"""The ratio is a price no trade can get: a burn big enough to move the pool would credit satoshis nobody could ever have realised. It also gives a ceiling for free — no burn, however enormous, is worth more than the whole bitcoin side of the pool. Nothing is taken off for a fee, because nothing is sold: the PEER is destroyed and the pool’s reserves do not move.' }));""",
    r"""The ratio is a price no trade can get: a burn big enough to move the pool would credit satoshis nobody could ever have realised. Nothing is taken off for a fee, because nothing is sold: the PEER is destroyed and the pool’s reserves do not move.' }));
    card.appendChild(h('p', { class: 'smallnote', text: 'That line gives ONE burn a ceiling for free — no single burn, however enormous, is worth more than the whole bitcoin side of the pool. It gives a LOG none, and the difference matters: because the PEER is destroyed rather than sold, the reserves never move, so the hundredth burn is priced as if it were the first. Three hundred accounts each taking a full epoch’s allowance against a pool holding 0.01 cbBTC would have created three and a half times what selling that PEER into that pool could ever have paid out. So a pool has a second, separate bound: in one epoch it cannot create more reserve than it holds bitcoin, first come first served, and the rest waits for the next epoch.' }));""",
    'the constant-product ceiling is per burn, and the aggregate is its own rule',
)


# ── 2. What this door never buys, and what it plainly does ────────────────
once(
    r"""      'A PEER burn credits reserve — the right to speak — and touches nothing else. It adds nothing to the satoshis you have proved destroyed on the Bitcoin chain, and that is the weight the epoch mint shares out and the weight the writer election counts. So the most a pushed price could ever buy through here is speech, capped per account per epoch. It can never buy a share of the mint or a vote for the writer.'));""",
    r"""      'A PEER burn credits reserve, and adds nothing to the satoshis you have proved destroyed on the Bitcoin chain — which is the weight the epoch mint shares out and the weight the writer election counts. Those two are what it can never buy, at any size, however the price was arrived at.'));
    card.appendChild(h('p', { class: 'smallnote' },
      h('b', { text: 'What it does buy, said exactly. ' }),
      'Reserve is the energy every act is debited from, so it buys ACTS — and acts are what the standing solve reads. This card used to say a PEER burn "touches nothing else", and that was not true: an account that speaks more has more of a graph around it. What bounds it is the ceiling rather than the claim, so the ceiling is printed below and the two things it can never reach are named above.'));""",
    'what the door never buys, without the clause that was not true',
)


# ── 3. The rules, with the two that were missing ──────────────────────────
once(
    r"""    rule(h('span', {}, 'most reserve this door creates'), perEpoch + ' per account per epoch');""",
    r"""    rule(h('span', {}, 'most reserve this door creates'), perEpoch + ' per account per epoch');
    rule(h('span', {}, '…and per pool, per epoch'), 'the pool’s own bitcoin side');
    rule(h('span', {}, 'blocks read inside the window'), (Number(lim.twapGrid) || 0) + ', chosen by the block hash');""",
    'the rules list names the aggregate bound and the seeded sampling',
)

once(
    r"""so what this card refuses and what replay refuses cannot drift apart. A burn over the ceiling is not trimmed to fit and not lost: it stays on the chain and stays valid, and the rest is claimable after the next epoch closes.' }));""",
    r"""so what this card refuses and what replay refuses cannot drift apart. A burn over the ceiling is not lost: the act records the slice it credits, and the rest of it is credited an epoch at a time, by the host, without you doing anything.' }));
    card.appendChild(h('p', { class: 'smallnote', text: 'The last of those is worth a sentence on its own. A window is only as good as WHERE inside it the price was read, and reading it on a fixed pattern would be no defence at all: whoever burns picks the block their burn lands in, so they would know every block that was going to be read and could push the price at exactly those, holding a false price for a hundredth of the window rather than all of it. The blocks are picked instead by the hash of the block the window ends at — a number nobody knows until that block exists — so pushing the price for a tenth of the window is caught about a tenth of the time, and the cost of lying is the cost of holding the lie. Every burn records that hash and the blocks it read, so anyone can redo the choice and re-read the pool at each of them.' }));""",
    'a burn over the ceiling is sliced, not forfeited — and why the window is seeded',
)


# ── 4. Whose burn it is, and in which order ───────────────────────────────
once(
    r"""      stateBox.appendChild(h('p', { class: 'smallnote', text: 'A PEER burn is credited to whichever handle has BOUND the address it was sent from — the same binding the epoch-earnings card above uses, read out of the public act log. Nothing needs to stay open: the host watches the dead address on its own tick and credits any transfer from a bound address whether or not this page exists. PEER sent from an address no handle has bound is destroyed and credited to nobody.' }));
      if (who && you && you.boundAddress) {
        stateBox.appendChild(h('p', { class: 'smallnote', text: 'This handle is bound to ' + String(you.boundAddress) + ' — that is the only address whose burns count as yours.' }));
      } else if (who) {""",
    r"""      stateBox.appendChild(h('p', { class: 'smallnote' },
        h('b', { text: 'Bind the address first, then burn from it. ' }),
        'A PEER burn is credited to the handle that had bound the sending address ALREADY, when the coins were destroyed — and to exactly one handle: an address two handles have bound is credited to neither. Both halves are the protection. Binding an address costs nothing but your own PIN and nothing anywhere can check that an address is really yours, so if a binding filed afterwards could reach a burn, anyone could read the public list of uncredited burns, bind the address a stranger sent from, and take it — permanently, because a burn is claimed once. Nothing needs to stay open once the order is right: the host watches the dead address on its own tick and credits your burn whether or not this page exists.'));
      if (who && you && you.boundAddress && you.burnsFromItAreYours === false) {
        stateBox.appendChild(h('p', { class: 'smallnote', style: 'color:var(--bad)', text: 'Another handle has also bound ' + String(you.boundAddress) + ', so a burn from it would be credited to nobody — not to them and not to you. Nothing of yours can be taken through it; it simply cannot be used for this door. Bind an address only this handle has named and burn from that one instead.' }));
      } else if (who && you && you.boundAddress) {
        stateBox.appendChild(h('p', { class: 'smallnote', text: 'This handle is bound to ' + String(you.boundAddress) + ', and that binding is already older than anything you burn from here on — so burns from it are yours. It is the only address whose burns count as yours.' }));
      } else if (who) {""",
    'ownership on the card: one handle, and bound before the burn',
)

once(
    r"""        stateBox.appendChild(h('p', { class: 'smallnote', style: 'color:var(--bad)', text: 'This handle has no address bound to it, so a burn made now would credit nobody. Bind one in the card above first — it is free and costs no θ.' }));""",
    r"""        stateBox.appendChild(h('p', { class: 'smallnote', style: 'color:var(--bad)', text: 'This handle has no address bound to it, so a burn made now would credit nobody — and binding afterwards would not rescue it, because a binding cannot reach coins that were already destroyed. Bind one in the card above FIRST: it is free and costs no θ.' }));""",
    'the unbound warning says binding afterwards does not rescue a burn',
)


# ── 5. The headroom, in the unit the box is measured in ───────────────────
# 'You have 100 reserve left' printed beside a box a person types PEER into is
# a limit they cannot apply. The amount that fits is derived from the same
# quoted reserves the arithmetic above uses, by inverting the constant-product
# output: N = sats·poolPEER / (poolBTC − sats).
once(
    r"""        var left = you && isFinite(Number(you.reserveLeftThisEpoch)) ? Number(you.reserveLeftThisEpoch) : null;
        if (who && left !== null && reserve > left) refuse.push('This would create ' + reserve + ' reserve and you have ' + fmt(left, 2) + ' of your ' + perEpoch + ' left this epoch. A burn over the ceiling is refused whole rather than trimmed — so burn less now, or burn this much after the next epoch closes.');""",
    r"""        var left = you && isFinite(Number(you.reserveLeftThisEpoch)) ? Number(you.reserveLeftThisEpoch) : null;
        if (who && left !== null && reserve > left) {
          // Not a refusal any more, and the difference is the whole point: a
          // burn over the ceiling used to credit NOTHING, in every epoch,
          // while the screen promised the rest next epoch. It is now credited
          // in slices. What the person still needs is the amount that lands
          // in one go, in the unit they are typing.
          var fits = maxPeerRaw(Math.round(left * satsPer), rp, rb);
          work.appendChild(h('p', { class: 'smallnote', text: 'This would be worth ' + fmt(reserve, 2) + ' reserve and you have ' + fmt(left, 2) + ' of your ' + perEpoch + ' left this epoch. Nothing is lost by burning it anyway: ' + fmt(left, 2) + ' is credited now and the rest an epoch at a time, by the host, with nothing left open on your side. To have all of it credited at once, burn ' + (fits === null ? 'less' : 'about ' + l2Human(fits, 18) + ' PEER') + ' instead.' }));
        }""",
    'the ceiling prints the amount that fits, in PEER, and stops calling it a refusal',
)

# The inverse of the pricing line, beside the pricing line. It is only ever
# used to print an amount, never to decide one: what a burn credits is what the
# host reads when it verifies the transfer.
once(
    r"""    function quoteSats(amtRaw, rpRaw, rbRaw) {""",
    r"""    /**
     * The largest raw PEER whose quoted value is at most `sats`, from the same
     * reserves. Inverting sats = floor(N·rb / (rp + N)) gives
     * N = sats·rp / (rb − sats), floored, which is the number of PEER that
     * fills the headroom without crossing it.
     *
     * Display only. Nothing here decides what is credited — the host prices
     * the burn from its own reading when it verifies the transfer — and a
     * number this page could not compute is simply not printed.
     */
    function maxPeerRaw(sats, rpRaw, rbRaw) {
      try {
        var s = BigInt(Math.max(0, Math.floor(sats))), rp = BigInt(rpRaw), rb = BigInt(rbRaw);
        if (s <= 0n || rp <= 0n || rb <= s) return null;
        return ((s * rp) / (rb - s)).toString();
      } catch (e) { return null; }
    }
    function quoteSats(amtRaw, rpRaw, rbRaw) {""",
    'maxPeerRaw: the headroom, in the unit the box takes',
)


# ── 6. Six fences, not four ───────────────────────────────────────────────
once(
    r"""Four fences answer that: the price is ', B('time-weighted'), ' over a window instead of read off one moment, a pool below a minimum ', B('depth'), ' is refused in words rather than priced badly, the reserve one account can create this way in one epoch is capped, and the burn must be a transfer that really happened on Base. The numbers are printed on the card itself.'),""",
    r"""Six fences answer that: the price is ', B('time-weighted'), ' over a window instead of read off one moment, and the blocks read inside that window are chosen by a block hash nobody can know in advance, so pushing the price costs whatever it costs to HOLD it; a pool below a minimum ', B('depth'), ' is refused in words rather than priced badly; the reserve one account can create this way in one epoch is capped, and so is the reserve any one pool can create in an epoch; the burn must be a transfer that really happened on Base; and it must come from an address bound to your handle, and bound before the burn. The numbers are printed on the card itself.'),""",
    'the guide counts the fences it actually has',
)


_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
