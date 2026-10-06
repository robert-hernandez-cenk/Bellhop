import { useCallback, useEffect, useState } from 'react';
import {
  SetupApiError,
  setupApi,
  type HostEndpoint,
  type ProxyChoice,
  type ProxyCheckResult,
  type ProxyStepState,
  type MidScheme,
  type SetupBasics,
  type SetupHost,
  type SetupPeer,
  type SetupState,
} from '../api/setup';
import { acmeDnsProviderOptions, proxyDriverOptions, tlsSourceOptions } from '../lib/settings-display';

const STEP_LABELS: Record<string, string> = {
  proxmox: 'Proxmox',
  basics: 'Domain and basics',
  proxy: 'Reverse proxy',
  finish: 'Finish',
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface StepProps {
  state: SetupState;
  reload: () => Promise<void>;
  next: () => void;
}

// A host's midScheme, prefilled with its saved value or the suggestion
// derived from its network (FR-014). Every field is editable; the server
// names an invalid one.
function MidSchemeEditor({ host, onSaved }: { host: SetupHost; onSaved: () => Promise<void> }) {
  const start: MidScheme | undefined = host.midScheme ?? host.suggestedMidScheme;
  const [vmidBase, setVmidBase] = useState(String(start?.vmidBase ?? ''));
  const [ipPrefix, setIpPrefix] = useState(start?.ipPrefix ?? '');
  const [cidrSuffix, setCidrSuffix] = useState(String(start?.cidrSuffix ?? ''));
  const [gateway, setGateway] = useState(start?.gateway ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(Boolean(host.midScheme));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await setupApi.saveMidScheme(host.name, {
        vmidBase: Number(vmidBase),
        ipPrefix,
        ...(cidrSuffix.trim() === '' ? {} : { cidrSuffix: Number(cidrSuffix) }),
        gateway,
      });
      setSaved(true);
      await onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setup-host">
      <h3>
        {host.name} <span className="settings-optional">{host.user}@{host.address}:{host.port}</span>
      </h3>
      {!host.midScheme && host.suggestedMidScheme && (
        <p className="settings-help">Suggested from this host's network. Change anything that doesn't fit your layout.</p>
      )}
      {!host.midScheme && !host.suggestedMidScheme && (
        <p className="settings-help">No bridge with an IPv4 address and gateway was found, so enter these yourself.</p>
      )}
      <div className="setup-grid">
        <label className="form-field">
          VMID base
          <input className="field-input" inputMode="numeric" value={vmidBase} onChange={(e) => setVmidBase(e.target.value)} />
        </label>
        <label className="form-field">
          IP prefix
          <input className="field-input" placeholder="192.0.2." value={ipPrefix} onChange={(e) => setIpPrefix(e.target.value)} />
        </label>
        <label className="form-field">
          CIDR suffix
          <input className="field-input" inputMode="numeric" placeholder="24" value={cidrSuffix} onChange={(e) => setCidrSuffix(e.target.value)} />
        </label>
        <label className="form-field">
          Gateway
          <input className="field-input" placeholder="192.0.2.1" value={gateway} onChange={(e) => setGateway(e.target.value)} />
        </label>
      </div>
      {error && <div className="warning-banner">{error}</div>}
      <div className="setup-actions">
        <button type="button" className="button" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save network layout'}
        </button>
        {saved && <span className="setup-ok">Saved</span>}
      </div>
    </div>
  );
}

function ProxmoxStep({ state, reload, next }: StepProps) {
  const [keyMode, setKeyMode] = useState<'generated' | 'file'>(state.key?.mode ?? 'generated');
  const [keyPath, setKeyPath] = useState(state.key?.mode === 'file' ? state.key.path : '');
  const [publicKey, setPublicKey] = useState(state.key?.publicKey ?? '');
  const [copied, setCopied] = useState(false);
  const [endpoint, setEndpoint] = useState<{ address: string; user: string; port: string }>({
    address: '',
    user: 'root',
    port: '22',
  });
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [peers, setPeers] = useState<SetupPeer[]>([]);

  const chooseKey = useCallback(
    async (mode: 'generated' | 'file', path: string) => {
      setError(null);
      try {
        const key = await setupApi.key(mode === 'generated' ? { mode } : { mode, path });
        setPublicKey(key.publicKey);
      } catch (err) {
        setPublicKey('');
        setError(message(err));
      }
    },
    []
  );

  // The generated key is created on first need (FR-008); reopening finds it.
  useEffect(() => {
    if (!state.key) void chooseKey('generated', '');
  }, [state.key, chooseKey]);

  const target = (): HostEndpoint => ({
    address: endpoint.address.trim(),
    user: endpoint.user.trim() || 'root',
    port: Number(endpoint.port) || 22,
  });

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  const installKey = () =>
    run('install', async () => {
      try {
        await setupApi.installKey({ ...target(), password });
        setNotice('Bellhop\'s key is installed. Now test the connection and save the host.');
      } finally {
        // Used once, never kept (FR-010).
        setPassword('');
      }
    });

  const test = () =>
    run('test', async () => {
      const result = await setupApi.testHost(target());
      setNotice(`Connected: Proxmox VE ${result.version}, node "${result.nodeName}".`);
    });

  const save = () =>
    run('save', async () => {
      const result = await setupApi.saveHost(target());
      setPeers(result.peers);
      setNotice(`Saved ${result.host.name} and read its guests, bridges and storage.`);
      await reload();
    });

  function addPeer(peer: SetupPeer) {
    setEndpoint((e) => ({ ...e, address: peer.address }));
    setNotice(`Add ${peer.name}: install the key if it is not there yet, then save the host.`);
  }

  const complete = state.completedSteps.includes('proxmox');

  return (
    <section className="setup-panel">
      <h2>Proxmox</h2>
      <p className="page-description">
        Bellhop reaches your Proxmox hosts over SSH with a key of its own. Add the first host; if it is part of a
        cluster you can add the other nodes after.
      </p>

      <h3>Bellhop's SSH key</h3>
      <div className="setup-actions">
        <label>
          <input
            type="radio"
            checked={keyMode === 'generated'}
            onChange={() => {
              setKeyMode('generated');
              void chooseKey('generated', '');
            }}
          />{' '}
          Generate one for Bellhop
        </label>
        <label>
          <input type="radio" checked={keyMode === 'file'} onChange={() => setKeyMode('file')} /> Use an existing key file
        </label>
      </div>
      {keyMode === 'file' && (
        <div className="form-field">
          <input
            className="field-input"
            placeholder="Path to an unencrypted private key on this machine"
            value={keyPath}
            onChange={(e) => setKeyPath(e.target.value)}
          />
          <button type="button" className="button" disabled={!keyPath.trim()} onClick={() => void chooseKey('file', keyPath.trim())}>
            Use this key
          </button>
        </div>
      )}
      {publicKey && (
        <>
          <pre className="setup-key">{publicKey}</pre>
          <div className="setup-actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                void navigator.clipboard?.writeText(publicKey).then(() => setCopied(true));
              }}
            >
              {copied ? 'Copied' : 'Copy key'}
            </button>
          </div>
          <p className="settings-help">
            To add it yourself instead of typing a password below, append that line to{' '}
            <code>~/.ssh/authorized_keys</code> of the SSH user on the Proxmox host (for root,{' '}
            <code>/root/.ssh/authorized_keys</code>).
          </p>
        </>
      )}

      <h3>Host</h3>
      <div className="setup-grid">
        <label className="form-field">
          Address
          <input className="field-input" placeholder="192.0.2.10" value={endpoint.address} onChange={(e) => setEndpoint({ ...endpoint, address: e.target.value })} />
        </label>
        <label className="form-field">
          SSH user
          <input className="field-input" value={endpoint.user} onChange={(e) => setEndpoint({ ...endpoint, user: e.target.value })} />
        </label>
        <label className="form-field">
          SSH port
          <input className="field-input" inputMode="numeric" value={endpoint.port} onChange={(e) => setEndpoint({ ...endpoint, port: e.target.value })} />
        </label>
      </div>

      <div className="form-field">
        <label>
          Host password (used once to install the key, never stored)
          <input
            className="field-input"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button type="button" className="button" disabled={!publicKey || !endpoint.address.trim() || !password || busy !== null} onClick={installKey}>
          {busy === 'install' ? 'Installing…' : 'Install key with password'}
        </button>
      </div>

      {error && <div className="warning-banner">{error}</div>}
      {notice && <p className="setup-ok">{notice}</p>}

      <div className="setup-actions">
        <button type="button" className="button" disabled={!publicKey || !endpoint.address.trim() || busy !== null} onClick={test}>
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button type="button" className="button" disabled={!publicKey || !endpoint.address.trim() || busy !== null} onClick={save}>
          {busy === 'save' ? 'Saving…' : 'Save host'}
        </button>
      </div>

      {peers.some((p) => !p.inInventory) && (
        <>
          <h3>Other nodes in this cluster</h3>
          <ul>
            {peers
              .filter((p) => !p.inInventory)
              .map((p) => (
                <li key={p.name}>
                  {p.name} ({p.address}){' '}
                  <button type="button" className="button" onClick={() => addPeer(p)}>
                    Add
                  </button>{' '}
                  <button type="button" className="button" onClick={() => setPeers((all) => all.filter((x) => x.name !== p.name))}>
                    Skip
                  </button>
                </li>
              ))}
          </ul>
        </>
      )}

      {state.hosts.length > 0 && <h3>Hosts</h3>}
      {state.hosts.map((host) => (
        <MidSchemeEditor key={`${host.name}-${host.midScheme ? 'set' : 'new'}`} host={host} onSaved={reload} />
      ))}

      <div className="setup-actions">
        <button type="button" className="button" disabled={!complete} onClick={next}>
          Continue
        </button>
      </div>
      {!complete && state.hosts.length > 0 && (
        <p className="settings-help">Save a network layout for at least one host to continue.</p>
      )}
    </section>
  );
}

