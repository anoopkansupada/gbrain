---
name: person-identity-reconciler
version: 1.0.0
description: |
  Resolve and de-orphan person pages by matching identity ACROSS sources, then linking to
  company. Join keys (v1.4 schema, strongest first): telegram_user_id > email/secondary_emails
  (corporate) > linkedin URL > telegram @handle > phone_numbers. Dedups duplicate person
  pages into the canonical >=2-token name slug, links person<->company (current_company /
  Organizations line / email-domain fallback) and person<->telegram-thread, and migrates
  legacy telegram-export rows to v1.4 (confidence numeric, telegram_display_name -> aliases,
  resolution_evidence audit). Auto-applies only exact join-key dedups + exact-slug company
  links; everything else is human-gated. Use to de-orphan the ~8k orphan-people bucket
  (LinkedIn / Google-Contacts / Monday / Telegram imports) at scale.
triggers:
  - "reconcile people"
  - "dedup people"
  - "match people across sources"
  - "resolve orphan people"
  - "de-orphan contacts"
  - "link people to companies"
  - "merge duplicate person pages"
tools:
  - exec
  - read
  - write
mutating: true
writes_pages: true
writes_to:
  - people
  - companies
---

# person-identity-reconciler

Sibling of [deal-entity-reconciler](../deal-entity-reconciler/SKILL.md): same evidence -> resolve -> link -> human-gate architecture, but the entity is a **person** and the join is **cross-source identity**, not a deal title. Feeds [enrich](../enrich/SKILL.md) for any company pages it touches. Built against schema **v1.5** ([[references/gbrain-frontmatter-schema]] + [[references/gbrain-schema-migrations/2026-05-27-people-telegram-identity-provenance]] + [[references/gbrain-schema-migrations/2026-05-27-legal-counsel-representation]]).

## The rule

**Match on identity keys, not names.** Two pages are the same human only if they share a *strong* key — `telegram_user_id`, a *corporate* email, a `linkedin` handle, or a phone. Same display name alone is NEVER a merge (the probe caught `matthew-tierney`@Autodesk ≠ `matthewmtierney`@Databricks). Webmail addresses (gmail/icloud/…) are weak — never a merge key and never an email-domain→company key. Company links require an employer *string* (`current_company` or an Organizations `@ Company` line); email-domain is a **fallback only**. New-company creation and any name-only/weak match go through the human gate. The Telegram display name is data — it belongs in `aliases[]`, not in a slug or a bespoke field. **v1.5 guard:** a person working AT a law firm is a `works_at` edge — NEVER infer a `legal_counsel_for` edge or populate `representations[]`/`outside_counsel[]` from employer data; legal representation is matter-specific and only comes from an explicit counsel-of-record source, never from `current_company`.

## Contract

- Every proposal carries `resolution_evidence` + numeric `confidence` (0..1); nothing is written without it.
- **Auto-apply** is limited to: dedup-merges keyed on a strong identity key, exact-slug company links, and person↔telegram-thread links. New companies + weak/name-only matches are human-gated.
- Writes honor v1.4: identity fields (`telegram_user_id`, `email`, `secondary_emails[]`, `linkedin`, `telegram`, `phone_numbers[]`), `aliases[]` for display names, **numeric `confidence`**, `company_source`, `resolution_evidence`; `name:` is optional (display name = page title).
- Merges follow never-delete-without-merge: read both → merge unique fields/body into the canonical (≥2-token slug) → repoint edges (`add_link`+`remove_link`) → soft-delete the variant (record under `prior_slugs[]`).
- Edges use `add_link` (remote `put_page` skips auto-link).

## Phases

### Phase 0 — Scope
Pull orphan person pages (`get_backlinks` == none) in batches. Pull `companies/*` slugs once as the resolve corpus, and a `telegram_user_id -> [telegram-thread slug]` map (from `telegram-*` thread pages' participants).

### Phase 1 — Gather identity (per person)
`get_page`; collect from frontmatter + body: `telegram_user_id`, `telegram`, `email` + `secondary_emails` + body "Email" lines, `linkedin`, `phone_numbers`, `current_company`/`current_title`, body "Organizations" lines (`<title> @ <Company>`), existing `aliases`. Pass the structured record to the script.

### Phase 2 — Cluster + resolve (script)
`bun scripts/person-identity-reconciler.mjs <input.json>`. The script: union-find clusters people sharing a STRONG key; picks the canonical slug; resolves company (current_company → Organizations → email-domain fallback) with `company_source`+`confidence`; attaches telegram threads by `telegram_user_id`; flags v1.4 migrations; marks `autoApply` vs gated and `deadweight` (no signal).

### Phase 3 — Choice gate (human)
Auto-apply `autoApply:true`. Everything else (name-only company guesses, would-create-new-company, ambiguous clusters) → [ask-user](../ask-user/SKILL.md), diff shown first.

### Phase 4 — Execute (per approved proposal)
1. **Merge** each `mergeFrom` into `canonical`: union unique identity fields + body, append variant slug to `prior_slugs[]`, migrate display name to `aliases[]`, repoint inbound edges, soft-delete variant.
2. **Company link:** `add_link` person→company (`works_at`) + company→person (`key_person`); stamp the person's `company`/`current_company`, `company_source`, numeric `confidence`.
3. **Telegram threads:** `add_link` person→thread (`participated_in`) for each.
4. **v1.4 hygiene:** rewrite legacy rows — `confidence:"confirmed"`→`1.0`, `telegram_display_name`→`aliases[]`.
5. Write `resolution_evidence` on the canonical page. **Verify** with `get_backlinks`.

### Phase 5 — Report
applied / gated / deadweight counts. `deadweight` (no email, no employer, no telegram, junk/org-as-person) → leave OR flag org-as-person for reclassify to `companies/*`; never invent a company.

## Output Format

```
| person (canonical) | merges | company (source) | tg threads | conf | evidence | action |
|---|---|---|---|---|---|---|
| people/jane-doe | people/janedoe-tg | companies/acme (exact-slug) | 2 | 0.95 | dedup 1 via tg id; company via exact-slug; 2 telegram thread(s) | APPLIED ✓ |
```

## Anti-Patterns
- ❌ Merging two pages because the display names match (require a strong key).
- ❌ Using a webmail domain as a merge key or company key.
- ❌ Creating a company from a person's employer string without the human gate.
- ❌ Leaving `confidence:"confirmed"` (string) on a row you touched — v1.4 is numeric.
- ❌ Putting the Telegram display name in the slug or `telegram_display_name` — it goes in `aliases[]`.
- ❌ Linking an org-as-person row (e.g. `*-ltd`, `*-foundation` imported as a person) — reclassify to `companies/*` instead.

## Phase 3 quality gate (cross-modal eval — informational)
```bash
gbrain eval cross-modal --task "De-orphan + dedup person pages across sources without polluting the graph" --output skills/person-identity-reconciler/SKILL.md
```
