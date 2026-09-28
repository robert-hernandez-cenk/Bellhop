import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cssPath = new URL('../../web-client/src/index.css', import.meta.url);
const css = readFileSync(cssPath, 'utf8');

const jobViewPath = new URL('../../web-client/src/pages/JobView.tsx', import.meta.url);
const jobViewSource = readFileSync(jobViewPath, 'utf8');

/**
 * Returns the declaration block text (without the surrounding braces) of the
 * first rule whose selector matches `selector` exactly as written in the
 * file. When `scope` is given (e.g. `@media (max-width: 640px)`), only looks
 * inside that media block, found by brace matching from the `@media` line
 * that starts with it.
 */
function ruleDeclarations(source: string, selector: string, scope?: string): string {
  let searchIn = source;
  if (scope !== undefined) {
    const scopeIndex = source.indexOf(scope);
    if (scopeIndex === -1) {
      throw new Error(`scope not found: ${scope}`);
    }
    const openBrace = source.indexOf('{', scopeIndex);
    if (openBrace === -1) {
      throw new Error(`no opening brace for scope: ${scope}`);
    }
    let depth = 0;
    let end = -1;
    for (let i = openBrace; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      throw new Error(`unterminated scope block: ${scope}`);
    }
    searchIn = source.slice(openBrace + 1, end);
  }

  // Find the selector followed (optionally by whitespace) by an opening
  // brace, searching the whole scope text directly (not line-by-line) so
  // index arithmetic never mixes a line-local offset with a whole-string one.
  let fromIndex = 0;
  while (fromIndex <= searchIn.length) {
    const idx = searchIn.indexOf(selector, fromIndex);
    if (idx === -1) break;
    const afterSelector = searchIn.slice(idx + selector.length);
    const braceMatch = afterSelector.match(/^\s*\{/);
    if (braceMatch) {
      const openBrace = idx + selector.length + braceMatch[0].length - 1;
      let depth = 0;
      let declStart = -1;
      let declEnd = -1;
      for (let j = openBrace; j < searchIn.length; j++) {
        const ch = searchIn[j];
        if (ch === '{') {
          depth++;
          if (depth === 1) declStart = j + 1;
        } else if (ch === '}') {
          depth--;
          if (depth === 0) {
            declEnd = j;
            break;
          }
        }
      }
      if (declStart !== -1 && declEnd !== -1) {
        return searchIn.slice(declStart, declEnd);
      }
    }
    fromIndex = idx + selector.length;
  }
  throw new Error(`selector not found: ${selector}${scope ? ` (scoped to ${scope})` : ''}`);
}

test('.job-header declares flex-wrap: wrap', () => {
  const decl = ruleDeclarations(css, '.job-header ');
  assert.match(decl, /flex-wrap:\s*wrap/);
});

test('.job-header-main declares min-width: 0 and overflow-wrap: anywhere', () => {
  const decl = ruleDeclarations(css, '.job-header-main ');
  assert.match(decl, /min-width:\s*0/);
  assert.match(decl, /overflow-wrap:\s*anywhere/);
});

test('.job-status-badge declares white-space: nowrap', () => {
  const decl = ruleDeclarations(css, '.job-status-badge ');
  assert.match(decl, /white-space:\s*nowrap/);
});

test('JobView.tsx contains className="job-header-main"', () => {
  assert.match(jobViewSource, /className="job-header-main"/);
});

test('.data-table tbody td inside the 640px mobile media block declares overflow-wrap: anywhere and text-align: right', () => {
  const decl = ruleDeclarations(css, '.data-table tbody td ', '@media (max-width: 640px)');
  assert.match(decl, /overflow-wrap:\s*anywhere/);
  assert.match(decl, /text-align:\s*right/);
});

test('.prompt-banner-freetext input declares min-width: 0', () => {
  const decl = ruleDeclarations(css, '.prompt-banner-freetext input ');
  assert.match(decl, /min-width:\s*0/);
});