function BasicsStep({ state, reload, next }: StepProps) {
  const [values, setValues] = useState<Required<SetupBasics>>({
    domain: state.settings.domain ?? '',
    dnsServer: state.settings.dnsServer ?? '',
    backupStorage: state.settings.backupStorage ?? '',
    nfsServer: state.settings.nfsServer ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await setupApi.saveBasics(values);
      await reload();
      next();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof SetupBasics) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  return (
    <section className="setup-panel">
      <h2>Domain and basics</h2>
      <label className="form-field">
        Domain (required)
        <input className="field-input" placeholder="example.com" value={values.domain} onChange={set('domain')} />
      </label>
      <p className="settings-help">The base domain your services are published under, such as example.com.</p>
      <label className="form-field">
        DNS server <span className="settings-optional">(optional)</span>
        <input className="field-input" placeholder="192.0.2.53" value={values.dnsServer} onChange={set('dnsServer')} />
      </label>
      <label className="form-field">
        Backup storage <span className="settings-optional">(optional)</span>
        <input className="field-input" list="setup-storages" value={values.backupStorage} onChange={set('backupStorage')} />
        <datalist id="setup-storages">
          {state.storages.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </label>
      <label className="form-field">
        NFS server <span className="settings-optional">(optional)</span>
        <input className="field-input" placeholder="192.0.2.5" value={values.nfsServer} onChange={set('nfsServer')} />
      </label>
      {error && <div className="warning-banner">{error}</div>}
      <div className="setup-actions">
        <button type="button" className="button" disabled={busy || !values.domain.trim()} onClick={save}>
          {busy ? 'Saving…' : 'Save and continue'}
        </button>
      </div>
    </section>
  );
}

// Step 3 (#87): the reverse proxy. The driver, the inventory entry it runs
// on, and the settings that driver reads. A secret input is never prefilled:
// the server only says whether one is stored, and a blank input keeps it.
function ProxyStep({ reload, next }: Omit<StepProps, 'state'>) {
  const [info, setInfo] = useState<ProxyStepState | null>(null);
  const [values, setValues] = useState<ProxyChoice | null>(null);
  const [password, setPassword] = useState('');
  const [cloudflareToken, setCloudflareToken] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<ProxyCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const loaded = await setupApi.proxy();
      setInfo(loaded);
      setValues(loaded.choice);
    } catch (err) {
      setError(message(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!info || !values) {
    return (
      <section className="setup-panel">
        <h2>Reverse proxy</h2>
        {error ? <div className="warning-banner">{error}</div> : <p className="settings-help">Loading…</p>}
      </section>
    );
  }

  const driver = info.drivers.find((d) => d.id === values.driver);
  const manages = driver?.managesProxy ?? false;
  const set = (key: keyof ProxyChoice) => (e: { target: { value: string } }) =>
    setValues((v) => (v ? { ...v, [key]: e.target.value } : v));
  // An unset source means the driver's own default, so the default is sent
  // as unset rather than pinned (a later driver switch is not then refused).
  const shownSource = values.tlsSource || driver?.defaultTlsSource || '';
  const shownProvider = values.acmeDnsProvider || info.defaultAcmeDnsProvider;
  const needsToken = shownSource === 'acme-dns' && shownProvider === 'cloudflare';

  async function save() {
    if (!values) return;
    setBusy(true);
    setError(null);
    try {
      const secrets = {
        ...(password ? { npmApiPassword: password } : {}),
        ...(cloudflareToken ? { cloudflareDnsApiToken: cloudflareToken } : {}),
      };
      const { state: saved } = await setupApi.saveProxy({
        ...values,
        tlsSource: values.tlsSource === driver?.defaultTlsSource ? '' : values.tlsSource,
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
      });
      setInfo(saved);
      setValues(saved.choice);
      setPassword('');
      setCloudflareToken('');
      setCheckResult(null);
      await reload();
      if (!saved.drivers.find((d) => d.id === saved.choice.driver)?.managesProxy) next();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  // The check runs against what is saved, so it waits for unsaved edits.
  const dirty =
    JSON.stringify(values) !== JSON.stringify(info.choice) || password !== '' || cloudflareToken !== '';

  async function check() {
    setChecking(true);
    setError(null);
    setCheckResult(null);
    try {
      const result = await setupApi.checkProxy();
      setCheckResult(result);
      await load();
      await reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="setup-panel">
      <h2>Reverse proxy</h2>
      <p className="page-description">
        Point Bellhop at the reverse proxy you already run. Nothing is written to it in this step.
      </p>
      <label className="form-field">
        Proxy
        <select className="field-input" value={values.driver} onChange={set('driver')}>
          {proxyDriverOptions(info.drivers, info.defaultDriver).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {!manages && <p className="settings-help">Bellhop will manage no proxy. Routes stay hand-configured.</p>}
      {manages && (
        <>
          <label className="form-field">
            Runs on
            <select className="field-input" value={values.entry ?? ''} onChange={set('entry')}>
              <option value="">Choose a host or guest…</option>
              {info.entries.map((e) => (
                <option key={e.name} value={e.name}>
                  {e.name} ({e.kind}
                  {e.ip ? `, ${e.ip}` : ''})
                </option>
              ))}
            </select>
          </label>
          {info.entries.length === 0 && (
            <p className="settings-help">
              The proxy must be a host or guest in your inventory. Add a Proxmox host in the first step.
            </p>
          )}
          {driver?.defaultConfigPath !== null && driver?.defaultConfigPath !== undefined && (
            <>
              <label className="form-field">
                Proxy config path <span className="settings-optional">(optional)</span>
                <input
                  className="field-input"
                  placeholder={driver.defaultConfigPath}
                  value={values.configPath}
                  onChange={set('configPath')}
                />
              </label>
              <p className="settings-help">
                Default {driver.defaultConfigPath}. {driver.configPathNote ?? ''}
              </p>
            </>
          )}
          {driver?.usesCertResolver && (
            <label className="form-field">
              Proxy cert resolver <span className="settings-optional">(optional)</span>
              <input className="field-input" placeholder="cloudflare" value={values.certResolver} onChange={set('certResolver')} />
            </label>
          )}
          {driver?.usesApiUrl && (
            <label className="form-field">
              Proxy API URL <span className="settings-optional">(optional)</span>
              <input className="field-input" placeholder="http://192.0.2.30:8080" value={values.apiUrl} onChange={set('apiUrl')} />
            </label>
          )}
          {driver?.usesNpmApi && (
            <>
              <label className="form-field">
                NPM API URL
                <input className="field-input" placeholder="http://192.0.2.30:81" value={values.npmApiUrl} onChange={set('npmApiUrl')} />
              </label>
              <label className="form-field">
                NPM email
                <input className="field-input" placeholder="admin@example.com" value={values.npmApiEmail} onChange={set('npmApiEmail')} />
              </label>
              <label className="form-field">
                NPM password{' '}
                <span className="settings-optional">({info.secrets.npmApiPassword ? 'set' : 'not set'})</span>
                <input
                  className="field-input"
                  type="password"
                  autoComplete="new-password"
                  placeholder={info.secrets.npmApiPassword ? 'Leave blank to keep the saved password' : ''}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            </>
          )}
          <label className="form-field">
            Certificates
            <select className="field-input" value={shownSource} onChange={set('tlsSource')}>
              {driver && tlsSourceOptions(driver, shownSource).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {shownSource === 'acme-dns' && (
            <label className="form-field">
              DNS provider
              <select className="field-input" value={shownProvider} onChange={set('acmeDnsProvider')}>
                {acmeDnsProviderOptions(info.acmeDnsProviders, info.defaultAcmeDnsProvider).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {needsToken && (
            <label className="form-field">
              Cloudflare API token{' '}
              <span className="settings-optional">({info.secrets.cloudflareDnsApiToken ? 'set' : 'not set'})</span>
              <input
                className="field-input"
                type="password"
                autoComplete="new-password"
                placeholder={info.secrets.cloudflareDnsApiToken ? 'Leave blank to keep the saved token' : ''}
                value={cloudflareToken}
                onChange={(e) => setCloudflareToken(e.target.value)}
              />
            </label>
          )}
          {shownSource === 'files' && (
            <>
              <label className="form-field">
                Certificate path <span className="settings-optional">(optional)</span>
                <input className="field-input" placeholder="/etc/letsencrypt/live/example.com/fullchain.pem" value={values.certificatePath} onChange={set('certificatePath')} />
              </label>
              <label className="form-field">
                Key path <span className="settings-optional">(optional)</span>
                <input className="field-input" placeholder="/etc/letsencrypt/live/example.com/privkey.pem" value={values.keyPath} onChange={set('keyPath')} />
              </label>
            </>
          )}
        </>
      )}
      {info.pinned.length > 0 && (
        <p className="settings-help">
          Set by the environment, so not editable here: {info.pinned.map((p) => p.variable).join(', ')}.
        </p>
      )}
      {error && <div className="warning-banner">{error}</div>}
      <div className="setup-actions">
        <button type="button" className="button" disabled={busy || (manages && !values.entry)} onClick={save}>
          {busy ? 'Saving…' : manages ? 'Save' : 'Save and continue'}
        </button>
        {manages && (
          <button
            type="button"
            className="button"
            disabled={checking || busy || dirty || !info.choice.entry}
            onClick={check}
          >
            {checking ? 'Checking…' : 'Check proxy'}
          </button>
        )}
      </div>
      {manages && dirty && <p className="settings-help">Save your changes, then check the proxy.</p>}
      {manages && info.complete && !checkResult && (
        <p className="settings-help">This step is complete. Any change you save will need a new check.</p>
      )}
      {checkResult && (
        <div className="setup-check">
          <p>{checkResult.summary}</p>
          {checkResult.preview !== undefined && (
            <>
              <p className="settings-help">
                The first sync would write the following. Nothing has been written to the proxy.
              </p>
              <pre className="setup-preview">{checkResult.preview}</pre>
              <div className="setup-actions">
                <button type="button" className="button" onClick={next}>
                  Continue
                </button>
              </div>
            </>
          )}
          {checkResult.previewError !== undefined && (
            <div className="warning-banner">
              The proxy passed its check, but the first sync could not be previewed, so the step is not complete: {checkResult.previewError}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function FinishStep({ state }: { state: SetupState }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = state.requiredSteps.every((s) => state.completedSteps.includes(s));

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      const { redirect } = await setupApi.finish();
      location.href = redirect;
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <section className="setup-panel">
      <h2>Finish</h2>
      <p className="page-description">
        Finishing turns the setup walkthrough off for good and retires the setup address. Everything you set here stays
        editable on the Settings page and the usual pages.
      </p>
      {!ready && <p className="settings-help">Complete the steps above first.</p>}
      {error && <div className="warning-banner">{error}</div>}
      <div className="setup-actions">
        <button type="button" className="button" disabled={!ready || busy} onClick={finish}>
          {busy ? 'Finishing…' : 'Finish setup'}
        </button>
      </div>
    </section>
  );
}

// The first-run setup walkthrough (#86). Rendered outside the app shell:
// before setup finishes nothing else is reachable, and there is no signed-in
// user for the sidebar to describe.
export function SetupPage() {
  const [state, setState] = useState<SetupState | null>(null);
  const [problem, setProblem] = useState<'unauthorized' | 'error' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The step shown: the first incomplete one until the operator picks another.
  const [chosen, setChosen] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setState(await setupApi.state());
    } catch (err: unknown) {
      if (err instanceof SetupApiError && err.status === 404) {
        location.href = '/';
        return;
      }
      if (err instanceof SetupApiError && err.status === 401) {
        setProblem('unauthorized');
        return;
      }
      setProblem('error');
      setError(message(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (problem === 'unauthorized') {
    return (
      <main className="setup-page">
        <h1>Set up Bellhop</h1>
        <p className="page-description">
          Open the setup address from the Bellhop service log. It looks like{' '}
          <code>http://&lt;this machine&gt;:3001/setup?token=…</code> and is written every time the service
          starts until setup is finished.
        </p>
      </main>
    );
  }

  const steps = state ? [...state.requiredSteps, 'finish'] : [];
  const firstIncomplete = state ? (state.requiredSteps.find((s) => !state.completedSteps.includes(s)) ?? 'finish') : '';
  const current = chosen ?? firstIncomplete;
  const advance = () => {
    const i = steps.indexOf(current);
    setChosen(steps[i + 1] ?? null);
  };

  return (
    <main className="setup-page">
      <h1>Set up Bellhop</h1>
      {error && <div className="warning-banner">{error}</div>}
      {state && (
        <>
          <ol className="setup-steps">
            {steps.map((step) => {
              const done = state.completedSteps.includes(step);
              return (
                <li key={step}>
                  <button
                    type="button"
                    className={`setup-step${done ? ' done' : ''}${step === current ? ' current' : ''}`}
                    onClick={() => setChosen(step)}
                  >
                    {STEP_LABELS[step] ?? step}
                  </button>
                </li>
              );
            })}
          </ol>
          {current === 'proxmox' && <ProxmoxStep state={state} reload={reload} next={advance} />}
          {current === 'basics' && <BasicsStep state={state} reload={reload} next={advance} />}
          {current === 'proxy' && <ProxyStep reload={reload} next={advance} />}
          {current === 'finish' && <FinishStep state={state} />}
        </>
      )}
    </main>
  );
}
