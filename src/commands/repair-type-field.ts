/**
 * `gbrain repair-type-field` — repair recursively-quoted `pages.type` values
 * left over from the matter.stringify double-encode bug (PR #_serializer wave_).
 *
 * Background: a bug in markdown frontmatter serialization caused every put_page
 * round-trip to wrap `type` in another layer of quotes (`"deal"` → `"'\"deal\"'"`
 * → ... etc). On a live brain we observed nesting from 1x up through 31x quote
 * layers across ~10K pages. The write-path fix lives in the serializer; this
 * command normalizes the data already on disk.
 *
 * Strategy: SELECT slug, type FROM pages WHERE type matches any quote char,
 * strip leading/trailing apostrophes + double-quotes iteratively until no
 * further change. If the result matches a TYPE_ENUM member, UPDATE the row.
 * If not (the stripping doesn't resolve to a known enum, or strips to empty),
 * INSERT into pages_quarantine_malformed_type and leave the original row
 * unchanged — a human decides. Idempotent: second `--apply` is a no-op.
 *
 * Slug-stability: only `type` is corrupted on the affected rows; slugs are
 * intact. Chunks / links / takes / page_versions all key off slug, so the
 * UPDATE is FK-safe by construction. No CASCADE concerns.
 */

import type { BrainEngine } from '../core/engine.ts';
import * as db from '../core/db.ts';
import { loadConfig, toEngineConfig } from '../core/config.ts';
import { TYPE_ENUM } from '../core/types-enum.ts';

const QUOTE_STRIP_RE = /^['"]+(.*?)['"]+$/;

export interface RepairTypeRow {
  slug: string;
  source_id: string;
  original_type: string;
  normalized: string;
  action: 'normalize' | 'quarantine';
}

/**
 * Iteratively strip leading/trailing quote chars until the result is stable.
 * Returns the fully-unwrapped string (may be empty if input was all quotes).
 */
export function normalizeQuoteNesting(input: string): string {
  let cur = input;
  for (let i = 0; i < 64; i++) {
    const m = cur.match(QUOTE_STRIP_RE);
    if (!m) break;
    const next = m[1] ?? '';
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

export function classifyTypeValue(original: string): RepairTypeRow['action'] | 'clean' {
  const normalized = normalizeQuoteNesting(original);
  if (normalized === original && TYPE_ENUM.has(normalized)) return 'clean';
  if (TYPE_ENUM.has(normalized)) return 'normalize';
  return 'quarantine';
}

export interface RepairTypeFieldOpts {
  dryRun: boolean;
  json: boolean;
}

export interface RepairTypeFieldResult {
  engine: 'postgres' | 'pglite';
  rows_scanned: number;
  rows_repaired: number;
  rows_quarantined: number;
  rows_already_clean: number;
  preview?: RepairTypeRow[];
}

export async function repairTypeField(opts: RepairTypeFieldOpts): Promise<RepairTypeFieldResult> {
  const config = loadConfig();
  if (!config) throw new Error('No brain configured. Run: gbrain init');
  const engineCfg = toEngineConfig(config);
  await db.connect(engineCfg);

  // The repair command targets the *configured* engine — same shape on both
  // Postgres and PGLite. The matching regex character class catches anything
  // that has a quote-char anywhere in `type`, including embedded ones.
  // We post-filter in JS so the regex stays simple and engine-portable.
  const engineKind: 'postgres' | 'pglite' = engineCfg.engine === 'pglite' ? 'pglite' : 'postgres';
  const sql = db.getConnection();

  const candidates = await sql.unsafe<Array<{ slug: string; source_id: string; type: string }>>(
    `SELECT slug, source_id, type FROM pages WHERE type ~ E'[\\'\"]'`
  );

  const result: RepairTypeFieldResult = {
    engine: engineKind,
    rows_scanned: candidates.length,
    rows_repaired: 0,
    rows_quarantined: 0,
    rows_already_clean: 0,
    preview: opts.dryRun ? [] : undefined,
  };

  if (candidates.length === 0) return result;

  const toNormalize: RepairTypeRow[] = [];
  const toQuarantine: RepairTypeRow[] = [];

  for (const row of candidates) {
    const action = classifyTypeValue(row.type);
    if (action === 'clean') {
      result.rows_already_clean++;
      continue;
    }
    const normalized = normalizeQuoteNesting(row.type);
    const entry: RepairTypeRow = {
      slug: row.slug,
      source_id: row.source_id,
      original_type: row.type,
      normalized,
      action,
    };
    if (action === 'normalize') toNormalize.push(entry);
    else toQuarantine.push(entry);
  }

  result.rows_repaired = toNormalize.length;
  result.rows_quarantined = toQuarantine.length;

  if (opts.dryRun) {
    result.preview = [...toNormalize, ...toQuarantine];
    return result;
  }

  // Apply path. The quarantine INSERT must be idempotent — a second
  // --apply over the same corrupted rows must not duplicate.
  // pages_quarantine_malformed_type is created by migration v81 (created by
  // the migration teammate; see schema in this file's call-site notes).
  for (const row of toNormalize) {
    await sql.unsafe(
      `UPDATE pages SET type = $1 WHERE slug = $2 AND source_id = $3`,
      [row.normalized, row.slug, row.source_id]
    );
  }

  for (const row of toQuarantine) {
    await sql.unsafe(
      `INSERT INTO pages_quarantine_malformed_type
         (slug, source_id, original_type, normalized_candidate, quarantined_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT DO NOTHING`,
      [row.slug, row.source_id, row.original_type, row.normalized || null]
    );
  }

  return result;
}

export async function runRepairTypeFieldCli(args: string[]): Promise<void> {
  const dryRun = !args.includes('--apply');
  const json = args.includes('--json');

  const result = await repairTypeField({ dryRun, json });

  if (json) {
    console.log(JSON.stringify({ status: 'ok', dry_run: dryRun, ...result }, null, 2));
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] Engine: ${result.engine}`);
    console.log(`[dry-run] Scanned ${result.rows_scanned} rows with quote-char in type.`);
    console.log(`[dry-run] Would normalize: ${result.rows_repaired}`);
    console.log(`[dry-run] Would quarantine: ${result.rows_quarantined}`);
    console.log(`[dry-run] Already clean (no-op): ${result.rows_already_clean}`);
    if (result.preview && result.preview.length > 0) {
      console.log('');
      console.log('slug,source_id,original_type,proposed_type,action');
      const limit = Math.min(result.preview.length, 50);
      for (let i = 0; i < limit; i++) {
        const r = result.preview[i]!;
        // CSV: quote anything containing comma/quote/newline.
        const csv = (s: string) => /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        console.log(`${csv(r.slug)},${csv(r.source_id)},${csv(r.original_type)},${csv(r.normalized)},${r.action}`);
      }
      if (result.preview.length > limit) {
        console.log(`... (${result.preview.length - limit} more rows, use --json for full output)`);
      }
    }
    console.log('');
    console.log('Run with --apply to execute. Re-running --apply is a no-op (idempotent).');
    return;
  }

  console.log(`Engine: ${result.engine}`);
  console.log(`Scanned ${result.rows_scanned} rows.`);
  console.log(`Normalized: ${result.rows_repaired}`);
  console.log(`Quarantined: ${result.rows_quarantined} (see pages_quarantine_malformed_type)`);
  if (result.rows_repaired === 0 && result.rows_quarantined === 0) {
    console.log('Nothing to repair.');
  }
}
