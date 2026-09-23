import type { StorageEntry } from '../api/types';

// undefined when Proxmox hasn't reported a total for this storage (e.g. it's
// inactive) -- callers fall back to showing the storage type instead.
// GB below 1000 (matches how Proxmox's own UI breaks), TB with one decimal
// above that -- a ~70TB NFS share as "71488 GB" is technically correct but
// unreadable next to a "94 GB" local disk.
export function formatStorageSize(storage: StorageEntry): string | undefined {
  if (!storage.totalBytes) return undefined;
  const gb = storage.totalBytes / 1024 ** 3;
  if (gb >= 1000) return `${(gb / 1024).toFixed(1)} TB`;
  return `${Math.round(gb)} GB`;
}
