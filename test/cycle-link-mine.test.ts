/**
 * PC3 — dream-cycle `link_mine` phase tests.
 *
 * Pins:
 *   - edge_type picker: `cites` when body literally contains the target slug,
 *     else `related`
 *   - threshold filter: candidates below the cosine floor are dropped
 *   - exclusion filter: person / calendar-index target types rejected; pre-run
 *     hub pages rejected; self-links rejected
 *   - top-N-per-source: at most MAX_TARGETS_PER_SOURCE edges per source page
 *   - GARBAGE-ADJACENCY REGRESSION (the 2026-05-25 guard): 50 source pages all
 *     pointing at one near-duplicate target → that target accrues at most
 *     MAX_INBOUND_PER_PASS mined edges in a single pass, NOT 50
 *   - DB idempotency: double-firing the phase on the same page produces 0 dup
 *     edges (reconcile keys on (source,target))
 *   - DB exclusion end-to-end: person + calendar-index targets never receive a
 *     mined edge even when cosine-similar
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  runPhaseLinkMine,
  selectEdgesForPage,
  pickEdgeType,
  LINK_MINE_SOURCE,
  MAX_TARGETS_PER_SOURCE,
  MAX_INBOUND_PER_PASS,
  DEFAULT_COSINE_THRESHOLD,
  type MineCandidate,
} from '../src/core/cycle/phases/link-mine.ts';

// ─── Pure-function unit tests (no DB) ──────────────────────────────

describe('pickEdgeType', () => {
  test('returns cites when source body literally contains the target slug', () => {
    expect(pickEdgeType('see companies/acme for context', 'companies/acme')).toBe('cites');
  });
  test('returns related when the body does not name the target slug', () => {
    expect(pickEdgeType('a note about widgets', 'companies/acme')).toBe('related');
  });
  test('returns related for null/empty body', () => {
    expect(pickEdgeType(null, 'companies/acme')).toBe('related');
    expect(pickEdgeType('', 'companies/acme')).toBe('related');
  });
});

describe('selectEdgesForPage threshold + exclusion filters', () => {
  const emptyHub = new Set<string>();
  const cand = (to_slug: string, to_type: string, cosine: number): MineCandidate => ({ to_slug, to_type, cosine });

  test('drops candidates below the cosine threshold', () => {
    const edges = selectEdgesForPage('concept/src', null, [
      cand('concept/a', 'concept', 0.79),
      cand('concept/b', 'concept', 0.50),
    ], new Map(), { cosineThreshold: DEFAULT_COSINE_THRESHOLD, hubSet: emptyHub });
    expect(edges.map((e) => e.to_slug)).toEqual(['concept/a']);
  });

  test('rejects person and calendar-index target types', () => {
    const edges = selectEdgesForPage('concept/src', null, [
      cand('people/jane-doe', 'person', 0.95),
      cand('calendar/2026-05', 'calendar-index', 0.95),
      cand('concept/keeper', 'concept', 0.81),
    ], new Map(), { cosineThreshold: DEFAULT_COSINE_THRESHOLD, hubSet: emptyHub });
    expect(edges.map((e) => e.to_slug)).toEqual(['concept/keeper']);
  });

  test('rejects pre-run hub pages', () => {
    const hub = new Set(['concept/hub']);
    const edges = selectEdgesForPage('concept/src', null, [
      cand('concept/hub', 'concept', 0.99),
      cand('concept/ok', 'concept', 0.80),
    ], new Map(), { cosineThreshold: DEFAULT_COSINE_THRESHOLD, hubSet: hub });
    expect(edges.map((e) => e.to_slug)).toEqual(['concept/ok']);
  });

  test('rejects self-links', () => {
    const edges = selectEdgesForPage('concept/src', null, [
      cand('concept/src', 'concept', 0.99),
      cand('concept/other', 'concept', 0.85),
    ], new Map(), { cosineThreshold: DEFAULT_COSINE_THRESHOLD, hubSet: emptyHub });
    expect(edges.map((e) => e.to_slug)).toEqual(['concept/other']);
  });

  test('caps at MAX_TARGETS_PER_SOURCE, strongest cosine first', () => {
    const edges = selectEdgesForPage('concept/src', null, [
      cand('concept/a', 'concept', 0.90),
      cand('concept/b', 'concept', 0.95),
      cand('concept/c', 'concept', 0.85),
      cand('concept/d', 'concept', 0.99),
      cand('concept/e', 'concept', 0.88),
    ], new Map(), { cosineThreshold: DEFAULT_COSINE_THRESHOLD, hubSet: emptyHub });
    expect(edges.length).toBe(MAX_TARGETS_PER_SOURCE);
    expect(edges.map((e) => e.to_slug)).toEqual(['concept/d', 'concept/b', 'concept/a']);
  });

  test('dedupes duplicate target slugs within one source page', () => {
    const edges = selectEdgesForPage('concept/src', null, [
      cand('concept/a', 'concept', 0.90),
      cand('concept/a', 'concept', 0.95),
    ], new Map(), { cosineThreshold: DEFAULT_COSINE_THRESHOLD, hubSet: emptyHub });
    expect(edges.length).toBe(1);
    expect(edges[0].to_slug).toBe('concept/a');
  });
});

describe('GARBAGE-ADJACENCY regression (2026-05-25 hub-pollution guard)', () => {
  test('50 source pages near-duplicate of one target → target capped at MAX_INBOUND_PER_PASS', () => {
    const hubSet = new Set<string>();
    const inboundCount = new Map<string, number>();
    // Every one of 50 distinct source pages finds the SAME junk target at high
    // cosine — exactly the people/linkedin pattern. Without the in-pass inbound
    // cap this target would accrue 50 edges and become a new hub mid-pass.
    for (let i = 0; i < 50; i++) {
      selectEdgesForPage(
        `note/src-${i}`,
        null,
        [{ to_slug: 'concept/junk-hub', to_type: 'concept', cosine: 0.99 }],
        inboundCount,
        { cosineThreshold: DEFAULT_COSINE_THRESHOLD, hubSet },
      );
    }
    expect(inboundCount.get('concept/junk-hub')).toBe(MAX_INBOUND_PER_PASS);
    expect(inboundCount.get('concept/junk-hub')).toBeLessThanOrEqual(3);
  });
});

// ─── DB-backed integration tests (PGLite) ──────────────────────────

let engine: PGLiteEngine;

/**
 * Sparse unit-ish vector with chosen dimensions set. Sized to the engine's
 * active `embedding` column dim (resolved at runtime in beforeAll — it varies
 * by build default: 1280d zembed-1 vs 1536d OpenAI). The phase queries by
 * column NAME (`embedding`) so the dim is environment-local; only seeds need it.
 */
