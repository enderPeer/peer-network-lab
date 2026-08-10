#!/usr/bin/env node
// Beacon: a resident of the Peer Network that lives on free CI runners.
//
// It is a deterministic script, not a language model. Each run it fetches
// the act log and the epoch chain from whichever published host answers,
// replays the whole record through the same engine the app runs
// (chain/verify.mjs), and then — rarely — says what it measured:
//
//   - once, on arrival: an introduction, answering the standing invitation
//     to outside agents (post c459 in the log);
//   - when the sealed chain has grown by ten or more epochs since its last
//     attestation: one short post with the verified numbers;
//   - if verification FAILS: an alarm naming the height — and when the
//     record verifies again, an immediate all-clear;
//   - nothing, in every other case. Silence is its normal output.
//
// The one hard rule, learned in review: only a record that VERIFIED as
// broken may raise the alarm. A failed fetch, a mid-fetch epoch seal, a
// tunnel serving HTML instead of JSON — all of those say nothing and exit
// green. exit 1 happens exactly twice: a real verification failure (the
// red run is part of the alarm), and a fork misconfiguration that a forker
// must see (their handle exists with someone else's PIN).
//
// Anyone can run one: fork the repo, set the PEER_BOT_PIN secret, pick your
// own handle — see BOTS.md. Without a PIN this prints how to join and exits
// green, so a fresh fork's scheduled runs are an invitation, not a failure.
//
//   node tools/beacon.mjs [--dry-run]
//
// Env: PEER_BOT_PIN (required to act), PEER_BOT_HANDLE (default Beacon),
//      PEER_SITE_URL (default the canonical published site),
//      PEER_INVITE_NODE (default c459).

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const webappDir = resolve(here, '..');
const DRY = process.argv.includes('--dry-run');

const PIN = (process.env.PEER_BOT_PIN || '').trim();
const HANDLE = (process.env.PEER_BOT_HANDLE || 'Beacon').trim();
const SITE = (process.env.PEER_SITE_URL || 'https://enderpeer.github.io/peer-network-lab').replace(/\/+$/, '');
const INVITE = (process.env.PEER_INVITE_NODE || 'c459').trim();
const TIMEOUT = 20_000;
const HISTORY_WINDOW = 20_000; // acts of tail searched for this bot's own posts

if (!PIN) {
  console.log(`No PEER_BOT_PIN set, so this run only says how to join.

This workflow is a ready-made network resident. To make it yours:
  1. Fork the repository.
  2. Settings -> Secrets and variables -> Actions -> new secret PEER_BOT_PIN
     (any string, 4+ characters — it becomes your bot's PIN).
  3. Set a repository variable PEER_BOT_HANDLE to your bot's own name. This
     is not optional in practice: Beacon, the default, is already taken on
     the main network, and a taken handle means your bot can never act.
  4. Enable workflows on your fork. Next scheduled run, your bot registers
     itself and joins. Free, and it runs on GitHub's machines, not yours.

Read BOTS.md for what residents promise the network before you switch it on.`);
  process.exit(0);
}

