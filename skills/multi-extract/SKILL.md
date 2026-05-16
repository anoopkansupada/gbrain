---
name: multi-extract
version: 1.0.0
description: |
  Orchestrator for the 10-extractor post-call pipeline. Fans out to all 10 narrow
  extractor skills in parallel, validates each JSON output, then runs one merger
  pass that writes the canonical brief debrief, follow-up email draft, task pages,
  and incremental gbrain page updates. Enforces idempotency via manual_override flag.
triggers:
  - "multi-extract"
  - "run extractors"
  - post-call-processor (internal)
tools:
  - get_page
  - create_page
  - update_page
  - search
  - run_skill
inputs:
  - meeting_slug
  - brief_slug (optional — inferred from meeting_slug if omitted)
  - operator_slug (default: people/anoop-kansupada)
outputs:
  - "/Users/jarvis/brain/extractions/<meeting_slug>/*.json"
  - "briefs/<brief_slug> — ## Post-call debrief section appended"
  - "emails/<meeting_slug>-followup — draft follow-up email"
  - "tasks/* — one task page per operator-owned action item"
  - "people/* — incremental updates for each named person"
  - "companies/* — incremental updates for each named firm"
  - "/Users/jarvis/brain/extractions/<meeting_slug>/coverage-report.json"
mutating: true
---

# Multi-Extract Orchestrator

Replaces the single-pass extraction in `post-call-processor`. Fans out 10 narrow skills against the same transcript, validates each output, merges into gbrain.

## Phase 1 — Fan-out (parallel)

Spawn 10 parallel calls, one per extractor skill. All receive the same inputs:

| Skill | Output file |
|---|---|
| `extract-deals` | `deals.json` |
| `extract-action-items` | `action-items.json` |
| `extract-competitor-mentions` | `competitor-mentions.json` |
| `extract-referrer-network` | `referrer-network.json` |
| `extract-pricing-signals` | `pricing-signals.json` |
| `extract-personal-context` | `personal-context.json` |
| `extract-corrections` | `corrections.json` |
| `extract-insider-knowledge` | `insider-knowledge.json` |
| `extract-intent-signals` | `intent-signals.json` |
| `extract-relationship-graph` | `relationship-graph.json` |

Each writes its typed JSON to `~/brain/extractions/<meeting_slug>/<output-file>`.


## Phase 1.5 — Enforce coverage (retry once)

After fan-out completes, invoke the `enforce-coverage` skill to verify every expected extractor output is present and well-formed. For any `missing` or `failed` extractor, retry exactly once. If after retry more than one extractor is still failed/missing/inferred, write a manual-review task at `tasks/<meeting_slug>-manual-review.md` and HALT the orchestrator (do not run merger on incomplete data). Otherwise write `coverage-report.json` with the final per-extractor status and continue.

This is wired in the shell wrapper at `~/.gbrain/integrations/multi-extract/run.sh` between fan-out and merger. See [[enforce-coverage]] SKILL.md for the contract.

## Phase 1.6 — Enrich action items

After coverage passes, if `action-items.json` exists, invoke the `enrich-tasks` skill. It reads the action items + the weekly/monthly goal pages (NCT shape) and emits `action-items-enriched.json` with three new fields per task: `parent_goal` (anchored at a commitment ID like `#wc3`), `due` (mandatory after enrichment), and canonicalized `owner`. Tasks that can't be enriched go to `orphan-tasks.json` with a `reason` field.

Non-fatal: if `enrich-tasks` fails, the merger falls back to the raw `action-items.json`. See [[enrich-tasks]] SKILL.md.

The merger pass (Phase 4c, task pages) MUST prefer `action-items-enriched.json` over `action-items.json` when present, and copy the enrichment fields into task frontmatter.

## Phase 2 — Validation

After all 10 complete, validate each JSON file:

