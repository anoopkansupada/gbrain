---
id: second-brain-to-brain
name: Second-Brain-to-Brain
version: 0.1.0
description: Existing note-taking app data (Notion, Obsidian, Roam, Apple Notes) ingests into ~/brain/notes/ where gbrain treats them as native pages. App-specific adapter; same correspondence-style schema where threads apply.
category: sense
requires: []
secrets:
  - name: NOTION_TOKEN
    description: Notion integration token (only if source = Notion)
    where: https://www.notion.so/my-integrations — create internal integration, share databases with it
health_checks:
  - type: dir_exists
    path: ~/brain/notes
    label: "Output directory ready"
setup_time: 30 min (Obsidian / Apple Notes) – 2 hours (Notion via API)
cost_estimate: "$0–$0.20 (Notion API free; OpenAI embedding new pages)"
---

# Second-Brain-to-Brain: Your Existing Notes Become Native Brain Pages

Most people accumulate years of structured notes in a "second brain" app — Notion, Obsidian, Roam, Apple Notes, Bear, etc. This recipe pulls them into `~/brain/notes/` as proper gbrain pages with frontmatter so they participate in vector search + link extraction.

This recipe is **decision-gated**: the user picks ONE source app per ingest (you can run it multiple times with different sources, each landing into a sub-directory).

## IMPORTANT: Instructions for the Agent

**You are the installer.** **First action: ask the user which app.** The collector code differs per app:

- **Obsidian / Bear / local markdown vault** → easiest. `cp -r` the vault into `~/brain/notes/<app>/` and let `live-sync` pick it up. ~5 min.
- **Apple Notes** → read via AppleScript or the `notes-cli` Homebrew tool. Outputs to `~/brain/notes/apple/`. ~20 min.
- **Notion** → API integration. Requires creating an internal integration + sharing each database with it. ~1.5 hours for first run on a large workspace.
- **Roam** → JSON export → markdown converter. ~30 min.

**Why this matters:** Notes contain *judgment* (meeting prep, project plans, decisions, learnings) that email/calendar/messages don't. They're the user's compiled-thinking layer. Without them, the brain has all the raw signal but none of the user's own synthesis.

## Decision flow

Ask:
> "Which second-brain app are we ingesting? Options: (a) Obsidian or other local-markdown vault, (b) Apple Notes, (c) Notion, (d) Roam, (e) other — name it."

Branch to the matching section below.

## Branch A — Obsidian / Local Markdown Vault

### Architecture
```
~/Obsidian/<vault>/ (or wherever)
  ↓ rsync into ~/brain/notes/obsidian/ (preserving directory structure)
  ↓ live-sync picks up new files
  ↓ gbrain extract links wires [[wikilinks]] (Obsidian's native format!)
```

Obsidian's link format `[[other-note]]` is the same as gbrain's native format — extract-links works out of the box.

### Setup

```bash
mkdir -p ~/brain/notes/obsidian
rsync -av --delete --exclude '.obsidian/' --exclude '.trash/' ~/Path/To/Vault/ ~/brain/notes/obsidian/
```

For each markdown file, add `type: note` frontmatter if missing:
```bash
find ~/brain/notes/obsidian -name '*.md' | while read f; do
  if ! head -3 "$f" | grep -q "^type:"; then
    # Prepend or insert into frontmatter
    python3 -c "
import sys; p = sys.argv[1]; t = open(p).read()
if t.startswith('---'):
    end = t.find('---', 3)+3
    open(p, 'w').write(t[:3] + '\ntype: note' + t[3:end] + t[end:])
else:
    open(p, 'w').write('---\ntype: note\nsource: obsidian\n---\n' + t)
" "$f"
  fi
done
```

Commit + sync:
```bash
cd ~/brain && git add notes/obsidian/ && git commit -m "second-brain: import Obsidian vault"
source ~/.zprofile && cd ~/gbrain && gbrain sync --no-pull --no-embed --repo ~/brain && gbrain embed --stale && gbrain extract links --dir ~/brain
```

### Incremental updates

The Obsidian vault is the source of truth. Re-run `rsync` after you make changes in Obsidian. A `fswatch` daemon can auto-trigger it:
```bash
fswatch -o ~/Path/To/Vault | xargs -n1 -I{} rsync -av --delete ~/Path/To/Vault/ ~/brain/notes/obsidian/
```

(Wrap in a LaunchAgent if you want it always-on.)

## Branch B — Apple Notes

### Architecture
```
Apple Notes (icloud-synced or local)
  ↓ notes-cli export OR AppleScript dump
  ↓ ~/brain/notes/apple/<folder>/<title>.md per note
  ↓ live-sync
```

### Setup

```bash
brew install notes-cli  # if available; else use AppleScript
```

Using `notes-cli`:
```bash
mkdir -p ~/brain/notes/apple
notes-cli list --format json > /tmp/notes.json
python3 - <<'PY'
import json, re, pathlib
notes = json.load(open('/tmp/notes.json'))
out = pathlib.Path.home() / 'brain' / 'notes' / 'apple'
out.mkdir(parents=True, exist_ok=True)
for n in notes:
    slug = re.sub(r'[^a-z0-9-]+', '-', n['title'].lower()).strip('-')[:80] or n['id']
    folder = re.sub(r'[^a-z0-9-]+', '-', (n.get('folder') or 'unfiled').lower()).strip('-')
    (out / folder).mkdir(exist_ok=True)
    fm = f"---\ntype: note\nsource: apple-notes\ntitle: {json.dumps(n['title'])}\ncreated: {n['created']}\nupdated: {n['updated']}\nfolder: {folder}\n---\n# {n['title']}\n\n{n['body']}"
    (out / folder / f"{slug}.md").write_text(fm)
PY
```

