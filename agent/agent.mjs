#!/usr/bin/env node
// Peer Network AI test user — fully local, with a persistent memory.
//
// The brain is a small language model (Qwen3-0.6B, GGUF) running on THIS
// machine via node-llama-cpp; no cloud API. Each cycle: read the network
// through /api/v1, digest everything new into a memory file (who does what,
// feedback on the bot's own acts, lessons the model notes for itself), hand
// context + memory to the model, force its answer through a JSON grammar so
// even a 0.6B model always emits a valid action, then perform it. The account
// it runs is an instrument and says so on its profile.
//
//   node agent.mjs --dry            # gather context, print the prompt, write nothing
//   node agent.mjs --init           # label the bot's profile (needs PEER_PIN, no model)
//   node agent.mjs                  # one observe -> learn -> decide -> act cycle
//   node agent.mjs --loop 5         # five cycles
//   node agent.mjs --forever        # run 24/7 (see run-forever.ps1)
//
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader — keeps the PIN out of the repo but available to the
// detached 24/7 process. Real env vars win over the file. Tolerates a UTF-8
// BOM, surrounding quotes, and stray whitespace.
const envFile = path.join(DIR, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
}

const HOST = process.env.PEER_HOST ?? "http://localhost:5210";
const ME = process.env.PEER_AS ?? "u_icesoul";
const PIN = process.env.PEER_PIN ?? "";
const MODEL_PATH = process.env.PEER_MODEL_PATH ?? path.join(DIR, "models", "Qwen3-0.6B-Q8_0.gguf");
const EVERY = Math.max(60, parseInt(process.env.PEER_EVERY ?? "600", 10) || 600); // seconds between 24/7 cycles
const MEM_PATH = path.join(DIR, `memory-${ME}.json`);
const LOCK_PATH = path.join(DIR, `agent-${ME}.pid`);

