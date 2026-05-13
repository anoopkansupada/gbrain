---
name: post-call-processor
description: After a Granola transcript lands and matches a pre-call brief, link the two, extract structured facts into entity pages, create task pages for committed action items, and draft a follow-up email. Locked output schema. Drafts never auto-sent.
triggers:
  - "process call"
  - "debrief"
  - "post-call"
  - "what came out of the call"
  - "/debrief"
mutating: true
---

# Post-Call Processor

Close the loop after a call: brief + transcript become a debriefed brief + tasks + draft follow-up email + updated entity pages.

> **Filing rule:** All output follows the [[brief-to-brain]] recipe schemas. See `~/gbrain/recipes/brief-to-brain.md` for the dual-storage pattern.

## Contract

- **Trigger condition:** a new `~/brain/meetings/<YYYY-MM-DD>-<participant>.md` exists, AND a matching `~/brain/briefs/<slug>.md` has `status: pre-call` (or `in-progress`) AND `participants:` overlap AND `date:` matches.
- **Idempotent.** Re-running on the same brief/transcript pair is a no-op (`status: post-call-debrief` short-circuits).
- **Drafts never auto-sent.** Email output is `status: draft` always. Operator reviews, redlines, sends from their real mail client. See standing rule [[feedback_drafter_required]] — chat-written outbound copy fails brand voice; this email is operator-reviewable copy, not an outbound message.
- **Confidential facts get flagged.** When the transcript contains "don't share this" / "sensitive" / "between us" markers, the extracted fact goes into a separate `confidential:` frontmatter field, NEVER into the public body, and a task is created tagged `confidential` to remind the operator.
- **Deterministic schema.** Every output file's frontmatter shape is locked. See "Output schemas" below.
- **No scratch in the output.** Per [[deliverable-only-no-scratch]] — no v1-vs-v2 commentary in the artifacts the operator reads.
- **Reciprocal links everywhere.** Brief links to transcript; transcript links to brief; both link to tasks; tasks link back to brief + transcript; email links to tasks.

## Inputs

Required (or auto-detected):
- `brief_slug` — e.g., `dewald-cloete-2026-05-13`
- `meeting_slug` — e.g., `2026-05-13-dewald-cloete`

Auto-detect mode: scan `~/brain/meetings/*.md` mtime > last-run time; for each, find matching brief by `(participants, date)` tuple.

## Phases

### Phase 1 — Load context

1. Read brief markdown at `~/brain/briefs/<brief_slug>.md`.
2. Read transcript at `~/brain/meetings/<meeting_slug>.md`.
3. Read each entity referenced in the brief's `deals_referenced` / `firms_referenced` / `participants` frontmatter (build a context dict).

### Phase 2 — Extract structured facts (LLM, locked schema)

Run a single LLM extraction pass with this output schema. **The schema is the contract — the LLM cannot deviate.**

```yaml
covered_vs_planned:
  - block: "Block 01 — Opener"
    planned: "..."
    covered: "..." | "skipped"
  - block: "Block 02 — ..."
    planned: "..."
    covered: "..."
  # ...repeat for every block in the brief
new_facts:
  - subject: "[[companies/<slug>]]" | "[[people/<slug>]]" | "[[deals/<slug>]]"
    fact_type: service_provider | relationship | deal_status | pricing | network | competitive_intel | personal_context
    fact: "<verbatim or close-paraphrase>"
    confidence: high | medium | low
    quote: "<exact transcript line>"
    confidential: false
service_provider_updates:
  - subject_page: "[[companies/<slug>]]"
    role: directorship | legal_counsel_cayman | legal_counsel_us | accountant | auditor | custodian | bank | ...
    firm: "[[companies/<slug>]]"
    individuals: ["[[people/<slug>]]"]
    notes: "<context from transcript>"
deal_status_updates:
  - deal_name: "..."
    new_stage: "..." | null
    new_blocker: "..." | null
    new_intel: "..." | null
action_items:
  - title: "..."
    owner: "anoop-kansupada" | "<participant-slug>"
    deadline: YYYY-MM-DD | null
    priority: high | medium | low
    notes: "<full context inc. transcript reference>"
    confidential: false
confidential_flags:
  - context: "<what makes it confidential>"
    fact: "<the fact>"
    handling: "do_not_spread" | "internal_only" | "operator_only"
gap_feedback:
  - issue: "<what the brief got wrong or missed>"
    fix: "<concrete change to template/generator>"
```

