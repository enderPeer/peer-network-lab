# The epoch chain, said out loud — plus a link to the explorer everywhere an
# on-chain thing is named, and one honest card about the difference between
# this app's pools and a Uniswap pool.
#
# Three things this patch is careful about, because each of them is a lie the
# interface could tell for free:
#
#   1. WHAT AN ANCHOR PROVES. It proves a commitment existed at a time and was
#      never revised. It does not make the result true — truth here stays with
#      replay of the public act log, by anyone who disagrees. The view says
#      both, in that order, and never lets the second sentence go missing.
#   2. WHOSE ANCHOR IT IS. Anchors are keyed by (poster, epoch) and ANYONE may
#      post one. There is no official anchoring address anywhere in this
#      codebase, so no row here may be drawn as "the network's": every row
#      names its poster, and an epoch several addresses anchored shows all of
#      them rather than one this page picked.
#   3. WHICH CHAIN AN EXPLORER READS. basescan reads Base. Pointed at an
#      address from another chain it does not fail — it draws a confident page
#      about whatever lives at that address on Base — so a link to the wrong
#      explorer is worse than none, and links are built from a table keyed by
#      chain id with no entry meaning no link.
#
# The block ids and signatures are recomputed IN THE READER'S BROWSER from the
# bytes the host served, because a host reporting that its own chain verifies
# is a host marking its own work. Where the browser gives the page no
# cryptography (crypto.subtle exists only on a secure origin, and this app is
# served over plain http on a LAN routinely), the view says "not checked here"
# — never "verified", and never "failed", which are opposite claims.
#
# Run:  python tools/patch-chainview-links.py && node social/assemble.mjs
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


# ── 1. the explorer, beside the chain helpers it belongs with ─────────────
once(
    r"""  function l2ChainName(n) { return Number(n) === 8453 ? 'Base' : 'chain ' + Number(n); }""",
    r"""  function l2ChainName(n) { return Number(n) === 8453 ? 'Base' : 'chain ' + Number(n); }

  // ── the block explorer, and only for the chain it is the explorer FOR ──
  //
  // basescan reads Base. Pointed at an address from some other chain it does
  // not fail: it draws a confident page about whatever lives at that address
  // ON BASE, which is usually nothing and occasionally somebody else's
  // contract. So a link to the wrong explorer is worse than no link at all —
  // it looks like a check that passed. Links are built from this table by
  // chain id, and a chain with no entry in it gets none.
  var L2_EXPLORERS = {
    8453: { name: 'basescan', at: 'https://basescan.org' }
  };
  /**
   * The explorer URL for one on-chain thing, or null.
   *
   * `kind` is 'address' (a wallet or a contract), 'token' (the token's own
   * page, which lists holders and transfers) or 'tx' (one transaction). The
   * value is checked against the shape it must have before a link is built
   * from it: a truncated hash makes a URL that opens a page about nothing,
   * and a dead end on an explorer reads as a fact about the chain rather than
   * a mistake on this page.
   */
  function l2ScanURL(chainId, kind, value) {
    var ex = L2_EXPLORERS[Number(chainId)];
    if (!ex) return null;
    var v = String(value == null ? '' : value).trim();
    if (kind === 'tx') return /^0x[0-9a-fA-F]{64}$/.test(v) ? ex.at + '/tx/' + v : null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return null;
    return ex.at + '/' + (kind === 'token' ? 'token' : 'address') + '/' + v;
  }
  // The <a> itself, or null. Callers append it only where it exists, never a
  // greyed-out placeholder: "this chain has no explorer here" and "this link
  // goes nowhere" must not look the same.
  function l2ScanLink(chainId, kind, value, label) {
    var href = l2ScanURL(chainId, kind, value);
    if (!href) return null;
    var ex = L2_EXPLORERS[Number(chainId)];
    return h('a', { class: 'smallnote', target: '_blank', rel: 'noopener', href: href,
      text: label || ('on ' + ex.name) });
  }
  // 0x12345678…f0e1d2c3 — enough to tell two rows apart at a glance. The
  // full value is always printed or copyable on the row this labels; nothing
  // here is ever the only place a hash appears.
  function l2ShortHex(v) {
    var t = String(v == null ? '' : v);
    return t.length > 20 ? t.slice(0, 10) + '…' + t.slice(-8) : t;
  }""",
    'l2ScanURL / l2ScanLink / l2ShortHex — one explorer, keyed by chain id',
)

# ── 2. the sub-view exists and survives a reload ──────────────────────────
once(
    r"""      if (['wallet', 'net', 'pools', 'layer0', 'ledger'].indexOf(v0.econView) >= 0) econView = v0.econView;""",
    r"""      if (['wallet', 'net', 'pools', 'chain', 'layer0', 'ledger'].indexOf(v0.econView) >= 0) econView = v0.econView;""",
    'the restored sub-view list knows about the chain',
)

once(
    r"""    var views = [['wallet', 'Wallet'], ['net', 'Network'], ['pools', 'Pools & ads'], ['layer0', 'Layer 0'], ['ledger', 'Transactions']];""",
    r"""    var views = [['wallet', 'Wallet'], ['net', 'Network'], ['pools', 'Pools & ads'], ['chain', 'Epoch chain'], ['layer0', 'Layer 0'], ['ledger', 'Transactions']];""",
    'the sub-tab bar gains Epoch chain',
)

once(
    r"""    if (econView === 'layer0') {""",
    r"""    if (econView === 'chain') {
      wrap.appendChild(epochChainView());
    }

    if (econView === 'layer0') {""",
    'the chain view is mounted',
)

