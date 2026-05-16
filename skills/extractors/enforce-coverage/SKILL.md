---
name: enforce-coverage
version: 1.0.0
description: |
  After post-call-processor Phase 1 fans out the 10 extractors, verify every
  expected output landed, retry missing or empty extractors once, and write
  a coverage-report.json. If coverage is still incomplete after retry,
  halt the processor and create a manual-review task instead of letting
  downstream phases write tasks/emails from a half-formed extraction set.
  Without this, extractor failures land silently and the brief reports
  "3 extractors did not run" days later.
triggers:
  - "enforce coverage"
  - "verify extractor coverage"
  - multi-extract orchestrator
  - post-call-processor (Phase 1.5, between fan-out and write-back)
tools:
  - get_page
  - list_pages
inputs:
  - meeting_slug
  - extractions_dir (default ~/brain/extractions/<meeting_slug>/)
  - expected_extractors (default: all 10 from the registry)
outputs:
  - "/Users/jarvis/brain/extractions/<meeting_slug>/coverage-report.json"
  - "/Users/jarvis/brain/tasks/<meeting_slug>-manual-review.md"  # only if escalating
mutating: true   # writes coverage-report and conditionally a manual-review task
writes_pages: true
writes_to:
  - extractions/   # coverage-report.json (always)
  - tasks/         # manual-review task (only on escalation)
---

# Enforce Coverage

The post-call-processor fans out N extractors in parallel. The current behavior on failure is that the missing extractor's output file simply isn't there, and the orchestrator proceeds anyway — meaning a call's downstream tasks, brief, and follow-up email are built from a partial picture. This skill closes the loop: verify, retry once, escalate if still incomplete.

## Why this exists

Real example from `briefs/petri-karel-2026-05-13`: the brief itself reports "3 extractors did not run — competitor-mentions, referrer-network, corrections (output files missing; Phase 1 fan-out likely incomplete for these skills)." Coverage was already being measured — but only after the damage was done, with no retry and no halt. This skill is the missing checkpoint between fan-out and write-back.

## Contract

- **Idempotent.** Re-running on the same extractions directory produces the same coverage-report.json. If every expected extractor output exists and has `coverage: full`, the skill is a no-op.
- **Retry once.** For any extractor that's `missing` or `failed` (see status taxonomy below), invoke that extractor exactly one more time. Do not retry a third time — that's a real failure, not a transient one.
- **Empty arrays are not failures.** `action-items.json` containing `[]` is a legitimate result for a personal-context-heavy call. Distinguish `empty` from `missing`. Treat both as coverage but mark `empty` so downstream phases can skip cleanly.
- **Escalate, don't silently degrade.** If after retry more than one extractor is still `failed` OR `inferred`, halt the processor: write a `manual-review` task with the specific gaps and stop. Do not let downstream phases write a brief from a half-formed extraction set.
- **The threshold is configurable but defaults to >1.** A single missing extractor is recoverable downstream (the brief will flag it). Two or more is a structural failure — the operator needs to see what happened before tasks and emails get written from partial data.
- **Never modify extractor outputs.** This skill reads them and reports. Retries are invocations of the upstream extractor, which writes its own output. The coverage-report is the only new artifact this skill produces (plus the manual-review task on escalation).

## Status taxonomy

For each expected extractor, classify into one of:

| Status | Meaning | Action |
|---|---|---|
| `full` | Output file exists, non-empty, well-formed | Pass |
| `empty` | Output file exists, is an empty array `[]` | Pass (legitimate "nothing to extract") |
| `missing` | Output file does not exist | Retry once |
| `failed` | Output file exists but malformed (not valid JSON, schema mismatch, error frontmatter) | Retry once |
| `partial` | Output exists and valid, but extractor self-reported `completion_status: partial` (future-state, when extractors adopt this field) | Retry once |
| `inferred` | Extractor self-reported `completion_status: inferred` (low-confidence output) | Flag, do not retry |

After retry, only `full`, `empty`, and `inferred` are acceptable. Any `missing`, `failed`, or `partial` after retry → escalation.

## Inputs

- `meeting_slug` — e.g., `2026-05-04-petri-anoop`.
- `extractions_dir` — defaults to `~/brain/extractions/<meeting_slug>/`.
- `expected_extractors` — defaults to the canonical 10, as `name → output_filename` pairs (the file name does not always match the extractor name):

  | Extractor name | Output file |
  |---|---|
  | `extract-deals` | `deals.json` |
  | `extract-action-items` | `action-items.json` |
  | `extract-pricing-signals` | `pricing.json` |
  | `extract-personal-context` | `personal.json` |
  | `extract-insider-knowledge` | `insider-knowledge.json` |
  | `extract-intent-signals` | `intent-signals.json` |
  | `extract-relationship-graph` | `relationship-graph.json` |
  | `extract-competitor-mentions` | `competitors.json` |
  | `extract-referrer-network` | `referrers.json` |
  | `extract-corrections` | `corrections.json` |

  Plus the enrichment artifacts when `enrich-tasks` is in the pipeline:
  - `enrich-tasks` → `action-items-enriched.json` (and `orphan-tasks.json` as a sibling, both optional — absent orphans file is treated as `empty`).

  Read the live registry from `~/gbrain/skills/extractors/*/SKILL.md` `outputs:` field at runtime when possible — hardcoding this map will rot the moment a new extractor is added.

