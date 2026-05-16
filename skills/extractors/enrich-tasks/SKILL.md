---
name: enrich-tasks
version: 1.0.0
description: |
  Post-process action-items.json into action-items-enriched.json: backfill
  inferred due dates, resolve owner slugs against attendees, and link each
  task to a parent weekly/monthly goal. Runs between extract-action-items
  and the post-call-processor task-write phase. Without this layer, tasks
  land in gbrain without dates or goal linkage and rot.
triggers:
  - "enrich tasks"
  - "task enrichment"
  - multi-extract orchestrator
  - post-call-processor (Phase 5.5)
tools:
  - get_page
  - list_pages
  - search
inputs:
  - meeting_slug
  - brief_slug (optional, but needed for attendees if action-items.json owners are ambiguous)
outputs:
  - "/Users/jarvis/brain/extractions/<meeting_slug>/action-items-enriched.json"
  - "/Users/jarvis/brain/extractions/<meeting_slug>/orphan-tasks.json"  # tasks that couldn't be linked
mutating: false
---

# Enrich Tasks

Narrow post-processor. Reads `action-items.json` from `extract-action-items` and produces an enriched copy with three fields filled in that the upstream extractor leaves loose: `due` (mandatory), `owner` (canonical slug), `parent_goal` (link to a weekly or monthly goal page). Anything that can't be linked goes to `orphan-tasks.json` for operator review.

## Why this exists

`extract-action-items` is correctly conservative: it only emits dates when they're stated or trivially inferable, owners only when the transcript is unambiguous, and never links tasks to goals (out of scope). The result is that the operator (Anoop) ends up with a `tasks/` directory of orphan items with no dates and no place in the weekly/monthly cadence. They rot. This skill closes that gap as a separate, idempotent post-processor so the upstream extractor stays narrow.

## Contract

