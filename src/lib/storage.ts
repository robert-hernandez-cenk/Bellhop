import type { HostEntry, StorageEntry } from './inventory.ts';

// Picks the first active storage on the host supporting one of the given
// Proxmox content types (e.g. 'vztmpl' for a template cache, 'rootdir'/
// 'images' for a container's/VM's own disk). Different hosts can have
// different storage pools available (confirmed live: one host has no
// vztmpl-capable pool besides 'local' and 'nas-proxmox', unlike the
// other) -- there is no single hardcoded default that's correct
// everywhere, so this always reads from sync-inventory's scanned
// hosts[].storages data.
export function pickStorage(host: HostEntry, contentTypes: string[]): string {
  const candidate = (host.storages ?? []).find((s) => s.active && contentTypes.some((ct) => s.content.includes(ct)));
  if (!candidate) {
    throw new Error(
      `Host '${host.name}' has no active storage supporting content type ${contentTypes.join('/')} -- run sync-inventory to refresh its storage list (Maintenance -> Sync Inventory), or check its Proxmox storage configuration`
    );
  }
  return candidate.name;
}

// Returns every active backup-capable storage on the host, rather than
// picking one like pickStorage does -- the operator chooses which backup
// target to use from a dropdown (Dashboard's DeleteGuestModal) rather than
// it being auto-selected, since guessing wrong here risks backing up to
// storage the operator didn't intend or one with no room.
export function listBackupStorages(host: HostEntry): StorageEntry[] {
  return (host.storages ?? []).filter((s) => s.active && s.content.includes('backup'));
}
