#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import matter from 'gray-matter';

type Mode = 'dry-run' | 'apply';

type PageIndexEntry = {
  slug: string;
  relPath: string;
  absPath: string;
  dir: string;
  title: string;
  aliases: string[];
};

type FileChange = {
  relPath: string;
  typeAdded?: string;
  linkConversions: number;
  timelineConversions: number;
  unresolvedLinks: Array<{
    raw: string;
    normalized: string;
    reason: 'not_found' | 'ambiguous' | 'self';
    candidates?: string[];
  }>;
};

type Summary = {
  mode: Mode;
  root: string;
  filesScanned: number;
  filesChanged: number;
  changedFilesOmitted: number;
  frontmatterTypesAdded: number;
  linkConversions: number;
  timelineConversions: number;
  unresolvedLinks: number;
  ambiguousLinks: number;
  notFoundLinks: number;
  selfLinksSkipped: number;
  changedFiles: FileChange[];
};

const TYPE_BY_DIR: Record<string, string> = {
  people: 'person',
  companies: 'company',
  meetings: 'meeting',
  concepts: 'concept',
  sources: 'source',
  deals: 'deal',
  projects: 'project',
  ideas: 'idea',
  media: 'media',
  programs: 'program',
  org: 'org',
  civic: 'civic',
  personal: 'personal',
  household: 'household',
  hiring: 'hiring',
  writing: 'writing',
};

const SKIP_BASENAMES = new Set(['README.md', 'RESOLVER.md', 'schema.md', 'index.md', 'log.md']);
const ENTITY_DIRS = new Set(['people', 'companies', 'meetings', 'concepts', 'sources', 'deals', 'projects', 'ideas', 'media']);
const WIKILINK_RE = /\[\[([^|\]#]+?)(?:#[^|\]]*?)?(?:\|([^\]]+?))?\]\]/g;
const SIMPLE_TIMELINE_RE = /^(\s*[-*]\s*)(\d{4}-\d{2}-\d{2})(\s*[|–—-]\s*.+)$/;

function main() {
  const mode = parseMode(process.argv[2] || 'dry-run');
  const root = process.argv[3] || join(process.env.HOME || '/Users/jarvis', 'brain');
  const enableTypePromotion = process.argv.includes('--promote-types');
  if (!existsSync(root)) {
    console.error(`Brain root not found: ${root}`);
    process.exit(1);
  }

  const files = walkMarkdown(root);
  const index = buildPageIndex(root, files);
  const titleMap = buildNameMap(index, 'title');
  const slugMap = buildNameMap(index, 'slug');
  const aliasMap = buildAliasMap(index);

  const summary: Summary = {
    mode,
    root,
    filesScanned: 0,
    filesChanged: 0,
    changedFilesOmitted: 0,
    frontmatterTypesAdded: 0,
    linkConversions: 0,
    timelineConversions: 0,
    unresolvedLinks: 0,
    ambiguousLinks: 0,
    notFoundLinks: 0,
    selfLinksSkipped: 0,
    changedFiles: [],
  };

  for (const absPath of files) {
    const relPath = relative(root, absPath).replace(/\\/g, '/');
    summary.filesScanned += 1;
    const original = readFileSync(absPath, 'utf8');
    const topDir = relPath.split('/')[0] || '';

    let next = rewriteLinks(original, relPath, root, index, titleMap, slugMap, aliasMap);
    next = normalizeTimelineLines(next);

    const parsed = safeMatter(next);
    const currentType = typeof parsed.data.type === 'string' ? parsed.data.type : '';
    const inferredType = TYPE_BY_DIR[topDir];
    let typeAdded: string | undefined;
    if (enableTypePromotion && !currentType && inferredType) {
      parsed.data.type = inferredType;
      typeAdded = inferredType;
      next = matter.stringify(parsed.content, parsed.data);
    }

    const fileChange: FileChange = {
      relPath,
      typeAdded,
      linkConversions: (next.match(/\]\((?:\.\.\/)*[a-z]+\/[^)]+\.md\)/g) || []).length - (original.match(/\]\((?:\.\.\/)*[a-z]+\/[^)]+\.md\)/g) || []).length,
      timelineConversions: countTimelineConversions(original, next),
      unresolvedLinks: (rewriteLinks as any).lastUnresolved ?? [],
    };
    fileChange.linkConversions = (rewriteLinks as any).lastConversions ?? 0;

    if (fileChange.typeAdded) summary.frontmatterTypesAdded += 1;
    summary.linkConversions += fileChange.linkConversions;
    summary.timelineConversions += fileChange.timelineConversions;
    for (const unresolved of fileChange.unresolvedLinks) {
      summary.unresolvedLinks += 1;
      if (unresolved.reason === 'ambiguous') summary.ambiguousLinks += 1;
      if (unresolved.reason === 'not_found') summary.notFoundLinks += 1;
      if (unresolved.reason === 'self') summary.selfLinksSkipped += 1;
    }

    if (next !== original) {
      summary.filesChanged += 1;
      if (summary.changedFiles.length < 500) {
        summary.changedFiles.push(fileChange);
      } else {
        summary.changedFilesOmitted += 1;
      }
      if (mode === 'apply') writeFileSync(absPath, next, 'utf8');
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

function parseMode(input: string): Mode {
  if (input === 'apply') return 'apply';
  return 'dry-run';
}

function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const abs = join(dir, name);
      const rel = relative(root, abs).replace(/\\/g, '/');
      if (rel.includes('/.raw/') || rel.endsWith('/.raw')) continue;
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!name.endsWith('.md')) continue;
      if (SKIP_BASENAMES.has(name)) continue;
      out.push(abs);
    }
  }
  walk(root);
  return out;
}

