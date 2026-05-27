/**
 * Tests for skills/deal-entity-reconciler/scripts/deal-entity-reconciler.mjs
 *
 * Regression anchor: the "Nil Foundation" → Nillion Foundation case
 * (2026-05-26). A pure string-matcher missed it; only LinkedIn
 * current_company ("Nillion") + Gmail domain corroboration + a human
 * approval should produce the company page. New-company creation must
 * NEVER auto-apply.
 */

import { describe, expect, it } from 'bun:test';
import {
  norm, slugKey, matchDealToCompany, linkedinReverseIndex,
  scoreCandidate, reconcile,
} from '../skills/deal-entity-reconciler/scripts/deal-entity-reconciler.mjs';

describe('norm / slugKey', () => {
  it('drops corp suffixes + punctuation', () => {
    expect(norm('Pantera Capital')).toBe(norm('Pantera'));
    expect(norm('AirSwap (Mesh) Ltd.')).toContain('airswap');
  });
  it('slugKey keeps suffixes, strips non-alnum', () => {
    expect(slugKey('companies/3box-labs')).toBe('3boxlabs');
  });
});

describe('matchDealToCompany', () => {
  const companies = ['companies/airswap', 'companies/3box-labs', 'companies/bain-capital'];
  it('exact slug stem', () => {
    expect(matchDealToCompany({ slug: 'deals/airswap', title: 'AirSwap' }, companies))
      .toEqual({ slug: 'companies/airswap', method: 'exact-slug' });
  });
  it('stem-prefix (3box-labs ⊂ 3box-labsceramic)', () => {
    const m = matchDealToCompany({ slug: 'deals/3box-labsceramic', title: '3Box labs/Ceramic' }, companies);
    expect(m?.slug).toBe('companies/3box-labs');
  });
  it('normalized title (Bain Capital ← baincapital deal)', () => {
    const m = matchDealToCompany({ slug: 'deals/baincapital', title: 'Bain Capital' }, companies);
    expect(m?.slug).toBe('companies/bain-capital');
  });
  it('frontmatter company wins', () => {
    const m = matchDealToCompany({ slug: 'deals/x', title: 'X', frontmatter: { company: 'airswap' } }, companies);
    expect(m).toEqual({ slug: 'companies/airswap', method: 'frontmatter' });
  });
  it('returns null when nothing matches', () => {
    expect(matchDealToCompany({ slug: 'deals/zzzznope', title: 'Zzzznope' }, companies)).toBeNull();
  });
});

describe('linkedinReverseIndex', () => {
  it('indexes current_company → people', () => {
    const idx = linkedinReverseIndex([
      { slug: 'people/andrew-masanto', frontmatter: { current_company: 'Nillion', current_title: 'Co-Founder' } },
    ]);
    expect(idx.get(norm('Nillion'))?.[0].person).toBe('people/andrew-masanto');
  });
});

describe('scoreCandidate', () => {
  it('existing company exact match → high + autoApply', () => {
    const p = scoreCandidate(
      { slug: 'deals/airswap', title: 'AirSwap', frontmatter: { hash_owner: 'Joshua Zimmer' } },
      { internalMatch: { slug: 'companies/airswap', method: 'exact-slug' } });
    expect(p.confidence).toBe('high');
    expect(p.autoApply).toBe(true);
    expect(p.isNewCompany).toBe(false);
    expect(p.owner).toBe('Joshua Zimmer');
  });

  it('drops "Deleted member" owner', () => {
    const p = scoreCandidate({ slug: 'deals/x', title: 'X', frontmatter: { hash_owner: 'Deleted member' } }, {});
    expect(p.owner).toBeNull();
  });

  it('Nillion regression: abbreviation expands, key person attaches, NEW company never auto-applies', () => {
    const idx = linkedinReverseIndex([
      { slug: 'people/andrew-masanto', frontmatter: { current_company: 'Nillion', current_title: 'Co-Founder' } },
    ]);
    const p = scoreCandidate(
      { slug: 'deals/nil-foundation', title: 'Nil Foundation', frontmatter: { hash_owner: 'Petri Basson' } },
      { internalMatch: null, linkedinIndex: idx, entityName: 'Nillion',
        gmailHits: [{ domainMatch: true, domain: 'nillion.com', threadId: 't1' }] });
    expect(p.isNewCompany).toBe(true);
    expect(p.canonicalName).toBe('Nillion');           // expanded from "Nil"
    expect(p.aka).toContain('Nil Foundation');          // original kept as aka
    expect(p.keyPeople).toContain('people/andrew-masanto');
    expect(p.confidence).toBe('high');                  // linkedin(2)+gmail-domain(2), 2 sources
    expect(p.autoApply).toBe(false);                    // NEW company always gated
  });

  it('no evidence → low confidence, no autoApply, slug still derived', () => {
    const p = scoreCandidate({ slug: 'deals/abt', title: 'ABT' }, { internalMatch: null });
    expect(p.confidence).toBe('low');
    expect(p.autoApply).toBe(false);
    expect(p.proposedCompany).toBe('companies/abt');
  });
});

describe('reconcile batch', () => {
  it('counts buckets and sorts human-needed before auto-apply', () => {
    const r = reconcile({
      companySlugs: ['companies/airswap'],
      people: [],
      deals: [
        { slug: 'deals/airswap', title: 'AirSwap' },          // auto
        { slug: 'deals/abt', title: 'ABT' },                  // low/new
      ],
    });
    expect(r.counts.total).toBe(2);
    expect(r.counts.autoApply).toBe(1);
    expect(r.counts.newCompanies).toBe(1);
    expect(r.proposals[r.proposals.length - 1].autoApply).toBe(true); // auto sorted last
  });
});