- **Idempotent.** Re-running on the same `action-items.json` produces the same `action-items-enriched.json`. Hash the input; skip if output is current.
- **Never invent.** If due/owner/goal cannot be confidently determined, emit the task to `orphan-tasks.json` with a `reason` field. Do not guess a goal to make the number go up.
- **Date inference uses the meeting date as anchor.** "by Friday" → next Friday from the meeting date, not from today. "next week" → meeting_date + 7. "EOQ" → quarter end of meeting date. "soon" / "later" / "when I can" → null, route to orphans.
- **Owner resolution uses the brief's attendees list as the only valid namespace.** If the action item names a person who isn't in `attendees:` (e.g., "have Sarah follow up" but Sarah wasn't on the call), keep the literal name in `owner_raw` and route to orphans for operator review — Sarah may be a real person, but the processor cannot resolve her without operator input.
- **Goal linking is best-effort and explicit.** Read `goals/weekly/<YYYY-W##>` and `goals/monthly/<YYYY-MM>` matching the meeting date. For each task, the LLM proposes the single best `parent_goal` from those pages, OR returns null with a reason. Do not chain (no "task → epic → quarterly objective"). One hop, one parent.
- **Goal pages may not exist yet.** If `goals/weekly/<W>` or `goals/monthly/<M>` is missing, write to orphans with reason `missing_goal_period` and surface a top-level note. Do not stub goal pages from this skill — that's an operator decision.

## Inputs

- `meeting_slug` — e.g., `2026-05-04-petri-anoop`. Load `~/brain/extractions/<meeting_slug>/action-items.json`. If missing, abort with a clear error (don't write an empty enriched file).
- `brief_slug` (optional) — e.g., `petri-anoop-2026-05-04`. Used to canonicalize attendee slugs when `action-items.json` owners are loose.

## Goal-page lookup (NCT shape)

Compute from the meeting date:
- ISO week: `YYYY-W##` (e.g., `2026-W19`)
- Month: `YYYY-MM` (e.g., `2026-05`)

Read:
- `goals/weekly/<YYYY-W##>` — the current weekly goals page
- `goals/monthly/<YYYY-MM>` — the current monthly goals page

Both are expected to be in **NCT shape** (see `nct-goals` skill): Narrative + numbered Commitments (C1, C2, … or WC1, WC2, …). The LLM reads each `### <CID> — <title>` block and matches the task to the most relevant single commitment across both pages, preferring the more specific (weekly over monthly) when both fit.

**Legacy fallback:** if either page is in old "Themes / Top priorities" shape (no commitment IDs), route every task to orphans with `reason: parent_goal_not_nct_shape` and flag in the top-level coverage note. Do not try to anchor to bullet text — anchors must be stable IDs.

## Output schema

### action-items-enriched.json

Same array shape as `action-items.json`, with these fields added/normalized:

```json
[
  {
    "title": "string — verbatim from input",
    "owner": "[[people/<slug>]]",        // canonicalized against attendees
    "owner_raw": "string | null",         // original literal if it differed
    "owner_role": "operator | counterparty | both",
    "due": "YYYY-MM-DD",                  // promoted from due_stated || due_inferred, OR inferred here
    "due_source": "stated | inferred_upstream | inferred_here | null",
    "priority": "high | medium | low",
    "verbatim": "string — unchanged",
    "parent_goal": "[[goals/weekly/<slug>#<cid>]] | [[goals/monthly/<slug>#<cid>]] | null",
    "parent_commitment_id": "WC1 | WC2 | ... | C1 | C2 | ... | null",
    "parent_goal_reason": "string — why this commitment was chosen, one sentence citing the commitment's title or done_when rule",
    "bilateral_pair_title": "string | null — unchanged",
    "task_slug_hint": "string — unchanged",
    "context": "string | null — unchanged",
    "enrichment_status": "full | partial",  // full = due+owner+goal all set; partial = one missing but task is still usable
    "missing_fields": ["due" | "owner" | "parent_goal"]  // [] if enrichment_status=full
  }
]
```

### orphan-tasks.json

Tasks that couldn't be confidently enriched and need operator review:

```json
[
  {
    "title": "string",
    "verbatim": "string",
    "reason": "ambiguous_owner | unparseable_due | no_matching_goal | missing_goal_period | conflicting_signals",
    "detail": "string — one sentence explaining what blocked enrichment",
    "raw_input": { ...the original action-items.json entry }
  }
]
```

## Prompt

The enrichment pass is two LLM calls (or one batched call with two sub-tasks):

### Call 1: due + owner

> You are a task enrichment pass. For each input action item, output the canonical owner slug (resolved against the attendees list) and an explicit due date.
>
> Owner rules:
> - If the input `owner` is already in `[[people/<slug>]]` form and the slug appears in `attendees`, keep it.
> - If `owner` is a bare name ("Petri", "Karel"), match to attendees by first name. Ambiguous matches (two attendees with the same first name) → route to orphans.
> - If `owner` is a name that doesn't match any attendee, route to orphans with `reason: ambiguous_owner`.
>
> Due rules (meeting_date is the anchor):
> - Use `due_stated` if set.
> - Else use `due_inferred` if set.
> - Else parse the `verbatim` and `context` for explicit time language relative to meeting_date.
> - Vague language ("soon", "when I can", "later") → null, route to orphans with `reason: unparseable_due`.
>
> Output one JSON object per input task with the new fields filled in.

### Call 2: parent_commitment

> You are a goal-linking pass. For each enriched task, choose the single best commitment from the provided weekly and monthly goal pages (NCT shape). Goal pages have numbered commitments: `### C1 — <title>` for monthly, `### WC1 — <title>` for weekly.
>
> Rules:
> - Prefer a weekly commitment over a monthly one if both fit, since weekly is more specific.
> - The task must materially advance the commitment's `done_when:` rule. If it's only tangentially related, that's not a match — route to orphans with `reason: no_matching_commitment`.
> - If no commitment on either page is a defensible match, return `parent_commitment_id: null` and route to orphans with `reason: no_matching_commitment`. Do not stretch.
> - The `parent_goal_reason` must cite the commitment's title or `done_when` rule — one sentence, concrete.
> - Output `parent_goal: "[[goals/<horizon>/<period>#<cid-lowercased>]]"`.

## Anti-patterns

- Inventing a due date from politeness language ("I'll get to it soon" → not a real date)
- Picking the only goal on the page just because there's only one (still has to actually match)
- Resolving owners by guessing at last names or company affiliation
- Stubbing goal pages from this skill — that's an operator decision
- Silently dropping tasks that don't enrich — they go to orphans, not the floor

## Coverage signal

This skill emits `enrichment_status` per task. Aggregate the array:
- All `full` → coverage is `full`
- Mix of `full` and `partial` → coverage is `partial`
- Any orphans → coverage report should flag `orphan_tasks: <count>`

The downstream coverage-enforcer reads `action-items-enriched.json` and `orphan-tasks.json` together when deciding whether to escalate.