# ── 3. the view itself, and the checks that make it worth having ──────────
once(
    r"""  function econTab(st) {
    var l0 = st.l0;""",
    r"""  // ── checking an epoch block here, instead of taking the host's word ────
  //
  // These mirror chain/canonical.mjs and chain/keys.mjs exactly, and they have
  // to: a host reporting that its own chain verifies is a host marking its own
  // work. Keys sorted by UTF-16 code unit, numbers printed by Number::toString
  // (which is what JSON.stringify prints), non-finite numbers refused rather
  // than nulled — JSON.stringify would write `null` for both and two different
  // corruptions would then hash alike. If that file ever changes, this changes
  // with it; the symptom of forgetting is every id on this screen going red at
  // once, which is the right way round for a mistake like that to fail.
  function chainCanon(v) {
    if (v === null) return 'null';
    var t = typeof v, i;
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'number') {
      if (!isFinite(v)) throw new Error('canonical: non-finite number');
      return JSON.stringify(v);
    }
    if (t === 'string') return JSON.stringify(v);
    if (t !== 'object') throw new Error('canonical: cannot encode ' + t);
    if (Array.isArray(v)) {
      var items = [];
      for (i = 0; i < v.length; i++) items.push(chainCanon(v[i]));
      return '[' + items.join(',') + ']';
    }
    var keys = Object.keys(v).sort(), parts = [];
    for (i = 0; i < keys.length; i++) {
      if (v[keys[i]] === undefined) continue;
      parts.push(JSON.stringify(keys[i]) + ':' + chainCanon(v[keys[i]]));
    }
    return '{' + parts.join(',') + '}';
  }
  function chainHexOf(bytes) {
    var out = '', i;
    for (i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return out;
  }
  function chainBytesFromHex(hex) {
    var t = String(hex), out = new Uint8Array(Math.floor(t.length / 2)), i;
    for (i = 0; i < out.length; i++) out[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  // base64url — the representation a producer key and a signature travel in,
  // the same one a JWK carries, so nothing here parses DER.
  function chainBytesFromB64u(t0) {
    var t = String(t0).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    var bin = atob(t), out = new Uint8Array(bin.length), i;
    for (i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function chainSha256(text) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
      .then(function (buf) { return chainHexOf(new Uint8Array(buf)); });
  }
  // Ed25519 over the 32 raw bytes of the block digest — exactly what
  // chain/keys.mjs signs. A browser without Ed25519 in WebCrypto rejects here
  // and the caller reports "not checked", never "failed": those are opposite
  // claims about somebody's record and this page must not render one as the
  // other.
  function chainVerifySig(pub, digestHex, sig) {
    var jwk = { kty: 'OKP', crv: 'Ed25519', x: String(pub), ext: true, key_ops: ['verify'] };
    return crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify'])
      .then(function (k) {
        return crypto.subtle.verify({ name: 'Ed25519' }, k, chainBytesFromB64u(sig), chainBytesFromHex(digestHex));
      });
  }
  /**
   * One block, recomputed in this browser: { id, sig, why }.
   *
   * `id` is the block's own hash or null; `sig` is true, false, or null for
   * "nothing checked it here". Null is never shown as either of the other two.
   */
  function chainCheck(block) {
    var out = { id: null, sig: null, why: null };
    if (!(window.crypto && window.crypto.subtle)) {
      out.why = 'This browser handed the page no cryptography to check with — crypto.subtle exists only on a secure origin, and this app is often served over plain http on a LAN. Nothing below was recomputed here, so every signature is unchecked rather than trusted.';
      return Promise.resolve(out);
    }
    var unsigned = {}, k;
    for (k in block) if (Object.prototype.hasOwnProperty.call(block, k) && k !== 'sig') unsigned[k] = block[k];
    return chainSha256(chainCanon(block)).then(function (id) {
      out.id = id;
      return chainSha256(chainCanon(unsigned));
    }).then(function (digest) {
      return chainVerifySig(block.producer, digest, block.sig);
    }).then(function (ok) {
      out.sig = ok;
      return out;
    }).catch(function (e) {
      out.why = out.id
        ? 'The id above was recomputed here, but this browser would not check an Ed25519 signature (' + l2Err(e) + '), so the signatures below are unchecked.'
        : 'This browser could not recompute these blocks (' + l2Err(e) + ').';
      return out;
    });
  }

  /**
   * The epoch chain, and who has timestamped it on Base.
   *
   * The distinction this view exists to hold apart is the one the whole design
   * turns on, so it is said on the screen and not only in this comment:
   *
   *   · the LOG is what is true. Anyone holding it recomputes the state and
   *     gets the same numbers. That is replay, and it needs no signature, no
   *     chain and nobody's permission.
   *   · a BLOCK makes a rewrite loud. It says: this key published exactly
   *     these bytes for this epoch, linked to the block before it.
   *   · an ANCHOR adds the one fact replay cannot reconstruct — WHEN a
   *     commitment existed — by putting two hashes somewhere the poster
   *     cannot reach back into.
   *
   * None of the three makes a result correct, and the interface must never
   * blur that: an anchor proves a commitment existed at a time and was never
   * revised, and says nothing whatever about whether what it commits to is
   * true.
   *
   * Anchors are keyed by (poster, epoch) and ANYONE may post one. This app has
   * no official anchoring address to compare against, so every row names WHOSE
   * anchor it is, and an epoch several addresses anchored shows all of them
   * rather than one this page chose.
   */
  function epochChainView() {
    var wrap = h('div', {});
    // The newest N blocks are drawn and checked. The chain is every epoch this
    // network has ever closed; hashing all of it inside a page would be a
    // spinner rather than a check, and the whole file is one fetch away at
    // /api/chain for anyone who wants to run chain/verify.mjs over it.
    var SHOW = 20;

    var card = h('div', { class: 'card' }, h('h2', { text: 'The epoch chain' }));
    card.appendChild(h('p', { class: 'smallnote' },
      'Every closed epoch is sealed into one ', term('epochBlock'),
      ': the acts it covered, hashes of the state computed from them, the constants used, and a signature from the ',
      term('producer'), ' that published it. Each block carries the id of the one before it, so an old block cannot be edited quietly — every id after it changes too, and stops matching the copies other people are holding.'));
    card.appendChild(h('p', { class: 'smallnote' },
      'A block is a publication, not a verdict. What is true here is settled by ', term('replay'),
      ' — recomputing the network from the public act log, which needs neither this host nor any chain. A signature that checks out says this key published exactly these bytes, and nothing at all about the numbers in them being right.'));
    card.appendChild(h('p', { class: 'smallnote', text: 'The ids and signatures below are recomputed in this browser out of the bytes this host served, because a host reporting that its own chain verifies is marking its own work. The same check runs offline over the same two files: node chain/verify.mjs, against /api/chain and /api/acts.' }));
    var body = h('div', {});
    card.appendChild(body);
    wrap.appendChild(card);

    var aCard = h('div', { class: 'card', style: 'margin-top:14px' }, h('h2', { text: 'Anchors — and whose they are' }));
    var aBody = h('div', {});
    aCard.appendChild(aBody);
    wrap.appendChild(aCard);

    var kCard = h('div', { class: 'card', style: 'margin-top:14px' }, h('h2', { text: 'The contracts this host reads' }));
    var kBody = h('div', {});
    kCard.appendChild(kBody);
    wrap.appendChild(kCard);

    body.appendChild(h('p', { class: 'smallnote', text: 'Reading the blocks this host publishes…' }));
    aBody.appendChild(h('p', { class: 'smallnote', text: 'Asking this host what it can see on chain…' }));
    kBody.appendChild(h('p', { class: 'smallnote', text: 'Asking this host which contracts it is pointed at…' }));

    // One shape for three answers, and a refusal that is a status rather than
    // an exception: /api/chain is ndjson and never parses as one document, so
    // the text is kept beside whatever JSON there was.
    function ask(path) {
      return fetch(API + path, { cache: 'no-store' }).then(function (r) {
        return r.text().then(function (t) {
          var d = null;
          try { d = JSON.parse(t); } catch (e) { d = null; }
          return { status: r.status, d: d, text: t };
        });
      }).catch(function () { return { status: 0, d: null, text: '' }; });
    }

    Promise.all([ask('/api/chain'), ask('/api/chain/head'), ask('/api/token/onchain')])
      .then(function (r) { draw(r[0], r[1], r[2]); });

    function draw(chainRes, headRes, ocRes) {
      body.innerHTML = '';
      aBody.innerHTML = '';
      kBody.innerHTML = '';

      var oc = ocRes.d;
      var ocOff = ocRes.status === 404 || !!(oc && oc.code === 'ONCHAIN_OFF');
      var ocOK = ocRes.status === 200 && !!oc && !oc.code;
      var chainId = ocOK && isFinite(Number(oc.chainId)) ? Number(oc.chainId) : null;
      var anch = ocOK && oc.anchors ? oc.anchors : null;
      var anchorsOn = !!(anch && anch.configured !== false && !anch.error && Array.isArray(anch.anchors));

      // Anchors by epoch, in a null-prototype map: the keys are decimal
      // strings a stranger chose, because anyone may anchor any epoch number.
      var byEpoch = Object.create(null);
      if (anchorsOn) {
        anch.anchors.forEach(function (a) {
          var k = String(a.epoch);
          if (!byEpoch[k]) byEpoch[k] = [];
          byEpoch[k].push(a);
        });
      }

      var blocks = [], bad = 0;
      if (chainRes.status === 200) {
        String(chainRes.text || '').split('\n').forEach(function (line) {
          var t = line.trim();
          if (!t) return;
          try {
            var b = JSON.parse(t);
            if (b && typeof b === 'object' && !Array.isArray(b)) blocks.push(b);
            else bad++;
          } catch (e) { bad++; }
        });
      }
      blocks.sort(function (x, y) { return (Number(x.height) || 0) - (Number(y.height) || 0); });

      var head = headRes.status === 200 && headRes.d ? headRes.d : null;
      // What the chain says its own ids are: block N+1 carries N's id in
      // `prev`, and HEAD.json names the tip's. That is what makes recomputing
      // them worth doing — two independent statements of one hash, one
      // derived from the bytes and one asserted by the files, and a
      // disagreement between them is the loudest thing this view can say.
      var said = Object.create(null), saidBy = Object.create(null);
      blocks.forEach(function (b) {
        var hgt = Number(b.height);
        if (typeof b.prev === 'string' && b.prev && isFinite(hgt)) {
          said[String(hgt - 1)] = b.prev;
          saidBy[String(hgt - 1)] = 'the block above names it as its prev';
        }
      });
      if (head && typeof head.hash === 'string' && head.hash) {
        said[String(head.height)] = head.hash;
        saidBy[String(head.height)] = 'HEAD.json names it as the tip';
      }

      var queue = [], whyBox = h('div', {});

      if (chainRes.status === 0) {
        body.appendChild(h('p', { class: 'smallnote', text: 'This page could not reach a host to ask for the chain, so nothing is shown. Nothing is drawn from this page’s own memory on purpose: a chain redrawn out of a cache is exactly what this view exists to make unnecessary.' }));
      } else if (chainRes.status === 404) {
        body.appendChild(h('p', { class: 'smallnote', text: (chainRes.d && chainRes.d.error) || 'This host has sealed no epoch block yet.' }));
        body.appendChild(h('p', { class: 'smallnote', text: 'That is a host which has sealed nothing, not a network without a record: the act log IS the record, and it replays without any of this.' }));
      } else if (chainRes.status !== 200) {
        body.appendChild(h('p', { class: 'smallnote', text: 'This host answered ' + chainRes.status + ' when asked for its chain' + (chainRes.d && chainRes.d.error ? ': ' + chainRes.d.error : '.') }));
      } else if (!blocks.length) {
        body.appendChild(h('p', { class: 'smallnote', text: 'This host served a chain with no blocks in it' + (bad ? ', and ' + bad + ' line(s) of it would not parse.' : '.') }));
      } else {
        drawBlocks();
      }

      function drawBlocks() {
        var shown = blocks.slice(Math.max(0, blocks.length - SHOW)).reverse();
        var top = 'Newest first. ' + (blocks.length > shown.length
          ? 'Showing ' + shown.length + ' of ' + blocks.length + ' blocks — the rest are in the same file, at /api/chain.'
          : blocks.length + ' block' + (blocks.length === 1 ? '' : 's') + ', which is all of them.');
        if (bad) top += ' ' + bad + ' line(s) would not parse and are not counted.';
        if (head && Number(head.height) !== Number(blocks[blocks.length - 1].height)) {
          top += ' This host’s HEAD names height ' + head.height + ' while the last block in its file is height ' + blocks[blocks.length - 1].height + ': the two disagree, which is worth more of your attention than any signature below.';
        }
        body.appendChild(h('p', { class: 'smallnote', text: top }));
        body.appendChild(whyBox);

        shown.forEach(function (b) {
          var row = h('div', { style: 'border-top:1px solid var(--line); padding:10px 0' });
          var when = typeof b.time === 'number' && isFinite(b.time)
            ? new Date(b.time).toLocaleString()
            : 'a time this block does not carry';
          row.appendChild(h('div', { class: 'kv' },
            h('span', { text: 'epoch ' + (b.epoch == null ? '?' : b.epoch) }),
            h('b', { class: 'num', text: 'height ' + (b.height == null ? '?' : b.height) }),
            h('span', { text: 'sealed' }),
            h('b', { class: 'num', text: when })));
          var idLine = h('p', { class: 'smallnote' });
          row.appendChild(idLine);
          row.appendChild(h('p', { class: 'smallnote' },
            h('span', { class: 'num', style: 'word-break:break-all', text: 'producer ' + String(b.producer || '—') })));
          var chips = h('div', {});
          row.appendChild(chips);
          var anchors = h('div', {});
          row.appendChild(anchors);
          body.appendChild(row);
          queue.push({ b: b, idLine: idLine, chips: chips, anchors: anchors });
        });

        body.appendChild(h('p', { class: 'smallnote', text: 'A producer is a signing key — not a wallet and not a person. It signs the record and holds no money. A key that changes from one block to the next is a change in who publishes this network’s epochs, and it is visible here rather than silent.' }));
        run();
      }

      // One at a time. Twenty blocks is twenty canonical encodings and forty
      // digests; done in parallel on a phone the page stops answering, and the
      // rows fill in top-down either way.
      function run() {
        var i = 0;
        function next() {
          if (i >= queue.length) return;
          var slot = queue[i++];
          chainCheck(slot.b).then(function (r) { paint(slot, r); next(); });
        }
        next();
      }

      function paint(slot, r) {
        var b = slot.b, hgt = String(b.height);
        var claimed = said[hgt] || null;
        var id = r.id || claimed;

        slot.idLine.innerHTML = '';
        if (id) {
          slot.idLine.appendChild(h('span', { class: 'num', style: 'word-break:break-all', text: id }));
          slot.idLine.appendChild(h('button', { class: 'btn small', style: 'margin-left:8px', text: 'Copy id',
            onclick: function () { copyLine(id, 'Block id copied.'); } }));
          slot.idLine.appendChild(h('span', { class: 'smallnote', text: r.id ? ' · recomputed here from the bytes served' : ' · not recomputed here — ' + (saidBy[hgt] || 'taken from this host') }));
        } else {
          slot.idLine.appendChild(h('span', { class: 'smallnote', text: 'This block’s id is not on screen: nothing here recomputed it, and neither another block nor HEAD names it.' }));
        }

        slot.chips.innerHTML = '';
        if (r.sig === true) slot.chips.appendChild(h('span', { class: 'gate pass', text: 'signature verifies' }));
        else if (r.sig === false) slot.chips.appendChild(h('span', { class: 'gate fail', text: 'SIGNATURE DOES NOT VERIFY' }));
        else slot.chips.appendChild(h('span', { class: 'gate', style: 'border:1px solid var(--line)', text: 'signature not checked here' }));

        if (r.id && claimed) {
          slot.chips.appendChild(r.id === claimed
            ? h('span', { class: 'gate pass', text: 'id matches — ' + saidBy[hgt] })
            : h('span', { class: 'gate fail', text: 'ID DOES NOT MATCH THE LINK' }));
        } else if (r.id) {
          slot.chips.appendChild(h('span', { class: 'gate', style: 'border:1px solid var(--line)', text: 'nothing else names this id' }));
        }

        if (r.id && claimed && r.id !== claimed) {
          slot.chips.appendChild(h('p', { class: 'smallnote', style: 'border-left:2px solid var(--ember); padding-left:9px',
            text: 'These bytes hash to ' + r.id + ', and this same host says the block at this height is ' + claimed + ' (' + saidBy[hgt] + '). One of the two is wrong, and a chain whose own links do not fit the blocks it serves proves nothing at all. Replay the act log and believe that instead.' }));
        }
        if (r.sig === false) {
          slot.chips.appendChild(h('p', { class: 'smallnote', style: 'border-left:2px solid var(--ember); padding-left:9px',
            text: 'The signature on this block does not check out against the key inside it. That does not say which of the possible things happened — an edited block, a truncated file, a key that is not this producer’s — only that these are not bytes that key published, and they should be read as unsigned.' }));
        }
        // Said once, above the list, rather than twenty times down it.
        if (r.why && !whyBox.firstChild) whyBox.appendChild(h('p', { class: 'smallnote', text: r.why }));

        paintAnchors(slot.anchors, b.epoch, r.id || claimed, false);
      }

      /**
       * The anchors for one epoch, each under the address that posted it.
       *
       * `id` is the block id this screen holds for that epoch, or null. Where
       * both exist they are compared, because an anchor committing to a
       * DIFFERENT block for the same epoch is the single most useful thing an
       * anchor can tell a reader — and it is a fact about two records, never a
       * verdict about which is honest.
       */
      function paintAnchors(box, epoch, id, orphan) {
        if (!anchorsOn) return;   // said once, in the anchors card below
        var rows = byEpoch[String(epoch)] || [];
        if (!rows.length) {
          box.appendChild(h('p', { class: 'smallnote', text: 'No anchor for this epoch in what this host has read. That is not evidence that nobody anchored it: anyone may post one from any address, and this host reports only the rows its own log scan reached.' }));
          return;
        }
        if (rows.length > 1) {
          box.appendChild(h('p', { class: 'smallnote', text: rows.length + ' separate addresses have anchored epoch ' + epoch + '. None of them is “the network’s” — the contract keeps one row per (address, epoch) and anyone may post — so these are ' + rows.length + ' claims sitting side by side, and which of them means anything is a question about those addresses and not about this epoch.' }));
        }
        rows.forEach(function (a) {
          var when = a.at ? new Date(Number(a.at) * 1000).toLocaleString() + ', on the chain’s own clock' : 'a time this host did not report';
          var who = l2ScanLink(chainId, 'address', a.by, 'this address on basescan');
          var tx = l2ScanLink(chainId, 'tx', a.tx, 'the transaction');
          box.appendChild(h('p', { class: 'smallnote' },
            h('span', { class: 'num', text: l2ShortHex(a.by) }),
            ' anchored epoch ' + a.epoch + ' at ' + when + '. ',
            who, who && tx ? ' · ' : null, tx));
          if (typeof a.blockId === 'string' && a.blockId) {
            if (id && String(a.blockId).toLowerCase() === String(id).toLowerCase()) {
              box.appendChild(h('span', { class: 'gate pass', text: 'commits to this exact block' }));
            } else if (id) {
              box.appendChild(h('p', { class: 'smallnote', style: 'border-left:2px solid var(--ember); padding-left:9px',
                text: 'That anchor commits to a different block for epoch ' + a.epoch + ' than the one on this screen: ' + a.blockId + '. Both records are real and they cannot both be this epoch. Which one is honest is not a question an anchor can answer — replay the act log and see whose hashes come out of it.' }));
            } else {
              box.appendChild(h('p', { class: 'smallnote', text: 'It commits to block id ' + a.blockId + '. Nothing here compared that against anything, because ' + (orphan ? 'this host holds no block for that epoch.' : 'this block’s own id could not be established above.') }));
            }
          }
          box.appendChild(h('p', { class: 'smallnote', text: 'It also commits to an earnings root, ' + l2ShortHex(String(a.earningsRoot || '—')) + '. This view checks that root against nothing: what an epoch owes and to whom is the earnings tree’s business, and an anchor only fixes the moment a commitment to it existed.' }));
        });
      }

      // ── the anchors card ──
      aBody.appendChild(h('p', { class: 'smallnote' },
        'An ', term('anchor'), ' is two hashes and a timestamp, posted to a contract on Base by whatever address chose to post them: this address said epoch N had this block id and this earnings root, at this moment. The contract keeps one row per (address, epoch) and refuses a second forever — so what it proves is that the commitment existed by then and was never revised.'));
      aBody.appendChild(h('p', { class: 'smallnote', text: 'It proves nothing else. Not that the epoch was computed honestly, not that the numbers in it are right, and not that the poster is anybody in particular: anyone may anchor anything, and an impostor’s row sits under their own address next to nothing. This app has no official anchoring address, so no row here is “the network’s” and every one of them says whose it is.' }));

      if (ocRes.status === 0) {
        aBody.appendChild(h('p', { class: 'smallnote', text: 'This page could not reach a host to ask what it reads on chain, so nothing is claimed about anchors either way.' }));
      } else if (ocOff) {
        aBody.appendChild(h('p', { class: 'smallnote', text: (oc && oc.why) || 'This host serves no on-chain token, so it reads no anchor contract either.' }));
      } else if (!ocOK) {
        aBody.appendChild(h('p', { class: 'smallnote', text: 'This host answered ' + ocRes.status + ' when asked what it reads on chain' + (oc && oc.error ? ': ' + oc.error : '.') }));
      } else if (!anch) {
        aBody.appendChild(h('p', { class: 'smallnote', text: oc.error || 'This host said nothing about anchors at all — neither a contract nor a reason — and nothing is assumed from that silence.' }));
      } else if (anch.configured === false) {
        aBody.appendChild(h('p', { class: 'smallnote', text: anch.why || 'PEER_ANCHOR_ADDR is unset on this host, so it reads no anchors.' }));
        aBody.appendChild(h('p', { class: 'smallnote', text: 'The blocks above are unaffected: they are this host’s own record and need no contract. Anchoring is an outside witness, and its absence here is not a claim that nobody anchored these epochs — only that this host is not looking.' }));
      } else if (anch.error) {
        aBody.appendChild(h('p', { class: 'smallnote', text: anch.error }));
      } else {
        aBody.appendChild(h('p', { class: 'smallnote' },
          h('span', { class: 'num', style: 'word-break:break-all', text: String(anch.contract || '—') }),
          ' · the anchor contract this host reads, on ' + l2ChainName(chainId) + '. ',
          l2ScanLink(chainId, 'address', anch.contract, 'the contract on basescan')));
        var seen = Number(anch.returned || 0), found = Number(anch.discovered || 0);
        var line = seen + ' anchor' + (seen === 1 ? '' : 's') + ' in view, of ' + found + ' this host has seen';
        if (anch.posters != null) line += ', posted by ' + anch.posters + ' address' + (Number(anch.posters) === 1 ? '' : 'es');
        if (anch.busiestPoster && anch.busiestPoster.by) line += '; the busiest is ' + l2ShortHex(anch.busiestPoster.by) + ' with ' + anch.busiestPoster.anchors;
        aBody.appendChild(h('p', { class: 'smallnote', text: line + '. Nothing ranks them, because there is nothing here to rank by: posting one costs a fee and proves membership of nothing.' }));
        if (anch.note) aBody.appendChild(h('p', { class: 'smallnote', text: anch.note }));

        // Anchors for epochs this host has no block for. Either it is behind,
        // or somebody anchored an epoch that does not exist here — both
        // are ordinary, and neither is evidence about the other.
        var have = Object.create(null);
        blocks.forEach(function (b) { have[String(b.epoch)] = 1; });
        var orphans = Object.keys(byEpoch).filter(function (k) { return !have[k]; });
        if (orphans.length) {
          orphans.sort(function (x, y) { return Number(y) - Number(x); });
          aBody.appendChild(h('p', { class: 'eyebrow', style: 'margin:14px 0 4px', text: 'anchored epochs this host has no block for' }));
          aBody.appendChild(h('p', { class: 'smallnote', text: 'The contract accepts any epoch number from any address, so a row here means somebody committed to an epoch this host cannot show you — because it has not sealed that far yet, or because the epoch is not one it recognises at all.' }));
          orphans.slice(0, 12).forEach(function (k) {
            var oBox = h('div', { style: 'border-top:1px solid var(--line); padding:8px 0' });
            oBox.appendChild(h('div', { class: 'kv' },
              h('span', { text: 'epoch ' + k }),
              h('b', { class: 'num', text: byEpoch[k].length + ' anchor' + (byEpoch[k].length === 1 ? '' : 's') })));
            aBody.appendChild(oBox);
            paintAnchors(oBox, k, null, true);
          });
          if (orphans.length > 12) {
            aBody.appendChild(h('p', { class: 'smallnote', text: orphans.length + ' such epochs in all; the newest twelve are shown.' }));
          }
        }
      }

      // ── the contracts card ──
      kBody.appendChild(h('p', { class: 'smallnote' },
        'Every address below is read from this host and never written into this page, and each one carries a link to a ', term('explorer', 'block explorer'),
        ' — which is how any of it gets checked against something that is not this app.'));
      if (!ocOK) {
        kBody.appendChild(h('p', { class: 'smallnote', text: ocOff
          ? ((oc && oc.why) || 'No on-chain token is configured on this host, so it names no contracts.')
          : 'This host did not answer with what it reads on chain, so there is nothing here to name.' }));
      } else {
        if (chainId === null) {
          kBody.appendChild(h('p', { class: 'smallnote', text: 'This host did not say which chain it serves, so nothing here links anywhere: an explorer for the wrong chain draws a confident page about an entirely different thing.' }));
        } else if (!L2_EXPLORERS[chainId]) {
          kBody.appendChild(h('p', { class: 'smallnote', text: 'This host serves chain ' + chainId + ', and this page knows no explorer for it. The addresses below are printed without links rather than linked to basescan, which only reads Base.' }));
        } else {
          kBody.appendChild(h('p', { class: 'smallnote', text: 'This host serves chain ' + chainId + ' (' + l2ChainName(chainId) + '), so every link below goes to basescan, which is the explorer for that chain.' }));
        }
        kRow('PEER — the ERC-20', oc.token, 'token', 'No token address.');
        kRow('cbBTC — the other side of every pool here', oc.btc, 'token', 'PEER_BTC_ADDR is unset on this host.');
        kRow('the pools factory — this app’s own pools', oc.namedPools && oc.namedPools.factory, 'address',
          'PEER_POOLS_ADDR is unset on this host, so this app has no pools of its own here.');
        kRow('the anchor contract — timestamps over epoch blocks', anch && anch.configured !== false ? anch.contract : null, 'address',
          (anch && anch.why) || 'No anchor contract is configured on this host.');
        var cs = oc.claimState;
        kRow('the claim contract — epoch earnings paid on chain', cs && cs.configured !== false ? cs.contract : null, 'address',
          (cs && cs.why) || 'No claim contract is configured on this host.');
      }

      function kRow(label, addr, kind, off) {
        var row = h('div', { style: 'border-top:1px solid var(--line); padding:8px 0' });
        row.appendChild(h('p', { class: 'eyebrow', style: 'margin:0 0 3px', text: label }));
        if (!addr) {
          row.appendChild(h('p', { class: 'smallnote', text: off }));
        } else {
          row.appendChild(h('p', { class: 'smallnote' },
            h('span', { class: 'num', style: 'word-break:break-all', text: String(addr) }), ' ',
            l2ScanLink(chainId, kind, addr, 'on basescan')));
        }
        kBody.appendChild(row);
      }
    }

    return wrap;
  }

  /**
   * This app's own pools, and the same pair on a public DEX.
   *
   * Two pools over the same two tokens are two pools. They hold different
   * coins, they have different prices, and a trade in one does nothing for the
   * other. That is worth a card of its own because the failure it prevents is
   * expensive and quiet: reading the ratio on this screen as "the price of
   * PEER", depositing into one pool while quoting the other, or believing this
   * app routes a trade somewhere it does not.
   *
   * Nothing here reads Uniswap. This app cannot say whether a Uniswap pool for
   * the pair exists, what it holds, or what it would fill at — so it says that
   * instead of implying otherwise, and the link is a link out rather than a
   * reading.
   */
  function dexCard() {
    var card = h('div', { class: 'card', style: 'margin-top:14px' },
      h('h2', { text: 'This app’s pools, and Uniswap' }));
    var body = h('div', {});
    card.appendChild(body);

    body.appendChild(h('p', { class: 'smallnote' },
      'The pools above are this app’s own: named pools inside one contract, opened by whoever wanted one, trading PEER against cbBTC. Every button on this screen calls that contract and nothing else.'));
    body.appendChild(h('p', { class: 'smallnote' },
      'The same two tokens can also have a pool on Uniswap, which is a different ', term('dex'),
      ': a different contract, holding different coins, with its own price and its own fee tier. This app does not read Uniswap, does not route anything to it, and cannot tell you whether a pool for this pair exists there at all.'));
    body.appendChild(h('p', { class: 'smallnote' },
      term('liquidity', 'Liquidity'), ' sits in one pool and nowhere else. Coins deposited here are not available to a trade there, and the reverse is just as true — so the two prices can differ for as long as nobody trades the gap away, and opening both splits what little depth there is rather than adding it up.'));
    body.appendChild(h('p', { class: 'smallnote', text: 'No price on this screen is a market price. A pool’s price is its own ratio: what its opener put in, moved by whoever has traded against it since.' }));

    var out = h('div', {});
    body.appendChild(out);

    function draw(status, d) {
      out.innerHTML = '';
      if (status === 404 || !d || d.code === 'ONCHAIN_OFF' || !d.token) {
        out.appendChild(h('p', { class: 'smallnote', text: 'This host names no token, so there is no pair to point at anywhere — here or on Uniswap.' }));
        return;
      }
      var chainId = Number(d.chainId);
      var token = String(d.token), btc = d.btc ? String(d.btc) : null;
      if (!d.namedPools) {
        out.appendChild(h('p', { class: 'smallnote', text: 'This host has no pools factory configured, so this app has no pools of its own — the card above says so. A Uniswap pool for the same pair would be a separate thing that needs nothing from this host.' }));
      }
      if (chainId !== 8453 || !/^0x[0-9a-fA-F]{40}$/.test(token) || !btc || !/^0x[0-9a-fA-F]{40}$/.test(btc)) {
        out.appendChild(h('p', { class: 'smallnote', text: 'No link out is drawn: it would be written for Base and this host serves chain ' + d.chainId + (btc ? '' : ', and no cbBTC address is configured to name the other side of the pair') + '. An exchange link built for the wrong chain sends somebody to a page about different coins with the same addresses.' }));
      } else {
        var row = h('div', { class: 'mini-form persistent' });
        row.appendChild(h('a', { class: 'btn small', target: '_blank', rel: 'noopener',
          href: 'https://app.uniswap.org/swap?chain=base&inputCurrency=' + btc + '&outputCurrency=' + token,
          text: 'Open this pair on Uniswap' }));
        var tl = l2ScanLink(chainId, 'token', token, 'the token on basescan');
        if (tl) row.appendChild(tl);
        out.appendChild(row);
        out.appendChild(h('p', { class: 'smallnote', text: 'That opens Uniswap with both addresses filled in. It is a link out, not a reading: if no pool exists there, Uniswap is what will tell you, and whatever price it shows is that pool’s and has nothing to do with the numbers above. Opening a position there is a decision about a different pool — chain-l2/DEPLOY.md §3 is the runbook, and a new pair belongs at a 1% fee tier with an opening price you are choosing rather than discovering.' }));
      }
      // PEER_POOL_ADDR: an outside pair this host was pointed at. It is read
      // and reported, and it is still not this app's pool — naming it without
      // that sentence would be the exact blur this card exists to prevent.
      var pool = d.pool ? (typeof d.pool === 'string' ? d.pool : d.pool.address) : null;
      if (pool) {
        var pl = l2ScanLink(chainId, 'address', pool, 'on basescan');
        out.appendChild(h('p', { class: 'smallnote' },
          'This host is also pointed at an outside pair at ',
          h('span', { class: 'num', style: 'word-break:break-all', text: String(pool) }), ' ', pl,
          ' — a UniswapV2-style contract it reads and never trades. No button here touches it, and this page cannot say which exchange it belongs to; the explorer can.'));
        if (d.pool && d.pool.error) out.appendChild(h('p', { class: 'smallnote', text: d.pool.error }));
      }
    }

    out.appendChild(h('p', { class: 'smallnote', text: 'Asking this host which pair it serves…' }));
    fetch(API + '/api/token/onchain', { cache: 'no-store' })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (x) { draw(x.status, x.d); })
      .catch(function () {
        out.innerHTML = '';
        out.appendChild(h('p', { class: 'smallnote', text: 'Could not reach this host to ask which pair it serves, so no link out is drawn from memory. Everything above is true regardless: two pools over one pair are two pools.' }));
      });
    return card;
  }

  function econTab(st) {
    var l0 = st.l0;""",
    'the epoch chain view, the chain checks, and the DEX card',
)