const ts = () => new Date().toISOString();
const log = (...a) => console.log(ts(), ...a);
const trim = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : s ?? "");
const norm = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ── Peer Network API ────────────────────────────────────────────────────────
// A tunnel or proxy can answer with HTML (502 pages) — never assume JSON.
const parseReply = async (r, p) => {
  let d;
  try {
    d = await r.json();
  } catch {
    d = { error: `non-JSON response` };
  }
  if (!r.ok) {
    const e = new Error(`${p} -> ${r.status} ${d.error}`);
    e.status = r.status;
    e.code = d.code;
    throw e;
  }
  return d;
};
const get = async (p) => parseReply(await fetch(HOST + p), p);
const post = async (p, body) =>
  parseReply(
    await fetch(HOST + p, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    p,
  );

// ── persistent memory: this is how the bot learns ──────────────────────────
const EMPTY_MEM = () => ({
  cursor: 0, // act-log index digested so far
  alertAt: 0, // high-water mark for EDGE-scale alerts (reactions/comments/tags/quotes/mentions)
  dmAt: 0, // high-water mark for ACT-scale alerts (messages/calls) — the two scales differ!
  people: {},
  feedback: [],
  lessons: [],
  acts: [],
  recentTargets: [],
  followed: [],
  dmPeers: [], // ids that have messaged the bot — the only ones it may message back
});

function loadMem() {
  try {
    return { ...EMPTY_MEM(), ...JSON.parse(readFileSync(MEM_PATH, "utf8")) };
  } catch (e) {
    if (existsSync(MEM_PATH)) log(`WARNING: memory file unreadable (${e.message}) — starting fresh`);
    return EMPTY_MEM();
  }
}
// Atomic save: write aside, then rename over — a crash mid-write must not
// wipe everything the bot has learned.
function saveMem(m) {
  writeFileSync(MEM_PATH + ".tmp", JSON.stringify(m, null, 1));
  renameSync(MEM_PATH + ".tmp", MEM_PATH);
}

// The server's alerts mix two index scales: edge-derived alerts carry the
// EDGE-log position, DM/call alerts carry the ACT-log index. One shared
// high-water mark would let the (always larger) edge scale permanently
// swallow new DMs — so each scale gets its own mark.
const isDmAlert = (a) => /^(messaged you|called you)/.test(a?.what ?? "");
const freshAlert = (mem, a) => (isDmAlert(a) ? a.at > mem.dmAt : a.at > mem.alertAt);

// Fold everything that happened since last cycle into memory: who is active
// and what they do, plus every new engagement with the bot's own content.
function digest(mem, { alerts, events }, myHandle) {
  for (const e of events.events ?? []) {
    if (e.at < mem.cursor) continue;
    if (!e.whoHandle || e.whoHandle === myHandle) continue;
    const p = (mem.people[e.whoHandle] ??= { n: 0, last: "", at: 0 });
    p.n++;
    p.last = `${e.what}${e.text ? ": " + trim(e.text, 50) : ""}`;
    p.at = e.at;
  }
  mem.cursor = Math.max(mem.cursor, events.cursor ?? mem.cursor);
  const fresh = (alerts.alerts ?? []).filter((a) => freshAlert(mem, a));
  for (const a of fresh.reverse()) {
    // oldest first
    mem.feedback.push(`${a.fromHandle} ${a.what}${a.target ? ` [${a.target}]` : ""}${a.text ? ": " + trim(a.text, 80) : ""}`);
    if (isDmAlert(a)) {
      mem.dmAt = Math.max(mem.dmAt, a.at);
      if (a.from && a.from !== ME && !mem.dmPeers.includes(a.from)) mem.dmPeers.push(a.from);
    } else {
      mem.alertAt = Math.max(mem.alertAt, a.at);
    }
  }
  mem.feedback = mem.feedback.slice(-8);
  mem.dmPeers = mem.dmPeers.slice(-12);
}

function rememberLesson(mem, note) {
  note = (note ?? "").trim().slice(0, 200);
  const nn = norm(note);
  if (nn.length < 8) return;
  if (mem.lessons.some((l) => norm(l).includes(nn) || nn.includes(norm(l)))) return;
  mem.lessons.push(note);
  mem.lessons = mem.lessons.slice(-15);
}

// ── observing ───────────────────────────────────────────────────────────────
async function observe(mem) {
  const [state, self, feed, alerts, peers] = await Promise.all([
    get("/api/v1/state"),
    get(`/api/v1/whoami?as=${ME}`),
    get(`/api/v1/feed?as=${ME}&sort=cogra&limit=8`),
    get(`/api/v1/alerts?as=${ME}`),
    get("/api/v1/peers"),
  ]);
  // If the host's log ever shrinks (reset, restored backup), resync from its
  // tail instead of waiting forever for a cursor that no longer exists.
  if ((state.cursor ?? 0) < mem.cursor) {
    log(`host log shrank (${state.cursor} < ${mem.cursor}) — resyncing from tail`);
    mem.cursor = Math.max(0, (state.cursor ?? 0) - 50);
  }
  // Everything since the last digested cursor — on the very first run that is
  // the network's whole visible history, which seeds the people map. The
  // endpoint caps a page at 200 events and flags `more`, so page until the
  // head (bounded, in case the log grew absurdly between cycles).
  const events = { events: [], cursor: mem.cursor };
  for (let i = 0, more = true; i < 10 && more; i++) {
    const d = await get(`/api/v1/events?since=${events.cursor}&limit=200`);
    events.events.push(...(d.events ?? []));
    events.cursor = d.cursor ?? events.cursor;
    more = !!d.more && (d.events ?? []).length > 0;
  }
  // Pull the actual conversations behind alerts the bot has NOT yet digested
  // — an alert alone names the post, not the words. Only fresh ones: re-feeding
  // the same thread every cycle forever invites obsession with one target.
  const targets = [
    ...new Set(
      (alerts.alerts ?? [])
        .filter((a) => freshAlert(mem, a))
        .map((a) => a.target)
        .filter(Boolean),
    ),
  ].slice(0, 2);
  const threads = (
    await Promise.all(targets.map((t) => get(`/api/v1/post/${t}?depth=3`).catch(() => null)))
  ).filter(Boolean);
  return { state, self, feed, alerts, peers, events, threads };
}

const handleOf = (peers) => (peers.peers ?? []).find((p) => p.id === ME)?.handle ?? ME;

function renderThread(n, indent, out, budget) {
  if (budget.lines-- <= 0) return;
  out.push(`${indent}[${n.id}] ${n.authorHandle}: ${trim(n.text, 180)}`);
  for (const c of (n.comments ?? []).slice(0, 6)) renderThread(c, indent + "  ", out, budget);
}

function promptOf({ state, self, feed, alerts, peers, events, threads }, mem, name) {
  const item = (p) => `  [${p.id}] ${p.authorHandle}: ${trim(p.text, 200)}`;
  const L = [];
  L.push(`Network: ${state.actors} actors, ${state.posts} posts, epoch ${state.epoch}.`);
  L.push(`You (${name}): energy ${self.energy?.toFixed?.(3) ?? self.energy}, ${self.actsAffordable} acts affordable.`);

  L.push("", "What you remember from earlier cycles:");
  const top = Object.entries(mem.people)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 6);
  L.push(top.length ? "  Active people: " + top.map(([h, p]) => `${h}×${p.n} (${trim(p.last, 60)})`).join("; ") : "  (first cycle — nothing yet)");
  if (mem.feedback.length) L.push("  Feedback on your acts: " + mem.feedback.slice(-4).join(" | "));
  if (mem.dmPeers.length) L.push("  People you may privately message (they wrote to you first): " + mem.dmPeers.join(", "));
  if (mem.acts.length)
    L.push("  Your recent acts: " + mem.acts.slice(-5).map((a) => `${a.a}${a.t ? "→" + a.t : ""}${a.x ? ` "${trim(a.x, 40)}"` : ""}`).join("; "));
  if (mem.lessons.length) {
    L.push("  Lessons you noted:");
    for (const l of mem.lessons.slice(-6)) L.push(`    - ${l}`);
  }

  const al = (alerts.alerts ?? []).slice(0, 5);
  L.push("", "Alerts — people engaging with you, newest first:");
  L.push(
    al.length
      ? al
          .map(
            (a) =>
              `  ${a.fromHandle} ${a.what}${a.target ? ` [${a.target}]` : ""}${a.text ? ": " + trim(a.text, 140) : ""}`,
          )
          .join("\n")
      : "  (none)",
  );
  if (threads?.length) {
    L.push("", "New conversations behind your alerts (reply with target = the id of the message you answer; skip anything that already has an answer):");
    const budget = { lines: 25 };
    for (const t of threads) renderThread(t, "  ", L, budget);
  }
  L.push("", "Your ranked feed:");
  L.push(feed.items?.length ? feed.items.map(item).join("\n") : "  (empty)");
  if (feed.beyondHorizon?.length) {
    L.push("", "More posts (reachable by engaging):");
    L.push(feed.beyondHorizon.slice(0, 4).map(item).join("\n"));
  }
  L.push("", "People (id = follow/message target):");
  L.push(
    (peers.peers ?? [])
      .filter((p) => p.id !== ME)
      .slice(0, 12)
      .map((p) => `  ${p.id} "${p.handle}"`)
      .join("\n"),
  );
  L.push("", `Recent activity, oldest first — [cN] ids are commentable; your own acts show as ${name}:`);
  L.push(
    (events.events ?? [])
      .slice(-20)
      .map(
        (e) =>
          `  #${e.at} ${e.whoHandle ?? "—"} ${e.what}${e.node ? ` [${e.node}]` : ""}${e.text ? ": " + trim(e.text, 100) : ""}`,
      )
      .join("\n"),
  );
  L.push("", "Choose exactly one action now, and optionally note one new lesson.");
  return L.join("\n");
}

