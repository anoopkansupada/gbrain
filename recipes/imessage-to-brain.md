---
id: imessage-to-brain
name: iMessage-to-Brain
version: 0.1.0
description: macOS iMessage threads (~/Library/Messages/chat.db) become brain correspondence pages with person match-back via phone number / Apple ID email.
category: sense
requires: []
secrets: []
health_checks:
  - type: file_exists
    path: ~/Library/Messages/chat.db
    label: "iMessage chat.db readable"
  - type: dir_exists
    path: ~/brain/correspondence/imessage
    label: "Output directory ready"
setup_time: 1 hour (collector) + Full Disk Access grant (manual)
cost_estimate: "$0 (local SQLite read, no API)"
---

# iMessage-to-Brain: Local Threads Become Searchable Memory

iMessage lives on every Mac as a SQLite database at `~/Library/Messages/chat.db`. This recipe reads it directly (no API, no auth), extracts substantive threads, and writes them as `correspondence`-type pages that **match back to existing person pages via phone number** — auto-tagging the contact you're already tracking with their entire iMessage history.

This is the single biggest unlock for "what did I eat in DC" / "where did I stay in Paris" — friend coordination chats are where the actual venue choices live, not on calendar.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Follow precisely.

**Why this matters:** Phone match-back compounds. Every person page already has phone numbers from Google Contacts. iMessage adds the **conversational history** to each match. Combined, you get "every text I exchanged with Kajal" → which surfaces Filomena Ristorante reservations, Saturday lunch plans, etc.

**Output:**
1. `~/brain/correspondence/imessage/<thread-handle>.md` per thread (one file per conversation partner / group)
2. Inline match-back: each matched person page gets `imessage_handles: [+1XXX, email@apple]` frontmatter for future lookups

## Architecture

```
~/Library/Messages/chat.db (SQLite, append-only)
  ↓ collector reads message + handle + chat tables
  ↓ join messages → chat handles → recipients
  ↓ filter substantive threads (≥ N messages, last activity in last K months, or explicit allow-list)
  ↓ phone normalization (E.164)
  ↓ match-back vs people/*.md
  ↓
For each thread:
  ├── if matched person: write ~/brain/correspondence/imessage/<slug>.md
  └── annotate person page with imessage_handles frontmatter
  ↓ heartbeat
```

## Opinionated Defaults

**Substantive filter** — drop:
- threads with `< 5` messages
- threads where the last message is `> 18 months` old AND total count `< 20`
- single-emoji messages (drop the message, not the thread)
- messages from `unknown sender` / numbers not in Contacts (unless on allow-list)

**Allow-list mode (recommended for first run):** ingest only threads with people on a curated list. The user provides phone numbers / Apple IDs. Default to family + close friends + work contacts. Expand iteratively.

**Privacy:** never write the raw message body to logs. Don't paste thread contents into Claude conversations unless the user explicitly requests a query against them. The brain MCP retrieves them on demand.

**Schema (`correspondence` type — shared with linkedin/telegram):**
```yaml
---
type: correspondence
channel: imessage
participants: [people/jane-doe, people/anoop-kansupada]
thread_handle: <imessage chat GUID>
first_message: 2018-03-04
last_message: 2026-04-22
message_count: 412
phone_e164: "+19178620401"
---
# Thread: Jane Doe (iMessage)
<turn-by-turn body, truncated if > 800KB to avoid tsvector overflow>
```

## Prerequisites

1. **macOS**, signed into iMessage with `Messages in iCloud` enabled or local-only — either works
2. **Full Disk Access** for the process reading `chat.db` (Terminal.app, bash, or the LaunchAgent — System Settings → Privacy & Security → Full Disk Access)
3. **gbrain doctor** passes; brain repo + collector dir writable
4. **Python 3 + sqlite3** (built-in on macOS; verify `python3 -c "import sqlite3"`)

## Setup Flow

### Step 1: Grant Full Disk Access

Tell the user:
> "Open System Settings → Privacy & Security → Full Disk Access. Click `+`, navigate to `/bin/bash` (Cmd+Shift+G to type the path). Toggle it on. Same for `/usr/bin/python3`. Restart the LaunchAgent process if it was already loaded."

Validate:
```bash
python3 -c "import sqlite3; c=sqlite3.connect('$HOME/Library/Messages/chat.db'); print('READ OK', c.execute('SELECT COUNT(*) FROM message').fetchone())"
```
Should print `READ OK (N,)` where N is the total message count.

### Step 2: Build the collector

```bash
mkdir -p ~/imessage-collector && cd ~/imessage-collector
```

Create `imessage-collector.py`:

