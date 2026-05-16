#!/usr/bin/env bun

import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";
import matter from "gray-matter";

type Mode = "dry-run" | "apply";

type PageRef = {
  slug: string;
  relPath: string;
  title: string;
  nameNorm: string;
};

type Summary = {
  mode: Mode;
  root: string;
  scanned: number;
  changed: number;
  peopleCompanyAdded: number;
  peopleCompaniesAdded: number;
  peopleFoundedAdded: number;
  meetingAttendeesNormalized: number;
  dealInvestorsAdded: number;
  dealLeadAdded: number;
  sample: Array<{ file: string; fields: string[] }>;
};

const SKIP_BASENAMES = new Set(["README.md", "RESOLVER.md", "schema.md", "index.md", "log.md"]);

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleFromMarkdown(body: string, fallback: string): string {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const abs = join(dir, name);
      const rel = relative(root, abs).replace(/\\/g, "/");
      if (rel.includes("/.raw/") || rel.endsWith("/.raw")) continue;
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!name.endsWith(".md")) continue;
      if (SKIP_BASENAMES.has(name)) continue;
      out.push(abs);
    }
  }
  walk(root);
  return out;
}

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

function firstSlugFromLink(text: string, dir: "people" | "companies"): string | null {
  const re = new RegExp(`\\((?:\\.\\./)?${dir}/([^)#]+)\\.md(?:#[^)]+)?\\)`, "i");
  const m = text.match(re);
  if (!m) return null;
  return `${dir}/${m[1]}`;
}

function mapNameToSlug(name: string, pages: PageRef[]): string | null {
  const n = norm(name);
  if (!n) return null;
  const exact = pages.find((p) => p.nameNorm === n);
  if (exact) return exact.slug;
  const compact = n.replace(/\s+/g, "");
  const loose = pages.find((p) => p.nameNorm.replace(/\s+/g, "") === compact);
  return loose ? loose.slug : null;
}

function main() {
  const modeArg = process.argv[2] || "dry-run";
  const mode: Mode = modeArg === "apply" ? "apply" : "dry-run";
  const root = process.argv[3] || join(process.env.HOME || "/Users/jarvis", "brain");

  const files = walkMarkdown(root);
  const peoplePages: PageRef[] = [];
  const companyPages: PageRef[] = [];

  for (const abs of files) {
    const rel = relative(root, abs).replace(/\\/g, "/");
    const raw = readFileSync(abs, "utf8");
    const parsed = matter(raw);
    const fallback = rel.replace(/^.*\//, "").replace(/\.md$/i, "");
    const title = String(parsed.data.title || titleFromMarkdown(parsed.content, fallback));
    const slug = rel.replace(/\.md$/i, "");
    if (rel.startsWith("people/")) peoplePages.push({ slug, relPath: rel, title, nameNorm: norm(title) });
    if (rel.startsWith("companies/")) companyPages.push({ slug, relPath: rel, title, nameNorm: norm(title) });
  }

  const summary: Summary = {
    mode,
    root,
    scanned: 0,
    changed: 0,
    peopleCompanyAdded: 0,
    peopleCompaniesAdded: 0,
    peopleFoundedAdded: 0,
    meetingAttendeesNormalized: 0,
    dealInvestorsAdded: 0,
    dealLeadAdded: 0,
    sample: [],
  };

  for (const abs of files) {
    const rel = relative(root, abs).replace(/\\/g, "/");
    summary.scanned += 1;
    const raw = readFileSync(abs, "utf8");
    const parsed = matter(raw);
    const fm = { ...parsed.data } as Record<string, unknown>;
    const body = parsed.content;
    const touched: string[] = [];

    if (rel.startsWith("people/")) {
      const existingCompany = typeof fm.company === "string" ? fm.company.trim() : "";
      const existingCompanies = asArray(fm.companies);
      let foundCompanies = [...existingCompanies];

      const linkedCompany = firstSlugFromLink(body, "companies");
      if (linkedCompany && !foundCompanies.includes(linkedCompany)) foundCompanies.push(linkedCompany);

      for (const line of body.split("\n")) {
        if (!/@/.test(line)) continue;
        const rhs = line.split("@").slice(1).join("@");
        const cleaned = rhs.replace(/\[Source:.*$/i, "").replace(/\[.*$/, "").trim();
        const slug = mapNameToSlug(cleaned, companyPages);
        if (slug && !foundCompanies.includes(slug)) foundCompanies.push(slug);
      }

      if (!existingCompany && foundCompanies.length === 1) {
        fm.company = foundCompanies[0];
        touched.push("company");
        summary.peopleCompanyAdded += 1;
      } else if (foundCompanies.length > 1) {
        const merged = Array.from(new Set(foundCompanies));
        if (JSON.stringify(merged) !== JSON.stringify(existingCompanies)) {
          fm.companies = merged;
          touched.push("companies");
          summary.peopleCompaniesAdded += 1;
        }
      }

      const role = String(fm.role || "");
      const founderSignal = /co[- ]?founder|founder/i.test(role) || /co[- ]?founder|founder/i.test(body);
      if (founderSignal && !fm.founded) {
        const base = asArray(fm.companies);
        if (typeof fm.company === "string" && fm.company) base.push(fm.company);
        const founded = Array.from(new Set(base.filter((s) => s.startsWith("companies/"))));
        if (founded.length > 0) {
          fm.founded = founded;
          touched.push("founded");
          summary.peopleFoundedAdded += 1;
        }
      }
    }

    if (rel.startsWith("meetings/")) {
      const attendees = asArray(fm.attendees);
      if (attendees.length > 0) {
        const mapped = attendees.map((a) => mapNameToSlug(a, peoplePages) || a);
        if (JSON.stringify(mapped) !== JSON.stringify(attendees)) {
          fm.attendees = mapped;
          touched.push("attendees");
          summary.meetingAttendeesNormalized += 1;
        }
      }
    }

    if (rel.startsWith("deals/")) {
      const investors = asArray(fm.investors);
      if (investors.length === 0) {
        const m = body.match(/Investor:\s*\[([^\]]+)\]\((?:\.\.\/)?people\/([^)#]+)\.md/i);
        if (m) {
          fm.investors = [`people/${m[2]}`];
          touched.push("investors");
          summary.dealInvestorsAdded += 1;
        }
      }
      const lead = typeof fm.lead === "string" ? fm.lead.trim() : "";
      if (!lead) {
        const m2 = body.match(/Lead:\s*\[([^\]]+)\]\((?:\.\.\/)?people\/([^)#]+)\.md/i);
        if (m2) {
          fm.lead = `people/${m2[2]}`;
          touched.push("lead");
          summary.dealLeadAdded += 1;
        }
      }
    }

    if (touched.length > 0) {
      summary.changed += 1;
      if (summary.sample.length < 200) summary.sample.push({ file: rel, fields: touched });
      const next = matter.stringify(body, fm);
      if (mode === "apply") writeFileSync(abs, next, "utf8");
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

main();

