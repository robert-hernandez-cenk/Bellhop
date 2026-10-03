// The only module that knows how a Bellhop user maps to a Proxmox user and
// how per-guest Proxmox ACLs are read and written (issue #53). Its callers
// are the create-vm operation (granting a newly created guest's creator
// access to it) and runMigrateGuest (copying an existing guest's ACLs onto
// its new VMID after a migration) -- see
// specs/016-pve-creator-acl/contracts/pve-acl.md. Every remote call goes
// through runRemote against a pve host.

export const DEFAULT_CREATOR_ROLE = 'PVEVMAdmin';

export interface Actor {
  username: string;
  email?: string;
}