```python
import sqlite3, os, re, json, sys, datetime as dt
from pathlib import Path

CHAT_DB = Path.home() / "Library" / "Messages" / "chat.db"
BRAIN = Path.home() / "brain"
OUT = BRAIN / "correspondence" / "imessage"
HEARTBEAT = Path.home() / ".gbrain" / "integrations" / "imessage" / "heartbeat.jsonl"
ALLOWLIST_FILE = Path.home() / ".gbrain" / "imessage-allowlist.txt"

OUT.mkdir(parents=True, exist_ok=True)
HEARTBEAT.parent.mkdir(parents=True, exist_ok=True)

# Load allow-list (one phone/email per line)
allowlist = set()
if ALLOWLIST_FILE.exists():
    allowlist = {line.strip() for line in ALLOWLIST_FILE.read_text().splitlines() if line.strip() and not line.startswith("#")}

def normalize_phone(s: str) -> str | None:
    if not s: return None
    if "@" in s: return s.lower()  # Apple ID email
    digits = re.sub(r"\D", "", s)
    if len(digits) == 10: return "+1" + digits
    if len(digits) == 11 and digits.startswith("1"): return "+" + digits
    return "+" + digits if digits else None

# Apple stores message dates as nanoseconds since 2001-01-01
APPLE_EPOCH = dt.datetime(2001, 1, 1, tzinfo=dt.timezone.utc)
def apple_date_to_iso(ns: int) -> str:
    if not ns: return ""
    return (APPLE_EPOCH + dt.timedelta(seconds=ns/1e9)).strftime("%Y-%m-%d")

# Build person page index for match-back
people_index: dict[str, str] = {}  # phone/email -> slug
for p in (BRAIN / "people").rglob("*.md"):
    text = p.read_text(errors="ignore")
    for m in re.finditer(r"^- ?(\+?[\d\s().-]+|[\w.-]+@[\w.-]+)", text, re.MULTILINE):
        norm = normalize_phone(m.group(1))
        if norm: people_index[norm] = p.relative_to(BRAIN).with_suffix("").as_posix()

conn = sqlite3.connect(f"file:{CHAT_DB}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

# Each chat has handles (recipients) and messages
chats = conn.execute("""
    SELECT c.ROWID as chat_id, c.guid, c.chat_identifier, c.display_name,
           COUNT(DISTINCT m.ROWID) as msg_count,
           MIN(m.date) as first_date, MAX(m.date) as last_date
    FROM chat c
    JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
    JOIN message m ON m.ROWID = cmj.message_id
    GROUP BY c.ROWID
    HAVING msg_count >= 5
    ORDER BY last_date DESC
""").fetchall()

written = 0
matched_pages = set()
for chat in chats:
    handles = [r["id"] for r in conn.execute(
        "SELECT h.id FROM handle h JOIN chat_handle_join chj ON chj.handle_id=h.ROWID WHERE chj.chat_id=?",
        (chat["chat_id"],)
    )]
    norms = [normalize_phone(h) for h in handles if h]
    norms = [n for n in norms if n]

    # Apply allow-list if non-empty
    if allowlist and not any(n in allowlist for n in norms):
        continue

    # Match-back
    matched_slugs = [people_index[n] for n in norms if n in people_index]
    matched_pages.update(matched_slugs)

    # Build slug from chat_identifier or display_name
    slug_base = chat["display_name"] or chat["chat_identifier"] or chat["guid"]
    slug = re.sub(r"[^a-z0-9-]+", "-", slug_base.lower()).strip("-")[:80]

    out_path = OUT / f"{slug}.md"
    if out_path.exists(): continue  # idempotent; later step handles incremental updates

    # Pull messages (truncate body to keep page under 800KB)
    msgs = conn.execute("""
        SELECT m.date, m.is_from_me, m.text, h.id as handle
        FROM message m
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        WHERE cmj.chat_id = ? AND m.text IS NOT NULL AND LENGTH(m.text) > 0
        ORDER BY m.date
    """, (chat["chat_id"],)).fetchall()

    body_lines = []
    total = 0
    for m in msgs:
        line = f"- **{apple_date_to_iso(m['date'])}** {'[me]' if m['is_from_me'] else '[' + (m['handle'] or '?') + ']'}: {m['text'].strip()[:500]}"
        if total + len(line) > 800_000: break
        body_lines.append(line); total += len(line) + 1

    fm = {
        "type": "correspondence",
        "channel": "imessage",
        "participants": matched_slugs or [f"unknown/{n}" for n in norms],
        "thread_handle": chat["guid"],
        "first_message": apple_date_to_iso(chat["first_date"]),
        "last_message": apple_date_to_iso(chat["last_date"]),
        "message_count": chat["msg_count"],
        "phone_e164": norms[0] if norms else "",
    }
    fm_str = "---\n" + "\n".join(f"{k}: {json.dumps(v) if isinstance(v, list) else v}" for k, v in fm.items()) + "\n---\n"
    out_path.write_text(fm_str + f"# Thread: {slug_base}\n\n" + "\n".join(body_lines))
    written += 1

# Write heartbeat
hb = {
    "ts": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "event": "sync_complete",
    "status": "ok",
    "details": {"threads_written": written, "person_matches": len(matched_pages), "allowlist_size": len(allowlist)},
}
with HEARTBEAT.open("a") as f:
    f.write(json.dumps(hb) + "\n")

print(json.dumps(hb, indent=2))
```

