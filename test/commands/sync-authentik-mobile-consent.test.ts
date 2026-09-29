import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  pythonStringLiteral,
  renderMobileConsentExpression,
  MOBILE_CONSENT_MARKER,
  MOBILE_CONSENT_STAGE_NAME,
  MOBILE_CONSENT_POLICY_NAME,
  runSyncAuthentik,
  syncAuthentikFailed,
  formatSyncAuthentik,
} from '../../src/commands/networking/sync-authentik.ts';
import type { Inventory } from '../../src/lib/inventory.ts';
import { authentikConfig } from '../../src/lib/authentik-config.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';

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

// ---------------------------------------------------------------------------
// T014: the mobile consent-step reconcile (research.md R6-R9)
// ---------------------------------------------------------------------------

const CONSENT_STAGE_MODEL = 'authentik_stages_consent.consentstage';
const EXPRESSION_POLICY_MODEL = 'authentik_policies_expression.expressionpolicy';
const LADDER = authentikConfig().groupLadder;
const USERS_RUNG = LADDER[2];
const WEB_URIS = ['https://media.example.com/oauth/callback'];
const MOBILE_A = 'app.example:///oauth-callback';
const MOBILE_B = 'https://media.example.com/mobile-redirect';
const HINT =
  " — check AUTHENTIK_AUTHORIZATION_FLOW_SLUG and the API token's stage/policy/flow permissions (README \"Authentik API token permissions\")";

// Every mutating consent-step call the fake logs. Group-binding writes
// (createPolicyBinding) never match, since each prefix ends in a space.
const CONSENT_WRITES = [
  'createConsentStage',
  'updateConsentStage',
  'deleteStage',
  'createExpressionPolicy',
  'updateExpressionPolicy',
  'deletePolicy',
  'createFlowStageBinding',
  'updateFlowStageBinding',
  'deleteFlowStageBinding',
  'createPolicyToTargetBinding',
  'deletePolicyBinding',
];
function consentWrites(authentik: FakeAuthentikClient, from = 0): string[] {
  return authentik.calls
    .slice(from)
    .filter((c) => c === 'clearFlowCache' || CONSENT_WRITES.some((m) => c.startsWith(`${m} `)));
}

type GuestOverrides = Partial<Inventory['guests'][number]>;

// One OIDC guest (`media`, carrying the mobile list) and one forward-auth
// guest (`sonarr`), so a test can check the rest of the run still applies.
function mobileInventory(
  mobile: string[] | undefined,
  media: GuestOverrides = {},
  extra: Inventory['guests'] = []
): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', authentik: true, ip: '192.0.2.5' }],
    guests: [
      {
        name: 'media',
        type: 'lxc',
        vmid: 130,
        host: 'pve1',
        ip: '192.0.2.30',
        subdomains: ['media'],
        authGroup: USERS_RUNG,
        authMode: 'oidc',
        oidcRedirectUris: WEB_URIS,
        ...(mobile ? { oidcMobileRedirectUris: mobile } : {}),
        ...media,
      },
      { name: 'sonarr', type: 'lxc', vmid: 131, host: 'pve1', ip: '192.0.2.31', subdomains: ['sonarr'], authGroup: USERS_RUNG },
      ...extra,
    ],
  };
}

function okFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ issuer: 'x' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

async function newClient(seed: ConstructorParameters<typeof FakeAuthentikClient>[0] = {}): Promise<FakeAuthentikClient> {
  const authentik = new FakeAuthentikClient(seed);
  for (const rung of LADDER) await authentik.createGroup(rung);
  return authentik;
}

function run(authentik: FakeAuthentikClient, inventory: Inventory, apply: boolean) {
  return runSyncAuthentik({ apply }, { authentik, inventory, fetchImpl: okFetch() });
}

