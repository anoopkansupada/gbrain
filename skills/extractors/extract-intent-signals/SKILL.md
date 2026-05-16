---
name: extract-intent-signals
version: 1.0.0
description: |
  Extract buying signals, ICP definition, collaboration intent, and expansion
  indicators from a meeting transcript. Drives BD targeting, switching-motion
  playbook, and partner pipeline scoring.
triggers:
  - "extract intent signals"
  - multi-extract orchestrator
tools:
  - get_page
inputs:
  - meeting_slug
  - brief_slug (optional)
outputs:
  - "/Users/jarvis/brain/extractions/<meeting_slug>/intent-signals.json"
mutating: false
---

# Extract Intent Signals

Narrow extractor. Reads ONE meeting transcript and surfaces explicit or implicit signals about what the counterparty intends to do, what kind of client they want, who they want to work with, and where they are in any buying or partnership motion.

## Contract

- **Signal must be grounded in the transcript.** No inferences from tone alone — quote the line.
- **Two signal directions:** (a) counterparty's intent toward Hash Directors/Lemma; (b) counterparty's ICP definition for clients they're sourcing, which informs who we send them.
- **Anti-ICP is as valuable as ICP.** If the counterparty says "don't send me DAOs," capture it — prevents wasted outreach.
- **Buying stage is distinct from deal stage.** A deal at "DSA signed" is closed; a new-service signal at "I'd want that at scale" is a live intent signal. Capture both.
- **Empty array is valid** — not every call has clear intent signals.

## Output schema

Write to `~/brain/extractions/<meeting_slug>/intent-signals.json`:

```json
[
  {
    "signal_type": "icp_definition | anti_icp | buying_intent | expansion_intent | partnership_intent | referral_intent | timing_signal | competitor_switch_intent",
    "subject": "string — who or what the signal is about",
    "signal_description": "string — one-sentence description of the signal",
    "icp_criteria": ["string"] ,
    "anti_icp_criteria": ["string"],
    "strength": "explicit | implied | inferred",
    "verbatim": "string — transcript quote anchoring the signal",
    "next_action": "string | null — what we should do in response to this signal",
    "timeline": "string | null — e.g., 'wants to expand in Q3', 'actively looking now'"
  }
]
```

## Prompt

> You are an intent-signal extractor. Read the transcript. Identify every signal about intent: what the counterparty plans to do, what kind of client they want to work with (ICP), what kinds of clients they explicitly don't want (anti-ICP), whether they're signaling interest in new services from us, or whether they're open to switching providers. Two directions matter: their intent toward us, and the ICP profile they expressed for their own sourcing. For each signal: output one object per schema. Strength: explicit = said directly, implied = strong inference, inferred = reading between the lines. Output ONLY the JSON array. Empty `[]` if no clear signals.

## Anti-patterns

- Treating general conversation as intent signals — test: "would this change what we pitch next call?" If not, skip
- Conflating deal stage with intent signal — use `extract-deals` for existing deal stages
- Missing anti-ICP — counterparty exclusions are high-value to avoid bad referral matches
- Collapsing multiple signals into one entry
