---
id: brief-to-brain
name: Brief-to-Brain
version: 0.1.0
description: Call briefs, meeting briefs, one-pagers and weekly reviews become first-class brain entities — markdown source in `~/brain/briefs/`, rendered HTML in `web/public/briefs/`, linked from participants + deals + events. Post-call hook closes the loop with the Granola transcript.
category: synthesize
requires: []
secrets: []
health_checks:
  - type: dir_exists
    path: ~/brain/briefs
    label: "Briefs directory ready"
  - type: dir_exists
    path: ~/Projects/active/hash-lemma/web/public/briefs
    label: "Web public/briefs dir ready"
setup_time: 15 min for scaffolding · ~30 sec per brief thereafter
cost_estimate: "$0 (deterministic Python; LLM only for generating the brief content itself)"
---

# Brief-to-Brain: Call Briefs as First-Class Entities

Briefs are the operator's primary working artifact — call prep, meeting prep, weekly reviews, one-pagers for counterparties. Without a canonical home they live as filesystem orphans. This recipe makes them first-class: the markdown lives in `~/brain/briefs/` (canonical, queryable, linked), the rendered HTML lives in `web/public/briefs/` (the daily-driver UI), and both are reciprocally linked to every entity they reference.

## IMPORTANT: Instructions for the Agent

**You are the installer + the runner.** Briefs are generated on-demand (pre-call, weekly review, etc.). This recipe defines the schema, the dual-storage pattern, and the post-call hook — not a scheduled collector.

**Why this matters:** Briefs are where prep work translates into action. If they're not queryable, the value of "what did I prep before the Dewald call" or "show me every brief that mentioned NXT Private Wealth" is lost. Reciprocal linking turns each brief into a navigable node in the relationship graph.

**The dual-storage pattern:**
1. **Markdown source:** `~/brain/briefs/<slug>.md` — gbrain canonical, indexed, searchable
2. **Rendered HTML:** `~/Projects/active/hash-lemma/web/public/briefs/<slug>.html` — daily-driver UI, light mode, mobile-responsive
3. **Reciprocal links:** every participant / deal / firm / event referenced gets a backlink to the brief

## Architecture

```
Brief generation request (operator types a /brief command OR pre-call hook fires)
  ↓
Generator reads:
  ├── ~/Projects/active/hash-lemma/data/index.sqlite (CRM: deals, contacts, companies)
  ├── ~/brain/people/<participant>.md (existing context)
  ├── ~/brain/sources/conferences/<event>.md (if event-anchored)
  ├── ~/brain/daily/calendar/<YYYY>/<YYYY-MM-DD>.md (to confirm context)
  └── any deal-specific brain pages
  ↓
LLM synthesizes the brief content (questions, sections, cheat sheet)
  ↓
Generator emits both:
  ├── ~/brain/briefs/<slug>.md (markdown + frontmatter)
  └── ~/Projects/active/hash-lemma/web/public/briefs/<slug>.html (styled HTML)
  ↓
Append `briefs:` frontmatter to every participant page + relevant deal/company pages
  ↓
git add + commit + gbrain sync + gbrain embed --stale + gbrain extract links
  ↓
[Open in browser for the operator]
  ↓
─── operator runs the call (Granola records) ───
  ↓
Post-call hook (fires after next granola-sync produces transcript):
  ├── Find the granola meeting page for that date + participants
  ├── Update brief frontmatter: status: post-call-debrief, related_granola: [[meetings/<id>]]
  ├── Update granola page: prep_brief: [[briefs/<slug>]]
  └── Optional LLM pass: append "What we actually covered vs planned" section to brief
```

## Schema

### Brief markdown frontmatter (canonical at `~/brain/briefs/<slug>.md`)

```yaml
---
type: brief
category: call-prep | post-call | one-pager | weekly-review | strategy-memo
slug: <participants-slug>-<YYYY-MM-DD>
title: "Human-readable title"
participants:
  - "[[people/<slug>]]"           # everyone in the room, including operator
date: 2026-05-13
duration_min: 45                  # planned duration
context_event: "[[sources/conferences/<slug>]]"  # optional, anchors why now
deals_referenced:
  - name: "Deal Name"
    monday_item_id: "..."
    stage: "..."
    deal_value: 30000
    referred_by: "..."
    closed: 2026-05-06             # if applicable
firms_referenced:
  - "[[companies/<slug>]]"        # every firm name-dropped in the brief
switching_targets_referenced:
  - "[[companies/foundations/<slug>]]"  # if the BD switching motion comes up
artifact_html: "web/public/briefs/<slug>.html"
status: pre-call | in-progress | post-call-debrief
generated_by: claude
generated_at: 2026-05-13T11:24:00Z
sources:
  - "data/index.sqlite#<query>"   # cite every data source used
  - "data/conferences/<slug>.json"
  - "daily/calendar/<YYYY>/<YYYY-MM-DD>.md"
related_granola: null             # filled by post-call hook
tags: [brief, call-prep, <project>, <participant-slugs>]
---
```

