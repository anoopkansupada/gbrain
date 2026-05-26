/**
 * Dream-cycle `link_mine` phase: cosine-similarity edge mining (PC3).
 *
 * Symptom this fixes: the graph layer barely contributes to recall.
 * link_density_score sits at the floor (4-5/25) and median links/page is
 * ~0.9 because the only edges are explicit wikilinks + frontmatter
 * inference. Pages that are semantically about the same thing — a deal and
 * the company it concerns, two notes on one thesis — carry no edge unless a
 * human typed one. This phase mines `related` (pure cosine ≥ 0.78) and
 * `cites` (body literally names the target slug) edges so the graph reflects
 * semantic adjacency the importers never wrote.
 *
 * ⚠️ THE 2026-05-25 LESSON (read before touching the guardrails):
 * A `source: linkedin-export` value fuzzy-resolved to `people/linkedin`,
 * creating 7,651 garbage edges to ONE junk hub — it falsely de-orphaned ~7k
 * people and inflated brain_score 57→65. Low-threshold similarity edges
 * concentrating on a few hub pages is exactly how you re-pollute the graph
 * and Goodhart the metric. THREE stacked guardrails below are non-negotiable:
 *   (1) target-type exclusion: never link TO person / calendar-index pages;
 *   (2) hub exclusion: never link TO a page already in the top-0.5% by
 *       inbound degree (don't pile cosine edges onto existing hubs);
 *   (3) in-pass inbound cap: no single target accrues > MAX_INBOUND_PER_PASS
 *       mined edges in one phase run — this is the structural defense against
 *       a NEW hub forming in a single pass (which (2) cannot catch because it
 *       reads pre-run degree).
 *
 * Phase contract (mirrors infer-links):
 *   - status 'ok' on every successful run (including zero edges)
 *   - status 'fail' on DB/IO error with PhaseError populated
 *   - dryRun honored: counts + reports candidates, never writes
 *   - idempotent: re-running a page reconciles its cosine-mine edges to the
 *     current candidate set (insert ON CONFLICT DO NOTHING + delete-stale),
 *     so a v1→v2 edge_type re-classification is a no-dup reconcile, not an
 *     INSERT of a second (source,target) row.
 *   - soft-delete defensive: `deleted_at IS NULL` filter on every read
 *   - pool-friendly: cursor-paged window, throttled to ≤ pagesPerMin
 *
 * Edge provenance: every mined edge is stamped `link_source = 'cosine-mine'`
 * so it is auditable and bulk-reversible (the rollback path in the plan).
 *
 * NOT in scope (deferred to v2): `extends` / `contradicts` typed edges — they
 * need a non-noisy temporal signal (`updated_at` is noise). Person-target
 * de-orphaning is deliberately out (guardrail 1).
 */

import type { BrainEngine } from '../../engine.ts';
import type { PhaseResult } from '../../cycle.ts';

/** Provenance tag stamped on every mined edge. Rollback keys on this. */
export const LINK_MINE_SOURCE = 'cosine-mine';

/** Pure-cosine threshold. Raise to 0.82 if a dry-run shows >20% garbage. */
export const DEFAULT_COSINE_THRESHOLD = 0.78;

/** Top-K nearest chunks pulled per source chunk before dedupe-to-pages. */
export const DEFAULT_TOP_K = 10;

/** Max unique target pages a single source page may link to per run. */
export const MAX_TARGETS_PER_SOURCE = 3;

/**
 * Max mined edges any single target may RECEIVE in one phase run. The direct
 * structural defense against the 2026-05-25 hub-pollution pattern: even if 50
 * source pages are all near-duplicates of one page, that page gets at most
 * MAX_INBOUND_PER_PASS new mined edges. Guardrail (2) reads PRE-run degree and
 * cannot see a hub forming mid-pass; this cap can.
 */
export const MAX_INBOUND_PER_PASS = 3;

/** Config key for the cross-run page cursor (DB-backed kv via engine config). */
export const CURSOR_KEY = 'cycle.link_mine.cursor_page_id';

/**
 * Target page types we never mine edges TO. `person` because person-target
 * de-orphaning is out of scope and persons are the highest hub-collision risk
 * (the 2026-05-25 incident was a person hub). `calendar-index` because they are
 * system pages, not entities.
 */
