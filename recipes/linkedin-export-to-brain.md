---
id: linkedin-export-to-brain
name: LinkedIn-Export-to-Brain
version: 0.1.0
description: LinkedIn account data export (connections, messages, invitations, posts) becomes searchable brain pages. Manual export route — no API auth, no scraping risk.
category: sense
requires: []
secrets: []
health_checks:
  - type: file_exists
    path: ~/Downloads/Basic_LinkedInDataExport_*.zip
    label: "LinkedIn export ZIP present"
  - type: dir_exists
    path: ~/brain/correspondence/linkedin
    label: "Output directory ready"
setup_time: 30 min + 24h wait for LinkedIn to email export
cost_estimate: "$0"
---

# LinkedIn-Export-to-Brain: Your Network Becomes Searchable Memory

LinkedIn aggressively blocks scraping. The supported, terms-compliant route is the **official data export** (`linkedin.com/mypreferences/d/download-my-data`). This recipe turns the resulting ZIP into searchable brain pages with **massive match-back** to your existing person pages: every connection gets current title + company + LinkedIn URL onto their existing `people/<slug>.md`.

This unlocks queries like *"who are the lawyers in Cayman firms I need to talk to"* and *"which of my connections invests in AI"* — both currently underserved by vector search alone because the structured signal isn't in the brain yet.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Follow these steps precisely.

**Why this matters:** LinkedIn is your second-largest people graph after Google Contacts. Without it, person pages have stale or missing titles/companies, and queries that need role-based filtering ("partners at Walkers") fail to rank well. The export is one-time human effort (~5 min in browser) + 24h wait + ~30 min agent work. After that, every future query benefits.

**The output is three streams:**
1. `~/brain/correspondence/linkedin/<thread-id>.md` — DM threads as `correspondence` pages
2. **Inline enrichment** of existing `~/brain/people/<slug>.md` — adds `linkedin:`, `current_title:`, `current_company:`, `connected_on:` frontmatter
3. `~/brain/media/linkedin-posts/<post-id>.md` — your own posts as `media` pages (optional, recipe v0.2)

**Do not skip steps. Verify after each step.**

## Architecture

```
LinkedIn data export (manual trigger)
  ↓ user clicks "Request archive" at linkedin.com/mypreferences/d/download-my-data
  ↓ LinkedIn emails a ZIP within 24h (Basic_LinkedInDataExport_*.zip)
  ↓ user downloads to ~/Downloads/
  ↓
Collector (deterministic):
  ├── unzip + parse CSVs (Connections.csv, messages.csv, Invitations.csv, Profile.csv)
  ├── normalize to canonical schema
  ├── for each connection: match to existing person page via (email | name + company) and write enrichment frontmatter
  ├── for each thread: write ~/brain/correspondence/linkedin/<thread-id>.md
  └── write heartbeat
  ↓
Agent enrichment (LLM judgment):
  ├── detect role tags (e.g., "lawyer", "investor", "partner at <firm>") from titles + about-text
  ├── add `tags: [lawyer, cayman]` or `tags: [investor, ai]` where confident
  └── flag ambiguities for human review
```

## Opinionated Defaults

**Match-back priority order** (highest-confidence first):
1. Email match (LinkedIn's email field → person page's `email:` frontmatter) — strong
2. Name + current-company match — medium
3. Name alone — weak (skip; flag for human)

**Thread filtering** — only ingest threads with **≥ 5 messages** OR with the latest message in the last 12 months. Skip one-line cold-outreach threads (low signal, high noise).

