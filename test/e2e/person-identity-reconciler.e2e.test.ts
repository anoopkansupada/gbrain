/** E2E: CLI run on a real input file -> proposals JSON (full reconcile pipeline). */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', '..', 'skills', 'person-identity-reconciler', 'scripts', 'person-identity-reconciler.mjs');

describe('person-identity-reconciler E2E', () => {
  it('CLI input file -> proposals with merge+company+telegram+v14', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pir-'));
    const p = join(dir, 'in.json');
    writeFileSync(p, JSON.stringify({
      companySlugs: ['companies/lemma','companies/autodesk'],
      telegramThreadsByUserId: { '1531434664': ['telegram-1531434664-karel'] },
      people: [
        { slug:'people/karel-olivier', frontmatter:{ telegram_user_id:'1531434664', current_company:'Lemma' } },
        { slug:'people/karel-olivier-lemma', frontmatter:{ telegram_user_id:'1531434664', source:'telegram-export', confidence:'confirmed', telegram_display_name:'Karel Olivier | Lemma' } },
        { slug:'people/jason-fiedler', frontmatter:{ email:'jason@redseaventures.com' }, organizations:[{ title:'Associate', company:'Autodesk' }] },
        { slug:'people/nobody', frontmatter:{ email:'x@gmail.com' } },
      ],
    }));
    const proc = Bun.spawnSync(['bun', SCRIPT, p]);
    const out = JSON.parse(proc.stdout.toString());
    rmSync(dir, { recursive:true, force:true });
    expect(proc.exitCode).toBe(0);
    expect(out.counts.canonicalPeople).toBe(3);     // karel cluster + jason + nobody
    expect(out.counts.mergesTotal).toBe(1);
    expect(out.counts.withCompany).toBe(2);
    expect(out.counts.deadweight).toBe(1);
  });
});
