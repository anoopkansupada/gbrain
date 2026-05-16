---
name: extract-relationship-graph
version: 1.0.0
description: |
  Extract every third party named in the transcript — people, firms, organisations
  — with relationship context, warm-intro potential, and social graph signals.
  Builds the warm-path graph used by the cockpit and BD targeting.
triggers:
  - "extract relationship graph"
  - multi-extract orchestrator
tools:
  - get_page
  - search
inputs:
  - meeting_slug
  - brief_slug (optional)
outputs:
  - "/Users/jarvis/brain/extractions/<meeting_slug>/relationship-graph.json"
mutating: false
---

# Extract Relationship Graph

Narrow extractor. Reads ONE meeting transcript and maps every third party mentioned — anyone the counterparty knows, worked with, referred to, vouched for, or named. These are warm-intro targets, referral sources, and network expansion nodes.

## Contract

- **Third parties only.** The counterparty and the operator are not extracted here (they're the `people/*` pages themselves). Extract everyone ELSE named.
- **Relationship strength and availability.** How does the counterparty know this person? Are they offering intro access? Is the relationship warm, cold, or complicated?
- **Do not fabricate contact details.** If no email or LinkedIn was provided, leave `contact` null.
- **Every named person/firm gets one entry.** De-dupe on canonical name. If the same person appears under two aliases, merge and note both in `aliases`.
- **Empty array is valid** for calls with no third-party names.

## Output schema

Write to `~/brain/extractions/<meeting_slug>/relationship-graph.json`:

```json
[
  {
    "entity_type": "person | firm | organisation | event",
    "name": "string — canonical name as stated",
    "aliases": ["string"],
    "role_or_context": "string — who they are and why they were named",
    "counterparty_relationship": "string — how the counterparty knows them (e.g., '8-year working relationship', 'co-founded with')",
    "relationship_valence": "positive | neutral | negative | complicated",
    "intro_available": "boolean — counterparty explicitly offered intro access",
    "intro_conditions": "string | null — any stated conditions on intro (e.g., 'at a conference', 'on request')",
    "warm_path_via": "[[people/<counterparty-slug>]]",
    "our_priority": "high | medium | low | not_relevant",
    "verbatim": "string — transcript quote where they were named",
    "gbrain_stub_slug": "string | null — kebab-case slug for the new people/* or companies/* stub page"
  }
]
```

## Prompt

> You are a relationship-graph extractor. Read the transcript. Identify every third party mentioned by name — people, firms, organisations, events. For each: capture who they are, how the counterparty knows them, whether the counterparty offered or implied access to an introduction, and our priority for following up. Do NOT extract the counterparty themselves or the operator — only third parties. De-dupe on canonical name. Output ONLY the JSON array. Empty `[]` if no third parties are named.

## Anti-patterns

- Extracting the counterparty themselves as a third party (they are the subject, not an object here)
- Adding priority judgments without transcript basis — `medium` is the safe default
- Inventing contact details not in the transcript
- Extracting organisations mentioned purely for historical context with no actionable path (e.g., "I worked at Goldman 20 years ago")
