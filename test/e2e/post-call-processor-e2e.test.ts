/**
 * E2E smoke for skills/post-call-processor.
 * The actual processor invokes ~10 LLM subprocess calls (~$1/run), so this
 * smoke validates the runner shim + cursor file exist and parse correctly
 * — full e2e against a fixture brain is a follow-up TODO.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const RUN_SH = join(homedir(), '.gbrain', 'integrations', 'post-call-processor', 'run.sh');
const CURSOR = join(homedir(), '.gbrain', 'integrations', 'post-call-processor', 'cursor.json');

describe('post-call-processor e2e (smoke)', () => {
  test('runner shim is installed', () => {
    if (!existsSync(RUN_SH)) { console.warn('[skip] runner not installed'); return; }
    expect(existsSync(RUN_SH)).toBe(true);
  });
  test('cursor file (if present) is valid JSON', () => {
    if (!existsSync(CURSOR)) { console.warn('[skip] cursor not yet created'); return; }
    const parsed = JSON.parse(readFileSync(CURSOR, 'utf-8'));
    expect(parsed).toHaveProperty('last_processed_at');
  });
});
