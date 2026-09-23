import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiGet, apiPost } from '../api/client';
import type { ProvisioningCommandDef, HostEntry, GuestEntry, AppDefaults } from '../api/types';
import { FieldInput } from '../components/FieldInput';
import { AppCheckInput, type CheckStatus } from '../components/AppCheckInput';
import { CheckStatusBadge } from '../components/CheckStatusBadge';
import { PageDescription } from '../components/PageDescription';
import { IconExternalLink } from '../components/icons';
import { nextAvailableMid, vmidForMid } from '../lib/mid';
import { findConflicts } from '../components/SubdomainsInput';

const composeVpnGatewayName = (vpn: string, identifier: string) =>
  vpn && identifier ? `${vpn}-${identifier}-gw-lxc` : '';

export function ProvisioningForm() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [commands, setCommands] = useState<ProvisioningCommandDef[]>([]);
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [guests, setGuests] = useState<GuestEntry[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  // Field names whose current value came from applyAppDefaults, not the
  // operator typing/selecting it -- lets a later app change clear exactly
  // those fields (so a new app's defaults aren't blocked by the previous
  // app's leftovers) while a deliberate manual edit is never touched.
  const [autofilledFields, setAutofilledFields] = useState<Set<string>>(new Set());
  // Raw operator-typed text for the Deploy VPN Gateway form's Name field
  // ('ext', say) -- never sent to the API directly. values.name holds the
  // derived, submitted value (`${vpn}-${identifier}-gw-lxc`), recomputed by
  // setField/setVpnGatewayNameIdentifier below whenever this or values.vpn
  // changes. Unused by every other command's form.
  const [nameIdentifier, setNameIdentifier] = useState('');
  const [checkStatuses, setCheckStatuses] = useState<Record<string, CheckStatus>>({});
  const [preview, setPreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    apiGet<ProvisioningCommandDef[]>('/provisioning').then(setCommands);
    apiGet<{ hosts: HostEntry[]; guests: GuestEntry[] }>('/inventory').then((data) => {
      setHosts(data.hosts);
      setGuests(data.guests);
    });
  }, []);

  useEffect(() => {
    setValues({});
    setAutofilledFields(new Set());
    setCheckStatuses({});
    setPreview(null);
    setError(null);
    setNameIdentifier('');
  }, [id]);

  const cmd = commands.find((c) => c.id === id);
  if (!cmd) return <div className="content">Loading…</div>;

  const AUTOFILLABLE_FIELDS = ['cores', 'memory', 'disk', 'port', 'hostname', 'subdomains'];

  const setField = (name: string, value: string) => {
    setValues((prev) => {
      const next = { ...prev, [name]: value };
      if (name === 'host') {
        const selectedHost = hosts.find((h) => h.name === value);
        const activeBridges = (selectedHost?.bridges ?? []).filter((b) => b.active !== false);
        next.bridge = (activeBridges.find((b) => b.name === 'vmbr0') ?? activeBridges[0])?.name ?? '';
        for (const f of cmd.fields) {
          if (f.kind === 'select-nfs-mount') next[f.name] = '';
        }
      }
      if (name === 'guest') {
        for (const f of cmd.fields) {
          if (f.kind === 'select-nfs-mount') next[f.name] = '';
        }
      }
      // Recompute each mid field's default whenever the host field it's
      // scoped to changes (create-lxc/create-vm/install-app/
      // deploy-vpn-gateway, all scoped to the plain 'host' field) -- or,
      // for migrate-guest, whenever the selected guest changes too: its mid
      // field is scoped to 'toHost', but the CLI's own preferred default
      // (the *current* guest's vmid numeric suffix) is a function of which
      // guest is selected, not the target host. That preferred mid can
      // still collide with a guest already on the target host, though (the
      // two hosts number guests independently), so once a target host is
      // known, fall back to the next fully-available mid on that host
      // instead of a value that's just going to bounce off
      // checkVmidAvailable at apply time.
      for (const f of cmd.fields) {
        if (f.kind !== 'mid') continue;
        const hostFieldName = f.hostField ?? 'host';
        if (hostFieldName !== name && name !== 'guest') continue;
        const selectedHost = hosts.find((h) => h.name === next[hostFieldName]);
        const selectedGuest = guests.find((g) => g.name === next.guest);
        if (selectedGuest) {
          const preferredMid = selectedGuest.vmid % 1000;
          const preferredVmid = vmidForMid(selectedHost, preferredMid);
          const collides =
            selectedHost !== undefined &&
            preferredVmid !== null &&
            guests.some((g) => g.host === selectedHost.name && g.vmid === preferredVmid);
          if (collides) {
            const suggestedMid = nextAvailableMid(selectedHost, guests);
            next[f.name] = suggestedMid === null ? '' : String(suggestedMid);
          } else {
            next[f.name] = String(preferredMid);
          }
        } else {
          const suggestedMid = nextAvailableMid(selectedHost, guests);
          next[f.name] = suggestedMid === null ? '' : String(suggestedMid);
        }
      }
      // Re-select each select-storage field's default whenever the host
      // field it's scoped to (its `hostField`, defaulting to 'host')
      // changes. This loop runs unconditionally on every field change
      // (not nested inside the `if (name === 'host')` block above) because
      // most commands scope storage to the plain 'host' field, but
      // migrate-guest's is scoped to 'toHost' instead (it targets a
      // *different* host than wherever the guest currently lives), so the
      // check below has to compare each field's own `hostField`, not just
      // name === 'host'.
      for (const f of cmd.fields) {
        if (f.kind !== 'select-storage' || (f.hostField ?? 'host') !== name) continue;
        const selectedHost = hosts.find((h) => h.name === value);
        const contentTypes = f.storageContentTypes ?? [];
        const candidate = (selectedHost?.storages ?? []).find(
          (s) => s.active && contentTypes.some((ct) => s.content.includes(ct))
        );
        next[f.name] = candidate?.name ?? '';
      }
      if (name === 'app') {
        for (const f of AUTOFILLABLE_FIELDS) {
          if (autofilledFields.has(f)) next[f] = '';
        }
      }
      if (name === 'vpn') {
        next.name = composeVpnGatewayName(value, nameIdentifier);
      }
      // A field with showIf whose controlling field just changed away from
      // the value it depends on is about to stop rendering -- clear it so a
      // stale value (e.g. a NordVPN access token typed before switching the
      // VPN Provider field to PIA) never gets silently resubmitted.
      for (const f of cmd.fields) {
        if (f.showIf && f.showIf.field === name && f.showIf.value !== value) {
          next[f.name] = '';
        }
      }
      return next;
    });
    setAutofilledFields((prev) => {
      const toRemove = name === 'app' ? AUTOFILLABLE_FIELDS : [name];
      if (!toRemove.some((f) => prev.has(f))) return prev;
      const next = new Set(prev);
      for (const f of toRemove) next.delete(f);
      return next;
    });
    setPreview(null);
  };

  // Sanitizes as the operator types (lowercase, strip anything outside
  // a-z/0-9/-) rather than only validating at submit time, then recomputes
  // the derived, submitted values.name via the existing setField path (so
  // it also gets setField's "clear stale preview" behavior for free).
  const setVpnGatewayNameIdentifier = (raw: string) => {
    const sanitized = raw.toLowerCase().replace(/[^a-z0-9-]/g, '');
    setNameIdentifier(sanitized);
    setField('name', composeVpnGatewayName(values.vpn ?? '', sanitized));
  };

  // Only fills fields the operator hasn't already touched -- a script's
  // recommended sizing is a starting point, not something that should
  // clobber a deliberate edit made before/after the app-check resolves.
  // Fields still holding a *previous* app's autofilled value are fair game
  // (setField already clears them the moment the app field changes, so this
  // only ever sees a manual edit or an actually-empty field here).
  const applyAppDefaults = (defaults: AppDefaults) => {
    const toFill = (['cores', 'memory', 'disk', 'port'] as const).filter((f) => defaults[f] !== undefined && !values[f]);
    if (toFill.length === 0) return;
    setValues((prev) => ({ ...prev, ...Object.fromEntries(toFill.map((f) => [f, String(defaults[f])])) }));
    setAutofilledFields((prev) => new Set([...prev, ...toFill]));
  };

  // install-app always creates an lxc (never a vm), so "-lxc" is the fixed
  // suffix here -- not a generic guest-type parameter, since this form has
  // no such choice to make. First pick is unsuffixed ("tracearr" /
  // "tracearr-lxc"); a name/subdomain already in use bumps a counter
  // ("tracearr-2" / "tracearr-2-lxc", "tracearr-3" / "tracearr-3-lxc", ...)
  // until one is free. Same "don't clobber a manual edit" guard as
  // applyAppDefaults -- only fills hostname/subdomains if still empty.
  const applyAppNaming = (appSlug: string) => {
    const toFill = (['hostname', 'subdomains'] as const).filter((f) => !values[f]);
    if (toFill.length === 0) return;

    const updates: Record<string, string> = {};
    if (toFill.includes('hostname')) {
      let n = 1;
      let candidate = `${appSlug}-lxc`;
      while (guests.some((g) => g.name.toLowerCase() === candidate.toLowerCase())) {
        n++;
        candidate = `${appSlug}-${n}-lxc`;
      }
      updates.hostname = candidate;
    }
    if (toFill.includes('subdomains')) {
      let n = 1;
      let candidate = appSlug;
      while (findConflicts([candidate], hosts, guests).length > 0) {
        n++;
        candidate = `${appSlug}-${n}`;
      }
      updates.subdomains = candidate;
    }
    setValues((prev) => ({ ...prev, ...updates }));
    setAutofilledFields((prev) => new Set([...prev, ...toFill]));
  };

  const runPreview = async () => {
    setError(null);
    setPreviewing(true);
    try {
      const res = await apiPost<{ preview: string }>(`/provisioning/${cmd.id}/preview`, values);
      setPreview(res.preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  };

  const runApply = async () => {
    setApplying(true);
    setError(null);
    try {
      const res = await apiPost<{ jobId: number }>(`/provisioning/${cmd.id}/apply`, values);
      navigate(`/jobs/${res.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setApplying(false);
    }
  };

  return (
    <div>
      <h2>{cmd.label}</h2>
      <PageDescription>{cmd.description}</PageDescription>
      {cmd.warning && <div className="warning-banner">{cmd.warning}</div>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          runPreview();
        }}
      >
        {cmd.fields
          .filter((field) => !field.showIf || values[field.showIf.field] === field.showIf.value)
          .map((field) => (
          <div className="form-field" key={field.name}>
            <label className="label">
              {field.label}
              {field.kind === 'app-check' && (
                <>
                  <a
                    className="label-link"
                    href="https://community-scripts.org/"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open community-scripts"
                  >
                    <IconExternalLink size={12} />
                  </a>
                  <CheckStatusBadge status={checkStatuses[field.name] ?? 'idle'} />
                </>
              )}
              {field.kind === 'vpn-gateway-name' && values.name && (
                <span className="label-hint">{values.name}</span>
              )}
            </label>
            {field.kind === 'app-check' ? (
              <AppCheckInput
                value={values[field.name] ?? ''}
                onChange={(v) => setField(field.name, v)}
                checkEndpoint={field.checkEndpoint!}
                onStatusChange={(status) => setCheckStatuses((prev) => ({ ...prev, [field.name]: status }))}
                onDefaults={applyAppDefaults}
                onExists={applyAppNaming}
              />
            ) : field.kind === 'vpn-gateway-name' ? (
              <input
                className="field-input"
                value={nameIdentifier}
                onChange={(e) => setVpnGatewayNameIdentifier(e.target.value)}
                placeholder="ext"
              />
            ) : (
              <FieldInput
                field={field}
                value={values[field.name] ?? ''}
                onChange={(v) => setField(field.name, v)}
                hosts={hosts}
                guests={guests}
                values={values}
                hasGuestField={cmd.fields.some((f) => f.kind === 'select-guest' || f.kind === 'select-guest-lxc')}
              />
            )}
          </div>
          ))}
        <button className="button" type="submit" disabled={previewing}>
          {previewing ? 'Previewing…' : 'Preview'}
        </button>
      </form>

      {error && <div className="warning-banner">{error}</div>}

      {preview !== null && (
        <div>
          <div className="label">Dry-run output</div>
          <pre className="preview-pane">{preview}</pre>
          <button className="button" onClick={runApply} disabled={applying}>
            {applying ? 'Applying…' : 'Apply'}
          </button>
        </div>
      )}
    </div>
  );
}