- Parse as valid JSON. If unparseable → flag `EXTRACTION_FAILED_PARSE`.
- Check required fields are present per schema (deal_name, owner, competitor, etc). If missing required fields → flag `EXTRACTION_FAILED_SCHEMA`.
- Check for empty arrays on calls ≥ 30 minutes — unexpected empties get flag `EXTRACTION_EMPTY_UNEXPECTED`.

Write `~/brain/extractions/<meeting_slug>/coverage-report.json`:

```json
{
  "meeting_slug": "string",
  "run_at": "ISO8601",
  "extractors": {
    "<skill-name>": {
      "status": "ok | failed_parse | failed_schema | empty | empty_unexpected",
      "item_count": "number",
      "flags": ["string"]
    }
  },
  "overall": "ok | partial | failed"
}
```

Surface coverage report as a warning in the brief's `## Post-call debrief` section. Do NOT silently drop failed extractors.

## Phase 3 — Idempotency check

Before writing any gbrain page, check for `manual_override: true` in the target page's frontmatter.

- If `manual_override: true` → preserve the human version. Write auto output to `<page-slug>.auto.md` as a sibling file. Do NOT overwrite.
- If no `manual_override` flag → proceed with update.

This prevents the bug where auto-extraction overwrites a manually curated brief.

## Phase 4 — Merger pass

Single LLM call. Reads all 10 validated JSON files + the pre-call brief. Produces:

### 4a. Brief debrief section
Append `## Post-call debrief` to `briefs/<brief_slug>`. Structure:

```markdown
## Post-call debrief

**Deals updated:** <count> | **Corrections:** <count> | **Action items:** <count>

### Corrections needed
<from corrections.json — one bullet per correction, with downstream_fix>

### Deal updates
<from deals.json — only entries where stage_correction_needed or referrer_correction_needed = true>

### Action items (operator)
<from action-items.json — only owner = operator>

### Key intel
<from insider-knowledge.json — do_not_share_externally items appear as REDACTED in body; full in frontmatter only>

### Coverage
<from coverage-report.json — list any empty_unexpected or failed extractors>
```

### 4b. Follow-up email draft
Create `emails/<meeting_slug>-followup` in gbrain. Populate from `action-items.json` bilateral pairs only. Do NOT include insider-knowledge content. Do NOT hand-write — follow the operator voice: direct, reference the specific deal/fact from the transcript, one CTA per email.

### 4c. Task pages
For every action item where `owner_role == "operator"`, create or update `tasks/<task_slug_hint>` with:
- Title from `action_item.title`
- Status: open
- Linked brief: `briefs/<brief_slug>`
- Due: from `due_inferred` or `due_stated`

### 4d. People + companies incremental updates
- From `extract-personal-context.json` → append to `people/<subject-slug>` under `## Personal context`
- From `extract-referrer-network.json` → append to `companies/<firm-slug>` under `## Referrer intel`
- From `extract-relationship-graph.json` → create stubs for new people/companies using `gbrain_stub_slug`; update existing pages with new `relationship_via` entry
- From `extract-intent-signals.json` → append to `people/<counterparty-slug>` under `## ICP fit`

## Phase 5 — Confirmation

After all writes complete, output:

```
multi-extract complete: <meeting_slug>
extractors: <ok_count>/10 ok | <failed_count> failed | <empty_unexpected_count> empty-unexpected
brief: briefs/<brief_slug> updated (## Post-call debrief appended)
email draft: emails/<meeting_slug>-followup
tasks created: <count>
pages updated: <count>
coverage report: ~/brain/extractions/<meeting_slug>/coverage-report.json
```

If `overall == "partial"` or `"failed"`, end with:
```
⚠ <count> extractor(s) need attention — see coverage report
```

## Anti-patterns

- Running merger before all 10 extractors complete — wait for all Phase 1 outputs
- Silently dropping failed extractors — always surface in coverage report
- Overwriting pages with `manual_override: true` — write to `.auto.md` sibling
- Hand-writing the follow-up email — populate from `action-items.json` bilateral pairs only
- Writing insider-knowledge content to the brief body or email — confidential frontmatter only
