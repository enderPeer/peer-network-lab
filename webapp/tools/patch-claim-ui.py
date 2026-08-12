# THE CLAIM PATH: binding an address, seeing what an epoch owes you, taking it.
#
# Everything about epoch earnings existed except the part a person could use.
# The host builds the tree (chain/earnings.mjs), serves a claimant's amount and
# proof (GET /api/v1/epoch/:n/claim), and accepts a 'bindAddress' act; PeerClaim
# is deployed-ready and tested. None of it was reachable from the interface, so
# the only people who could ever be paid were the ones who read the source.
#
# What this adds is one card under the Wallet view, and the hard part of it is
# not the transaction. It is saying four different things without letting any
# of them be mistaken for another:
#
#   1. "the log says you earned this"       — arithmetic over a public record
#   2. "an address is bound to this handle" — who the tree will pay
#   3. "somebody funded this epoch on Base" — money exists behind the number
#   4. "you can take it now"                — and only then is there a button
#
# An interface that blurs 1 into 4 is telling people they are owed money by
# somebody who never agreed to pay them. PEER has NO MINT: the supply is fixed
# and every claim is a transfer out of holdings the operator already has, made
# only if the operator chooses to open and fund that epoch. In the shipped
# configuration PEER_CLAIM_ADDR is unset, so the honest answer for every epoch
# today is "nothing has been deposited" — and this card says exactly that,
# rather than rendering a dead Claim button or implying a debt.
#
# The other thing it must say early rather than late: an UNBOUND handle has no
# leaf in the tree at all. Not a leaf worth zero — no leaf. That share stays
# with whoever funded the epoch and returns to them at the sweep. Binding after
# the close cannot recover it, because a published root cannot be recomputed.
# So the warning sits at the top of the binding section, where somebody meets
# it before the epoch closes, not in a row explaining what they already lost.
#
# On the transaction itself: checkClaim is a free eth_call that folds in every
# check claim() makes, so it is asked BEFORE the wallet is opened and a doomed
# claim never costs gas. When it says no, this card reads epochInfo and the
# claimed flag to say WHICH check failed, because "it would fail" is not an
# answer anybody can act on. The proof array is taken verbatim from the
# endpoint — the encoding is position-dependent and re-deriving it in a browser
# would be a second implementation to keep in step — and the one structural
# rule that can be checked without the tree (bits above the sibling count in
# the path word are meaningless and PeerClaim rejects them) is checked here,
# for free, before anything is sent.
#
# Run:  python tools/patch-claim-ui.py && node social/assemble.mjs
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


# ── 1. two more slots beside the wallet state they belong to ──────────────
# l2Redraw is ONE slot and the token card takes it. There are two cards in the
# Wallet view now, so the claim card gets its own rather than fighting for
# that one — whichever card the reader is looking at, a wallet that switches
# account or network must reach both, or one of them keeps printing an
# address the wallet has moved on from.
once(
    """  var l2Bal = null;
  var alertView = 'inbound'; // | 'record'
""",
    """  var l2Bal = null;
  // The claim card's own redraw hook. l2Redraw is the token card's, and the
  // two cards sit in the SAME view — one slot between them means the second
  // one to render silently takes the wallet's events away from the first.
  var l2ClaimRedraw = null;
  // One epoch's answer from GET /api/v1/epoch/N/claim, keyed by handle and
  // epoch, so re-rendering this tab (which a poll can do at any moment) does
  // not re-ask the host — and, where a claim contract IS configured, does not
  // turn one open tab into a chain read per epoch every few seconds. Cache,
  // never a source of truth: every row prints the clock time it was read at
  // and carries a button to read it again.
  var l2Claims = {};
  // Whether one address has already claimed one epoch, read off the contract
  // through the reader's own wallet: 'epoch|address' -> true/false. Kept apart
  // from the host's answer above because it is a different source — the
  // contract's own public mapping, which is the thing that actually decides.
  var l2Claimed = {};
  var alertView = 'inbound'; // | 'record'
""",
    'module slots for the claim card: its redraw hook and its two caches',
)

once(
    """      if (l2Redraw) l2Redraw();
    };
    window.ethereum.on('chainChanged', function () { forget('The wallet changed network.""",
    """      if (l2Redraw) l2Redraw();
      // Both cards, always. A claim row shows an address, an amount and a
      // Claim button that are only true of one account on one chain.
      if (l2ClaimRedraw) l2ClaimRedraw();
    };
    window.ethereum.on('chainChanged', function () { forget('The wallet changed network.""",
    'the wallet watcher reaches the claim card too',
)

