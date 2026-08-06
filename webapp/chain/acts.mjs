// Per-act commitments: the structural part and the payload part, separately.
//
// Deletion here is redaction — a tombstone act appends, and the target's
// content BYTES are rewritten in place (server.mjs redactPostAct): text
// blanked, media dropped, place blanked, `redacted` stamped, and `rmen`
// (resolved mention ids) materialised first so counter parity survives the
// loss of the text. A commitment that covered those bytes would read every
// lawful deletion as tampering.
//
// So each act is committed twice, the way the spec's payload-isolation rule
// prescribes (Appendix H #49):
//
//   structural hash — the act minus {text, media, place, redacted}, with
//     `rmen` materialised for posts and events by exactly the computation
//     redaction itself performs. Invariant under every lawful redaction;
//     any change to it is a change to the record.
//
//   payload hash — {text, media, place} as they stood when the block was
//     sealed. After a redaction this no longer recomputes, ON PURPOSE: the
//     sealed value is the retained commitment residue (Appendix H #54) —
//     proof that a payload existed and of what it was, surviving the
//     payload's removal.

import { hashCanonical } from './canonical.mjs';

// The four seed-world actors exist before any register act and ARE
// mentionable — same table the server keeps (server.mjs SEED_HANDLES).
const SEED_HANDLES = { alice: 'Alice', bob: 'Bob', carol: 'Carol', dave: 'Dave' };

const PAYLOAD_FIELDS = ['text', 'media', 'place'];
const MENTION_KINDS = new Set(['post', 'event']);

function structuralProjection(act, handles, parseMentions) {
  const s = { ...act };
  for (const f of PAYLOAD_FIELDS) delete s[f];
  delete s.redacted;
  if (MENTION_KINDS.has(act.t)) {
    s.rmen = act.rmen !== undefined ? act.rmen : parseMentions(act.text || '', handles);
  }
  return s;
}

function payloadProjection(act) {
  return {
    text: act.text !== undefined ? act.text : null,
    media: act.media !== undefined ? act.media : null,
    place: act.place !== undefined ? act.place : null,
  };
}

/**
 * Walk the file acts once (indices are FILE indices — the in-memory
 * seedWorld act at server position 0 is not a line and is not hashed) and
 * return both hash sequences. The handle map grows as registers pass, and an
 * act's mentions resolve against the map as it stood BEFORE that act — you
 * cannot mention someone not yet registered, and the server's retroactive
 * rmen stamping obeys the same rule, which is what makes this projection
 * redaction-invariant.
 */
export function actCommitments(fileActs, parseMentions) {
  const handles = { ...SEED_HANDLES };
  const structural = [];
  const payload = [];
  for (const act of fileActs) {
    structural.push(hashCanonical(structuralProjection(act, handles, parseMentions)));
    payload.push(hashCanonical(payloadProjection(act)));
    if (act.t === 'register' && act.id) handles[act.id] = act.handle;
  }
  return { structural, payload };
}

/** True when a sealed payload commitment is allowed to differ from the
 *  current bytes: the act carries the redaction stamp. */
export function payloadMayDiffer(act) {
  return act.redacted === true;
}
