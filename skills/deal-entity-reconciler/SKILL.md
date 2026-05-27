---
name: deal-entity-reconciler
version: 1.0.0
description: |
  Reconcile orphan/unmatched gbrain deal pages to their real company + people.
  An LLM proposes matches from three evidence sources — gbrain-internal,
  LinkedIn current_company (bidirectional name<->company), and Gmail
  thread/domain — a human approves anything below high-confidence at a choice
  gate, then a deterministic executor creates the company page (with aka),
  wires bidirectional deal<->company and person<->company links, merges
  duplicate person pages, and verifies via get_backlinks. Use when deal pages
  exist in the graph but point at no company (the 2026-05 backfill left ~240).
triggers:
  - "reconcile deals"
  - "match deals to companies"
  - "link unmatched deals"
  - "resolve deal entities"
  - "which deals have no company"
  - "reconcile this deal"
tools:
  - exec
  - read
  - write
mutating: true
writes_pages: true
writes_to:
  - companies
  - people
---

# deal-entity-reconciler

Turn a footprint-less deal stub into a connected entity: `deals/nil-foundation`
("$40k, won") → `companies/nillion-foundation` (aka "Nil Foundation") ←
`people/andrew-masanto` (Co-Founder, via LinkedIn) ← the Nillion Gmail/Telegram
threads. Chains after the Phase-2 deal-link backfill and feeds
[enrich/SKILL.md](../enrich/SKILL.md) for the new company pages it creates.

## The rule

**Never create a company page or link a deal on a string match alone.** A
new-company creation or a person link requires *external corroboration*
(LinkedIn `current_company`, a Gmail domain, or a resolved contact) **and** a
human approval for anything that is not an exact match to an *existing*
company page. Abbreviations ("Nil" → "Nillion") and founder identity
("Andrew Masanto runs Nillion") are knowledge the matcher does not have —
surface the evidence and let the human confirm. The cost of a wrong auto-match
is a polluted graph that is expensive to unwind; under-linking is cheap to
re-run.

## Contract

This skill guarantees:
- Every proposal carries an **evidence list + confidence** (high / medium / low); nothing is written without it.
- **Auto-apply is restricted** to exact matches against an *existing* company page (`autoApply: true`). New-company creation and all medium/low candidates pass through the [ask-user](../ask-user/SKILL.md) choice gate.
- Writes honor the house rules: canonical slug (`companies/<slug>` ≥1 real token, no catchalls), never-delete-without-merge (duplicate persons), `put_page` full-markdown reconstruction (no body clobber), and **`add_link` for edges** (remote `put_page` skips auto-link — wikilinks alone do NOT create edges).
- Every applied mapping is **verified** with `get_backlinks` before the deal is marked reconciled.

## Phases

### Phase 0 — Scope the unmatched set
Pull `list_pages type=deal` (paginate). A deal is "unmatched" if it has no
outgoing `deal_with` edge (`get_links`) / no resolvable company. Pull
`list_pages type=company` once as the match corpus.

### Phase 1 — Deterministic internal match
`bun scripts/deal-entity-reconciler.mjs <input.json>`. The script's
`matchDealToCompany` resolves frontmatter `company`, exact slug, normalized
title, and stem-prefix (`3box-labs` ⊂ `3box-labsceramic`). A hit = the deal's
company already exists → high-confidence, auto-appliable.

### Phase 2 — Evidence enrichment (for the misses)
For deals with no internal match, gather corroboration before proposing a NEW company:
1. **LinkedIn bidirectional.** Build the reverse index from `source: linkedin-export` people (`linkedinReverseIndex`): `current_company` → people.
   - **company → name:** the deal entity name matches a person's `current_company` → that person is a `key_person` candidate (this is how Andrew Masanto attaches to Nillion).
   - **name → company:** a deal contact/referrer resolves to a person whose `current_company` ≈ the deal entity → corroborates the entity is real and supplies the *canonical* spelling (person says "Nillion", deal says "Nil").
2. **Gmail cross-reference.** `mcp__claude_ai_Gmail__search_threads` for the entity name. From hits capture: sender/participant **domains** (`@nillion.com` → `domainMatch`, strong) and whether the name appears (`nameMatch`, weak). `resolve_slugs` participant names/emails back to existing `people/*`.
3. Pass all evidence to the script's `scoreCandidate`, which assigns weight + confidence and proposes a canonical name + slug + `aka`.

### Phase 3 — Choice gate (human)
Render the proposal table (below). Auto-apply only `autoApply: true` rows.
For every other row use [ask-user](../ask-user/SKILL.md): approve / edit
(fix slug or canonical name) / reject. **Diff must be shown before approval.**

### Phase 4 — Execute (deterministic, per approved proposal)
1. **Company page:** if `isNewCompany`, `put_page companies/<slug>` with `name`, `aka: [<dealTitle>, ...]`, `subtype`, `key_people`, `canonical_in: gbrain`, `created_from: <deal>`. If it exists, only add missing `aka`/`key_people` (reconstruct full markdown — never clobber the body).
2. **Links (`add_link`, both directions):** `deal → company` (`deal_with`) + `company → deal` (`has_deal`); for each key person `person → company` (`works_at`) + `company → person` (`key_person`); `owner → deal` (`owns_deal`) if not already present.
3. **Duplicate persons:** if LinkedIn/Gmail surfaced a second slug for the same human (e.g. `andrewmasanto` vs `andrew-masanto`), merge per [enrich](../enrich/SKILL.md) dedup: read both → merge unique frontmatter/body into the canonical (≥2-token slug) → repoint edges (`add_link`+`remove_link`) → soft-delete the variant.
4. **Verify:** `get_backlinks <company>` shows the deal + people; re-fetch the company `content_hash` changed.

### Phase 5 — Report + log
Emit the applied / queued / skipped table. Note residuals (no evidence found →
leave unlinked, do not invent a page).

## Output Format

Proposal table (Phase 3) and post-apply report (Phase 5):

```
| deal | → company (new?) | canonical (aka) | key people | conf | evidence | action |
|------|------------------|-----------------|-----------|------|----------|--------|
| deals/nil-foundation | companies/nillion-foundation (NEW) | Nillion Foundation (aka Nil Foundation) | andrew-masanto | high | linkedin-company->person; gmail-domain @nillion.com | APPLIED ✓ get_backlinks shows deal+person |
| deals/abt | — | ABT | — | low | none | SKIPPED (no evidence, ambiguous acronym) |
```

## Anti-Patterns

- ❌ Creating `companies/<x>` from a deal title with zero corroborating evidence (string-match hallucination).
- ❌ Auto-applying a NEW company without the human gate (only existing-page exact matches auto-apply).
- ❌ Writing `[[wikilinks]]` into a body and assuming edges exist — remote `put_page` skips auto-link; you MUST `add_link`.
- ❌ Deleting a duplicate person before merging its unique fields into the canonical.
- ❌ Inventing a canonical name; only expand an abbreviation when LinkedIn/Gmail evidence supplies the full spelling.
- ❌ Creating first-name-only / acronym catchall slugs (respect the no-slug-catchalls rule).

## Phase 3 quality gate (cross-modal eval — informational)

```bash
gbrain eval cross-modal \
  --task "Reconcile unmatched deal pages to real company+people without polluting the graph" \
  --output skills/deal-entity-reconciler/SKILL.md
```
3 frontier models / 3 providers score 5 dimensions; pass = every dim mean ≥7 AND no model <5. Receipt under `~/.gbrain/.gbrain/eval-receipts/`.