const FOUR_CREATES = (count: number) => [
  { object: 'stage', action: 'create' },
  { object: 'policy', action: 'create', detail: `${count} mobile redirect URI(s)` },
  { object: 'binding', action: 'create' },
  { object: 'policy-binding', action: 'create' },
];

const OWNED_STAGE = { id: '500', name: MOBILE_CONSENT_STAGE_NAME, model: CONSENT_STAGE_MODEL, mode: 'always_require' };

// A client whose `method` starts throwing only after a first, clean apply has
// created both Applications (so the rest of the run no longer needs the flow
// lookup either) and an owned stage exists (so the binding listing is read).
async function failingAfterSetup(method: string): Promise<FakeAuthentikClient> {
  const failOn = new Set<string>();
  const authentik = await newClient({ failOn });
  await run(authentik, mobileInventory(undefined), true);
  await authentik.createConsentStage({ name: MOBILE_CONSENT_STAGE_NAME, mode: 'always_require' });
  failOn.add(method);
  return authentik;
}

describe('mobile consent reconcile', () => {
  test('no mobile URIs: no objects, no consent writes, an empty report on dry run and apply', async () => {
    const authentik = await newClient();
    const before = authentik.calls.length;
    for (const apply of [false, true]) {
      const result = await run(authentik, mobileInventory(undefined), apply);
      assert.deepEqual(result.mobileConsent, { uris: [], changes: [], conflicts: [] });
    }
    assert.deepEqual(consentWrites(authentik, before), []);
    assert.equal(authentik.cacheClears, 0);
    assert.deepEqual(authentik.listStagesForTest(), []);
    assert.deepEqual(authentik.listPoliciesForTest(), []);
  });

  test('first URI: the dry run lists 4 creates and writes nothing; apply creates exactly those with the right settings', async () => {
    const authentik = await newClient();
    const inventory = mobileInventory([MOBILE_B, MOBILE_A]);
    const before = authentik.calls.length;

    const dry = await run(authentik, inventory, false);
    assert.deepEqual(dry.mobileConsent?.uris, [MOBILE_B, MOBILE_A].sort());
    assert.deepEqual(dry.mobileConsent?.changes, FOUR_CREATES(2));
    assert.deepEqual(dry.mobileConsent?.conflicts, []);
    assert.deepEqual(authentik.calls.slice(before), [], 'a dry run makes no mutating call at all');
    assert.equal(authentik.cacheClears, 0);

    const applied = await run(authentik, inventory, true);
    assert.deepEqual(applied.mobileConsent?.changes, dry.mobileConsent?.changes, 'dry-run parity');
    assert.equal(applied.mobileConsent?.error, undefined);

    const stages = authentik.listStagesForTest();
    assert.equal(stages.length, 1);
    assert.equal(stages[0].name, MOBILE_CONSENT_STAGE_NAME);
    assert.equal(stages[0].model, CONSENT_STAGE_MODEL);
    assert.equal(stages[0].mode, 'always_require');

    const policies = authentik.listPoliciesForTest();
    assert.equal(policies.length, 1);
    assert.equal(policies[0].name, MOBILE_CONSENT_POLICY_NAME);
    assert.equal(policies[0].model, EXPRESSION_POLICY_MODEL);
    assert.equal(policies[0].expression, renderMobileConsentExpression([MOBILE_A, MOBILE_B]));

    const bindings = authentik.listFlowStageBindingsForTest();
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].flowId, 'default-flow');
    assert.equal(bindings[0].stageId, stages[0].id);
    assert.equal(bindings[0].order, 10);
    assert.equal(bindings[0].evaluateOnPlan, false);
    assert.equal(bindings[0].reEvaluatePolicies, true);

    // Created against the PolicyBindingModel pk (research R4), which the
    // listing is also queried by.
    const policyBindings = await authentik.listPolicyBindingsForTarget(bindings[0].policyBindingModelId);
    assert.equal(policyBindings.length, 1);
    assert.equal(policyBindings[0].policyId, policies[0].id);
    assert.ok(
      authentik.calls.includes(`createPolicyToTargetBinding ${bindings[0].policyBindingModelId} ${policies[0].id}`)
    );

    assert.equal(authentik.cacheClears, 1);
    assert.equal(consentWrites(authentik, before).at(-1), 'clearFlowCache');
    assert.equal(syncAuthentikFailed(applied), false);
  });

  test('a URI change updates only the policy, and clears the cache once', async () => {
    const authentik = await newClient();
    await run(authentik, mobileInventory([MOBILE_A]), true);
    const before = authentik.calls.length;
    const clears = authentik.cacheClears;

    const expected = [{ object: 'policy', action: 'update', detail: 'expression (2 mobile redirect URI(s))' }];
    const dry = await run(authentik, mobileInventory([MOBILE_A, MOBILE_B]), false);
    assert.deepEqual(dry.mobileConsent?.changes, expected);

    const applied = await run(authentik, mobileInventory([MOBILE_A, MOBILE_B]), true);
    assert.deepEqual(applied.mobileConsent?.changes, expected);
    const policy = authentik.listPoliciesForTest()[0];
    assert.deepEqual(consentWrites(authentik, before), [`updateExpressionPolicy ${policy.id}`, 'clearFlowCache']);
    assert.equal(policy.expression, renderMobileConsentExpression([MOBILE_A, MOBILE_B]));
    assert.equal(authentik.cacheClears, clears + 1);
  });

  test('a second identical apply makes zero changes and zero cache clears (SC-005)', async () => {
    const authentik = await newClient();
    const inventory = mobileInventory([MOBILE_A]);
    await run(authentik, inventory, true);
    const before = authentik.calls.length;
    const clears = authentik.cacheClears;

    const second = await run(authentik, inventory, true);
    assert.deepEqual(second.mobileConsent, { uris: [MOBILE_A], changes: [], conflicts: [] });
    assert.deepEqual(consentWrites(authentik, before), []);
    assert.equal(authentik.cacheClears, clears);
  });

  test('the same URI on two OIDC entries is listed once', async () => {
    const authentik = await newClient();
    const inventory = mobileInventory([MOBILE_A], {}, [
      {
        name: 'books',
        type: 'lxc',
        vmid: 132,
        host: 'pve1',
        ip: '192.0.2.32',
        subdomains: ['books'],
        authGroup: USERS_RUNG,
        authMode: 'oidc',
        oidcRedirectUris: ['https://books.example.com/callback'],
        oidcMobileRedirectUris: [MOBILE_A, MOBILE_B],
      },
    ]);
    const dry = await run(authentik, inventory, false);
    assert.deepEqual(dry.mobileConsent?.uris, [MOBILE_A, MOBILE_B].sort());
    assert.deepEqual(dry.mobileConsent?.changes, FOUR_CREATES(2));
  });

  test('drift on the stage mode and the binding flags is repaired', async () => {
    const authentik = await newClient();
    const inventory = mobileInventory([MOBILE_A]);
    await run(authentik, inventory, true);
    const stage = authentik.listStagesForTest()[0];
    const binding = authentik.listFlowStageBindingsForTest()[0];
    await authentik.updateConsentStage(stage.id, { mode: 'permanent' });
    await authentik.updateFlowStageBinding(binding.id, { evaluateOnPlan: true, reEvaluatePolicies: false });
    const before = authentik.calls.length;
    const clears = authentik.cacheClears;

    const expected = [
      { object: 'stage', action: 'update', detail: 'mode' },
      { object: 'binding', action: 'update', detail: 'evaluate_on_plan, re_evaluate_policies' },
    ];
    const dry = await run(authentik, inventory, false);
    assert.deepEqual(dry.mobileConsent?.changes, expected);
    const applied = await run(authentik, inventory, true);
    assert.deepEqual(applied.mobileConsent?.changes, expected);

    assert.equal(authentik.listStagesForTest()[0].mode, 'always_require');
    const repaired = authentik.listFlowStageBindingsForTest()[0];
    assert.equal(repaired.evaluateOnPlan, false);
    assert.equal(repaired.reEvaluatePolicies, true);
    assert.deepEqual(consentWrites(authentik, before), [
      `updateConsentStage ${stage.id}`,
      `updateFlowStageBinding ${binding.id}`,
      'clearFlowCache',
    ]);
    assert.equal(authentik.cacheClears, clears + 1);
  });

  test('a stage-only prior state creates the other 3 objects, not a second stage', async () => {
    const authentik = await newClient({ stages: [OWNED_STAGE] });
    const inventory = mobileInventory([MOBILE_A]);
    const expected = FOUR_CREATES(1).slice(1);
    const dry = await run(authentik, inventory, false);
    assert.deepEqual(dry.mobileConsent?.changes, expected);
    const applied = await run(authentik, inventory, true);
    assert.deepEqual(applied.mobileConsent?.changes, expected);
    assert.equal(authentik.listStagesForTest().length, 1);
    assert.equal(authentik.listFlowStageBindingsForTest()[0].stageId, '500');
    assert.equal(authentik.listTargetPolicyBindingsForTest().length, 1);
  });

  test('a binding of the owned stage on a different flow is ignored; one is created on the configured flow', async () => {
    const authentik = await newClient({
      stages: [OWNED_STAGE],
      flowStageBindings: [
        {
          id: '501',
          policyBindingModelId: '502',
          flowId: 'other-flow',
          stageId: '500',
          order: 10,
          evaluateOnPlan: false,
          reEvaluatePolicies: true,
        },
      ],
    });
    const applied = await run(authentik, mobileInventory([MOBILE_A]), true);
    assert.deepEqual(applied.mobileConsent?.changes, FOUR_CREATES(1).slice(1));
    const onFlow = authentik.listFlowStageBindingsForTest().filter((b) => b.flowId === 'default-flow');
    assert.equal(onFlow.length, 1);
    assert.equal(authentik.listFlowStageBindingsForTest().length, 2, "the other flow's binding is left alone");
  });

  test('a partial failure (binding create fails) is completed by the next run without duplicates', async () => {
    const failOn = new Set(['createFlowStageBinding']);
    const authentik = await newClient({ failOn });
    const inventory = mobileInventory([MOBILE_A]);
    const first = await run(authentik, inventory, true);
    assert.deepEqual(first.mobileConsent?.changes, FOUR_CREATES(1).slice(0, 2), 'reports only what was made');
    assert.match(first.mobileConsent?.error ?? '', /forced failure for createFlowStageBinding/);

    failOn.delete('createFlowStageBinding');
    const second = await run(authentik, inventory, true);
    assert.deepEqual(second.mobileConsent?.changes, FOUR_CREATES(1).slice(2));
    assert.equal(second.mobileConsent?.error, undefined);
    assert.equal(authentik.listStagesForTest().length, 1);
    assert.equal(authentik.listPoliciesForTest().length, 1);
    assert.equal(authentik.listFlowStageBindingsForTest().length, 1);
    assert.equal(authentik.listTargetPolicyBindingsForTest().length, 1);
  });

  test('a failed policy-binding create rolls back the stage binding this run created, then the next run completes', async () => {
    const failOn = new Set(['createPolicyToTargetBinding']);
    const authentik = await newClient({ failOn });
    const inventory = mobileInventory([MOBILE_A]);
    const first = await run(authentik, inventory, true);
    // An unguarded stage binding would show the consent page on every login.
    assert.deepEqual(authentik.listFlowStageBindingsForTest(), []);
    assert.deepEqual(first.mobileConsent?.changes, FOUR_CREATES(1).slice(0, 2), 'only what remains done');
    assert.match(first.mobileConsent?.error ?? '', /forced failure for createPolicyToTargetBinding/);
    assert.equal(syncAuthentikFailed(first), true);
    const writes = consentWrites(authentik);
    const bindingDelete = writes.findIndex((c) => c.startsWith('deleteFlowStageBinding '));
    assert.ok(bindingDelete >= 0, 'the new binding is deleted');
    assert.ok(writes.indexOf('clearFlowCache', bindingDelete) > bindingDelete, 'cache cleared after the rollback');

    failOn.delete('createPolicyToTargetBinding');
    const second = await run(authentik, inventory, true);
    assert.deepEqual(second.mobileConsent?.changes, FOUR_CREATES(1).slice(2));
    assert.equal(authentik.listStagesForTest().length, 1);
    assert.equal(authentik.listPoliciesForTest().length, 1);
    assert.equal(authentik.listFlowStageBindingsForTest().length, 1);
    assert.equal(authentik.listTargetPolicyBindingsForTest().length, 1);
  });

  test('a failed policy-binding create leaves a pre-existing stage binding in place', async () => {
    const failOn = new Set<string>();
    const authentik = await newClient({ failOn });
    const inventory = mobileInventory([MOBILE_A]);
    await run(authentik, inventory, true);
    const policyBinding = authentik.listTargetPolicyBindingsForTest()[0];
    await authentik.deletePolicyBinding(policyBinding.id);
    const binding = authentik.listFlowStageBindingsForTest()[0];
    failOn.add('createPolicyToTargetBinding');
    const before = authentik.calls.length;

    const applied = await run(authentik, inventory, true);
    assert.deepEqual(applied.mobileConsent?.changes, []);
    assert.match(applied.mobileConsent?.error ?? '', /forced failure for createPolicyToTargetBinding/);
    assert.deepEqual(authentik.listFlowStageBindingsForTest(), [binding], 'the existing binding is not rolled back');
    assert.deepEqual(consentWrites(authentik, before), []);
  });

  const removals: Array<[string, GuestOverrides]> = [
    ['the last URI is removed', { oidcMobileRedirectUris: [] }],
    ['the entry leaves OIDC mode', { authMode: 'forward' }],
  ];
  for (const [label, media] of removals) {
    test(`${label}: all 4 are deleted in order, then the cache is cleared`, async () => {
      const authentik = await newClient();
      await run(authentik, mobileInventory([MOBILE_A]), true);
      const stage = authentik.listStagesForTest()[0];
      const policy = authentik.listPoliciesForTest()[0];
      const binding = authentik.listFlowStageBindingsForTest()[0];
      const policyBinding = authentik.listTargetPolicyBindingsForTest()[0];
      const before = authentik.calls.length;
      const clears = authentik.cacheClears;

      const expected = [
        { object: 'policy-binding', action: 'delete' },
        { object: 'binding', action: 'delete' },
        { object: 'policy', action: 'delete' },
        { object: 'stage', action: 'delete' },
      ];
      const inventory = mobileInventory([MOBILE_A], media);
      const dry = await run(authentik, inventory, false);
      assert.deepEqual(dry.mobileConsent, { uris: [], changes: expected, conflicts: [] });

      const applied = await run(authentik, inventory, true);
      assert.deepEqual(applied.mobileConsent?.changes, expected);
      assert.deepEqual(consentWrites(authentik, before), [
        `deletePolicyBinding ${policyBinding.id}`,
        `deleteFlowStageBinding ${binding.id}`,
        `deletePolicy ${policy.id}`,
        `deleteStage ${stage.id}`,
        'clearFlowCache',
      ]);
      assert.equal(authentik.cacheClears, clears + 1);
      assert.deepEqual(authentik.listStagesForTest(), []);
      assert.deepEqual(authentik.listPoliciesForTest(), []);
      assert.deepEqual(authentik.listFlowStageBindingsForTest(), []);
      assert.deepEqual(authentik.listTargetPolicyBindingsForTest(), []);
    });
  }

  test('a foreign same-named stage is a conflict: zero consent writes, and the rest of the run applies', async () => {
    const authentik = await newClient({
      stages: [{ id: '600', name: MOBILE_CONSENT_STAGE_NAME, model: 'authentik_stages_prompt.promptstage' }],
    });
    const inventory = mobileInventory([MOBILE_A]);
    const before = authentik.calls.length;
    const expected = {
      uris: [MOBILE_A],
      changes: [],
      conflicts: [
        `stage '${MOBILE_CONSENT_STAGE_NAME}' exists but is not a consent stage Bellhop created — rename or delete it in Authentik`,
      ],
    };
    assert.deepEqual((await run(authentik, inventory, false)).mobileConsent, expected);
    const applied = await run(authentik, inventory, true);
    assert.deepEqual(applied.mobileConsent, expected);
    assert.deepEqual(consentWrites(authentik, before), []);
    assert.equal(syncAuthentikFailed(applied), false, 'a conflict alone never fails the run');
    assert.deepEqual((await authentik.listApplications()).map((a) => a.slug).sort(), ['media', 'sonarr']);
  });

  test('a same-named policy without the marker is a conflict: zero consent writes, and the rest of the run applies', async () => {
    const authentik = await newClient({
      policies: [{ id: '700', name: MOBILE_CONSENT_POLICY_NAME, model: EXPRESSION_POLICY_MODEL, expression: 'return True' }],
    });
    const before = authentik.calls.length;
    const applied = await run(authentik, mobileInventory([MOBILE_A]), true);
    assert.deepEqual(applied.mobileConsent, {
      uris: [MOBILE_A],
      changes: [],
      conflicts: [
        `policy '${MOBILE_CONSENT_POLICY_NAME}' exists but was not created by Bellhop — rename or delete it in Authentik`,
      ],
    });
    assert.deepEqual(consentWrites(authentik, before), []);
    assert.equal(authentik.listPoliciesForTest()[0].expression, 'return True', 'left untouched');
    assert.equal(syncAuthentikFailed(applied), false);
    assert.deepEqual((await authentik.listApplications()).map((a) => a.slug).sort(), ['media', 'sonarr']);
  });

  test('a thrown error on create sets error; the forward/OIDC work still applies and the run fails', async () => {
    const authentik = await newClient({ failOn: new Set(['createExpressionPolicy']) });
    const applied = await run(authentik, mobileInventory([MOBILE_A]), true);
    const error = applied.mobileConsent?.error ?? '';
    assert.ok(error.startsWith('FakeAuthentikClient: forced failure for createExpressionPolicy'), error);
    assert.ok(error.endsWith(HINT), error);
    assert.deepEqual(applied.mobileConsent?.changes, [{ object: 'stage', action: 'create' }]);
    assert.deepEqual((await authentik.listApplications()).map((a) => a.slug).sort(), ['media', 'sonarr']);
    assert.equal(applied.discovery?.length, 1, 'the discovery check still runs after a consent failure');
    assert.equal(syncAuthentikFailed(applied), true);
  });

  test('a read failure with mobile URIs sets error on a dry run (not failed) and on apply (failed)', async () => {
    for (const method of ['findStageByName', 'getDefaultAuthorizationFlowId', 'listFlowStageBindings']) {
      const authentik = await failingAfterSetup(method);
      const inventory = mobileInventory([MOBILE_A]);
      const before = authentik.calls.length;
      const dry = await run(authentik, inventory, false);
      assert.match(dry.mobileConsent?.error ?? '', new RegExp(`forced failure for ${method}`));
      assert.deepEqual(dry.mobileConsent?.changes, []);
      assert.equal(syncAuthentikFailed(dry), false, `${method}: a dry run never fails`);

      const applied = await run(authentik, inventory, true);
      assert.ok(applied.mobileConsent?.error?.endsWith(HINT));
      assert.equal(syncAuthentikFailed(applied), true, `${method}: apply fails`);
      assert.deepEqual(consentWrites(authentik, before), []);
      assert.deepEqual((await authentik.listApplications()).map((a) => a.slug).sort(), ['media', 'sonarr']);
    }
  });

  test('no mobile URIs plus a failing read: no error, nothing done', async () => {
    for (const method of ['findStageByName', 'findPolicyByName', 'getDefaultAuthorizationFlowId', 'listFlowStageBindings']) {
      const authentik = await failingAfterSetup(method);
      const before = authentik.calls.length;
      for (const apply of [false, true]) {
        const result = await run(authentik, mobileInventory(undefined), apply);
        assert.deepEqual(result.mobileConsent, { uris: [], changes: [], conflicts: [] }, method);
        assert.equal(syncAuthentikFailed(result), false, method);
      }
      assert.deepEqual(consentWrites(authentik, before), [], method);
    }
  });

  test('a mobile URI on a forward-mode or ungated entry contributes nothing', async () => {
    const authentik = await newClient();
    const variants: GuestOverrides[] = [{ authMode: 'forward' }, { authGroup: undefined }];
    for (const media of variants) {
      const result = await run(authentik, mobileInventory([MOBILE_A], media), false);
      assert.deepEqual(result.mobileConsent, { uris: [], changes: [], conflicts: [] });
    }
  });
});