export const EXCLUDED_TARGET_TYPES: ReadonlySet<string> = new Set([
  'person',
  'calendar-index',
]);

/**
 * Source page types we never mine edges FROM. Logs and auto-ingested noise are
 * not entities worth a semantic-adjacency edge, and mining from them would burn
 * the throttle budget on rows nobody traverses. (Targets are filtered
 * separately by EXCLUDED_TARGET_TYPES + the hub set.)
 */
export const EXCLUDED_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'person',
  'calendar-index',
  'correspondence',
  'telegram',
  'signal',
  'article-clipping',
  'reusable-component',
]);

export interface LinkMinePhaseOpts {
  dryRun?: boolean;
  /** In-phase keepalive callback. Awaited between batches. */
  yieldDuringPhase?: () => Promise<void>;
  /** Source pages scanned per phase invocation. Default 1000. */
  maxPagesPerRun?: number;
  /** Pages per progress/yield batch. Default 100. */
  batchSize?: number;
  /** Pure-cosine acceptance threshold. Default DEFAULT_COSINE_THRESHOLD. */
  cosineThreshold?: number;
  /** Top-K nearest chunks per source chunk. Default DEFAULT_TOP_K. */
  topK?: number;
  /** Throttle ceiling. Default 100. 0 = unlimited (tests / dry-run). */
  pagesPerMin?: number;
  /** Embedding column to query. Default 'embedding' (active OpenAI 1536 col). */
  embeddingColumn?: string;
}

/** One candidate target surfaced for a source page, with its max-chunk cosine. */
export interface MineCandidate {
  to_slug: string;
  to_type: string;
  cosine: number;
}

/** One edge selected for writing. */
export interface MinedEdge {
  to_slug: string;
  edge_type: 'related' | 'cites';
  cosine: number;
}

/**
 * Decide the edge type for a (source, target) pair. `cites` when the source
 * body literally contains the target slug (an explicit textual reference the
 * link-extractor missed), else `related` (pure semantic adjacency). Pure.
 */
export function pickEdgeType(sourceBody: string | null | undefined, targetSlug: string): 'related' | 'cites' {
  if (sourceBody && targetSlug && sourceBody.includes(targetSlug)) return 'cites';
  return 'related';
}

/**
 * The core selection logic, extracted for unit testing. Given a source page's
 * candidate targets, applies — in order — threshold, target-type exclusion, hub
 * exclusion, top-N-per-source, and the in-pass inbound cap. MUTATES
 * `inboundCount` (target slug → edges accrued so far this run) so the cap holds
 * across every source page in the pass. Returns the edges to write.
 *
 * This function is the 2026-05-25 regression guard: feed it 50 source pages all
 * pointing at one near-duplicate target and the inbound cap keeps that target at
 * MAX_INBOUND_PER_PASS, not 50.
 */
export function selectEdgesForPage(
  sourceSlug: string,
  sourceBody: string | null | undefined,
  candidates: MineCandidate[],
  inboundCount: Map<string, number>,
  opts: {
    cosineThreshold: number;
    hubSet: ReadonlySet<string>;
    maxTargets?: number;
    maxInboundPerPass?: number;
  },
): MinedEdge[] {
  const maxTargets = opts.maxTargets ?? MAX_TARGETS_PER_SOURCE;
  const maxInbound = opts.maxInboundPerPass ?? MAX_INBOUND_PER_PASS;

  // Threshold + exclusions, then strongest-first so the top-N and the inbound
  // cap both prefer the highest-confidence edges.
  const eligible = candidates
    .filter((c) => c.to_slug !== sourceSlug)
    .filter((c) => c.cosine >= opts.cosineThreshold)
    .filter((c) => !EXCLUDED_TARGET_TYPES.has(c.to_type))
    .filter((c) => !opts.hubSet.has(c.to_slug))
    .sort((a, b) => b.cosine - a.cosine);

  const edges: MinedEdge[] = [];
  const seen = new Set<string>();
  for (const c of eligible) {
    if (edges.length >= maxTargets) break;
    if (seen.has(c.to_slug)) continue; // dedupe to unique target pages
    const already = inboundCount.get(c.to_slug) ?? 0;
    if (already >= maxInbound) continue; // in-pass inbound cap (anti-hub)
    seen.add(c.to_slug);
    inboundCount.set(c.to_slug, already + 1);
    edges.push({ to_slug: c.to_slug, edge_type: pickEdgeType(sourceBody, c.to_slug), cosine: c.cosine });
  }
  return edges;
}

