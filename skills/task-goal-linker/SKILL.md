---
name: task-goal-linker
version: 0.2.0
description: |
  Scan all tasks/* pages in gbrain, ensure each has due (deadline) + owner +
  parent_goal frontmatter, link tasks to goals/weekly/* or goals/monthly/*
  via a single LLM resolution pass, surface orphans + missing-metadata in a
  dated audit report.
triggers:
  - "link tasks to goals"
  - "audit tasks"
  - "/task-link"
tools:
  - get_page
  - put_page
  - list_pages
mutating: true
writes_pages: true
writes_to:
  - tasks/        # parent_goal frontmatter only
  - reports/      # dated audit report
---

# Task ↔ Goal Linker

Close the loop between tasks and goals. Every task in gbrain should be
traceable to a parent goal (weekly or monthly) so the operator can answer
"why am I doing this?" in one hop.

## Contract

- **One LLM call per audit.** All unlinked tasks + all goals go in one
  prompt; one JSON object comes back. No hand-tuned scoring weights.
- **Idempotent.** A task with non-empty `parent_goal:` is skipped unless
  `--force` is passed.
- **Three audits per task:** due (deadline) present? owner present?
  parent_goal present? Any missing field surfaces in the audit report.
- **Orphans surface, not silently dropped.** The LLM may return
  `parent_goal: null` — those land in the orphans section so the operator
  either files them under a goal or signals a missing goal.
- **Drafts only.** Frontmatter writes only; no body edits.

## Inputs

Optional CLI flags (per-machine runner at `~/.gbrain/integrations/task-goal-linker/run.sh`):
- `--force` — re-link tasks that already have `parent_goal:`
- `--dry-run` — print proposed changes without writing

## Architecture

Per the gbrain convention, this skill has two halves:

1. **`~/gbrain/skills/task-goal-linker/SKILL.md`** (this file) — contract +
   data shapes, machine-agnostic.
2. **`~/.gbrain/integrations/task-goal-linker/run.sh`** — per-machine
   runner. Calls `bun run src/cli.ts` for gbrain reads/writes and
   `claude -p` (via stdin) for the LLM resolution pass. Reference copy at
   `skills/task-goal-linker/run.sh.reference`.

## Phases

### 1. Load goals

`gbrain list --type goal --limit 500`; for each, read frontmatter
(`period`, `horizon`, `start_date`, `end_date`) + first 800 chars of body.

### 2. Walk tasks

`gbrain list --type task --limit 500`. For each task, read:
- `deadline:` (or `due:`)
- `owner:`
- `parent_goal:`
Mark missing fields. Skip already-linked tasks unless `--force`.

### 3. One LLM call

Build a single prompt with all goals + all unlinked tasks (title, deadline,
600-char body excerpt). Ask for a JSON object:

```json
{
  "links": [
    {"task": "tasks/<slug>", "parent_goal": "goals/weekly/<slug>",
     "reason": "deadline in window + ICP overlap"},
    {"task": "tasks/<slug>", "parent_goal": null,
     "reason": "no plausible goal — file under a new goal"}
  ]
}
```

Match rules in the prompt: prefer weekly over monthly when deadline falls
in the weekly window; otherwise topic/title/body overlap drives it.

### 4. Write back

For each non-null match, inject `parent_goal: <slug>` into task
frontmatter via `gbrain put`. Preserve all other frontmatter and body.

### 5. Report

Write `reports/task-link-audit-<YYYY-MM-DD>.md` with frontmatter:

```yaml
---
type: report
date: <today>
generator: task-goal-linker v0.2 (LLM)
linked: N
orphans: M
missing_metadata: K
---
```

Body sections: Linked, Orphans (with reason), Missing metadata.

## When to use

- Daily-driver audit: after a meeting processor run, re-run the linker to
  catch new merger-created tasks.
- Weekly review: `--force` to re-link everything against the current week's
  goal.
- Goal-restructure: after editing goal scope, `--force` to re-balance task
  attribution.

## Output guarantees

- Audit report is the single source of truth for "what was linked and why"
  on a given day.
- Orphans imply *either* a misfiled task *or* a missing goal — the LLM's
  `reason` field disambiguates.
- The skill never writes goals or tasks beyond a single `parent_goal:`
  frontmatter line; body changes happen in other skills.
