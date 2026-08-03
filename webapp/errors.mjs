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
    http: 400,
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
    why: 'This act is irreversible — deleting an account, removing a post, revising one — and the handle has no PIN. Without proof of identity, anyone could do it in your name.',
    fix: 'Set a PIN on the handle first. If it has already posted, only the operator can attach one, because nothing in a setPin act proves you wrote any of it.',
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
