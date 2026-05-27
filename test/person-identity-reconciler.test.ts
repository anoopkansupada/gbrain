/**
 * Tests for skills/person-identity-reconciler (v1.4 identity matching).
 * Regression anchors:
 *  - merge ONLY on a strong shared key (telegram_user_id/corporate-email/linkedin/phone)
 *  - same display name alone NEVER merges (matthew-tierney@Autodesk != matthewmtierney@Databricks)
 *  - webmail is weak: never a merge key, never an email-domain->company key
 *  - canonical slug = real >=2-token name, not the telegram-handle/id slug
 *  - v1.4 migration: confidence "confirmed"->1.0, telegram_display_name->aliases
 */
import { describe, expect, it } from 'bun:test';
import {
  norm, emailDomain, normLinkedin, normPhone, normHandle, WEBMAIL,
  identityKeys, clusterByIdentity, pickCanonical, resolveCompany, v14Migration, reconcile,
} from '../skills/person-identity-reconciler/scripts/person-identity-reconciler.mjs';

describe('normalizers', () => {
  it('emailDomain / linkedin / phone / handle', () => {
    expect(emailDomain('Jane <jane@acme.com>')).toBe('acme.com');
    expect(normLinkedin('https://www.linkedin.com/in/AkeemO')).toBe('akeemo');
    expect(normPhone('+1 (914) 523-1493')).toBe('9145231493');
    expect(normHandle('@KarelO')).toBe('karelo');
  });
  it('webmail set', () => { expect(WEBMAIL.has('gmail.com')).toBe(true); });
});

describe('identityKeys', () => {
  it('corporate email -> em:, webmail -> emw:, namespaced keys', () => {
    const k = identityKeys({ frontmatter: { email: 'a@acme.com', telegram_user_id: '42', linkedin: 'https://linkedin.com/in/foo', phone_numbers: ['(914) 523-1493'] }, emails:['b@gmail.com'] });
    expect(k.has('em:a@acme.com')).toBe(true);
    expect(k.has('emw:b@gmail.com')).toBe(true);
    expect(k.has('tg:42')).toBe(true);
    expect(k.has('li:foo')).toBe(true);
    expect(k.has('ph:9145231493')).toBe(true);
  });
});

describe('clusterByIdentity', () => {
  it('merges on shared telegram_user_id (telegram row + real-name row)', () => {
    const people = [
      { slug: 'people/karel-olivier', frontmatter: { telegram_user_id: '1531434664', linkedin:'https://linkedin.com/in/karel' } },
      { slug: 'people/karel-olivier-lemma', frontmatter: { telegram_user_id: '1531434664', source:'telegram-export' } },
    ];
    const c = clusterByIdentity(people);
    expect(c.length).toBe(1);
    expect(c[0].sort()).toEqual(['people/karel-olivier','people/karel-olivier-lemma']);
  });
  it('does NOT merge same-name different-employer (no shared key)', () => {
    const people = [
      { slug: 'people/matthew-tierney', frontmatter: { email:'m@autodesk.com' } },
      { slug: 'people/matthewmtierney', frontmatter: { current_company:'Databricks', linkedin:'https://linkedin.com/in/mmt' } },
    ];
    expect(clusterByIdentity(people).length).toBe(2);
  });
  it('does NOT merge on shared webmail', () => {
    const people = [
      { slug: 'people/a-one', frontmatter: { email:'shared@gmail.com' } },
      { slug: 'people/b-two', frontmatter: { email:'shared@gmail.com' } },
    ];
    expect(clusterByIdentity(people).length).toBe(2);
  });
});

describe('pickCanonical', () => {
  it('prefers real 2-token name over telegram-handle/id slug', () => {
    const bySlug = {
      'people/karel-olivier': { frontmatter:{ source:'monday' } },
      'people/karel-olivier-lemma': { frontmatter:{ source:'telegram-export' } },
      'people/1531434664-karel': { frontmatter:{ source:'telegram-export' } },
    };
    expect(pickCanonical(Object.keys(bySlug), bySlug)).toBe('people/karel-olivier');
  });
});

