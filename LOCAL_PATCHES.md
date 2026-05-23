# Local Patches — Triage & Upstream Plan

Living document. Every patch carried on top of `origin/master` belongs here, with
a triage decision: **PR upstream**, **keep local (extension point)**, or **delete**.

Audit cadence: every upgrade. If a patch sits here for >30 days without a PR
filed or a justification, delete it or land it.

Last audit: 2026-05-23 (post-v0.40.6 upgrade)

---

## Patches that touch `src/` (conflict-prone — these are the ones that cost time)

### 1. `dc76d3c7` — `--unsafe-bypass-lock` flag on `gbrain dream`
- **Files:** `src/commands/dream.ts` (+7), `src/core/cycle.ts` (+9)
- **What it does:** Adds CLI flag that skips the cycle advisory-lock gate, so manual `gbrain dream --phase X` can run while the autopilot daemon holds the lock. Loud stderr warning. Cron MUST NOT use.
- **Why it exists:** PC2 manual backfill via `~/.gbrain/backfill-synthesize.sh` blocked by `cycle_already_running`.
- **Triage: PR UPSTREAM.** Useful for any operator doing manual backfill against a continuously-running brain. Upstream already has `--unsafe-bypass-dream-guard` (precedent: same naming convention, same caveats).
- **PR action:** open against `garrytan/gbrain` titled `feat(dream): --unsafe-bypass-lock flag for manual backfill while autopilot runs`. Body: cherry-pick `dc76d3c7` summary.
- **Owner:** Anoop
- **Status:** not yet filed

### 2. `ea7e039f` — Bootstrap forward-reference for v51/v60/v61 columns
- **Files:** `src/commands/migrations/v0_32_2.ts` (3 lines) — the larger commit also reworked the postgres-engine bootstrap probe list, but that survived in upstream form.
- **What it does:** `notability` column was removed from `facts` table in a later wave; the v0_32_2 phase B `SELECT` still referenced it. Patches to `NULL::text AS notability` so brains migrating from <v51 don't crash.
- **Why it exists:** schema v49→v66 forward migration on Supabase brains.
- **Triage: PR UPSTREAM.** Surgical, low-risk, addresses a real forward-compat bug for older brains. Likely already moot for fresh installs (v0_32_2 is a long way back), but cheap insurance.
- **PR action:** title `fix(migrations/v0_32_2): tolerate dropped notability column in phase B SELECT`. Surface the IPv6 / `GBRAIN_DISABLE_DIRECT_POOL=1` note in the issue body so future operators find it.
- **Owner:** Anoop
- **Status:** not yet filed

### 3. `2a7c51c0` — `repair-type-field.ts` + `types-enum.ts` (additive)
- **Files:** `src/commands/repair-type-field.ts` (+199, NEW), `src/core/types-enum.ts` (+45, NEW).
- **What it does:** maintenance CLI to fix pages with bad `type:` frontmatter values, backed by a canonical enum of allowed types.
- **Why it exists:** our brain accumulated junk type values; needed one-shot repair.
- **Triage: MOVE TO `scripts/`.** This is a maintenance tool, not a feature. Other gbrain operators won't hit our specific type-value drift. Keeping it under `src/commands/` means upstream renames will conflict every upgrade.
- **Action:** `git mv src/commands/repair-type-field.ts scripts/repair-type-field.ts`; same for `types-enum.ts` if it's only referenced by repair-type-field. Verify nothing else imports it. Update the launchd plist (`com.gbrain.repair-type-field-canary`) if it references the old path.
- **Owner:** Anoop
- **Status:** not yet moved

---

## Patches in extension points (never conflict — leave alone)

These touch only `skills/`, `recipes/`, `evals/`, `docs/`, `scripts/`. Upstream additions in these dirs are additive too, so they rebase cleanly. No action required.

| SHA | Path(s) | Purpose |
|---|---|---|
| `4e8b1bef` | `scripts/upgrade.sh`, `.gitignore` | Automated upgrade pipeline (2026-05-23) |
| `17ef649d` | `recipes/brief-to-brain.md` | Call-brief ingest recipe |
| `bea89336` | `skills/call-brief-generator/`, `skills/post-call-processor/` | Locked-schema brief skills |
| `c7cea7bc` | `skills/RESOLVER.md` | Resolver registration for above |
| `3c18593d` | same skills | Garry-convention rewrite |
| `1df122d8` | `skills/call-brief-generator/SKILL.md` | gap_feedback loop |
| `4e5244e1` | `skills/post-call-processor/SKILL.md` | Phase 2 speaker disambiguation |
| `db89117c` | `evals/extractors/*.json`, `recipes/*-to-brain.md`, `scripts/brain-compiler.ts`, etc. | Bulk eval + recipe additions |
| `a0976aae` | `docs/architecture/hermes-harness.md`, `evals/recall-quality.jsonl`, `evals/skill-resolution.jsonl` | Phase-2 design + eval suites |
| `8380a432` | `evals/recall-quality.jsonl` | 12 slug fills |

---

## Patches dropped during 2026-05-23 upgrade (lessons)

These were on the old `safety/pre-upgrade-2026-05-16` branch as "carry-along" patches. The v0.40 rebase showed upstream had either superseded them or the patch was no longer needed:

- `disk_pressure` doctor check w/ backfill-pause at <5Gi free — upstream's `remediation` system supersedes the simple `actions[]` pattern.
- `actions[]` field on `Check` type — upstream has structured `RemediationStep[]` (richer).
- `markdown.ts` quote-strip fix — upstream rewrote frontmatter handling; verify if the YAML re-quote bug recurs before re-patching.
- The original `--no-recurse-submodules` patch on `git-remote.ts` — upstream now splits global vs subcommand flag positions correctly.
- The original `safety-snapshot-of-uncommitted` commit pattern — useless after rebase; just commit work as you go.

**Lesson:** the conflict cost of every src/ patch compounds. Of the 8 unpushed local commits coming into the upgrade, **3 were already obsolete** because upstream solved the same problem differently. Audit before assuming a patch needs to be re-applied.

---

## Rules for future patches

1. **Default to extension points.** Before touching `src/`, ask: can this be a skill (`skills/`), a recipe (`recipes/`), an integration (`~/.gbrain/integrations/`), or a one-shot script (`scripts/`)? 90% of the time, yes.

2. **If you must touch `src/`, file the upstream PR within 7 days.** Carrying core patches without upstreaming them is interest-bearing debt. By the next upgrade, half are obsolete and you paid the conflict cost for nothing.

3. **Don't commit scratch.** `*.mjs`, `*.bak`, `analyze_*.ts` debugging files in the repo root blocked the v0.40 rebase. `.gitignore` now catches them — keep it that way.

4. **One commit, one logical change.** "Safety snapshot of uncommitted patches" commits add nothing and become empty after rebase. If work isn't ready to commit cleanly, branch + stash instead.

5. **`scripts/upgrade.sh` is the canonical upgrade.** Don't hand-roll. If the script breaks, fix the script, not the workaround.