// ---------------------------------------------------------------------------
// T015: formatSyncAuthentik's mobile consent sections (contracts/interfaces.md §2)
// ---------------------------------------------------------------------------

describe('formatSyncAuthentik mobile consent sections', () => {
  const FLOW_SLUG = authentikConfig().authorizationFlowSlug;
  const base = {
    toCreate: [],
    toRemove: [],
    conflicts: [],
    missingRungs: [],
    offLadder: [],
    bindingChanges: [],
    applied: true,
  };

  test('an absent mobileConsent and an empty one format byte-identically, with no mobile consent text at all', () => {
    const absent = formatSyncAuthentik(base);
    const empty = formatSyncAuthentik({ ...base, mobileConsent: { uris: [], changes: [], conflicts: [] } });
    assert.equal(absent, empty);
    assert.doesNotMatch(absent, /Mobile consent/);
  });

  test('creates: header names the change/URI counts, one "+ <object>" line per change, in order', () => {
    const text = formatSyncAuthentik({
      ...base,
      mobileConsent: {
        uris: [MOBILE_A, MOBILE_B],
        changes: [
          { object: 'stage', action: 'create' },
          { object: 'policy', action: 'create', detail: '2 mobile redirect URI(s)' },
          { object: 'binding', action: 'create' },
          { object: 'policy-binding', action: 'create' },
        ],
        conflicts: [],
      },
    });
    assert.equal(
      text,
      [
        'Applications to create: 0',
        'Applications to remove: 0',
        `Mobile consent step: 4 change(s) for 2 mobile redirect URI(s)`,
        `  + stage ${MOBILE_CONSENT_STAGE_NAME}`,
        `  + policy ${MOBILE_CONSENT_POLICY_NAME}`,
        `  + binding on ${FLOW_SLUG}`,
        `  + policy-binding`,
      ].join('\n')
    );
  });

  test('updates: "~ <object>: <detail>" for a drifted stage, policy and binding', () => {
    const text = formatSyncAuthentik({
      ...base,
      mobileConsent: {
        uris: [MOBILE_A, MOBILE_B],
        changes: [
          { object: 'stage', action: 'update', detail: 'mode' },
          { object: 'policy', action: 'update', detail: 'expression (2 mobile redirect URI(s))' },
          { object: 'binding', action: 'update', detail: 'evaluate_on_plan, re_evaluate_policies' },
        ],
        conflicts: [],
      },
    });
    assert.equal(
      text,
      [
        'Applications to create: 0',
        'Applications to remove: 0',
        `Mobile consent step: 3 change(s) for 2 mobile redirect URI(s)`,
        `  ~ stage ${MOBILE_CONSENT_STAGE_NAME}: mode`,
        `  ~ policy ${MOBILE_CONSENT_POLICY_NAME}: expression (2 mobile redirect URI(s))`,
        `  ~ binding on ${FLOW_SLUG}: evaluate_on_plan, re_evaluate_policies`,
      ].join('\n')
    );
  });

  test('deletes: "- <object>" with no detail suffix, in policy-binding -> binding -> policy -> stage order', () => {
    const text = formatSyncAuthentik({
      ...base,
      mobileConsent: {
        uris: [],
        changes: [
          { object: 'policy-binding', action: 'delete' },
          { object: 'binding', action: 'delete' },
          { object: 'policy', action: 'delete' },
          { object: 'stage', action: 'delete' },
        ],
        conflicts: [],
      },
    });
    assert.equal(
      text,
      [
        'Applications to create: 0',
        'Applications to remove: 0',
        `Mobile consent step: 4 change(s) for 0 mobile redirect URI(s)`,
        `  - policy-binding`,
        `  - binding on ${FLOW_SLUG}`,
        `  - policy ${MOBILE_CONSENT_POLICY_NAME}`,
        `  - stage ${MOBILE_CONSENT_STAGE_NAME}`,
      ].join('\n')
    );
  });

  test('conflicts: a "Mobile consent conflicts: <N>" stanza with one "! <text>" line per conflict, independent of changes', () => {
    const text = formatSyncAuthentik({
      ...base,
      mobileConsent: {
        uris: [MOBILE_A],
        changes: [],
        conflicts: [
          `stage '${MOBILE_CONSENT_STAGE_NAME}' exists but is not a consent stage Bellhop created — rename or delete it in Authentik`,
        ],
      },
    });
    assert.equal(
      text,
      [
        'Applications to create: 0',
        'Applications to remove: 0',
        `Mobile consent conflicts: 1`,
        `  ! stage '${MOBILE_CONSENT_STAGE_NAME}' exists but is not a consent stage Bellhop created — rename or delete it in Authentik`,
      ].join('\n')
    );
  });

  test('error: a single "Mobile consent step failed: <message>" line, with the message printed verbatim', () => {
    const message = `FakeAuthentikClient: forced failure for createExpressionPolicy${HINT}`;
    const text = formatSyncAuthentik({
      ...base,
      mobileConsent: { uris: [MOBILE_A], changes: [{ object: 'stage', action: 'create' }], conflicts: [], error: message },
    });
    assert.match(text, /Mobile consent step: 1 change\(s\) for 1 mobile redirect URI\(s\)\n {2}\+ stage /);
    assert.ok(text.endsWith(`Mobile consent step failed: ${message}`));
  });

  test('a change with no conflicts/error prints no conflicts or failure stanza', () => {
    const text = formatSyncAuthentik({
      ...base,
      mobileConsent: { uris: [MOBILE_A], changes: [{ object: 'stage', action: 'create' }], conflicts: [] },
    });
    assert.doesNotMatch(text, /Mobile consent conflicts/);
    assert.doesNotMatch(text, /Mobile consent step failed/);
  });

  test('the mobile consent stanzas sit before the discovery section, which stays last', () => {
    const text = formatSyncAuthentik({
      ...base,
      mobileConsent: { uris: [MOBILE_A], changes: [{ object: 'stage', action: 'create' }], conflicts: [] },
      discovery: [{ slug: 'media', issuer: 'https://auth.example.com/application/o/media/', ok: true }],
    });
    const mobileIndex = text.indexOf('Mobile consent step:');
    const discoveryIndex = text.indexOf('OIDC discovery:');
    assert.ok(mobileIndex >= 0 && discoveryIndex >= 0 && mobileIndex < discoveryIndex);
  });
});
