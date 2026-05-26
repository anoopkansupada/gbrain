import { describe, test, expect } from 'bun:test';
import { scanBodyForEntities } from '../src/core/cycle/phases/infer-links.ts';
import { extractFrontmatterLinks, type SlugResolver } from '../src/core/link-extraction.ts';
import type { PageType } from '../src/core/types.ts';

// SYNTHETIC entity names only (check-test-real-names CI guard forbids real ones).

describe('scanBodyForEntities (Guard 2 — prose mentions)', () => {
  const dict = new Map<string, string>([
    ['anchor harbor', 'companies/anchor-harbor'],
    ['zello', 'companies/zello'],
    ['ubsx', 'companies/ubsx'],
    ['sam ortega', 'people/sam-ortega'],
  ]);

  test('links multi-word, single-word, and acronym entities named in prose', () => {
    const body =
      'We talked with Anchor Harbor and Zello about the raise. UBSX joined late. Sam Ortega led the round.';
    const found = scanBodyForEntities(body, dict);
    expect(found.has('companies/anchor-harbor')).toBe(true);
    expect(found.has('companies/zello')).toBe(true);
    expect(found.has('companies/ubsx')).toBe(true);
    expect(found.has('people/sam-ortega')).toBe(true);
  });

  test('does not link a lowercase common-word occurrence (proper-noun gate)', () => {
    // "zello" lowercase mid-sentence is not a proper noun → skipped.
    const found = scanBodyForEntities('we should zello the files before the call', dict);
    expect(found.has('companies/zello')).toBe(false);
  });

  test('longest-match wins (does not double-count a sub-span)', () => {
    const found = scanBodyForEntities('Anchor Harbor closed.', dict);
    expect([...found]).toEqual(['companies/anchor-harbor']);
  });

  test('empty body yields no mentions', () => {
    expect(scanBodyForEntities('', dict).size).toBe(0);
  });
});

describe('extractFrontmatterLinks (Guard 2 — triple-nested attendee array)', () => {
  const resolver: SlugResolver = {
    async resolve(name: string) {
      // Echo back anything already shaped like a person slug.
      return /^people\/[a-z-]+$/.test(name) ? name : null;
    },
  };

  test('triple-nested attendees array still emits attended edges', async () => {
    const fm = { attendees: [[['people/sam-ortega']]] } as Record<string, unknown>;
    const { candidates } = await extractFrontmatterLinks(
      'meetings/2026-05-26-sync',
      'meeting' as unknown as PageType,
      fm,
      resolver,
    );
    const attended = candidates.filter((c) => c.linkType === 'attended');
    expect(attended.length).toBe(1);
    expect(attended[0].fromSlug).toBe('people/sam-ortega');
    expect(attended[0].targetSlug).toBe('meetings/2026-05-26-sync');
  });

  test('flat attendees array is unchanged by the deep-flatten', async () => {
    const fm = { attendees: ['people/sam-ortega', 'people/dana-reno'] } as Record<string, unknown>;
    const resolver2: SlugResolver = {
      async resolve(name: string) {
        return /^people\/[a-z-]+$/.test(name) ? name : null;
      },
    };
    const { candidates } = await extractFrontmatterLinks(
      'meetings/2026-05-26-sync',
      'meeting' as unknown as PageType,
      fm,
      resolver2,
    );
    expect(candidates.filter((c) => c.linkType === 'attended').length).toBe(2);
  });
});
