# Porting conventions — ender-engine (READ FIRST, FOLLOW EXACTLY)

The goal is a bit-exact port: `canonical(epochPackage)` must reproduce the
JS bytes for every close in two real logs. These rules exist because any
deviation shows up as a hash divergence three layers away.

## Floats
- NEVER call `f64::powf/exp/ln/round/tanh`. Use `ender_jsmath::{js_pow,
  js_exp, js_tanh, js_log, js_round}` — they are bit-identical to V8
  (proven against 19k vectors).
- `Math.floor` → `f64::floor`, `Math.sqrt` → `f64::sqrt`, `Math.abs` →
  `f64::abs`, `Math.max/min` → `f64::max/min` BUT check NaN semantics at
  each site: JS `Math.max(NaN, x)` is NaN while Rust's `f64::max` prefers
  the non-NaN operand; if a site can see NaN, write it out with explicit
  comparisons matching JS. `Math.sign` → write out (JS returns ±0/NaN
  faithfully).
- Copy arithmetic EXPRESSION TREES token for token. JS
  `Math.floor(pool * tw / twTotal * 1e6) / 1e6` must stay
  `(pool * tw / twTotal * 1e6).floor() / 1e6` — same association, same
  order. Do not refactor, simplify, or "hoist" float math.
- Integer-ish JS numbers stay f64 unless the map says the JS uses BigInt.
  JS BigInt paths (peerBurn pricing, raw amounts) → `num_bigint::BigInt`
  (or u128 ONLY if the map proves bounds).
- `x | 0`, `>>> 0`, `~~x` etc.: port the exact 32-bit coercion semantics
  (`as i32`/`as u32` after JS ToInt32 rules — f64 as i32 in Rust saturates,
  JS wraps; use a `to_int32()` helper for any value that can exceed i32).

## Maps and iteration order
- Every JS `bare()` / `{}` accumulation map → `indexmap::IndexMap<String, _>`.
  JS for-in order = integer-like keys ascending FIRST, then insertion
  order. Our keys are ids/symbols (never integer-like) — assert with
  `debug_assert!(!key_is_integer_like(k))` via the helper in `state.rs`.
- JS `Object.keys(m).sort()` → collect keys, sort by
  `a.encode_utf16().cmp(b.encode_utf16())` (helper `utf16_sort` in
  `state.rs`) — NOT Rust's default string order.
- Deleting a key mid-iteration, re-assignment keeping position: IndexMap's
  shift_remove preserves JS delete semantics (order of remaining keys);
  never swap_remove.

## JS semantics helpers (in `state.rs` — use them, don't reinvent)
- `truthy(&Value)` — JS ToBoolean.
- `js_str(&Value)` — field as &str if string, else None.
- `js_num(&Value)` — JS ToNumber for the cases the map documents.
- String comparison `<` in JS (e.g. poolId) is UTF-16 code-unit order —
  use the helper.
- `String(x)` / `.toString()` on numbers → `ender_canonical` number
  formatting (ryu-js), NEVER Rust's `{}` for f64.

## Acts
- Acts arrive as `serde_json::Value` (already parsed). Access fields via
  the helpers; a missing field is JS `undefined` — mirror each branch's
  handling exactly (undefined vs null vs '' are three different things).
- Unknown/invalid acts are SKIPPED, never errors. The fold never fails.
- Refusal-message strings (tokenActError etc.) are API: byte-for-byte.

## Structure
- Cite the JS line range you ported at the top of each function:
  `// replay.cjs 969-1126`. Do not add other narrative comments.
- No `unsafe`, no threads, no HashMap in state, no early-exit
  "optimizations" that change visit order.
- If the JS does something you cannot port faithfully, STOP and record it
  in your report — do not approximate silently.
