import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Documentation link check (specs/013-condense-readme-docs/contracts/link-check.md).
// Scans README.md, CONTRIBUTING.md, CLAUDE.md and every *.md under docs/, and
// fails once listing every
// relative link or anchor that no longer resolves.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const README_LINE_LIMIT = 200;

function markdownFiles(): string[] {
  // CONTRIBUTING.md and CLAUDE.md link into the README (#prerequisites,
  // #setup), so renaming one of its headings must fail here too.
  const files = ['README.md', 'CONTRIBUTING.md', 'CLAUDE.md'].map((name) => join(REPO_ROOT, name));
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
    }
  };
  walk(join(REPO_ROOT, 'docs'));
  return files;
}

function countLines(text: string): number {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

// Returns each line's text, or null for a line inside (or delimiting) a
// fenced code block.
function proseLines(text: string): (string | null)[] {
  const out: (string | null)[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && match[2].trim() === '') {
        fence = null;
      }
      out.push(null);
    } else if (match && !(match[1][0] === '`' && match[2].includes('`'))) {
      fence = { char: match[1][0], length: match[1].length };
      out.push(null);
    } else {
      out.push(line);
    }
  }
  return out;
}

function stripCodeSpans(line: string): string {
  return line.replace(/(`+)[\s\S]*?\1/g, '');
}

function headingText(line: string): string | null {
  const match = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
  if (!match) return null;
  return match[1] ?? '';
}

function renderHeading(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\*\*/g, '');
}

function githubSlug(text: string, seen: Map<string, number> = new Map()): string {
  const base = renderHeading(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
  let slug = base;
  let count = seen.get(base) ?? 0;
  while (seen.has(slug)) {
    count += 1;
    slug = `${base}-${count}`;
  }
  seen.set(base, count);
  seen.set(slug, seen.get(slug) ?? 0);
  return slug;
}

function headingSlugs(text: string): Set<string> {
  const seen = new Map<string, number>();
  const slugs = new Set<string>();
  for (const line of proseLines(text)) {
    if (line === null) continue;
    const heading = headingText(line);
    if (heading !== null) slugs.add(githubSlug(heading, seen));
  }
  return slugs;
}

function linkTargets(text: string): string[] {
  const targets: string[] = [];
  const linkPattern = /\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  for (const line of proseLines(text)) {
    if (line === null) continue;
    for (const match of stripCodeSpans(line).matchAll(linkPattern)) {
      targets.push(match[1] ?? match[2]);
    }
  }
  return targets;
}

function brokenLinks(files: string[]): string[] {
  const slugCache = new Map<string, Set<string>>();
  const slugsOf = (file: string): Set<string> => {
    let slugs = slugCache.get(file);
    if (!slugs) {
      slugs = headingSlugs(readFileSync(file, 'utf8'));
      slugCache.set(file, slugs);
    }
    return slugs;
  };

  const breaks: string[] = [];
  for (const file of files) {
    const source = relative(REPO_ROOT, file).replace(/\\/g, '/');
    for (const target of linkTargets(readFileSync(file, 'utf8'))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const hashIndex = target.indexOf('#');
      const pathPart = hashIndex === -1 ? target : target.slice(0, hashIndex);
      const anchor = hashIndex === -1 ? '' : target.slice(hashIndex + 1);
      const resolved = pathPart === '' ? file : resolve(dirname(file), decodeURIComponent(pathPart));
      if (!existsSync(resolved)) {
        breaks.push(`${source}: ${target} (missing file)`);
        continue;
      }
      if (anchor !== '' && resolved.endsWith('.md') && statSync(resolved).isFile()) {
        const wanted = decodeURIComponent(anchor);
        if (!slugsOf(resolved).has(wanted)) {
          breaks.push(`${source}: ${target} (no heading "#${wanted}")`);
        }
      }
    }
  }
  return breaks;
}

test('githubSlug follows GitHub heading-anchor rules', () => {
  assert.equal(githubSlug('nginx driver'), 'nginx-driver');
  assert.equal(githubSlug('`proxyDriver` setting'), 'proxydriver-setting');
  assert.equal(
    githubSlug('Inventory-wide settings (before your first sync)'),
    'inventory-wide-settings-before-your-first-sync',
  );
  assert.equal(githubSlug('Upgrading from the Caddy-only version'), 'upgrading-from-the-caddy-only-version');
  assert.equal(githubSlug('See [the docs](docs/x.md) **now**'), 'see-the-docs-now');
});

test('duplicate headings in one file get -1, -2 suffixes', () => {
  const slugs = headingSlugs('# Setup\n\n## Setup\n\n### Setup\n');
  assert.deepEqual([...slugs], ['setup', 'setup-1', 'setup-2']);
});

test('headings and links inside fenced code blocks are ignored', () => {
  const text = '# Real\n\n```md\n# Fake\n[x](missing.md)\n```\n\n~~~~\n[y](gone.md)\n~~~~\n`[z](nope.md)` [ok](#real)\n';
  assert.deepEqual([...headingSlugs(text)], ['real']);
  assert.deepEqual(linkTargets(text), ['#real']);
});

test(`README.md stays within its ${README_LINE_LIMIT}-line budget`, () => {
  const lines = countLines(readFileSync(join(REPO_ROOT, 'README.md'), 'utf8'));
  assert.ok(
    lines <= README_LINE_LIMIT,
    `README.md has ${lines} lines; the limit is ${README_LINE_LIMIT}`,
  );
});

test('every relative link and anchor in README.md, docs/ and the contributor docs resolves', () => {
  const breaks = brokenLinks(markdownFiles());
  assert.equal(breaks.length, 0, `Broken documentation links:\n${breaks.join('\n')}`);
});
