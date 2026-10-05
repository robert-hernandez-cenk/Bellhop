import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triggeredByLabel } from '../../web-client/src/lib/job-display.ts';

// The job list's "triggered by" cell (#65/#66): who, as which group when
// impersonating, and from which front end.
test('triggeredByLabel names the user and the front end', () => {
  assert.equal(triggeredByLabel({ triggeredByUsername: 'admin', triggeredByImpersonating: null, triggeredVia: 'mcp' }), 'admin via MCP');
  assert.equal(triggeredByLabel({ triggeredByUsername: 'admin', triggeredByImpersonating: null, triggeredVia: 'web' }), 'admin via web UI');
  assert.equal(
    triggeredByLabel({ triggeredByUsername: 'admin', triggeredByImpersonating: 'bellhop-viewers', triggeredVia: 'web' }),
    'admin (as: bellhop-viewers) via web UI'
  );
});

test('older rows and scheduled runs show no front end', () => {
  assert.equal(triggeredByLabel({ triggeredByUsername: 'scheduler', triggeredByImpersonating: null, triggeredVia: null }), 'scheduler');
  assert.equal(triggeredByLabel({ triggeredByUsername: null, triggeredByImpersonating: null, triggeredVia: null }), '—');
});
