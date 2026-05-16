---
id: hash-advisors-to-brain
name: Hash-Advisors-to-Brain
version: 0.1.0
description: Existing Hash Lemma strategy docs (in sources/hash-lemma/docs/) get parsed for advisor + counsel + partner mentions, creating structured advisor pages under people/advisors/. Pure agent enrichment — no external source.
category: sense
requires: []
secrets: []
health_checks:
  - type: dir_exists
    path: ~/brain/sources/hash-lemma/docs
    label: "Hash docs source present"
  - type: dir_exists
    path: ~/brain/people/advisors
    label: "Output directory ready"
setup_time: 30 min
cost_estimate: "$0.10 (one-time OpenAI embed of new pages)"
---

# Hash-Advisors-to-Brain: Internal Docs → Structured Advisor Graph

The strategy docs in `~/brain/sources/hash-lemma/docs/` (COMPETITORS, COMPANY-CONTEXT, ONBOARDING, LABS-MAP, RWA-MAP, SALES-STRATEGY, etc.) mention dozens of advisors, board members, counsel, and partners — but they live as free-text mentions, not structured records. This recipe extracts them into proper `people/advisors/<slug>.md` pages and `companies/<firm>.md` pages with advisor-relationship frontmatter.

This unlocks queries like *"who are my Cayman lawyer advisors"* — currently weak because the data is buried in prose, not tagged.

## IMPORTANT: Instructions for the Agent

**You are the installer AND the collector.** Unlike most recipes, this one has no external API or daemon. It is a **one-shot agent enrichment pass** over existing brain content, re-runnable when the source docs update.

**Why this matters:** Hash docs are the single richest source of structured advisor relationships you already own. Petri's onboarding PDF, the competitor maps, the partnership memos — all reference real people with roles and firms. Pulling these into `people/advisors/` and `companies/<firm>/` makes the graph queryable.

**The output is two streams:**
1. `~/brain/people/advisors/<slug>.md` — advisor profile with role, firm, expertise area, mention sources
2. **Inline updates** to `~/brain/companies/<firm>.md` (or new file) — adds `advisors:` and `referral_partners:` frontmatter

## Architecture

```
~/brain/sources/hash-lemma/docs/*.md
  ↓ agent reads each doc with a structured extraction prompt
  ↓ produces a JSON list of {name, firm, role, area, mention_sources, confidence}
  ↓
Validator (deterministic):
  ├── deduplicate by (firm, name) tuple
  ├── slugify names
  ├── match-back to existing people/*.md pages
  └── write/update advisor pages + firm pages
  ↓
Heartbeat
```

The "collector" is the LLM extraction call; the "validator" is a deterministic post-processor. This is the inverse of most recipes (which use code for collection, LLM for enrichment).

## Opinionated Defaults

**Confidence threshold** — only auto-create pages for `confidence >= 0.8` mentions (named individual with explicit role + firm). Below that, flag for human review.

**Advisor categories** (mapped from doc context):
- `advisor_area: legal` — counsel, partners at law firms (referrer or competitor)
- `advisor_area: financial` — directors at company-manager firms
- `advisor_area: technical` — token launch / governance / smart contract
- `advisor_area: strategic` — board members, ecosystem advisors
- `advisor_area: relationship` — referral partners (Carey Olsen, Ogier, Appleby flow)

**Schema additions** (frontmatter on `people/advisors/<slug>.md`):
- `type: person`
- `category: advisor`
- `advisor_area: <category>` (see above)
- `firm: [[companies/<slug>]]` — link to firm page
- `relationship_to_hash: <referrer | competitor | board | external_counsel | ...>`
- `mentioned_in: [<list of source doc paths>]`
- `tags: [hash-advisors, cayman, <area>, <firm-slug>]`

**Firm pages** get:
- `referral_partners: [<advisor slugs>]` — for Leeward-style "their referrers"
- `competitors_via: [<advisor slugs>]` — for Marfire-style "who left from where"
- `advisor_to_hash: [<advisor slugs>]` — direct advisory relationships

## Prerequisites

