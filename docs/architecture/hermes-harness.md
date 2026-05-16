# Hermes Thin Harness — Design Spec

> Status: draft for review
> Owner: Anoop
> Target commit path: `docs/architecture/hermes-harness.md`
> Companion ethos: [[docs/ethos/thin_harness_fat_skills]]

## 1. Goal

Let Nous Research's **Hermes** operate as a co-equal agent against Anoop's gbrain alongside Claude Code (via gstack), fronted by Slack. The harness is a ~500 LOC shim: one read primitive (`gbrain query`), one skill loader (RESOLVER.md → skill markdown), and a Slack WebSocket adapter. All intelligence lives in skills and in the model. Per [[docs/ethos/thin_harness_fat_skills]], the harness must resist becoming a toolkit — no 40-tool MCP surface, no god-tool wrappers, no REST shims. If a capability isn't a CLI, it doesn't belong here.

## 2. Architecture

```
Slack message
  ↓
Hermes harness (read-only by default)
  ↓
gbrain query  (one CLI: RRF + expansion)
  ↓
RESOLVER.md  (intent → skill path)
  ↓
Load skill markdown
  ↓
Execute deterministic CLI steps the skill prescribes
  ↓
Hermes synthesizes from context + skill output
  ↓
Slack reply
```

Commentary: the harness is a **pipe**, not a brain. Hermes sees raw `gbrain query` output and raw skill markdown; the harness never paraphrases either. The skill prescribes the CLIs; the harness shells out and streams stdout back to Hermes. This is the same shape Claude Code uses with gstack — Hermes just gets its own seat at the table.

## 3. Module structure

Target tree (~500 LOC total, hard cap):

```
hermes-harness/
├── main.py              # entrypoint, Slack event loop                 (~60 LOC)
├── slack_adapter.py     # Bolt WebSocket: events → harness → reply     (~90 LOC)
├── hermes_client.py     # one HTTP call to Hermes inference endpoint   (~70 LOC)
├── gbrain.py            # subprocess wrapper: `gbrain query <q>`       (~40 LOC)
├── resolver.py          # parse RESOLVER.md, intent → skill path       (~60 LOC)
├── skill_runner.py      # load skill md, execute its CLI prescriptions (~90 LOC)
├── trace.py             # JSONL trace per turn (intent, skill, CLIs)   (~40 LOC)
├── config.py            # env, allow-list, source_id                   (~30 LOC)
└── tests/
    └── eval_intents.py  # eval harness: N intents → assert skill+shape (~60 LOC)
```

Everything else (auth, retry, OAuth dance) leans on libraries. No hand-rolled MCP server.

## 4. Slack adapter

- **SDK**: Slack Bolt for Python, **Socket Mode** (WebSocket). No public HTTP endpoint, no ngrok, no inbound webhook signature handling.
- **Events subscribed**: `app_mention`, `message.im` (DMs). Nothing else — channel firehose is out of scope.
- **Auth**: bot token (`xoxb-`) + app-level token (`xapp-`) in `~/.hermes/slack.env`. One workspace.
- **Deployment shape**: single long-lived process on the Mini under launchd (same pattern as `post-call-processor`). No public ingress. Restart-on-crash. Logs to `~/.hermes/logs/`.
- **Reply shape**: thread reply, plain text. No blocks, no attachments v1. Streaming optional v2.
- **Identity**: bot user "Hermes". Slack `user_id` of the requester → maps to gbrain person via `config.py` allow-list. Unknown senders are politely refused.

## 5. Hermes API surface (the loop)

```python
# main.py — the entire control flow, ~30 lines
def handle_slack_message(evt):
    user_text = evt["text"]
    trace = Trace.new(evt)

    # 1. Pull context — ONE call, no fan-out
    ctx = gbrain.query(user_text)              # subprocess: `gbrain query <q>`
    trace.log("gbrain_query", ctx.digest())

    # 2. Ask Hermes for intent (system prompt = RESOLVER.md verbatim)
    intent = hermes.classify_intent(user_text, ctx, resolver_md())
    trace.log("intent", intent)

    # 3. Resolve skill
    skill_path = resolver.pick(intent)         # parses RESOLVER.md table
    skill_md   = open(skill_path).read()
    trace.log("skill", skill_path)

    # 4. Let Hermes drive the skill — it sees the markdown and decides
    #    which CLIs from the skill's "Steps" section to invoke.
    for step in hermes.plan_steps(skill_md, ctx, user_text):
        out = skill_runner.exec(step)          # subprocess + capture
        trace.log("step", step, out)
        if step.terminal: break

    # 5. Synthesize the reply
    reply = hermes.synthesize(user_text, ctx, trace.steps())
    slack.reply(evt, reply)
    trace.close()
```

No agentic loop beyond what the skill prescribes. Hermes is **planner + writer**, not an autonomous tool-caller. If a skill needs 12 CLI calls, the skill markdown lists 12 CLI calls. Per [[docs/ethos/thin_harness_fat_skills]]: *the model's job is judgment, not orchestration*.

## 6. gbrain connection

- **Read**: `gbrain query` CLI subprocess only. Returns hybrid RRF + expanded neighbors as JSON on stdout. ~80–200ms p50. No MCP wrapping.
- **Writes (v2)**: gbrain v0.34 HTTP MCP endpoint behind **OAuth 2.1 + Dynamic Client Registration**. Hermes harness registers as a DCR client at first boot, stores client_id/secret in `~/.hermes/oauth.json`.
- **source_id**: every write tagged `source_id="hermes"` (Claude writes are `source_id="claude"` / `"gstack"`). This is the discriminator for salience asymmetry (see Open Questions).
- **Per-token allow-list**: the OAuth token's scope is constrained to: `pages.read`, `pages.write:source=hermes`, `query.read`. No `pages.write:any`. No `system.*`. Enforced server-side in gbrain, not in the harness.
- **Day-one default**: read-only. The write scope is provisioned but disabled by config flag until Anoop flips it (see Open Questions).