# ── 4. the pools card: the factory, the creators, the transactions ────────
once(
    r"""      var ocSeq = h('div', {});
      ocCard.appendChild(ocSeq);
      wrap.appendChild(ocCard);""",
    r"""      var ocSeq = h('div', {});
      ocCard.appendChild(ocSeq);
      // Every transaction hash this card produces, kept where it can be
      // clicked. Deliberately NOT inside ocSeq: the create sequence clears
      // that panel when it starts, and a hash from an earlier swap is exactly
      // the thing that must survive somebody pressing another button.
      var ocTxBox = h('div', {});
      ocCard.appendChild(ocTxBox);
      wrap.appendChild(ocCard);
      // Two pools over one pair are two pools. Directly under the card whose
      // prices could otherwise be read as the market's.
      wrap.appendChild(dexCard());""",
    'a persistent transaction record, and the DEX card under the pools card',
)

once(
    r"""        return {
          open: function (what) {""",
    r"""        return {
          // Exposed so the on-screen record can print each leg beside a link
          // to the explorer. Read-only by convention: the ledger owns them.
          legs: legs,
          open: function (what) {""",
    'the ledger hands out its legs',
)

once(
    r"""      // Decimal text -> raw BigInt at `dec` decimals, or null. NEVER""",
    r"""      /**
       * Every transaction this card produced, on screen, with a link each.
       *
       * A hash inside a toast is a hash nobody can act on: it is gone in five
       * seconds and it cannot be clicked — and the two states where it
       * matters most, BROADCAST WITH NO RECEIPT SEEN and REVERTED, are exactly
       * the ones somebody has to look up before pressing anything again.
       * Pressing again can pay for the same thing twice.
       *
       * Base is not asked for here: this whole card refuses to draw unless the
       * host answered chain 8453, a few hundred lines above, so a hash it
       * produced is a hash on Base by construction.
       */
      function ocTxRecord(led, headline) {
        var all = (led && led.legs) || [], rows = [], i;
        for (i = 0; i < all.length; i++) if (all[i].tx) rows.push(all[i]);
        if (!rows.length) return;
        var box = h('div', { style: 'margin-top:10px' });
        box.appendChild(h('p', { class: 'eyebrow', style: 'margin:0 0 4px', text: headline }));
        rows.forEach(function (l) {
          var said = l.state === 'confirmed' ? 'landed'
            : l.state === 'reverted' ? 'REVERTED — it cost the gas and moved no coins'
            : l.state === 'sent' ? 'BROADCAST AND NOT SEEN TO CONFIRM — it may still land, so look it up before signing anything like it again'
            : l.state;
          box.appendChild(h('p', { class: 'smallnote' },
            h('span', { class: 'num', style: 'word-break:break-all', text: String(l.tx) }),
            ' · ' + l.what + ' · ' + said + ' ',
            l2ScanLink(8453, 'tx', l.tx, 'on basescan')));
        });
        ocTxBox.appendChild(box);
      }

      // Decimal text -> raw BigInt at `dec` decimals, or null. NEVER""",
    'ocTxRecord — the hashes stay on screen, each with a link',
)