### Reciprocal frontmatter on participant pages (`~/brain/people/<slug>.md`)

```yaml
briefs:
  - "[[briefs/<slug>-<YYYY-MM-DD>]]"
```

### Reciprocal frontmatter on deal / firm / event pages

```yaml
briefs_referenced_in:
  - "[[briefs/<slug>-<YYYY-MM-DD>]]"
```

`gbrain extract links` picks up the `[[wikilinks]]` and builds the graph automatically.

## Opinionated Defaults

**Slug rule:** `<lastname-firstname-or-participants>-<YYYY-MM-DD>`. If multi-person, comma-separate lastnames in slug (e.g., `cloete-zimmer-2026-05-13`).

**Dual storage is mandatory.** Don't ship a brief that exists only as HTML (no queryability) or only as markdown (no usable phone UI). Both forms always.

**Light mode.** Per [[feedback_no_dark_mode]] — all briefs render in the warm-paper palette (Instrument Serif + Inter Tight + JetBrains Mono, terracotta accent on `#f7f2e8`).

**Deliverable-only output.** Per [[feedback_deliverable_only_no_scratch]] — the brief contains the final content only. CoS audit, v1-to-v2 reasoning, and scratch work stay in chat, not in the brief.

**Deterministic data only.** Per [[feedback_deterministic_data_only]] — every fact in a brief must trace to a source path cited in the `sources:` frontmatter. Locations, dates, names, numbers come from CRM / calendar / docs, never from inference.

**Cite sources in the footer.** Render the source list at the bottom of the HTML brief so the operator can audit any fact mid-call.

## Prerequisites

1. **gbrain installed and configured** (`gbrain doctor` passes)
2. **Hash-lemma `web/` Next.js project** at `~/Projects/active/hash-lemma/web/` with `public/briefs/` writable
3. **CRM source data** at `~/Projects/active/hash-lemma/data/index.sqlite` (Monday board export)

## Setup Flow

### Step 1: Create the directories

```bash
mkdir -p ~/brain/briefs
ssh jarviss-mac-mini 'mkdir -p ~/brain/briefs'
mkdir -p ~/Projects/active/hash-lemma/web/public/briefs
```

### Step 2: Bootstrap the first brief (this one)

```bash
# Already done 2026-05-13:
# ~/brain/briefs/dewald-cloete-2026-05-13.md
# ~/Projects/active/hash-lemma/web/public/briefs/dewald-cloete-2026-05-13.html
# people/dewald-cloete.md gets `briefs:` frontmatter appended
```

### Step 3: Define the per-brief generator script

`~/Projects/active/hash-lemma/scripts/brief-gen.py` (sketch — implement when next brief is requested):

```python
# Reads:
#   --participant <slug>        # required
#   --date <YYYY-MM-DD>         # required
#   --event <conference-slug>   # optional
#   --duration <min>            # default 45
# Pulls:
#   - All CRM deals where owner LIKE %<participant-name>%
#   - Participant brain page
#   - Conference page (if --event)
#   - Calendar entry confirming operator was at event (if --event)
# Calls LLM:
#   - With template + retrieved facts → markdown brief body
# Writes:
#   - ~/brain/briefs/<slug>.md (with frontmatter)
#   - web/public/briefs/<slug>.html (rendered via shared template)
#   - Appends `briefs:` to participant page frontmatter
# Commits + syncs gbrain
```

### Step 4: Post-call hook

`~/Projects/active/hash-lemma/scripts/brief-link-granola.py` — runs after each `gbrain granola-sync` cycle:

```python
# For each ~/brain/meetings/<YYYY-MM-DD>-*.md file:
#   - Extract participants + date
#   - Find any ~/brain/briefs/*.md with matching participants + date (pre-call status)
#   - If found:
#       - Update brief frontmatter: status: post-call-debrief, related_granola: [[meetings/...]]
#       - Update granola page: prep_brief: [[briefs/...]]
#       - Commit
```

Wire this into `~/.gbrain/integrations/granola-sync/run.sh` so it fires after every granola sync.

