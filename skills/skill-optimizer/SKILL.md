---
name: skill-optimizer
version: 0.1.0
description: Run the SkillOpt loop (gbrain eval cross-modal) against an EXISTING SKILL.md to iteratively improve it, then re-lock tests. Gradient-descent for skills you already shipped.
triggers:
  - "optimize this skill"
  - "skillopt"
  - "improve this SKILL.md"
  - "tune this skill"
  - "re-eval this skill"
---

# skill-optimizer

Run the SkillOpt loop against a SKILL.md you ALREADY shipped. `gbrain skillify`
evals a skill once, at creation. Nothing re-runs the gate as the skill ages,
the model generation bumps, or the surrounding skills drift. This skill closes
that gap: point the same 3-model cross-modal eval at an existing skill and
iterate it toward a higher score, then re-lock the improved behavior in tests.

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md) for the lookup chain (search → query → get_page → external).

## The rule

**Never hand-edit a SKILL.md "to make it better" and ship it on your own
judgment.** Your judgment is one model. Run the gate (3 frontier models, 3
providers) before AND after every edit and keep only the edits that move a
dimension mean up without dropping any dimension below the floor. An edit that
feels better but doesn't move the score is reverted.

## Contract

Given a target `skills/<slug>/SKILL.md`, this skill guarantees:
- A baseline cross-modal eval receipt is captured BEFORE any edit.
- Each edit cycle re-runs the same 3 models on the same 5 dimensions.
- Only score-improving edits survive; the final SKILL.md scores >= its baseline
  on every dimension.
- The final tests (unit + routing) are regenerated to lock the improved body.
- No write happens to a skill whose baseline already passes unless the user
  explicitly asks to push it higher.

## Phases

### Phase 1: Pick the target + baseline
Resolve the target SKILL.md (user names it, or pick the lowest-scoring skill
from the last audit). Run the gate once to record the baseline:

```bash
gbrain eval cross-modal \
  --task "<one line: what this skill must accomplish>" \
  --output skills/<slug>/SKILL.md
```

Record the per-dimension means + the receipt sha.

### Phase 2: Edit against the weakest dimension
Apply the top improvements the eval surfaced for the weakest dimension only.
One dimension per cycle keeps the diff attributable.

### Phase 3: Re-eval (the gradient step)
Re-run the SAME command. Compare per-dimension deltas against the baseline.
Keep the edit if every dimension is >= baseline AND the target dimension rose.
Otherwise revert and try the next improvement.

### Phase 4: Stop condition
Stop when either every dimension mean >= 7 AND no model scored any dimension
< 5 (pass), or after 3 cycles (ship with a KNOWN_GAPS note listing the
dimensions still below 7 and why). Cost: <= 9 frontier calls per cycle.

### Phase 5: Re-lock tests
Regenerate the unit + routing tests so they assert the improved behavior, then
`gbrain check-resolvable` to confirm no MECE/DRY regressions were introduced.

## Output Format

1. A before/after per-dimension score table (baseline vs final).
2. The improved `skills/<slug>/SKILL.md` (only if it beat baseline).
3. The new cross-modal eval receipt sha.
4. A one-line verdict: `improved <slug>: <dim> X.X -> Y.Y` or `no improvement, reverted`.

## Anti-Patterns

- Editing without a baseline eval (you can't prove improvement).
- Optimizing a passing skill that nobody flagged (cost with no signal).
- Accepting an edit that raises one dimension and drops another.
- Running the gate on a SKILL.md under 200 tokens (not worth 9 API calls).
- Locking tests before the eval passes (cements mediocrity — the skillify rule).