# ── 2. the words, in the dictionary that already exists ───────────────────
# Two rules, both from the header above TERMS and both binding: the one-liner
# must be answerable WITHOUT knowing another term, and `sect` must name a
# section that actually exists in guideTab. The section these seven point at
# is added in the next hunk — the guide had nothing at all about binding or
# claiming, and pointing all seven at 'Glossary' would have been a dodge.
once(
    """    append: {
      t: 'append order',
      one: 'The log exactly as written, newest first — the authoritative order.',
      more: 'Every other order on this list is a view ON this one. Nothing is hidden by ranking: what changes is the sequence, never the set.',
      sect: 'The left rail: search, order, filters',
    },
  };
""",
    """    append: {
      t: 'append order',
      one: 'The log exactly as written, newest first — the authoritative order.',
      more: 'Every other order on this list is a view ON this one. Nothing is hidden by ranking: what changes is the sequence, never the set.',
      sect: 'The left rail: search, order, filters',
    },
    earnings: {
      t: 'epoch earnings',
      one: 'What an epoch credited you for other people engaging with what you made.',
      more: 'It is a number computed from the public log, and that is all it is until somebody funds it. The PEER token on Base has no mint: paying an epoch means the operator transferring coins they already hold, which they may simply never do. Nothing here is a debt anybody owes you.',
      sect: 'Epoch earnings: binding an address and claiming on Base',
    },
    merkle: {
      t: 'merkle root',
      one: 'One short fingerprint of a whole payout list: change any line and the fingerprint changes.',
      more: 'It is what gets published on the chain — 32 bytes instead of thousands of lines — so a contract can check that your line was in the list without ever holding the list. Published once per epoch and never editable afterwards, which is exactly why a binding made today cannot reach an epoch that closed yesterday.',
      sect: 'Epoch earnings: binding an address and claiming on Base',
    },
    proof: {
      t: 'proof',
      one: 'The handful of hashes that show your line was in the published list.',
      more: 'Walk them from your line upward and you arrive at the published fingerprint, or you do not. It is checked against the address that sends the transaction, so a proof is worth nothing to anybody else — nobody can claim your share with it, including you from another wallet.',
      sect: 'Epoch earnings: binding an address and claiming on Base',
    },
    binding: {
      t: 'binding an address',
      one: 'Telling the network which ethereum address this handle is paid at.',
      more: 'Whoever holds that address collects, so it is guarded like a password change. It applies forward only — the payout list for an epoch that has already closed is fixed — and nothing here can detect a typo, so paste it from a wallet and never type it.',
      sect: 'Epoch earnings: binding an address and claiming on Base',
    },
    steward: {
      t: 'steward',
      one: 'The one account that can put money behind an epoch, and take back what nobody collected.',
      more: 'It cannot create coins (there is no mint), cannot edit a payout list it has already published, and cannot take back a payment already made. What it CAN do that costs people: publish a list adding up to more than it deposited, which pays whoever claims first and fails for everyone after — so the amounts are all published, and this app compares them for you.',
      sect: 'Epoch earnings: binding an address and claiming on Base',
    },
    deadline: {
      t: 'claim deadline',
      one: 'The moment after which an epoch stops paying and cannot be reopened.',
      more: 'It is set when the epoch is funded and it is on the chain\\u2019s clock, not this computer\\u2019s. Miss it and the money is not held for you: it goes back to whoever put it there.',
      sect: 'Epoch earnings: binding an address and claiming on Base',
    },
    sweep: {
      t: 'sweep',
      one: 'Taking back whatever nobody collected once the deadline has passed.',
      more: 'It returns to whoever funded the epoch. A handle with no address bound when the epoch closed was never in the payout list at all, so its whole share leaves this way \\u2014 which is the one loss here that binding early prevents and nothing else does.',
      sect: 'Epoch earnings: binding an address and claiming on Base',
    },
  };
""",
    'seven terms: earnings, merkle, proof, binding, steward, deadline, sweep',
)

# ── 3. the section those seven point at ───────────────────────────────────
# Placed straight after the epoch section, because closing an epoch is what
# creates the thing this one is about.
once(
    """      sect('The economy: Layer 0 (Peer Attestation)', false,
""",
    """      sect('Epoch earnings: binding an address and claiming on Base', false,
        P('Closing an epoch mints ', B('PEER'), ' in this log and credits it to creators by the engagement their work drew. That is a number in a public record: anyone replaying the log computes the same one, and it is true whatever any chain says. Everything below is about the separate question of whether that number ever becomes money.'),
        P(B('There is no mint. '), 'The PEER token on Base has a fixed supply, and this app cannot add to it. Paying an epoch means the operator transferring coins they already hold into a claim contract and opening that epoch against a published payout list. They may never do it. An epoch balance is therefore ', B('not'), ' a debt anybody owes you, and this app will not print it as one — where no claim contract is configured, the card says so in those words.'),
        P(B('Bind an address before the epoch closes, not after. '), 'The payout list is built from the bindings as they stood ', B('at that close'), ', and only handles with an address in it get a line. A handle with none has no line at all — not a line worth zero — and its share returns to whoever funded the epoch at the ', K('sweep'), '. Binding is free, costs no θ, and applies to future epochs only, because a published list cannot be recomputed.'),
        P(B('Whoever holds the address collects. '), 'A binding is as strong as your PIN, and the app asks for it. Nothing here can tell whether an address is yours or whether it has a typo in it — the checksum a wallet prints is keccak-based and this codebase deliberately carries no keccak — so the address is taken from the connected wallet and read back to you in full before anything is recorded.'),
        P(B('Claiming is one transaction, signed by you. '), 'The app asks the contract first, for free, whether the claim would be paid, and refuses with the contract’s own answer rather than letting a doomed claim cost gas. The proof is checked against the address that sends it, so nobody can claim your share and you cannot claim it from a second wallet. ', jump('open the wallet', 'econ/wallet'))),

      sect('The economy: Layer 0 (Peer Attestation)', false,
""",
    'the guide section the seven terms name',
)