# The factory itself, named and linkable. It was never printed anywhere: the
# one address every button on this card sends money to was the one address a
# reader could not check.
once(
    r"""        var walletRow = h('div', { class: 'mini-form persistent' });
        ocBody.appendChild(walletRow);""",
    r"""        // The address every button below sends to, printed and linkable. It
        // was the one address on this card a reader could not check, which is
        // backwards: a pool list is judged by its reserves and its creators,
        // and the factory holding all of them is judged by being readable.
        ocBody.appendChild(h('p', { class: 'smallnote' },
          h('span', { class: 'num', style: 'word-break:break-all', text: String(factory) }),
          ' · the pools contract this host reads, on Base. ',
          l2ScanLink(8453, 'address', factory, 'on basescan')));

        var walletRow = h('div', { class: 'mini-form persistent' });
        ocBody.appendChild(walletRow);""",
    'the factory address, with an explorer link',
)

once(
    r"""          box.appendChild(h('p', { class: 'smallnote', text: prov }));""",
    r"""          // The creator, linkable. "Read the creator" is advice nobody can
          // take from twelve characters of hex: on the explorer that address
          // has a history, and this row is where somebody decides whether to
          // hand it money.
          box.appendChild(h('p', { class: 'smallnote' }, prov + ' ',
            l2ScanLink(8453, 'address', p.creator, 'that address on basescan')));""",
    'pool creators link to the explorer',
)