let embedDim = 1536;
function vec(dims: Record<number, number>): Float32Array {
  const v = new Float32Array(embedDim);
  for (const [k, val] of Object.entries(dims)) v[Number(k)] = val;
  return v;
}

async function seed(slug: string, type: string, embedding: Float32Array, body = `# ${slug}`): Promise<void> {
  await engine.putPage(slug, { type, title: slug.split('/').pop() ?? slug, compiled_truth: body });
  await engine.upsertChunks(slug, [
    { chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth', token_count: 3, embedding },
  ]);
}

async function minedEdgeCount(): Promise<number> {
  const r = await engine.executeRaw<{ n: number | string }>(
    `SELECT COUNT(*)::int AS n FROM links WHERE link_source = $1`,
    [LINK_MINE_SOURCE],
  );
  return Number(r[0]?.n ?? 0);
}

describe('runPhaseLinkMine DB integration', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    // Resolve the active embedding column dimension so seeds match the column.
    const ft = await engine.executeRaw<{ ft: string }>(
      `SELECT format_type(atttypid, atttypmod) AS ft
         FROM pg_attribute
        WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`,
    );
    const m = /vector\((\d+)\)/.exec(ft[0]?.ft ?? '');
    if (m) embedDim = Number(m[1]);
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await engine.executeRaw(`DELETE FROM links`);
    await engine.executeRaw(`DELETE FROM content_chunks`);
    await engine.executeRaw(`DELETE FROM pages`);
    await engine.unsetConfig('cycle.link_mine.cursor_page_id');
  });

  test('mines a related edge between two cosine-similar concept pages', async () => {
    await seed('concept/src', 'concept', vec({ 0: 1 }));
    await seed('concept/near', 'concept', vec({ 0: 0.99, 1: 0.14 }));
    await seed('concept/far', 'concept', vec({ 500: 1 }));

    const r = await runPhaseLinkMine(engine, { pagesPerMin: 0 });
    expect(r.status).toBe('ok');

    const edges = await engine.executeRaw<{ from_slug: string; to_slug: string; link_type: string }>(
      `SELECT pf.slug AS from_slug, pt.slug AS to_slug, l.link_type
         FROM links l
         JOIN pages pf ON pf.id = l.from_page_id
         JOIN pages pt ON pt.id = l.to_page_id
        WHERE l.link_source = $1 AND pf.slug = 'concept/src'`,
      [LINK_MINE_SOURCE],
    );
    const targets = edges.map((e) => e.to_slug);
    expect(targets).toContain('concept/near');
    expect(targets).not.toContain('concept/far'); // below threshold
  });

  test('emits cites when the source body names the target slug', async () => {
    await seed('concept/src', 'concept', vec({ 0: 1 }), 'this note references concept/near directly');
    await seed('concept/near', 'concept', vec({ 0: 0.99, 1: 0.14 }));

    await runPhaseLinkMine(engine, { pagesPerMin: 0 });
    const r = await engine.executeRaw<{ link_type: string }>(
      `SELECT l.link_type FROM links l
         JOIN pages pf ON pf.id = l.from_page_id
         JOIN pages pt ON pt.id = l.to_page_id
        WHERE l.link_source = $1 AND pf.slug='concept/src' AND pt.slug='concept/near'`,
      [LINK_MINE_SOURCE],
    );
    expect(r[0]?.link_type).toBe('cites');
  });

  test('idempotent: double-firing produces zero duplicate edges', async () => {
    await seed('concept/src', 'concept', vec({ 0: 1 }));
    await seed('concept/near', 'concept', vec({ 0: 0.99, 1: 0.14 }));

    await runPhaseLinkMine(engine, { pagesPerMin: 0 });
    const after1 = await minedEdgeCount();
    await runPhaseLinkMine(engine, { pagesPerMin: 0 });
    const after2 = await minedEdgeCount();

    expect(after1).toBeGreaterThan(0);
    expect(after2).toBe(after1);
  });

  test('never mines an edge TO a person or calendar-index target', async () => {
    await seed('concept/src', 'concept', vec({ 0: 1 }));
    await seed('people/jane-doe', 'person', vec({ 0: 0.99, 1: 0.14 }));
    await seed('calendar/2026-05', 'calendar-index', vec({ 0: 0.98, 1: 0.19 }));

    await runPhaseLinkMine(engine, { pagesPerMin: 0 });
    const r = await engine.executeRaw<{ to_type: string }>(
      `SELECT pt.type AS to_type FROM links l
         JOIN pages pt ON pt.id = l.to_page_id
        WHERE l.link_source = $1`,
      [LINK_MINE_SOURCE],
    );
    const types = r.map((x) => x.to_type);
    expect(types).not.toContain('person');
    expect(types).not.toContain('calendar-index');
  });

  test('dryRun writes nothing', async () => {
    await seed('concept/src', 'concept', vec({ 0: 1 }));
    await seed('concept/near', 'concept', vec({ 0: 0.99, 1: 0.14 }));

    const r = await runPhaseLinkMine(engine, { dryRun: true, pagesPerMin: 0 });
    expect(r.details.dryRun).toBe(true);
    expect(await minedEdgeCount()).toBe(0);
  });
});
