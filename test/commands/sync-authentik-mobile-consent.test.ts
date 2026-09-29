import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  pythonStringLiteral,
  renderMobileConsentExpression,
  MOBILE_CONSENT_MARKER,
} from '../../src/commands/networking/sync-authentik.ts';

// Probe once for a usable python interpreter (python3, then python -- Windows
// often only has `python`). Neither present means the cross-check tests skip
// rather than fail, keeping the suite deterministic without depending on
// python being installed.
function detectPython(): string | null {
  for (const candidate of ['python3', 'python']) {
    try {
      const result = spawnSync(candidate, ['--version']);
      if (result.status === 0) return candidate;
    } catch {
      // not found -- try the next candidate
    }
  }
  return null;
}

const PYTHON = detectPython();

describe('pythonStringLiteral', () => {
  test('renders a plain ASCII string as a double-quoted literal', () => {
    assert.equal(pythonStringLiteral('app.example:///oauth-callback'), '"app.example:///oauth-callback"');
  });

  test('escapes backslash, double quote, newline, carriage return, tab', () => {
    assert.equal(pythonStringLiteral('\\"\n\r\t'), '"\\\\\\"\\n\\r\\t"');
  });

  test('leaves printable ASCII 0x20-0x7E literal', () => {
    const printable = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
    const rendered = pythonStringLiteral(printable);
    // Only the characters this function itself escapes (\, ") should gain a
    // backslash; everything else must appear byte-for-byte.
    const expected = '"' + printable.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    assert.equal(rendered, expected);
  });

  test('escapes a non-ASCII code point <= 0xFF as \\xHH, lowercase hex', () => {
    assert.equal(pythonStringLiteral('é'), '"\\xe9"');
  });

  test('escapes a non-ASCII BMP code point above 0xFF as \\uHHHH, lowercase hex', () => {
    // U+0100 (Ā) is above the \xHH range (0x00-0xFF) but within the BMP.
    assert.equal(pythonStringLiteral('Ā'), '"\\u0100"');
  });

  test('escapes a code point above U+FFFF as \\UHHHHHHHH, not a surrogate pair', () => {
    // '😀' is U+1F600, encoded in UTF-16 as a surrogate pair. JSON.stringify
    // would emit \ud83d\ude00 (two lone-surrogate escapes when decoded by
    // Python); pythonStringLiteral must iterate code points and emit the one
    // \U escape instead.
    const rendered = pythonStringLiteral('😀');
    assert.equal(rendered, '"\\U0001f600"');
    assert.ok(!/\\u[dD][89abAB][0-9a-fA-F]{2}/.test(rendered), 'must not contain a surrogate-half \\u escape');
  });

  test('escapes a control character below 0x20 (other than \\n\\r\\t) as \\xHH', () => {
    assert.equal(pythonStringLiteral('\x01'), '"\\x01"');
  });

  test('escapes DEL (0x7F, just above printable ASCII) as \\xHH', () => {
    assert.equal(pythonStringLiteral('\x7f'), '"\\x7f"');
  });

  test('combined: quote, backslash, newline, accented letter, emoji', () => {
    const rendered = pythonStringLiteral('"back\\slash"\nover é 😀');
    assert.equal(rendered, '"\\"back\\\\slash\\"\\nover \\xe9 \\U0001f600"');
  });

  if (PYTHON) {
    test('cross-check: python ast.literal_eval round-trips a mixed string', () => {
      const original = '"quoted"\\slash\nnewline\ttab é 😀';
      const literal = pythonStringLiteral(original);
      const result = spawnSync(PYTHON, ['-c', 'import sys,ast; print(ast.literal_eval(sys.stdin.read()), end="")'], {
        input: literal,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, original);
    });

    test('cross-check: python ast.literal_eval round-trips an emoji-only string', () => {
      const original = '😀😀';
      const literal = pythonStringLiteral(original);
      const result = spawnSync(PYTHON, ['-c', 'import sys,ast; print(ast.literal_eval(sys.stdin.read()), end="")'], {
        input: literal,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, original);
    });
  } else {
    test('cross-check: python ast.literal_eval round-trips (skipped)', { skip: 'python not available' }, () => {});
  }
});

describe('renderMobileConsentExpression', () => {
  test('exact rendered text for two URIs, sorted', () => {
    const rendered = renderMobileConsentExpression([
      'https://books.example.com/auth/openid/mobile-redirect',
      'app.example:///oauth-callback',
    ]);
    assert.equal(
      rendered,
      [
        '# Managed by Bellhop (sync-authentik). Changes made here are overwritten.',
        '# Asks for consent only when the login hands off to a mobile app redirect URI.',
        'MOBILE_REDIRECT_URIS = {',
        '    "app.example:///oauth-callback",',
        '    "https://books.example.com/auth/openid/mobile-redirect",',
        '}',
        'params = request.context.get("goauthentik.io/providers/oauth2/params")',
        'return getattr(params, "redirect_uri", None) in MOBILE_REDIRECT_URIS',
      ].join('\n')
    );
  });

  test('sorting makes input order irrelevant', () => {
    const uris = ['https://books.example.com/auth/openid/mobile-redirect', 'app.example:///oauth-callback'];
    const forward = renderMobileConsentExpression(uris);
    const reversed = renderMobileConsentExpression([...uris].reverse());
    assert.equal(forward, reversed);
  });

  test('a URI with quote, backslash, newline, accented letter and emoji escapes correctly', () => {
    const tricky = 'app.example:///cb?state="a\\b"\né😀';
    const rendered = renderMobileConsentExpression([tricky]);
    assert.ok(rendered.includes(pythonStringLiteral(tricky) + ','));
  });

  test('starts with MOBILE_CONSENT_MARKER', () => {
    const rendered = renderMobileConsentExpression(['app.example:///oauth-callback']);
    assert.ok(rendered.startsWith(MOBILE_CONSENT_MARKER));
  });

  test('renders an empty set as set(), not {}', () => {
    const rendered = renderMobileConsentExpression([]);
    assert.ok(rendered.includes('MOBILE_REDIRECT_URIS = set()'));
    assert.ok(!rendered.includes('MOBILE_REDIRECT_URIS = {}'));
  });

  test('empty-set rendering still starts with the marker and ends with the return line', () => {
    const rendered = renderMobileConsentExpression([]);
    assert.ok(rendered.startsWith(MOBILE_CONSENT_MARKER));
    assert.ok(rendered.endsWith('return getattr(params, "redirect_uri", None) in MOBILE_REDIRECT_URIS'));
  });

  if (PYTHON) {
    test('cross-check: rendered expression is valid python (two URIs)', () => {
      const rendered = renderMobileConsentExpression([
        'https://books.example.com/auth/openid/mobile-redirect',
        'app.example:///oauth-callback',
      ]);
      // Wrap in a function so the bare `return` is legal, and call it with a
      // request stub carrying no matching context key -- exercises getattr's
      // None default and confirms the module compiles/executes cleanly.
      const script = [
        'import sys',
        'class Ctx:',
        '    def get(self, key):',
        '        return None',
        'class Request:',
        '    context = Ctx()',
        'request = Request()',
        'def check():',
        ...rendered.split('\n').map((line) => '    ' + line),
        'print(check())',
      ].join('\n');
      const result = spawnSync(PYTHON, ['-c', script], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'False');
    });

    test('cross-check: rendered expression is valid python (empty set)', () => {
      const rendered = renderMobileConsentExpression([]);
      const script = [
        'class Ctx:',
        '    def get(self, key):',
        '        return None',
        'class Request:',
        '    context = Ctx()',
        'request = Request()',
        'def check():',
        ...rendered.split('\n').map((line) => '    ' + line),
        'print(check())',
      ].join('\n');
      const result = spawnSync(PYTHON, ['-c', script], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'False');
    });
  } else {
    test('cross-check: rendered expression is valid python (skipped)', { skip: 'python not available' }, () => {});
  }
});
