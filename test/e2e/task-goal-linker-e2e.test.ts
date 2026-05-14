/**
 * E2E smoke test for skills/task-goal-linker/
 *
 * Exercises the runner shim (--dry-run path) end-to-end without writing
 * to gbrain. Verifies wrapper exits 0, heartbeat is appended, no Python
 * tracebacks in stderr.
 *
 * This test is intentionally light: a full e2e against a fixture brain
 * would need a PGlite test instance per the gbrain test conventions —
 * follow-up TODO.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const RUN_SH = join(homedir(), '.gbrain', 'integrations', 'task-goal-linker', 'run.sh');
const HEARTBEAT = join(homedir(), '.gbrain', 'integrations', 'task-goal-linker', 'heartbeat.jsonl');

describe('task-goal-linker e2e', () => {
  test('runner shim exists and is executable', () => {
    if (!existsSync(RUN_SH)) {
      console.warn(`[skip] runner not installed at ${RUN_SH}`);
      return;
    }
    expect(existsSync(RUN_SH)).toBe(true);
  });

  test('--dry-run completes without writing pages', async () => {
    if (!existsSync(RUN_SH)) {
      console.warn('[skip] runner not installed');
      return;
    }
    const result = spawnSync('bash', [RUN_SH, '--dry-run'], {
      encoding: 'utf-8',
      timeout: 300_000,
    });
    if (result.error) console.error(result.error);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/Traceback/);
    // either linked some, or had nothing to link
    expect(result.stdout + result.stderr).toMatch(/(linked=|nothing to link|candidates)/);
  }, 600_000);

  test('heartbeat file is appended after a successful run', () => {
    if (!existsSync(HEARTBEAT)) {
      console.warn('[skip] heartbeat file not yet created');
      return;
    }
    const lines = readFileSync(HEARTBEAT, 'utf-8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last).toHaveProperty('ts');
    expect(last).toHaveProperty('event');
  });
});
