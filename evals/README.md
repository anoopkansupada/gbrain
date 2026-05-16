# gbrain Eval Suites

Two human-curated eval suites for gbrain quality regression testing. Both are JSONL so they grow line-by-line without merge conflicts.

## Files

- `skill-resolution-eval.jsonl` — 30 intents → expected skill routing (tests RESOLVER.md)
- `recall-quality-eval.jsonl` — 20 queries → expected page slugs (tests semantic search + ranking)

## Running

```bash
gbrain eval run evals/skill-resolution-eval.jsonl
gbrain eval run evals/recall-quality-eval.jsonl
```

Expected output: per-line pass/fail plus a summary block (top-1 accuracy, P@5, latency p50/p95).

## Baselines

| Suite | Metric | Target | Stretch |
|---|---|---|---|
| skill-resolution | top-1 accuracy (unambiguous only) | >85% | >95% |
| skill-resolution | top-3 accuracy (ambiguous set) | >80% | >90% |
| skill-resolution | fallback rate on edge cases | =100% (must route to FALLBACK_HUMAN) | — |
| recall-quality | P@5 (all `relevant` slugs appear in top 5) | >70% | >85% |
| recall-quality | MRR | >0.6 | >0.8 |

## Schema

### Skill resolution
```json
{"id": "<slug>", "intent": "<phrasing>", "expected_skill": "<kebab-case>", "ambiguous_with": ["<other>"], "notes": "<optional>"}
```
- `expected_skill` must match a skill folder name in `~/gbrain/skills/` or `FALLBACK_HUMAN`.
- `ambiguous_with` is informational — the runner uses it to relax to top-3 scoring.

### Recall quality
```json
{"id": "<slug>", "query": "<question>", "relevant": ["<slug>", ...], "TODO_FILL_IN": false, "category": "<person|company|meeting|deal|essay|architecture|recent|event>"}
```
- `TODO_FILL_IN: true` lines are skipped by the runner until Anoop fills in real slugs.
- `relevant` is unordered — runner checks set membership in top-K.

## Adding entries

1. Append a line to the JSONL file (don't rewrite existing lines).
2. Re-run the suite to confirm the new line scores as expected.
3. If a regression appears, file an issue tagged `eval-regression` before merging skill changes.

## Categories in recall suite

person (3), company (3), meeting (1), deal (1), essay (2), architecture (4), recent (4), event (1). Rebalance as new categories matter.

## TODO

Anoop must fill in 12 placeholder slugs in `recall-quality-eval.jsonl` (grep `TODO_FILL_IN`). Until then, recall suite runs at 8/20 = 40% coverage.