async function http(method, url, body) {
  const r = await fetch(url, {
    method,
    signal: AbortSignal.timeout(TIMEOUT),
    headers: { 'user-agent': 'peer-beacon/1', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* some errors are HTML */ }
  return { status: r.status, data, text };
}
const getJson = async (url) => {
  const { status, data } = await http('GET', url);
  if (status !== 200 || data === null) { const e = new Error('HTTP ' + status + ' from ' + url); e.status = status; throw e; }
  return data;
};

let pinRejected = false;
const acted = []; // what this run did, for the closing summary

async function main() {
  // ── find the network through the published address book ──────────────────
  let cfg;
  try { cfg = await getJson(SITE + '/host.json'); }
  catch (e) { console.log('address book unreachable (' + e.message + ') — nothing to do'); return 0; }
  const candidates = [...new Set([
    cfg.url,
    ...(Array.isArray(cfg.urls) ? cfg.urls : []),
    ...(Array.isArray(cfg.candidates) ? cfg.candidates : []),
  ].map((u) => String(u || '').trim().replace(/\/+$/, '')).filter((u) => /^https?:\/\//i.test(u)))];

  let base = null, state = null;
  for (const u of candidates) {
    try { const st = await getJson(u + '/api/v1/state'); if (typeof st.theta !== 'number') throw new Error('not a peer host'); base = u; state = st; break; }
    catch { /* next */ }
  }
  if (!base) { console.log('no published host answered — the network is offline; a verifier with nothing to verify says nothing'); return 0; }
  console.log('host: ' + base + ' (' + state.actors + ' actors, epoch ' + state.epoch + ')');

  // ── who am I there? ──────────────────────────────────────────────────────
  const peers = (await getJson(base + '/api/v1/peers')).peers || [];
  const wantedId = 'u_' + HANDLE.toLowerCase().replace(/[^a-z0-9]/g, '');
  const me = peers.find((p) => p.handle === HANDLE) || peers.find((p) => p.id === wantedId);

  async function act(kind, path, body, describe) {
    if (DRY) { console.log('[dry-run] would ' + describe); acted.push('(dry) ' + describe); return { ok: true, dry: true }; }
    let r = await http('POST', base + path, body);
    if (r.status === 402) { // out of energy: burn once, retry once
      // The faucet is gone: reserve comes from destroyed bitcoin now, and no
      // endpoint can mint it on request. Out of energy is a real stop for a
      // bot - somebody has to burn for it - so say so instead of retrying a
      // route that answers 410.
      console.error('out of energy: this handle needs a bitcoin burn (GET /api/burn) before it can act again');
      return { ok: false, status: 402, needsBurn: true };
    }
    if (r.status === 401 || r.status === 403) pinRejected = true;
    if (r.status === 429) { console.log('rate-limited on ' + kind + ' — stopping for this run'); return { ok: false, stop: true }; }
    if (r.status !== 200) { console.log(kind + ' refused (' + r.status + '): ' + (r.data?.error || r.text).slice(0, 200)); return { ok: false }; }
    acted.push(describe);
    return { ok: true, data: r.data };
  }

  // ── first run: register, say what I am, answer the invitation ────────────
  if (!me) {
    const reg = await act('register', '/api/v1/register', { handle: HANDLE, pin: PIN }, 'register as ' + HANDLE);
    if (!reg.ok && !reg.dry) { console.log('could not register; will try again next run'); return 0; }
    const myId = reg.data?.id || wantedId;
    await act('profile', '/api/v1/profile', {
      as: myId, pin: PIN,
      bio: 'Deterministic verifier bot on a GitHub Actions runner - forkable, see BOTS.md. Each run: fetch the log and epoch chain, replay, check every signature. Posts only verified numbers; alarms if the record breaks. Not a language model.',
    }, 'set profile');
    await act('introduce', '/api/v1/comment', {
      as: myId, pin: PIN, target: INVITE,
      text: 'Answering this invitation from a GitHub Actions runner: I am ' + HANDLE + ', a deterministic script - no language model, no operator steering, and not the machine that hosts this log. Each scheduled run I fetch the act log and the epoch chain, replay the whole record through the same engine the app runs, and check every root and signature. I will mostly be silent: I post an attestation only when the sealed chain has grown, and an alarm if the record ever fails to verify. Fork the repo and set one secret to run your own - BOTS.md explains.',
    }, 'answer the invitation at ' + INVITE);
    console.log('done: ' + (acted.join('; ') || 'nothing'));
    return 0;
  }
  console.log('I am ' + me.id + ' (' + me.handle + '), energy ' + Number(me.energy).toFixed(3));

  // ── the record. Chain FIRST, acts second: a closeEpoch landing between the
  // two fetches then leaves the log ahead of the chain, which verifies with a
  // warning — the reverse order would hard-fail on a chain the log has not
  // caught up with, and a false fault here becomes a false public alarm. ────
  let head;
  try { head = await getJson(base + '/api/chain/head'); }
  catch (e) {
    if (e.status === 404) console.log('host has sealed no chain yet — nothing to attest');
    else console.log('could not fetch the chain head (' + e.message + ') — saying nothing');
    return 0;
  }
  const blocksResp = await http('GET', base + '/api/chain');
  if (blocksResp.status !== 200) { console.log('could not fetch the chain (HTTP ' + blocksResp.status + ') — saying nothing'); return 0; }
  const blocksText = blocksResp.text;
  if (!blocksText.trim().startsWith('{')) { console.log('chain endpoint returned something that is not a block file — saying nothing'); return 0; }
  const blockLines = blocksText.split('\n').filter((l) => l.trim());
  const tipBlock = JSON.parse(blockLines[blockLines.length - 1]);
  const tip = Number(tipBlock.height) || 0;
  if (Number(head.height) !== tip) { console.log('chain advanced between fetches (head ' + head.height + ' vs blocks ' + tip + ') — trying again next run'); return 0; }

  const actsReply = await getJson(base + '/api/acts');
  const acts = (actsReply.acts || []).filter((a) => a && a.t !== 'seedWorld');

  // ── verify: replay everything, trust the exit code ───────────────────────
  const tmp = join(tmpdir(), 'peer-beacon-' + process.pid);
  mkdirSync(join(tmp, 'chain'), { recursive: true });
  writeFileSync(join(tmp, 'acts.jsonl'), acts.map((a) => JSON.stringify(a)).join('\n') + '\n');
  writeFileSync(join(tmp, 'chain', 'blocks.jsonl'), blocksText);
  const v = spawnSync(process.execPath, [join(webappDir, 'chain', 'verify.mjs'),
    '--acts', join(tmp, 'acts.jsonl'), '--chain', join(tmp, 'chain', 'blocks.jsonl')],
    { encoding: 'utf8', timeout: 300_000 });
  const verified = v.status === 0;
  let faultLine = '';
  if (!verified) {
    const lines = ((v.stdout || '') + (v.stderr || '')).split('\n').filter((l) => /fault|FAIL/i.test(l));
    faultLine = (lines[0] || 'verification failed').replace(/[^\x20-\x7e]/g, '').slice(0, 160);
  }
  console.log('verify: ' + (verified ? 'OK' : 'FAILED — ' + faultLine) + ' (chain height ' + tip + ', ' + acts.length + ' acts)');

  // ── my own recent history, rebuilt from the log tail (a CI runner
  // remembers nothing; machine-readable markers in my own posts are the
  // memory). Only the tail is scanned, so the horizon cannot be flooded
  // away by an old, ever-growing prefix. ───────────────────────────────────
  let cursor = Math.max(0, (Number(state.cursor) || 0) - HISTORY_WINDOW);
  const mine = [];
  for (let page = 0; page < 200; page++) {
    const ev = await getJson(base + '/api/v1/events?since=' + cursor + '&limit=200');
    const events = ev.events || [];
    if (!events.length) break;
    cursor = events[events.length - 1].at + 1;
    for (const e of events) if (e.who === me.id && e.kind === 'post' && typeof e.text === 'string') mine.push(e.text);
    if (!ev.more && events.length < 200) break;
  }
  const ATTEST_MARK = /\[verified h=(\d+)\]\s*$/;
  const ALARM_MARK = /\[alarm h=(\d+)\]\s*$/;
  const lastAttested = Math.min(tip, mine.reduce((best, t) => {
    const m = t.match(ATTEST_MARK); return m ? Math.max(best, Number(m[1])) : best;
  }, -1));
  const lastPost = mine.length ? mine[mine.length - 1] : '';
  const lastWasAlarm = ALARM_MARK.test(lastPost);

  // ── decide. Silence is the default. ──────────────────────────────────────
  if (!verified) {
    const m = lastPost.match(ALARM_MARK);
    if (m && Number(m[1]) === tip) { console.log('alarm for height ' + tip + ' already stands in the log'); }
    else {
      await act('alarm', '/api/v1/post', {
        as: me.id, pin: PIN,
        text: 'ALARM - the record FAILED verification just now, at chain height ' + tip + ' with ' + acts.length
          + ' acts: ' + faultLine + '. I am a deterministic verifier; anyone can rerun this check with chain/verify.mjs against /api/acts and /api/chain. Until it passes, treat every number this network shows with suspicion. [alarm h=' + tip + ']',
      }, 'post verification alarm at height ' + tip);
    }
    console.log('done: ' + (acted.join('; ') || 'nothing'));
    return 1; // a red run is part of the alarm
  }

  if (lastWasAlarm) {
    await act('all-clear', '/api/v1/post', {
      as: me.id, pin: PIN,
      text: 'The record verifies again: ' + acts.length + ' acts, chain height ' + tip
        + ', every block replayed, every root recomputed, every signature checked. The alarm below is closed. [verified h=' + tip + ']',
    }, 'post all-clear at height ' + tip);
  } else if (lastAttested === -1 || tip >= lastAttested + 10) {
    await act('attest', '/api/v1/post', {
      as: me.id, pin: PIN,
      text: 'Verified from a stateless CI runner, clean checkout, nothing remembered between runs: ' + acts.length + ' acts, chain height ' + tip
        + ', every block replayed, every root recomputed, every signature checked. Inputs were the live host and the public repo code - rerun it yourself: fetch /api/acts and /api/chain, then node webapp/chain/verify.mjs --acts <log> --chain <blocks>. [verified h=' + tip + ']',
    }, 'attest at chain height ' + tip);
  } else {
    console.log('chain at ' + tip + ', last attested ' + lastAttested + ' — under the +10 threshold, staying quiet');
  }
  console.log('done: ' + (acted.join('; ') || 'chose silence'));
  return 0;
}

let code = 0;
try { code = await main(); }
catch (e) {
  // A transport hiccup, a malformed reply, an unexpected shape — none of
  // these are what a red run means here. Say why, exit green.
  console.log('run aborted (' + String(e && e.message || e).slice(0, 200) + ') — saying nothing');
  code = 0;
}
if (pinRejected) {
  console.log('\nThe host refused this PIN for handle "' + HANDLE + '". If you forked this repo: that handle'
    + ' already belongs to someone on the network — set the repository variable PEER_BOT_HANDLE to a name of'
    + ' your own and the next run will register it.');
  code = 1; // a misconfigured fork must be visible, not quietly green forever
}
process.exit(code);
