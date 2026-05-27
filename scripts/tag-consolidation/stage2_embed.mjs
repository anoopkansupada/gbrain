#!/usr/bin/env node
// PC3 tag consolidation — Stage 2: embed residual tags via Ollama nomic-embed-text.
//
// Operates on distinct tags MINUS those already proposed in Stage 1 (passed via
// --exclude-file, a JSON array of tag strings). Embeds each residual tag name
// through the local Ollama HTTP API (free), then runs single-link agglomerative
// clustering at cosine >= THRESHOLD. Highest-page-count member = canonical.
//
// NEVER applies. Emits checkbox markdown + audit JSON, capped at 20.
//
// Usage: node stage2_embed.mjs --exclude-file /path/stage1-tags.json [--threshold 0.82] [--cap 20]

import postgres from "postgres";
import { readFileSync } from "node:fs";
import os from "node:os";

const cfg = JSON.parse(readFileSync(os.homedir() + "/.gbrain/config.json", "utf8"));
const sql = postgres(cfg.database_url, { max: 2 });
const OLLAMA = "http://localhost:11434/api/embeddings";
const MODEL = "nomic-embed-text";

function argVal(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : dflt;
}
const THRESHOLD = parseFloat(argVal("--threshold", "0.82"));
const CAP = parseInt(argVal("--cap", "20"), 10);
const EXCLUDE_FILE = argVal("--exclude-file", null);

async function embed(text) {
  const res = await fetch(OLLAMA, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.embedding;
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
class UF {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[ra] = rb; }
}

// Machine-generated / non-semantic tag prefixes that must NEVER be clustered.
// `contacts-group:<hex>` & `contacts:group-<hex>` are Google Contacts group IDs
// (each a distinct group); embeddings see them as near-identical and chain them
// into a single 400+ blob. They are junk-noise, not concepts — drop from Stage 2.
const NON_SEMANTIC = /^(contacts-group:|contacts:group-|contacts:)/i;

async function main() {
  const exclude = EXCLUDE_FILE ? new Set(JSON.parse(readFileSync(EXCLUDE_FILE, "utf8"))) : new Set();
  const rows = await sql`SELECT tag, count(*)::int AS n FROM tags GROUP BY tag ORDER BY n DESC`;
  const dropped = rows.filter(r => NON_SEMANTIC.test(r.tag)).length;
  const tags = rows.map(r => ({ tag: r.tag, n: r.n }))
    .filter(t => !exclude.has(t.tag) && !NON_SEMANTIC.test(t.tag));
  const N = tags.length;
  process.stderr.write(`INFO: embedding ${N} residual tags (excluded ${exclude.size} stage-1, dropped ${dropped} non-semantic contacts-group ids)\n`);

  const vecs = [];
  for (let i = 0; i < N; i++) {
    vecs.push(await embed(tags[i].tag));
    if (i % 250 === 0) process.stderr.write(`INFO: embedded ${i}/${N}\n`);
  }

  // COMPLETE-LINK agglomerative clustering. Single-link (union-find over any
  // >=threshold pair) chains across an entire topic neighborhood — at 0.82 it
  // collapsed `hash-lemma`+`bd`+`strategy`+`investing` into one blob (the cardinal
  // sin). Complete-link only admits a tag to a cluster if it is >= THRESHOLD to
  // EVERY existing member, which prevents transitive topic-bridging. Greedy:
  // process tags by descending page-count (canonical-first), each new tag joins
  // the first existing cluster it is fully-linked to, else seeds its own.
  const order = tags.map((_, i) => i); // already sorted desc by n from SQL
  const clustersArr = []; // each: { members: [idx...] }
  for (const i of order) {
    let placed = false;
    for (const c of clustersArr) {
      if (c.members.every(m => cosine(vecs[i], vecs[m]) >= THRESHOLD)) {
        c.members.push(i); placed = true; break;
      }
    }
    if (!placed) clustersArr.push({ members: [i] });
  }
  const clusters = new Map();
  clustersArr.forEach((c, k) => clusters.set(k, c.members.map(m => tags[m])));

  const proposals = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
    proposals.push({ canonical: members[0], olds: members.slice(1) });
  }
  proposals.sort((a, b) => (b.olds.length - a.olds.length) || (b.canonical.n - a.canonical.n));
  const capped = proposals.slice(0, CAP);

  const date = new Date().toISOString().slice(0, 10);
  let md = `## Stage 2 (embed nomic-embed-text, cosine ≥ ${THRESHOLD}) — ${date}\n\n`;
  md += `> ${proposals.length} candidate clusters across ${N} residual distinct tags (Stage-1 proposals excluded). Showing top ${capped.length} (cap). **Review carefully — embedding clusters can group semantically-distinct tags (e.g. crypto-regulation vs crypto-trading).** Check a box to approve; leave unchecked + add \`decline: <reason>\` to reject.\n\n`;
  for (const p of capped) {
    const oldStr = p.olds.map(o => `\`${o.tag}\` (${o.n})`).join(" + ");
    md += `- [ ] merge ${oldStr} → \`${p.canonical.tag}\` (${p.canonical.n})\n`;
  }

  const audit = [];
  for (const p of capped) {
    const olds = p.olds.map(o => o.tag);
    const affected = await sql`SELECT page_id, tag FROM tags WHERE tag IN ${sql(olds)}`;
    audit.push({
      canonical: p.canonical.tag, canonical_n: p.canonical.n,
      olds: p.olds.map(o => ({ tag: o.tag, n: o.n })),
      affected_page_ids: affected.map(a => ({ page_id: a.page_id, tag: a.tag })),
    });
  }

  process.stdout.write(md);
  process.stderr.write("AUDIT_JSON:" + JSON.stringify({
    stage: 2, date, threshold: THRESHOLD, residual_tags: N,
    total_clusters: proposals.length, proposed: capped.length,
    proposed_tags: capped.flatMap(p => p.olds.map(o => o.tag)), audit
  }));
  await sql.end();
}
main().catch(e => { console.error("FATAL:" + e.stack); process.exit(1); });