function buildPageIndex(root: string, files: string[]): PageIndexEntry[] {
  const entries: PageIndexEntry[] = [];
  for (const absPath of files) {
    const relPath = relative(root, absPath).replace(/\\/g, '/');
    const dir = relPath.split('/')[0] || '';
    if (!ENTITY_DIRS.has(dir) && dir !== 'people' && dir !== 'companies') continue;
    const raw = readFileSync(absPath, 'utf8');
    const parsed = safeMatter(raw);
    const title = extractTitle(parsed.content) || String(parsed.data.title || basenameSlug(relPath));
    const aliases = Array.isArray(parsed.data.aliases)
      ? parsed.data.aliases.map(v => String(v)).filter(Boolean)
      : [];
    entries.push({
      slug: relPath.replace(/\.md$/i, ''),
      relPath,
      absPath,
      dir,
      title,
      aliases,
    });
  }
  return entries;
}

function safeMatter(raw: string): matter.GrayMatterFile<string> {
  try {
    return matter(raw);
  } catch {
    return {
      content: raw,
      data: {},
      excerpt: '',
      empty: raw.trim().length === 0,
      isEmpty: raw.trim().length === 0,
      orig: raw,
      language: 'yaml',
      matter: '',
      stringify(lang: string) {
        return lang;
      },
    } as matter.GrayMatterFile<string>;
  }
}

function buildNameMap(index: PageIndexEntry[], field: 'title' | 'slug'): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const entry of index) {
    const value = field === 'title' ? entry.title : basenameSlug(entry.relPath);
    const key = normalizeName(value);
    if (!key) continue;
    const list = map.get(key) || [];
    if (!list.includes(entry.slug)) list.push(entry.slug);
    map.set(key, list);
  }
  return map;
}

function buildAliasMap(index: PageIndexEntry[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const entry of index) {
    for (const alias of entry.aliases) {
      const key = normalizeName(alias);
      if (!key) continue;
      const list = map.get(key) || [];
      if (!list.includes(entry.slug)) list.push(entry.slug);
      map.set(key, list);
    }
  }
  return map;
}

