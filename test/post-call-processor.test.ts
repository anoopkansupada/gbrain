/**
 * Unit tests for skills/post-call-processor/SKILL.md
 *
 * Asserts Phase 2 (speaker disambiguation) covers the three known
 * Granola failure modes: **Unknown** tags, Speaker A/B/C diarization,
 * and host-collapse (>70% one-name).
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SKILL = join(__dirname, '..', 'skills', 'post-call-processor', 'SKILL.md');

describe('post-call-processor Phase 2 (speaker disambiguation)', () => {
  test('SKILL.md exists', () => {
    expect(readFileSync(SKILL, 'utf-8').length).toBeGreaterThan(0);
  });

  test('Phase 2 trigger covers **Unknown** speakers', () => {
    const body = readFileSync(SKILL, 'utf-8');
    expect(body).toMatch(/\*\*Unknown\*\*:/);
  });

  test('Phase 2 trigger covers Speaker [A-Z] diarization labels', () => {
    const body = readFileSync(SKILL, 'utf-8');
    expect(body).toMatch(/Speaker \[A-Z\]:|`Speaker [A-Z]:`/);
  });

  test('Phase 2 trigger covers host-collapse (>70% one name) case', () => {
    const body = readFileSync(SKILL, 'utf-8');
    expect(body.toLowerCase()).toMatch(/host[- ]collapse|>70%|note creator/);
  });

  test('Phase 2 documents the 2026-05-14 Karel-dinner incident as evidence', () => {
    const body = readFileSync(SKILL, 'utf-8');
    expect(body).toMatch(/2026-05-14|karel|may 3.*dinner/i);
  });

  test('Phase 2 contains the critical attribution rule', () => {
    const body = readFileSync(SKILL, 'utf-8');
    expect(body).toMatch(/A brief named after Person X does not mean all .* belong to Person X|Attribution follows speaker identity/);
  });
});