# ── 5. every sequence writes its hashes down ──────────────────────────────
once(
    r"""                  toast('Swapped in ' + label + '. ' + OC_LAG);""",
    r"""                  toast('Swapped in ' + label + '. ' + OC_LAG);
                  ocTxRecord(led, 'Swap in ' + label);""",
    'the swap records its transaction',
)
once(
    r"""                } catch (e) { toast(led.sentence('The swap stopped', e)); }""",
    r"""                } catch (e) { toast(led.sentence('The swap stopped', e)); ocTxRecord(led, 'Swap in ' + label + ' — stopped'); }""",
    'a stopped swap keeps its hashes on screen',
)
once(
    r"""                  toast('Added to ' + label + ' \u2014 the proportional part of what you offered. ' + OC_LAG);""",
    r"""                  toast('Added to ' + label + ' \u2014 the proportional part of what you offered. ' + OC_LAG);
                  ocTxRecord(led, 'Deposit into ' + label);""",
    'the deposit records its transactions',
)
once(
    r"""                } catch (e) { toast(led.sentence('The deposit stopped', e)); }""",
    r"""                } catch (e) { toast(led.sentence('The deposit stopped', e)); ocTxRecord(led, 'Deposit into ' + label + ' \u2014 stopped'); }""",
    'a stopped deposit keeps its hashes on screen',
)
once(
    r"""                      toast('Withdrew from ' + label + ' \u2014 both sides, proportional to your shares. ' + OC_LAG);""",
    r"""                      toast('Withdrew from ' + label + ' \u2014 both sides, proportional to your shares. ' + OC_LAG);
                      ocTxRecord(led, 'Withdrawal from ' + label);""",
    'the withdrawal records its transaction',
)
once(
    r"""                    } catch (e) { toast(led.sentence('The withdrawal stopped', e)); }""",
    r"""                    } catch (e) { toast(led.sentence('The withdrawal stopped', e)); ocTxRecord(led, 'Withdrawal from ' + label + ' \u2014 stopped'); }""",
    'a stopped withdrawal keeps its hashes on screen',
)
once(
    r"""              cSay(OC_LAG + ' The list above is being re-read now and once more when that window rolls \u2014 you do not have to reload the page.');""",
    r"""              cSay(OC_LAG + ' The list above is being re-read now and once more when that window rolls \u2014 you do not have to reload the page.');
              ocTxRecord(led, 'Opening \u201c' + nm + '\u201d');""",
    'opening a pool records its transactions',
)
once(
    r"""              cSay(led.sentence('Opening the pool stopped', e), true);""",
    r"""              cSay(led.sentence('Opening the pool stopped', e), true);
              ocTxRecord(led, 'Opening \u201c' + nm + '\u201d \u2014 stopped');""",
    'a stopped opening keeps its hashes on screen',
)

