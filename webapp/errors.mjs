// Every refusal this network can hand you, with a reason.
//
// The messages here were already specific — they name the number you sent and
// the limit you hit — but a specific message still only says WHAT happened. On
// a network whose rules are unusual (posting costs something; a vouch can lower
// the standing of the person you back; deleting content leaves the record), the
// question people actually ask is WHY, and answering it in the moment is worth
// more than any amount of documentation nobody opens.
//
// So every refusal carries four things:
//
//   code   a stable identifier a bot can branch on, and that survives rewording
//   error  the sentence, naming the actual numbers
//   why    the mechanism — what rule produced this, and what it is protecting
//   fix    the next action, or an honest statement that there is not one
//
// The codes are stable API. Reword `error` freely; changing a `code` breaks
// callers, so treat it the way you would treat a URL.

/**
 * @typedef {{ http: number, why: string, fix: string }} ErrorSpec
 */

/** @type {Record<string, ErrorSpec>} */
export const CATALOGUE = {
  // ── The economy ─────────────────────────────────────────────────────────
  NO_ENERGY: {
    // 402 Payment Required, which is what the door actually answers and what
    // GET /api/v1 documents ("the host refuses the act with 402, gate W1").
    // This table said 400 — so a caller who trusted statusFor() branched on a
    // status the network never sends for this code.
    http: 402,
    why: 'Every act debits θ = 0.0528066 of burned reserve, and yours is spent. This is the whole anti-spam design: talk is priced, so nobody can flood the network without paying for it in destroyed value.',
    fix: 'Burn more reserve. Note that burning raises your balance but not your act count, so it also raises your commitment rate.',
  },
  RATE_TOO_LOW: {
    http: 400,
    why: 'Your commitment rate — burned reserve divided by acts — fell below the safety wall at 0.528. Acting lowers it; burning raises it. Nothing was taken from you: the denominator grew.',
    fix: 'Burn reserve to lift the rate back over the wall. Acting more will lower it further.',
  },

  // ── Identity ────────────────────────────────────────────────────────────
  HANDLE_TAKEN: {
    http: 400,
    why: 'Handles are unique by the shape a reader resolves, not by their bytes. Case, punctuation, zero-width characters, fullwidth digits, Cyrillic and Greek look-alikes and the 0/O, 1/l/I, 5/S, 8/B families all fold to the same name. Two accounts wearing one name is impersonation, and it was demonstrated here.',
    fix: 'Pick a name that reads differently, not one that only differs in bytes.',
  },
  NO_SUCH_HANDLE: {
    http: 400,
    why: 'The act names an account that was never registered. Without this check anyone could post as anyone — and acts from accounts that do not exist also crashed every replay, which took the host down once.',
    fix: 'Register the handle first, or correct the id.',
  },
  PIN_WRONG: {
    http: 401,
    why: 'This handle is PIN-secured and the PIN did not match. The check is constant-time, so a wrong PIN takes exactly as long as a right one and tells an attacker nothing.',
    fix: 'Try again, or add a passkey so you stop depending on a short secret.',
  },
  PIN_REQUIRED: {
    http: 401,
    why: 'This act is irreversible or decides where money goes — deleting an account, removing a post, revising one, binding the ethereum address your epoch earnings are paid to — and the handle has no credential of any kind. Without proof of identity, anyone could do it in your name.',
    fix: 'Set a PIN on the handle, or attach a passkey — either one is enough. If it has already posted, only the operator can attach the first credential, because nothing in a setPin act proves you wrote any of it.',
  },
  PASSKEY_REQUIRED: {
    http: 401,
    why: 'This handle is secured with a passkey and has no PIN, so a PIN cannot open it — there is nothing stored to compare one against. This used to read as "no credential" and refused the handle outright, which locked the strongest credential here out of binding an address, and quietly meant a passkey alone verified nothing.',
    fix: 'POST /api/auth/challenge for a fresh challenge, sign it with the passkey, and send the assertion object as `auth` instead of a PIN string.',
  },
  HANDLE_UNCLAIMABLE: {
    http: 401,
    why: 'This handle has already acted and has no PIN. Letting anyone attach one would mean whoever claimed it first owned the name — which is exactly how a tester lost their account here.',
    fix: 'Ask the instance operator to set a PIN for you.',
  },
  PIN_ATTEMPTS: {
    http: 429,
    why: 'Too many failed PIN attempts from one address. Online guessing is throttled; offline guessing is handled separately by storing PINs with PBKDF2 and a per-account salt.',
    fix: 'Wait a few minutes. If it was not you, that is worth knowing — and a passkey would end the problem.',
  },
  PASSKEY_REFUSED: {
    http: 401,
    why: 'The passkey signature did not check out. That can mean a replayed or expired challenge, a signature made for a different site, or a credential that is not registered to this handle. Each of those is a real attack that the check exists to stop.',
    fix: 'Ask for a fresh challenge and sign again on the site you are actually on.',
  },

  // ── Content and limits ──────────────────────────────────────────────────
  TOO_LONG: {
    http: 400,
    why: 'Text is carried by the network and stored in a log every participant downloads, so length is capped. The limit is not about the content; it is about what everyone else has to fetch forever.',
    fix: 'Shorten it, or split it across two acts — each costs θ.',
  },
  NOT_YOURS: {
    http: 400,
    why: 'Only the author can revise or remove their own record. Removal takes the payload and never the record, and it is not yours to remove what other people wrote.',
    fix: 'If it needs answering rather than removing, comment on it — commentary outlives its subject here.',
  },
  UNKNOWN_TARGET: {
    http: 400,
    why: 'The act points at a content id that was never minted. Such acts used to be accepted and charged for; eighteen of them sit in the record reading as "something since removed", which is why this is refused now. The id counter also ticks for hyperedge legs, so an id derived by counting posts will be wrong.',
    fix: 'Read the id from /api/v1/events (the `node` field) or from the feed rather than deriving it.',
  },
  ALREADY_DELETED: {
    http: 400,
    why: 'That content has already had its payload removed. Deletion is not repeatable, and the record of the act itself deliberately stays.',
    fix: 'Nothing to do — it is already gone.',
  },
  ACCOUNT_DELETED: {
    http: 410,
    why: 'This account was deleted. Deletion here removes what someone wrote and keeps that they wrote it, so their past acts still hold the graph together — but nothing more can be done as them.',
    fix: 'Register a new handle. The old one cannot be reclaimed.',
  },

  // ── Rate and capacity ───────────────────────────────────────────────────
  RATE_LIMIT: {
    http: 429,
    why: 'More acts arrived from one address than this host accepts per minute. This is a transport-level guard on top of the θ cost, not a substitute for it.',
    fix: 'Slow down. A bot that posts constantly also dilutes its own rate until the network stops carrying it.',
  },
  TOO_LARGE: {
    http: 413,
    why: 'The whole act, once serialised, exceeds what this host will store. Media is capped separately and by type.',
    fix: 'Attach less, or compress it before uploading.',
  },
  STORE_FULL: {
    http: 507,
    why: 'The media store on this test instance is full. Blobs no surviving act references are collected automatically, but only after an hour, because a young orphan is usually somebody\'s unfinished draft.',
    fix: 'Try again later, or ask the operator to collect unreferenced media.',
  },

  // ── This host ───────────────────────────────────────────────────────────
  BURN_UNVERIFIED: {
    http: 400,
    why: 'A burn is only a burn if the chain says so. The host asked two independent public block explorers about that transaction and did not get an answer it could act on: either the transaction does not exist, or it pays nothing to the dead address, or it is not confirmed yet, or the explorers disagreed about what it paid. Recording it on any of those answers would put a number in a permanent public record that nobody could check.',
    fix: 'Check the txid on any block explorer yourself. If you have just sent it, wait for confirmations — an unconfirmed transaction can still be replaced, so it does not count until it is mined.',
  },
  BURN_OFF: {
    http: 404,
    why: 'Proof of burn is not switched on for this host: no burn address is configured, so there is nothing to verify against and nowhere to send anything.',
    fix: 'Nothing you can do from here. The operator sets a burn address, or this network simply does not use burns.',
  },
  BURN_ALREADY_CLAIMED: {
    http: 409,
    why: 'That transaction is already recorded. A burn counts once, whoever presents it — otherwise one payment could be replayed into unlimited weight, which is the same as no cost at all.',
    fix: 'If it is your burn and it is credited to another handle, the burn was claimed before you got to it. Bind future burns quickly, and remember the log shows exactly which handle holds which txid.',
  },
  // ── Burning PEER: the second door into reserve ──────────────────────────
  // Reserve is value destroyed, and there are now two ways to destroy it.
  // They are NOT equally provable, and every refusal below says so where it
  // matters: a bitcoin burn pays a script that cannot be satisfied, which
  // anyone can check by arithmetic, while a PEER burn pays an address nobody
  // is believed to hold a key for. Both destroy value; only one is a proof.
  PEER_BURN_HOST_ONLY: {
    http: 400,
    why: 'A PEER burn cannot be self-declared, and neither can its price. The host verifies two separate things before it records one: that an ERC-20 Transfer really destroyed that many PEER at the dead address, and what the official PEER/cbBTC pool held across the whole averaging window. Letting a client supply either would make the mechanism a statement about itself — and letting a client supply the price would be an oracle attack that never has to touch a pool.',
    fix: 'Send the transaction hash to the PEER burn endpoint and let the host read the chain. Never send a price; it will not be believed.',
  },
  PEER_BURN_MISPRICED: {
    http: 400,
    why: 'The act records a satoshi value that its own recorded pool reserves do not produce. Replay recomputes the price from the reserves in the act and refuses any disagreement, because a host that records a price and a value which do not match each other is either broken or lying — and this is the one place that gets caught rather than trusted. Nothing here is fetched during replay: the act carries what was verified, so the act must also survive being checked against itself.',
    fix: 'Nothing from your side. This is a defect in the host that wrote the act, and the burn itself is untouched — it can be claimed correctly by a host that computes it right.',
  },
  PEER_BURN_THIN_POOL: {
    http: 400,
    why: 'The PEER/cbBTC pool is too shallow to have a price. Constant-product price is whatever the last trade left behind, so in a thin pool an attacker can pump it, burn PEER at the inflated rate, take the reserve and let it fall — buying the right to speak with a rounding error. Below the minimum depth a burn is refused in words rather than priced badly.',
    fix: 'Wait for the pool to be deep enough, or use the bitcoin door, which has no price to manipulate and therefore no depth requirement.',
  },
  PEER_BURN_STALE_PRICE: {
    http: 400,
    why: 'The price behind this burn was not averaged over a long enough window, or came from too few observations. A spot price is one block of history and can be bought for the length of one block; a time-weighted price has to be held against every arbitrageur for the whole window, at the manipulator\'s own expense. The window length is a choice about the price of speech, not a discovered quantity.',
    fix: 'Try again once the host has a full window of observations for the pool.',
  },
  // The four below are the HOST DOOR's half of this door — the refusals that
  // happen before an act exists, where the five above are replay's, which
  // happen to acts already written. Both halves have to exist: a door check
  // stops a burner destroying PEER for nothing, and a replay check is what
  // makes the rule true on every host rather than on this one.
  PEERBURN_OFF: {
    http: 404,
    why: 'Burning PEER for reserve is not switched on here. It is priced by ONE pool — a factory address and a pool id an operator configured — and with none configured there is no price. That is the shipped state: no pools factory is deployed and no PEER/cbBTC pool exists yet, so this host says so rather than guessing a rate. A guessed rate would be an invented exchange rate for the right to speak, which is worse than a closed door.',
    fix: 'Burn bitcoin instead — that door needs no price and no pool: GET /api/burn. If you run this host, set PEER_PEERBURN_FACTORY and PEER_PEERBURN_POOL_ID to a pool you chose yourself.',
  },
  PEERBURN_NO_BINDING: {
    http: 400,
    why: 'A transfer on Base names the address that sent it, and nothing else. What ties that address to a handle here is a bindAddress act — filed with your own credential, public in the log — and without one there is no honest way to say a burn is yours. The bitcoin door has the same problem and solves it with intents, because a bitcoin output names no sender; this door does not need them, precisely because the transfer does.',
    fix: 'Bind the address you will burn from, then send the PEER from that address. In that order: a binding filed after the coins are destroyed cannot reach them. The binding is the same one epoch earnings are paid to.',
  },
  PEERBURN_UNOWNED: {
    http: 400,
    why: 'The log does not say that address is yours. A burn belongs to the handle that had bound the sending address — exactly one handle, and it must be yours. An address nobody bound belongs to nobody. An address TWO handles have bound belongs to neither of them, and that is deliberate rather than an oversight: the alternative rules both end in theft. If the newest binding won, anyone could bind your address and take the reserve your coins bought — which was demonstrated against this host, end to end, for 24.99 reserve. If the first binding won, pre-binding a stranger\'s address would do the same thing silently. So ambiguity shuts this door for that address instead, which costs a burn and never hands one to somebody else.',
    fix: 'Burn from an address only your handle has bound, and bind it before you burn. If somebody else has bound your address, bind a fresh one and use that: nothing can be taken from you here, but that particular address can no longer be used for this door.',
  },
  PEERBURN_BOUND_AFTER_BURN: {
    http: 400,
    why: 'That address is bound to your handle, but the binding was filed after the block that destroyed the coins, so it cannot reach them. The uncredited list is public — it has to be, or nobody could see their own burn sitting there — and if binding afterwards worked, that list would be a shopping list: anyone could bind the address a stranger burned from and collect the reserve, permanently, because a burn is claimed once. The order is the whole protection.',
    fix: 'Nothing recovers this particular burn: the coins are destroyed and no binding filed now can claim them. Bind first from here on, then burn from the bound address, and the host credits it on its own.',
  },
  PEER_BURN_POOL_CAP: {
    http: 429,
    why: 'The pool this burn is priced against has already created as much reserve this epoch as it holds bitcoin. That bound exists because the per-account ceiling on its own bounds nothing: handles are free and open at zero, so three hundred of them filling the ceiling once against a pool holding 1,000,000 satoshis created 2,710,000 satoshis of "value destroyed" — more than the pool could ever have paid out, against a definition of reserve that is value destroyed measured in satoshis. Burning does not move the reserves, so every burn is priced as if it were the first; this is what stops that from being a mint.',
    fix: 'Nothing is lost. The burn is on-chain and stays valid, and what is left of it is claimable after the next epoch closes — or burn bitcoin, which is priced against nothing and capped by nothing.',
  },
  PEERBURN_UNVERIFIED: {
    http: 400,
    why: 'The chain does not show what was claimed. The host checks a transaction hash for a Transfer of THIS network\'s PEER, from the address bound to your handle, to the dead address, in a transaction that succeeded — and records nothing unless all of it is true. Anyone can deploy a token, mint a trillion of it and destroy it for the price of gas, so the token address is checked as carefully as the amount.',
    fix: 'Check the hash on any Base explorer. If the transfer is there and this host disagrees, the act log carries the hash for exactly that reason — the disagreement is checkable by anyone, against any endpoint.',
  },
  PEERBURN_UNCONFIRMED: {
    http: 400,
    why: 'The transaction is not buried deeply enough yet. A transfer that can still be un-mined is not a destruction. Note honestly what depth means here: Base is a rollup whose sequencer can reorganise unsafe blocks, so a confirmation count is protection against the ordinary case and not the settlement guarantee the same phrase means on Bitcoin.',
    fix: 'Nothing. The host watches the dead address and credits the burn on its own once it is deep enough, whether or not you are still connected.',
  },
  PEERBURN_ALREADY_CLAIMED: {
    http: 409,
    why: 'That Base transaction is already recorded. A burn counts once, whoever presents it — otherwise one destruction could be replayed into unlimited standing, which is the same as it costing nothing. Bitcoin burns and PEER burns are deduplicated in separate tables, because they are different chains and a hash from one must never satisfy a claim about the other.',
    fix: 'Nothing to do — the reserve from that burn is already credited to the handle whose bound address sent it, and the log says which.',
  },
  PEER_BURN_CAP: {
    http: 429,
    why: 'Burning PEER creates a bounded amount of reserve per account per epoch, and this handle has used its allowance. The ceiling exists because this door has a PRICE and a price can be lied to: it bounds what a manipulated window could ever buy. The bitcoin door has no such ceiling and needs none — nobody manipulates the price of bitcoin to themselves. Note also what a PEER burn never buys at any size: it credits reserve only, and never touches the weight that decides a share of the epoch mint or a vote in the writer election.',
    fix: 'Nothing is lost, and that sentence is now true — it was not always. A burn worth more than one whole epoch\'s allowance used to be refused entire, in every epoch, forever, while this line promised the remainder. The act records the slice it credits, so the rest of a large burn is credited an epoch at a time until it is finished, by the host\'s own watcher, without you doing anything. Or burn bitcoin, which is uncapped.',
  },
  ONCHAIN_OFF: {
    http: 404,
    why: 'No on-chain token is configured for this host. A token address written into source code is one nobody verified, so this stays off until an operator points it at a deployment they made and checked themselves.',
    fix: 'Nothing from here. The network still works — the token is an addition to it, not a requirement.',
  },
  MIRROR_READONLY: {
    http: 503,
    why: 'You reached a read-only mirror rather than the primary. Two hosts accepting acts would fork the log the first time both were reachable, and there is no merge — acts are ordered, and two orders are two networks.',
    fix: 'Nothing: the app finds the primary by itself while it answers. If the primary is gone for good, the operator promotes this mirror.',
  },
  ENGINE_LOADING: {
    http: 503,
    why: 'The host has not finished loading the protocol engine, so it cannot yet compute the state an act must be checked against. It refuses rather than guessing.',
    fix: 'Retry in a moment.',
  },
  BLOCKED: {
    http: 403,
    why: 'The operator has blocked this address. You are told rather than silently dropped, because a blocked person who can read the reason can argue with it.',
    fix: 'Contact the operator if you think this is wrong.',
  },

  // ── Tokens and pools ────────────────────────────────────────────────────
  INSUFFICIENT_BALANCE: {
    http: 400,
    why: 'You do not hold as much of that asset as the act would move — buying a placement counts here too, since an advert is paid for in tBTC and the payment is burned. Balances are derived from the log by replay, so what the interface showed may already be one act out of date.',
    fix: 'Reload and check the balance, then send the amount you actually have.',
  },
  SLIPPAGE: {
    http: 400,
    why: 'The pool moved between the quote you saw and the act arriving, so the trade would have filled below your minimum. Constant-product pools reprice on every swap, and somebody traded first.',
    fix: 'Ask for a fresh quote. Raising your tolerance means accepting a worse price, not avoiding one.',
  },
  POOL_EXISTS: {
    http: 400,
    why: 'A pair has exactly one pool whichever way you name it, so that liquidity is not split across two prices for the same two assets.',
    fix: 'Add liquidity to the existing pool instead of creating a second one.',
  },
  ALREADY_CLAIMED: {
    http: 400,
    why: 'tBTC is claimable once per account, ever. It is sandbox value with a bitcoin-shaped name, backed by nothing, and a repeatable faucet would make even that meaningless.',
    fix: 'Trade for more in a pool, if anyone is selling.',
  },
  SYMBOL_TAKEN: {
    http: 400,
    why: 'That asset symbol already exists. PEER and tBTC in particular are reserved and cannot be shadowed, because an asset pretending to be another is the same trick as a handle pretending to be another.',
    fix: 'Pick a different symbol, 3-8 characters, A-Z and digits.',
  },

  // ── Epoch earnings, on a chain ──────────────────────────────────────────
  BAD_ADDRESS: {
    http: 400,
    why: 'Binding is the one act here that points at money outside this network: it says where a handle\'s epoch earnings are payable on Base, and the earnings tree is built over addresses rather than handles. So the address is checked to the byte — 0x and exactly 40 hex characters — and the zero address is refused outright, because nobody holds its key and anything paid there is destroyed. What cannot be checked is a typo: the EIP-55 checksum needs keccak-256, and nothing in this codebase hashes with a library.',
    fix: 'Paste the address from your wallet instead of typing it. If you bound the wrong one, bind again — the newest binding wins, and it takes effect from the next epoch close.',
  },
  EPOCH_NOT_CLOSED: {
    http: 404,
    why: 'Earnings exist only for an epoch that has CLOSED. The distribution is computed at close, from engagement inside that epoch, and until then there is no share to prove and no root to publish. An epoch number beyond the last close is a question about the future.',
    fix: 'GET /api/v1/tokens for how many epochs have closed (emission.epochsClosed), then ask for one of those.',
  },

  // ── Adverts ─────────────────────────────────────────────────────────────
  ADS_CLOSED: {
    http: 400,
    why: 'This instance has no payment address configured, so it cannot quote anyone. The host holds no keys and never generates an address; the operator pastes one from their own wallet.',
    fix: 'Ask the operator to configure PEER_BTC_ADDRESS.',
  },
  AD_NOT_APPROVED: {
    http: 400,
    why: 'An advert has to be read by a person before it can be paid for. Approval is what tells the advertiser to send anything, so it cannot be skipped.',
    fix: 'Wait for review. Do not send payment before the status reads "approved".',
  },
  BAD_URL: {
    http: 400,
    why: 'An advert link must be a plain http(s) URL. javascript:, data: and the rest are refused because an advert is shown to everyone and a link is the one thing they will click.',
    fix: 'Use an ordinary https link.',
  },

  // ── Live streaming ──────────────────────────────────────────────────────
  STREAM_NEEDS_PIN: {
    http: 403,
    why: 'A broadcast puts a face and a voice on a handle, so this host will only carry one for a handle that is PIN-protected. Ordinary posts are allowed from an unsecured handle; a live stream is not, because there is no way for a viewer to tell afterwards that it was not you.',
    fix: 'Set a PIN on the account first (Settings, then Security), and start the broadcast again.',
  },
  STREAM_BUSY: {
    http: 503,
    why: 'This host is already carrying as many simultaneous broadcasts as it will. The limit is deliberate: video is the only thing here that can take the upstream away from every other person using the network.',
    fix: 'Wait for a broadcast to end, or ask the operator to raise the limit if the machine has room.',
  },
  STREAM_NOT_LIVE: {
    http: 404,
    why: 'No broadcast is running under that id. Being live is not recorded in the act log — it is a connection that exists or does not — so a stream that has ended leaves nothing to join.',
    fix: 'Refresh the live list. The post the broadcast was attached to is still there with its comments.',
  },
  STREAM_FORMAT: {
    http: 415,
    why: 'The broadcaster is sending a video format this browser cannot decode, and cannot produce one it can. No single format plays everywhere: iPhone Safari refuses WebM, and Firefox cannot record MP4.',
    fix: 'Watch from a different browser, or ask the broadcaster to stream from one that can produce MP4.',
  },
  STREAM_RATE: {
    http: 429,
    why: 'The broadcast is pushing more bits per second than this host will relay. Every viewer costs the host that same rate again, so an unbounded broadcaster is an outage for everyone else.',
    fix: 'Lower the quality and start again. The host reports its ceiling in the refusal.',
  },

  // ── Shape ───────────────────────────────────────────────────────────────
  BAD_REQUEST: {
    http: 400,
    why: 'The act was malformed — a missing field, a value out of range, or a number that was not finite. Shape is checked before anything else so that no arithmetic ever sees a NaN.',
    fix: 'Check the act against GET /api/v1, which lists every verb and its fields.',
  },
  CONFLICT: {
    http: 409,
    why: 'The log moved while you were composing. Acts are ordered, and yours was written against a state that is no longer the newest one.',
    fix: 'Fetch the acts you are missing and retry. The response includes them.',
  },
  NOT_FOUND: {
    http: 404,
    why: 'No such endpoint or object on this host. If you expected one, it may be an endpoint a newer host has and this one does not — the API document lists exactly what this host answers, and hosts are not all on the same build.',
    fix: 'GET /api/v1 lists everything this host answers.',
  },
};

