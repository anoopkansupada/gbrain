---
name: extract-personal-context
version: 1.0.0
description: |
  Extract personal context (family, geography, values, beliefs, hobbies, irritants)
  from a meeting transcript. Drives rapport-building and next-call references.
triggers:
  - "extract personal context"
  - multi-extract orchestrator
tools:
  - get_page
inputs:
  - meeting_slug
outputs:
  - "/Users/jarvis/brain/extractions/<meeting_slug>/personal.json"
mutating: false
---

# Extract Personal Context

Narrow extractor. The rapport layer. Captures everything non-business the counterparty volunteered that builds trust on future calls.

## Contract

- **Only what the counterparty volunteered.** Don't extract things they were directly asked. Volunteered = high-signal.
- **Categorize by fact type.** Family, geography, values, beliefs, hobbies, irritants, professional history (non-current-role), public engagements.
- **Verbatim quote for every fact.** This is where paraphrase loses character.
- **`rapport_use` field rates how to deploy it.** High = open the next call with it. Low = save for context, don't lead with.

## Output schema

```json
[
  {
    "subject": "[[people/<slug>]]",
    "fact": "string — concise statement",
    "fact_type": "family | geography | values | beliefs | hobbies | irritants | prior_career | public_speaking | health | other",
    "rapport_use": "high | medium | low",
    "next_call_hook": "string | null — how to open with this on the next call",
    "verbatim": "string — exact transcript line"
  }
]
```

## Prompt

> You are a personal-context extractor. Read the transcript. Find every fact the counterparty *volunteered* about themselves outside of their current professional role — family, geography, values, beliefs, hobbies, irritants, prior careers, public engagements, health. For each: output one object per schema. `rapport_use` ranks deployability: `high` for things you'd open the next call with, `medium` for context, `low` for archive-only. Output ONLY JSON. Empty `[]` if no personal context shared.

## Anti-patterns

- Extracting professional history that's already on their LinkedIn (use `prior_career` only if it's non-obvious)
- Inferring values from one word (`beliefs` requires an explicit statement)
- Capturing only quotable lines — sometimes the fact is in summary form
