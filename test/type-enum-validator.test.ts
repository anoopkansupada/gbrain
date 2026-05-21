import { describe, test, expect } from 'bun:test';
import { TYPE_ENUM, assertValidPageType } from '../src/core/types-enum.ts';

describe('TYPE_ENUM validator', () => {
  test('accepts every canonical type', () => {
    for (const t of TYPE_ENUM) {
      expect(() => assertValidPageType(t, 'test')).not.toThrow();
    }
  });

  test('rejects quote-wrapped corruption with paste-ready hint', () => {
    expect(() => assertValidPageType("'''deal'''", 'test')).toThrow(
      /gbrain repair-type-field --apply/,
    );
    expect(() => assertValidPageType("'''''''deal'''''''", 'test')).toThrow(
      /gbrain repair-type-field --apply/,
    );
    expect(() => assertValidPageType('"deal"', 'test')).toThrow(
      /gbrain repair-type-field --apply/,
    );
  });

  test('rejects unknown type with paste-ready hint', () => {
    expect(() => assertValidPageType('nonsense', 'test')).toThrow(
      /Invalid type "nonsense".*gbrain repair-type-field --apply/,
    );
  });

  test('rejects empty/non-string', () => {
    expect(() => assertValidPageType('', 'test')).toThrow();
    expect(() => assertValidPageType(undefined, 'test')).toThrow();
    expect(() => assertValidPageType(null, 'test')).toThrow();
    expect(() => assertValidPageType(42, 'test')).toThrow();
  });
});
