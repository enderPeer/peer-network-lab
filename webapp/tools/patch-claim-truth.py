# Six things the epoch-earnings surface said that are not true, and one epoch
# it made unreachable.
#
#  1. The token card told the reader, in the sentence right above the claim
#     card, that "nothing in this app can turn epoch PEER into the coin below".
#     The card two hundred pixels lower does exactly that: it pays the ERC-20
#     against a published list of epoch credits. The direction that misleads is
#     the expensive one — a reader who believes there is nothing to collect
#     never scrolls to the only place in the app that says an UNBOUND handle
#     gets no line at all, and an epoch that closes with the handle unbound
#     loses that share permanently at the sweep. So the sentence now says what
#     is actually true: no rate, no automatic conversion, no obligation, one
#     crossing that runs one way only, in the card below this one. Same repair
#     in the guide, where the absolute was repeated a section before the
#     section that explains claiming.
#
#  2. Only the six newest epochs were reachable, and the note under them
#     admitted the older ones were "still claimable if they were ever funded"
#     while offering no way to reach them. closeEpoch is a communal act with a
#     plain button, so seven closes in an afternoon push a funded, open,
#     matching-root epoch off the bottom of the only list in the app that
#     renders a Claim button — and it sits there until its window runs out and
#     sweeps back to the steward. The cap was a batching decision (one host
#     read and one chain read per row); it is now a batch, with a button.
#
#  3. TERMS.steward dropped the one power that can take a claimant's money.
#     PeerClaim.sol's CAN list names it outright: the steward may put an
#     address they control in the root and claim it first, which is a complete
#     one-transaction censoring of that epoch's other claimants. The UI's
#     version read like an accident between honest claimants. The CANNOT half
#     was short by exactly the clause the contract header was corrected to add
#     — MIN_WINDOW — which the `deadline` term's "set when the epoch is funded"
#     left a reader believing was the funder's free choice. Both are stated
#     now, and the card names the steward's actual address and serves the
#     host's own account of the role, which chain-l2/onchain.mjs has always
#     computed and nothing rendered.
#
#  4. "gas is only ever spent on a claim that is going to work" is a promise
#     checkClaim cannot make: it is an eth_call at 'latest', and PeerClaim.sol
#     says in as many words that the answer can go stale the moment another
#     claim lands. On an oversubscribed epoch a claim that just checked out
#     reverts and the gas is gone — which the card's own success path already
#     admits two paragraphs later. The sentence now ends where the evidence
#     ends.
#
#  5. The bind gate refused a passkey-secured handle in the host's name for a
#     rule the host does not have. server.mjs enters its no-credential branch
#     only when BOTH the PIN store and the key store are empty, and the comment
#     above that line was written for bindAddress specifically. The client
#     cannot make that test at all — replay.cjs carries pinHash and nothing
#     about passkeys — so the test was a PIN test wearing a credential test's
#     sentence, and its cost was the earnings: the strongest credential in this
#     codebase was blocked from the one act that turns a share into money and
#     steered toward a weaker one. The question now goes to the host that holds
#     the answer (GET /api/auth/status), only the case it confirms is refused
#     here, and a host that will not answer is not treated as a refusal.
#
# Run:  python tools/patch-claim-truth.py && node social/assemble.mjs && npx vitest run
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


# ── 1. the steward, with the bullet the contract puts in its CAN list ──────
once(
    """      more: 'It cannot create coins (there is no mint), cannot edit a payout list it has already published, and cannot take back a payment already made. What it CAN do that costs people: publish a list adding up to more than it deposited, which pays whoever claims first and fails for everyone after — so the amounts are all published, and this app compares them for you.',""",
    """      more: 'It cannot create coins (there is no mint), cannot edit a payout list it has already published, cannot take back a payment already made, cannot sweep before the deadline, and cannot open an epoch whose claim window is shorter than a week. What it CAN do that costs people: publish a list adding up to more than it deposited, which pays whoever claims first and fails for everyone after — including a list that pays an address the steward controls, claimed first, which empties that epoch before anybody else reaches it. Nothing on a chain can add a list up, so the amounts are all published and this app compares them for you.',""",
    'TERMS.steward names the sharp power and the week-long floor',
)

