/**
 * PC3 timeline backfill — ONE-SHOT (component C1 of
 * tasks/gbrain-weekly-meta-cognitive-cron). NOT a recurring cron.
 *
 * INTENT (corrected from spec): lift `timeline_coverage` off 0.396 (score 6/25).
 * As of gbrain v0.40.x that metric is ENTITY-SCOPED:
 *   timeline_coverage = (person|company pages with >=1 timeline_entry) / (person|company pages)
 * (see project_gbrain_brain_score_entity_scoped). Correspondence/* and meetings/*
 * pages are NOT entity pages, so writing entries onto THEM moves nothing. The
 * dated events therefore land on the PERSON/COMPANY entities those pages link to
 * — exactly the post-call-processor idiom (timeline entries live on entity pages,
 * not the meeting page). This both lifts coverage and enriches existing timelines.
 *
 * Pipeline: for each correspondence/* + meetings/* page (deleted_at IS NULL):
 *   1. regex-extract dated events from the body (LinkedIn/Gmail message heads;
 *      meeting Date header + inline ISO + natural-language month-day).
 *   2. resolve the person/company entities it links TO (links table).
 *   3. write each (date, summary) onto each linked entity's timeline.
 *
 * Idempotency: UNIQUE(page_id, date, summary) + ON CONFLICT DO NOTHING, AND we
 * skip any (entity, date) already carrying a `source LIKE 'timeline-backfill%'`
 * row. Re-run is a strict no-op.
 *
 * Guardrails (link-mine 2026-05-25 lesson): never write to junk-hub entities
 * (people/linkedin etc.) or to a single entity from absurdly many sources.
 *
 * Extraction is REGEX-ONLY (no Haiku/Ollama — one-shot). Ambiguous date strings
 * are counted + reported, not written.
 *
 * Throttle: cursor-paged batches + brief sleep to protect the 15-client session
 * pool (project_gbrain_session_pool_invariant). Single postgres.js client.
 */
import os from "os";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const cfg = require(os.homedir() + "/.gbrain/config.json");
const pgMod = require("postgres");
const postgres = typeof pgMod === "function" ? pgMod : pgMod.default;

const SOURCE_ID = "default";
const TODAY = new Date().toISOString().slice(0, 10);
const SOURCE_TAG = `timeline-backfill ${TODAY}`;
const SOURCE_PREFIX = "timeline-backfill";

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = 100;
const SLEEP_MS = 250;
const MAX_DATES_PER_SOURCE = 25; // cap distinct dates per source page
const MAX_ENTITIES_PER_SOURCE = 12; // don't fan one thread across a huge cc list

