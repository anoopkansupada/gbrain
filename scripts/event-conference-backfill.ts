#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, join, relative } from "path";
import matter from "gray-matter";

type Mode = "dry-run" | "apply";

const EVENT_PATTERNS = [
  /\bbaby\s*bathwater\b/i,
  /\bbreakout\b/i,
  /\bsxsw\b/i,
  /\bconsensus\b/i,
  /\btoken2049\b/i,
  /\bethdenver\b/i,
  /\bpermissionless\b/i,
  /\bmainnet\b/i,
  /\bbitcoin\s+conference\b/i,
  /\bguest\s*list\b/i,
  /\brsvp\b/i,
  /\beventbrite\b/i,
  /\bsplash\b/i,
  /\bpaperless\s*post\b/i,
];

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
  if (existsSync(root)) walk(root);
  return out;
}

function findEventSignal(text: string): string | null {
  for (const p of EVENT_PATTERNS) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return null;
}

function inferDate(text: string): string {
  const m = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return new Date().toISOString().slice(0, 10);
}

function ensureEventPage(brainRoot: string, eventName: string, mode: Mode): string {
  const dir = join(brainRoot, "events");
  mkdirSync(dir, { recursive: true });
  const slug = slugify(eventName).slice(0, 80) || "event";
  const path = join(dir, `${slug}.md`);
  if (!existsSync(path) && mode === "apply") {
    const md = [
      "---",
      `title: ${eventName}`,
      "type: event",
      `updated: ${new Date().toISOString().slice(0, 10)}`,
      "tags: [events, network]",
      "---",
      "",
      `# ${eventName}`,
      "",
      "## What I know",
      "",
      "[No data yet]",
      "",
      "## Timeline",
      "",
    ].join("\n");
    writeFileSync(path, `${md}\n`, "utf8");
  }
  return path;
}

function appendUniqueTimeline(path: string, line: string, mode: Mode): boolean {
  if (!existsSync(path)) {
    // In dry-run we may "touch" pages that are not yet materialized.
    return true;
  }
  const raw = readFileSync(path, "utf8");
  if (raw.includes(line)) return false;
  const marker = "\n## Timeline\n";
  let next = raw;
  if (raw.includes(marker)) {
    const idx = raw.indexOf(marker) + marker.length;
    next = `${raw.slice(0, idx)}\n${line}\n${raw.slice(idx)}`;
  } else {
    next = `${raw.trimEnd()}\n\n## Timeline\n\n${line}\n`;
  }
  if (mode === "apply") writeFileSync(path, next, "utf8");
  return true;
}

function run(mode: Mode, brainRoot: string) {
  const files = [
    ...walkMd(join(brainRoot, "meetings")),
    ...walkMd(join(brainRoot, "sources", "email")),
    ...walkMd(join(brainRoot, "daily", "calendar")),
  ];

  let signals = 0;
  let pagesTouched = 0;
  const touched = new Set<string>();
  for (const f of files) {
    const rel = relative(brainRoot, f).replace(/\\/g, "/");
    const raw = readFileSync(f, "utf8");
    const parsed = matter(raw);
    const text = `${parsed.data.title || ""}\n${parsed.content}`.slice(0, 4000);
    const sig = findEventSignal(text);
    if (!sig) continue;
    signals += 1;
    const eventName = sig.toUpperCase().includes("SXSW")
      ? "SXSW"
      : sig.replace(/\s+/g, " ").trim();
    const eventPath = ensureEventPage(brainRoot, eventName, mode);
    const date = inferDate(text);
    const title = String(parsed.data.title || basename(f, ".md"));
    const line = `- **${date}** | Signal from [${title}](../${rel}) — matched "${sig}".`;
    if (appendUniqueTimeline(eventPath, line, mode) && !touched.has(eventPath)) {
      touched.add(eventPath);
      pagesTouched += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        mode,
        scannedFiles: files.length,
        signals,
        eventPagesTouched: pagesTouched,
      },
      null,
      2,
    ),
  );
}

const modeArg = process.argv[2] === "apply" ? "apply" : "dry-run";
const root = process.argv[3] || join(process.env.HOME || "/Users/jarvis", "brain");
run(modeArg, root);
