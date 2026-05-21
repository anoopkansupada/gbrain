import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, LATEST_VERSION } from '../src/core/migrate.ts';

describe('migration v81 — pages.type CHECK constraint + quarantine table', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('v81 is registered in MIGRATIONS', () => {
    const v81 = MIGRATIONS.find(m => m.version === 81);
    expect(v81).toBeDefined();
    expect(v81!.name).toBe('pages_type_check_and_quarantine');
    expect(v81!.idempotent).toBe(true);
    expect(typeof v81!.handler).toBe('function');
  });

  test('LATEST_VERSION is >= 68', () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(68);
  });

  test('quarantine table exists with expected columns', async () => {
    const cols = await engine.executeRaw<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'pages_quarantine_malformed_type'
       ORDER BY ordinal_position`
    );
    const names = cols.map(c => c.column_name);
    expect(names).toEqual([
      'id',
      'slug',
      'source_id',
      'original_type',
      'normalized_candidate',
      'quarantined_at',
    ]);
  });

  test('quarantine slug index exists', async () => {
    const idx = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_quarantine_slug'`
    );
    expect(idx.length).toBe(1);
  });

  test('CHECK constraint rejects malformed type values', async () => {
    // 'default' source is seeded by initSchema; no need to insert.
// Malformed: triple-quoted recursive corruption.
    await expect(
      engine.executeRaw(
        `INSERT INTO pages (slug, type, title) VALUES ('test/bad', $1, 'bad')`,
        [`'''deal'''`]
      )
    ).rejects.toThrow();

    // Malformed: starts with digit.
    await expect(
      engine.executeRaw(
        `INSERT INTO pages (slug, type, title) VALUES ('test/bad2', '1deal', 'bad')`
      )
    ).rejects.toThrow();

    // Malformed: uppercase.
    await expect(
      engine.executeRaw(
        `INSERT INTO pages (slug, type, title) VALUES ('test/bad3', 'Deal', 'bad')`
      )
    ).rejects.toThrow();
  });

  test('CHECK constraint accepts well-formed type values', async () => {
    // All valid: lowercase letter prefix, then [a-z0-9_-]*
    for (const goodType of ['deal', 'person', 'company', 'analysis', 'page_kind', 'a-b-c', 'x1']) {
      await engine.executeRaw(
        `INSERT INTO pages (slug, type, title) VALUES ($1, $2, 'ok')
         ON CONFLICT DO NOTHING`,
        [`test/ok-${goodType}`, goodType]
      );
    }

    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM pages WHERE slug LIKE 'test/ok-%'`
    );
    expect(parseInt(rows[0].count, 10)).toBe(7);
  });

  test('pre-check guard refuses when corrupted rows exist', async () => {
    // Spin up a separate engine, drop the v81 constraint to simulate a
    // pre-v81 state with corrupted data, then re-run the v81 handler and
    // assert it throws with the documented unblock command.
    const eng = new PGLiteEngine();
    await eng.connect({});
    await eng.initSchema();

    // Drop the constraint so we can insert a malformed row.
    await eng.executeRaw(
      `ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_type_check`
    );
    // PGLite materializes inline column CHECK constraints under a generated
    // name; defensive belt-and-suspenders.
    await eng.executeRaw(
      `DO $$
       DECLARE c text;
       BEGIN
         FOR c IN
           SELECT conname FROM pg_constraint
           WHERE conrelid = 'pages'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%type%a-z0-9%'
         LOOP
           EXECUTE 'ALTER TABLE pages DROP CONSTRAINT ' || quote_ident(c);
         END LOOP;
       END $$;`
    );

    await eng.executeRaw(
      `INSERT INTO pages (slug, type, title) VALUES ('test/corrupt', $1, 'corrupt')`,
      [`'''deal'''`]
    );

    const v81 = MIGRATIONS.find(m => m.version === 81)!;
    await expect(v81.handler!(eng)).rejects.toThrow(/repair-type-field --apply/);

    await eng.disconnect();
  });

  test('handler is idempotent (re-run does not error)', async () => {
    const v81 = MIGRATIONS.find(m => m.version === 81)!;
    // Engine already has v81 applied (via initSchema → runMigrations).
    // Re-running the handler should not throw: pre-check passes (no malformed
    // rows since CHECK is already live), CREATE TABLE IF NOT EXISTS is a
    // no-op, and the DO-block constraint-add is gated on pg_constraint lookup.
    await expect(v81.handler!(engine)).resolves.toBeUndefined();
  });
});