# ── 6. the words, in the dictionary that already exists ───────────────────
# Two rules, both binding: the one-liner is answerable without knowing another
# term, and `sect` names a section that ACTUALLY EXISTS in guideTab. The three
# on-chain terms needed a section that did not exist yet, so one is added
# below rather than pointing them at a section about something else.
once(
    r"""  var TERMS = {
    reserve: {""",
    r"""  var TERMS = {
    epochBlock: {
      t: 'epoch block',
      one: 'One signed certificate per closed epoch: what was computed then, and who published it.',
      more: 'It carries the acts that epoch covered, hashes of the state computed from them, the constants used, and the id of the block before it — so editing an old one changes every id after it and stops matching the copies other people hold. A block is a publication, not a verdict: it makes a silent rewrite loud, and decides nothing.',
      sect: 'Epochs: stamping the record',
    },
    producer: {
      t: 'producer',
      one: 'The key that signed a block — whoever published that epoch’s result.',
      more: 'A signing key, not a person and not a wallet: it signs the record and holds no money. A signature that checks out says this key published exactly these bytes. It says nothing about the numbers being right — anyone who disagrees recomputes the log and publishes the difference.',
      sect: 'Epochs: stamping the record',
    },
    replay: {
      t: 'replay',
      one: 'Recomputing the whole network from the public list of acts, to see if you get the same answer.',
      more: 'Every number on screen comes out of that list, so anyone holding it rebuilds the state themselves and has to trust no host, no signature and no chain. Replay is what decides what is true here; hashes and timestamps only make a disagreement visible and attributable.',
      sect: 'What you are looking at',
    },
    anchor: {
      t: 'anchor',
      one: 'A short record posted on a public chain, saying a particular result existed by a particular moment.',
      more: 'It is a timestamp over two hashes, posted by whatever address chose to post it, and it can never be revised. What it proves is that the commitment existed by then — not that the result is correct, and not that the poster is anyone in particular. Anyone may post one, so an anchor is worth exactly what its poster is.',
      sect: 'Epochs: stamping the record',
    },
    explorer: {
      t: 'block explorer',
      one: 'A public website that shows what a chain holds at an address, or inside one transaction.',
      more: 'It reads the same chain a wallet does, which makes it the way to check this page against something that is not this page. Links here only ever point at the explorer for the chain this host is configured for: pointed at another chain an explorer does not fail, it draws a confident page about something else.',
      sect: 'The coin on Base: pools, prices and explorers',
    },
    dex: {
      t: 'DEX',
      one: 'A place two tokens trade against each other with no company in the middle — a contract holding both.',
      more: 'The ratio between what it holds is the price, and a trade moves it. This app has its own pools; the same pair can also have a pool on Uniswap, which is a different contract with different coins in it. Nothing here routes a trade to Uniswap or reads a price from it.',
      sect: 'The coin on Base: pools, prices and explorers',
    },
    liquidity: {
      t: 'liquidity',
      one: 'How much of each coin a pool actually holds — what there is to trade against.',
      more: 'The less there is, the further a trade moves the price, so a thin pool moves enormously on a small trade. It sits in one pool and nowhere else: coins in this app’s pool do nothing for a trade in a Uniswap pool of the same pair, and the two prices can differ until somebody trades the gap away.',
      sect: 'The coin on Base: pools, prices and explorers',
    },
    reserve: {""",
    'seven terms: the chain ones and the on-chain ones',
)

