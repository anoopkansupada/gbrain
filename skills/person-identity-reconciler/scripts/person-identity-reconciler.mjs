#!/usr/bin/env bun
// person-identity-reconciler — pure identity-matching + company-resolution + v1.4 migration.
//
// No MCP / disk / network. The agent gathers person pages (+ body-parsed emails /
// organizations), company slugs, and telegram-thread maps, passes them here, and acts on
// the returned proposals. Judgment-free mechanics stay unit-testable; create/link/merge
// stays in the agent's MCP calls behind the human gate (SKILL.md).
//
// v1.4 schema (2026-05-27): identity join keys = telegram_user_id (strongest) > email /
// secondary_emails > linkedin > telegram @handle > phone_numbers. Telegram display name
// lives in aliases[]. confidence is a NUMBER 0..1. Resolver writes resolution_evidence.

const STOP = /\b(ltd|limited|inc|llc|llp|lp|the|co|corp|gmbh|ag|sa|plc|pte|pty|holdings?|group|labs?|capital|foundation|protocol|network|ventures?|partners?|technologies)\b/g;
export const WEBMAIL = new Set(["gmail.com","googlemail.com","yahoo.com","ymail.com","rocketmail.com","hotmail.com","outlook.com","live.com","icloud.com","me.com","mac.com","aol.com","proton.me","protonmail.com","pm.me","fastmail.com","msn.com","gmx.com"]);

export function norm(s){ if(!s) return ""; return String(s).toLowerCase().replace(STOP," ").replace(/[^a-z0-9]/g,""); }
export function emailDomain(e){ const m=String(e||"").toLowerCase().match(/@([^@>\s]+)/); return m?m[1]:""; }
export function normLinkedin(u){ const m=String(u||"").toLowerCase().match(/linkedin\.com\/in\/([a-z0-9-]+)/); return m?m[1]:""; }
export function normPhone(p){ return String(p||"").replace(/[^0-9]/g,"").replace(/^1(?=\d{10}$)/,""); }
export function normHandle(h){ return String(h||"").toLowerCase().replace(/^@/,"").trim(); }

/** All identity join keys for a person, namespaced so different key-types never collide. */
export function identityKeys(p){
  const fm=p.frontmatter||{}; const keys=new Set();
  if(fm.telegram_user_id) keys.add("tg:"+String(fm.telegram_user_id));
  const emails=[fm.email,...(fm.secondary_emails||[]),...(p.emails||[])].filter(Boolean);
  for(const e of emails){ const d=emailDomain(e); if(d && !WEBMAIL.has(d)) keys.add("em:"+String(e).toLowerCase()); else if(d) keys.add("emw:"+String(e).toLowerCase()); }
  const li=normLinkedin(fm.linkedin); if(li) keys.add("li:"+li);
  const tg=normHandle(fm.telegram); if(tg) keys.add("tgh:"+tg);
  for(const ph of (fm.phone_numbers||p.phones||[])){ const n=normPhone(ph); if(n.length>=10) keys.add("ph:"+n); }
  return keys;
}

/** Strong join keys only (telegram id / corporate email / linkedin / phone) — safe to auto-merge on. */
export function strongKeys(p){
  return new Set([...identityKeys(p)].filter(k=>/^(tg|em|li|ph):/.test(k)));
}

/** Union-find clustering of people that share a strong identity key. Returns array of slug-clusters. */
export function clusterByIdentity(people){
  const parent={}; const find=x=>{while(parent[x]!==x)x=parent[x]=parent[parent[x]];return x;};
  for(const p of people) parent[p.slug]=p.slug;
  const keyOwner={};
  for(const p of people){
    for(const k of strongKeys(p)){
      if(keyOwner[k]){ parent[find(p.slug)]=find(keyOwner[k]); }
      else keyOwner[k]=p.slug;
    }
  }
  const groups={};
  for(const p of people){ const r=find(p.slug); (groups[r]=groups[r]||[]).push(p.slug); }
  return Object.values(groups);
}

