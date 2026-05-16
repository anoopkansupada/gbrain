---
name: extract-competitor-mentions
version: 1.0.0
description: |
  Extract every competitor named in a meeting transcript with context, stance,
  and switching-motion impact.
triggers:
  - "extract competitors"
  - multi-extract orchestrator
tools:
  - get_page
  - search
inputs:
  - meeting_slug
outputs:
  - "/Users/jarvis/brain/extractions/<meeting_slug>/competitors.json"
mutating: false
---

# Extract Competitor Mentions

Narrow extractor. Surfaces every competitor (firm or named individual) discussed, with the **stance** (cold-flippable vs personal-relationship-locked).

## Contract

- **Stance is the highest-leverage field.** "Sarah at Marfire — ex-government colleague, personal relationship" = `stance: personal_relationship_locked`. "Some firm we lost to" = `stance: switching_target`. Drives whether cold outreach makes sense.
- **Include individuals, not just firms.** Sarah Marfire is a person; Marfire is the firm. Both go in.
- **Context is critical.** "We lost X to them" ≠ "They sent us X". `context_type` field disambiguates.
- **Empty array is valid.**

## Output schema

```json
[
  {
    "competitor_firm": "[[companies/<slug>]] | null",
    "named_person": "[[people/<slug>]] | null",
    "context_type": "lost_deal_to | won_deal_from | personal_relationship | regulatory_competitor | mentioned_neutral",
    "context": "string — one sentence",
    "stance": "switching_target | personal_relationship_locked | reciprocal_referrer | unknown",
    "deal_impact": "string | null — which deal of ours this affects",
    "verbatim": "string — exact transcript line"
  }
]
```

## Prompt

> You are a competitor extractor. Read the transcript. Identify every competitor firm OR named individual at a competitor mentioned by the counterparty. For each: output one object per the schema. `stance` is critical — if the counterparty has a personal relationship with them (ex-colleague, friend, co-author), use `personal_relationship_locked`. If they've taken business from us OR appear in our switching list, use `switching_target`. Output ONLY the JSON array. Empty `[]` if no competitors named.

## Anti-patterns

- Listing every law firm as a competitor (law firms = referrers, separate extractor)
- Inferring stance from one word — use `unknown` when ambiguous
- Including the counterparty's own firm (Hash Directors) as a competitor