# ── 2. the deadline is floored, and the term said it was chosen freely ─────
once(
    """      more: 'It is set when the epoch is funded and it is on the chain\\u2019s clock, not this computer\\u2019s. Miss it and the money is not held for you: it goes back to whoever put it there.',""",
    """      more: 'It is set when the epoch is funded and it is on the chain\\u2019s clock, not this computer\\u2019s. The contract refuses a window shorter than a week and refuses to sweep before it passes, so this is not a span the funder can shrink to nothing. Miss it and the money is not held for you: it goes back to whoever put it there.',""",
    'TERMS.deadline names the minimum window',
)

# ── 3. the token card stops denying the card underneath it ────────────────
once(
    """      body.appendChild(h('p', { class: 'smallnote', text: 'The PEER below is a different token that happens to share the name: an ERC-20 on ' + chainName + '. That is the one a wallet holds and the only one an on-chain pool can trade. There is no bridge between the two and neither converts into the other \\u2014 nothing in this app can turn epoch PEER into the coin below, or the coin below into epoch PEER.' }));""",
    """      body.appendChild(h('p', { class: 'smallnote', text: 'The PEER below is a different token that happens to share the name: an ERC-20 on ' + chainName + '. That is the one a wallet holds and the only one an on-chain pool can trade. There is no exchange rate between the two and nothing converts one into the other automatically: the coin below never becomes epoch PEER, and epoch PEER is never spent to get it.' }));
      // The one crossing, named here because the card that does it is the very
      // next thing in this view. This used to be an absolute — nothing in this
      // app can turn epoch PEER into the coin below — with the claim card
      // rendered two hundred pixels lower doing precisely that, and the
      // misleading direction is the expensive one: a reader who believes there
      // is nothing to collect never scrolls to the only place in this app that
      // says an unbound handle gets no line at all, and that share is gone at
      // the sweep rather than waiting for them.
      body.appendChild(h('p', { class: 'smallnote', text: 'One crossing does exist, in the card below this one, and it runs one way only: the operator may deposit coins they already hold against an epoch\\u2019s payout list, and a handle with an address bound before that epoch closed can then claim its line \\u2014 paid in the coin below, at the number the log computed. Nobody is obliged to fund an epoch, a handle with no address bound gets no line in the list at all, and claiming does not spend the epoch PEER the line was computed from.' }));""",
    'the token card names the one crossing and points at it',
)

# ── 4. the epoch list is a batch now, not a truncation ────────────────────
once(
    """    var ROWS = 6;   // most recent epochs asked about per render
""",
    """    var ROWS = 6;   // epochs asked about per press, newest first
    // How many rows are on screen. It only rises, and only when somebody asks.
    // The cap is there because every row costs one host read and one chain
    // read, which is a reason to ask in batches and no reason at all to make
    // an epoch unreachable: nothing else in this app renders an epoch row, so
    // a funded, open, still-matching epoch pushed off the bottom by a busy
    // afternoon of closes had no route to a Claim button until its window ran
    // out and the remainder swept back to the steward.
    var shownN = ROWS;
""",
    'shownN — the window into the epoch list, raised by a press',
)

once(
    """    function drawEpochs() {
      epochBox.innerHTML = '';
      epochBox.appendChild(h('p', { class: 'eyebrow', style: 'margin:18px 0 4px', text: 'what each closed epoch credited you' }));""",
    """    function drawEpochs() {
      epochBox.innerHTML = '';
      // Every repaint in that list points at a row this line just detached.
      rowPaints.length = 0;
      epochBox.appendChild(h('p', { class: 'eyebrow', style: 'margin:18px 0 4px', text: 'what each closed epoch credited you' }));""",
    'drawEpochs drops the repaints for the rows it just removed',
)

once(
    """      var shown = mine.slice(0, ROWS);
      if (mine.length > shown.length) {
        epochBox.appendChild(note('The ' + shown.length + ' most recent of ' + mine.length + ' epochs that credited this handle. The older ones are unchanged and still claimable if they were ever funded; this card asks about a few at a time so that opening it is not a chain read per epoch.'));
      }
      for (var k = 0; k < shown.length; k++) epochBox.appendChild(epochRow(shown[k]));
    }
""",
    """      var shown = mine.slice(0, shownN);
      if (mine.length > shown.length) {
        epochBox.appendChild(note('The ' + shown.length + ' most recent of ' + mine.length + ' epochs that credited this handle. Each row is one question to this host and one to the chain, so they are asked in batches rather than all at once \\u2014 the rest are unchanged and still claimable if they were ever funded, and the button below asks about them.'));
      }
      for (var k = 0; k < shown.length; k++) epochBox.appendChild(epochRow(shown[k]));
      if (mine.length > shown.length) {
        var left = mine.length - shown.length;
        var step = left < ROWS ? left : ROWS;
        epochBox.appendChild(h('div', { class: 'mini-form persistent', style: 'margin-top:12px' },
          h('button', { class: 'btn small ghost', text: 'Show ' + step + ' older epoch' + (step === 1 ? '' : 's'),
            onclick: function () { shownN += ROWS; drawEpochs(); } }),
          h('span', { class: 'smallnote', text: left + ' older epoch' + (left === 1 ? '' : 's') + ' this card has not asked about yet. An epoch\\u2019s claim window runs whether or not its row is on screen, so open them rather than read their absence as \\u201cnothing there\\u201d.' })));
      }
    }
""",
    'the older epochs get a button instead of a closed door',
)

