import { describe, test, expect } from 'bun:test';
import { parseMarkdown, serializeMarkdown } from '../src/core/markdown.ts';

function roundTrip(md: string): string {
  const p = parseMarkdown(md);
  return serializeMarkdown(p.frontmatter, p.compiled_truth, p.timeline, {
    type: p.type,
    title: p.title,
    tags: p.tags,
  });
}

describe('serializeMarkdown — quote accretion', () => {
  test('clean type round-trips without quote growth (5 cycles)', () => {
    let md = `---
type: deal
title: foo
---

body
`;
    for (let i = 0; i < 5; i++) {
      md = roundTrip(md);
      const parsed = parseMarkdown(md);
      expect(parsed.type).toBe('deal');
      expect(md).toContain('type: deal\n');
      expect(md).not.toMatch(/type:\s*['"]/);
    }
  });

  test('already-corrupt type is healed on first write and stable', () => {
    const md = `---
type: "'''deal'''"
title: corrupt
---

body
`;
    let cur = roundTrip(md);
    expect(parseMarkdown(cur).type).toBe('deal');
    for (let i = 0; i < 5; i++) {
      cur = roundTrip(cur);
      expect(parseMarkdown(cur).type).toBe('deal');
    }
  });

  test('values that legitimately need quoting (colon) still parse back equal', () => {
    const md = `---
type: deal
title: "has: colon"
---

body
`;
    let cur = md;
    for (let i = 0; i < 5; i++) {
      cur = roundTrip(cur);
      const parsed = parseMarkdown(cur);
      expect(parsed.type).toBe('deal');
      expect(parsed.title).toBe('has: colon');
    }
  });
});
