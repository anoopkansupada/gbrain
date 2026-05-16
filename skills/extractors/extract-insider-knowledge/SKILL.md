---
name: extract-insider-knowledge
version: 1.0.0
description: |
  Extract non-public facts disclosed under implicit confidentiality — regulatory
  pipeline intel, internal org knowledge, pre-announcement moves. Tags each fact
  with handling instructions. Never surfaces content externally; feeds confidential
  frontmatter in briefs only.
triggers:
  - "extract insider knowledge"
  - multi-extract orchestrator
tools:
  - get_page
inputs:
  - meeting_slug
  - brief_slug (optional)
outputs:
  - "/Users/jarvis/brain/extractions/<meeting_slug>/insider-knowledge.json"
mutating: false
---

# Extract Insider Knowledge

Narrow extractor. Reads ONE meeting transcript and identifies facts that are not publicly available and were shared in confidence or by virtue of the counterparty's privileged role. These facts drive our content strategy and competitive positioning — but must never leak to external communications.

## Contract

- **Confidentiality-first.** Any fact tagged `do_not_share_externally: true` must NOT appear in follow-up emails, blog drafts, or any outbound. It feeds only the confidential frontmatter of the gbrain brief.
- **Source-role matters.** Who is the counterparty and WHY do they have this intel? Ex-government = regulatory pipeline. CIMA insider = enforcement stance. Law firm partner = upcoming deal flow.
- **Actionability is required.** Only include insider facts that change what we write, who we call, or what we pitch. Pure gossip with no downstream use: exclude.
- **One JSON object per fact.** Do not aggregate — keep granular so individual facts can be redacted independently.

## Output schema

Write to `~/brain/extractions/<meeting_slug>/insider-knowledge.json`:

```json
[
  {
    "fact": "string — the non-public fact in one sentence",
    "source_role": "string — why the counterparty has this knowledge (e.g., 'ex-CIMA Director, 7 years inside Ministry')",
    "fact_category": "regulatory_pipeline | enforcement_stance | deal_flow | org_intel | market_move | other",
    "confidentiality": "trade_secret_in_house | shared_in_confidence | inferred_nonpublic | public_but_unreported",
    "handling": "string — how we use this (e.g., 'drives VASP article title', 'informs which VASPs to target')",
    "do_not_share_externally": "boolean",
    "evidence_quote": "string — verbatim transcript line confirming the fact",
    "expires_relevance": "string | null — when this fact becomes stale (e.g., 'after CIMA publishes DeFi rules')"
  }
]
```

## Prompt

> You are an insider-knowledge extractor. Read the transcript. Identify facts the counterparty disclosed that are NOT publicly available — regulatory developments, internal org intelligence, pre-announcement moves, unpublished data, enforcement signals. For each: output one object per schema. Tag confidentiality level. Specify whether it can appear in external communications. Output ONLY the JSON array. Empty `[]` if no non-public facts were shared.

## Anti-patterns

- Extracting public facts (e.g., "CIMA published regulation X last year") — only NON-PUBLIC
- Conflating personal anecdotes with insider knowledge — test: "would a journalist pay for this?" If not, skip
- Omitting evidence quote — unverifiable facts are a liability
- Including facts that have no downstream use for Hash Directors or Lemma