# ── 5. the steward, named, on the card that depends on them ───────────────
once(
    """    // ── 2. the wallet, once for the whole card ────────────────────────────
    body.appendChild(wRow);
""",
    """    // ── 2. the wallet, once for the whole card ────────────────────────────
    body.appendChild(wRow);

    // ── 2b. who the steward is, in the host's own words ───────────────────
    //
    // The rows below all depend on one account choosing to fund an epoch, and
    // the card named it nowhere: `steward` appeared once in the whole surface,
    // under the softer label "operator", with no address beside it. Both lines
    // come from this host — the address the contract answers for steward(),
    // and the account of the role that chain-l2/onchain.mjs already computes
    // and serves to every other consumer of /api/token/onchain, including the
    // uncomfortable half. Rendered only where that answer is about the very
    // contract these rows claim against: a steward printed under a different
    // deployment would be a different person entirely.
    var sBox = h('div', {});
    body.appendChild(sBox);
    var sAsked = false;

    function drawSteward() {
      if (sAsked || !claimAddr) return;
      sAsked = true;
      fetch(API + '/api/token/onchain', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var cs = d && d.claimState;
          if (!cs || !cs.contract || !cs.steward) return;
          if (String(cs.contract).toLowerCase() !== String(claimAddr).toLowerCase()) return;
          sBox.innerHTML = '';
          sBox.appendChild(h('p', { class: 'eyebrow', style: 'margin:16px 0 4px', text: 'who can open and fund an epoch here' }));
          var row = h('div', { class: 'mini-form persistent' },
            h('span', { class: 'smallnote' }, 'the ', term('steward', 'steward'), ' of this contract is'),
            h('span', { class: 'smallnote num', style: 'word-break:break-all', text: String(cs.steward) }));
          var link = l2ScanLink(d.chainId, 'address', cs.steward, 'on basescan');
          if (link) row.appendChild(link);
          sBox.appendChild(row);
          if (cs.stewardIs) sBox.appendChild(note(cs.stewardIs));
        })
        .catch(function () { sAsked = false; });   // a question that failed is not an answer
    }
""",
    'the claim card names the steward and what the role can do',
)

once(
    """        if (!claimAddr && oc.contract) {
          claimAddr = String(oc.contract);
          chainHex = l2ChainHex(oc.chainId);
          chainName = l2ChainName(oc.chainId);
          drawWallet();
        }""",
    """        if (!claimAddr && oc.contract) {
          claimAddr = String(oc.contract);
          chainHex = l2ChainHex(oc.chainId);
          chainName = l2ChainName(oc.chainId);
          drawWallet();
          drawSteward();
        }""",
    'the steward block is asked for once the contract is known',
)

# ── 6. the dry run promises only what a dry run can ───────────────────────
once(
    """          h('span', { class: 'smallnote' }, 'The contract is asked first, for free, whether this would be paid \\u2014 a refused ',
            term('proof', 'proof'), ' costs nothing this way, and gas is only ever spent on a claim that is going to work.')));""",
    """          h('span', { class: 'smallnote' }, 'The contract is asked first, for free, whether this would be paid \\u2014 a refused ',
            term('proof', 'proof'), ' costs nothing this way, and this page will not offer to sign a claim the contract has already said no to. It is one moment\\u2019s answer, not a guarantee: on an epoch whose list adds up to more than its deposit, another claim landing first can still revert this one, and so can the deadline passing between the check and the block that carries the transaction. Gas spent on a claim that reverts does not come back.')));""",
    'the claim button stops promising gas can only be spent well',
)

