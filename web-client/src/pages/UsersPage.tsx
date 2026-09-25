import { useEffect, useState } from 'react';
import { apiGet } from '../api/client';
import type { AuthentikGroupEntry, AuthentikUserEntry } from '../api/types';
import { PageDescription } from '../components/PageDescription';
import { UsersSection } from '../components/UsersSection';
import { GroupsSection } from '../components/GroupsSection';
import { useWhoAmI } from '../lib/whoami';

export function UsersPage() {
  const [users, setUsers] = useState<AuthentikUserEntry[]>([]);
  const [groups, setGroups] = useState<AuthentikGroupEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { whoami } = useWhoAmI();

  const reload = async () => {
    setError(null);
    try {
      const [u, g] = await Promise.all([
        apiGet<AuthentikUserEntry[]>('/users'),
        apiGet<AuthentikGroupEntry[]>('/groups'),
      ]);
      setUsers(u);
      setGroups(g);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  return (
    <div>
      <h2>Users &amp; Groups</h2>
      <PageDescription>
        Manage the accounts and groups this app's sign-in (Authentik) knows about.
      </PageDescription>
      {error && <div className="warning-banner">{error}</div>}
      {loading ? (
        <p>Loading…</p>
      ) : (
        <>
          <UsersSection users={users} groups={groups} whoamiUsername={whoami?.username ?? null} reload={reload} />
          {whoami && <GroupsSection groups={groups} users={users} adminGroups={whoami.adminGroups} reload={reload} />}
        </>
      )}
    </div>
  );
}