### Step 3: Allow-list

Tell the user:
> "Edit `~/.gbrain/imessage-allowlist.txt`. One phone (E.164 like `+12125551234`) or Apple ID email per line. Start with 10–20 people you actually want indexed; add more iteratively. Or leave the file empty / missing to ingest **everything** ≥ 5 messages — riskier on privacy."

Validate:
```bash
wc -l ~/.gbrain/imessage-allowlist.txt 2>/dev/null || echo "no allow-list — will ingest all substantive threads"
```

### Step 4: First run

```bash
python3 ~/imessage-collector/imessage-collector.py
ls ~/brain/correspondence/imessage/ | wc -l
tail -1 ~/.gbrain/integrations/imessage/heartbeat.jsonl
```

### Step 5: Sync to gbrain

```bash
cd ~/brain && git add correspondence/imessage/ && git commit -m "imessage: initial backfill ($(ls ~/brain/correspondence/imessage/ | wc -l) threads)"
source ~/.zprofile
cd ~/gbrain
gbrain sync --no-pull --no-embed --repo ~/brain
gbrain embed --stale
gbrain extract links --dir ~/brain
```

### Step 6: LaunchAgent (incremental updates)

`~/calendar-sync`-style. Create `~/imessage-collector/run.sh` (sources `~/.zprofile`, runs the python collector, then `gbrain sync --no-pull --no-embed && gbrain embed --stale`).

Create `~/Library/LaunchAgents/com.gbrain.imessage.plist` with `StartInterval=3600` (hourly — chat.db updates frequently) and `RunAtLoad=true`.

`launchctl load` + verify in launchctl list + tail heartbeat.

### Step 7: Heartbeat verification

```bash
tail -3 ~/.gbrain/integrations/imessage/heartbeat.jsonl
```

## Critical Implementation Details

### Date math (Apple's quirky format)

Apple stores `message.date` as **nanoseconds since 2001-01-01 00:00:00 UTC** — not Unix epoch. Forgetting the offset = dates 31 years off. Conversion: `(ns / 1e9) + 978307200` = Unix seconds. The Python helper above handles it.

### Schema reuse from LinkedIn

`type: correspondence` + `channel: imessage` matches the LinkedIn recipe's schema exactly. Same fields, different channel. This means queries like "all my conversations with Pedro" cross-source naturally.

### Idempotency

Re-running the collector skips threads whose output file already exists. To force-update (e.g., add new messages to an old thread), delete the file first OR add an `--update` flag that diffs `message_count` and appends new messages.

### Phone normalization edge cases

- US 10-digit → prepend `+1`
- US 11-digit starting with `1` → prepend `+`
- International → assume already E.164 if starts with `+`, otherwise prepend `+`
- iCloud handles can be `email@apple.com` style — keep as-is

### Page size limits

A thread with 10,000+ messages over a decade can blow past 1MB (tsvector limit per the gbrain-install skill troubleshooting #2). The collector truncates body at 800KB. For chronological splits (one file per year), add a future v0.2 flag.

## Cost Estimate

| Component | Cost |
|---|---|
| SQLite reads | $0 (local) |
| OpenAI embedding of new pages | ~$0.02 per 1000 threads |
| LaunchAgent compute | $0 |
| **Total** | **~$0.10 / year** |

## Troubleshooting

**"unable to open database file":** Full Disk Access not granted to the process. Re-do Step 1 for `/bin/bash` and `/usr/bin/python3` and any LaunchAgent script path.

**Phone match-back rate low:** Most likely `people/*.md` pages don't have phone numbers as `- +1...` bullet lines (the format Google Contacts uses). Adjust the regex in the collector OR run `email-to-brain`'s contact enrichment first.

**Threads from group chats split awkwardly:** Group chats appear as one chat row with N handles. The collector currently uses the first handle's normalized number. For groups, the file name is the display_name (the group title); participants frontmatter lists all matched slugs.

**Tsvector overflow on long thread:** Reduce per-message truncation from 500 → 300 chars, OR split file by year (manual for now).

**Allow-list missed someone you want:** Add their phone or Apple ID to `~/.gbrain/imessage-allowlist.txt`, re-run.

**Encrypted Messages backup (Messages in iCloud only, not local):** chat.db may be empty if the user never had a local-store. Re-enable `Settings → Messages → Messages in iCloud → Enable Messages on iCloud` followed by `Sync Now` to populate the local cache.