### Phase 3 — Update brief

1. Set frontmatter: `status: post-call-debrief`, `related_granola: "[[meetings/<meeting_slug>]]"`.
2. Append a `## Post-call debrief — what we actually covered` section with:
   - `### Covered vs planned` table
   - `### New facts surfaced` bullets
   - `### What the brief got wrong (for future generations)` — operator-self-identified + LLM-identified gaps from `gap_feedback`
3. **Do NOT touch the pre-call body sections** — preserve operator's audit trail of what was planned.

### Phase 4 — Update transcript

1. Append to frontmatter: `prep_brief: "[[briefs/<brief_slug>]]"`, `participants: [...]` (canonicalize "Unknown" Granola attendees against brief participants).
2. Append `## Post-call links` section with backlinks to brief + tasks + draft email.

### Phase 5 — Write task pages

For each `action_items` entry, write `~/brain/tasks/<participant-slug>-<call-date>-<task-slug>.md` with locked frontmatter:

```yaml
---
type: task
title: "..."
status: open                    # open | in-progress | blocked | done | cancelled
owner: "[[people/<owner>]]"
context_call: "[[briefs/<brief_slug>]]"
related_granola: "[[meetings/<meeting_slug>]]"
related_person: "[[people/<participant>]]"
deals_referenced: [...]
firms_referenced: [...]
deadline: <YYYY-MM-DD or null>
priority: high | medium | low
created: <ISO timestamp>
created_from: post-call-processor
confidential: false | true
tags: [task, <participant-slug>, <project-slug>, <priority>-priority]
---

# <title>

**Owner:** <name> · **Deadline:** <date> · **Priority:** <level>

## Context

From call with [[people/<participant>]] on <date>. See [[briefs/<brief_slug>]] and [[meetings/<meeting_slug>]].

## Notes

<full context including transcript quote if relevant>
```

### Phase 6 — Update entity pages

For each `service_provider_updates` entry, append `service_providers:` list entry to the subject page's frontmatter (see [[brain-CLAUDE]] for the service-provider schema).

For each `new_facts` entry where `subject` is a person/firm/deal page, append a `## Recent intel` section entry with the fact + source quote + date.

For each `deal_status_updates` entry, append a timeline entry to the deal page.

### Phase 7 — Draft follow-up email

Write `~/brain/emails/<brief_slug>-followup.md` with locked frontmatter:

```yaml
---
type: email
category: follow-up
status: draft                   # ALWAYS draft. Never sent by the processor.
to: ["<participant email from CRM>"]
cc: []
from: "<operator email>"
subject: "Following up — <participant first> x <operator>, <D Mon>"
context_call: "[[briefs/<brief_slug>]]"
related_granola: "[[meetings/<meeting_slug>]]"
tasks_referenced: ["[[tasks/...]]"]
generated_by: post-call-processor
generated_at: <ISO>
tags: [email, draft, follow-up, <participant-slug>]
---

# Draft email (NOT sent — operator review + send manually)

**To:** ...
**Subject:** ...

---

<email body referencing the action_items, structured by:
 - Actions operator owns (with deadlines)
 - Things operator needs from participant (with deadlines)
 - Logistics (standing call cadence)
 - Optional confidential P.S. if any confidential_flags were present>
```

Body writing rules:
- **Natural prose, not bullets-only.** Operator can lift this verbatim if they want.
- **Reference participants by first name** unless the call surfaced they prefer otherwise.
- **No "as discussed during our call" filler.** Get to the actions.
- **P.S. confidential note** only if the operator needs to acknowledge a confidential commitment (e.g., "got it, holding tight"). NEVER include the confidential fact itself.
- **No subject-line emoji.** Operator's existing voice is unadorned.

