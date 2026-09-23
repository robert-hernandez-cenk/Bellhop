import { useState } from 'react';
import { apiDelete, apiPatch, apiPost } from '../api/client';
import type { AuthentikGroupEntry, AuthentikUserEntry } from '../api/types';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';

interface Props {
  users: AuthentikUserEntry[];
  groups: AuthentikGroupEntry[];
  whoamiUsername: string | null;
  reload: () => Promise<void>;
}

export function UsersSection({ users, groups, whoamiUsername, reload }: Props) {
  const [newUsername, setNewUsername] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newGroupIds, setNewGroupIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [recoveryLink, setRecoveryLink] = useState<string | null>(null);
  const [recoveryLinkError, setRecoveryLinkError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editUsername, setEditUsername] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editGroupIds, setEditGroupIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deletingUser, setDeletingUser] = useState<AuthentikUserEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? id;

  const toggleSet = (set: Set<string>, id: string, setter: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  const createUser = async () => {
    setCreating(true);
    setError(null);
    setRecoveryLink(null);
    setRecoveryLinkError(null);
    try {
      const res = await apiPost<{
        user: AuthentikUserEntry;
        recoveryLink: string | null;
        recoveryLinkError?: string;
      }>('/users', {
        username: newUsername.trim(),
        email: newEmail.trim(),
        groupIds: [...newGroupIds],
      });
      // The account is created either way once this request succeeds --
      // reload unconditionally so it shows up even if the recovery-link
      // follow-up call below failed.
      setRecoveryLink(res.recoveryLink);
      setRecoveryLinkError(res.recoveryLinkError ?? null);
      setNewUsername('');
      setNewEmail('');
      setNewGroupIds(new Set());
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (user: AuthentikUserEntry) => {
    setEditingId(user.id);
    setEditUsername(user.username);
    setEditEmail(user.email);
    setEditGroupIds(new Set(user.groupIds));
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setSaving(true);
    setError(null);
    setRecoveryLink(null);
    setRecoveryLinkError(null);
    setLinkFor(null);
    try {
      await apiPatch(`/users/${editingId}`, {
        username: editUsername.trim(),
        email: editEmail.trim(),
        groupIds: [...editGroupIds],
      });
      setEditingId(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (user: AuthentikUserEntry) => {
    setBusyId(user.id);
    setError(null);
    setRecoveryLink(null);
    setRecoveryLinkError(null);
    setLinkFor(null);
    try {
      await apiPost(`/users/${user.id}/${user.isActive ? 'deactivate' : 'reactivate'}`, {});
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const generateLink = async (user: AuthentikUserEntry) => {
    setBusyId(user.id);
    setError(null);
    setLinkFor(null);
    try {
      const res = await apiPost<{ recoveryLink: string }>(`/users/${user.id}/recovery-link`, {});
      setLinkFor(res.recoveryLink);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <h3>Users</h3>
      {error && <div className="warning-banner">{error}</div>}
      {recoveryLink && (
        <div className="page-description">
          Account created. Share this one-time recovery link so the new user can set their password:
          <pre className="preview-pane">{recoveryLink}</pre>
        </div>
      )}
      {recoveryLinkError && (
        <div className="page-description">
          Account created, but generating a recovery link failed: {recoveryLinkError}. Use the "New recovery link"
          button on this user's row to try again once the issue is resolved.
        </div>
      )}
      {linkFor && (
        <div className="page-description">
          New recovery link:
          <pre className="preview-pane">{linkFor}</pre>
        </div>
      )}
      <table className="data-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Email</th>
            <th>Status</th>
            <th>Groups</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) =>
            editingId === user.id ? (
              <tr key={user.id}>
                <td data-label="Username">
                  <input className="field-input" value={editUsername} onChange={(e) => setEditUsername(e.target.value)} />
                </td>
                <td data-label="Email">
                  <input className="field-input" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} />
                </td>
                <td data-label="Status">{user.isActive ? 'Active' : 'Deactivated'}</td>
                <td data-label="Groups" className="host-detail-cell">
                  <div className="label checklist-caption">Groups</div>
                  <div className="checkbox-list">
                    {groups.map((g) => (
                      <label key={g.id} style={{ display: 'block' }}>
                        <input
                          type="checkbox"
                          checked={editGroupIds.has(g.id)}
                          onChange={() => toggleSet(editGroupIds, g.id, setEditGroupIds)}
                        />{' '}
                        {g.name}
                      </label>
                    ))}
                  </div>
                </td>
                <td data-label="Actions">
                  <div className="actions-cell actions-cell-end">
                    <button
                      className="button"
                      onClick={saveEdit}
                      disabled={saving || !editUsername.trim() || !editEmail.trim()}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button className="button" onClick={() => setEditingId(null)} disabled={saving}>
                      Cancel
                    </button>
                  </div>
                </td>
              </tr>
            ) : (
              <tr key={user.id}>
                <td data-label="Username">{user.username}</td>
                <td data-label="Email">{user.email}</td>
                <td data-label="Status">{user.isActive ? 'Active' : 'Deactivated'}</td>
                <td data-label="Groups">{user.groupIds.map(groupName).join(', ') || '—'}</td>
                <td data-label="Actions">
                  <div className="actions-cell actions-cell-end">
                    <button className="button" onClick={() => startEdit(user)}>
                      Edit
                    </button>
                    <button
                      className="button"
                      onClick={() => toggleActive(user)}
                      disabled={busyId === user.id || user.username === whoamiUsername}
                    >
                      {user.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                    <button className="button" onClick={() => generateLink(user)} disabled={busyId === user.id}>
                      New recovery link
                    </button>
                    <button
                      className="button button-danger"
                      onClick={() => setDeletingUser(user)}
                      disabled={user.username === whoamiUsername}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>

      <h4>Add user</h4>
      <div className="form-field">
        <label className="label">Username</label>
        <input className="field-input" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} />
      </div>
      <div className="form-field">
        <label className="label">Email</label>
        <input className="field-input" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
      </div>
      <div className="form-field">
        <label className="label">Groups</label>
        <div className="checkbox-list">
          {groups.map((g) => (
            <label key={g.id} style={{ display: 'block' }}>
              <input
                type="checkbox"
                checked={newGroupIds.has(g.id)}
                onChange={() => toggleSet(newGroupIds, g.id, setNewGroupIds)}
              />{' '}
              {g.name}
            </label>
          ))}
        </div>
      </div>
      <button className="button" onClick={createUser} disabled={creating || !newUsername.trim() || !newEmail.trim()}>
        {creating ? 'Creating…' : 'Add user'}
      </button>

      {deletingUser && (
        <ConfirmDeleteModal
          message={`This will permanently delete the account "${deletingUser.username}". This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            setRecoveryLink(null);
            setRecoveryLinkError(null);
            setLinkFor(null);
            await apiDelete(`/users/${deletingUser.id}`);
            await reload();
          }}
          onClose={() => setDeletingUser(null)}
        />
      )}
    </div>
  );
}