# ── 7. the guide sections those terms point at ────────────────────────────
once(
    r"""        P('Closing also advances ', B('tenure'), ': each actor’s derived self-edge bond re-reads their standing (p = S/(ν+S)) and its maturity τ steps toward 1 — long-standing identities route more weight. ', jump('see certificates', 'econ/ledger'))),""",
    r"""        P('Closing also advances ', B('tenure'), ': each actor’s derived self-edge bond re-reads their standing (p = S/(ν+S)) and its maturity τ steps toward 1 — long-standing identities route more weight. ', jump('see certificates', 'econ/ledger')),
        P('Closing also seals an ', B('epoch block'), ': one signed certificate carrying the acts that epoch covered, hashes of the state computed from them, the constants used, and the previous block’s id. The key that signs it is the ', B('producer'), ' — a signing key, not a wallet, holding no money. Changing an old block changes every id after it, which is the whole job: it makes a silent rewrite loud rather than deciding anything.'),
        P('None of that is what makes a result true. ', B('Replay'), ' is: anyone holding the public act log recomputes the same numbers, without this host and without any chain. A signature says who published these exact bytes. An ', B('anchor'), ' — two hashes posted to a contract on Base by whatever address chose to post them — says a commitment existed by a given moment and was never revised. Neither says the numbers are right, and anyone may anchor anything, so an anchor is worth what its poster is. ', jump('open the epoch chain', 'econ/chain'))),""",
    'the epochs section explains the block, the producer, replay and the anchor',
)

