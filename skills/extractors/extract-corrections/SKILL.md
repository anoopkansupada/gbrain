---
name: extract-corrections
version: 1.0.0
description: |
  Extract every correction the counterparty made to our data — CRM fields, name
  spellings, stage labels, referrer attribution, fact errors. Highest-leverage
  extractor — every correction = a data-quality bug fixed.
triggers:
  - "extract corrections"
  - multi-extract orchestrator
tools:
  - get_page
  - search
inputs:
  - meeting_slug
  - brief_slug
outputs:
  - "/Users/jarvis/brain/extractions/<meeting_slug>/corrections.json"
mutating: false
---

# Extract Corrections

Narrow extractor. The single highest-leverage extraction we run. Every correction the counterparty makes to our records = a future error prevented + trust gained.

## Contract

- **Active corrections only.** "The CRM says X but actually Y" = correction. "I don't remember" = not a correction. "Just to clarify" = correction.
- **Always link to source-of-truth.** Each correction should specify `downstream_fix` — which file/system needs updating (monday CRM, gbrain people/<slug>, brief frontmatter, etc).
- **Compare against the pre-call brief.** If a correction matches a brief fact, flag it. Helps the brief generator learn.
- **Empty array means the call had no corrections — that's a signal the brief was accurate (or the counterparty wasn't paying attention).**

## Output schema

```json
[
  {
    "subject": "string — what was being discussed (deal, person, fact)",
    "our_data": "string — what our records currently say",
    "their_correction": "string — what the counterparty said is actually true",
    "evidence_quote": "string — verbatim",
    "data_source_to_fix": "monday_crm | gbrain_page | brief_frontmatter | external_system | unknown",
    "downstream_fix_description": "string — concrete change",
    "blocked_by": "operator_action | counterparty_send | system_patch | unknown",
    "priority": "high | medium | low"
  }
]
```

## Prompt

> You are a corrections extractor. Read the transcript. Identify every moment the counterparty corrected, clarified, or updated information about a deal, person, firm, stage, referrer, name, date, or fact. For each: output one object per schema. Specify which data system needs the fix. Priority: corrections that affect outbound (CRM stage, referrer attribution) = high; name spellings = medium; historical context = low. Output ONLY JSON. Empty `[]` if no corrections.

## Anti-patterns

- Extracting *new* facts that don't conflict with existing data (use `extract-personal-context` or other extractors)
- Labeling every clarification as a correction — the test is "does our record currently differ?"
- Missing the verbatim quote — corrections without evidence are unverifiable