/** Junk-hub / non-entity slugs we must never write to (link-mine lesson). */
const SLUG_DENYLIST = new Set([
  "people/linkedin", "people/gmail", "people/unknown", "people/me",
  "people/anoop-kansupada", // self: every thread links to Anoop; would dominate + uninformative
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Extracted { date: string; summary: string; }

// --- date helpers -----------------------------------------------------------
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9,
  oct: 10, nov: 11, dec: 12, january: 1, february: 2, march: 3, april: 4,
  june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (y < 1990 || y > 2100) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() + 1 !== m || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function clip(s: string, n = 160): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// --- extractors -------------------------------------------------------------
const MSG_HEAD = /\*\*(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?(?:\s*UTC)?\*\*\s*([←→↔<>]?)/g;

function extractCorrespondence(body: string, threadTitle: string): { entries: Extracted[]; ambiguous: number } {
  const lines = body.split("\n");
  type Head = { idx: number; date: string; dir: string };
  const heads: Head[] = [];
  for (let i = 0; i < lines.length; i++) {
    MSG_HEAD.lastIndex = 0;
    const m = MSG_HEAD.exec(lines[i]);
    if (m && m.index === lines[i].search(/\*\*\d{4}-\d{2}-\d{2}/)) {
      const date = iso(+m[1].slice(0, 4), +m[1].slice(5, 7), +m[1].slice(8, 10));
      let dir = m[2] || "";
      if (!dir) {
        const tail = lines[i].slice(m.index + m[0].length);
        if (/→/.test(tail)) dir = "→"; else if (/←/.test(tail)) dir = "←";
      }
      if (date) heads.push({ idx: i, date, dir });
    }
  }
  const byDate = new Map<string, Extracted>();
  for (let h = 0; h < heads.length; h++) {
    const { idx, date, dir } = heads[h];
    if (byDate.has(date)) continue;
    const end = h + 1 < heads.length ? heads[h + 1].idx : lines.length;
    let msg = "";
    const headLine = lines[idx];
    MSG_HEAD.lastIndex = 0;
    const hm = MSG_HEAD.exec(headLine);
    if (hm) {
      const tail = headLine.slice(hm.index + hm[0].length).replace(/^[→←↔<>\s]+/, "").trim();
      if (tail && !/^\[Open in/i.test(tail)) msg = tail;
    }
    if (!msg) {
      for (let j = idx + 1; j < end; j++) {
        const t = lines[j].trim();
        if (t && !/^\[Open in/i.test(t) && !/^https?:\/\//.test(t)) { msg = t; break; }
      }
    }
    const arrow = dir === "←" ? "received" : dir === "→" ? "sent" : "message in";
    const summary = clip(`${arrow}: ${msg || threadTitle || "(no text)"}`);
    byDate.set(date, { date, summary });
  }
  let entries = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (entries.length > MAX_DATES_PER_SOURCE) {
    const keep = new Set<number>([0, entries.length - 1]);
    const step = entries.length / MAX_DATES_PER_SOURCE;
    for (let k = 1; k < MAX_DATES_PER_SOURCE - 1; k++) keep.add(Math.floor(k * step));
    entries = entries.filter((_, i) => keep.has(i));
  }
  return { entries, ambiguous: 0 };
}

const ISO_BARE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const MONTH_DD = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/g;

function extractMeeting(body: string, title: string): { entries: Extracted[]; ambiguous: number } {
  const byDate = new Map<string, Extracted>();
  let ambiguous = 0;
  let anchorYear: number | null = null;
  const dh = body.match(/\*\*Date:\*\*\s*(\d{4})-(\d{2})-(\d{2})/);
  if (dh) {
    const d = iso(+dh[1], +dh[2], +dh[3]);
    if (d) { byDate.set(d, { date: d, summary: clip(`meeting: ${title || "call"}`) }); anchorYear = +dh[1]; }
  }
  const lines = body.split("\n");
  for (const line of lines) {
    ISO_BARE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ISO_BARE.exec(line))) {
      const d = iso(+m[1], +m[2], +m[3]);
      if (d && !byDate.has(d)) {
        byDate.set(d, { date: d, summary: clip(line.replace(/[#*>\-]/g, " ").trim()) || "dated note" });
        if (anchorYear == null) anchorYear = +m[1];
      }
    }
  }
  for (const line of lines) {
    MONTH_DD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MONTH_DD.exec(line))) {
      const mon = MONTHS[m[1].toLowerCase()];
      if (!mon) continue;
      const yr = m[3] ? +m[3] : anchorYear;
      if (yr == null) { ambiguous++; continue; }
      const d = iso(yr, mon, +m[2]);
      if (!d || byDate.has(d)) continue;
      byDate.set(d, { date: d, summary: clip(line.replace(/[#*>\-]/g, " ").trim()) || "dated event" });
    }
  }
  let entries = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (entries.length > MAX_DATES_PER_SOURCE) entries = entries.slice(0, MAX_DATES_PER_SOURCE);
  return { entries, ambiguous };
}

function titleOf(body: string): string {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].replace(/[*_`]/g, "").trim() : "";
}
function extract(slug: string, body: string) {
  if (!body) return { entries: [], ambiguous: 0 };
  const title = titleOf(body);
  if (slug.startsWith("correspondence/")) return extractCorrespondence(body, title);
  return extractMeeting(body, title);
}

// --- main --------------------------------------------------------------------
async function main() {
  const sql = postgres(cfg.database_url, { max: 2 });
  const stats = {
    sourcePagesScanned: 0,
    sourcePagesWithDates: 0,
    sourcePagesWithLinkedEntities: 0,
    distinctEntitiesTouched: 0,
    entitiesNewlyCovered: 0, // entities that had 0 timeline before and get >=1 now
    candidateRows: 0,
    written: 0,
    skippedExistingBackfill: 0,
    skippedDenylist: 0,
    ambiguous: 0,
  };
  const touched = new Set<number>();
  const newlyCovered = new Set<number>();
  const samples: { entity: string; date: string; summary: string; from: string }[] = [];

  try {
    let lastId = 0;
    for (;;) {
      const pages = await sql<{ id: number; slug: string; body: string }[]>`
        SELECT id, slug, compiled_truth AS body
        FROM pages
        WHERE deleted_at IS NULL AND source_id = ${SOURCE_ID}
          AND (slug LIKE 'correspondence/%' OR slug LIKE 'meetings/%')
          AND id > ${lastId}
        ORDER BY id ASC LIMIT ${BATCH_SIZE}`;
      if (pages.length === 0) break;
      lastId = pages[pages.length - 1].id;

      for (const p of pages) {
        stats.sourcePagesScanned++;
        const { entries, ambiguous } = extract(p.slug, p.body || "");
        stats.ambiguous += ambiguous;
        if (entries.length === 0) continue;
        stats.sourcePagesWithDates++;

        // entities this source links TO (person/company, not denylisted)
        const ents = await sql<{ id: number; slug: string; has_tl: boolean }[]>`
          SELECT e.id, e.slug,
                 EXISTS (SELECT 1 FROM timeline_entries te WHERE te.page_id = e.id) AS has_tl
          FROM links l
          JOIN pages e ON e.id = l.to_page_id
          WHERE l.from_page_id = ${p.id}
            AND e.type IN ('person','company') AND e.deleted_at IS NULL
          ORDER BY e.id`;
        const targets = ents.filter((e) => !SLUG_DENYLIST.has(e.slug)).slice(0, MAX_ENTITIES_PER_SOURCE);
        stats.skippedDenylist += ents.length - ents.filter((e) => !SLUG_DENYLIST.has(e.slug)).length;
        if (targets.length === 0) continue;
        stats.sourcePagesWithLinkedEntities++;

        for (const e of targets) {
          touched.add(e.id);
          // existing backfill dates on this entity (idempotency)
          const existing = await sql<{ date: string }[]>`
            SELECT to_char(date,'YYYY-MM-DD') AS date FROM timeline_entries
            WHERE page_id = ${e.id} AND source LIKE ${SOURCE_PREFIX + "%"}`;
          const have = new Set(existing.map((x) => x.date));
          const toWrite = entries.filter((en) => !have.has(en.date));
          stats.candidateRows += entries.length;
          stats.skippedExistingBackfill += entries.length - toWrite.length;
          if (!e.has_tl && toWrite.length) newlyCovered.add(e.id);

          if (samples.length < 10 && toWrite.length) {
            samples.push({ entity: e.slug, date: toWrite[0].date, summary: toWrite[0].summary, from: p.slug });
          }
          if (!DRY_RUN && toWrite.length) {
            for (const en of toWrite) {
              const res = await sql`
                INSERT INTO timeline_entries (page_id, date, source, summary, detail)
                VALUES (${e.id}, ${en.date}::date, ${SOURCE_TAG}, ${en.summary}, ${""})
                ON CONFLICT (page_id, date, summary) DO NOTHING
                RETURNING 1`;
              stats.written += res.length;
            }
          }
        }
      }
      await sleep(SLEEP_MS);
    }
    stats.distinctEntitiesTouched = touched.size;
    stats.entitiesNewlyCovered = newlyCovered.size;
  } finally {
    await sql.end();
  }

  console.log("=== TIMELINE BACKFILL " + (DRY_RUN ? "(DRY-RUN)" : "(WRITE)") + " === source=" + SOURCE_TAG);
  console.log(JSON.stringify(stats, null, 2));
  console.log("SAMPLES (entity | date | summary | from-source):");
  for (const s of samples) console.log(`  ${s.entity} | ${s.date} | ${s.summary}  [${s.from}]`);
}

main().catch((e) => { console.error(e); process.exit(1); });
