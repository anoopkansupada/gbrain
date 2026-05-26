import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendNameCollision, nameCollisionLogPath } from '../src/core/name-collision-queue.ts';

describe('name-collision-queue', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ncq-'));
    logPath = join(dir, 'nested', 'name-collision-review.jsonl');
    process.env.GBRAIN_NAME_COLLISION_LOG = logPath;
  });
  afterEach(() => {
    delete process.env.GBRAIN_NAME_COLLISION_LOG;
    rmSync(dir, { recursive: true, force: true });
  });

  test('honors the env override path', () => {
    expect(nameCollisionLogPath()).toBe(logPath);
  });

  test('creates parent dirs and appends one JSON line per rejection', async () => {
    await appendNameCollision(
      'companies/zello',
      { collidesWith: 'companies/zillo', score: 0.9, reason: 'phonetic' },
      { type: 'company', title: 'Zello' } as unknown as import('../src/core/types.ts').PageInput,
      'default',
    );
    await appendNameCollision(
      'people/sam-ortega-fooco',
      { collidesWith: 'people/sam-ortega', score: 0.97, reason: 'token-reduction' },
      { type: 'person', title: 'Sam Ortega' } as unknown as import('../src/core/types.ts').PageInput,
      'default',
    );
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.rejected_slug).toBe('companies/zello');
    expect(first.collides_with).toBe('companies/zillo');
    expect(first.reason).toBe('phonetic');
    expect(first.score).toBe(0.9);
    expect(typeof first.ts).toBe('string');
    const second = JSON.parse(lines[1]);
    expect(second.rejected_slug).toBe('people/sam-ortega-fooco');
  });
});
