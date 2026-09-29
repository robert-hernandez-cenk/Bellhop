# Interface contracts: OIDC mobile-app redirect URIs

## 1. `AuthentikClient` additions (`src/lib/authentik-client.ts`)

Implemented by `RealAuthentikClient` (fetch, request/response mapping pinned by stubbed-fetch tests against redacted live fixtures), `UnconfiguredAuthentikClient` (throws the usual "not configured" error), and `FakeAuthentikClient` (in-memory, `test/support/fake-authentik-client.ts`). Endpoints are listed in research R4.

```ts
export interface AuthentikStageRef {
  id: string;            // pk
  name: string;
  model: string;         // meta_model_name, e.g. 'authentik_stages_consent.consentstage'
}
export interface AuthentikConsentStage { id: string; name: string; mode: string }
export interface AuthentikPolicyRef {
  id: string;            // pk
  name: string;
  model: string;         // meta_model_name, e.g. 'authentik_policies_expression.expressionpolicy'
  expression?: string;   // present for an expression policy
}
export interface AuthentikFlowStageBinding {
  id: string;            // pk
  policyBindingModelId: string; // policybindingmodel_ptr_id -- what a policy binding targets
  flowId: string;        // target
  stageId: string;       // stage
  order: number;
  evaluateOnPlan: boolean;
  reEvaluatePolicies: boolean;
}
export interface AuthentikPolicyBindingDetail {
  id: string;
  targetId: string;
  policyId?: string;     // absent for a group/user binding
}

// in AuthentikClient:
findStageByName(name: string): Promise<AuthentikStageRef | undefined>;
getConsentStage(id: string): Promise<AuthentikConsentStage>;
createConsentStage(input: { name: string; mode: string }): Promise<AuthentikConsentStage>;
updateConsentStage(id: string, input: { mode: string }): Promise<void>;
deleteStage(id: string): Promise<void>;                  // DELETE /api/v3/stages/consent/<id>/
findPolicyByName(name: string): Promise<AuthentikPolicyRef | undefined>;
createExpressionPolicy(input: { name: string; expression: string }): Promise<AuthentikPolicyRef>;
updateExpressionPolicy(id: string, input: { expression: string }): Promise<void>;
deletePolicy(id: string): Promise<void>;                 // DELETE /api/v3/policies/expression/<id>/
listFlowStageBindings(flowId: string): Promise<AuthentikFlowStageBinding[]>;
createFlowStageBinding(input: {
  flowId: string; stageId: string; order: number; evaluateOnPlan: boolean; reEvaluatePolicies: boolean;
}): Promise<AuthentikFlowStageBinding>;
updateFlowStageBinding(id: string, input: { evaluateOnPlan: boolean; reEvaluatePolicies: boolean }): Promise<void>;
deleteFlowStageBinding(id: string): Promise<void>;
listPolicyBindingsForTarget(targetId: string): Promise<AuthentikPolicyBindingDetail[]>; // ?target=<policybindingmodel_ptr_id>
createPolicyToTargetBinding(input: { targetId: string; policyId: string }): Promise<void>;
clearFlowCache(): Promise<void>;
```

The existing group-binding methods (`createPolicyBinding`, `listPolicyBindings`, `deletePolicyBinding`) are unchanged. `deletePolicyBinding` is reused to remove the consent policy binding.

## 2. `sync-authentik`

### Exports (`src/commands/networking/sync-authentik.ts`)

```ts
export const MOBILE_CONSENT_STAGE_NAME = 'bellhop-mobile-app-consent';
export const MOBILE_CONSENT_POLICY_NAME = 'bellhop-consent-on-mobile-redirect';
export const MOBILE_CONSENT_MARKER = '# Managed by Bellhop (sync-authentik).';
export function clientRedirectUris(entry: { oidcRedirectUris?: string[]; oidcMobileRedirectUris?: string[] }): string[];
export function renderMobileConsentExpression(uris: string[]): string;
export function pythonStringLiteral(value: string): string;
```

`SyncAuthentikResult.mobileConsent` has the shape given in data-model.md. `syncAuthentikFailed(result)` additionally returns true when `result.applied && result.mobileConsent?.error`.

### CLI output (`formatSyncAuthentik`)

Each section is printed only when non-empty, so a run with no mobile URIs and nothing to remove is byte-identical to today:

```text
Mobile consent step: 4 change(s) for 2 mobile redirect URI(s)
  + stage bellhop-mobile-app-consent
  + policy bellhop-consent-on-mobile-redirect
  + binding on default-provider-authorization-implicit-consent
  + policy-binding
Mobile consent conflicts: 1
  ! stage 'bellhop-mobile-app-consent' exists but is not a consent stage Bellhop created — rename or delete it in Authentik
Mobile consent step failed: <message> — check AUTHENTIK_AUTHORIZATION_FLOW_SLUG and the API token's stage/policy/flow permissions (README "Authentik API token permissions")
```

Update lines use `~ <object>: <detail>`; delete lines use `- <object>`.

## 3. Edit surfaces

| Surface | Field | Rules |
|---|---|---|
| `PATCH /api/inventory/guests/:name` (Dashboard) | `oidcMobileRedirectUris`: `;`-joined string or array | Parsed by `parseOidcMobileRedirectUris` (400 on an invalid URI). Admin-only in both directions (403 otherwise, `oidcEditChangeError`). Cross-list duplicates give 400 via `oidcConfigErrors`. |
| MCP `edit_guest` (`EDIT_GUEST_SHAPE`) | `oidcMobileRedirectUris: string \| string[]` optional | Same parse and cross-list rules via `applyGuestEdits` and `commitGuestEdit`. No admin check. The tool description lists the field. |
| `import-yaml-inventory` | `oidcMobileRedirectUris: [..]` on hosts, guests, external sites | Zod item validation only (no cross-list check, consistent with load). |
| `GuestEntry` in `web-client/src/api/types.ts` | `oidcMobileRedirectUris?: string[]` | — |

## 4. Web client

- `web-client/src/lib/oidc.ts`: `accessFieldsFor(authMode?: 'forward' | 'oidc'): AccessField[]`, where `AccessField` is `'authGroup' | 'authMode' | 'unauthenticatedPaths' | 'callbackUrls' | 'mobileRedirectUrls' | 'oidcClient'`. Forward mode returns the first three; OIDC mode returns everything except `unauthenticatedPaths`.
- `EditableOidcMobileRedirectUris` (in `EditableAuthMode.tsx`): props `{ guest, onSaved }`. Saves `{ oidcMobileRedirectUris }`, with the same admin handling and error display as `EditableOidcRedirectUris`. Help text: "For a native app's sign-in callback (custom scheme or its mobile-redirect page). Adds one consent click to mobile sign-ins only."
- `AdvancedGuestModal`: tab strip with `General` and `Access` (`role="tablist"`, buttons with `role="tab"` and `aria-selected`); General is the default.
