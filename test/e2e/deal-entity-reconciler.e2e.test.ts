/**
 * E2E smoke for deal-entity-reconciler: trigger (run the CLI on a real input
 * file) → side effect (proposals JSON on stdout). Exercises the full
 * reconcile() pipeline end-to-end, not just unit branches.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', '..', 'skills', 'deal-entity-reconciler', 'scripts', 'deal-entity-reconciler.mjs');

describe('deal-entity-reconciler E2E', () => {
  it('CLI: input file → proposals JSON with correct bucketing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'der-'));
    const inputPath = join(dir, 'input.json');
    writeFileSync(inputPath, JSON.stringify({
      companySlugs: ['companies/airswap'],
      people: [{ slug: 'people/andrew-masanto', frontmatter: { current_company: 'Nillion', source: 'linkedin-export' } }],
      entityNameByDeal: { 'deals/nil-foundation': 'Nillion' },
      gmailByDeal: { 'deals/nil-foundation': [{ domainMatch: true, domain: 'nillion.com', threadId: 't1' }] },
      deals: [
        { slug: 'deals/airswap', title: 'AirSwap', frontmatter: { hash_owner: 'Joshua Zimmer' } },
        { slug: 'deals/nil-foundation', title: 'Nil Foundation', frontmatter: { hash_owner: 'Petri Basson' } },
        { slug: 'deals/abt', title: 'ABT' },
      ],
    }));

    const proc = Bun.spawnSync(['bun', SCRIPT, inputPath]);
    const out = JSON.parse(proc.stdout.toString());
    rmSync(dir, { recursive: true, force: true });

    expect(proc.exitCode).toBe(0);
    expect(out.counts.total).toBe(3);
    expect(out.counts.autoApply).toBe(1);                 // only existing airswap
    expect(out.counts.newCompanies).toBe(2);              // nillion + abt

    const nillion = out.proposals.find((p: any) => p.deal === 'deals/nil-foundation');
    expect(nillion.proposedCompany).toBe('companies/nillion');
    expect(nillion.canonicalName).toBe('Nillion');
    expect(nillion.aka).toContain('Nil Foundation');
    expect(nillion.keyPeople).toContain('people/andrew-masanto');
    expect(nillion.autoApply).toBe(false);                // NEW company gated to human
  });
});
