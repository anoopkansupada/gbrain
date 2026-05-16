---
name: extract-referrer-network
version: 1.0.0
description: |
  Extract every law firm / introducer / referrer mentioned, with named contacts,
  relationship strength, and firm-office disambiguation (e.g., Walkers UK vs Walkers Cayman).
triggers:
  - "extract referrers"
  - multi-extract orchestrator
tools:
  - get_page
  - search
inputs:
  - meeting_slug
outputs:
  - "/Users/jarvis/brain/extractions/<meeting_slug>/referrers.json"
mutating: false
---

# Extract Referrer Network

Narrow extractor. Maps the counterparty's referral graph: every law firm, introducer, professional services partner mentioned.

## Contract

- **Firm-office disambiguation is mandatory.** "Walkers" → ask which office. Default to the office the counterparty named. If unknown, set `office: "unclear"` and flag it.
- **Named contact required when stated.** "Melissa Lim at Walkers UK" → both fields populated.
- **Deals sourced is a list.** Cross-reference against `extract-deals.json` output if available.
- **Relationship strength field is qualitative.** Use the counterparty's language: "trusted on legislation, 8 years" → `relationship_strength: "trusted_long_term"`.

## Output schema

```json
[
  {
    "referrer_firm": "string — as named",
    "referrer_firm_slug": "[[companies/<slug>]]",
    "office": "string — UK, Cayman, Dubai, unclear, etc.",
    "named_contact": "[[people/<slug>]] | null",
    "named_contact_raw": "string | null — exact name as spoken",
    "relationship_strength": "trusted_long_term | warm | transactional | cold | unknown",
    "deals_sourced_to_us": ["deal_name"],
    "deals_sourced_elsewhere": "string | null — context",
    "open_action": "string | null — what should we do with this relationship",
    "verbatim": "string — exact transcript line"
  }
]
```

## Prompt

> You are a referrer-network extractor. Read the transcript. Identify every law firm, professional services firm, or introducer mentioned as a source of business or potential source. For each: output one object per schema. **Critical: disambiguate firm vs office.** If the counterparty says "Walkers" but context says UK or Dubai, the office field captures it. Cross-reference with deals discussed — which referred deals came through whom. Output ONLY the JSON array. Empty `[]` if no referrers named.

## Anti-patterns

- Listing competitor firms here — `extract-competitor-mentions` handles those
- Conflating Walkers UK with Walkers Cayman (the bug that lost 70% of Samuel's call)
- Missing the named contact — the firm without the person is half the value
