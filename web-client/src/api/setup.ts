// The first-run setup walkthrough's API (#86, contracts/http-setup.md). Its
// own fetch wrapper rather than client.ts's: during setup a 401 means "this
// browser has not opened the setup address", not "sign in", and there is
// no sign-in page to send anyone to.
import type { ProxyDriverInfo } from './types';

export interface MidScheme {
  vmidBase: number;
  ipPrefix: string;
  cidrSuffix?: number;
  gateway: string;
}

export interface SetupHost {
  name: string;
  address: string;
  user: string;
  port: number;
  midScheme?: MidScheme;
  suggestedMidScheme?: MidScheme;
}

export interface SetupKey {
  mode: 'generated' | 'file';
  path: string;
  publicKey: string;
  authorizedKeysLine: string;
}

export interface SetupBasics {
  domain?: string;
  dnsServer?: string;
  backupStorage?: string;
  nfsServer?: string;
}

export interface SetupState {
  completedSteps: string[];
  requiredSteps: string[];
  hosts: SetupHost[];
  settings: SetupBasics;
  storages: string[];
  key: Omit<SetupKey, "authorizedKeysLine"> | null;
}

export interface SetupPeer {
  name: string;
  address: string;
  inInventory: boolean;
}

export interface HostEndpoint {
  address: string;
  user: string;
  port: number;
}

export class SetupApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/setup${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new SetupApiError(data.error ?? res.statusText, res.status);
  return data as T;
}

export const setupApi = {
  state: () => call<SetupState>('GET', '/state'),
  key: (choice: { mode: 'generated' } | { mode: 'file'; path: string }) => call<SetupKey>('POST', '/key', choice),
  installKey: (endpoint: HostEndpoint & { password: string }) =>
    call<{ installed: true }>('POST', '/hosts/install-key', endpoint),
  testHost: (endpoint: HostEndpoint) => call<{ nodeName: string; version: string }>('POST', '/hosts/test', endpoint),
  saveHost: (endpoint: HostEndpoint) =>
    call<{ host: SetupHost; peers: SetupPeer[] }>('POST', '/hosts', endpoint),
  saveMidScheme: (name: string, midScheme: MidScheme) =>
    call<{ host: SetupHost; completedSteps: string[] }>('PUT', `/hosts/${encodeURIComponent(name)}/mid-scheme`, midScheme),
  saveBasics: (basics: SetupBasics) =>
    call<{ settings: SetupBasics; completedSteps: string[] }>('PUT', '/basics', basics),
  proxy: () => call<ProxyStepState>('GET', '/proxy'),
  saveProxy: (body: ProxySaveBody) => call<{ state: ProxyStepState }>('PUT', '/proxy', body),
  checkProxy: () => call<ProxyCheckResult>('POST', '/proxy/check'),
  finish: () => call<{ redirect: string }>('POST', '/finish'),
};

// Step 3, the reverse proxy (#87, contracts/http-setup-proxy.md).
export interface ProxyChoice {
  driver: string;
  entry?: string;
  configPath: string;
  certResolver: string;
  apiUrl: string;
  npmApiUrl: string;
  npmApiEmail: string;
  tlsSource: string;
  acmeDnsProvider: string;
  certificatePath: string;
  keyPath: string;
}

export interface ProxyEntry {
  name: string;
  kind: 'host' | 'guest';
  parent?: string;
  ip?: string;
}

export interface ProxyStepState {
  drivers: ProxyDriverInfo[];
  defaultDriver: string;
  acmeDnsProviders: string[];
  defaultAcmeDnsProvider: string;
  entries: ProxyEntry[];
  choice: ProxyChoice;
  // Set or not set: a secret's value never reaches the browser.
  secrets: { npmApiPassword: boolean; cloudflareDnsApiToken: boolean };
  pinned: { key: string; variable: string }[];
  complete: boolean;
}

export interface ProxyCheckResult {
  ok: true;
  summary: string;
  // sync-proxy's dry-run text; absent when it could not be built (previewError says why).
  preview?: string;
  previewError?: string;
  completedSteps: string[];
}

export interface ProxySaveBody extends Omit<ProxyChoice, 'entry'> {
  entry?: string;
  secrets?: { npmApiPassword?: string; cloudflareDnsApiToken?: string };
}