describe('resolveCompany', () => {
  const companies = ['companies/autodesk','companies/databricks','companies/red-sea-ventures'];
  it('current_company exact-slug', () => {
    expect(resolveCompany({ frontmatter:{ current_company:'Databricks' } }, companies))
      .toEqual({ slug:'companies/databricks', company_source:'exact-slug', confidence:0.95 });
  });
  it('Organizations line', () => {
    const r = resolveCompany({ frontmatter:{}, organizations:[{ title:'Associate', company:'Red Sea Ventures' }] }, companies);
    expect(r?.slug).toBe('companies/red-sea-ventures'); expect(r?.company_source).toBe('organizations-line');
  });
  it('corporate email-domain fallback', () => {
    const r = resolveCompany({ frontmatter:{ email:'j@autodesk.com' } }, companies);
    expect(r?.slug).toBe('companies/autodesk'); expect(r?.company_source).toBe('email-domain');
  });
  it('webmail email does NOT resolve a company', () => {
    expect(resolveCompany({ frontmatter:{ email:'j@gmail.com' } }, companies)).toBeNull();
  });
});

describe('v14Migration', () => {
  it('confirmed->1.0 and telegram_display_name->aliases', () => {
    const m = v14Migration({ frontmatter:{ confidence:'confirmed', telegram_display_name:'Karel Olivier | Lemma' } });
    expect(m.confidence).toBe(1.0);
    expect(m.aliases).toContain('Karel Olivier | Lemma');
    expect(m.drop).toContain('telegram_display_name');
  });
  it('clean v1.4 row needs no migration', () => {
    expect(v14Migration({ frontmatter:{ confidence:0.9 } })).toBeNull();
  });
});

describe('reconcile batch', () => {
  it('merges tg cluster, links company, attaches threads, migrates v1.4', () => {
    const r = reconcile({
      companySlugs: ['companies/lemma'],
      telegramThreadsByUserId: { '1531434664': ['telegram-1531434664-karel'] },
      people: [
        { slug:'people/karel-olivier', frontmatter:{ telegram_user_id:'1531434664', current_company:'Lemma' } },
        { slug:'people/karel-olivier-lemma', frontmatter:{ telegram_user_id:'1531434664', source:'telegram-export', confidence:'confirmed', telegram_display_name:'Karel Olivier | Lemma' } },
        { slug:'people/random-webmail', frontmatter:{ email:'x@gmail.com' } },
      ],
    });
    expect(r.counts.canonicalPeople).toBe(2);
    expect(r.counts.mergesTotal).toBe(1);
    expect(r.counts.withCompany).toBe(1);
    expect(r.counts.withTelegram).toBe(1);
    expect(r.counts.v14migrations).toBe(1);
    const karel = r.proposals.find((p:any)=>p.canonical==='people/karel-olivier');
    expect(karel.mergeFrom).toEqual(['people/karel-olivier-lemma']);
    expect(karel.company.slug).toBe('companies/lemma');
    expect(karel.autoApply).toBe(false); // merge present -> gated, even with company+telegram
    const dead = r.proposals.find((p:any)=>p.canonical==='people/random-webmail');
    expect(dead.deadweight).toBe(true);
    expect(dead.autoApply).toBe(false);
  });

  it('additive company link with NO merge auto-applies; any merge gates', () => {
    const r = reconcile({ companySlugs:['companies/acme'], people:[
      { slug:'people/jane-doe', frontmatter:{ current_company:'Acme' } },                 // company only -> auto
      { slug:'people/jdupe', frontmatter:{ email:'x@acme.com', current_company:'Acme' } },// shares nothing strong w/ jane (diff email) -> own cluster, auto
    ]});
    for (const p of r.proposals) { expect(p.mergeFrom.length).toBe(0); expect(p.autoApply).toBe(true); }
  });
});