interface SourcePageRow {
  id: number;
  slug: string;
  type: string;
  compiled_truth: string | null;
}

/**
 * Compute the hub-exclusion set: pages in the top-0.5% by inbound (to_page_id)
 * degree in the ORGANIC graph. Crucially, edges this phase itself wrote
 * (link_source='cosine-mine') are EXCLUDED from the degree count — otherwise a
 * freshly-mined target would bootstrap itself into the hub set on the next run,
 * get excluded, and have its valid edges reconciled away (a non-idempotent
 * oscillation). Excluding cosine-mine keeps the hub set stable across runs.
 * Floor of 20 so a sparse graph still excludes a sensible head.
 */
async function computeHubSet(engine: BrainEngine): Promise<Set<string>> {
  const totalRows = await engine.executeRaw<{ n: number | string }>(
    `SELECT COUNT(*)::bigint AS n FROM pages WHERE deleted_at IS NULL`,
  );
  const total = Number(totalRows[0]?.n ?? 0);
  const topN = Math.max(20, Math.ceil(total * 0.005));
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT p.slug
       FROM links l
       JOIN pages p ON p.id = l.to_page_id AND p.deleted_at IS NULL
      WHERE l.link_source IS DISTINCT FROM '${LINK_MINE_SOURCE}'
      GROUP BY p.slug
      ORDER BY COUNT(*) DESC
      LIMIT ${topN}`,
  );
  return new Set(rows.map((r) => r.slug));
}

/**
 * For one source page, find candidate target pages by chunk-level cosine KNN.
 * Pure pgvector `<=>` (cosine distance) against the active embedding column —
 * NOT searchVector, whose score is boosted by source/recency/backlink factors
 * and would distort the 0.78 pure-cosine threshold. Same HNSW index + operator,
 * so this reuses the search infrastructure without re-ranking semantics.
 *
 * Per source chunk (bounded to 8 to cap cost) we pull the K nearest OTHER-page
 * chunks via the HNSW index, join to the target page, take the MAX cosine per
 * target. Type-exclusion and self-exclusion are pushed into SQL; threshold,
 * hub-exclusion, top-N and the inbound cap are applied in selectEdgesForPage.
 */
async function findCandidates(
  engine: BrainEngine,
  sourceSlug: string,
  topK: number,
  embeddingCol: string,
): Promise<MineCandidate[]> {
  // embeddingCol is from a fixed allowlist (validated by caller) — never user
  // input — so interpolating it into the identifier position is safe.
  const excludedTypes = [...EXCLUDED_TARGET_TYPES];
  const rows = await engine.executeRaw<{ to_slug: string; to_type: string; cosine: number | string }>(
    `WITH src AS (
        SELECT cc.${embeddingCol} AS emb
          FROM content_chunks cc
          JOIN pages p ON p.id = cc.page_id
         WHERE p.slug = $1 AND p.source_id = 'default' AND p.deleted_at IS NULL
           AND cc.${embeddingCol} IS NOT NULL
         LIMIT 8
     )
     SELECT p2.slug AS to_slug,
            p2.type AS to_type,
            MAX(1 - (nn.emb <=> src.emb)) AS cosine
       FROM src
       CROSS JOIN LATERAL (
         SELECT cc2.${embeddingCol} AS emb, cc2.page_id
           FROM content_chunks cc2
          WHERE cc2.${embeddingCol} IS NOT NULL
          ORDER BY cc2.${embeddingCol} <=> src.emb
          LIMIT $2
       ) nn
       JOIN pages p2 ON p2.id = nn.page_id AND p2.deleted_at IS NULL
      WHERE p2.slug <> $1
        AND p2.source_id = 'default'
        AND p2.type <> ALL($3::text[])
      GROUP BY p2.slug, p2.type
      ORDER BY cosine DESC
      LIMIT 50`,
    [sourceSlug, topK, excludedTypes],
  );
  return rows.map((r) => ({ to_slug: r.to_slug, to_type: r.to_type, cosine: Number(r.cosine) }));
}

/**
 * Reconcile one source page's cosine-mine edges to exactly `edges`:
 *   1. insert the current edges (ON CONFLICT DO NOTHING via addLinksBatch)
 *   2. delete any cosine-mine edge from this source whose (to, type) is not in
 *      the current set — clears stale edges (dropped below threshold, or
 *      edge_type flipped) so (source,target) never carries a duplicate.
 * Returns count of edges inserted (delta) — addLinksBatch returns rows added.
 */
async function reconcileSourceEdges(
  engine: BrainEngine,
  sourceSlug: string,
  edges: MinedEdge[],
): Promise<number> {
  let inserted = 0;
  if (edges.length > 0) {
    inserted = await engine.addLinksBatch(
      edges.map((e) => ({
        from_slug: sourceSlug,
        to_slug: e.to_slug,
        link_type: e.edge_type,
        link_source: LINK_MINE_SOURCE,
        context: `cosine ${e.cosine.toFixed(3)}`,
      })),
    );
  }

  // Delete stale cosine-mine edges for this source. Keep only the (to,type)
  // pairs in the current set. When edges is empty, all of this source's
  // cosine-mine edges are stale and removed.
  if (edges.length === 0) {
    await engine.executeRaw(
      `DELETE FROM links
        WHERE link_source = $2
          AND from_page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default' AND deleted_at IS NULL)`,
      [sourceSlug, LINK_MINE_SOURCE],
    );
  } else {
    const keepSlugs = edges.map((e) => e.to_slug);
    const keepTypes = edges.map((e) => e.edge_type);
    await engine.executeRaw(
      `DELETE FROM links l
        WHERE l.link_source = $2
          AND l.from_page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default' AND deleted_at IS NULL)
          AND NOT EXISTS (
            SELECT 1
              FROM unnest($3::text[], $4::text[]) AS keep(to_slug, link_type)
              JOIN pages tp ON tp.slug = keep.to_slug AND tp.source_id = 'default' AND tp.deleted_at IS NULL
             WHERE tp.id = l.to_page_id AND keep.link_type = l.link_type
          )`,
      [sourceSlug, LINK_MINE_SOURCE, keepSlugs, keepTypes],
    );
  }
  return inserted;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPhaseLinkMine(
  engine: BrainEngine,
  opts: LinkMinePhaseOpts = {},
): Promise<PhaseResult> {
  const dryRun = opts.dryRun === true;
  const maxPagesPerRun = opts.maxPagesPerRun ?? 1000;
  const batchSize = opts.batchSize ?? 100;
  const cosineThreshold = opts.cosineThreshold ?? DEFAULT_COSINE_THRESHOLD;
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const pagesPerMin = opts.pagesPerMin ?? 100;
  // Allowlist the embedding column — it lands in an identifier position.
  const ALLOWED_COLS = new Set(['embedding', 'embedding_voyage', 'embedding_openai']);
  const embeddingCol = ALLOWED_COLS.has(opts.embeddingColumn ?? '') ? opts.embeddingColumn! : 'embedding';
  const minMsPerPage = pagesPerMin > 0 && !dryRun ? Math.floor(60000 / pagesPerMin) : 0;

  let hubSet: Set<string>;
  let cursorStart = 0;
  try {
    hubSet = await computeHubSet(engine);
    const cur = await engine.getConfig(CURSOR_KEY);
    cursorStart = cur ? Number(cur) || 0 : 0;
  } catch (err) {
    return {
      phase: 'link_mine',
      status: 'fail',
      duration_ms: 0,
      summary: 'failed to initialize (hub set / cursor)',
      details: { error: err instanceof Error ? err.message : String(err) },
      error: {
        class: 'LinkMineInitFailed',
        code: 'link_mine_init_failed',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // Window of source pages by id ascending from the cursor. Excludes noise
  // source types; only pages with at least one active embedding are worth
  // scanning, but we DON'T filter that in SQL (it would force a join per row) —
  // findCandidates returns [] for embedding-less pages and the cursor still
  // advances past them.
  let pages: SourcePageRow[];
  try {
    const excludedSourceTypes = [...EXCLUDED_SOURCE_TYPES];
    pages = await engine.executeRaw<SourcePageRow>(
      `SELECT id, slug, type, compiled_truth
         FROM pages
        WHERE deleted_at IS NULL
          AND source_id = 'default'
          AND id > $1
          AND type <> ALL($2::text[])
        ORDER BY id ASC
        LIMIT ${maxPagesPerRun}`,
      [cursorStart, excludedSourceTypes],
    );
  } catch (err) {
    return {
      phase: 'link_mine',
      status: 'fail',
      duration_ms: 0,
      summary: 'failed to scan source pages',
      details: { error: err instanceof Error ? err.message : String(err) },
      error: {
        class: 'LinkMineScanFailed',
        code: 'link_mine_scan_failed',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const inboundCount = new Map<string, number>();
  let pagesScanned = 0;
  let pagesWithEdges = 0;
  let edgesWritten = 0;
  let edgesCites = 0;
  let edgesRelated = 0;
  let candidatesSeen = 0;
  let lastId = cursorStart;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    lastId = page.id;
    pagesScanned += 1;

    if (i > 0 && i % batchSize === 0 && opts.yieldDuringPhase) {
      try { await opts.yieldDuringPhase(); } catch { /* keepalive non-fatal */ }
    }

    const pageStart = Date.now();
    try {
      const candidates = await findCandidates(engine, page.slug, topK, embeddingCol);
      candidatesSeen += candidates.length;
      const edges = selectEdgesForPage(page.slug, page.compiled_truth, candidates, inboundCount, {
        cosineThreshold,
        hubSet,
      });
      if (edges.length > 0) {
        pagesWithEdges += 1;
        edgesCites += edges.filter((e) => e.edge_type === 'cites').length;
        edgesRelated += edges.filter((e) => e.edge_type === 'related').length;
        if (dryRun) {
          edgesWritten += edges.length;
        } else {
          edgesWritten += await reconcileSourceEdges(engine, page.slug, edges);
        }
      } else if (!dryRun) {
        // No current candidates: clear any stale cosine-mine edges from this source.
        await reconcileSourceEdges(engine, page.slug, []);
      }
    } catch {
      // Per-page failure is non-fatal; next run retries idempotently because
      // the page's edges are recomputed from scratch each pass.
    }

    if (minMsPerPage > 0) {
      const elapsed = Date.now() - pageStart;
      if (elapsed < minMsPerPage) await sleep(minMsPerPage - elapsed);
    }
  }

  // Advance / wrap the cursor. A short window (fewer rows than the cap) means we
  // hit the tail of the id space → wrap to 0 so the next run starts over.
  if (!dryRun) {
    const nextCursor = pages.length < maxPagesPerRun ? 0 : lastId;
    try { await engine.setConfig(CURSOR_KEY, String(nextCursor)); } catch { /* cursor write non-fatal */ }
  }

  return {
    phase: 'link_mine',
    status: 'ok',
    duration_ms: 0,
    summary: dryRun
      ? `(dry-run) would mine ${edgesWritten} edges (${edgesRelated} related, ${edgesCites} cites) across ${pagesWithEdges}/${pagesScanned} pages; ${candidatesSeen} candidates; hub-set ${hubSet.size}`
      : `mined ${edgesWritten} edges (${edgesRelated} related, ${edgesCites} cites) across ${pagesWithEdges}/${pagesScanned} pages; hub-set ${hubSet.size}; cursor→${pages.length < maxPagesPerRun ? 0 : lastId}`,
    details: {
      dryRun,
      pages_scanned: pagesScanned,
      pages_with_edges: pagesWithEdges,
      edges_written: edgesWritten,
      edges_related: edgesRelated,
      edges_cites: edgesCites,
      candidates_seen: candidatesSeen,
      hub_set_size: hubSet.size,
      cosine_threshold: cosineThreshold,
      cursor_start: cursorStart,
      cursor_next: pages.length < maxPagesPerRun ? 0 : lastId,
    },
  };
}