// ── the brain: a small local model, grammar-forced into valid JSON ─────────
const systemOf = (name) => `You are ${name}, a small AI bot account on the Peer Network test sandbox. You are openly a bot: a tiny local model (Qwen3-0.6B) run by ender, the developer, to test the network. Real people use this network.

You have a persistent memory. The prompt shows what you remembered from earlier cycles: the people here and what they do, feedback on your acts, and lessons you noted. Use it — refer to what people actually did, and never repeat yourself.

Rules:
- Never pretend to be human. If someone asks what you are, say you are a small local AI model run for testing.
- Never praise the network, the app, or its developer. No "great app" or "this works great" posts, ever.
- Replies must be short, polite, and about what the other person actually wrote. Write in your own words — never copy sentences from the feed.
- Never comment on or react to your own content.
- Only message people who have messaged you first.
- Do not engage the same person twice in a row. Acting costs energy; choosing "nothing" is fine.

Pick ONE action:
- comment: reply to content. target = a content id like c123. text = your reply (under 400 characters).
- react: like or dislike content. target = a content id like c123. polarity from -1 to 1.
- message: private reply to someone who wrote to you. target = their id like u_cam. text = your message.
- follow: follow a person you have not followed yet. target = their id like u_cam.
- post: one short original post — a question or concrete observation. text only, target empty.
- nothing: skip this turn. target and text empty.

Also fill "note": one short NEW observation about this network or a person, worth remembering next cycle — or leave it empty. Notes are private memory, not posts.`;

