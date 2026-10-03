# Quickstart: Proxmox Access for VM Creators

## Automated

```bash
npm run typecheck
npm test            # includes test/lib/pve-acl.test.ts and the create-vm / migrate-guest / settings tests
npm run web:build
```

## Manual check against a real Proxmox cluster

Prerequisites:
- A Proxmox OpenID realm (example ID `authentik`) whose username claim is
  `username` or `email`, backed by the same identity provider as Bellhop's web UI.
- A non-admin test account in that identity provider.

1. `bellhop set-config pveUserRealm authentik --apply`. Leave `pveCreatorRole`
   unset to get the `PVEVMAdmin` default.
2. Sign in to Bellhop's web UI as the test account and **Preview** a Create
   VM. The preview has a line like `Would grant PVEVMAdmin on /vms/<vmid> to <user>'s Proxmox account (realm authentik)`.
3. **Apply** it. The job log ends with `Granted PVEVMAdmin on VM <vmid> to <userid>`
   and contains no `client-key` value.
4. On a Proxmox host, `pveum acl list` shows `/vms/<vmid>` with the test
   user and role. Sign in to the Proxmox web UI as the test account: the VM
   is listed and can be started and its console opened.
5. Migrate that VM to the other host with `migrate-guest`. Afterwards
   `pveum acl list` shows the same entry on the new VMID, and none on the old
   one.
6. Delete the VM. `pveum acl list` no longer shows its VMID (Proxmox removes
   it; research R4).
7. `bellhop set-config pveUserRealm --unset --apply`, then create another VM
   from the web UI. The job succeeds and logs the "creator grant is off" line.

Every step after 1 that creates or destroys a guest changes real
infrastructure. Use a throwaway MID.