## 7. Skill compatibility

**Works as-is** (CLI-shaped, no Claude-Code-isms):
- `brief-pipeline` skills (`call-brief-generator`, `post-call-processor`)
- `monday-running-log`
- `enrichment-stack` (Clay MCP + browser/safe-browser are subprocess CLIs)
- `gbrain-list-pages-pagination`, `gbrain-cleanup`
- `intro-email`, `meeting-briefing`, `daily-briefing`
- `search`, `fetch`, `what-antibot` — pure CLIs already

**Needs a Hermes-shaped RESOLVER.md fork** (`RESOLVER.hermes.md`):
- Anything that assumes Claude Code's `Skill` tool invocation grammar
- Skills that reference `Bash` / `Read` / `Edit` tool names in their Steps — Hermes harness has no such tools; needs to translate to raw `sh -c`
- `signal-detector` / `brain-ops` — these assume always-on background fan-out; in Hermes they run inline per-turn or not at all
- `superpowers:*` and `agent-skills:*` — Claude-Code-namespaced, skip for v1

**Strategy**: ship `RESOLVER.hermes.md` as a sibling of `RESOLVER.md` rather than forking the skills themselves. Skills stay the single source of truth; only the routing table diverges.

## 8. Failure modes + observability

- **Trace**: one JSONL file per turn under `~/.hermes/traces/<turn_id>.jsonl`. Lines: `slack_in`, `gbrain_query`, `intent`, `skill`, `step`, `hermes_call`, `slack_out`, `error`.
- **Retry**: `gbrain query` retries 2× with 200ms backoff. Hermes inference retries 1×. CLI steps invoked by skills are **not retried** by the harness — the skill owns that semantic.
- **Circuit breaker**: if `gbrain query` fails 3× in 60s, harness replies "brain offline, try again in a minute" and stops calling until a probe succeeds. Same for Hermes endpoint.
- **Timeouts**: `gbrain query` 5s, Hermes call 30s, skill CLI step 60s (override per-step in skill frontmatter).
- **Quiet failures**: every uncaught exception → Slack ephemeral reply to the user + trace flagged `error=true`. No silent drops.
- **Dashboards**: none v1. Grep the JSONL. Per `silent_execution` rule, narration belongs in traces, not in Slack.

## 9. Testing strategy

Eval-driven, not unit-driven. `tests/eval_intents.py` ships ~30 fixture intents covering the main skill families.

For each fixture:
1. Feed the Slack-shaped message into the harness in **dry-run mode** (no Slack post, no writes).
2. Assert: (a) `resolver.pick()` returned the expected skill, (b) the first CLI step matches the expected command shape, (c) the synthesized reply contains the expected entities (substring match — not exact string).
3. Snapshot the trace JSONL; diff against golden on regression.

CI: run on every PR. Failing eval blocks merge. Drift in skill routing is the #1 risk; this catches it.

No mocking of `gbrain query` — it hits a fixture brain (small seeded SQLite) per the `datahive-real-db` rule applied to gbrain.

## 10. Bootstrap sequence

1. Create `hermes-harness/` repo + venv, pin `slack-bolt`, `httpx`, `pydantic`.
2. Stand up Slack app in workspace; enable Socket Mode; grab `xoxb-` and `xapp-` tokens; subscribe to `app_mention` + `message.im`.
3. Implement `slack_adapter.py` echo bot — Slack message → "pong". Deploy under launchd on Mini. Confirm round-trip.
4. Implement `gbrain.py` subprocess wrapper. Wire into echo: reply with `gbrain query <text>` JSON digest. Confirm against a known entity.
5. Stand up Hermes inference endpoint (local Nous server **or** remote — see Open Questions). Implement `hermes_client.py` with one `complete()` method. Wire a smoke test.
6. Author `RESOLVER.hermes.md` with 10 seed intents → skill paths. Implement `resolver.py` parser.
7. Implement `skill_runner.py`: load skill md, expose its Steps to Hermes, execute the CLIs Hermes selects, capture stdout.
8. Wire the full loop in `main.py` per §5. End-to-end on one fixture: "what did I commit to Boardy last week?" → daily-briefing or meeting-briefing skill → reply.
9. Add `trace.py` JSONL + `tests/eval_intents.py` with 10 fixtures. Get CI green.
10. Register gbrain OAuth DCR client, store token with read-only scope, ship to Mini under launchd, invite Hermes bot to a private channel, run for one week read-only before flipping the write flag.

## 11. Open questions

- **Hermes endpoint**: local Nous server on the Mini (latency win, ops cost) or remote API (simpler, but introduces a vendor dependency and a network hop)?
- **Slack frontend**: adopt Nous's existing Slack bot if one exists, or build fresh on Slack Bolt SDK? Reuse risks inheriting an opinionated harness; greenfield is ~90 LOC.
- **Hermes write authority**: read-only for the first week to observe behavior, or read+write from day one with `source_id="hermes"` as the safety valve?
- **Salience asymmetry**: should Hermes-authored writes carry the same salience weight as Claude-authored writes, or should gbrain down-weight `source_id="hermes"` until a track record exists? Per [[docs/ethos/thin_harness_fat_skills]] the harness shouldn't encode this — it's a gbrain-side policy — but the decision gates the v2 write rollout.
