/**
 * Unit tests for skills/multi-extract/SKILL.md
 *
 * Asserts all 4 pre-write guardrails are documented in the contract
 * (slug existence, task frontmatter contract, internal-call detection,
 * auto-chain task-goal-linker).
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SKILL = join(__dirname, '..', 'skills', 'multi-extract', 'SKILL.md');

describe('multi-extract SKILL contract', () => {
  test('SKILL.md exists with v0.2 frontmatter', () => {
    const body = readFileSync(SKILL, 'utf-8');
    expect(body).toMatch(/^---\nname: multi-extract\n/);
    expect(body).toMatch(/version: 0\.2/);
  });

  test('declares all 10 extractors implicitly via writes_to or contract', () => {
    const body = readFileSync(SKILL, 'utf-8');
    expect(body).toMatch(/10 parallel extractors/i);
    // Sample 3 of the 10 extractors named in the contract description
    expect(body).toMatch(/deals/);
    expect(body).toMatch(/action-items/);
    expect(body).toMatch(/competitor-mentions/);
  });

  test('Guardrail 1 — slug existence check is documented', () => {
    const body = readFileSync(SKILL, 'utf-8');
    expect(body).toMatch(/Guardrail 1.*Slug existence/);
    expect(body).toMatch(/gbrain get/);
    expect(body).toMatch(/typed stub|manual-review task/);
  });

  test('Guardrail 2 — task frontmatter contract enforces owner/deadline/parent_goal', () => {
    const body = readFileSync(SKILL, 'utf-8');
    expect(body).toMatch(/Guardrail 2/);
    expect(body).toMatch(/owner:/);
    expect(body).toMatch(/deadline:/);
    expect(body).toMatch(/parent_goal:/);
    expect(body).toMatch(/deadline_inferred/);
  });

  test('Guardrail 3 — internal-call detection skips email draft', () => {
    const body = readFileSync(SKILL, 'utf-8');
    expect(body).toMatch(/Guardrail 3.*Internal-call/);
    expect(body).toMatch(/skip.*email-draft|email-draft.*skip/);
  });

  test('Guardrail 4 — auto-chain task-goal-linker as final phase', () => {
    const body = readFileSync(SKILL, 'utf-8');
    expect(body).toMatch(/Guardrail 4.*Auto-chain/);
    expect(body).toMatch(/task-goal-linker/);
    expect(body).toMatch(/--force/);
  });

  test('coverage report is mandated and lists guardrail enforcement', () => {
    const body = readFileSync(SKILL, 'utf-8');
    expect(body).toMatch(/coverage-report\.json/);
    expect(body).toMatch(/guardrail.*enforcement/i);
  });

  test('documents the 2026-05-14 incident origin for each guardrail', () => {
    const body = readFileSync(SKILL, 'utf-8');
    // Every guardrail rationale should cite the date or "Why:" with concrete origin
    const occurrences = (body.match(/2026-05-14/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });
});