/** Pick the canonical slug of a same-person cluster: prefer real >=2-token name slug. */
export function pickCanonical(slugs, bySlug){
  const score=s=>{
    const stem=s.replace(/^people\//,""); const fm=(bySlug[s]||{}).frontmatter||{};
    let sc=0;
    if(stem.split("-").length>=2 && !/^\d/.test(stem)) sc+=4;        // first-surname shape
    if(!/[0-9]{5,}/.test(stem)) sc+=2;                                // not a telegram/id slug
    if(fm.source==="linkedin-export"||fm.linkedin) sc+=1;
    if(fm.source==="google-contacts"||/contacts/.test(JSON.stringify((bySlug[s]||{}).tags||[]))) sc+=1;
    if(fm.source==="telegram-export") sc-=2;                          // telegram-handle slugs are weak
    return sc;
  };
  return [...slugs].sort((a,b)=>score(b)-score(a))[0];
}

/** Resolve a person to an existing company. Returns {slug, company_source, confidence} | null. */
export function resolveCompany(p, companySlugs){
  const fm=p.frontmatter||{};
  const byStem=new Map(), byNorm=new Map();
  for(const cs of companySlugs){ const stem=cs.replace(/^companies\//,""); byStem.set(stem.replace(/[^a-z0-9]/g,""),cs); const n=norm(stem); if(n&&!byNorm.has(n))byNorm.set(n,cs); }
  const tryName=(name,src,conf)=>{
    if(!name) return null;
    const n=norm(name); if(n && byNorm.has(n)) return {slug:byNorm.get(n),company_source:src,confidence:conf};
    const stem=String(name).toLowerCase().replace(/[^a-z0-9]/g,""); if(stem && byStem.has(stem)) return {slug:byStem.get(stem),company_source:src,confidence:conf};
    return null;
  };
  // 1. current_company (linkedin/monday) — strongest employer signal
  let r=tryName(fm.current_company,"exact-slug",0.95); if(r) return r;
  // 2. Organizations line (google-contacts) "<title> @ <Company>"
  for(const o of (p.organizations||[])){ r=tryName(o.company,"organizations-line",0.9); if(r) return r; }
  // 3. corporate email domain -> company (FALLBACK only)
  const emails=[fm.email,...(fm.secondary_emails||[]),...(p.emails||[])].filter(Boolean);
  for(const e of emails){ const d=emailDomain(e); if(d && !WEBMAIL.has(d)){ const host=d.split(".")[0]; r=tryName(host,"email-domain",0.7); if(r) return r; } }
  return null;
}

/** v1.4 hygiene actions a page needs (legacy telegram-export rows). */
export function v14Migration(p){
  const fm=p.frontmatter||{}; const out={};
  if(fm.confidence==="confirmed") out.confidence=1.0;
  if(fm.telegram_display_name){ out.aliases=[...(fm.aliases||[]),fm.telegram_display_name]; out.drop=["telegram_display_name"]; }
  return Object.keys(out).length?out:null;
}

/** Build one reconciliation proposal per canonical person in the batch. */
export function reconcile(input){
  const people=input.people||[]; const companySlugs=input.companySlugs||[];
  const tgThreads=input.telegramThreadsByUserId||{};
  const bySlug=Object.fromEntries(people.map(p=>[p.slug,p]));
  const clusters=clusterByIdentity(people);
  const out=[];
  for(const cluster of clusters){
    const canonical=pickCanonical(cluster,bySlug);
    const cp=bySlug[canonical];
    const mergeFrom=cluster.filter(s=>s!==canonical);
    const company=resolveCompany(cp, companySlugs) ||
      mergeFrom.map(s=>resolveCompany(bySlug[s],companySlugs)).find(Boolean) || null;
    const tgid=(cp.frontmatter||{}).telegram_user_id ||
      mergeFrom.map(s=>(bySlug[s].frontmatter||{}).telegram_user_id).find(Boolean);
    const telegramThreads=tgid?(tgThreads[String(tgid)]||[]):[];
    const v14=[canonical,...mergeFrom].map(s=>({slug:s,migrate:v14Migration(bySlug[s])})).filter(x=>x.migrate);
    const ev=[];
    if(mergeFrom.length) ev.push(`dedup ${mergeFrom.length} via shared identity key`);
    if(company) ev.push(`company via ${company.company_source}`);
    if(telegramThreads.length) ev.push(`${telegramThreads.length} telegram thread(s)`);
    // autoApply: ONLY additive, easily-reversed edges. MERGES ARE NEVER auto —
    // they soft-delete a page and dirty source data produces false same-email joins
    // (e.g. one person's email mis-entered on another's page), so every merge is human-gated.
    const companyExact = company && company.company_source==="exact-slug";
    const autoApply = Boolean(companyExact || telegramThreads.length>0) && mergeFrom.length===0;
    out.push({
      canonical, mergeFrom, company, telegramThreads,
      v14Migrations:v14,
      resolution_evidence: ev.join("; ") || "no signal",
      confidence: company?company.confidence:(mergeFrom.length||telegramThreads.length?0.9:0.3),
      autoApply: Boolean(autoApply),
      deadweight: !company && !mergeFrom.length && !telegramThreads.length,
    });
  }
  return { proposals:out, counts:{
    canonicalPeople: out.length,
    withMerges: out.filter(p=>p.mergeFrom.length).length,
    mergesTotal: out.reduce((n,p)=>n+p.mergeFrom.length,0),
    withCompany: out.filter(p=>p.company).length,
    withTelegram: out.filter(p=>p.telegramThreads.length).length,
    v14migrations: out.reduce((n,p)=>n+p.v14Migrations.length,0),
    autoApply: out.filter(p=>p.autoApply).length,
    deadweight: out.filter(p=>p.deadweight).length,
  }};
}

if(import.meta.main){
  const path=process.argv[2];
  if(!path){ console.error("usage: person-identity-reconciler.mjs <input.json>"); process.exit(1); }
  const fs=await import("node:fs");
  console.log(JSON.stringify(reconcile(JSON.parse(fs.readFileSync(path,"utf8"))),null,2));
}
