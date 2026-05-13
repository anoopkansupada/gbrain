---
name: call-brief-generator
description: Generate a pre-call brief deterministically from CRM dealbook + brain context + conference history. Outputs canonical markdown to ~/brain/briefs/ AND rendered HTML to web/public/briefs/. Locked schema, locked design, no inferred facts.
triggers:
  - "brief me on"
  - "prep call with"
  - "call brief for"
  - "/brief"
tools:
  - search
  - query
  - get_page
  - list_pages
  - put_page
  - get_recent_salience
mutating: true
---

# Call Brief Generator

Produce a pre-call brief that's queryable in gbrain AND usable on a phone during the call.

> **Filing rule:** All brief output follows the [[brief-to-brain]] recipe schema. See `~/gbrain/recipes/brief-to-brain.md` for full frontmatter + dual-storage pattern. This skill executes the recipe.

## Contract

- **Every fact pulled deterministically.** Counterparty's deals come from `~/Projects/active/hash-lemma/data/index.sqlite#deals where owner LIKE %<name>%`. Conference context comes from `~/brain/sources/hash-lemma/conferences/<slug>.md` OR `~/Projects/active/hash-lemma/data/conferences/<slug>.json`. Calendar attendance comes from `~/brain/daily/calendar/<YYYY>/<YYYY-MM-DD>.md`. **Zero inferred locations, dates, names, numbers.** If a source doesn't have it, the field stays blank.
- **Dual storage mandatory.** Markdown source at `~/brain/briefs/<slug>.md` (canonical, queryable). Rendered HTML at `~/Projects/active/hash-lemma/web/public/briefs/<slug>.html` (daily-driver UI). Both forms every time.
- **Light mode.** HTML uses the brief design tokens: Instrument Serif display + Inter Tight body + JetBrains Mono mono, terracotta accent on `#f7f2e8` warm-paper background. See [[no-dark-mode]] memory. Tokens in `references/design-tokens.md`.
- **Deliverable only, no scratch.** The brief contains the final content only. No audit, no v1-vs-v2, no critique blocks shown to the operator. See [[deliverable-only-no-scratch]].
- **Reciprocal links.** Every entity referenced (people, deals, firms, events) gets a backlink to the brief in its `briefs_referenced_in:` frontmatter list. `gbrain extract links` runs after write.
- **Source-cite in footer.** Every brief HTML footer lists the source paths used. Operator can audit any claim mid-call.
- **Slug rule:** `<lastname>-<firstname>-<YYYY-MM-DD>` for single counterparties; `<last1>-<last2>-<YYYY-MM-DD>` for multi-person. NO frontmatter `slug:` field (gbrain derives from path; including `slug:` triggers SLUG_MISMATCH sync failure).

## Inputs

Required:
- `participant_slug` — canonical slug, e.g., `dewald-cloete`
- `date` — call date, YYYY-MM-DD

Optional:
- `context_event_slug` — if call is anchored to a recent conference, e.g., `consensus-miami-2026`. Skill verifies operator's calendar to confirm they were there.
- `duration_min` — default 45
- `category` — `call-prep` (default) | `post-call` | `one-pager` | `weekly-review` | `strategy-memo`

## Phases

### Phase 1 — Pull deterministic facts

1. **CRM dealbook** — query `~/Projects/active/hash-lemma/data/index.sqlite`:
   ```sql
   SELECT name, stage, entity_type, deal_value, referred_by, delivery_channel,
          deal_length, follow_up_date, won_lost_date, comments
   FROM deals
   WHERE owner LIKE '%<participant-name>%'
   ORDER BY won_lost_date DESC, stage;
   ```
2. **CRM contacts owned** — query the same DB:
   ```sql
   SELECT name, title, companies, importance, last_contact, contact_type, location
   FROM contacts
   WHERE hash_person LIKE '%<participant-name>%'
   ORDER BY importance DESC, last_contact DESC;
   ```
3. **CRM firms owned** — query companies where `hash_person` includes participant.
4. **Participant brain page** — read `~/brain/people/<participant_slug>.md` for any existing context (role, location, known clients).
5. **Conference context (if `context_event_slug`)** — read `~/brain/sources/hash-lemma/conferences/<slug>.md` for location/dates. Read `~/brain/daily/calendar/<year>/<date>.md` to confirm operator was there. **If calendar entry missing → don't reference the event in the brief.**
6. **Open threads on participant** — search `~/brain/people/<participant_slug>.md` for `### Open threads` section or `?` markers; surface as questions in the brief.

### Phase 2 — Synthesize the brief

Apply the 5-block template (see `references/template-pre-call.md`):