once(
    r"""        P('Try it in the ', B('Economy tab'), ': deposit, close a cycle, burn, watch φ ratchet. ', jump('open economy', 'econ'))),""",
    r"""        P('Try it in the ', B('Economy tab'), ': deposit, close a cycle, burn, watch φ ratchet. ', jump('open economy', 'econ'))),

      sect('The coin on Base: pools, prices and explorers', false,
        P('Two different things here are called PEER. The one this guide has been about is the ', B('epoch token'), ': a number in the act log, minted when an epoch closes, on no chain and in no wallet. The other is an ', B('ERC-20 on Base'), ' — a real token in a real wallet, and the only one of the two a pool can trade. Nothing converts either into the other.'),
        P('A ', B('DEX'), ' is a place two tokens trade against each other with no company in between: a contract holding both sides, where the ratio between them is the price. This app has its own — named pools in its own contract, which is what every button in Pools calls. The same pair can also have a pool on Uniswap: a different contract, with different coins in it, its own price and its own fee tier. This app neither reads it nor routes anything to it.'),
        P(B('Liquidity'), ' is how much of each coin a pool actually holds, and it sits in one pool and nowhere else. The less there is, the further a trade moves the price — so a thin pool moves enormously on a small trade, and coins deposited in one pool do nothing for a trade in the other. Running both splits what depth there is rather than adding it up.'),
        P('A ', B('block explorer'), ' is a public website showing what a chain holds at an address or inside one transaction — basescan, for Base. It is how anything on these screens gets checked against something that is not this page, so every on-chain address and every transaction here carries a link to one. Where this host is configured for another chain there is no link at all: an explorer pointed at the wrong chain does not fail, it draws a confident page about different coins. ', jump('open pools', 'econ/pools'))),""",
    'a guide section for the coin on Base',
)

_data = s.encode('utf-8')          # must be its own line: open() truncates first
io.open(TP, 'wb').write(_data)
print('template.html %d -> %d chars' % (before, len(s)))
