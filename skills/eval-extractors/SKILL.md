---
name: eval-extractors
version: 1.0.0
description: |
  Evaluates the 10-extractor system against a ground-truth eval file. For each
  assertion, checks the actual extraction JSON and scores: CAPTURED / PARTIAL / MISSED.
  Produces a per-extractor coverage score and a ranked list of missed facts.
triggers:
  - "eval extractors"
  - "score extractors"
  - "run extractor eval"
tools:
  - get_page
  - search
inputs:
  - meeting_slug — e.g. "2026-05-13-samuel-cloutier"
  - eval_file (optional) — defaults to ~/gbrain/evals/extractors/<meeting_slug>.eval.json
outputs:
  - "~/gbrain/evals/extractors/<meeting_slug>.eval-result.json"
  - stdout: human-readable coverage report
mutating: false
---

# Eval Extractors

Scores the 10-extractor system against a ground-truth eval file. Run after `multi-extract` has produced its 10 JSON outputs for a meeting.

## Contract

- **One assertion at a time.** For each assertion in the eval file, load the relevant extractor's JSON and judge whether the fact is captured.
- **Three verdicts only:** `CAPTURED` (fact clearly present), `PARTIAL` (fact present but incomplete or imprecise), `MISSED` (fact absent or wrong).
- **Quote the evidence.** For CAPTURED and PARTIAL, quote the specific JSON field that satisfies the assertion. For MISSED, state what the JSON does say instead.
- **Do not invent.** If the JSON is empty or irrelevant, verdict is MISSED.
- **Severity weighting:** CRITICAL assertions count double in the coverage score.

## Inputs

- `meeting_slug` — load eval file from `~/gbrain/evals/extractors/<meeting_slug>.eval.json`
- `extractions_dir` — load 10 JSONs from `~/brain/extractions/<meeting_slug>/`

## Scoring

Per-extractor score = (CAPTURED + 0.5 × PARTIAL) / total_assertions_for_extractor, weighted by severity (critical = 2×, high = 1.5×, medium = 1×).

Overall score = same formula across all assertions.

## Output schema

Write to `~/gbrain/evals/extractors/<meeting_slug>.eval-result.json`:

```json
{
  "meeting_slug": "string",
  "eval_version": "number",
  "run_at": "ISO8601",
  "overall_score": "0.0-1.0",
  "per_extractor": {
    "<extractor-name>": {
      "score": "0.0-1.0",
      "assertions_total": "number",
      "captured": "number",
      "partial": "number",
      "missed": "number"
    }
  },
  "results": [
    {
      "id": "string",
      "extractor": "string",
      "severity": "critical | high | medium",
      "description": "string",
      "verdict": "CAPTURED | PARTIAL | MISSED",
      "evidence": "string — JSON quote for CAPTURED/PARTIAL; what was found instead for MISSED",
      "notes": "string | null"
    }
  ],
  "missed_critical": ["string — assertion IDs"],
  "off_record_facts": ["string — from eval file, not scored"]
}
```

## Prompt (the skill IS the prompt)

> You are an extraction evaluator. You have two sets of inputs:
> 1. A ground-truth eval file at `~/gbrain/evals/extractors/<meeting_slug>.eval.json` — a list of assertions, each specifying which extractor should capture a specific fact from the meeting transcript.
> 2. The actual extraction outputs at `~/brain/extractions/<meeting_slug>/` — 10 JSON files, one per extractor.
>
> For each assertion:
> - Load the specified extractor's JSON output.
> - Judge: does the JSON capture the fact described in the assertion? Verdict: CAPTURED (clearly present), PARTIAL (present but incomplete), or MISSED (absent or wrong).
> - For CAPTURED/PARTIAL: quote the specific JSON value that satisfies the assertion.
> - For MISSED: state what the JSON says instead (or "JSON is empty" if empty array).
>
> Calculate per-extractor scores using severity weights (critical=2×, high=1.5×, medium=1×). Score = (CAPTURED + 0.5×PARTIAL) / weighted_total.
>
> Write the full result to `~/gbrain/evals/extractors/<meeting_slug>.eval-result.json`.
>
> Then print a human-readable summary:
> ```
> === EXTRACTOR EVAL: <meeting_slug> ===
> Overall: <score>% (<n> assertions: <captured> CAPTURED, <partial> PARTIAL, <missed> MISSED)
>
> Per-extractor:
>   extract-deals:            XX% (<n> assertions)
>   extract-corrections:      XX%
>   ... (all 10)
>
> MISSED (critical):
>   - <assertion_id>: <description>
>
> MISSED (high):
>   - <assertion_id>: <description>
>
> Off-record (not scored):
>   - <fact>
> ```

## Anti-patterns

- Marking CAPTURED when the JSON contains the deal name but misses the key qualifier (e.g., has "Cashy" but as `stage: unknown` when transcript says Active) — that's PARTIAL
- Marking MISSED for facts that genuinely aren't in the transcript (check `off_record_facts` in the eval file — these are excluded from scoring)
- Averaging scores without severity weighting
- Skipping the evidence quote — unverifiable verdicts are useless for prompt tuning
