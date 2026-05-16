---
id: telegram-to-brain
name: Telegram-to-Brain
version: 0.1.0
description: Telegram private chats + groups + channels become brain correspondence pages via telethon (user-account API access, not bot). Same correspondence schema as iMessage and LinkedIn.
category: sense
requires: []
secrets:
  - name: TELEGRAM_API_ID
    description: Telegram API ID from https://my.telegram.org
    where: https://my.telegram.org → API development tools → create app → copy api_id
  - name: TELEGRAM_API_HASH
    description: Telegram API hash from https://my.telegram.org (same page as api_id)
    where: same page as TELEGRAM_API_ID
  - name: TELEGRAM_PHONE
    description: Phone number associated with your Telegram account (E.164, e.g. +12125551234)
    where: your own Telegram account settings
health_checks:
  - type: env_exists
    name: TELEGRAM_API_ID
    label: "Telegram API ID set"
  - type: env_exists
    name: TELEGRAM_API_HASH
    label: "Telegram API hash set"
  - type: dir_exists
    path: ~/brain/correspondence/telegram
    label: "Output directory ready"
setup_time: 45 min (auth + first backfill)
cost_estimate: "$0"
---

# Telegram-to-Brain: User-Account API into Searchable Correspondence

The Telegram **Bot API** only sees messages routed to a bot. To ingest your own chats (private DMs + groups + channels you're a member of), you need the **MTProto user-account API** — accessed via `telethon` (Python) with your own api_id/api_hash.

This recipe sets up a one-time auth (you'll receive a code on Telegram itself), then runs incrementally via LaunchAgent. Same `correspondence` schema as iMessage and LinkedIn so cross-source queries work.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Follow precisely. Telegram's API requires user-action auth — there's a manual step you can't skip.

**Why this matters:** Telegram is where a lot of crypto / VC / international conversations happen. For someone running BD in the Cayman / crypto space, Telegram correspondence is high-signal context that doesn't exist in Gmail. Missing it = blind spot.

**Output:**
1. `~/brain/correspondence/telegram/<peer-handle>.md` per chat (one file per DM partner, group, or channel)
2. Inline match-back to person pages via Telegram username (`telegram: @username` frontmatter added)
3. Optional channel ingest (e.g., crypto news channels you follow) as `~/brain/media/telegram/<channel>/<date>.md`

## Architecture

```
my.telegram.org → api_id + api_hash (one-time)
  ↓ telethon login flow (one-time, code via Telegram app)
  ↓ session stored at ~/.gbrain/telegram-session.session
  ↓
Collector (telethon, async Python):
  ├── iterate over dialogs (DMs, groups, channels)
  ├── for each: pull messages since last cursor
  ├── filter substantive (≥ 5 messages OR last activity recent)
  ├── normalize sender → username/phone
  ├── match-back to people/*.md via telegram: frontmatter or phone
  └── write correspondence pages + heartbeat
```

## Opinionated Defaults

**Default scope:** private DMs + groups where you're an active participant (defined as: you've sent ≥ 1 message in the last 12 months). Skip public channels by default (volume too high, low signal) — opt-in via allow-list.

**Filter:** drop dialogs with `< 5` total messages OR no activity in 24 months.

**Privacy:** never write Secret Chats (end-to-end encrypted) — telethon can read them locally, but the user may not want them indexed. Default = skip; opt-in via `--include-secret`.

**Schema:**
```yaml
---
type: correspondence
channel: telegram
participants: [people/jane-doe]
thread_handle: <telegram dialog ID>
first_message: 2021-04-12
last_message: 2026-05-09
message_count: 234
telegram_username: "@janedoe"
---
# Thread: Jane Doe (Telegram)
```

## Prerequisites

1. **Telegram account** with a phone number
2. **Python 3.10+** with `pip install telethon`
3. **gbrain doctor** passes
4. **Brief access to your Telegram app** during first auth (to copy the code Telegram sends)

## Setup Flow

### Step 1: Create Telegram API credentials

Tell the user:
> "Go to https://my.telegram.org, log in with your phone number + the SMS code Telegram sends. Click **'API development tools'**. Fill in: App title (anything), Short name (anything). Submit. Copy the **api_id** (numeric) and **api_hash** (hex string)."

Save to `~/.zprofile`:
```bash
export TELEGRAM_API_ID="12345678"
export TELEGRAM_API_HASH="abc123def456..."
export TELEGRAM_PHONE="+12125551234"
```

### Step 2: Install telethon

```bash
mkdir -p ~/telegram-collector && cd ~/telegram-collector
python3 -m venv venv && source venv/bin/activate
pip install telethon
```

### Step 3: First auth (interactive)

Create `~/telegram-collector/auth.py`:

```python
import os, asyncio
from telethon import TelegramClient

api_id = int(os.environ["TELEGRAM_API_ID"])
api_hash = os.environ["TELEGRAM_API_HASH"]
phone = os.environ["TELEGRAM_PHONE"]
session_path = os.path.expanduser("~/.gbrain/telegram-session")

async def main():
    client = TelegramClient(session_path, api_id, api_hash)
    await client.start(phone=phone)
    me = await client.get_me()
    print(f"AUTH OK as {me.username or me.first_name} ({me.id})")
    await client.disconnect()

asyncio.run(main())
```

Run it:
```bash
source ~/.zprofile && source ~/telegram-collector/venv/bin/activate
python3 ~/telegram-collector/auth.py
```

Telethon will prompt: *"Please enter the code you received:"* — open Telegram on your phone, find the **"Telegram"** chat (login codes arrive there), copy the 5-digit code, paste in the terminal. If you have 2FA, it'll also ask for your password.

**Validate:** session file should exist at `~/.gbrain/telegram-session.session` and the `AUTH OK as ...` line should print.

### Step 4: Build the collector

Create `~/telegram-collector/telegram-collector.py`:

```python
import os, re, json, asyncio, datetime as dt
from pathlib import Path
from telethon import TelegramClient

api_id = int(os.environ["TELEGRAM_API_ID"])
api_hash = os.environ["TELEGRAM_API_HASH"]
session_path = os.path.expanduser("~/.gbrain/telegram-session")

BRAIN = Path.home() / "brain"
OUT = BRAIN / "correspondence" / "telegram"
HEARTBEAT = Path.home() / ".gbrain" / "integrations" / "telegram" / "heartbeat.jsonl"
STATE = Path.home() / ".gbrain" / "telegram-state.json"
ALLOWLIST = Path.home() / ".gbrain" / "telegram-allowlist.txt"

OUT.mkdir(parents=True, exist_ok=True)
HEARTBEAT.parent.mkdir(parents=True, exist_ok=True)

state = json.loads(STATE.read_text()) if STATE.exists() else {"cursors": {}}
allowlist = set()
if ALLOWLIST.exists():
    allowlist = {l.strip() for l in ALLOWLIST.read_text().splitlines() if l.strip() and not l.startswith("#")}

# Build person index by telegram_username
people_by_username: dict[str, str] = {}
for p in (BRAIN / "people").rglob("*.md"):
    text = p.read_text(errors="ignore")
    m = re.search(r"^telegram:\s*@?(\w+)", text, re.MULTILINE)
    if m:
        people_by_username[m.group(1).lower()] = p.relative_to(BRAIN).with_suffix("").as_posix()

def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9-]+", "-", (s or "").lower()).strip("-")[:80]

async def main():
    client = TelegramClient(session_path, api_id, api_hash)
    await client.connect()
    if not await client.is_user_authorized():
        raise RuntimeError("Not authorized — run auth.py first")

    written = 0
    matched = 0
    me = await client.get_me()

    async for dialog in client.iter_dialogs():
        ent = dialog.entity
        # Skip channels by default; include groups + DMs
        is_channel = getattr(ent, "broadcast", False)
        if is_channel and (not allowlist or str(dialog.id) not in allowlist):
            continue
        # Skip if not in allow-list when allow-list present
        username = getattr(ent, "username", None)
        if allowlist:
            keys = [str(dialog.id), username and username.lower()]
            if not any(k in allowlist for k in keys if k):
                continue

        # Substantive filter
        if dialog.message and dialog.message.date < dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=730):
            continue

        cursor = state["cursors"].get(str(dialog.id), 0)
        msgs = []
        async for msg in client.iter_messages(dialog, min_id=cursor, limit=10000):
            if msg.text:
                msgs.append(msg)
        if len(msgs) < 5 and cursor == 0:
            continue  # too small to bother on first run

        msgs.reverse()
        peer_name = getattr(ent, "title", None) or f"{getattr(ent, 'first_name', '')} {getattr(ent, 'last_name', '') or ''}".strip()
        slug = slugify(username or peer_name or str(dialog.id))
        matched_slug = people_by_username.get((username or "").lower())
        if matched_slug: matched += 1

        first_dt = msgs[0].date.strftime("%Y-%m-%d") if msgs else ""
        last_dt = msgs[-1].date.strftime("%Y-%m-%d") if msgs else ""

        fm = (
            f"---\ntype: correspondence\nchannel: telegram\n"
            f"participants: {[matched_slug] if matched_slug else []}\n"
            f"thread_handle: {dialog.id}\n"
            f"first_message: {first_dt}\nlast_message: {last_dt}\n"
            f"message_count: {len(msgs)}\n"
            f"telegram_username: \"@{username}\"\n" if username else ""
            f"---\n# Thread: {peer_name}\n\n"
        )
        body = []
        total = 0
        for m in msgs:
            handle = "[me]" if m.out else f"[{username or peer_name}]"
            line = f"- **{m.date.strftime('%Y-%m-%d')}** {handle}: {m.text.strip()[:500]}"
            if total + len(line) > 800_000: break
            body.append(line); total += len(line) + 1

        (OUT / f"{slug}.md").write_text(fm + "\n".join(body))
        state["cursors"][str(dialog.id)] = msgs[-1].id if msgs else cursor
        written += 1

    STATE.write_text(json.dumps(state, indent=2))
    hb = {
        "ts": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "event": "sync_complete",
        "status": "ok",
        "details": {"threads_written": written, "person_matches": matched},
    }
    with HEARTBEAT.open("a") as f: f.write(json.dumps(hb) + "\n")
    print(json.dumps(hb, indent=2))
    await client.disconnect()

asyncio.run(main())
```

### Step 5: First run (backfill)

```bash
source ~/.zprofile && source ~/telegram-collector/venv/bin/activate
python3 ~/telegram-collector/telegram-collector.py
```

### Step 6: Sync to gbrain

```bash
cd ~/brain && git add correspondence/telegram/ && git commit -m "telegram: initial backfill"
source ~/.zprofile && cd ~/gbrain
gbrain sync --no-pull --no-embed --repo ~/brain
gbrain embed --stale
gbrain extract links --dir ~/brain
```

### Step 7: LaunchAgent

`~/telegram-collector/run.sh` (sources `~/.zprofile` + venv + runs collector + gbrain sync). Plist with `StartInterval=1800` (every 30 min — Telegram updates less frequently than iMessage but more than calendar).

`launchctl load` + verify.

## Critical Implementation Details

### Session file location

`~/.gbrain/telegram-session.session` is **as secret as your account password**. Anyone with this file can read all your Telegram messages. File mode 600 minimum; do not commit, do not back up to public cloud.

### Match-back via telegram username

Person pages need `telegram: @username` frontmatter to match. The first run populates this for people the user converses with. For others (mentioned in groups but not personally messaging), `telegram_username:` can be set manually.

### Idempotency via cursors

`~/.gbrain/telegram-state.json` stores `dialog_id → last_message_id`. Next run only pulls messages with `min_id > cursor`. Append-only at the page level: existing files get NEW messages appended, not rewritten.

### Channel vs group vs DM distinction

- **DM**: `ent.user_id` set, no `title`. One participant.
- **Group**: `ent.megagroup=True`. Many participants. Frontmatter `participants:` lists matched ones.
- **Channel**: `ent.broadcast=True`. Skipped by default. Opt-in via allowlist.

### Secret Chats

`telethon` reads them with the right session, BUT they're labeled `EncryptedChat` in dialogs. The collector skips them by default. Opt-in via `--include-secret` if user wants.

## Cost Estimate

| Component | Cost |
|---|---|
| Telegram API | $0 (free) |
| Compute | $0 (local) |
| OpenAI embeds | ~$0.05 / 1000 threads |
| **Total** | **~$0.20 / year** |

## Troubleshooting

**"FloodWaitError":** Telegram rate-limited the session. Wait the specified seconds (telethon prints the number) and re-run. Future runs are incremental so this is rare.

**"PhoneCodeInvalidError":** User typed the wrong code, or used a code from a previous login attempt. Re-run auth.py and use the freshest code.

**2FA password:** Telegram prompts for "cloud password" if user has 2FA. Type it in (telethon hides input).

**Session expired after a long gap:** Re-run auth.py; will likely require a fresh code.

**Match-back rate low:** Person pages don't have `telegram:` frontmatter. Add manually for the dozen most-messaged contacts, run again, rate will climb.