/**
 * Build a refusal body.
 *
 * `error` stays the human sentence — the one that names your actual numbers —
 * and the catalogue supplies the standing explanation. A code with no entry
 * still works and is reported honestly as unexplained, rather than silently
 * dropping the fields callers depend on.
 */
export function refusal(code, message) {
  const spec = CATALOGUE[code];
  return {
    error: message,
    code,
    why: spec ? spec.why : 'No explanation is catalogued for this refusal yet, which is a gap worth reporting.',
    fix: spec ? spec.fix : 'Report it: https://github.com/enderPeer/peer-network-lab/issues',
    docs: '/api/v1/errors',
  };
}

/** HTTP status for a code, defaulting to 400. */
export function statusFor(code) {
  return (CATALOGUE[code] && CATALOGUE[code].http) || 400;
}

/** The whole catalogue, for GET /api/v1/errors. */
export function catalogueDocument() {
  return {
    note: 'Every refusal carries a stable `code`, the sentence in `error`, the mechanism in `why`, and the next step in `fix`. Branch on `code` — the wording of `error` may change, codes do not.',
    count: Object.keys(CATALOGUE).length,
    errors: Object.entries(CATALOGUE)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, spec]) => ({ code, http: spec.http, why: spec.why, fix: spec.fix })),
  };
}
