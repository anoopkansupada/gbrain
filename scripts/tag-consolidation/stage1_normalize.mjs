#!/usr/bin/env node
// PC3 tag consolidation — Stage 1: string-normalize clustering (cheap, ~0 cost).
//
// Pulls all distinct tags + page counts, normalizes (lowercase / strip punct /
// English singularization), clusters tags whose NORMALIZED forms are within
// Levenshtein <= 2, picks the highest-page-count member as canonical, and emits
// approval-gated checkbox proposals (capped at 20).
//
// NEVER applies. Output is markdown for the gbrain pending page + a JSON audit
// sidecar (captures before-state page_ids per merge for manual reversal).
//
// Usage: node stage1_normalize.mjs [--cap N]  (prints markdown to stdout, audit JSON to stderr-prefixed line)

import postgres from "postgres";
import { readFileSync } from "node:fs";
import os from "node:os";

const cfg = JSON.parse(readFileSync(os.homedir() + "/.gbrain/config.json", "utf8"));
const sql = postgres(cfg.database_url, { max: 2 });

const CAP = (() => {
  const i = process.argv.indexOf("--cap");
  return i > -1 ? parseInt(process.argv[i + 1], 10) : 20;
})();

// ---- normalization -------------------------------------------------------
function normalize(tag) {
  let t = tag.toLowerCase().trim();
  t = t.replace(/[_\s]+/g, "-");        // unify separators to hyphen
  t = t.replace(/[^a-z0-9-]/g, "");     // strip punctuation
  t = t.replace(/-+/g, "-").replace(/^-|-$/g, "");
  // English singularization heuristic, applied to the LAST hyphen-token only.
  const parts = t.split("-");
  parts[parts.length - 1] = singularize(parts[parts.length - 1]);
  return parts.join("-");
}
function singularize(w) {
  if (w.length <= 3) return w;                 // ais, vcs, etc — leave short
  if (/(ss|us|is)$/.test(w)) return w;         // business, status, analysis
  if (/ies$/.test(w)) return w.slice(0, -3) + "y";   // strategies -> strategy
  if (/(ches|shes|xes|ses|zes)$/.test(w)) return w.slice(0, -2); // matches -> match
  if (/s$/.test(w)) return w.slice(0, -1);     // projects -> project
  return w;
}

// ---- Levenshtein ---------------------------------------------------------
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3; // early-out: can't be <=2
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(
        dp[i] + 1,
        dp[i - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[m];
}

// ---- union-find ----------------------------------------------------------
class UF {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[ra] = rb; }
}

async function main() {
  const rows = await sql`SELECT tag, count(*)::int AS n FROM tags GROUP BY tag ORDER BY n DESC`;
  const tags = rows.map(r => ({ tag: r.tag, n: r.n, norm: normalize(r.tag) }));
  const N = tags.length;

  // CONSERVATIVE clustering. The cardinal sin is merging semantically-distinct
  // tags. Two guarded mechanisms ONLY — no transitive edit-distance chaining
  // (which collapses `bd`/`vc`/`nft`/`task`/`taste`/... into one blob):
  //
  //   (A) EXACT normalized-form match — `Crypto_Project` / `crypto-projects` /
  //       `crypto project` all normalize to `crypto-project`. Always safe.
  //   (B) GUARDED near-match — Levenshtein <= 1 on the FULL normalized string,
  //       BOTH strings length >= 6, AND identical first 3 chars. Catches a single
  //       typo (`opengradient`/`open-gradient` after norm) without reaching across
  //       distinct concepts. Edges only connect each tag to the CLUSTER ANCHOR
  //       (highest-count member of its exact-norm bucket), never tag-to-tag, so
  //       there is no chaining.
  const uf = new UF(N);
  const byNorm = new Map();
  tags.forEach((t, i) => {
    if (!byNorm.has(t.norm)) byNorm.set(t.norm, []);
    byNorm.get(t.norm).push(i);
  });
  // (A) exact-norm merges
  for (const idxs of byNorm.values()) {
    for (let k = 1; k < idxs.length; k++) uf.union(idxs[0], idxs[k]);
  }
  // (B) Mechanism B (guarded Levenshtein near-match) was REMOVED 2026-05-27.
  // Even with length>=6 + shared-prefix + edit<=1 guards it crossed concept
  // boundaries (contact/contract, blocker/blocked, person/persona) — the cardinal
  // sin. Exact-normalized-form grouping (A) is the only provably-safe string win;
  // genuinely fuzzy cases are deferred to Stage 2 embeddings, which are
  // approval-gated and reviewed by a human anyway. `lev()` retained for any future
  // diagnostic use.
  void lev;

  // collect clusters
  const clusters = new Map();
  for (let i = 0; i < N; i++) {
    const r = uf.find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(tags[i]);
  }

  const proposals = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
    const canonical = members[0];
    const olds = members.slice(1);
    const reduction = olds.reduce((s, m) => s + 1, 0);
    proposals.push({ canonical, olds, totalMembers: members.length, score: olds.length });
  }
  // Order: biggest cluster impact + highest page volume first.
  proposals.sort((a, b) =>
    (b.olds.length - a.olds.length) ||
    (b.canonical.n - a.canonical.n)
  );

  const capped = proposals.slice(0, CAP);

  // ---- markdown ----------------------------------------------------------
  const date = new Date().toISOString().slice(0, 10);
  let md = `## Stage 1 (string-normalize, exact-normalized-form) — ${date}\n\n`;
  md += `> ${proposals.length} candidate clusters found across ${N} distinct tags. Showing top ${capped.length} (cap). Check a box to approve; leave unchecked + add \`decline: <reason>\` to reject.\n\n`;
  for (const p of capped) {
    const oldStr = p.olds.map(o => `\`${o.tag}\` (${o.n})`).join(" + ");
    md += `- [ ] merge ${oldStr} → \`${p.canonical.tag}\` (${p.canonical.n})\n`;
  }

  // ---- audit sidecar (page_ids captured at proposal time, for reversal) ---
  const audit = [];
  for (const p of capped) {
    const olds = p.olds.map(o => o.tag);
    const affected = await sql`SELECT page_id, tag FROM tags WHERE tag IN ${sql(olds)}`;
    audit.push({
      canonical: p.canonical.tag,
      canonical_n: p.canonical.n,
      olds: p.olds.map(o => ({ tag: o.tag, n: o.n })),
      affected_page_ids: affected.map(a => ({ page_id: a.page_id, tag: a.tag })),
    });
  }

  process.stdout.write(md);
  process.stderr.write("AUDIT_JSON:" + JSON.stringify({
    stage: 1, date, distinct_tags: N, total_clusters: proposals.length,
    proposed: capped.length, proposed_tags: capped.flatMap(p => p.olds.map(o => o.tag)),
    audit
  }));
  await sql.end();
}
main().catch(e => { console.error("FATAL:" + e.stack); process.exit(1); });
