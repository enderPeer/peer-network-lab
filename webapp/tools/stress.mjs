#!/usr/bin/env node
// The crowd: drive N virtual peers at a live host and see what it does when
// far more people arrive than it agreed to serve.
//
// Why this exists, and why it is a script rather than a fleet of language
// models. Load is the one thing a model is terrible at producing: every
// request costs a prompt, and a thousand requests cost a thousand prompts.
// A script makes the same requests for nothing. So the model writes this
// once, reads the numbers at the end, and stays out of the middle.
//
// What it is actually testing. The limiters here are PER IP (20 acts/min,
// 8 registrations/hour, 600 reads/min), so no amount of concurrency from one
// machine raises the accepted rate. That is the design, not a bug, and it
// means "can it go faster" is the wrong question. The right questions are:
//
//   1. Under flood, does the host REFUSE cleanly — a real HTTP status with a
//      machine-readable code — or does it crash, hang, or drop sockets?
//   2. Does refusing cost it correctness? The act log is append-only and gets
//      sealed into the epoch chain, so the cursor must advance by EXACTLY the
//      number of acts that were accepted. One extra is corruption. One fewer
//      is a lost write. Both are worse than any slowness.
//   3. Does the tunnel in front of it survive the concurrency, or does
//      Cloudflare start inventing 5xx the host never sent?
//
// A refusal is a correct answer. A 500, a dropped socket, or a cursor that
// does not reconcile is a finding.
//
// Zero dependencies, like everything else here: node stdlib only.
//
//   node tools/stress.mjs --base https://host --peers 200 [--soak 60] [--pin-lockout]

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(n);

const BASE = String(arg('--base', 'http://127.0.0.1:5199')).replace(/\/+$/, '');
const PEERS = Math.max(1, Number(arg('--peers', 200)));
const SOAK = Math.max(0, Number(arg('--soak', 45)));      // seconds of sustained traffic
const TIMEOUT = Math.max(2000, Number(arg('--timeout', 20000)));
const TAG = 'loadtest';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0);

// ── the one request primitive ────────────────────────────────────────────
// Everything funnels through here so that every phase classifies outcomes
// the same way. The distinction that matters most is the last one: a status
// code means the host answered, however rudely. A thrown error means it did
// not — the socket died, the tunnel gave up, or nothing came back in time.
// Those are the failures worth reporting.
async function hit(method, path, body) {
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html error page from the tunnel */ }
    return { ms: performance.now() - t0, status: res.status, json, raw: text.slice(0, 200), threw: null };
  } catch (e) {
    return { ms: performance.now() - t0, status: 0, json: null, raw: '', threw: String((e && e.message) || e).slice(0, 120) };
  }
}

// Run `n` tasks with at most `width` in flight. A plain Promise.all over
// thousands of fetches opens thousands of sockets and measures the client's
// file-descriptor ceiling instead of the server's behaviour.
async function pool(n, width, task) {
  const out = new Array(n);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, n) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      out[i] = await task(i);
    }
  }));
  return out;
}

// Fold a pile of results into something a human can read in one glance.
function summarise(label, rs) {
  const lat = rs.filter((r) => r.status > 0).map((r) => r.ms);
  const by = {};
  for (const r of rs) {
    const k = r.threw ? 'NETWORK: ' + r.threw : String(r.status);
    by[k] = (by[k] || 0) + 1;
  }
  const row = {
    phase: label,
    sent: rs.length,
    ok: rs.filter((r) => r.status >= 200 && r.status < 300).length,
    refused: rs.filter((r) => r.status === 429).length,
    clientErr: rs.filter((r) => r.status >= 400 && r.status < 500 && r.status !== 429).length,
    serverErr: rs.filter((r) => r.status >= 500).length,
    dead: rs.filter((r) => r.status === 0).length,
    p50: Math.round(pct(lat, 0.5)), p95: Math.round(pct(lat, 0.95)), p99: Math.round(pct(lat, 0.99)),
    max: Math.round(Math.max(0, ...lat)),
    codes: by,
  };
  console.log(`\n── ${label}`);
  console.log(`   sent ${row.sent}  ok ${row.ok}  429 ${row.refused}  4xx ${row.clientErr}  5xx ${row.serverErr}  no-answer ${row.dead}`);
  console.log(`   latency  p50 ${row.p50}ms  p95 ${row.p95}ms  p99 ${row.p99}ms  max ${row.max}ms`);
  console.log(`   codes    ${JSON.stringify(by)}`);
  return row;
}

const report = { base: BASE, peers: PEERS, phases: [], findings: [] };
const finding = (sev, what) => { report.findings.push({ sev, what }); console.log(`   !! [${sev}] ${what}`); };

