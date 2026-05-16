#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, join, relative } from "path";
import matter from "gray-matter";

type Mode = "dry-run" | "apply";

type Person = {
  slug: string;
  path: string;
  title: string;
  tags: string[];
  company?: string;
  companies: string[];
  emails: string[];
};

type Meeting = {
  slug: string;
  path: string;
  attendees: string[];
  related: string[];
};

type Summary = {
  mode: Mode;
  peopleScanned: number;
  meetingsScanned: number;
  peopleChanged: number;
  meetingsChanged: number;
  peopleTagsAdded: number;
  peopleRelatedAdded: number;
  meetingRelatedAdded: number;
};

function slugify(v: string): string {
  return String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function walkMd(root: string): string[] {
  const out: string[] = [];
  function walk(d: string) {
    for (const n of readdirSync(d)) {
      if (n.startsWith(".")) continue;
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (n.endsWith(".md")) out.push(p);
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

function parseTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === "string") {
    return v
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((x) => x.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return [];
}

function extractEmails(body: string): string[] {
  const m = body.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  return [...new Set(m.map((x) => x.toLowerCase()))];
}

function toYamlScalarOrArray(values: string[]) {
  if (values.length <= 1) return values[0] || "";
  return values;
}

function main() {
  const mode: Mode = process.argv[2] === "apply" ? "apply" : "dry-run";
  const brainRoot = process.argv[3] || join(process.env.HOME || "/Users/jarvis", "brain");
  const peopleDir = join(brainRoot, "people");
  const meetingsDir = join(brainRoot, "meetings");

  const peopleFiles = existsSync(peopleDir) ? walkMd(peopleDir) : [];
  const meetingFiles = existsSync(meetingsDir) ? walkMd(meetingsDir) : [];

  const people: Person[] = [];
  const byEmail = new Map<string, string>();
  const byName = new Map<string, string>();

  for (const p of peopleFiles) {
    const raw = readFileSync(p, "utf8");
    const parsed = matter(raw);
    const rel = relative(brainRoot, p).replace(/\\/g, "/");
    const slug = rel.replace(/\.md$/i, "");
    const title = String(parsed.data.title || basename(p, ".md"));
    const tags = parseTags(parsed.data.tags);
    const company = typeof parsed.data.company === "string" ? parsed.data.company : undefined;
    const companies = asArray(parsed.data.companies);
    const emails = extractEmails(parsed.content);
    const entry: Person = { slug, path: p, title, tags, company, companies, emails };
    people.push(entry);
    byName.set(slugify(title), slug);
    for (const e of emails) byEmail.set(e, slug);
  }

  const summary: Summary = {
    mode,
    peopleScanned: people.length,
    meetingsScanned: meetingFiles.length,
    peopleChanged: 0,
    meetingsChanged: 0,
    peopleTagsAdded: 0,
    peopleRelatedAdded: 0,
    meetingRelatedAdded: 0,
  };

  // Contacts -> people semantic tags from group ids
  for (const person of people) {
    const raw = readFileSync(person.path, "utf8");
    const parsed = matter(raw);
    const tags = parseTags(parsed.data.tags);
    const add: string[] = [];
    for (const t of tags) {
      if (!t.startsWith("contacts-group:")) continue;
      const g = t.replace("contacts-group:", "");
      if (g === "friends" || g === "family" || g === "coworkers" || g === "mycontacts") continue;
      add.push(`contacts:group-${g}`);
    }
    const merged = [...new Set([...tags, ...add])];
    if (merged.length !== tags.length) {
      parsed.data.tags = merged;
      summary.peopleTagsAdded += merged.length - tags.length;
      summary.peopleChanged += 1;
      if (mode === "apply") writeFileSync(person.path, matter.stringify(parsed.content, parsed.data), "utf8");
    }
  }

  // Calendar meetings -> related companies inferred from attendees' company fields
  for (const p of meetingFiles) {
    const raw = readFileSync(p, "utf8");
    const parsed = matter(raw);
    const attendeesRaw = asArray(parsed.data.attendees);
    const related = asArray(parsed.data.related);
    const companyRefs = new Set<string>();

    for (const a of attendeesRaw) {
      let personSlug = a.startsWith("people/") ? a : byName.get(slugify(a));
      if (!personSlug) continue;
      const personFile = join(brainRoot, `${personSlug}.md`);
      if (!existsSync(personFile)) continue;
      const personMd = matter(readFileSync(personFile, "utf8"));
      const c1 = typeof personMd.data.company === "string" ? personMd.data.company : "";
      const cN = asArray(personMd.data.companies);
      if (c1.startsWith("companies/")) companyRefs.add(c1);
      for (const c of cN) if (c.startsWith("companies/")) companyRefs.add(c);
    }

    const merged = [...new Set([...related, ...companyRefs])];
    if (merged.length !== related.length) {
      parsed.data.related = toYamlScalarOrArray(merged);
      summary.meetingRelatedAdded += merged.length - related.length;
      summary.meetingsChanged += 1;
      if (mode === "apply") writeFileSync(p, matter.stringify(parsed.content, parsed.data), "utf8");
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

main();

