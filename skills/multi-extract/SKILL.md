---
name: multi-extract
version: 0.2.0
description: |
  After post-call-processor identifies a brief+transcript pair, fan out 10
  parallel extractor skills (deals, action-items, competitor-mentions,
  referrer-network, pricing-signals, personal-context, corrections,
  insider-knowledge, intent-signals, relationship-graph) followed by a
  merger pass that validates outputs, enforces pre-write guardrails, and
  writes the post-call debrief, follow-up email draft, task pages, and
  entity updates.
triggers:
  - "process call"
  - "post-call merger"
  - "debrief multi-extract"
tools:
  - exec
  - get_page
  - put_page
  - list_pages
mutating: true
writes_pages: true
writes_to:
  - briefs/         # post-call debrief section appended
  - meetings/       # prep_brief link + post-call links
  - tasks/          # one per action item
  - emails/         # one follow-up draft (skipped for internal calls)
  - people/         # service_provider + intel updates
  - companies/      # service_provider + deal-status updates
  - extractions/    # per-meeting JSON intermediates
  - reports/        # coverage report per merger run
---

# Multi-Extract — parallel extractors + merger

The actual work-horse behind `skills/post-call-processor/`. Each extractor
is a focused LLM call producing a JSON file at
`~/brain/extractions/<meeting-slug>/<extractor>.json`. The merger validates,
deduplicates, and writes brain pages.

## Contract

- **10 parallel extractors.** Failures of individual extractors don't gate
  the merger — coverage report flags missing outputs for follow-up.
- **Idempotent.** Pages with `manual_override: true` get written to a
  `.auto.md` sibling, never overwriting operator edits.
- **Locked output schema per extractor.** Outputs that don't validate land
  in a manual-review task instead of being silently written.

## Pre-write guardrails (merger phase)

The merger MUST enforce all four before writing any page:

### Guardrail 1 — Slug existence check

Before writing any task, email, or entity page that references another slug
via `parent_goal:`, `subject:`, `recipient:`, `firm:`, or `individuals:`,
the merger looks up the referenced slug via `gbrain get`. If missing, the
merger MUST either:

- Create a typed stub for the referenced slug with a TODO body, OR
- Refuse the write and emit a manual-review task with the orphan reference.

**Why:** 2026-05-14 — the May 3 Karel-dinner merger wrote two tasks
referencing `goals/standing/platform-improvements` that did not exist as a
page. Linker downstream surfaced the orphan but only after the operator ran
it. Slug-existence check at write time eliminates the class.

### Guardrail 2 — Task frontmatter contract

Every task page rejected at write time unless it has:

- `owner:` — a `[[people/<slug>]]` link.
- `deadline:` — an ISO date. If the transcript doesn't yield one, default
  to `meeting_date + 7d` with `deadline_inferred: true` flag.
- `parent_goal:` — a `goals/<horizon>/<slug>` link. Use the
  date-window fallback to the active weekly goal if the LLM doesn't pick one.

**Why:** 2026-05-14 — the May 13 and May 14 merger runs produced 12 tasks
without `deadline:`, forcing the operator to chase each one. The contract
flips that: missing field → inferred field + flag, not silently absent.

### Guardrail 3 — Internal-call detection

If every participant in the meeting's `attendees` frontmatter resolves to
the operator's own organization (Hash Directors / Lemma slugs for the
default operator), the merger skips the email-draft step entirely.

**Why:** 2026-05-14 — the May 3 dinner with Karel produced an empty
follow-up email draft that the operator had to cancel manually. Internal
calls don't need external follow-up emails; the brief debrief is the
artifact.

### Guardrail 4 — Auto-chain task-goal-linker

After all extractor outputs are merged and pages are written, the merger
MUST run `task-goal-linker --force` as its final phase. This closes the
loop: new tasks land already linked to a parent goal, and the coverage
report captures the linker's audit summary.

**Why:** 2026-05-14 — the May 3 + May 4 merger runs created 5 new tasks
without `parent_goal:`. The operator had to run the linker separately to
clean up. Auto-chain ensures no human follow-up is required for the link.

## Phases

### Phase 1 — Fan out

```bash
for skill in $EXTRACTORS; do
  claude -p "Run the $skill skill. meeting_slug: $M. brief_slug: $B." &
done
wait
```

### Phase 2 — Merger

```bash
claude -p "Run the multi-extract skill merger phase. meeting_slug: $M.
brief_slug: $B. Enforce all 4 pre-write guardrails (slug existence, task
frontmatter contract, internal-call detection, auto-chain linker). Write
coverage-report.json last."
```

### Phase 3 — Coverage report

Write `~/brain/extractions/<meeting-slug>/coverage-report.json` listing:

- Each extractor's status (`ok`, `failed_parse`, `empty_unexpected`, `file_missing`).
- Each guardrail's enforcement count (slugs validated, stubs created,
  tasks defaulted to inferred-deadline, internal-calls skipped, linker
  pass).
- Confidential flags surfaced.

## Output guarantees

- Brief debrief section appended (status flips to `post-call-debrief`).
- Tasks all linked + all have due/owner/parent_goal.
- Email draft only for external calls.
- Coverage report is the single audit source for the merger run.
- No orphan slug references anywhere in the output.

## When to extend

- New extractor → add to the `$EXTRACTORS` list in
  `~/.gbrain/integrations/multi-extract/run.sh` and write its SKILL.md.
- New pre-write guardrail → document here, add enforcement to the merger
  LLM prompt, add a unit test under `test/multi-extract.test.ts`.