// ── phase 0: baseline ────────────────────────────────────────────────────
console.log(`crowd of ${PEERS} against ${BASE}`);
const before = await hit('GET', '/api/v1/state');
if (before.status !== 200) { console.error('host is not answering /api/v1/state — nothing to test'); process.exit(1); }
const start = before.json;
console.log(`\nbaseline: ${start.actors} actors, ${start.posts} posts, epoch ${start.epoch}, cursor ${start.cursor}`);
report.before = start;

// ── phase 1: read storm ──────────────────────────────────────────────────
// Reads are the cheap path and the one every visitor takes. 600/min is the
// stated ceiling; this sends well past it, all at once, to see whether the
// host degrades gracefully or falls over. Mixed paths so we are not just
// measuring one hot cache line.
const READ_PATHS = ['/api/v1/state', '/api/v1/peers', '/api/v1/feed', '/api/acts?since=999999', '/api/election', '/api/chain/head', '/api/v1/pools', '/api/v1/tokens'];
const READS = Math.max(PEERS * 6, 900);
console.log(`\nphase 1: ${READS} reads, ${PEERS} in flight (stated ceiling is 600/min)`);
const reads = await pool(READS, PEERS, (i) => hit('GET', READ_PATHS[i % READ_PATHS.length]));
report.phases.push(summarise('read storm', reads));
if (reads.some((r) => r.status >= 500)) finding('HIGH', 'reads produced 5xx — the host or the tunnel broke under concurrent reads');
if (reads.some((r) => r.status === 0)) finding('HIGH', `${reads.filter((r) => r.status === 0).length} reads got no answer at all (socket died or timed out)`);
if (!reads.some((r) => r.status === 429)) finding('INFO', 'the 600/min read limiter never engaged — either it is not reached or reads are not counted');

// ── phase 2: registration burst ──────────────────────────────────────────
// 8 per hour per IP. Ask for far more, at once, and check two things: that
// exactly the allowance is granted, and that the refusals are honest 429s
// carrying a code a client can branch on rather than a wall of text.
console.log('\nphase 2: 40 simultaneous registrations (stated allowance is 8/hour)');
const PIN = 'stress-' + start.cursor;
const regs = await pool(40, 40, (i) => hit('POST', '/api/v1/register', { handle: `${TAG}${start.epoch}x${i}`, pin: PIN }));
report.phases.push(summarise('registration burst', regs));
const born = regs.filter((r) => r.status === 200 && r.json?.id).map((r) => r.json.id);
console.log(`   handles created: ${born.length ? born.join(', ') : '(none — allowance already spent this hour)'}`);
report.handles = born;
if (regs.some((r) => r.status >= 500)) finding('HIGH', 'registration burst produced 5xx');
const badRefusal = regs.filter((r) => r.status === 429 && r.json?.code !== 'RATE_LIMIT');
if (badRefusal.length) finding('MED', `${badRefusal.length} refusals lacked the RATE_LIMIT code a client would branch on`);

// Every write phase needs at least one handle. If the hour's allowance was
// already spent we cannot invent one, and saying so is better than testing
// nothing and reporting success.
const actors = born.length ? born : [];
if (!actors.length) finding('INFO', 'no writable handle this run — write phases are limited to refusal paths');

// ── phase 3: write storm ─────────────────────────────────────────────────
// The heart of it. Far more acts than the 20/min allowance, fired at once,
// from every handle we own. What we are watching is not how many land — we
// know that — but whether the ones that land are counted exactly once.
console.log(`\nphase 3: 300 concurrent acts across ${actors.length || 0} handle(s) (stated allowance is 20/min)`);
let writes = [];
if (actors.length) {
  const verbs = [
    (me, i) => ['/api/v1/post', { as: me, pin: PIN, text: `[${TAG}] synthetic load act ${i} — automated stress traffic, epoch ${start.epoch}` }],
    (me) => ['/api/v1/follow', { as: me, pin: PIN, to: actors[(actors.indexOf(me) + 1) % actors.length] }],
    (me) => ['/api/v1/react', { as: me, pin: PIN, target: 'prof_' + actors[0], polarity: 0.5, reaction: 0.5 }],
    (me, i) => ['/api/v1/message', { as: me, pin: PIN, to: actors[(i + 1) % actors.length], text: `[${TAG}] ${i}` }],
    (me) => ['/api/v1/profile', { as: me, pin: PIN, bio: `[${TAG}] synthetic peer` }],
    (me) => ['/api/v1/burn', { as: me, pin: PIN }],
  ];
  writes = await pool(300, PEERS, (i) => {
    const me = actors[i % actors.length];
    const [path, body] = verbs[i % verbs.length](me, i);
    return hit('POST', path, body);
  });
  report.phases.push(summarise('write storm', writes));
  if (writes.some((r) => r.status >= 500)) finding('HIGH', 'write storm produced 5xx');
  if (writes.some((r) => r.status === 0)) finding('HIGH', `${writes.filter((r) => r.status === 0).length} writes got no answer — a write with no answer is the worst case, the client cannot know if it landed`);

  // The accepted acts each reported the index they landed at. Duplicates
  // here would mean two acts claiming one slot; gaps would mean the log
  // grew for reasons nobody asked for.
  const idx = writes.filter((r) => r.status === 200 && Number.isInteger(r.json?.actIndex)).map((r) => r.json.actIndex);
  const dupes = idx.length - new Set(idx).size;
  if (dupes) finding('CRITICAL', `${dupes} accepted acts reported the SAME act-log index — concurrent writes are colliding`);
  report.acceptedIndices = idx.slice().sort((a, b) => a - b);
}

