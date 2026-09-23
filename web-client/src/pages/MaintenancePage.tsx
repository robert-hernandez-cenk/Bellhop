import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiGet, apiPost } from '../api/client';
import type { MaintenanceActionDef, HostEntry, GuestEntry } from '../api/types';
import { FieldInput } from '../components/FieldInput';
import { PageDescription } from '../components/PageDescription';

type TargetMode = 'host' | 'all' | 'group';

export function MaintenancePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [actions, setActions] = useState<MaintenanceActionDef[]>([]);
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [guests, setGuests] = useState<GuestEntry[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [targetMode, setTargetMode] = useState<TargetMode>('host');
  const [targetHost, setTargetHost] = useState('');
  const [targetGroup, setTargetGroup] = useState<'pve' | 'lxc' | 'vm'>('lxc');
  const [preview, setPreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [runningReport, setRunningReport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiGet<MaintenanceActionDef[]>('/maintenance').then(setActions);
    apiGet<{ hosts: HostEntry[]; guests: GuestEntry[] }>('/inventory').then((data) => {
      setHosts(data.hosts);
      setGuests(data.guests);
    });
  }, []);

  useEffect(() => {
    setValues({});
    setPreview(null);
    setReport(null);
    setError(null);
  }, [id]);

  const action = actions.find((a) => a.id === id);
  if (!action) return <div className="content">Loading…</div>;

  const buildSelector = () => {
    if (targetMode === 'all') return { all: true };
    if (targetMode === 'group') return { group: targetGroup };
    return { host: targetHost };
  };

  const runReadOnly = async () => {
    setError(null);
    setRunningReport(true);
    try {
      const res = await apiPost<{ report: string }>(`/maintenance/${action.id}/run`, values);
      setReport(res.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningReport(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ jobId: number }>(`/maintenance/${action.id}/run`, { selector: buildSelector() });
      navigate(`/jobs/${res.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const runPreview = async () => {
    setError(null);
    setPreviewing(true);
    try {
      const res = await apiPost<{ preview: string }>(`/maintenance/${action.id}/preview`, values);
      setPreview(res.preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  };

  const runApply = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ jobId: number }>(`/maintenance/${action.id}/apply`, values);
      navigate(`/jobs/${res.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const nonTargetSelectorFields = action.fields.filter((f) => f.kind !== 'target-selector');
  const hasTargetSelector = action.fields.some((f) => f.kind === 'target-selector');

  return (
    <div>
      <h2>{action.label}</h2>
      <PageDescription>{action.description}</PageDescription>

      {nonTargetSelectorFields.map((field) => (
        <div className="form-field" key={field.name}>
          <label className="label">{field.label}</label>
          <FieldInput
            field={field}
            value={values[field.name] ?? ''}
            onChange={(v) => setValues((prev) => ({ ...prev, [field.name]: v }))}
            hosts={hosts}
            guests={guests}
            values={values}
            hasGuestField={action.fields.some((f) => f.kind === 'select-guest' || f.kind === 'select-guest-lxc')}
          />
        </div>
      ))}

      {hasTargetSelector && (
        <div className="form-field">
          <label className="label">Target</label>
          <select className="field-input" value={targetMode} onChange={(e) => setTargetMode(e.target.value as TargetMode)}>
            <option value="host">Single host/guest</option>
            <option value="all">All hosts and guests</option>
            <option value="group">Group</option>
          </select>
          {targetMode === 'host' && (
            <select className="field-input" value={targetHost} onChange={(e) => setTargetHost(e.target.value)}>
              <option value="">Select…</option>
              {[...hosts.map((h) => h.name), ...guests.map((g) => g.name)].map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
          {targetMode === 'group' && (
            <select className="field-input" value={targetGroup} onChange={(e) => setTargetGroup(e.target.value as any)}>
              <option value="pve">pve</option>
              <option value="lxc">lxc</option>
              <option value="vm">vm</option>
            </select>
          )}
        </div>
      )}

      {error && <div className="warning-banner">{error}</div>}

      {action.mode === 'read-only' && (
        <>
          <button className="button" onClick={runReadOnly} disabled={runningReport}>
            {runningReport ? 'Running…' : 'Run'}
          </button>
          {report !== null && <pre className="preview-pane">{report}</pre>}
        </>
      )}

      {action.mode === 'run-only' && (
        <button className="button" onClick={runNow} disabled={busy}>
          {busy ? 'Starting…' : 'Run'}
        </button>
      )}

      {action.mode === 'preview-apply' && (
        <>
          <button className="button" onClick={runPreview} disabled={previewing}>
            {previewing ? 'Previewing…' : 'Preview'}
          </button>
          {preview !== null && (
            <div>
              <pre className="preview-pane">{preview}</pre>
              <button className="button" onClick={runApply} disabled={busy}>
                {busy ? 'Applying…' : 'Apply'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
