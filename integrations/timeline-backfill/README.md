# timeline-backfill (PC3, one-shot)

Component **C1** of `tasks/gbrain-weekly-meta-cognitive-cron`. **Not** a recurring
cron — run once, by hand.

## What it does

Lifts `timeline_coverage` (entity-scoped in gbrain v0.40.x:
`person|company pages with ≥1 timeline_entry ÷ person|company pages`) by mining
dated events out of `correspondence/*` and `meetings/*` page bodies and writing
them onto the **person/company entities those pages link to** — the
post-call-processor idiom (timeline entries live on entity pages, not on the
correspondence/meeting page itself).

Writing entries directly onto correspondence/meeting pages would move *nothing*,
because those are not entity pages. That spec assumption predates the v0.40.x
Goodhart-correction (`project_gbrain_brain_score_entity_scoped`).

## Extraction (regex-only)

- **correspondence** — LinkedIn/Gmail message heads: `**YYYY-MM-DD[ HH:MM:SS UTC]** ←/→`.
  One entry per distinct date; summary = direction + first message line (Gmail
  date-only threads fall back to the thread title). Capped at 25 dates/page.
- **meetings** — `**Date:** YYYY-MM-DD` header + inline ISO dates + natural-language
  `Month DD[, YYYY]` (year inherited from the meeting date when absent). Capped at 25.
- No Haiku / Ollama (one-shot; Ollama is reserved for crons). Genuinely
  ambiguous date strings (month-day with no year context) are **counted and
  reported, not written**.

## Guardrails / idempotency

- Never writes to junk-hub / self entities (`SLUG_DENYLIST`: `people/linkedin`,
  `people/anoop-kansupada`, …) — the 2026-05-25 link-mine hub-pollution lesson.
- `UNIQUE(page_id, date, summary)` + `ON CONFLICT DO NOTHING`, AND skips any
  `(entity, date)` already carrying a `source LIKE 'timeline-backfill%'` row.
  **Re-running is a strict no-op.**
- Cursor-paged batches + 250 ms sleep to protect the 15-client session pool
  (`project_gbrain_session_pool_invariant`). Single `postgres.js` client, `max: 2`.

## Run

```bash
~/.gbrain/integrations/timeline-backfill/run.sh --dry-run   # report only
~/.gbrain/integrations/timeline-backfill/run.sh             # write
```

Every written row is stamped `source = "timeline-backfill <YYYY-MM-DD>"`, so it
is auditable and bulk-reversible.