const SCHEMA = {
  type: "object",
  properties: {
    action: { enum: ["post", "comment", "react", "message", "follow", "nothing"] },
    target: { type: "string", maxLength: 24, description: "c-id for comment/react, u_-id for message/follow, else empty" },
    text: { type: "string", maxLength: 450, description: "body for post/comment/message, else empty" },
    polarity: { type: "number", description: "for react, -1 to 1, else 0" },
    why: { type: "string", maxLength: 160, description: "one short line for the log" },
    note: { type: "string", maxLength: 200, description: "one short new private lesson to remember, or empty" },
  },
  required: ["action", "target", "text", "polarity", "why", "note"],
};

let llama, model, grammar;
async function loadBrain() {
  const { getLlama } = await import("node-llama-cpp");
  llama = await getLlama();
  model = await llama.loadModel({ modelPath: MODEL_PATH });
  grammar = await llama.createGrammarForJsonSchema(SCHEMA);
  log(`model loaded: ${path.basename(MODEL_PATH)} (backend: ${llama.gpu || "cpu"})`);
}

async function decide(prompt, name) {
  const { LlamaChatSession } = await import("node-llama-cpp");
  const context = await model.createContext({ contextSize: 4096 });
  try {
    const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: systemOf(name) });
    const out = await session.prompt(prompt, { grammar, maxTokens: 600, temperature: 0.7 });
    try {
      return JSON.parse(out);
    } catch {
      // Grammar guarantees prefix-valid JSON, but a maxTokens cut can still
      // truncate mid-string. A lost turn, not a lost process.
      return { action: "nothing", target: "", text: "", polarity: 0, why: "model output truncated — skipped", note: "" };
    }
  } finally {
    await context.dispose();
  }
}

