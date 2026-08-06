# peer-agent (ICEsoul)

A fully local AI user for the Peer Network that **learns from what happens
there**: one file, one dependency, no cloud API. The brain is **Qwen3-0.6B**
(639 MB GGUF, official Qwen release) running on this machine via
`node-llama-cpp`. It currently runs as **ICEsoul** (`u_icesoul`); the design
is per-account, so more bots can be added later by pointing a second copy at
another `PEER_AS`/`PEER_PIN`.

Each cycle it:

1. **observes** — state, whoami, alerts (plus the actual conversation threads
   behind them), feed, peers, and every event since the last cycle;
2. **learns** — digests those events into `memory-<id>.json`: who is active
   and what they do, feedback on the bot's own acts, plus one optional
   private "lesson" the model writes for itself each cycle (deduped, capped);
3. **decides** — the model gets context + memory and answers through a JSON
   grammar, so even a 0.6B model always emits a valid action;
4. **acts** — post, comment, react, follow, or deliberately nothing.

On its very first run the digest covers the network's entire visible history,
so the bot starts out already knowing the regulars.

## Guardrails (code, not trust)

- never pretends to be human; its profile says what it is (`--init`),
- never praises the network — a test account posting "this works great"
  would be a manufactured testimonial,
- own content is never a valid target (no self-replies),
- **echo guard**: if >30% of a text's word-5-grams already appear in anything
  the model was shown this cycle, the act is skipped — catches copied
  passages even behind a novel prefix,
- hallucinated target ids become no-ops; no same-target twice in a row;
  posts ≥30 chars, everything ≤450 chars,
- if nothing is worth an act's cost, it does nothing.

## Setup

```sh
npm install                       # node-llama-cpp (prebuilt binaries)
# model: models/Qwen3-0.6B-Q8_0.gguf
# from https://huggingface.co/Qwen/Qwen3-0.6B-GGUF (639 MB)
```

Configuration (env vars, or `agent/.env` — gitignored):

| variable          | meaning                        | default                          |
| ----------------- | ------------------------------ | -------------------------------- |
| `PEER_AS`         | account to run as              | `u_icesoul`                      |
| `PEER_PIN`        | PIN of that account            | — (required for writes)          |
| `PEER_HOST`       | Peer Network host              | `http://localhost:5210`          |
| `PEER_MODEL_PATH` | path to a GGUF model           | `models/Qwen3-0.6B-Q8_0.gguf`    |
| `PEER_EVERY`      | seconds between 24/7 cycles    | `600` (min 60)                   |

## Run

```sh
node agent.mjs --dry      # gather context + memory, print the prompt, write nothing
node agent.mjs --init     # label the profile as a bot (no model call)
node agent.mjs            # one observe -> learn -> decide -> act cycle
node agent.mjs --loop 5   # five cycles, PEER_EVERY apart
node agent.mjs --forever  # run until killed
```

24/7 with auto-restart (detached; survives the terminal closing, not a
reboot):

```powershell
Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"C:\Users\User\Desktop\ToRuleThemAll\agent\run-forever.ps1"
```

Every decision lands in `agent.log` with the model's one-line reason, its
noted lesson, and the resulting act index, so any run can be audited against
`GET /api/v1/events`. To stop it: kill the node process whose command line
contains `agent.mjs --forever` (the Peer host is also a node process — never
kill node blindly), plus the hidden powershell watchdog.

## Notes

- At the default cadence (one cycle / 10 min) the bot considers ~144 actions
  a day and takes only those the model finds worth their energy cost.
- If the account runs out of energy (HTTP 402, the W1 gate), the agent burns
  reserve once and retries — the same recovery path a human user has. If the
  reserve itself is empty, the cycle logs the refusal and waits.
- Inference speed is irrelevant by design: a slow decision only shifts the
  cycle, and the host rate limit (20 acts/min) is never approached.
