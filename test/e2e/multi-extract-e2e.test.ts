/**
 * E2E smoke for skills/multi-extract.
 * Full e2e invokes 10 parallel claude subprocesses (~$1+/run), so this smoke
 * validates the runner shim + heartbeat schema only.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const RUN_SH = join(homedir(), '.gbrain', 'integrations', 'multi-extract', 'run.sh');
const HEARTBEAT = join(homedir(), '.gbrain', 'integrations', 'multi-extract', 'heartbeat.jsonl');

describe('multi-extract e2e (smoke)', () => {
  test('runner shim is installed and accepts meeting_slug + brief_slug args', () => {
    if (!existsSync(RUN_SH)) { console.warn('[skip] runner not installed'); return; }
    const body = readFileSync(RUN_SH, 'utf-8');
    expect(body).toMatch(/MEETING_SLUG=\$\{?1/);
    expect(body).toMatch(/BRIEF_SLUG=\$\{?2/);
  });
  test('heartbeat schema (if present) has ts + event fields', () => {
    if (!existsSync(HEARTBEAT)) { console.warn('[skip] no heartbeat yet'); return; }
    const lines = readFileSync(HEARTBEAT, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return;
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last).toHaveProperty('ts');
    expect(last).toHaveProperty('event');
  });
});
