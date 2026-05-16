---
name: extract-deals
version: 1.0.0
description: |
  Extract every deal mentioned in a meeting transcript, including stage corrections,
  referrer corrections, and intel. Single focused pass. Output one structured JSON.
triggers:
  - "extract deals"
  - "deal extraction"
  - multi-extract orchestrator
tools:
  - get_page
  - search
inputs:
  - meeting_slug
  - brief_slug (optional)
outputs:
  - "/Users/jarvis/brain/extractions/<meeting_slug>/deals.json"
mutating: false
---

# Extract Deals

Narrow extractor. Reads ONE meeting transcript + (optionally) the pre-call brief's `deals_referenced` frontmatter. Returns a JSON array of every deal mentioned, with explicit fields for CRM-vs-stated stage and referrer mismatches.

## Contract

- **Single focused pass.** Do not extract action items, personal context, competitors, or anything else. Only deals.
- **CRM-vs-stated mismatch is a FIRST-CLASS field.** If the transcript contradicts the pre-call brief's stage/referrer for a deal, set `*_correction_needed: true` and quote the exact line.
- **Quote, don't paraphrase, the key transcript line.** One verbatim quote per deal.
- **Empty array is a valid output** if no deals are discussed.
- **Idempotent.** Re-running on the same transcript produces the same JSON.

## Inputs

- `meeting_slug` — e.g., `2026-05-13-samuel-cloutier`. Load transcript from `~/brain/meetings/<slug>.md` AND/OR the Granola transcript via gbrain.
- `brief_slug` (optional) — e.g., `samuel-cloutier-2026-05-13`. Load `deals_referenced` frontmatter to compare against.

## Output schema

Write to `~/brain/extractions/<meeting_slug>/deals.json`. Array of objects:

```json
[
  {
    "deal_name": "string — as stated in transcript",
    "stage_stated": "string | null — Won | Onboarded | DSA to be signed | Pending KYC | Pricing sent | Followed up | Initial call | Follow-up 3mo | Lost | unclear",
    "stage_in_crm": "string | null — from brief frontmatter, null if no brief",
    "stage_correction_needed": "boolean — true if stated ≠ crm",
    "value_usd": "number | null",
    "referrer_stated": "string | null — what the counterparty said on the call",
    "referrer_in_crm": "string | null — from brief frontmatter",
    "referrer_correction_needed": "boolean",
    "deal_length_days_stated": "number | null",
    "key_quote": "string — one verbatim line from transcript that anchors this deal",
    "intel": "string | null — single-sentence insight from the discussion beyond stage/$/referrer",
    "deal_slug_hint": "string | null — kebab-case for downstream linking"
  }
]
```

## Anti-patterns

- Extracting action items as deals (e.g., "send VASP list" is not a deal — `extract-action-items` handles it)
- Inferring stage from tone instead of explicit statement — use `"unclear"` when ambiguous
- Listing the same deal twice (de-dupe on `deal_name`)
- Inventing referrers — if the transcript doesn't say, use `null`
- Adding commentary or narrative — JSON output only

## Prompt (the skill IS the prompt)

> You are a deal extractor. Read the meeting transcript provided. Identify every named deal, opportunity, or client engagement discussed. For each, output one object per the schema above. Compare against the pre-call brief's `deals_referenced` frontmatter if provided — flag any stage or referrer mismatch with the `*_correction_needed: true` field. Quote the exact transcript line for `key_quote`. Output ONLY the JSON array, no preamble or commentary. If no deals are discussed, output `[]`.
