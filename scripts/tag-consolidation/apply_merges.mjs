#!/usr/bin/env node
// PC3 tag consolidation — APPLY merges (used by /process-tag-consolidation skill).
//
// Reads checked (`- [x]`) merge lines from a markdown file (the pending-page body
// exported from gbrain), and applies each as a constraint-safe, IDEMPOTENT SQL
// merge on the pooler database_url.
//
// Constraint-safe merge (tags has UNIQUE(page_id, tag)):
//   For each OLD tag -> CANONICAL:
//     1. DELETE old rows whose page already carries CANONICAL  (would collide)
//     2. UPDATE remaining old rows  SET tag = CANONICAL
//   Idempotent: if OLD no longer exists, the merge is a no-op (0 rows) and skipped.
//
// Modes:
//   --dry-run            parse + report what WOULD merge, touch nothing
//   --limit N            apply only the first N merges (spot-check; default all)
//   --rollback-test      run the FIRST checked merge inside a transaction and
//                        ROLL BACK — proves the SQL works without committing
//   (default)            apply for real, each merge in its own committed txn
//
// Usage: node apply_merges.mjs --file /path/pending.md [--dry-run|--rollback-test|--limit N]

import postgres from "postgres";
import { readFileSync } from "node:fs";
import os from "node:os";

const cfg = JSON.parse(readFileSync(os.homedir() + "/.gbrain/config.json", "utf8"));
const sql = postgres(cfg.database_url, { max: 2 });

function argVal(flag, dflt) { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : dflt; }
const FILE = argVal("--file", null);
const DRY = process.argv.includes("--dry-run");
const ROLLBACK_TEST = process.argv.includes("--rollback-test");
const LIMIT = parseInt(argVal("--limit", "0"), 10) || Infinity;

// Parse checked merge lines:  - [x] merge `a` (n) + `b` (m) → `canonical` (k)
function parseChecked(md) {
  const out = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\s*-\s*\[x\]\s*merge\s+(.+?)\s*(?:→|->)\s*`([^`]+)`/i);
    if (!m) continue;
    const olds = [...m[1].matchAll(/`([^`]+)`/g)].map(x => x[1]);
    const canonical = m[2];
    if (olds.length && canonical) out.push({ olds, canonical });
  }
  return out;
}

// One constraint-safe merge for a single (old -> canonical) inside a given sql/txn handle.
async function mergeOne(h, oldTag, canonical) {
  if (oldTag === canonical) return { skipped: "same", deleted: 0, updated: 0 };
  const exists = await h`SELECT 1 FROM tags WHERE tag = ${oldTag} LIMIT 1`;
  if (exists.length === 0) return { skipped: "absent", deleted: 0, updated: 0 };
  // 1. drop old rows whose page already has canonical (avoid UNIQUE collision)
  const del = await h`
    DELETE FROM tags t
    WHERE t.tag = ${oldTag}
      AND EXISTS (SELECT 1 FROM tags c WHERE c.page_id = t.page_id AND c.tag = ${canonical})`;
  // 2. rename remaining old rows to canonical
  const upd = await h`UPDATE tags SET tag = ${canonical} WHERE tag = ${oldTag}`;
  return { deleted: del.count, updated: upd.count };
}

async function main() {
  if (!FILE) { console.error("FATAL: --file required"); process.exit(1); }
  const merges = parseChecked(readFileSync(FILE, "utf8"));
  if (merges.length === 0) { console.log("No checked (- [x]) merges found. Nothing to do."); await sql.end(); return; }

  if (ROLLBACK_TEST) {
    const t = merges[0];
    console.log(`ROLLBACK-TEST on first checked merge: [${t.olds.join(", ")}] → ${t.canonical}`);
    const before = await sql`SELECT tag, count(*)::int n FROM tags WHERE tag IN ${sql([...t.olds, t.canonical])} GROUP BY tag`;
    console.log("BEFORE:", JSON.stringify(before));
    await sql.begin(async (h) => {
      let totDel = 0, totUpd = 0;
      for (const o of t.olds) { const r = await mergeOne(h, o, t.canonical); totDel += r.deleted || 0; totUpd += r.updated || 0; console.log(`  merge ${o}→${t.canonical}:`, JSON.stringify(r)); }
      const mid = await h`SELECT tag, count(*)::int n FROM tags WHERE tag IN ${h([...t.olds, t.canonical])} GROUP BY tag`;
      console.log("IN-TXN (uncommitted):", JSON.stringify(mid), `| deleted=${totDel} updated=${totUpd}`);
      throw new Error("__ROLLBACK__"); // force rollback
    }).catch(e => { if (e.message !== "__ROLLBACK__") throw e; });
    const after = await sql`SELECT tag, count(*)::int n FROM tags WHERE tag IN ${sql([...t.olds, t.canonical])} GROUP BY tag`;
    console.log("AFTER ROLLBACK (must equal BEFORE):", JSON.stringify(after));
    const ok = JSON.stringify(before.sort((a,b)=>a.tag.localeCompare(b.tag))) === JSON.stringify(after.sort((a,b)=>a.tag.localeCompare(b.tag)));
    console.log(ok ? "ROLLBACK VERIFIED: state unchanged ✅" : "ROLLBACK MISMATCH ❌");
    await sql.end();
    return;
  }

  let applied = 0;
  for (const m of merges) {
    if (applied >= LIMIT) break;
    if (DRY) {
      const cur = await sql`SELECT tag, count(*)::int n FROM tags WHERE tag IN ${sql(m.olds)} GROUP BY tag`;
      const present = cur.filter(r => r.n > 0).map(r => r.tag);
      console.log(`[DRY] merge [${present.join(", ") || "(all absent — no-op)"}] → ${m.canonical}`);
    } else {
      await sql.begin(async (h) => {
        for (const o of m.olds) { const r = await mergeOne(h, o, m.canonical); console.log(`merge ${o}→${m.canonical}:`, JSON.stringify(r)); }
      });
    }
    applied++;
  }
  console.log(`${DRY ? "DRY-RUN" : "APPLIED"}: ${applied} merge group(s)${LIMIT !== Infinity ? ` (limit ${LIMIT})` : ""}.`);
  await sql.end();
}
main().catch(e => { console.error("FATAL:" + e.stack); process.exit(1); });
