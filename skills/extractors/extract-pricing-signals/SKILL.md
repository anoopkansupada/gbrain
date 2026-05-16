---
name: extract-pricing-signals
version: 1.0.0
description: |
  Extract every price point, fee ladder, pricing objection, or pricing strategy
  mentioned in a meeting transcript.
triggers:
  - "extract pricing"
  - multi-extract orchestrator
tools:
  - get_page
inputs:
  - meeting_slug
outputs:
  - "/Users/jarvis/brain/extractions/<meeting_slug>/pricing.json"
mutating: false
---

# Extract Pricing Signals

Narrow extractor. Pulls every price point, ladder, ratchet, or objection from the transcript. Drives pricing playbook + competitive positioning.

## Contract

- **Fee ladders are structured.** "$40k now → $50k at 3 → $100k at 8-9" becomes an array of `{capacity, price}` pairs.
- **Currency must be explicit** — assume USD unless transcript says otherwise.
- **Objections vs strategy are separate categories.** A client saying "too expensive" = `category: objection`. The director's own pricing strategy = `category: strategy`.
- **Empty array valid.**

## Output schema

```json
[
  {
    "category": "current_price | fee_ladder | objection | strategy | competitor_price",
    "context": "string — what product/service/deal this pricing applies to",
    "current_price_usd": "number | null",
    "ladder": [{"trigger": "string", "price_usd": "number"}],
    "objection_or_loss": "string | null",
    "strategic_rationale": "string | null",
    "verbatim": "string — exact transcript line"
  }
]
```

## Prompt

> You are a pricing-signals extractor. Read the transcript. Find every mention of price, fee, cost, billing, retainer, or pricing strategy. For each: output one object per schema. Fee ladders (e.g., "ramp from $40k to $100k as capacity decreases") become a `ladder` array of `{trigger, price_usd}` pairs. Objections from clients are separate from the director's own pricing strategy. Output ONLY JSON. Empty `[]` if no pricing discussed.
