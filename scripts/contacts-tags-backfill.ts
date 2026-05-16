#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";
import matter from "gray-matter";

type Mode = "dry-run" | "apply";

type Summary = {
  mode: Mode;
  root: string;
  pagesScanned: number;
  pagesChanged: number;
  taggedPages: number;
  tagsAdded: number;
  groupKeysSeen: number;
  readableGroupLabelsKnown: number;
  readableGroupLabelsUnknown: number;
  reportPath: string;
  sample: Array<{ file: string; tagsAdded: string[] }>;
};

const SYSTEM_GROUP_LABELS: Record<string, string> = {
  friends: "contacts:friends",
  family: "contacts:family",
  coworkers: "contacts:coworkers",
  mycontacts: "contacts:my-contacts",
  starred: "contacts:starred",
};

function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (name.endsWith(".md")) out.push(abs);
    }
  }
  walk(root);
  return out;
}

function slugify(v: string): string {
  return String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function groupKeyFromMembership(membership: any): string {
  const id = String(membership?.contactGroupMembership?.contactGroupId || "").trim();
  const rn = String(membership?.contactGroupMembership?.contactGroupResourceName || "").trim();
  if (id) return slugify(id);
  if (rn) return slugify(rn.replace(/^contactGroups\//i, ""));
  return "";
}

function loadLocalGroupLabelArtifacts(brainRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const reportPath = join(brainRoot, "reports", "contacts", "contact-group-labels.json");
  if (!existsSync(reportPath)) return out;
  try {
    const parsed = JSON.parse(readFileSync(reportPath, "utf8"));
    const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];
    for (const g of groups) {
      const key = slugify(String(g?.groupKey || ""));
      const label = slugify(String(g?.label || ""));
      if (key && label) out.set(key, `contacts:${label}`);
    }
  } catch {}
  return out;
}

function getMembershipTags(contact: any, artifactLabels: Map<string, string>): { tags: string[]; groupKeys: string[] } {
  const tags = new Set<string>();
  const groupKeys = new Set<string>();
  const memberships = Array.isArray(contact.memberships) ? contact.memberships : [];
  for (const m of memberships) {
    const groupKey = groupKeyFromMembership(m);
    if (!groupKey) continue;
    groupKeys.add(groupKey);
    tags.add(`contacts-group:${groupKey}`);
    const sysLabel = SYSTEM_GROUP_LABELS[groupKey];
    if (sysLabel) tags.add(sysLabel);
    const artifactLabel = artifactLabels.get(groupKey);
    if (artifactLabel) tags.add(artifactLabel);
  }
  return { tags: [...tags], groupKeys: [...groupKeys] };
}

function loadContactsMap(
  brainRoot: string,
  artifactLabels: Map<string, string>,
): { map: Map<string, string[]>; groupKeyCounts: Map<string, number> } {
  const map = new Map<string, string[]>();
  const groupKeyCounts = new Map<string, number>();
  const sourceDir = join(brainRoot, "sources", "contacts");
  if (!existsSync(sourceDir)) return { map, groupKeyCounts };
  const files = readdirSync(sourceDir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const full = join(sourceDir, f);
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    const connections = Array.isArray(parsed.connections) ? parsed.connections : [];
    for (const c of connections) {
      const rn = String(c.resourceName || "").trim();
      if (!rn) continue;
      const { tags, groupKeys } = getMembershipTags(c, artifactLabels);
      if (tags.length === 0) continue;
      const prev = map.get(rn) || [];
      map.set(rn, [...new Set([...prev, ...tags])]);
      for (const key of groupKeys) {
        groupKeyCounts.set(key, (groupKeyCounts.get(key) || 0) + 1);
      }
    }
  }
  return { map, groupKeyCounts };
}

function extractResourceNameFromBody(body: string): string | null {
  const m = body.match(/Resource:\s*`([^`]+)`/i);
  return m?.[1] ? String(m[1]).trim() : null;
}

function main() {
  const modeArg = process.argv[2] || "dry-run";
  const mode: Mode = modeArg === "apply" ? "apply" : "dry-run";
  const brainRoot = process.argv[3] || join(process.env.HOME || "/Users/jarvis", "brain");
  const peopleDir = join(brainRoot, "people");
  const artifactLabels = loadLocalGroupLabelArtifacts(brainRoot);
  const { map: contactsMap, groupKeyCounts } = loadContactsMap(brainRoot, artifactLabels);
  const reportDir = join(brainRoot, "reports", "contacts");
  if (!existsSync(reportDir) && mode === "apply") mkdirSync(reportDir, { recursive: true });

  const summary: Summary = {
    mode,
    root: brainRoot,
    pagesScanned: 0,
    pagesChanged: 0,
    taggedPages: 0,
    tagsAdded: 0,
    groupKeysSeen: 0,
    readableGroupLabelsKnown: 0,
    readableGroupLabelsUnknown: 0,
    reportPath: join(reportDir, "contacts-tags-backfill-report.json"),
    sample: [],
  };

  const files = walkMarkdown(peopleDir);
  for (const abs of files) {
    summary.pagesScanned += 1;
    const rel = relative(brainRoot, abs).replace(/\\/g, "/");
    const raw = readFileSync(abs, "utf8");
    const parsed = matter(raw);
    const rn = extractResourceNameFromBody(parsed.content);
    if (!rn) continue;
    const tagsFromContacts = contactsMap.get(rn) || [];
    if (tagsFromContacts.length === 0) continue;

    const existing = Array.isArray(parsed.data.tags)
      ? parsed.data.tags.map((t: unknown) => String(t))
      : typeof parsed.data.tags === "string"
      ? parsed.data.tags
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((x: string) => x.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean)
      : [];

    const merged = [...new Set([...existing, ...tagsFromContacts])];
    const added = merged.filter((t) => !existing.includes(t));
    if (added.length === 0) continue;

    parsed.data.tags = merged;
    summary.pagesChanged += 1;
    summary.taggedPages += 1;
    summary.tagsAdded += added.length;
    if (summary.sample.length < 200) summary.sample.push({ file: rel, tagsAdded: added });
    if (mode === "apply") writeFileSync(abs, matter.stringify(parsed.content, parsed.data), "utf8");
  }

  const known = new Set<string>([
    ...Object.keys(SYSTEM_GROUP_LABELS).map((x) => slugify(x)),
    ...artifactLabels.keys(),
  ]);
  const groups = [...groupKeyCounts.entries()]
    .map(([groupKey, count]) => ({
      groupKey,
      count,
      readableTag: SYSTEM_GROUP_LABELS[groupKey] || artifactLabels.get(groupKey) || null,
    }))
    .sort((a, b) => b.count - a.count || a.groupKey.localeCompare(b.groupKey));

  summary.groupKeysSeen = groups.length;
  summary.readableGroupLabelsKnown = groups.filter((g) => g.readableTag).length;
  summary.readableGroupLabelsUnknown = groups.filter((g) => !g.readableTag).length;

  const report = {
    generatedAt: new Date().toISOString(),
    mode,
    knownReadableLabelSources: {
      systemGroups: Object.keys(SYSTEM_GROUP_LABELS),
      localArtifactsLoaded: artifactLabels.size,
    },
    groups,
    summary,
  };
  if (mode === "apply") {
    Bun.write(summary.reportPath, JSON.stringify(report, null, 2));
  }

  console.log(JSON.stringify(summary, null, 2));
}

main();
