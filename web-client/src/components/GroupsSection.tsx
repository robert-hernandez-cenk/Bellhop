import { useState } from 'react';
import { apiDelete, apiPatch, apiPost } from '../api/client';
import type { AuthentikGroupEntry, AuthentikUserEntry } from '../api/types';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';

interface Props {
  groups: AuthentikGroupEntry[];
  users: AuthentikUserEntry[];
  // From GET /api/whoami -- this build cannot import the server's
  // configured admin group names, so they arrive as data.
  adminGroups: { app: string; authentikBuiltin: string };
  reload: () => Promise<void>;
}

export function GroupsSection({ groups, users, adminGroups, reload }: Props) {
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editUserIds, setEditUserIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const [deletingGroup, setDeletingGroup] = useState<AuthentikGroupEntry | null>(null);

  const username = (id: string) => users.find((u) => u.id === id)?.username ?? id;

  const toggleEditUser = (id: string) => {
    const next = new Set(editUserIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setEditUserIds(next);
  };

  const createGroup = async () => {
    setCreating(true);
    setError(null);
    try {
      await apiPost('/groups', { name: newName.trim() });
      setNewName('');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (group: AuthentikGroupEntry) => {
    setEditingId(group.id);
    setEditName(group.name);
    setEditUserIds(new Set(group.userIds));
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`/groups/${editingId}`, { name: editName.trim(), userIds: [...editUserIds] });
      setEditingId(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h3>Groups</h3>
      {error && <div className="warning-banner">{error}</div>}
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Members</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) =>
            editingId === group.id ? (
              <tr key={group.id}>
                <td data-label="Name">
                  <input className="field-input" value={editName} onChange={(e) => setEditName(e.target.value)} />
                </td>
                <td data-label="Members" className="host-detail-cell">
                  <div className="label checklist-caption">Members</div>
                  <div className="checkbox-list">
                    {users.map((u) => (
                      <label key={u.id} style={{ display: 'block' }}>
                        <input type="checkbox" checked={editUserIds.has(u.id)} onChange={() => toggleEditUser(u.id)} /> {u.username}
                      </label>
                    ))}
                  </div>
                </td>
                <td data-label="Actions">
                  <div className="actions-cell actions-cell-end">
                    <button className="button" onClick={saveEdit} disabled={saving || !editName.trim()}>
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button className="button" onClick={() => setEditingId(null)} disabled={saving}>
                      Cancel
                    </button>
                  </div>
                </td>
              </tr>
            ) : (
              <tr key={group.id}>
                <td data-label="Name">{group.name}</td>
                <td data-label="Members">{group.userIds.map(username).join(', ') || '—'}</td>
                <td data-label="Actions">
                  <div className="actions-cell actions-cell-end">
                    <button className="button" onClick={() => startEdit(group)}>
                      Edit
                    </button>
                    <button className="button button-danger" onClick={() => setDeletingGroup(group)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>

      <h4>Add group</h4>
      <div className="form-field">
        <label className="label">Name</label>
        <input className="field-input" value={newName} onChange={(e) => setNewName(e.target.value)} />
      </div>
      <button className="button" onClick={createGroup} disabled={creating || !newName.trim()}>
        {creating ? 'Creating…' : 'Add group'}
      </button>

      {deletingGroup && (
        <ConfirmDeleteModal
          message={
            deletingGroup.name === adminGroups.app
              ? 'This is the admin group — deleting it will lock every admin, including you, out of this page. This cannot be undone.'
              : deletingGroup.name === adminGroups.authentikBuiltin
              ? "This is Authentik's own built-in superuser group — deleting it affects Authentik itself, not just this app, and may lock out any admin who relies on it for access to this page. This cannot be undone."
              : `This will permanently delete the group "${deletingGroup.name}". This cannot be undone.`
          }
          confirmLabel="Delete"
          onConfirm={async () => {
            await apiDelete(`/groups/${deletingGroup.id}`);
            await reload();
          }}
          onClose={() => setDeletingGroup(null)}
        />
      )}
    </div>
  );
}
