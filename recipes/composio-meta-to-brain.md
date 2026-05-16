---
id: composio-meta-to-brain
name: Composio-Meta-to-Brain
version: 0.1.0
description: Meta-recipe — use Composio's unified MCP layer to ingest any of ~hundreds of services (Drive, Slack, GitHub, Figma, Linear, etc.) into brain pages. Each Composio tool slug + filter rule yields a sub-source.
category: sense
requires: [credential-gateway]
secrets:
  - name: COMPOSIO_API_KEY
    description: Composio API key
    where: https://app.composio.dev — sign up → settings → API keys
health_checks:
  - type: env_exists
    name: COMPOSIO_API_KEY
    label: "Composio API key set"
  - type: dir_exists
    path: ~/brain/sources
    label: "Output directory ready"
setup_time: 30 min initial + 15 min per added service
cost_estimate: "$0 (free tier) – $20/mo (Composio Pro for heavy use)"
---

# Composio-Meta-to-Brain: One Integration Layer for N Sources

Writing a recipe + collector per service (Slack, Drive, GitHub, Figma, Linear, Stripe, ...) is N integration projects. Composio gives one auth surface and one API for ~hundreds of services. This is a **meta-recipe**: install Composio once, then declare each service-to-brain mapping as a small config entry, not a new collector.

This recipe is **highest-leverage** in the ingestion ladder — it unlocks the long tail of "I have data in <service>, can it be in the brain?" without per-service code.

## IMPORTANT: Instructions for the Agent

**You are the installer.** This recipe sets up the Composio plumbing. Adding individual services is a config-only operation after that.

**Why this matters:** Garry-style ingestion is "code for data, LLMs for judgment." Composio is the code-for-auth layer that lets you skip the OAuth dance per service. Each new source becomes a 10-line config entry, not a new collector dir.

**Output structure:**
```
~/brain/sources/<service>/<area>/<id>.md
~/.gbrain/integrations/composio/<service>/heartbeat.jsonl
```

## Architecture

```
~/.gbrain/composio-config.yml (sources you want ingested)
  ↓ each entry: { service: "google-drive", filter: "...", brain_dir: "..." }
  ↓
Collector (one .mjs / .py per config entry, generated from a template):
  ├── call composio.tools.execute("<service>.<action>", filter)
  ├── for each result: render to markdown w/ frontmatter
  ├── write to ~/brain/sources/<service>/<area>/<id>.md
  └── heartbeat
  ↓
gbrain sync picks up new files
```

## Opinionated Defaults

**Per-service config schema** (entries in `~/.gbrain/composio-config.yml`):
```yaml
- service: google-drive
  action: search_files
  filter:
    mime_types: [application/vnd.google-apps.document]
    modified_after: "{{ last_sync }}"
  brain_dir: sources/drive/docs
  page_template: docs
  schedule: 0 */6 * * *  # every 6h
  
- service: slack
  action: list_messages
  filter:
    channels: [strategy, bd-funnel]
  brain_dir: sources/slack
  page_template: thread
  schedule: 0 */1 * * *  # hourly
  
- service: github
  action: list_issues
  filter:
    repo: hash-team/hash-private
    state: all
  brain_dir: sources/github/hash-private
  page_template: issue
```

**Page templates** — three built-ins:
- `docs` — single page per document (Drive, Notion, Confluence, etc.)
- `thread` — correspondence schema (Slack messages, Discord, Telegram-via-Composio)
- `issue` — ticket/issue schema (GitHub, Linear, Jira)

Custom templates = Jinja2-style templates that emit markdown.

**Cursor / state:** each service tracks `last_sync` per filter signature in `~/.gbrain/composio-state.json`.

## Prerequisites

1. **Composio account** (free tier gives 5k calls/mo)
2. **Composio API key**
3. **Each target service connected** via Composio UI (one-time OAuth per service)
4. **Node.js or Python** for the runner

## Setup Flow

### Step 1: Composio account + API key

Tell the user:
> "Sign up at https://app.composio.dev. Go to Settings → API Keys → create new. Copy the key."

Save:
```bash
echo 'export COMPOSIO_API_KEY="..."' >> ~/.zprofile
```

### Step 2: Connect services in Composio UI

For each service the user wants:
> "In Composio dashboard → Connected Apps → click `+ Add` → pick service (e.g., Google Drive) → OAuth flow → authorize. Repeat for Slack, GitHub, Notion, etc."

This is one-time per service.

### Step 3: Install Composio SDK

```bash
mkdir -p ~/composio-collector && cd ~/composio-collector
npm init -y && npm install composio-core
# or: python3 -m venv venv && source venv/bin/activate && pip install composio-core
```

### Step 4: Write config

Edit `~/.gbrain/composio-config.yml` with one entry per (service, filter) pair. See Opinionated Defaults above.

### Step 5: Build the runner

