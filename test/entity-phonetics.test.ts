import { describe, test, expect } from 'bun:test';
import {
  stripDisplayNoise,
  slugifyBase,
  phoneticKey,
  levenshteinRatio,
  collisionScore,
  findPhoneticCollision,
} from '../src/core/entity-phonetics.ts';

// NOTE: fixtures use SYNTHETIC names that reproduce the 2026-05-21 drift
// *patterns* (vowel-swap, vowel-insert, "| org" display noise, corporate
// suffix). Real cohort names are deliberately avoided — they are real
// people/companies and the check-test-real-names CI guard forbids them. The
// literal cohort is exercised by an out-of-band runtime check, not here.

describe('stripDisplayNoise', () => {
  test('drops a "| org" qualifier tail', () => {
    expect(stripDisplayNoise('Sam Ortega | Fooco')).toBe('Sam Ortega');
  });
  test('drops a parenthetical qualifier', () => {
    expect(stripDisplayNoise('Bobby Quill (Zellocorp)')).toBe('Bobby Quill');
  });
  test('drops an em-dash qualifier', () => {
    expect(stripDisplayNoise('Ada — Zello')).toBe('Ada');
  });
  test('leaves a clean name untouched', () => {
    expect(stripDisplayNoise('Sam Ortega')).toBe('Sam Ortega');
  });
});

describe('slugifyBase', () => {
  test('noise-strips then slugifies', () => {
    expect(slugifyBase('Sam Ortega | Fooco')).toBe('sam-ortega');
  });
});

describe('phoneticKey', () => {
  test('vowel-swap variants collapse to the same key', () => {
    // reallo/rialo pattern: differ only by interior vowels.
    expect(phoneticKey('zello')).toBe(phoneticKey('zillo'));
  });
  test('vowel-insert variants collapse to the same key', () => {
    // reana/rena pattern: one extra vowel.
    expect(phoneticKey('reeno')).toBe(phoneticKey('reno'));
  });
  test('genuinely different names get different keys', () => {
    expect(phoneticKey('stripe')).not.toBe(phoneticKey('stark'));
  });
});

describe('levenshteinRatio', () => {
  test('identical strings = 1', () => {
    expect(levenshteinRatio('zephyr', 'zephyr')).toBe(1);
  });
  test('one-char typo scores high', () => {
    expect(levenshteinRatio('jonsmith', 'johnsmith')).toBeGreaterThan(0.85);
  });
});

describe('collisionScore', () => {
  test('phonetic-equal pair scores >= 0.85 even when edit distance is large', () => {
    // zello vs zillo: 2 edits over len 5 = 0.6 lev ratio, but phonetic-equal.
    expect(collisionScore('zello', 'zillo')).toBeGreaterThanOrEqual(0.85);
  });
});

describe('findPhoneticCollision', () => {
  const existing = [
    { slug: 'companies/zillo' },
    { slug: 'companies/zephyr-labs' },
    { slug: 'people/sam-ortega' },
    { slug: 'people/dana-reno' },
    { slug: 'companies/acme-robotics' },
  ];

  test('vowel-swap company variant is rejected (reallo/rialo pattern)', () => {
    const hit = findPhoneticCollision('companies/zello', existing);
    expect(hit).not.toBeNull();
    expect(hit!.collidesWith).toBe('companies/zillo');
  });

  test('corporate-suffix variant collides with the -labs canonical (subzero pattern)', () => {
    const hit = findPhoneticCollision('companies/zephyr', existing);
    expect(hit).not.toBeNull();
    expect(hit!.collidesWith).toBe('companies/zephyr-labs');
    expect(hit!.reason).toBe('exact-after-strip');
  });

  test('display-noise person slug collides via token reduction (karel-olivier-lemma pattern)', () => {
    const hit = findPhoneticCollision('people/sam-ortega-fooco', existing);
    expect(hit).not.toBeNull();
    expect(hit!.collidesWith).toBe('people/sam-ortega');
    expect(hit!.reason).toBe('token-reduction');
  });

  test('vowel-insert person variant is rejected (reana/rena pattern)', () => {
    const hit = findPhoneticCollision('people/dana-reeno', existing);
    expect(hit).not.toBeNull();
    expect(hit!.collidesWith).toBe('people/dana-reno');
  });

  test('a genuinely new distinct company is allowed', () => {
    expect(findPhoneticCollision('companies/helix-bio', existing)).toBeNull();
  });

  test('a genuinely new distinct person is allowed', () => {
    expect(findPhoneticCollision('people/wei-tanaka', existing)).toBeNull();
  });

  test('cross-kind near-matches do not collide', () => {
    // people/zillo must not match companies/zillo.
    expect(findPhoneticCollision('people/zillo-andersen', existing)).toBeNull();
  });

  test('exact same slug is treated as update, not collision', () => {
    expect(findPhoneticCollision('companies/zillo', existing)).toBeNull();
  });
});