## Algorithm

1. **Pre-scan.** For each expected extractor name, check whether `<extractions_dir>/<name>.json` exists. Classify per the status taxonomy.
2. **First-pass coverage.** Build the initial coverage map. If every entry is `full` or `empty`, write coverage-report and exit successfully.
3. **Retry phase.** For each `missing` or `failed` entry, invoke the corresponding upstream extractor exactly once. Wait for completion.
4. **Re-scan.** Re-classify after retry.
5. **Decision.**
   - If every entry is `full`, `empty`, or `inferred` AND the count of `inferred` is 0 or 1 → write coverage-report, exit success.
   - Otherwise → write coverage-report AND create a manual-review task; return a halt signal to the orchestrator.

## Output schema

### coverage-report.json

Written to `<extractions_dir>/coverage-report.json`. Idempotent — overwrites prior report.

```json
{
  "meeting_slug": "2026-05-04-petri-anoop",
  "checked_at": "<ISO timestamp>",
  "expected_count": 10,
  "extractors": [
    {
      "name": "deals",
      "status_first_pass": "full | empty | missing | failed | partial | inferred",
      "status_final": "full | empty | missing | failed | partial | inferred",
      "retried": true,
      "output_path": "/Users/jarvis/brain/extractions/<slug>/deals.json",
      "size_bytes": 4823,
      "row_count": 3,
      "error": "string | null"
    }
  ],
  "summary": {
    "full": 7,
    "empty": 1,
    "inferred": 1,
    "missing_after_retry": 1,
    "failed_after_retry": 0
  },
  "verdict": "pass | escalate",
  "escalation_reason": "string | null"
}
```

### manual-review task (only on escalation)

Written to `~/brain/tasks/<meeting_slug>-manual-review.md`:

```yaml
---
type: task
title: "Manual review: extractor coverage incomplete for <meeting_slug>"
status: open
owner: "[[people/anoop-kansupada]]"
priority: high
created_from: enforce-coverage
created: <ISO timestamp>
related_meeting: "[[meetings/<meeting_slug>]]"
tags: [task, manual-review, coverage-failure]
---

# Manual review: extractor coverage incomplete

Coverage enforcement halted post-call processing for [[meetings/<meeting_slug>]] because more than one extractor failed to produce a usable output after retry.

## What's missing

<bulleted list from coverage-report.json — for each non-full extractor: name, status, error>

## What to do

1. Read `~/brain/extractions/<meeting_slug>/coverage-report.json` for full detail.
2. Decide whether to fix the failing extractor(s) and re-run post-call-processor, OR
3. Proceed manually by editing the brief and writing tasks/emails by hand.

Do NOT let post-call-processor finish on this meeting until coverage is resolved — it will write a brief from incomplete data.
```

## Anti-patterns

- Retrying more than once. If an extractor fails twice, the operator needs to see it, not have the orchestrator paper over it.
- Treating `empty` as `missing`. An LLM correctly returning `[]` for "no deals discussed in this call" is a successful extraction.
- Retrying `inferred` outputs. Low-confidence output won't get higher-confidence on retry — flag and surface.
- Stubbing out missing extractor outputs with `[]` to make the count look right. The whole point is to NOT silently degrade.
- Letting downstream phases run when verdict is `escalate`. The halt signal must short-circuit the rest of post-call-processor.

## Integration with post-call-processor

Add to `post-call-processor/SKILL.md` between current Phase 1 (load context) and Phase 3 (extract structured facts), as Phase 1.5:

> ### 1.5. Enforce extractor coverage
>
> Invoke `enforce-coverage` with the current `meeting_slug`. Read its returned `verdict`:
> - `pass` → proceed to Phase 2 (speaker disambiguation) or 3 (extract).
> - `escalate` → halt. The manual-review task is already filed; the operator will resume after fixing the failing extractor.

When `enrich-tasks` is in the pipeline, add a second coverage check after enrichment (Phase 5.6 — between enrich-tasks and task-write) with the expected_extractors list extended to include `action-items-enriched` and `orphan-tasks`.

## Future state: extractors adopting completion_status

Today, status is inferred from file presence + JSON validity. The cleaner long-term path is for each extractor to self-report `completion_status: full | partial | inferred` in its output (wrapped object, not bare array). When that lands, this skill prefers the self-reported status over inference. The taxonomy already supports it — see Status taxonomy table above.