// ── validation: a 0.6B model gets guardrails, not trust ────────────────────
function validate(d, { feed, events, peers, threads }, mem, myHandle) {
  const known = new Set();
  const mine = new Set(); // content the bot itself authored — never engage it
  const seen = []; // every text shown to the model — reject echoes of it
  const note = (id, authorHandle, text) => {
    if (id) known.add(id);
    if (id && authorHandle === myHandle) mine.add(id);
    if (text) seen.push(norm(text));
  };
  for (const p of feed.items ?? []) note(p.id, p.authorHandle, p.text);
  for (const p of feed.beyondHorizon ?? []) note(p.id, p.authorHandle, p.text);
  for (const e of (events.events ?? []).slice(-40)) note(e.node, e.whoHandle, e.text);
  const addThread = (n) => {
    note(n.id, n.authorHandle, n.text);
    for (const c of n.comments ?? []) addThread(c);
  };
  for (const t of threads ?? []) addThread(t);
  const people = new Set((peers.peers ?? []).map((p) => p.id));
  const skip = (why) => ({ action: "nothing", target: "", text: "", polarity: 0, why, note: d.note });

  d.target = (d.target ?? "").trim();
  d.text = (d.text ?? "").trim().slice(0, 450);
  // Echo guard: a copied passage buried anywhere in the text must be caught,
  // even behind a novel prefix ("I'm relaying the same message as …"), so
  // compare word 5-grams instead of fixed windows.
  const n = norm(d.text);
  const words = n.split(" ").filter(Boolean);
  const gramsOf = (w, k) => Array.from({ length: Math.max(0, w.length - k + 1) }, (_, i) => w.slice(i, i + k).join(" "));
  const g = gramsOf(words, 5);
  const echoed =
    g.length >= 3
      ? g.filter((x) => seen.some((t) => t.includes(x))).length / g.length > 0.3
      : n.length >= 15 && seen.some((t) => t.includes(n));
  if (echoed) return skip("text is an echo of something already on the network — skipped");
  const repeat = (t) => (mem.recentTargets ?? []).includes(t);
  if (d.action === "comment" || d.action === "react") {
    if (!known.has(d.target)) return skip(`unknown target "${d.target}" — skipped`);
    if (mine.has(d.target)) return skip(`${d.target} is my own content — skipped`);
    if (repeat(d.target)) return skip(`already engaged ${d.target} recently — skipped`);
    if (d.action === "comment" && !d.text) return skip("empty comment — skipped");
  } else if (d.action === "message") {
    if (!mem.dmPeers.includes(d.target)) return skip(`${d.target || "(empty)"} never messaged me — skipped`);
    if (repeat(d.target)) return skip(`already messaged ${d.target} recently — skipped`);
    if (!d.text) return skip("empty message — skipped");
  } else if (d.action === "follow") {
    if (!people.has(d.target) || d.target === ME) return skip(`unknown person "${d.target}" — skipped`);
    if ((mem.followed ?? []).includes(d.target)) return skip(`already following ${d.target} — skipped`);
  } else if (d.action === "post") {
    if (d.text.length < 30) return skip("post empty or filler-short — skipped");
  }
  return d;
}

// ── acting ──────────────────────────────────────────────────────────────────
const clamp = (v) => Math.max(-1, Math.min(1, typeof v === "number" && isFinite(v) ? v : 0.5));

async function act(d) {
  const write = (p, body) => post(p, { as: ME, pin: PIN, ...body });
  const go = () => {
    if (d.action === "post") return write("/api/v1/post", { text: d.text });
    if (d.action === "comment") return write("/api/v1/comment", { target: d.target, text: d.text });
    if (d.action === "react") return write("/api/v1/react", { target: d.target, polarity: clamp(d.polarity) });
    if (d.action === "message") return write("/api/v1/message", { to: d.target, text: d.text.slice(0, 500) });
    if (d.action === "follow") return write("/api/v1/follow", { to: d.target });
    return Promise.resolve(null);
  };
  try {
    return await go();
  } catch (e) {
    if (e.status === 402) {
      // W1 gate: out of energy — burn reserve and retry once, like a user would.
      await write("/api/v1/burn", {});
      return go();
    }
    throw e;
  }
}

// ── main ────────────────────────────────────────────────────────────────────
const flags = process.argv.slice(2);
const dry = flags.includes("--dry");
const forever = flags.includes("--forever");
const li = flags.indexOf("--loop");
const cycles = forever ? Infinity : li >= 0 ? Math.max(1, parseInt(flags[li + 1], 10) || 1) : 1;

const needPin = () => {
  if (!PIN) {
    console.error(`PEER_PIN is not set — writes as ${ME} need its PIN. Nothing was sent.`);
    process.exit(1);
  }
};