### Step 5: Web/ frontend routes

In `~/Projects/active/hash-lemma/web/`:

- `app/briefs/page.tsx` — list all briefs from `~/brain/briefs/*.md` (gbrain MCP fetch or local FS read), sorted by date desc
- `app/briefs/[slug]/page.tsx` — render single brief; serve the `.html` directly via `iframe` OR re-render markdown with the same design tokens
- `app/people/[slug]/page.tsx` — add a **Briefs** section showing all briefs where the person is a participant
- `app/deals/[id]/page.tsx` — add **Mentioned in briefs** section

### Step 6: Heartbeat

```bash
mkdir -p ~/.gbrain/integrations/brief-to-brain
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"brief_generated\",\"status\":\"ok\",\"details\":{\"slug\":\"<slug>\",\"participants\":N,\"deals_referenced\":N}}" \
  >> ~/.gbrain/integrations/brief-to-brain/heartbeat.jsonl
```

## Critical Implementation Details

### Why dual storage and not just HTML

Markdown in `~/brain/briefs/` is the source of truth because:
- Queryable via `gbrain query "Dewald Plume Foundation"` → returns the brief
- Linkable: `[[briefs/dewald-cloete-2026-05-13]]` from any other page
- Extractable: `gbrain extract links` auto-builds the graph
- Diff-able under git
- Re-renderable to any UI (HTML today, mobile app tomorrow)

HTML in `web/public/briefs/` is the daily-driver UI because:
- Loads on phone instantly during a call
- Styled (typography, color, cheat sheets) for fast scanning
- No markdown-rendering overhead

### Reciprocal-link enforcement

The generator MUST update every page it references. Brief lives at `briefs/X`; participant page gets `briefs: [briefs/X]`; deal pages get `briefs_referenced_in: [briefs/X]`. Without reciprocal links, the brief is a leaf node — the graph misses half the value.

### Status lifecycle

- **`pre-call`** — generated, not yet used. Operator reads to prep.
- **`in-progress`** — currently in the meeting (rare; mostly a transitional state)
- **`post-call-debrief`** — Granola transcript has landed; brief is linked and optionally annotated with "what actually got covered vs planned"

Querying for `status: pre-call` AND `date < today` surfaces missed prep that didn't get executed.

### Post-call diff (optional v0.2)

After Granola transcript arrives, an LLM pass can compare:
- Planned questions (from brief)
- Actual conversation (from transcript)
- Output: "Questions we DID ask," "Questions we MISSED," "New topics that emerged"

This becomes feedback into future brief generation — if a question type consistently doesn't get asked, drop it from the template.

### One-pager variant

Same recipe handles outbound one-pagers (e.g., "Hash overview for a prospect"). Difference: `participants:` is the recipient, `generated_for:` field replaces `context_event:`, output may be PDF instead of HTML. Same dual-storage pattern.

## Cost Estimate

| Component | Cost |
|---|---|
| Brief generation (Claude API) | ~$0.05-0.20 per brief depending on context size |
| Storage | $0 (local) |
| OpenAI embedding new brief | ~$0.001 per brief |
| **Total** | **~$0.10 per brief on average** |

## Troubleshooting

**Brief generated but not surfacing in queries:**
- `gbrain sync` + `gbrain embed --stale` after writing. Briefs need embedding to surface in vector search.
- Run `gbrain extract links --dir ~/brain` to wire the reciprocal links.

**HTML render diverges from markdown content:**
- The HTML and markdown share content but the HTML adds design polish. Keep the markdown as source of truth — if they diverge, the markdown wins. Regenerate HTML from markdown.

**Granola post-call hook not linking:**
- Participant slug mismatch is the #1 issue. Granola transcripts use email addresses or display names; brief participants use canonical slugs. Add a normalization step (email → slug, display name → slug) before matching.

**Reciprocal frontmatter conflicts:**
- If a participant page is being edited by multiple processes (CRM importer + brief generator), use append-only semantics on list keys (don't replace, only add new items). gbrain extract-links handles dedup downstream.

## What this enables (the long game)

Once briefs are first-class:

- **Pre-call:** "What did I prep for the Dewald call?"
- **During-call:** Open the HTML on phone, mark which questions got asked
- **Post-call:** Brief auto-links to transcript; you query "what came up about Plume RO across all calls" and get the answer
- **Quarterly:** "Show me every brief that mentioned NXT Private Wealth" → trace the relationship arc
- **For the operator:** every conversation has a structured prep record, not a scratch text file
