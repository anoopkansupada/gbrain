import { describe, test, expect } from 'bun:test';
import {
  normalizeQuoteNesting,
  classifyTypeValue,
} from '../src/commands/repair-type-field.ts';

describe('normalizeQuoteNesting', () => {
  test('already clean: no quotes, returns as-is', () => {
    expect(normalizeQuoteNesting('deal')).toBe('deal');
    expect(normalizeQuoteNesting('person')).toBe('person');
  });

  test('1x nesting: single layer of double quotes', () => {
    expect(normalizeQuoteNesting('"deal"')).toBe('deal');
  });

  test('1x nesting: single layer of apostrophes', () => {
    expect(normalizeQuoteNesting("'deal'")).toBe('deal');
  });

  test('3x nesting (observed in live brain)', () => {
    expect(normalizeQuoteNesting(`'"'deal'"'`)).toBe('deal');
  });

  test('7x nesting', () => {
    const input = `'''''''deal'''''''`;
    expect(normalizeQuoteNesting(input)).toBe('deal');
  });

  test('15x nesting (mixed quote chars)', () => {
    const input = `'"'"'"'"'"'"'"'"deal"'"'"'"'"'"'"'"'`;
    expect(normalizeQuoteNesting(input)).toBe('deal');
  });

  test('31x nesting (observed extreme)', () => {
    const inner = 'deal';
    const wrapped = `'`.repeat(31) + inner + `'`.repeat(31);
    expect(normalizeQuoteNesting(wrapped)).toBe('deal');
  });

  test('empty after stripping (all quotes)', () => {
    // The greedy regex will produce empty inner — quarantine territory.
    expect(normalizeQuoteNesting(`""""`)).toBe('');
  });

  test('idempotent: re-running on clean output is stable', () => {
    const once = normalizeQuoteNesting(`'"deal"'`);
    expect(normalizeQuoteNesting(once)).toBe(once);
  });
});

describe('classifyTypeValue', () => {
  test('clean enum member: returns clean', () => {
    expect(classifyTypeValue('deal')).toBe('clean');
    expect(classifyTypeValue('person')).toBe('clean');
  });

  test('quoted enum member: normalize', () => {
    expect(classifyTypeValue(`"deal"`)).toBe('normalize');
    expect(classifyTypeValue(`'''person'''`)).toBe('normalize');
  });

  test('strips to non-enum: quarantine', () => {
    expect(classifyTypeValue(`"not-a-real-type"`)).toBe('quarantine');
  });

  test('strips to empty: quarantine', () => {
    expect(classifyTypeValue(`""""`)).toBe('quarantine');
  });
});
