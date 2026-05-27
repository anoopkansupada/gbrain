#!/usr/bin/env bun
// deal-entity-reconciler — deterministic matching + evidence scoring.
//
// Pure functions only: no MCP, no disk, no network. The agent (per SKILL.md)
// gathers gbrain/LinkedIn/Gmail data, passes it here as plain objects, and
// acts on the returned proposals. Judgment-free mechanics stay unit-testable;
// the actual create/link/merge stays in the agent's MCP calls behind the
// human choice gate.

const STOP = /\b(ltd|limited|inc|llc|llp|lp|the|foundation|labs?|capital|group|holdings?|co|corp|gmbh|ag|sa|plc|protocol|network|systems?|technologies|trading|games?)\b/g;

/** Normalize an org name/slug to a comparison key (drops corp suffixes + punctuation). */
export function norm(s) {
  if (!s) return "";
  return String(s).toLowerCase().replace(STOP, " ").replace(/[^a-z0-9]/g, "");
}

/** Strict slug stem: lowercase alnum only, suffixes KEPT (for exact slug compare). */
export function slugKey(s) {
  if (!s) return "";
  return String(s).toLowerCase().replace(/^(companies|deals|people)\//, "").replace(/[^a-z0-9]/g, "");
}

/**
 * Deterministic internal match of a deal to an existing company.
 * companySlugs: string[] like "companies/airswap". Returns {slug, method} | null.
 */
export function matchDealToCompany(deal, companySlugs) {
  const fm = deal.frontmatter || {};
  const title = deal.title || "";
  const dealStem = slugKey(deal.slug);
  const set = new Set(companySlugs);
  const byNormSlug = new Map();
  const byStem = new Map();
  for (const cs of companySlugs) {
    byStem.set(slugKey(cs), cs);
    const k = norm(cs.replace(/^companies\//, ""));
    if (k && !byNormSlug.has(k)) byNormSlug.set(k, cs);
  }
  if (fm.company) {
    const cv = String(fm.company).startsWith("companies/") ? String(fm.company) : "companies/" + fm.company;
    if (set.has(cv)) return { slug: cv, method: "frontmatter" };
  }
  if (byStem.has(dealStem)) return { slug: byStem.get(dealStem), method: "exact-slug" };
  for (const cand of [title.split("/")[0], title]) {
    const k = norm(cand);
    if (k && byNormSlug.has(k)) return { slug: byNormSlug.get(k), method: "norm-title" };
  }
  let best = null;
  for (const [k, slug] of byStem) {
    if (k.length >= 4 && (dealStem.startsWith(k) || k.startsWith(dealStem))) {
      if (!best || k.length > best.k.length) best = { k, slug };
    }
  }
  if (best) return { slug: best.slug, method: "stem-prefix" };
  return null;
}

/**
 * Build company-name -> [personSlug] reverse index from LinkedIn-export people.
 * people: [{slug, frontmatter:{current_company|company, current_title}}].
 */
export function linkedinReverseIndex(people) {
  const idx = new Map();
  for (const p of people || []) {
    const fm = p.frontmatter || {};
    const company = fm.current_company || fm.company;
    if (!company) continue;
    const k = norm(company);
    if (!k) continue;
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push({ person: p.slug, company, title: fm.current_title || null });
  }
  return idx;
}

/**
 * Score a reconciliation candidate for one deal against all evidence.
 * Evidence weights: internal-exact 3, linkedin-company->person 2,
 * gmail-domain 2, gmail-mention 1, contact-resolves 1.
 */
export function scoreCandidate(deal, ctx) {
  const fm = deal.frontmatter || {};
  const title = deal.title || "";
  const rawEntity = (title.split("/")[0] || title).trim();
  // The LLM (Phase 2) supplies ctx.entityName when it recognizes an
  // abbreviation/expansion the deterministic normalizer cannot ("Nil" -> "Nillion").
  const entityName = (ctx.entityName || rawEntity).trim();
  const ek = norm(entityName);
  const evidence = [];
  let weight = 0;

  const internal = ctx.internalMatch || null;
  if (internal) { evidence.push({ src: "internal-" + internal.method, target: internal.slug }); weight += 3; }

  const liHits = (ctx.linkedinIndex && ctx.linkedinIndex.get(ek)) || [];
  const keyPeople = [];
  for (const h of liHits) {
    evidence.push({ src: "linkedin-company->person", person: h.person, title: h.title });
    keyPeople.push(h.person);
    weight += 2;
  }

  for (const g of ctx.gmailHits || []) {
    if (g.domainMatch) { evidence.push({ src: "gmail-domain", domain: g.domain, thread: g.threadId }); weight += 2; }
    else if (g.nameMatch) { evidence.push({ src: "gmail-mention", thread: g.threadId }); weight += 1; }
    for (const ps of g.resolvedPeople || []) { if (!keyPeople.includes(ps)) keyPeople.push(ps); }
  }

  for (const c of ctx.resolvedContacts || []) {
    evidence.push({ src: "contact-resolves", person: c });
    if (!keyPeople.includes(c)) keyPeople.push(c);
    weight += 1;
  }

  const sources = new Set(evidence.map((e) => e.src.split("->")[0]));
  let confidence = "low";
  if (internal && weight >= 3) confidence = "high";
  else if (weight >= 4 && sources.size >= 2) confidence = "high";
  else if (weight >= 2) confidence = "medium";

  let canonicalName = entityName;
  if (liHits.length && norm(liHits[0].company) === ek && liHits[0].company.length > canonicalName.length) {
    canonicalName = liHits[0].company;
  }
  const proposedCompany = internal ? internal.slug
    : "companies/" + canonicalName.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const aka = canonicalName !== rawEntity ? [rawEntity] : [];

  return {
    deal: deal.slug,
    proposedCompany,
    isNewCompany: !internal,
    canonicalName,
    aka,
    keyPeople,
    owner: fm.hash_owner && !/^(deleted member|owner)$/i.test(String(fm.hash_owner)) ? fm.hash_owner : null,
    referrer: fm.referrer || null,
    evidence,
    weight,
    confidence,
    autoApply: Boolean(internal) && confidence === "high",
  };
}

/** Reconcile a batch. input: {deals[], companySlugs[], people[], gmailByDeal{}, contactsByDeal{}} */
export function reconcile(input) {
  const companySlugs = input.companySlugs || [];
  const liIndex = linkedinReverseIndex(input.people || []);
  const out = [];
  for (const deal of input.deals || []) {
    const internalMatch = matchDealToCompany(deal, companySlugs);
    const ctx = {
      internalMatch,
      linkedinIndex: liIndex,
      entityName: (input.entityNameByDeal || {})[deal.slug],
      gmailHits: (input.gmailByDeal || {})[deal.slug] || [],
      resolvedContacts: (input.contactsByDeal || {})[deal.slug] || [],
    };
    out.push(scoreCandidate(deal, ctx));
  }
  out.sort((a, b) => (a.autoApply === b.autoApply ? b.weight - a.weight : a.autoApply ? 1 : -1));
  return { proposals: out, counts: {
    total: out.length,
    autoApply: out.filter((p) => p.autoApply).length,
    high: out.filter((p) => p.confidence === "high").length,
    medium: out.filter((p) => p.confidence === "medium").length,
    low: out.filter((p) => p.confidence === "low").length,
    newCompanies: out.filter((p) => p.isNewCompany).length,
  } };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) { console.error("usage: deal-entity-reconciler.mjs <input.json>"); process.exit(1); }
  const fs = await import("node:fs");
  const input = JSON.parse(fs.readFileSync(path, "utf8"));
  console.log(JSON.stringify(reconcile(input), null, 2));
}