- **Block 01 — Opener** (2 min): natural callback referencing verified shared context. Drop new-hire framing if participants have prior history.
- **Block 02 — Context debrief** (3-4 min): if `context_event_slug` provided, debrief that event first — free intel surface.
- **Block 03 — Dealbook** (12-15 min): anchor to 3-5 specific deals (mix of wins for reference stories, losses for pattern interrogation, pricing-sent for unsticking). NEVER walk through every deal — that's a death spiral.
- **Block 04 — Referrer firms / network** (5-7 min): firms where the participant is `hash_person` for the firm relationship. Probe live vs cold.
- **Block 05 — Switching motion + the ask** (5-8 min): operator's specific BD plays + one concrete next step (NOT a "one-pager redline" — a real deliverable + deadline).

Defaults:
- **Lead with wins, not losses.** Reference stories > postmortems unless category=`post-call`.
- **Distinguish CRM `owner` ambiguity.** A deal where `owner=<participant>` can mean (a) they sit as director-of-record, or (b) they source/close but someone else sits. Frontmatter and body must clarify which.
- **Cap the deal walkthrough at 4 deals.** More than that exhausts the time slot.
- **Closer is a real next step**, not a cute redline framing.

### Phase 3 — Write outputs

1. Write markdown to `~/brain/briefs/<slug>.md` per [[brief-to-brain]] recipe schema. **No `slug:` field in frontmatter.**
2. Render HTML to `~/Projects/active/hash-lemma/web/public/briefs/<slug>.html` using `references/html-template.html`.
3. Append `briefs:` list entry to `~/brain/people/<participant_slug>.md` frontmatter.
4. For each deal/firm/event referenced, append `briefs_referenced_in:` list entry.
5. `git add` + commit the brain repo.
6. Run `gbrain sync --no-pull --no-embed --repo ~/brain && gbrain embed --stale && gbrain extract links --dir ~/brain`.
7. Write heartbeat to `~/.gbrain/integrations/brief-to-brain/heartbeat.jsonl`:
   ```json
   {"ts":"<ISO>","event":"brief_generated","status":"ok","details":{"slug":"<slug>","participants":N,"deals_referenced":N,"firms_referenced":N,"category":"call-prep"}}
   ```

### Phase 4 — Verify

- Open the HTML in browser (`open <path>`).
- Run `gbrain query "<participant first name> brief"` and confirm the new brief is rank 1.
- Confirm participant page now has `briefs:` entry.

## Output (deterministic)

Exactly two files per invocation:

```
~/brain/briefs/<participant-slug>-<YYYY-MM-DD>.md
~/Projects/active/hash-lemma/web/public/briefs/<participant-slug>-<YYYY-MM-DD>.html
```

Plus reciprocal-link edits on N entity pages, where N is `len(participants) + len(deals_referenced) + len(firms_referenced) + (1 if context_event else 0)`.

## What this skill does NOT do

- Does NOT call any external scraper (LinkedIn / web). All inputs are local: gbrain + CRM SQLite + calendar.
- Does NOT send the brief anywhere. The HTML is opened locally; the operator decides what to do with it.
- Does NOT generate slides or PDFs. Output is markdown + HTML only.
- Does NOT modify CRM source data. Read-only against `~/Projects/active/hash-lemma/data/`.

## Failure modes + recovery

| Symptom | Cause | Fix |
|---|---|---|
| Sync fails with `SLUG_MISMATCH` | Frontmatter has `slug:` field | Remove the `slug:` line — gbrain derives slug from path |
| HTML has dark backgrounds | Wrong design tokens loaded | See [[no-dark-mode]] memory; load `references/design-tokens.md` light palette |
| Brief mentions a location/date that's wrong | Inferred fact (forbidden) | Per [[deterministic-data-only]] memory, fall back to blank field; never guess |
| Participant has 50+ contacts in CRM | Walked through every contact, brief is unusable | Cap at 4 deals + top 5 contacts by importance; rest stays in cheat-sheet table |
| No prior history with participant | Default `Block 01` opener is "new hire" framing | Test: if `~/brain/people/<slug>.md` has fewer than 3 timeline entries, use new-hire opener; otherwise reference shared context |

## References

- `references/template-pre-call.md` — 5-block prompt template
- `references/template-post-call.md` — post-call category template (different blocks)
- `references/design-tokens.md` — light-mode color, typography, spacing tokens
- `references/html-template.html` — Jinja-style HTML template with design tokens
- `~/gbrain/recipes/brief-to-brain.md` — schema authority

## See also

- [[post-call-processor]] — runs AFTER Granola transcript lands; closes the loop
- [[brain-ops]] — general brain query patterns
- [[meeting-ingestion]] — Granola pipeline producing the transcripts this skill's post-call counterpart consumes