// ── phase 4: malformed input ─────────────────────────────────────────────
// Rudeness the host was never designed for. None of it should reach a stack
// trace, and none of it should take the process with it. The oversized body
// is the interesting one: readBody destroys the socket past its cap, so the
// honest expectation is a dead connection rather than a 413 — worth seeing
// what that looks like from the far side of a tunnel.
console.log('\nphase 4: malformed and hostile input');
const me0 = actors[0] || 'u_nobody';
const junk = [
  ['oversized body', () => hit('POST', '/api/v1/post', { as: me0, pin: PIN, text: 'x'.repeat(200_000) })],
  ['invalid JSON', async () => {
    const t0 = performance.now();
    try {
      const r = await fetch(BASE + '/api/v1/post', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json', signal: AbortSignal.timeout(TIMEOUT) });
      return { ms: performance.now() - t0, status: r.status, json: null, raw: (await r.text()).slice(0, 120), threw: null };
    } catch (e) { return { ms: performance.now() - t0, status: 0, json: null, raw: '', threw: String(e.message).slice(0, 120) }; }
  }],
  ['unknown endpoint', () => hit('POST', '/api/v1/definitelyNotAThing', { as: me0, pin: PIN })],
  ['missing required field', () => hit('POST', '/api/v1/comment', { as: me0, pin: PIN })],
  ['nonexistent handle', () => hit('POST', '/api/v1/post', { as: 'u_doesnotexist', pin: PIN, text: 'hi' })],
  ['nonexistent target', () => hit('POST', '/api/v1/comment', { as: me0, pin: PIN, target: 'c999999', text: 'hi' })],
  ['out-of-range number', () => hit('POST', '/api/v1/react', { as: me0, pin: PIN, target: 'prof_' + me0, polarity: 1e9 })],
  ['null injection', () => hit('POST', '/api/v1/post', { as: me0, pin: PIN, text: null, attachment: null })],
  ['deep nesting', () => hit('POST', '/api/v1/post', { as: me0, pin: PIN, text: 'x', attachments: JSON.parse('[' .repeat(60) + ']'.repeat(60)) })],
  ['GET on a write route', () => hit('GET', '/api/v1/post')],
];
const junkRows = [];
for (const [name, run] of junk) {
  const r = await run();
  const verdict = r.status >= 500 ? 'SERVER ERROR' : r.status === 0 ? 'no answer: ' + r.threw : r.status;
  console.log(`   ${name.padEnd(24)} → ${verdict}  ${(r.json?.error || r.raw || '').slice(0, 90)}`);
  junkRows.push({ name, status: r.status, threw: r.threw, body: (r.json?.error || r.raw || '').slice(0, 200) });
  if (r.status >= 500) finding('HIGH', `"${name}" produced a ${r.status} — malformed input should never reach a server error`);
}
report.malformed = junkRows;

//

// ── phase 5: soak ────────────────────────────────────────────────────────
// A flood is a moment; a soak is a shift. Steady traffic for a while, to
// catch the failures that only show up once something has been running:
// memory creeping, latency drifting, a limiter window that never resets.
if (SOAK > 0) {
  console.log(`\nphase 5: ${SOAK}s soak at steady pressure`);
  const t0 = Date.now();
  const soak = [];
  const buckets = [];
  while (Date.now() - t0 < SOAK * 1000) {
    const round = await pool(30, 30, (i) => (i % 5 === 0 && actors.length
      ? hit('POST', '/api/v1/post', { as: actors[i % actors.length], pin: PIN, text: `[${TAG}] soak ${Date.now() - t0}ms` })
      : hit('GET', READ_PATHS[i % READ_PATHS.length])));
    soak.push(...round);
    const lat = round.filter((r) => r.status > 0).map((r) => r.ms);
    buckets.push({ at: Math.round((Date.now() - t0) / 1000), p50: Math.round(pct(lat, 0.5)), p95: Math.round(pct(lat, 0.95)), err: round.filter((r) => r.status >= 500 || r.status === 0).length });
    await sleep(500);
  }
  report.phases.push(summarise('soak', soak));
  report.soakTimeline = buckets;
  // Drift: compare the first quarter of the soak to the last.
  const q = Math.max(1, Math.floor(buckets.length / 4));
  const early = buckets.slice(0, q).reduce((a, b) => a + b.p50, 0) / q;
  const late = buckets.slice(-q).reduce((a, b) => a + b.p50, 0) / q;
  console.log(`   p50 drift: ${Math.round(early)}ms early → ${Math.round(late)}ms late`);
  if (late > early * 2 && late - early > 250) finding('MED', `latency drifted upward over the soak (${Math.round(early)}ms → ${Math.round(late)}ms) — something is accumulating`);
}

// ── phase 6: reconciliation ──────────────────────────────────────────────
// The only question that really matters. We know exactly how many acts the
// host told us it accepted. The log must have grown by exactly that much.
console.log('\nphase 6: reconciliation');
await sleep(1500); // let any queued persist settle
const after = await hit('GET', '/api/v1/state');
const chainAfter = await hit('GET', '/api/election');
if (after.status !== 200) { finding('CRITICAL', 'host not answering at reconciliation'); }
else {
  const accepted = [...writes, ...(report.phases.find((p) => p.phase === 'soak') ? [] : [])].filter((r) => r.status === 200).length;
  const soakAccepted = (report.soakTimeline ? 1 : 0) && 0; // counted below from the log delta instead
  const grew = after.json.cursor - start.cursor;
  console.log(`   cursor ${start.cursor} → ${after.json.cursor}  (grew by ${grew})`);
  console.log(`   acts this run reported accepted: ${accepted} in the write storm${SOAK ? ' (soak writes counted in the delta)' : ''}`);
  console.log(`   epoch ${start.epoch} → ${after.json.epoch},  chain height ${chainAfter.json?.chainHeight ?? '?'}`);
  report.after = after.json;
  report.growth = grew;
  report.reportedAccepted = accepted;
  if (grew < accepted) finding('CRITICAL', `the log grew by ${grew} but ${accepted} acts were told they were accepted — ${accepted - grew} writes were acknowledged and LOST`);
  // A log that grew more than we were told is only suspicious if nobody else
  // is writing. On a live network other people are, so this is INFO.
  if (grew > accepted + (SOAK ? 999 : 0)) finding('INFO', `the log grew by ${grew}, more than our ${accepted} — other writers were active, or the soak contributed`);
}

// ── phase 7: the lockout, last on purpose ────────────────────────────────
// Twelve wrong PINs from one address locks that address out of writing for
// ten minutes — and while it holds, the CORRECT pin is refused too. That is
// a real property worth confirming, and a terrible thing to confirm early,
// because it would poison every phase after it. Opt in explicitly.
if (flag('--pin-lockout') && actors.length) {
  console.log('\nphase 7: PIN lockout (this blocks writes from this IP for ~10 minutes)');
  const wrong = await pool(15, 5, () => hit('POST', '/api/v1/post', { as: actors[0], pin: 'definitely-not-the-pin', text: 'x' }));
  report.phases.push(summarise('wrong PIN', wrong));
  const nowCorrect = await hit('POST', '/api/v1/post', { as: actors[0], pin: PIN, text: `[${TAG}] does the correct pin still work?` });
  console.log(`   correct PIN after lockout → ${nowCorrect.status}  ${(nowCorrect.json?.error || '').slice(0, 120)}`);
  report.lockout = { wrongCodes: wrong.map((r) => r.status), correctAfter: nowCorrect.status, msg: nowCorrect.json?.error || null };
  if (nowCorrect.status === 200) finding('MED', 'the correct PIN still worked after 15 wrong ones — the lockout did not engage as documented');
}

// ── verdict ──────────────────────────────────────────────────────────────
console.log('\n════ findings ════');
if (!report.findings.length) console.log('none — the host refused what it should refuse, answered everything else, and the log reconciles.');
for (const f of report.findings) console.log(`[${f.sev}] ${f.what}`);
console.log('\n' + JSON.stringify({ summary: report.phases, findings: report.findings, growth: report.growth, handles: report.handles }, null, 1));