// One agent per account: a second instance would double-post and fight over
// the memory file (last writer wins).
function acquireLock() {
  try {
    const pid = parseInt(readFileSync(LOCK_PATH, "utf8"), 10);
    if (pid && pid !== process.pid) {
      process.kill(pid, 0); // throws if not running
      log(`another instance (pid ${pid}) already runs as ${ME} — exiting`);
      process.exit(0);
    }
  } catch {}
  writeFileSync(LOCK_PATH, String(process.pid));
  process.on("exit", () => {
    try {
      if (readFileSync(LOCK_PATH, "utf8") === String(process.pid)) rmSync(LOCK_PATH);
    } catch {}
  });
}

if (flags.includes("--init")) {
  needPin();
  const peers = await get("/api/v1/peers");
  const name = handleOf(peers);
  const bio = `Automated AI test agent (local Qwen3-0.6B) named ${name}, operated by ender. Not a person — I read the network, remember what I see, and post for testing. Say hi and I will answer.`;
  // NOTE: the profile act replaces the whole profile — a link or picture set
  // elsewhere would be dropped. Fine for this bot; don't reuse on human accounts.
  await post("/api/v1/profile", { as: ME, pin: PIN, bio });
  log(`profile of ${ME} now says what it is:\n  "${bio}"`);
  process.exit(0);
}

const mem = loadMem();

async function cycle(n) {
  const ctx = await observe(mem);
  const name = handleOf(ctx.peers);
  digest(mem, ctx, name);
  log(
    `[cycle ${n}] ${ME} "${name}": energy ${ctx.self.energy?.toFixed?.(3)}, ${ctx.self.actsAffordable} affordable, ${ctx.alerts.alerts?.length ?? 0} alerts, memory: ${Object.keys(mem.people).length} people / ${mem.lessons.length} lessons`,
  );
  const prompt = promptOf(ctx, mem, name);
  if (dry) {
    console.log("\n--- system prompt ---\n" + systemOf(name));
    console.log("\n--- user prompt (would go to the local model) ---\n" + prompt);
    console.log("\n--dry: no model call, nothing written, memory not saved.");
    return false;
  }
  const t0 = Date.now();
  const d = validate(await decide(prompt, name), ctx, mem, name);
  log(`  decision (${((Date.now() - t0) / 1000).toFixed(1)}s): ${d.action}${d.target ? " -> " + d.target : ""} — ${d.why}`);
  if (d.text && ["post", "comment", "message"].includes(d.action)) log(`  text: ${d.text}`);
  if (d.note) log(`  note: ${d.note}`);
  rememberLesson(mem, d.note);
  const r = await act(d);
  if (r) {
    if (d.target) mem.recentTargets = [...(mem.recentTargets ?? []), d.target].slice(-6);
    if (d.action === "follow") mem.followed = [...(mem.followed ?? []), d.target].slice(-50);
    mem.acts.push({ i: r.actIndex, a: d.action, t: d.target || "", x: (d.text || "").slice(0, 60) });
    mem.acts = mem.acts.slice(-12);
    log(`  done: act #${r.actIndex}, cursor ${r.cursor}`);
  } else log("  no act this cycle");
  saveMem(mem);
  return true;
}

if (!dry) {
  needPin();
  acquireLock();
  await loadBrain();
}

let failures = 0;
for (let i = 1; i <= cycles; i++) {
  // A wedged cycle (hung native call, dead socket held open) would otherwise
  // sit forever looking alive — exit instead so run-forever.ps1 restarts clean.
  const guard = setTimeout(() => {
    log("cycle wedged for 20 minutes — exiting for a clean restart");
    process.exit(3);
  }, 20 * 60 * 1000);
  try {
    const cont = await cycle(i);
    failures = 0;
    if (!cont) break;
  } catch (e) {
    failures++;
    log(`  cycle failed (${failures} in a row): ${e.message}`);
    if (!forever && cycles === 1) {
      clearTimeout(guard);
      throw e;
    }
    if (failures >= 5) {
      log("5 consecutive failures — exiting for a clean restart");
      process.exit(2);
    }
  } finally {
    clearTimeout(guard);
  }
  if (i < cycles) await new Promise((r) => setTimeout(r, EVERY * 1000));
}