# ── 4. the card ───────────────────────────────────────────────────────────
once(
    """  function econTab(st) {
    var l0 = st.l0;
""",
    """  /**
   * Epoch earnings: binding an address, what an epoch owes, and claiming it.
   *
   * Three sources feed this card and they are never blended, because the whole
   * value of the card is in keeping them apart:
   *
   *   THIS LOG (st)  — which epochs credited this handle and which address is
   *                    bound to it. Local, instant, replayable by anyone.
   *   THIS HOST      — GET /api/v1/epoch/N/claim: the earnings tree for one
   *                    epoch, the amount in raw units, the proof PeerClaim
   *                    takes, and what the host can see of that epoch on the
   *                    chain. The proof is used exactly as it arrives; the
   *                    encoding is position-dependent and a second derivation
   *                    in the browser would be a second thing to keep in step.
   *   THE CHAIN      — read through the reader's OWN wallet: whether this
   *                    address has already claimed, the free dry run before a
   *                    signature, and the receipt afterwards.
   *
   * The sentence this card exists to avoid is "you are owed 4,000 PEER" said
   * about an epoch nobody has funded. PEER has no mint: every claim is a
   * transfer out of holdings the operator already has, made only if they
   * choose to open and fund that epoch, and where no claim contract is
   * configured at all the honest answer is that these earnings are a number in
   * a log and nothing else. So "the log credited you", "somebody deposited
   * money behind it" and "you can take it now" are three separate statements
   * here, in that order, and the button only ever appears under the third.
   */
  function l2ClaimCard(st) {
    var card = h('div', { class: 'card', style: 'margin-top:14px' },
      h('h2', {}, term('earnings', 'Epoch earnings'), ' \\u2014 getting paid on Base'));
    var body = h('div', {});
    card.appendChild(body);

    var me = who;
    if (!me) {
      body.appendChild(h('p', { class: 'smallnote', text: 'Nobody is signed in here, so there is no handle to bind an address to and nothing to claim.' }));
      return card;
    }

    // PeerClaim's selectors, each beside the signature it hashes from — the
    // same policy as the pools card and chain-l2/onchain.mjs: no keccak in
    // this page. Recompute any of them with `cast sig '<signature>'`.
    var CL_SEL = {
      claim: '0xae0b51df',        // claim(uint256,uint256,bytes32[])
      checkClaim: '0x65574c78',   // checkClaim(uint256,address,uint256,bytes32[])
      claimed: '0x120aa877',      // claimed(uint256,address)
      epochInfo: '0x3894228e'     // epochInfo(uint256)
    };
    var WARN = 'border-left:2px solid var(--ember); padding-left:9px';
    var ROWS = 6;   // most recent epochs asked about per render

    function note(t, style) { return h('p', { class: 'smallnote', style: style || '', text: t }); }
    /** A uint as a 32-byte argument word. */
    function w256(v) { return BigInt(v).toString(16).padStart(64, '0'); }
    /** A bytes32 as it arrives from the host (0x-prefixed) as an argument word. */
    function w32(x) { return String(x).replace(/^0x/, '').toLowerCase().padStart(64, '0'); }
    /** A chain deadline in words. The clock is named, because it is not the
     *  chain's — a browser an hour out would otherwise state a deadline as
     *  fact that the contract disagrees with. */
    function when(sec) {
      var v = Number(sec);
      if (!isFinite(v) || v <= 0) return 'no deadline this host could read';
      var days = Math.round((v * 1000 - Date.now()) / 86400000);
      return new Date(v * 1000).toLocaleString() + ' \\u2014 '
        + (days >= 0 ? 'about ' + days + ' day(s) from now' : Math.abs(days) + ' day(s) ago')
        + ', by this computer\\u2019s clock';
    }

    // ── first, the thing that is true of every row below ──
    body.appendChild(note('Epoch earnings are paid OUT OF THE OPERATOR\\u2019S OWN HOLDINGS. The PEER token on Base has no mint \\u2014 its supply is fixed and nothing in this app can add to it \\u2014 so an epoch is paid only if the operator deposits coins they already hold against it. Everything below says which of those two things has happened.'));

    // What the chain block is anchored to, once any epoch answer has named it.
    // Never a constant in this file: a different operator runs a different
    // contract on a different chain.
    var claimAddr = null, chainHex = null, chainName = null;
    var rowPaints = [];       // every row's repaint, so a wallet change reaches all of them
    var wRow = h('div', { class: 'mini-form persistent' });

    function redrawAll() {
      drawWallet();
      drawBind();
      for (var i = 0; i < rowPaints.length; i++) { try { rowPaints[i](); } catch (e) {} }
    }

    // ── 1. binding ────────────────────────────────────────────────────────
    var bindBox = h('div', {});
    body.appendChild(bindBox);

    function drawBind() {
      bindBox.innerHTML = '';
      var bound = (st.addresses || {})[me] || '';
      bindBox.appendChild(h('p', { class: 'eyebrow', style: 'margin:16px 0 4px' },
        term('binding', 'where this handle is paid')));
      if (bound) {
        bindBox.appendChild(h('div', { class: 'kv' },
          h('span', { text: 'bound to' }),
          h('b', { class: 'num', style: 'word-break:break-all', text: bound })));
        bindBox.appendChild(note('Whoever holds that address collects this handle\\u2019s earnings from the epochs that close from now on. It is public: the binding is an act in this log like everything else.'));
      } else {
        // The loudest sentence on the card, and it is here rather than in a
        // row because a row is read after the epoch closed, which is too late
        // for it to be worth anything.
        bindBox.appendChild(h('p', { class: 'smallnote', style: WARN },
          'No address is bound to this handle. An epoch\\u2019s payout list is built from the bindings as they stood AT ITS CLOSE, and a handle with no address gets no line in it at all \\u2014 not a line worth zero, no line. That share is not held for you: it stays with whoever funded the epoch and returns to them at the ',
          term('sweep', 'sweep'),
          '. Bind an address before the next close, or this repeats.'));
      }

      var row = h('div', { class: 'mini-form persistent' });
      bindBox.appendChild(row);
      if (!window.ethereum) {
        row.appendChild(h('span', { class: 'smallnote', text: 'There is no wallet in this browser to take an address from. Open this app in a browser with one \\u2014 the address is never typed here, because a typo in an address cannot be detected and would send these earnings somewhere nobody can reach.' }));
        return;
      }
      if (!l2Wallet) {
        row.appendChild(h('button', { class: 'btn small', text: 'Connect a wallet', onclick: function () {
          // The chain to connect to is the one the host names for its claim
          // contract, and only once an epoch answer has named it. Before
          // that, Base is the default this page has always used — connecting
          // reads an address and signs nothing either way.
          l2Connect(chainHex, chainName).then(function (a) { if (a) redrawAll(); })
            .catch(function (e) { toast('Connect failed: ' + l2Err(e)); });
        } }));
        row.appendChild(h('span', { class: 'smallnote', text: 'Connecting shows an address. It signs nothing, records nothing, and this page never sees a key.' }));
        return;
      }
      row.appendChild(h('span', { class: 'smallnote num', style: 'word-break:break-all', text: 'wallet ' + l2Wallet }));
      if (l2Wallet === String(bound).toLowerCase()) {
        row.appendChild(h('span', { class: 'smallnote', text: '\\u2014 which is the address already bound. Nothing to change.' }));
        return;
      }
      row.appendChild(h('button', { class: 'btn small', text: bound ? 'Bind this wallet instead' : 'Bind this wallet', onclick: function () { confirmBind(l2Wallet, bound); } }));
    }

    /**
     * Read the address back, in full, before it is recorded.
     *
     * Not a confirm() and not a short form of the address: this is the one
     * screen where somebody should compare 40 characters against their wallet,
     * and a truncated address is precisely how a wrong one gets past a person
     * who was looking straight at it.
     */
    function confirmBind(addr, bound) {
      // One confirmation at a time. Pressed twice, the old shape stacked two
      // identical blocks and the reader confirmed the one they were not
      // looking at.
      var open = bindBox.querySelector('[data-confirm]');
      if (open) open.remove();
      var box = h('div', { style: 'margin-top:10px', 'data-confirm': '1' });
      bindBox.appendChild(box);
      box.appendChild(h('p', { class: 'eyebrow', style: 'margin:6px 0 4px', text: 'bind this handle\\u2019s earnings to' }));
      box.appendChild(h('p', { class: 'num', style: 'word-break:break-all; margin:0 0 6px', text: addr }));
      box.appendChild(note('Read it against the wallet before pressing. Nothing here can check it: an address is 20 bytes and any 20 bytes are a valid one, and the checksum a wallet shows is keccak-based while this codebase carries no keccak on purpose. A wrong address is earnings paid to somebody else, or to nobody, permanently.'));
      box.appendChild(note('Whoever holds this address can claim this handle\\u2019s earnings from now on. That is the whole security of it \\u2014 there is no second check and no way to reverse a payment.', WARN));
      box.appendChild(h('p', { class: 'smallnote' },
        'It applies to FUTURE epochs only. Epochs that have already closed have their payout lists published, and a published ',
        term('merkle', 'root'),
        ' cannot be recomputed \\u2014 so this changes nothing about what they pay, including epochs where this handle was unbound and therefore has no line at all.'));
      if (bound) box.appendChild(note('This replaces ' + bound + ' from the next close onward. Anything already claimable at that address stays claimable there.'));
      var go = h('div', { class: 'mini-form persistent' });
      box.appendChild(go);
      go.appendChild(h('button', { class: 'btn small primary', text: 'Bind ' + addr.slice(0, 10) + '\\u2026' + addr.slice(-6), onclick: function () { submitBind(addr); } }));
      go.appendChild(h('button', { class: 'btn small ghost', text: 'Cancel', onclick: function () { box.remove(); } }));
    }

    function submitBind(addr) {
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

    // ── 2. the wallet, once for the whole card ────────────────────────────
    body.appendChild(wRow);

    function drawWallet() {
      wRow.innerHTML = '';
      if (!claimAddr) return;      // nothing on a chain to talk to yet
      if (!window.ethereum) {
        wRow.appendChild(h('span', { class: 'smallnote', text: 'No wallet in this browser, so nothing below can be checked against the chain or claimed. The amounts are still what this host computes from the log.' }));
        return;
      }
      if (!chainHex) {
        wRow.appendChild(h('span', { class: 'smallnote', text: 'This host named no chain id for its claim contract, so this page cannot tell a wallet which network to ask \\u2014 and a read on the wrong one would be about a different contract. Nothing here is read through a wallet until it does.' }));
        return;
      }
      if (!l2Wallet) {
        wRow.appendChild(h('button', { class: 'btn small', text: 'Connect wallet', onclick: function () {
          l2Connect(chainHex, chainName).then(function (a) { if (a) redrawAll(); })
            .catch(function (e) { toast('Connect failed: ' + l2Err(e)); });
        } }));
        wRow.appendChild(h('span', { class: 'smallnote', text: 'Connecting lets this card ask the contract whether these epochs have already been claimed. It signs nothing until you press a Claim button.' }));
        return;
      }
      wRow.appendChild(h('span', { class: 'smallnote num', style: 'word-break:break-all', text: l2Wallet + ' \\u00b7 ' + chainName }));
      wRow.appendChild(h('span', { class: 'smallnote', text: 'claiming at ' + claimAddr }));
    }

    // ── 3. one row per epoch this handle earned in ────────────────────────
    var epochBox = h('div', {});
    body.appendChild(epochBox);
    drawBind();
    drawEpochs();

    function drawEpochs() {
      epochBox.innerHTML = '';
      epochBox.appendChild(h('p', { class: 'eyebrow', style: 'margin:18px 0 4px', text: 'what each closed epoch credited you' }));
      var dist = (st.tokens && st.tokens.dist) || [];
      var mine = [];
      for (var i = dist.length - 1; i >= 0; i--) {
        var d = dist[i];
        if (d && d.to && d.to[me] > 0) mine.push(d);
      }
      if (!mine.length) {
        epochBox.appendChild(note('No closed epoch has credited this handle yet. Earnings come from other people reacting to and commenting on what you made, shared out when an epoch closes \\u2014 so there is nothing here to bind for yet, and binding early is what makes sure the first one has a line to pay.'));
        return;
      }
      var shown = mine.slice(0, ROWS);
      if (mine.length > shown.length) {
        epochBox.appendChild(note('The ' + shown.length + ' most recent of ' + mine.length + ' epochs that credited this handle. The older ones are unchanged and still claimable if they were ever funded; this card asks about a few at a time so that opening it is not a chain read per epoch.'));
      }
      for (var k = 0; k < shown.length; k++) epochBox.appendChild(epochRow(shown[k]));
    }

    function epochRow(dist) {
      var n = dist.epoch;
      var logAmt = Math.round((dist.to[me] || 0) * 1e6) / 1e6;
      var box = h('div', { style: 'margin-top:12px; border-top:1px solid var(--line); padding-top:10px' });
      box.appendChild(h('div', { class: 'kv' },
        h('span', { text: 'epoch ' + n }),
        h('b', { class: 'num', text: logAmt + ' PEER credited to this handle in the log' })));
      var stateBox = h('div', {});
      var actBox = h('div', {});
      var sayBox = h('div', {});
      box.appendChild(stateBox);
      box.appendChild(actBox);
      box.appendChild(sayBox);
      var key = me + '|' + n;

      function say(t, warn) {
        sayBox.appendChild(h('p', { class: 'smallnote', style: warn ? WARN : '', text: t }));
      }
      function only(t, style) { stateBox.innerHTML = ''; actBox.innerHTML = ''; stateBox.appendChild(note(t, style)); }

      function stamp(at) {
        var line = h('div', { class: 'mini-form persistent' },
          h('span', { class: 'smallnote', text: 'read from this host at ' + new Date(at).toLocaleTimeString() }),
          h('button', { class: 'btn small ghost', text: 'Check again', onclick: function () { load(true); } }));
        stateBox.appendChild(line);
      }

      /** Everything about epoch `n`, painted from one host answer. */
      function paint(d, at) {
        stateBox.innerHTML = '';
        actBox.innerHTML = '';
        var oc = d.onchain || {};
        var dec = Number(d.decimals);
        var cl = d.claimant;

        // (a) is there a line in the payout list, and what does it pay?
        if (cl) {
          stateBox.appendChild(h('div', { class: 'kv' },
            h('span', {}, 'its ', term('merkle', 'payout list'), ' pays'),
            h('b', { class: 'num', text: l2Human(BigInt(cl.amount), dec) + ' PEER' }),
            h('span', { text: 'to' }),
            h('b', { class: 'num', style: 'word-break:break-all', text: cl.address })));
          if (cl.handles && cl.handles.length > 1) {
            stateBox.appendChild(note('That line is shared: ' + cl.handles.length + ' handles had this same address bound when the epoch closed, so the amount above is their combined share and whoever holds the address collects all of it at once.'));
          }
        } else {
          stateBox.appendChild(note(d.claimantNote || 'This handle has no line in this epoch\\u2019s payout list.', WARN));
        }

        // (b) has anybody put money behind it? Four different answers, and
        //     blurring them is exactly how "nothing was deposited" gets read
        //     as "you will be paid".
        if (oc.configured === false) {
          stateBox.appendChild(note('The operator of this host has not deployed a claim contract \\u2014 PEER_CLAIM_ADDR is unset. These earnings therefore exist only as a number in this log: there is nothing on any chain to claim, nothing has been deposited, and no deadline is running. That may never change; nothing in this app can make it.', WARN));
          stamp(at);
          return;
        }
        if (!claimAddr && oc.contract) {
          claimAddr = String(oc.contract);
          chainHex = l2ChainHex(oc.chainId);
          chainName = l2ChainName(oc.chainId);
          drawWallet();
        }
        if (oc.error) { stateBox.appendChild(note(oc.error, WARN)); stamp(at); return; }
        if (!oc.opened) {
          stateBox.appendChild(note('Nobody has opened epoch ' + n + ' on the claim contract at ' + (oc.contract || 'the configured address') + '. NOTHING HAS BEEN DEPOSITED for it. This is not \\u201cyou will be paid later\\u201d \\u2014 it is \\u201cno money has been put behind this\\u201d, and opening an epoch is the operator\\u2019s own transaction out of coins they already hold. ' + (oc.why || ''), WARN));
          stamp(at);
          return;
        }
        if (oc.rootMatches === false) {
          stateBox.appendChild(note(oc.rootMismatch || 'The payout list published on chain for this epoch is NOT the one this host computes from its log. Nothing here is claimable against it.', WARN));
          stamp(at);
          return;
        }

        var total = BigInt(oc.totalRaw || '0');
        var paid = BigInt(oc.paidRaw || '0');
        var tree = BigInt(d.total || '0');
        var kv = h('div', { class: 'kv' },
          h('span', {}, 'the ', term('steward', 'operator'), ' deposited'),
          h('b', { class: 'num', text: l2Human(total, dec) + ' PEER' }),
          h('span', { text: 'claimed so far' }),
          h('b', { class: 'num', text: l2Human(paid, dec) + ' PEER' }),
          h('span', {}, term('deadline', 'claim deadline')),
          h('b', { text: when(oc.claimUntil) }));
        stateBox.appendChild(kv);
        // The check no contract can make, made here, before anybody spends
        // gas: nothing on chain holds the payout list, so a list adding up to
        // more than the deposit pays first-come and reverts for the rest.
        if (tree > total) {
          stateBox.appendChild(note('This epoch\\u2019s payout list adds up to ' + l2Human(tree, dec) + ' PEER but only ' + l2Human(total, dec) + ' was deposited. No contract can add a list up, so this epoch pays whoever claims first and reverts for everyone after. Read that as a warning about the epoch, not about your line.', WARN));
        }
        if (!oc.open) {
          stateBox.appendChild(h('p', { class: 'smallnote', style: WARN },
            'This epoch is not open to claims: the window ran to ' + when(oc.claimUntil) + ', or the remainder has already been ',
            term('sweep', 'swept'),
            '. A claim now would revert and cost the gas, so there is no button.'));
          stamp(at);
          return;
        }
        if (!cl) { stamp(at); return; }

        // (c) can THIS reader take it?
        drawClaim(d, cl, oc, dec);
        stamp(at);
      }

      function drawClaim(d, cl, oc, dec) {
        actBox.innerHTML = '';
        var leafAddr = String(cl.address).toLowerCase();
        if (!window.ethereum) {
          actBox.appendChild(note('There is no wallet in this browser to claim with. This line is payable to ' + leafAddr + ' and to no other address \\u2014 open that account in a browser with a wallet.'));
          return;
        }
        if (!chainHex) {
          actBox.appendChild(note('This host named no chain id for its claim contract, so nothing here will be signed \\u2014 a claim sent on the wrong chain reaches no contract and costs the gas anyway.', WARN));
          return;
        }
        if (!l2Wallet) {
          actBox.appendChild(note('Connect a wallet above to check whether this has already been claimed, and to claim it. It is payable to ' + leafAddr + ' and to no other address.'));
          return;
        }
        if (l2Wallet !== leafAddr) {
          actBox.appendChild(note('The connected wallet is ' + l2Wallet + '. This line pays ' + leafAddr + ', and the contract checks the proof against whoever sends the transaction \\u2014 so nobody can claim it for you, including you from a second wallet. Switch the wallet to that account.', WARN));
          return;
        }
        var flag = l2Claimed[n + '|' + leafAddr];
        if (flag === true) {
          actBox.appendChild(note('This address has already claimed epoch ' + n + '. The contract\\u2019s own record says so; there is nothing further to take.'));
          return;
        }
        var btn = h('button', { class: 'btn small primary', text: 'Claim ' + l2Human(BigInt(cl.amount), dec) + ' PEER' });
        btn.onclick = function () {
          btn.disabled = true;
          sayBox.innerHTML = '';
          doClaim(d, cl, oc).catch(function (e) {
            say('Stopped: ' + l2Err(e), true);
          }).then(function () { btn.disabled = false; });
        };
        actBox.appendChild(h('div', { class: 'mini-form persistent' }, btn,
          h('span', { class: 'smallnote' }, 'The contract is asked first, for free, whether this would be paid \\u2014 a refused ',
            term('proof', 'proof'), ' costs nothing this way, and gas is only ever spent on a claim that is going to work.')));
        if (flag === undefined) readClaimed(leafAddr);
      }

      /** The contract's own claimed mapping — the same flag claim() checks. */
      function readClaimed(addr) {
        if (!claimAddr || !window.ethereum || !l2Wallet) return;
        l2Eth('eth_call', [{ to: claimAddr, data: CL_SEL.claimed + w256(n) + l2Addr(addr) }, 'latest'])
          .then(function (r) {
            var v = l2Uint(r, 'the claimed flag for epoch ' + n);
            l2Claimed[n + '|' + addr] = v === 1n;
            var c = l2Claims[key];
            if (c) paint(c.d, c.at);
          })
          .catch(function () { /* the dry run below asks the same question anyway */ });
      }

      /**
       * Claim, with the free question asked before the expensive one.
       *
       * checkClaim folds in every check claim() makes, so a claim that would
       * revert is refused here at the cost of one eth_call — and when it does
       * refuse, epochInfo and the claimed flag are read to say WHICH check
       * failed, because "it would fail" is not something anybody can act on.
       */
      async function doClaim(d, cl, oc) {
        var to = String(oc.contract);
        var acct = l2Wallet || await l2Connect(chainHex, chainName);
        if (!acct) return;
        // Asked again at the last moment. l2Wallet outlives the check made at
        // connect time on purpose, so between connecting and pressing, the
        // wallet may have moved account or network without this page hearing.
        var accs = await l2Eth('eth_accounts');
        var cur = accs && accs[0] ? String(accs[0]).toLowerCase() : '';
        if (!cur) { say('The wallet is not connected any more \\u2014 nothing was sent.', true); return; }
        if (cur !== String(cl.address).toLowerCase()) {
          l2Wallet = cur;
          redrawAll();
          say('The wallet is on ' + cur + ' now, and this line pays ' + cl.address + '. Nothing was sent: the proof is checked against whoever sends the transaction.', true);
          return;
        }
        var chain = await l2Eth('eth_chainId');
        if (!l2OnChain(chain, chainHex)) {
          l2Wallet = null;
          redrawAll();
          say('That wallet answers for chain ' + chain + ', not ' + chainName + '. Nothing was sent \\u2014 a claim signed on the wrong chain reaches no contract and costs the gas anyway.', true);
          return;
        }

        // The proof, exactly as the endpoint supplies it. Checked for shape
        // only: 32-byte words, and the one structural rule of this encoding —
        // proof[0] is a PATH WORD whose bits index the siblings after it, so
        // bits above that count carry no meaning and PeerClaim refuses them.
        var words = cl.proof;
        if (!Array.isArray(words) || !words.length) { say('This host sent no proof for this line, so there is nothing to send.', true); return; }
        for (var i = 0; i < words.length; i++) {
          if (!/^(0x)?[0-9a-fA-F]{64}$/.test(String(words[i]))) {
            say('Word ' + i + ' of this proof is not 32 bytes, so nothing was sent \\u2014 this host answered something no contract could read.', true);
            return;
          }
        }
        if ((BigInt('0x' + w32(words[0])) >> BigInt(words.length - 1)) !== 0n) {
          say('The path word of this proof has bits set above its sibling count, which PeerClaim rejects outright. Nothing was sent.', true);
          return;
        }

        var amt = BigInt(cl.amount);
        say('Asking the contract whether this claim would be paid. This is a free read \\u2014 no signature, no gas.');
        var dry = CL_SEL.checkClaim + w256(n) + l2Addr(cur) + w256(amt)
          + w256(128) + w256(words.length) + words.map(w32).join('');
        var okWord;
        try {
          okWord = l2Uint(await l2Eth('eth_call', [{ to: to, data: dry }, 'latest']), 'the dry run of this claim');
        } catch (e) {
          say('The dry run could not be read (' + l2Err(e) + '), so nothing was signed. A claim is not sent on a question this page could not ask.', true);
          return;
        }
        if (okWord !== 1n) {
          say('The contract says this claim would NOT be paid. Nothing was signed and no gas was spent. ' + (await whyNot(d, cl, to, cur)), true);
          load(true);
          return;
        }

        say('Approve it in the wallet. This is the only step that costs gas, and it is the only thing this page ever asks you to sign.');
        var data = CL_SEL.claim + w256(n) + w256(amt)
          + w256(96) + w256(words.length) + words.map(w32).join('');
        var tx = await l2Eth('eth_sendTransaction', [{ from: cur, to: to, data: data, chainId: chainHex }]);
        say('Sent. Transaction ' + tx + ' \\u2014 waiting for a block to carry it. Nothing has been claimed until one does; do not send it again.');
        if (Number(oc.chainId) === 8453) {
          sayBox.appendChild(h('p', { class: 'smallnote' },
            h('a', { target: '_blank', rel: 'noopener', href: 'https://basescan.org/tx/' + tx, text: 'follow it on basescan' })));
        }
        var rc = null;
        for (var k = 0; k < 90 && !rc; k++) {
          await new Promise(function (r) { setTimeout(r, 2000); });
          // A provider that throws mid-poll throws out of here, which is the
          // truth: the transaction went out and this page stopped watching.
          rc = await l2Eth('eth_getTransactionReceipt', [tx]);
        }
        if (!rc) {
          say('Not mined after three minutes. It may still be waiting in the mempool \\u2014 follow the hash above rather than sending it a second time.', true);
        } else if (rc.status !== '0x1') {
          say('It reverted on chain. No PEER moved; the gas did not come back. The state below is re-read from the chain rather than assumed.', true);
        } else {
          say('Claimed. The PEER is in ' + cur + ' now \\u2014 if the wallet does not list it, add the token from the card above; a wallet does not show a token it has never been told about.');
        }
        delete l2Claimed[n + '|' + cur];
        load(true);
      }

      /** Which check failed, in the contract's own terms. */
      async function whyNot(d, cl, to, cur) {
        var reasons = [];
        try {
          var got = String(await l2Eth('eth_call', [{ to: to, data: CL_SEL.epochInfo + w256(n) }, 'latest']) || '').replace(/^0x/, '');
          if (got.length >= 320) {
            var root = got.slice(0, 64);
            var total = BigInt('0x' + got.slice(64, 128));
            var paid = BigInt('0x' + got.slice(128, 192));
            var until = Number(BigInt('0x' + got.slice(192, 256)));
            var open = BigInt('0x' + got.slice(256, 320)) === 1n;
            if (/^0+$/.test(root)) {
              reasons.push('this epoch is not open on that contract at all');
            } else {
              if (root !== String(d.root).toLowerCase()) reasons.push('the payout list published on chain is not the one this host computes, so no proof from here folds to it');
              if (!open) reasons.push('the epoch is closed to claims \\u2014 its window ran to ' + when(until));
              if (total - paid < BigInt(cl.amount)) reasons.push('what is left of the deposit is ' + l2Human(total - paid, Number(d.decimals)) + ' PEER, less than this line, so the list was funded for less than it promises');
            }
          }
        } catch (e) { /* the claimed read below may still explain it */ }
        try {
          var c = l2Uint(await l2Eth('eth_call', [{ to: to, data: CL_SEL.claimed + w256(n) + l2Addr(cur) }, 'latest']), 'the claimed flag');
          if (c === 1n) {
            l2Claimed[n + '|' + cur] = true;
            reasons.unshift('this address has already claimed this epoch');
          }
        } catch (e) { /* below */ }
        return reasons.length
          ? 'Why: ' + reasons.join('; ') + '.'
          : 'It did not say which check failed. The address, the amount or the proof is not what the published list commits to.';
      }

      function load(force) {
        var c = l2Claims[key];
        if (!force && c && Date.now() - c.at < 60000) { paint(c.d, c.at); return; }
        only('Asking this host what epoch ' + n + ' owes you\\u2026');
        fetch(API + '/api/v1/epoch/' + n + '/claim?as=' + encodeURIComponent(me), { cache: 'no-store' })
          .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
          .then(function (x) {
            if (x.status !== 200 || !x.d || !x.d.root) {
              only((x.d && x.d.error) || ('This host answered ' + x.status + ' for epoch ' + n + ', so nothing about it is shown here rather than guessed.'), WARN);
              return;
            }
            l2Claims[key] = { at: Date.now(), d: x.d };
            paint(x.d, l2Claims[key].at);
            // Claimed once this card is actually on screen, for the same
            // reason the token card claims its own slot late: a fetch landing
            // after the reader moved on must not take the hook from the card
            // they moved to.
            if (card.isConnected) l2ClaimRedraw = function () { redrawAll(); };
          })
          .catch(function () {
            only('Could not reach this host to ask about epoch ' + n + '. The ' + logAmt + ' PEER above is what this device\\u2019s copy of the log says; whether anything was ever deposited against it is a question only the host and the chain can answer.', WARN);
          });
      }

      rowPaints.push(function () {
        var c = l2Claims[key];
        if (c) paint(c.d, c.at);
      });
      load(false);
      return box;
    }

    return card;
  }

  function econTab(st) {
    var l0 = st.l0;
""",
    'the epoch-earnings claim card',
)

once(
    """      // Directly under the epoch token, because the two are only confusable
      // while they are apart.
      wrap.appendChild(l2TokenCard());
""",
    """      // Directly under the epoch token, because the two are only confusable
      // while they are apart.
      wrap.appendChild(l2TokenCard());
      // And under both: the epoch token is what an epoch credits, the coin on
      // Base is what a claim pays, and this is the only place the two ever
      // meet — the operator transferring the second against a list of the
      // first. It reads as nonsense anywhere else on the page.
      wrap.appendChild(l2ClaimCard(st));
""",
    'the claim card is mounted under the two token cards',
)

_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