### Phase 8 — Commit + sync + verify

```bash
cd ~/brain
git add briefs/<brief_slug>.md meetings/<meeting_slug>.md tasks/ emails/ companies/ people/ deals/
git commit -m "post-call: <participant> <date> — brief→debrief, transcript linked, N tasks + draft follow-up"

source ~/.zprofile
gbrain sync --no-pull --skip-failed --repo ~/brain
gbrain embed --stale
gbrain extract links --dir ~/brain
```

Heartbeat:
```json
{"ts":"<ISO>","event":"processed","status":"ok","details":{"brief":"<slug>","meeting":"<slug>","tasks_created":N,"emails_drafted":1,"facts_extracted":N,"confidential_flags":N,"service_provider_updates":N}}
```
to `~/.gbrain/integrations/post-call-processor/heartbeat.jsonl`.

### Phase 9 — Render web/ HTML versions

- `~/Projects/active/hash-lemma/web/public/briefs/<brief_slug>.html` — regenerate with post-call section appended (same light-mode design tokens)
- `~/Projects/active/hash-lemma/web/public/emails/<brief_slug>-followup.html` — render the draft email with light-mode styling, mailto: link to operator's mail client
- Task pages do NOT get per-file HTML; they're surfaced via the `/tasks` route in web/

## Output schemas (locked)

Every invocation produces exactly:

```
~/brain/briefs/<brief_slug>.md             (updated, status: post-call-debrief)
~/brain/meetings/<meeting_slug>.md          (updated, prep_brief link)
~/brain/tasks/<...>.md                      (N new task pages)
~/brain/emails/<brief_slug>-followup.md     (1 draft email)
~/Projects/active/hash-lemma/web/public/briefs/<brief_slug>.html   (regenerated)
~/Projects/active/hash-lemma/web/public/emails/<brief_slug>-followup.html  (new)
```

Plus inline frontmatter updates on referenced deals, firms, persons.

## Auto-run (LaunchAgent integration)

Optional: add to `~/Library/LaunchAgents/com.gbrain.post-call-processor.plist` with `StartInterval=900` (15 min). The wrapper script `~/.gbrain/integrations/post-call-processor/run.sh` scans for new transcripts and runs this skill on each match.

Alternative: chain into `~/.gbrain/integrations/granola-sync/run.sh` — after each Granola sync, immediately run post-call processor on any new transcripts. Tighter feedback loop.

## Failure modes + recovery

| Symptom | Cause | Fix |
|---|---|---|
| No brief matches transcript | Transcript participants are "Unknown" (Granola anonymization) | Operator manually edits transcript frontmatter to canonicalize names; skill matches on date alone as fallback |
| LLM extraction returns malformed schema | Prompt drift / model behavior change | Re-run with `--strict-schema` flag (validates against JSON schema before commit); fall back to "review needed" task page if 2+ retries fail |
| Email draft references a task that doesn't exist | Race condition between task write + email write | Tasks always written FIRST; email written last referencing the now-on-disk task pages |
| Brief gets re-processed (idempotency break) | Operator manually reverted status: post-call-debrief | Skill checks `related_granola` field; if set, no-op unless `--force` flag |
| Confidential fact leaks into email body | LLM extraction marked confidential=false incorrectly | Manual review step: skill DRAFT emails are reviewable; any "confidential" tagged fact gets a [REVIEW: confidential?] marker inline that operator must remove before send |

## References

- `references/extraction-prompt.md` — the locked-schema LLM extraction prompt
- `references/email-template.md` — natural-prose follow-up email template
- `references/confidential-handling.md` — how to mark/route sensitive facts
- `~/gbrain/recipes/brief-to-brain.md` — recipe authority

## See also

- [[call-brief-generator]] — produces the brief this skill closes the loop on
- [[meeting-ingestion]] — Granola → transcript pipeline that feeds this skill
- [[brain-ops]] — general brain query patterns
