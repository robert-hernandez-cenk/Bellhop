import { Fragment, useEffect, useState } from 'react';
import { apiGet, apiPut, apiDelete } from '../api/client';
import type {
  AuthentikGroupEntry,
  GroupPermissionEntry,
  HostEntry,
  GuestEntry,
  PermissionMode,
  ResourceRef,
} from '../api/types';
import { PageDescription } from '../components/PageDescription';

function resourceKey(r: ResourceRef): string {
  return `${r.type}:${r.name}`;
}

export function PermissionsPage() {
  const [groups, setGroups] = useState<AuthentikGroupEntry[]>([]);
  const [permissions, setPermissions] = useState<GroupPermissionEntry[]>([]);
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [guests, setGuests] = useState<GuestEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<PermissionMode>('block-list');
  const [editResources, setEditResources] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    setError(null);
    try {
      const [g, p, inv] = await Promise.all([
        apiGet<AuthentikGroupEntry[]>('/groups'),
        apiGet<GroupPermissionEntry[]>('/permissions'),
        apiGet<{ hosts: HostEntry[]; guests: GuestEntry[] }>('/inventory'),
      ]);
      setGroups(g);
      setPermissions(p);
      setHosts(inv.hosts);
      setGuests(inv.guests);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const permissionFor = (groupName: string) => permissions.find((p) => p.groupName === groupName);

  const startEdit = (groupName: string) => {
    const existing = permissionFor(groupName);
    setEditingGroup(groupName);
    setEditMode(existing?.mode ?? 'block-list');
    setEditResources(new Set((existing?.resources ?? []).map(resourceKey)));
  };

  // Row click toggles the detail panel open/closed, same as Dashboard's host
  // rows -- only one group's panel is open at a time (unlike Dashboard's
  // multi-host Set), since editing more than one group's rule concurrently
  // has no sensible "which unsaved edit wins" story.
  const toggleEditing = (groupName: string) => {
    if (editingGroup === groupName) setEditingGroup(null);
    else startEdit(groupName);
  };

  const toggleResource = (ref: ResourceRef) => {
    const key = resourceKey(ref);
    const next = new Set(editResources);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setEditResources(next);
  };

  const saveEdit = async () => {
    if (!editingGroup) return;
    setSaving(true);
    setError(null);
    try {
      const resources: ResourceRef[] = [...editResources].map((key) => {
        const [type, name] = key.split(':') as [ResourceRef['type'], string];
        return { type, name };
      });
      await apiPut(`/permissions/${encodeURIComponent(editingGroup)}`, { mode: editMode, resources });
      setEditingGroup(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const clearRestriction = async (groupName: string) => {
    setError(null);
    try {
      await apiDelete(`/permissions/${encodeURIComponent(groupName)}`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <h2>Permissions</h2>
      <PageDescription>
        Restrict what a non-admin group can see and act on. A group with no rule can see everything. Blocking a host
        hides only that host's entry; its guests are controlled by their own separate rules. Click a group row to
        edit its rule.
      </PageDescription>
      {error && <div className="warning-banner">{error}</div>}
      {loading ? (
        <p>Loading…</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th className="col-expand"></th>
              <th>Group</th>
              <th>Mode</th>
              <th>Resources</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const existing = permissionFor(group.name);
              const expanded = editingGroup === group.name;
              return (
                <Fragment key={group.id}>
                  <tr className="expandable-row" onClick={() => toggleEditing(group.name)}>
                    <td className="col-expand" data-label="expand">{expanded ? '▾' : '▸'}</td>
                    <td data-label="Group">{group.name}</td>
                    <td data-label="Mode">{existing ? existing.mode : 'Unrestricted'}</td>
                    <td data-label="Resources">
                      {existing && existing.resources.length > 0
                        ? existing.resources.map((r) => `${r.type}:${r.name}`).join(', ')
                        : '—'}
                    </td>
                    <td data-label="Actions">
                      {existing && (
                        <div className="actions-cell actions-cell-end">
                          <button
                            className="button button-danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              clearRestriction(group.name);
                            }}
                          >
                            Clear
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="host-detail-row">
                      <td colSpan={5} className="host-detail-cell">
                        <div className="host-detail">
                          <div className="host-detail-section">
                            <div className="label">Mode</div>
                            <select
                              className="field-input"
                              value={editMode}
                              onChange={(e) => setEditMode(e.target.value as PermissionMode)}
                            >
                              <option value="block-list">Block-list (everything except these)</option>
                              <option value="allow-list">Allow-list (only these)</option>
                            </select>
                          </div>
                          <div className="host-detail-section">
                            <div className="label">Hosts</div>
                            <div className="checkbox-list">
                              {hosts.map((h) => (
                                <label key={`host:${h.name}`} style={{ display: 'block' }}>
                                  <input
                                    type="checkbox"
                                    checked={editResources.has(resourceKey({ type: 'host', name: h.name }))}
                                    onChange={() => toggleResource({ type: 'host', name: h.name })}
                                  />{' '}
                                  {h.name}
                                </label>
                              ))}
                            </div>
                          </div>
                          <div className="host-detail-section">
                            <div className="label">Guests</div>
                            <div className="checkbox-list">
                              {guests.map((g) => (
                                <label key={`guest:${g.name}`} style={{ display: 'block' }}>
                                  <input
                                    type="checkbox"
                                    checked={editResources.has(resourceKey({ type: 'guest', name: g.name }))}
                                    onChange={() => toggleResource({ type: 'guest', name: g.name })}
                                  />{' '}
                                  {g.name}
                                </label>
                              ))}
                            </div>
                          </div>
                          <div className="actions-cell">
                            <button className="button" onClick={saveEdit} disabled={saving}>
                              {saving ? 'Saving…' : 'Save'}
                            </button>
                            <button className="button" onClick={() => setEditingGroup(null)} disabled={saving}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
