/**
 * Phonetic resolve-before-create guard (Guard 1).
 *
 * Symptom this fixes: Granola speech-to-text drift on proper nouns produced
 * NEW `companies/<phonetic>` and `people/<phonetic>` pages that should have
 * resolved to an existing canonical entity. Documented 2026-05-21 cohort:
 * Reallo→Rialo, Reana→Rena, "Karel Olivier | Lemma"→karel-olivier,
 * Subzero→subzero-labs. Each created an orphan variant + dead backlinks.
 *
 * This module is PURE (no DB, no IO) so it is unit-testable in isolation.
 * The engine putPage paths call findPhoneticCollision with a pre-fetched
 * list of same-kind existing slugs; on a >threshold match they reject the
 * write (mirroring PR #13's catchall slug gate) and queue the candidate for
 * human triage.
 *
 * Reuses the matching philosophy of the gbrain-cleanup skill (near-duplicate
 * detection via normalized name + phonetic key), promoted here to a write-time
 * guard so drift never lands in the first place.
 */

/** Corporate suffixes stripped before comparing company bases. Mirrors the
 *  COMPANY_SUFFIX_RE in cycle/phases/infer-links.ts so "subzero" collides
 *  with the canonical "subzero-labs". */
const COMPANY_SUFFIX_RE =
  /-(labs|inc|llc|ltd|co|corp|company|holdings|group|partners|capital|ventures|io|ai|xyz|fi)$/;

/**
 * Strip display-name noise before slugging. Telegram/LinkedIn export names
 * arrive as "Karel Olivier | Lemma", "Bobby Z (Rialo)", "Ade — Reallo".
 * Drop the "| org" / "· org" / "(org)" tail and stray punctuation so the
 * slug is the person/company name only. Pure string transform — exported so
 * extractors can normalize a raw display name before they ever form a slug.
 */
export function stripDisplayNoise(name: string): string {
  if (!name) return '';
  let s = name;
  // Cut at the first pipe / middot / bullet separator — everything after is
  // an org/handle qualifier, not part of the name.
  s = s.split(/\s*[|·•]\s*/)[0];
  // Drop parenthetical / bracketed qualifiers anywhere.
  s = s.replace(/[([{][^)\]}]*[)\]}]/g, ' ');
  // Em/en dash followed by a qualifier ("Ade — Reallo") — keep the head.
  s = s.split(/\s+[–—]\s+/)[0];
  // Collapse remaining punctuation to spaces, squeeze whitespace.
  s = s.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

/** Slugify a (already noise-stripped) display name to the bare base form
 *  used after the `people/` or `companies/` prefix. */
export function slugifyBase(name: string): string {
  return stripDisplayNoise(name)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Split an entity slug into kind + base. Returns null for non-entity slugs. */
export function parseEntitySlug(
  slug: string,
): { kind: 'people' | 'companies'; base: string } | null {
  const m = slug.match(/^(people|companies)\/(.+)$/);
  if (!m) return null;
  return { kind: m[1] as 'people' | 'companies', base: m[2] };
}

/** Normalize a slug base for comparison: lowercase letters/digits only as a
 *  string; for companies, strip a trailing corporate suffix token. */
export function normalizeBase(base: string, kind: 'people' | 'companies'): string {
  let b = base.toLowerCase().trim();
  if (kind === 'companies') b = b.replace(COMPANY_SUFFIX_RE, '');
  return b;
}

/**
 * Phonetic key (Metaphone-lite): keep the leading letter, drop vowels from
 * the remainder, collapse consecutive duplicates. Two names that sound alike
 * collapse to the same key (reallo/rialo → "RL", reana/rena → "RN"). Crude
 * but deterministic and dependency-free; false positives only cost a
 * human-triage queue entry, never data loss.
 */
export function phoneticKey(s: string): string {
  const w = s.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  const first = w[0];
  const rest = w.slice(1).replace(/[aeiou]/g, '');
  return (first + rest).replace(/(.)\1+/g, '$1').toUpperCase();
}

/** Levenshtein edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Levenshtein similarity ratio in [0,1]: 1 - distance / maxLen. */
export function levenshteinRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Collision score in [0,1] between two normalized bases. Combines:
 *   - exact match → 1.0
 *   - shared phonetic key → 0.9 (strong "sounds the same" signal)
 *   - else raw Levenshtein ratio (catches one-char typos like johnsmith/jonsmith)
 * Take the max so either signal can trip the guard.
 */
export function collisionScore(a: string, b: string): number {
  if (a === b) return 1;
  const lev = levenshteinRatio(a, b);
  const phon = phoneticKey(a) && phoneticKey(a) === phoneticKey(b) ? 0.9 : 0;
  return Math.max(lev, phon);
}

export interface ExistingEntity {
  slug: string;
  title?: string | null;
}

export interface PhoneticCollision {
  /** The existing canonical slug the candidate likely duplicates. */
  collidesWith: string;
  /** Collision score in [0,1]. */
  score: number;
  /** Why it matched: 'exact-after-strip' | 'phonetic' | 'levenshtein' | 'token-reduction'. */
  reason: string;
}

/**
 * Decide whether creating `candidateSlug` would duplicate an existing entity
 * of the same kind. Returns the best collision above `threshold`, else null.
 *
 * Strategy (cheapest signal wins, all bounded):
 *   1. exact normalized-base match (company-suffix aware) → 1.0
 *   2. people token-reduction: drop the trailing slug token and re-test for an
 *      exact existing match — catches display-noise like
 *      "karel-olivier-lemma" → people/karel-olivier
 *   3. graded collisionScore (phonetic key OR Levenshtein) ≥ threshold
 *
 * Never matches a slug against itself (an exact same-slug "create" is an
 * update, handled by the existence probe in putPage).
 */
export function findPhoneticCollision(
  candidateSlug: string,
  existing: ExistingEntity[],
  threshold = 0.85,
): PhoneticCollision | null {
  const parsed = parseEntitySlug(candidateSlug);
  if (!parsed) return null;
  const { kind, base } = parsed;
  const candNorm = normalizeBase(base, kind);
  if (!candNorm) return null;

  // people: trailing-token-dropped variant for display-noise detection.
  const candReduced =
    kind === 'people' && base.split('-').filter(Boolean).length >= 3
      ? base.split('-').filter(Boolean).slice(0, -1).join('-')
      : null;

  let best: PhoneticCollision | null = null;
  for (const e of existing) {
    const ep = parseEntitySlug(e.slug);
    if (!ep || ep.kind !== kind) continue;
    if (e.slug === candidateSlug) continue; // same slug = update, not a dup
    const exNorm = normalizeBase(ep.base, kind);
    if (!exNorm) continue;

    let score = 0;
    let reason = '';
    if (candNorm === exNorm) {
      score = 1;
      reason = 'exact-after-strip';
    } else if (candReduced && (candReduced === ep.base || candReduced === exNorm)) {
      score = 0.97;
      reason = 'token-reduction';
    } else {
      const s = collisionScore(candNorm, exNorm);
      if (s >= threshold) {
        score = s;
        reason = phoneticKey(candNorm) === phoneticKey(exNorm) ? 'phonetic' : 'levenshtein';
      }
    }
    if (score >= threshold && (!best || score > best.score)) {
      best = { collidesWith: e.slug, score, reason };
    }
  }
  return best;
}
