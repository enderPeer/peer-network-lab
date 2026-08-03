// Who is allowed to look like whom.
//
// A tester demonstrated the hole by registering two accounts whose displayed
// handle was byte-identical to someone else's — `u_ender1337` and `u_ender1338`
// both wearing "Ender133" — and posting as them. Registration only ever checked
// that the ACT ID was free; the name people actually read was never checked at
// all. On a network whose entire premise is that the record shows who did what,
// a name anyone can wear is not a cosmetic defect.
//
// The fix is a skeleton: a lossy projection of a handle onto the shape a human
// eye actually resolves. Two handles collide when their skeletons match, and
// the second one is refused. This is deliberately aggressive — it will
// occasionally refuse a name somebody genuinely wanted — because the failure it
// prevents is somebody being impersonated, and the failure it causes is
// somebody picking a different name.

/**
 * Characters that render close enough to a Latin letter or digit to fool a
 * reader at a glance. Cyrillic and Greek carry most of the risk: "Еnder" with
 * a Cyrillic Е is a different string and the same picture.
 */
const CONFUSABLE = {
  // Cyrillic → Latin
  'а': 'a', 'в': 'b', 'с': 'c', 'е': 'e', 'н': 'h', 'к': 'k', 'м': 'm',
  'о': 'o', 'р': 'p', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's', 'і': 'l',
  'ј': 'j', 'ԁ': 'd', 'ɡ': 'g', 'ѵ': 'v', 'ԛ': 'q', 'ᴡ': 'w', 'ո': 'n',
  // Greek → Latin
  'α': 'a', 'β': 'b', 'ε': 'e', 'ζ': 'z', 'η': 'h', 'ι': 'l', 'κ': 'k',
  'μ': 'm', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x',
  'γ': 'y', 'σ': 'o', 'ϲ': 'c',
  // Digits and letters that share a shape
  // The classic look-alike families, all folded to one representative:
  // {0,O,o} {1,l,I,i,|} {5,S} {8,B} {2,Z} {6,G}
  '0': 'o', '1': 'l', 'i': 'l', '|': 'l', '5': 's', '8': 'b', '2': 'z', '6': 'g',
  'ı': 'l', 'ł': 'l', 'ø': 'o', 'đ': 'd', 'ƅ': 'b',
};

/**
 * The shape a handle reduces to.
 *
 * Lowercased, decomposed so accents fall away, confusables folded, everything
 * that is not a letter or digit dropped, and runs of the same character
 * collapsed — because "Faable" and "Fable" are one typo apart in reading, not
 * in bytes. Empty means the handle was nothing but decoration.
 */
export function handleSkeleton(handle) {
  const lowered = String(handle ?? '')
    .normalize('NFKD')                       // ﬁ → fi, é → e + combining accent
    .replace(/[̀-ͯ]/g, '')          // drop the combining accents
    .replace(/[​-‏⁠﻿]/g, '') // zero-width space and friends
    .toLowerCase();
  let out = '';
  for (const ch of lowered) {
    const mapped = CONFUSABLE[ch] ?? ch;
    if (!/[a-z0-9]/.test(mapped)) continue;
    if (out[out.length - 1] === mapped) continue; // fable vs faable
    out += mapped;
  }
  return out;
}

/**
 * May `handle` be registered, given everything already registered?
 *
 * `taken` maps skeleton → the handle that claimed it first. Returns null when
 * the name is free, or a sentence naming the clash — because "that name is
 * taken" with no explanation reads like a bug when your name plainly is not
 * the same string.
 */
export function handleClash(handle, taken) {
  const skel = handleSkeleton(handle);
  if (!skel) return 'a handle needs at least one letter or digit';
  const owner = taken.get(skel);
  if (!owner) return null;
  if (owner.toLowerCase() === String(handle).toLowerCase()) {
    return 'the handle ' + owner + ' is already registered';
  }
  return 'that handle reads as ' + owner + ', which is already registered — '
    + 'names that look alike are refused here, because the record is only worth '
    + 'reading if the name on an act identifies one person';
}

/** Build the skeleton→first-owner map from a log. */
export function takenHandles(acts) {
  const taken = new Map();
  for (const a of acts) {
    if (a.t !== 'register' || typeof a.handle !== 'string') continue;
    const skel = handleSkeleton(a.handle);
    if (skel && !taken.has(skel)) taken.set(skel, a.handle);
  }
  return taken;
}
