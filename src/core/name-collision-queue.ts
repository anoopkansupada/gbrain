/**
 * Durable triage queue for Guard-1 (phonetic resolve-before-create) rejections.
 *
 * Appends one JSON line per rejected near-duplicate to
 * ~/.gbrain/name-collision-review.jsonl. This is deliberately a file, not a
 * gbrain page: the MCP put_page path runs inside a transaction, so a gbrain
 * write issued while the guard is throwing rolls back with it. A plain
 * append is transaction-independent and durable for every caller. Scan it
 * with `jq` or promote entries to gbrain pages out-of-band.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PageInput } from './types.ts';
import type { PhoneticCollision } from './entity-phonetics.ts';

/** Queue file path. Override with GBRAIN_NAME_COLLISION_LOG (used by tests). */
export function nameCollisionLogPath(): string {
  return process.env.GBRAIN_NAME_COLLISION_LOG
    ?? join(homedir(), '.gbrain', 'name-collision-review.jsonl');
}

export async function appendNameCollision(
  rejectedSlug: string,
  hit: PhoneticCollision,
  page: PageInput,
  sourceId: string,
): Promise<void> {
  const path = nameCollisionLogPath();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    rejected_slug: rejectedSlug,
    collides_with: hit.collidesWith,
    reason: hit.reason,
    score: Number(hit.score.toFixed(2)),
    attempted_title: page.title ?? null,
    source_id: sourceId,
  }) + '\n';
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, 'utf8');
}