# ── 7. the bind gate asks the host instead of guessing from pinHash ───────
once(
    """    function submitBind(addr) {
      // The host refuses this act from a handle with no credential, and it is
      // right to: an unsecured handle is claimable by anyone who knows its id,
      // and this is the act that decides where money goes. Said here rather
      // than offering a button that bounces.
      if (!st.pinHash[me]) {
        toast('Set a PIN first \\u2014 this act says where money goes, and the host refuses it from a handle anyone could act as.');
        setPinFlow(st, false);
        return;
      }
      // The ordinary act path, PIN unlock and all: pushAct is what every other
      // act in this file goes through, and bindAddress is not debited (the
      // replay says so in as many words), so it does not go through the W1
      // wrapper that would refuse a drained account. Earning needs no reserve
      // and speaking does, so those two run out at different times, and an
      // account that earned a share must still be able to say where it goes.
      pushAct({ t: 'bindAddress', id: me, addr: addr }, function () {
        toast('Bound to ' + addr + '. It costs no \\u03b8. From the next epoch close, this handle\\u2019s share is a line in the payout list under that address; epochs already closed are unchanged.');
      });
    }
""",
    """    function submitBind(addr) {
      // The host refuses this act from a handle with NO CREDENTIAL, and it is
      // right to: an unsecured handle is claimable by anyone who knows its id,
      // and this is the act that decides where money goes. But "secured" is a
      // question about credentials, and this page cannot answer it — the
      // replay carries pinHash and nothing whatever about passkeys, so the
      // test that stood here was a PIN test wearing a credential test's
      // sentence. server.mjs enters its no-credential branch only when BOTH
      // stores are empty, and the comment above that line was written for this
      // very act; refusing in the host's name for a rule the host does not
      // have sent the owner of the strongest credential in this codebase off
      // to set a weaker one, or to watch their share stay unbound and return
      // to the steward at every sweep.
      //
      // So the question goes to the host that holds the answer, and only the
      // case it confirms is refused here. A host that will not answer is not a
      // refusal: the act is sent, and whatever the host says of it — including
      // "this handle is secured with a passkey, sign the act with it" — is
      // what the reader is told, in the host's own words.
      var go = function () {
        // The ordinary act path, PIN unlock and all: pushAct is what every
        // other act in this file goes through, and bindAddress is not debited
        // (the replay says so in as many words), so it does not go through the
        // W1 wrapper that would refuse a drained account. Earning needs no
        // reserve and speaking does, so those two run out at different times,
        // and an account that earned a share must still be able to say where
        // it goes.
        pushAct({ t: 'bindAddress', id: me, addr: addr }, function () {
          toast('Bound to ' + addr + '. It costs no \\u03b8. From the next epoch close, this handle\\u2019s share is a line in the payout list under that address; epochs already closed are unchanged.');
        });
      };
      if (!REMOTE) { go(); return; }
      fetch(API + '/api/auth/status?as=' + encodeURIComponent(me), { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var hasPin = !!(d && d.hasPin);
          var keys = d && d.passkeys && d.passkeys.length ? d.passkeys.length : 0;
          if (!hasPin && !keys) {
            toast('Secure this handle first, with a PIN or a passkey \\u2014 this act says where money goes, and the host refuses it from a handle anyone could act as.');
            setPinFlow(st, false);
            return;
          }
          go();
        })
        .catch(function () { go(); });
    }
""",
    'the bind gate asks /api/auth/status instead of reading pinHash',
)

# ── 8. the guide, where both false absolutes were repeated ────────────────
once(
    """        P(B('Whoever holds the address collects. '), 'A binding is as strong as your PIN, and the app asks for it. Nothing here can tell whether an address is yours""",
    """        P(B('Whoever holds the address collects. '), 'A binding is as strong as the credential on the handle — a PIN or a passkey — and the host demands one before it records this act. Nothing here can tell whether an address is yours""",
    'the guide stops calling a binding PIN-strength only',
)

once(
    """ — a real token in a real wallet, and the only one of the two a pool can trade. Nothing converts either into the other.'),""",
    """ — a real token in a real wallet, and the only one of the two a pool can trade. There is no exchange rate between them and no automatic bridge in either direction: the coin on Base never becomes epoch PEER, and epoch PEER is never spent to get it. The one crossing is the one described above — the operator may deposit coins they already hold against an epoch’s payout list, and a handle bound to an address before that epoch closed can claim its line — and claiming pays the coin without touching the epoch PEER the line was computed from.'),""",
    'the guide names the crossing instead of denying it',
)

_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