`~/composio-collector/run.mjs`:
```javascript
import { Composio } from "composio-core";
import fs from "fs"; import path from "path"; import yaml from "yaml";
import os from "os";

const HOME = os.homedir();
const config = yaml.parse(fs.readFileSync(`${HOME}/.gbrain/composio-config.yml`, "utf8"));
const state = JSON.parse(fs.readFileSync(`${HOME}/.gbrain/composio-state.json`, "utf8").catch?.() ?? "{}");

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });

for (const entry of config) {
    const key = `${entry.service}/${JSON.stringify(entry.filter)}`;
    const since = state[key] || null;
    const params = { ...entry.filter };
    if (since) params.modified_after ??= since;
    
    const res = await composio.tools.execute({
        action: `${entry.service.toUpperCase().replace("-", "_")}_${entry.action.toUpperCase()}`,
        params,
    });
    
    const outDir = path.join(HOME, "brain", entry.brain_dir);
    fs.mkdirSync(outDir, { recursive: true });
    
    let written = 0;
    for (const item of res.data ?? []) {
        const slug = slugify(item.title || item.name || item.id);
        const fm = renderFrontmatter(entry.page_template, item);
        const body = renderBody(entry.page_template, item);
        fs.writeFileSync(path.join(outDir, `${slug}.md`), fm + body);
        written++;
    }
    
    state[key] = new Date().toISOString();
    
    // Heartbeat per service
    const hbPath = path.join(HOME, ".gbrain", "integrations", "composio", entry.service, "heartbeat.jsonl");
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.appendFileSync(hbPath, JSON.stringify({
        ts: new Date().toISOString(),
        event: "sync_complete",
        status: "ok",
        details: { service: entry.service, items_written: written },
    }) + "\n");
}

fs.writeFileSync(`${HOME}/.gbrain/composio-state.json`, JSON.stringify(state, null, 2));

function slugify(s) { return (s || "untitled").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 80); }
function renderFrontmatter(tpl, item) { /* tpl-specific YAML */ }
function renderBody(tpl, item) { /* tpl-specific markdown */ }
```

### Step 6: First run

```bash
source ~/.zprofile
node ~/composio-collector/run.mjs
ls ~/brain/sources/
```

### Step 7: Sync + verify

```bash
cd ~/brain && git add sources/ && git commit -m "composio: initial pull"
source ~/.zprofile && cd ~/gbrain
gbrain sync --no-pull --no-embed --repo ~/brain && gbrain embed --stale && gbrain extract links --dir ~/brain
tail -5 ~/.gbrain/integrations/composio/*/heartbeat.jsonl
```

### Step 8: LaunchAgent

`~/composio-collector/run.sh` (sources `~/.zprofile`, runs run.mjs). Plist with `StartInterval=1800` (default; per-entry schedules in YAML override this in the runner's logic — entries skip themselves if their cron hasn't elapsed).

## Critical Implementation Details

### Composio action naming

Composio's action names are uppercased with the service prefix: `GOOGLEDRIVE_SEARCH_FILES`, `SLACK_LIST_MESSAGES`, `GITHUB_LIST_ISSUES`. The config uses lowercase + dashes; the runner converts.

### Service-specific filters

Each Composio service exposes different filter params. Reference: https://docs.composio.dev/tools/<service>. The config schema is intentionally permissive — pass-through to Composio's params object.

### Avoiding overlap with dedicated recipes

If a service already has a dedicated recipe (Gmail → email-to-brain, Calendar → calendar-to-brain), **don't use the Composio path** for it. The dedicated recipe has more careful filtering + heartbeat semantics. Composio-meta covers the long tail.

### Filtering vs ingest size

Some services (Slack with active workspaces, GitHub with huge repos) can return enormous result sets. Always use filter params (date range, channel, label) — don't ingest entire services without filters. Default `modified_after: "{{ last_sync }}"` keeps re-runs incremental.

### Cost tiering

Composio free tier = 5k calls/month, ~enough for moderate use. Pro tier ($20/mo) unlocks higher rate limits + premium connectors. For most operators, free tier sustains.

### Auth refresh

Composio handles OAuth token refresh internally per service. The runner only sees the API key. No per-service token management in your config.

## Cost Estimate

| Component | Cost |
|---|---|
| Composio free tier | $0 (5k calls/mo) |
| Composio Pro | $20/mo (50k calls/mo) |
| OpenAI embeds on new pages | ~$0.05–$0.20/mo depending on volume |
| **Total (free tier)** | **~$2/year** |
| **Total (Pro for heavy use)** | **~$240/year** |

## Troubleshooting

**"Service not connected":** open Composio dashboard → Connected Apps → re-auth the service.

**Rate limit (429):** Composio retries with backoff. If hitting limits consistently, narrow filters or upgrade tier.

**Page templates produce empty markdown:** the item shape from Composio varies per service. Inspect a raw result (`console.log(JSON.stringify(res.data[0], null, 2))`) and adjust `renderFrontmatter` / `renderBody`.

**Service not in Composio:** check https://composio.dev/tools — Composio is growing but doesn't cover everything. For unsupported services, write a dedicated recipe.

**Slack threads coming through one-message-at-a-time instead of grouped:** Composio's Slack action returns individual messages; group by `thread_ts` in the runner before writing files.

## Why this is the highest-leverage recipe

The other 5 recipes each unlock one source. This one unlocks the long tail. Once Composio is plumbed, adding a new service (Linear tickets, Stripe customers, HubSpot contacts, Coda docs) is a 10-line YAML config change — no new collector, no new recipe, no new auth.

For an operator (Anoop @ Hash Directors) who lives in a multi-tool stack, this is the recipe that turns "things I'd like in my brain" from a backlog of integration projects into a config file.
