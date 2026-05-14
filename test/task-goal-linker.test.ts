/**
 * Unit tests for skills/task-goal-linker/
 *
 * Validates the SKILL.md contract is well-formed and the runner shim
 * has the expected structure. Deterministic matching logic is exercised
 * by the LLM in production; the unit pass is a structural/contract gate.
 *
 * E2E lives in test/e2e/task-goal-linker-e2e.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

const SKILL_DIR = join(__dirname, '..', 'skills', 'task-goal-linker');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const RUN_SH = join(SKILL_DIR, 'run.sh.reference');

describe('task-goal-linker SKILL contract', () => {
  test('SKILL.md exists', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  test('SKILL.md frontmatter has required fields', () => {
    const body = readFileSync(SKILL_MD, 'utf-8');
    expect(body).toMatch(/^---\n/);
    const fm = body.split('---\n')[1];
    expect(fm).toMatch(/^name: task-goal-linker$/m);
    expect(fm).toMatch(/^version: \d+\.\d+\.\d+$/m);
    expect(fm).toMatch(/^description:/m);
    expect(fm).toMatch(/^triggers:/m);
    expect(fm).toMatch(/^tools:/m);
    expect(fm).toMatch(/^mutating: true$/m);
    expect(fm).toMatch(/writes_to:/m);
  });

  test('SKILL.md has required body sections', () => {
    const body = readFileSync(SKILL_MD, 'utf-8');
    expect(body).toContain('## Contract');
    expect(body).toContain('## Phases');
    expect(body).toMatch(/(## Output|writes? back|reports?\/task-link-audit)/i);
  });

  test('SKILL.md documents LLM resolution (v0.2 pattern, no hand-tuned weights)', () => {
    const body = readFileSync(SKILL_MD, 'utf-8');
    expect(body).toMatch(/(LLM|one LLM call|claude -p)/i);
    expect(body).not.toMatch(/score \+=/);
    expect(body).not.toMatch(/tag.*\* ?3/);
  });

  test('SKILL.md documents idempotency', () => {
    const body = readFileSync(SKILL_MD, 'utf-8');
    expect(body.toLowerCase()).toContain('idempotent');
  });

  test('SKILL.md documents the three audit fields (due, owner, parent_goal)', () => {
    const body = readFileSync(SKILL_MD, 'utf-8');
    expect(body).toMatch(/(deadline|due)/i);
    expect(body).toMatch(/owner/);
    expect(body).toMatch(/parent_goal/);
  });

  test('SKILL.md declares triggers users would actually type', () => {
    const body = readFileSync(SKILL_MD, 'utf-8');
    const fm = body.split('---\n')[1];
    expect(fm).toMatch(/- "link tasks to goals"/);
    expect(fm).toMatch(/- "(audit tasks|\/task-link)"/);
  });
});

describe('task-goal-linker runner', () => {
  test('reference runner exists at skills/task-goal-linker/run.sh.reference', () => {
    expect(existsSync(RUN_SH)).toBe(true);
  });

  test('reference runner declares --dry-run and --force flags', () => {
    const body = readFileSync(RUN_SH, 'utf-8');
    expect(body).toContain('--dry-run');
    expect(body).toContain('--force');
  });

  test('reference runner writes audit report to reports/task-link-audit-<date>', () => {
    const body = readFileSync(RUN_SH, 'utf-8');
    expect(body).toMatch(/reports\/task-link-audit-\$TODAY/);
  });

  test('reference runner uses claude CLI via stdin (no -p "cat file" bug)', () => {
    const body = readFileSync(RUN_SH, 'utf-8');
    // Verify the LLM call passes prompt via stdin, not as a literal arg
    expect(body).toMatch(/input=prompt/);
    expect(body).not.toMatch(/"cat \$\{?pf\}?"/);
  });
});
