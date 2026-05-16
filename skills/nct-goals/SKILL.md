---
name: nct-goals
version: 1.0.0
description: |
  Generate, validate, and maintain NCT-shaped goal pages (Narrative,
  Commitments, Tasks) in gbrain. Replaces "themes + top priorities" stub
  shape with disciplined commitment IDs that tasks can anchor to. Use
  when creating a new weekly/monthly/quarterly goal page, when reshaping
  legacy goal pages, or when verifying a goal page is well-formed enough
  for enrich-tasks to consume.
triggers:
  - "create goals page"
  - "shape goals as NCT"
  - "reshape goals"
  - "validate goal page"
  - "new month goals"
  - "new week goals"
tools:
  - get_page
  - put_page
  - list_pages
  - search
inputs:
  - horizon (weekly | monthly | quarterly)
  - period (e.g. "2026-05", "2026-W19", "2026-Q2")
  - source_briefs (optional list of brief slugs that define strategy)
  - parent_goal_slug (for weekly → monthly link)
outputs:
  - "goals/<horizon>/<period>"   # written via put_page
mutating: true
writes_pages: true
writes_to:
  - goals/
---

# NCT Goals

Goal pages in NCT shape: **Narrative → Commitments → Tasks**. The narrative is the strategic paragraph (why this period, what's the bet). Commitments are 3–7 specific, measurable things the producer commits to within the period — they hold both outcomes and delivery work cleanly, unlike OKR Key Results. Tasks anchor to a commitment by ID (e.g. `#c1`), not to a vague theme or markdown anchor.

## Why this exists

The legacy goal pages on this brain are "Themes" + "Top priorities" — readable, but tasks can't reliably link to them and the operator can't tell at a glance which items are done. NCT closes both gaps:

- **Commitment IDs are stable**. `C1` survives reordering, edits, status changes.
- **Commitments hold delivery work**. "Ship 4 proposals" is a valid commitment — it's measurable and directly actionable. Same as an outcome commitment like "publish RWA paper."
- **Narrative cites the source**. Every commitment ties back to a call, decision, or signal. No goals appear out of nowhere.
- **Status is binary at the commitment level**. `status: open | done | blocked | cancelled` — no 0.7 sandbagging.

Originator: Ravi Mehta (ex-FB, Tinder CPO). Canonical reference: Reforge "Set Better Goals with NCTs, Not OKRs" (Mehta, 2021).

## Contract

- **Every goal page has Narrative + Commitments. Tasks section is optional and auto-populated** by enrich-tasks; do not hand-edit it.
- **Commitment IDs are sequential within a page**: `C1, C2, C3...` for monthly/quarterly; `WC1, WC2...` for weekly. The prefix tells the operator the horizon at a glance.
- **3–7 commitments per page**. Fewer than 3: the period probably isn't worth a goal page. More than 7: the operator can't hold them all; split or escalate to monthly.
- **Each commitment is measurable and time-bound**. A commitment without a `done_when:` rule and a `due:` date is a wish, not a commitment.
- **Narrative is 1–3 paragraphs, max ~150 words**. It cites at least one source: a brief slug, a meeting slug, or a decision page. The narrative answers "if you had to defend why this period's commitments are these and not other commitments, what's the argument?"
- **Weekly pages link to their parent monthly**. `parent_goal: "goals/monthly/<YYYY-MM>"` in frontmatter. Weekly commitments may reference a monthly commitment ID (e.g. `parent_commitment: "C2"`) when they are explicit weekly-scoped slices.
- **Status taxonomy is page-level AND commitment-level**:
  - Page-level (frontmatter): `active | completed | abandoned`
  - Commitment-level (per commitment): `open | done | blocked | cancelled`
- **Done means binary**. Each commitment has a `done_when:` rule that's checkable. "Ship 4 proposals" → done when 4 proposals are in `~/brain/deliverables/` with `status: sent`. "Publish RWA paper" → done when the file is published and at least one share confirmation is logged.

## Inputs

- `horizon` — `weekly | monthly | quarterly`. Determines commitment-ID prefix and `start_date`/`end_date` computation.
- `period` — string identifier per horizon:
  - weekly: `YYYY-W##` (ISO week)
  - monthly: `YYYY-MM`
  - quarterly: `YYYY-Q#`
- `source_briefs` — optional list of brief slugs that define the strategy this page implements. The skill reads each brief and cites it in the narrative.
- `parent_goal_slug` — for weekly pages, the monthly goal page they roll up into.

## Page shape (output schema)

Every goal page is a markdown file written via `put_page` with this exact frontmatter + body:

```yaml
---
type: goal
horizon: weekly | monthly | quarterly
period: <YYYY-MM | YYYY-W## | YYYY-Q#>
owner: "people/<slug>"
status: active | completed | abandoned
start_date: <ISO date>
end_date: <ISO date>
parent_goal: "goals/<horizon>/<period>"   # weekly only; omit for monthly/quarterly
source_briefs: ["briefs/<slug>", ...]      # optional, recommended
tags: [goal, <horizon>, <theme tags optional>]
---

# Goals — <human title> (<date range>)

## Narrative

<1–3 paragraphs explaining the strategic bet for this period. Cites at least
one source brief or meeting. Answers: why these commitments, why now, what
moves if they all complete.>

## Commitments

### <CID> — <commitment title>

- **Source:** `[[briefs/<slug>]]` or `[[meetings/<slug>]]` (the call/decision that produced this commitment)
- **Done when:** <binary checkable rule>
- **Due:** <YYYY-MM-DD>
- **Owner:** `[[people/<slug>]]`
- **Status:** open | done | blocked | cancelled
- **Parent commitment:** `<CID-from-parent-page>`  *(weekly pages only, optional)*
- **Notes:** <one or two sentences of context, optional>

<repeat for each commitment, 3–7 total>

## Tasks

<auto-populated by enrich-tasks. Do not hand-edit. Each line:
`- [ ] <title> — <CID> · due <YYYY-MM-DD> · [[tasks/<slug>]]`>
```

## Algorithm for generating a new goal page

When the operator says "new month goals" or "shape goals as NCT for <period>":

1. **Load source briefs.** For each `source_briefs` entry, `get_page` and read the body for strategic intent (key intel, action items, deal updates).
2. **Load adjacent goal pages.** Read the parent (if weekly) and the prior period (if monthly/quarterly). Don't repeat already-committed work; do roll forward incomplete commitments where it makes sense.
3. **Draft the narrative.** 1–3 paragraphs. Cite the source briefs explicitly. The narrative should pass the "could a reader who hadn't seen the source briefs reconstruct the strategic bet" test.
4. **Draft commitments.** Pull from action items in source briefs, from explicit strategic asks in their bodies, and from carry-overs from the prior period. For each: write a binary `done_when:` rule. If you can't write one, the commitment isn't well-formed — rework it.
5. **Number the commitments.** `C1, C2, C3...` (or `WC1...` for weekly). Order by priority/anchor commitment first.
6. **Validate before writing.**
   - 3–7 commitments? ✓
   - Each has `done_when` and `due`? ✓
   - Narrative cites at least one source? ✓
   - Weekly has `parent_goal`? ✓
   - No more than ~150 words in narrative? ✓
7. **Write via `put_page`.** Idempotent: if the page exists, merge by keeping operator edits where commitments overlap. Never overwrite an in-flight `status: done` commitment.

## Validation pass (standalone use)

If invoked with an existing goal page slug to validate, run only steps 6 above and report per-rule pass/fail. Useful for the `task-goal-linker` audit and for reshaping legacy stub pages.

## Anti-patterns

- Writing the Tasks section by hand. That's enrich-tasks' job. Hand-written tasks here will be overwritten or stranded.
- Commitments without `done_when:`. "Improve narrative" is not a commitment — it has no completion criterion.
- More than 7 commitments. If you can't pick 7 things that matter most this period, the priority signal is gone.
- A narrative that doesn't cite a source. Goals that materialize from nowhere are a code smell — they tend to drift from what the operator actually said matters.
- Renumbering commitments after tasks are linked. C2 stays C2 even if C1 is cancelled. Use `status: cancelled` instead of deleting.
- Mixing weekly and monthly commitments on the same page. A weekly slice of a monthly commitment is its own commitment with `parent_commitment: C<n>`.

## Integration with enrich-tasks

`enrich-tasks` reads goal pages for commitment IDs and assigns each task one `parent_goal: "[[goals/<horizon>/<period>#<cid>]]"`. The `#<cid>` fragment is the anchor — that's why commitment IDs are stable. If the goal page is in legacy "Themes/Top priorities" shape, enrich-tasks falls back to routing all tasks to orphans with `reason: parent_goal_not_nct_shape`, and the operator should invoke this skill to reshape.

## Reference

- Ravi Mehta, "Set Better Goals with NCTs, Not OKRs" (Reforge, 2021)
- "NCTs (Narrative, Commitment, Task)" — Open Practice Library
- Existing extractor convention: see `~/gbrain/skills/extractors/extract-action-items/SKILL.md` for the action-items → tasks pipeline that feeds the Tasks section.