**Privacy** — do not ingest InMail content that the sender marked confidential (LinkedIn's export marks these; respect the flag).

**Schema additions** (frontmatter keys added to existing person pages):
- `linkedin: <url>` — full profile URL
- `current_title: "..."` — most recent title from export
- `current_company: "..."` — most recent company
- `connected_on: YYYY-MM-DD` — first-degree connection date
- `linkedin_industry: "..."` — if present in export

## Prerequisites

1. **GBrain installed and configured** (`gbrain doctor` passes)
2. **Node.js 18+** (collector is `.mjs`)
3. **LinkedIn account** with sufficient connection history (export is most valuable at 500+ connections)

## Setup Flow

### Step 1: Request the LinkedIn export (HUMAN ACTION REQUIRED)

Tell the user:
> "Go to https://linkedin.com/mypreferences/d/download-my-data, select **'The works'** (Connections + Messages + Invitations + Profile + Posts), confirm. LinkedIn will email you a download link within 24 hours. When the email arrives, download the ZIP to `~/Downloads/`. Don't unzip it — the collector handles that."

**STOP until the ZIP arrives.**

Validate when present:
```bash
ls -la ~/Downloads/Basic_LinkedInDataExport_*.zip && echo PASS || echo "FAIL — export not yet downloaded"
```

### Step 2: Use the existing collector

**A 408-line Python collector already exists at `~/Projects/active/hash-lemma/importers/linkedin_to_gbrain.py` on the operator's laptop.** Tested against a synthetic 4-connection + 3-message sample on 2026-05-13 — produces well-formed person pages with embedded DM conversations, gbrain-compliant frontmatter (linkedin_url, email, company, position, connected_on, source, confidence, tags).

```bash
# Verify the existing tool
ls -la ~/Projects/active/hash-lemma/importers/linkedin_to_gbrain.py
python3 ~/Projects/active/hash-lemma/importers/linkedin_to_gbrain.py --help
```

The tool handles: Connections.csv, Contacts.csv, messages.csv, Invitations.csv, Recommendations_Given.csv, Recommendations_Received.csv. Missing optional files are tolerated if stubbed with header-only CSV.

**Run when ZIP arrives:**
```bash
ZIP=$(ls -t ~/Downloads/Basic_LinkedInDataExport_*.zip | head -1)
WORK=/tmp/linkedin-export-$(date +%Y%m%d)
unzip -q "$ZIP" -d "$WORK"
# Stub any missing optional CSVs to avoid FileNotFoundError
for f in Contacts.csv Recommendations_Given.csv Recommendations_Received.csv; do
  [ -f "$WORK/$f" ] || echo "First Name,Last Name,URL" > "$WORK/$f"
done

OUT=/tmp/linkedin-out
python3 ~/Projects/active/hash-lemma/importers/linkedin_to_gbrain.py \
  --export-dir "$WORK" --out-dir "$OUT" --self-name "Anoop Kansupada"

# Merge into brain (existing tool writes to <out>/people/; gbrain import handles merge)
rsync -av "$OUT/people/" jarviss-mac-mini:~/brain/people/
ssh jarviss-mac-mini 'cd ~/brain && git add people/ && git -c user.name=jarvis -c user.email=jarvis@local commit -m "linkedin: import N connections" && source ~/.zprofile && cd ~/gbrain && gbrain sync --no-pull --no-embed --repo ~/brain && gbrain embed --stale && gbrain extract links --dir ~/brain'

# Heartbeat
ssh jarviss-mac-mini "mkdir -p ~/.gbrain/integrations/linkedin-export && echo '{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"sync_complete\",\"status\":\"ok\"}' >> ~/.gbrain/integrations/linkedin-export/heartbeat.jsonl"
```

If you want a fresh collector following the manual-export flow with the correspondence schema specifically (instead of inline DMs on person pages), the v0.2 sketch below was the original plan — use only if the existing tool isn't sufficient:

1. **Find latest export ZIP** in `~/Downloads/`
2. **Unzip to a temp dir** (don't pollute Downloads)
3. **Parse CSVs:**
   - `Connections.csv` — First Name, Last Name, URL, Email Address, Company, Position, Connected On
   - `messages.csv` — CONVERSATION ID, FROM, TO, DATE, SUBJECT, CONTENT
   - `Invitations.csv` — From, To, Sent At, Message, Direction
   - `Profile.csv` — user's own info (skip — already in operator profile)
4. **For each connection:**
   - Try email match against existing `~/brain/people/*.md` frontmatter `email:` field
   - Fall back to fuzzy name match (Levenshtein < 3) within same company
   - If match found: append `linkedin: <url>`, `current_title:`, `current_company:`, `connected_on:` to person page frontmatter (in-place merge, don't clobber existing keys)
   - If no match: create stub `~/brain/people/<first-last-slug>.md` with the connection data and `tags: [linkedin-only]` (flagged for human review)
5. **For each conversation:**
   - Group messages by CONVERSATION ID
   - Apply filter (≥ 5 messages OR last message within 12 months)
   - Write `~/brain/correspondence/linkedin/<conversation-id>.md` with frontmatter: `type: correspondence`, `channel: linkedin`, `participants: [<slugs>]`, `first_message:`, `last_message:`, `message_count:`
6. **Write heartbeat** to `~/.gbrain/integrations/linkedin-export/heartbeat.jsonl`

### Step 3: First import (backfill)

```bash
cd ~/linkedin-collector
node linkedin-collector.mjs import --zip ~/Downloads/Basic_LinkedInDataExport_*.zip 2>&1 | tee ~/.gbrain/integrations/linkedin-export/sync.log
```

Verify:
```bash
ls ~/brain/correspondence/linkedin/ | wc -l  # should be > 0
grep -l 'linkedin: ' ~/brain/people/*.md | wc -l  # connections matched to existing person pages
cat ~/.gbrain/integrations/linkedin-export/heartbeat.jsonl | tail -1  # most recent heartbeat
```

### Step 4: Sync to gbrain DB

```bash
source ~/.zprofile
cd ~/gbrain
gbrain sync --no-pull --no-embed --repo ~/brain
gbrain embed --stale
gbrain extract links --dir ~/brain  # picks up new correspondence ↔ person links
```

### Step 5: Agent enrichment pass (your job)

For high-signal connections that didn't get auto-tagged:
1. Open `~/brain/people/<slug>.md` for any connection where `current_title` matches `/lawyer|attorney|counsel|partner|associate/i`
2. If they work at a known Cayman firm (Carey Olsen, Ogier, Appleby, Conyers, Walkers, Maples, Mourant, Harneys), add `tags: [lawyer, cayman]`
3. For investors: any title matching `/partner|principal|investor|md|managing director/i` at a VC/PE firm, add `tags: [investor]`; if their bio/title mentions AI/ML/foundation models, add `[investor, ai]`
4. For correspondence pages, link to the relevant deal/company page if a single deal dominates the thread

### Step 6: Set up incremental re-imports

LinkedIn exports are point-in-time, not streaming. Re-request the export quarterly (or when planning to use LinkedIn-derived data heavily). Each re-import should be idempotent: existing person pages get updated frontmatter; only NEW connections create new pages; deduplicate threads by CONVERSATION ID.

A LaunchAgent isn't useful here (no streaming source). Instead, document a calendar reminder for quarterly re-export.

### Step 7: Log setup completion

```bash
mkdir -p ~/.gbrain/integrations/linkedin-export
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.1.0","status":"ok","details":{"connections_imported":"N","threads_imported":"M","person_pages_enriched":"K"}}' >> ~/.gbrain/integrations/linkedin-export/heartbeat.jsonl
```

## Critical Implementation Details

### Match-back precision

The match-back step is where this recipe earns its keep. A false match (wrong person gets wrong title) is worse than no match. Order of precedence:
1. **Email exact match** — never wrong
2. **Name + current_company exact match** — rarely wrong (two people with same name at same company is rare)
3. **Name + Levenshtein-3 on company** — flag for human if name is common (top 100 surnames + top 100 first names)
4. **Name-only** — **do not auto-merge.** Create stub with `[linkedin-only]` tag for manual review.

### Correspondence schema (new gbrain type)

```yaml
---
type: correspondence
channel: linkedin
participants: [people/jane-doe, people/anoop-kansupada]
thread_id: <linkedin-conversation-id>
first_message: 2024-01-15
last_message: 2025-11-08
message_count: 23
---
# Thread: Jane Doe ↔ Anoop (LinkedIn)
<turn-by-turn body>
```

This same schema serves iMessage and Telegram. Defining it here once lets later recipes reuse it.

### What NOT to ingest

- **Marketing/cold outreach threads** (1-3 messages, recruiter pitch) — low signal
- **InMails marked confidential** — privacy
- **"Liked your post" notifications** — not in CSV but if scraped, filter
- **Auto-translated messages** — translation artifacts confuse LLM enrichment; prefer original

### Idempotency

Re-running the collector against a newer export should:
1. UPDATE existing person pages' `current_title` / `current_company` if changed (preserving `connected_on`)
2. ADD new connections as new person stubs
3. SKIP existing correspondence pages (match by `thread_id`)
4. APPEND new messages to existing threads only if the source CSV shows growth (compare `message_count`)

## Cost Estimate

| Component | Cost |
|---|---|
| LinkedIn data export | $0 (free, 1-2x/year per account) |
| Collector compute | $0 (local) |
| OpenAI embedding for new pages | ~$0.01 per 1000 new pages |
| **Total** | **~$0.05/year for typical 5k connections** |

## Troubleshooting

**ZIP not found:**
- LinkedIn's email goes to your "junk" folder sometimes. Search `noreply-jobs@linkedin.com` or `dataaccess@linkedin.com`.
- Export can take 24-48h, not instant.

**Match-back rate low (< 30%):**
- Most likely cause: person pages don't have `email:` frontmatter. Email-to-brain should populate this — check email collector heartbeat first.
- Secondary: name spelling differs between Google Contacts (formal) and LinkedIn (preferred name). Levenshtein-2 + same company is a safe expansion.

**Threads page too large (tsvector overflow):**
- Some long-running DMs exceed 1MB on a single page. Split by year if a thread grows past 800KB. See `~/.claude/skills/gbrain-install/references/troubleshooting.md` failure mode #2.

**Duplicate person pages from name-only stubs:**
- Run `gbrain dedupe people/` after the collector. (See `feedback_never_delete_always_verify.md` — always merge unique fields before deleting duplicates.)