If `notes-cli` isn't available, AppleScript version (slower, supports password-protected notes if unlocked):
```applescript
tell application "Notes"
  repeat with n in every note
    -- export to disk
  end repeat
end tell
```

Wrap the AppleScript in `osascript` and have it dump to `/tmp/apple-notes-export/`.

## Branch C — Notion

### Architecture
```
Notion workspace
  ↓ Notion API (with integration token + databases shared)
  ↓ for each page: fetch blocks recursively, render to markdown
  ↓ ~/brain/notes/notion/<workspace>/<db>/<page>.md
  ↓ live-sync
```

### Setup

1. **Create integration:**
   > "Go to https://www.notion.so/my-integrations → New integration → Internal → name it 'gbrain-import' → save → copy the secret token."

2. **Share databases with integration:** for each database you want ingested, open it in Notion → Share → invite the integration by name.

3. **Save token:**
```bash
echo 'export NOTION_TOKEN="secret_..."' >> ~/.zprofile
source ~/.zprofile
```

4. **Install Notion API SDK:**
```bash
mkdir -p ~/notion-collector && cd ~/notion-collector
python3 -m venv venv && source venv/bin/activate
pip install notion-client markdownify
```

5. **Run collector:**
The collector iterates `databases.query()`, fetches each page's `blocks.children.list()` recursively, renders blocks → markdown, writes to disk. Use `notion-client` library + `markdownify` for HTML→MD conversion of rich-text.

For brevity, the full collector pattern is the standard "fetch + paginate + render" — see Notion's API docs or `notion-to-md` npm package as reference. The collector should be ~150 lines of Python.

Each page becomes `~/brain/notes/notion/<db-slug>/<page-slug>.md` with frontmatter:
```yaml
---
type: note
source: notion
notion_page_id: <uuid>
notion_database: <db-name>
title: "<page title>"
created: <iso date>
updated: <iso date>
tags: [<from notion multiselect>]
---
```

6. **Sync:**
```bash
cd ~/brain && git add notes/notion/ && git commit -m "second-brain: import Notion"
source ~/.zprofile && cd ~/gbrain && gbrain sync --no-pull --no-embed --repo ~/brain && gbrain embed --stale && gbrain extract links --dir ~/brain
```

### Incremental updates

Notion API has a `last_edited_time` filter. Store last-sync timestamp in `~/.gbrain/notion-state.json`; next run only pulls pages with `last_edited_time > cursor`.

LaunchAgent at `StartInterval=3600` (hourly) — Notion changes throughout the day for active workspaces.

## Branch D — Roam Research

Roam doesn't have a public API. Export → JSON, then convert:

1. In Roam: top-right menu → Export All → JSON
2. Save to `~/Downloads/Roam-Export.json`
3. Run a converter: `npx roam-to-obsidian /path/to/Roam-Export.json ~/brain/notes/roam/` (or write your own — Roam's block structure is recursive but well-documented)

After conversion, treat as Branch A (local markdown).

## Branch E — Other / Custom

For Bear, Notable, Joplin, etc., look for "Export to Markdown" in the app's menu. Most note apps support this. Result = local markdown folder → Branch A.

For app-specific APIs (Evernote, OneNote), follow the same pattern as Notion (Branch C): create integration, save token, build collector that fetches pages and renders to markdown with frontmatter.

## Critical Implementation Details

### Wikilink preservation

Obsidian, Roam, Notion (with "Reference another page") all have internal links. Convert to gbrain's `[[slug]]` format on import so `gbrain extract links` picks them up.

### Image handling

Most note apps embed images by URL or local path. Two strategies:
1. **Reference only:** keep image links pointing at the source (works for Notion with public URLs; doesn't work offline)
2. **Copy locally:** download to `~/brain/notes/<app>/_attachments/<id>.png`, rewrite links

For first ingest, reference-only is fine. Upgrade if image search becomes important.

### Schema collisions

Some note apps have their own concept of "tags" or "categories" that may collide with gbrain's frontmatter `tags`. Namespace them: store note-app tags as `source_tags:` in frontmatter, gbrain's own tagging system uses `tags:`.

### Size limits

Some Notion / Obsidian notes can be huge (multi-MB). Same tsvector overflow risk as other recipes. Split files > 800KB into chronological or section-based chunks.

## Cost Estimate

| Source | Cost |
|---|---|
| Obsidian / local markdown | $0 |
| Apple Notes (notes-cli) | $0 |
| Notion (API) | $0 (free tier) |
| Roam (JSON export) | $0 |
| OpenAI embedding new pages | ~$0.20 per 10k notes |
| **Total** | **~$0.50 / year** |

## Troubleshooting

**Obsidian sync conflicts:** if both Obsidian and gbrain modify the same file (rare — gbrain doesn't usually rewrite imported notes), use one-way rsync (`~/brain/notes/obsidian/` is read-only from gbrain's side; all edits in Obsidian).

**Notion API rate limit (429):** notion-client retries automatically, but huge workspaces (10k+ pages) may take an hour. Use a smaller `page_size` or run overnight.

**Notion blocks not rendering:** some block types (synced blocks, database views) need special handling. Default to `[block type X — see Notion]` for unsupported types and improve incrementally.

**Apple Notes empty:** `notes-cli` may need accessibility permission. Open System Settings → Privacy → Automation → toggle for the terminal app.
