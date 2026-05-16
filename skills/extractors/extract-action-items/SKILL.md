---
name: extract-action-items
version: 1.0.0
description: |
  Extract every bilateral commitment from a meeting transcript with explicit
  owner attribution and counterparty pairing. Drives task pages + follow-up email.
triggers:
  - "extract action items"
  - multi-extract orchestrator
tools:
  - get_page
inputs:
  - meeting_slug
  - operator_slug (default: people/anoop-kansupada)
outputs:
  - "/Users/jarvis/brain/extractions/<meeting_slug>/action-items.json"
mutating: false
---

# Extract Action Items

Narrow extractor. Reads ONE meeting transcript and produces a JSON list of every commitment, with explicit ownership (operator vs counterparty) and bilateral pairing (Sam sends X → I research X).

## Contract

- **Bilateral pairing.** If a commitment from one side enables an action from the other, link them with `bilateral_pair_slug`. Drives the follow-up email's reciprocity framing.
- **No inferred actions.** Only commitments stated in the transcript. "I'll send you the list" → yes. "I should follow up" without explicit commitment → no.
- **Owner is always a person slug** in `[[people/<slug>]]` format.
- **Due dates only when explicit OR inferable from context** (e.g., "this week" → +5 business days). Otherwise `null`.
- **Empty array is valid.**

## Output schema

Write to `~/brain/extractions/<meeting_slug>/action-items.json`:

```json
[
  {
    "title": "string — imperative form",
    "owner": "[[people/<slug>]]",
    "owner_role": "operator | counterparty | both",
    "due_stated": "YYYY-MM-DD | null",
    "due_inferred": "YYYY-MM-DD | null",
    "priority": "high | medium | low",
    "verbatim": "string — exact transcript line",
    "bilateral_pair_title": "string | null — the other action this enables/depends on",
    "task_slug_hint": "string — kebab-case",
    "context": "string | null — one sentence why this matters"
  }
]
```

## Prompt

> You are an action-item extractor. Read the meeting transcript. Identify every commitment — anything the operator or counterparty said they would do, send, follow up on, research, decide, or deliver. For each: output one object per the schema. If two commitments form a bilateral pair (one enables the other), link them via `bilateral_pair_title`. Use `null` for unknown due dates. Owner must be a person slug. Output ONLY the JSON array. Empty array `[]` if no commitments.

## Anti-patterns

- Listing "we discussed X" as an action item — discussion is not commitment
- Inventing priorities — use `medium` as default; only mark `high` when transcript signals urgency
- Inferring due dates from politeness (no, "I'll send it soon" → `null`)
- Merging two separate commitments into one entry
