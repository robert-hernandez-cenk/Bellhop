import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cssPath = new URL('../../web-client/src/index.css', import.meta.url);
const css = readFileSync(cssPath, 'utf8');

/**
 * Declaration text of the rule whose selector, at the start of a line, is
 * exactly `selector`. Requiring the opening brace right after the selector
 * keeps `.field-help-popover` from matching `.field-help-popover-anchored`.
 */
function ruleDeclarations(selector: string): string {
  let from = 0;
  for (;;) {
    const idx = css.indexOf(`\n${selector}`, from);
    if (idx === -1) throw new Error(`rule not found: ${selector}`);
    const afterSelector = idx + 1 + selector.length;
    const brace = css.slice(afterSelector).match(/^\s*\{/);
    if (brace) {
      const start = afterSelector + brace[0].length;
      return css.slice(start, css.indexOf('}', start));
    }
    from = idx + 1;
  }
}

function hasDeclaration(decls: string, property: string, value?: string): boolean {
  return decls.split(';').some((d) => {
    const [p, ...rest] = d.split(':');
    if (p.trim() !== property) return false;
    return value === undefined || rest.join(':').trim() === value;
  });
}

// Issue #75: the Update page's badge explanation is anchored to its marker
// with position: fixed, sized to its content -- not laid out against
// whatever positioned ancestor happens to exist.
test('.field-help-popover-anchored is fixed, content-sized and capped', () => {
  const decls = ruleDeclarations('.field-help-popover-anchored');
  assert.ok(hasDeclaration(decls, 'position', 'fixed'));
  assert.ok(hasDeclaration(decls, 'width', 'max-content'));
  assert.ok(hasDeclaration(decls, 'right', 'auto'));
  assert.ok(hasDeclaration(decls, 'max-width'));
});

// The Advanced modal's row layout is unchanged.
test('.field-help-popover still spans its row', () => {
  const decls = ruleDeclarations('.field-help-popover');
  assert.ok(hasDeclaration(decls, 'position', 'absolute'));
  assert.ok(hasDeclaration(decls, 'left', '0'));
  assert.ok(hasDeclaration(decls, 'right', '0'));
});