function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function basenameSlug(relPath: string): string {
  return relPath.split('/').pop()!.replace(/\.md$/i, '');
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTimelineLines(raw: string): string {
  let inFence = false;
  return raw
    .split('\n')
    .map(line => {
      if (line.trim().startsWith('```')) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const rewritten = rewriteTimelineLine(line);
      return rewritten ?? line;
    })
    .join('\n');
}

function countTimelineConversions(before: string, after: string): number {
  const beforeCount = (before.match(SIMPLE_TIMELINE_RE_GLOBAL) || []).length;
  const afterCount = (after.match(SIMPLE_TIMELINE_RE_GLOBAL) || []).length;
  return Math.max(beforeCount - afterCount, 0);
}

const SIMPLE_TIMELINE_RE_GLOBAL = /^\s*[-*]\s*\d{4}-\d{2}-\d{2}\s*[|–—-]\s.+$/gm;

function rewriteLinks(
  raw: string,
  relPath: string,
  root: string,
  index: PageIndexEntry[],
  titleMap: Map<string, string[]>,
  slugMap: Map<string, string[]>,
  aliasMap: Map<string, string[]>,
): string {
  const currentSlug = relPath.replace(/\.md$/i, '');
  const entryBySlug = new Map(index.map(e => [e.slug, e]));
  const unresolved: FileChange['unresolvedLinks'] = [];
  let conversions = 0;
  let inFence = false;

  const next = raw
    .split('\n')
    .map(line => {
      if (line.trim().startsWith('```')) {
        inFence = !inFence;
        return line;
      }
      if (inFence || !line.includes('[[')) return line;
      return line.replace(WIKILINK_RE, (full, targetRaw: string, displayRaw?: string) => {
        const resolved = resolveWikilink(targetRaw, displayRaw, currentSlug, titleMap, slugMap, aliasMap);
        if (!resolved.slug) {
          unresolved.push({
            raw: full,
            normalized: normalizeName(targetRaw),
            reason: resolved.reason!,
            candidates: resolved.candidates,
          });
          return full;
        }
        const targetEntry = entryBySlug.get(resolved.slug);
        if (!targetEntry) {
          unresolved.push({
            raw: full,
            normalized: normalizeName(targetRaw),
            reason: 'not_found',
          });
          return full;
        }
        conversions += 1;
        const label = displayRaw?.trim() || targetEntry.title || targetRaw.trim();
        const linkPath = relative(dirname(join(root, relPath)), targetEntry.absPath).replace(/\\/g, '/');
        return `[${label}](${linkPath})`;
      });
    })
    .join('\n');

  (rewriteLinks as any).lastUnresolved = unresolved;
  (rewriteLinks as any).lastConversions = conversions;
  return next;
}

function resolveWikilink(
  targetRaw: string,
  displayRaw: string | undefined,
  currentSlug: string,
  titleMap: Map<string, string[]>,
  slugMap: Map<string, string[]>,
  aliasMap: Map<string, string[]>,
): { slug?: string; reason?: 'not_found' | 'ambiguous' | 'self'; candidates?: string[] } {
  let target = targetRaw.trim().replace(/\.md$/i, '');
  if (!target) return { reason: 'not_found' };
  if (target.includes('/')) {
    const slug = target.replace(/^\/+/, '');
    if (slug === currentSlug) return { reason: 'self', candidates: [slug] };
    return { slug };
  }

  const key = normalizeName(target);
  const candidateSet = new Set<string>();
  for (const map of [titleMap, slugMap, aliasMap]) {
    for (const slug of map.get(key) || []) candidateSet.add(slug);
  }
  const candidates = [...candidateSet];
  if (candidates.length === 0 && displayRaw) {
    const displayKey = normalizeName(displayRaw);
    for (const map of [titleMap, slugMap, aliasMap]) {
      for (const slug of map.get(displayKey) || []) candidateSet.add(slug);
    }
  }
  const finalCandidates = [...candidateSet];
  if (finalCandidates.length === 0) return { reason: 'not_found' };
  if (finalCandidates.length > 1) {
    const preferred = preferCanonicalSlug(finalCandidates);
    if (preferred) return { slug: preferred };
    return { reason: 'ambiguous', candidates: finalCandidates };
  }
  if (finalCandidates[0] === currentSlug) return { reason: 'self', candidates: finalCandidates };
  return { slug: finalCandidates[0] };
}

function preferCanonicalSlug(candidates: string[]): string | null {
  const noNumericSuffix = candidates.filter(c => !/-\d+$/.test(c));
  if (noNumericSuffix.length === 1) return noNumericSuffix[0];
  return null;
}

function rewriteTimelineLine(line: string): string | null {
  const alreadyGood = /^\s*[-*]\s+\*\*\d{4}-\d{2}-\d{2}\*\*\s*\|\s*.+\s+[—–-]\s*.+$/.test(line);
  if (alreadyGood) return null;

  const m = /^(\s*[-*]\s*)(?:\*\*)?(\d{4}-\d{2}-\d{2})(?:\*\*)?\s*([|–—-])\s*(.+?)\s*$/.exec(line);
  if (!m) return null;

  let summary = m[4].trim();
  const sources: string[] = [];
  summary = summary.replace(/`?\[Source:\s*([^\]]+?)\s*\]`?/g, (_full, source: string) => {
    sources.push(source.trim());
    return '';
  }).trim();
  summary = summary.replace(/\s+/g, ' ').trim();
  const source = sources.length > 0 ? sources.join('; ') : 'markdown';
  if (!summary) return null;
  return `${m[1]}**${m[2]}** | ${source} — ${summary}`;
}

main();