1. `~/brain/sources/hash-lemma/docs/` populated (already true on the user's Mini)
2. `gbrain` MCP available OR direct `gbrain query` access on the host
3. Anthropic API key in `~/.zprofile` (extraction quality is materially better than smaller models)

## Setup Flow

### Step 1: Inventory the source docs

```bash
ls ~/brain/sources/hash-lemma/docs/*.md
wc -l ~/brain/sources/hash-lemma/docs/*.md | sort -n | tail
```

Expected files (per current state): COMPANY-CONTEXT, COMPETITORS, ONBOARDING, LABS-MAP, RWA-MAP, SALES-STRATEGY, SYSTEM-ROADMAP, FRONTEND-DESIGN, 30-60-90-PLAN, BD-OUTREACH (if present).

### Step 2: Define the extraction schema

```yaml
# extraction_schema.yaml — what we want from each doc
extract:
  - field: name
    type: string
    description: Full name of the person
  - field: firm
    type: string
    description: Company / law firm / VC firm they work at
  - field: role
    type: string
    description: Title or role (Partner, Director, Counsel, Founder, etc.)
  - field: area
    enum: [legal, financial, technical, strategic, relationship]
  - field: relationship_to_hash
    enum: [referrer, competitor, board, external_counsel, vendor, peer]
  - field: confidence
    type: number
    range: [0.0, 1.0]
  - field: mention_quote
    type: string
    description: Verbatim quote that established this fact
```

### Step 3: Run the extraction pass

The cleanest path is via the gbrain MCP from a Claude Code session, calling `mcp__gbrain__query` or just `gbrain get` for each doc, then having Claude apply the extraction schema. As a script:

```bash
# pseudo-collector — could be a Claude Agent SDK script
for doc in ~/brain/sources/hash-lemma/docs/*.md; do
  claude -p "Extract all advisor/counsel/partner mentions from this document per the extraction_schema. Output JSONL." \
    --file "$doc" \
    --output-format json \
    >> /tmp/hash-advisors-raw.jsonl
done
```

Or — and this is the **Garry-preferred path** — fold the extraction into the autopilot dream cycle's `synthesize` phase by writing a synthesis prompt that targets these docs specifically. The synth output writes pages directly.

### Step 4: Deduplicate and validate

```bash
# Group by (firm, name) tuple, merge mentions
python3 ~/hash-advisors-collector/dedupe.py /tmp/hash-advisors-raw.jsonl > /tmp/hash-advisors-clean.jsonl
```

Manual review: scan for `confidence < 0.8` rows and decide. Drop obvious noise (people mentioned in passing without a clear advisory role).

### Step 5: Write advisor pages

For each clean record, generate `~/brain/people/advisors/<slug>.md` (or update existing `people/<slug>.md` if a page already exists — append `category: advisor` and the new frontmatter keys).

```bash
python3 ~/hash-advisors-collector/write-pages.py /tmp/hash-advisors-clean.jsonl
```

### Step 6: Update firm pages

For each firm referenced, ensure `~/brain/companies/<firm-slug>.md` exists with the new `referral_partners` / `advisor_to_hash` frontmatter populated. Create stub firm pages if missing (e.g., `companies/carey-olsen.md`, `companies/ogier.md`, `companies/appleby.md`, `companies/conyers.md`).

### Step 7: Sync + verify

```bash
cd ~/brain && git add people/advisors/ companies/ && git commit -m "hash-advisors: ingest advisor/counsel/partner graph from sources/hash-lemma/docs/"
source ~/.zprofile
cd ~/gbrain
gbrain sync --no-pull --no-embed --repo ~/brain
gbrain embed --stale
gbrain extract links --dir ~/brain

# Verify
gbrain query "Cayman lawyers I should talk to" --limit 8
# Should now return structured advisor pages, not just prose mentions
```

### Step 8: Log heartbeat

```bash
mkdir -p ~/.gbrain/integrations/hash-advisors
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.1.0","status":"ok","details":{"advisor_pages":"N","firm_pages":"M"}}' >> ~/.gbrain/integrations/hash-advisors/heartbeat.jsonl
```

### Step 9: Re-run trigger

This recipe is **event-driven**, not scheduled. Re-run when:
- A new doc lands in `sources/hash-lemma/docs/` (live-sync notices new files)
- The user adds someone to a doc in passing and wants them surfaced
- Quarterly review of the advisor graph

A simple LaunchAgent that watches `sources/hash-lemma/docs/` for mtime changes can auto-trigger the extraction — optional v0.2 feature.

## Critical Implementation Details

### "Mentioned in passing" filter

Many docs name people in context like "told us about Carey Olsen" — these are TWO mentions (the speaker + the firm) but only one of them is an advisor. The extraction prompt must distinguish:

- ✅ "Glenn Kennedy is Registered Professional Director under Cayman Islands Directors Registration Act" — direct advisor mention
- ❌ "told us about Carey Olsen" — Carey Olsen is the firm, not the person; the person is the speaker (unnamed)

Confidence calibration: require role + firm + name in same sentence or adjacent context to score > 0.8.

### Conflict with existing person pages

If `people/petri-basson.md` already exists (it does), the recipe should NOT create `people/advisors/petri-basson.md`. Instead, **update the existing page** with the advisor frontmatter. Slug collisions = update, not create.

### Quote preservation

Each advisor mention preserves the **verbatim quote** in `mention_quote:` frontmatter (truncated to 200 chars). This is the audit trail — every claim about an advisor traces back to a specific document line.

### Firm-level enrichment

The richest Hash docs (COMPETITORS.md especially) have whole sections on individual firms (Leeward, Marfire, Horizons) with multiple personnel. The extraction must group these — one extraction pass per firm-section yields cleaner results than one pass per doc.

## Re-runnable Pattern

This recipe is **idempotent** by design:
1. Re-extract from source docs (always fresh data)
2. Compare against existing `people/advisors/*.md`
3. Update changed fields; skip unchanged
4. Add new advisors only if not already present (by name + firm match)
5. Never delete — the source docs may have removed a mention, but the person may still be an advisor

## Cost Estimate

| Component | Cost |
|---|---|
| LLM extraction (Claude / GPT-4) over ~10 docs | $0.10–$0.30 one-time |
| Re-runs (quarterly) | $0.10–$0.30 per run |
| **Total annual** | **~$1** |

## Troubleshooting

**No advisor pages created:**
- Check the extraction confidence threshold; may be too high. Lower to 0.7 for first pass, re-review manually.

**Same advisor listed under multiple firms:**
- Career path (e.g., Barbara Padega: Lerners → Conyers → Appleby → Leeward). The page should record CURRENT firm in `firm:` and prior firms in `mention_quote:` or a `career_path:` list field.

**False positives from quoted clients:**
- COMPETITORS.md quotes Cayman Compass articles which reference real people in context. Don't auto-extract from quoted articles unless the source byline is a Hash advisor (rare). Add a filter: skip mentions inside block quotes (`> ...`).
