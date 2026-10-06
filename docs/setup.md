# First-run setup

A fresh Bellhop install has no inventory, no settings and no way to reach your Proxmox hosts yet. The first time the web service starts on such an install, it opens a setup walkthrough in the web UI that takes it from nothing to a working inventory. The walkthrough runs once. When it finishes it is turned off for good, and every value it set stays editable on the Settings page, with `set-config`, and on the Dashboard.

An install that already has Proxmox hosts in its inventory never sees the walkthrough.

## The setup address and token

Until sign-in is configured there is no login, so the walkthrough is protected by a one-time **setup token** instead. On every start while setup is pending, the service writes the setup address to its log:

```text
Setup is pending: open http://localhost:3001/setup?token=<token> (from another device, use this machine's address instead of localhost)
```

- Open that address in a browser. The token is swapped for a cookie that lasts for the browser session, and the address bar drops it.
- The token stays the same across restarts until setup finishes, so an address the installer printed keeps working.
- Without the token, nothing is reachable: pages redirect to the setup page (which asks for the setup address), and every API call answers `503` "setup is in progress".
- The cookie works over plain HTTP, because setup runs before any reverse proxy or TLS certificate exists. Run setup from a network you trust.
- Finishing setup deletes the token. It never works again, even after a restart.

## Step 1: Proxmox

1. **Bellhop's SSH key.** Bellhop generates its own ed25519 key pair and keeps it on the Bellhop machine (`data/ssh/id_ed25519`). You can name an existing unencrypted private key file instead. The page shows the public key.
2. **The first host.** Enter its address, SSH user (normally `root`) and port.
3. **Install the key**, either:
   - **with the root password**: Bellhop connects once with the password, adds its public key to that user's `authorized_keys` (only if it isn't already there), and forgets the password. The password is never stored, logged or shown back; or
   - **by hand**: copy the shown `authorized_keys` line onto the host yourself.
4. **Test.** Bellhop connects with its key and checks that the machine is a Proxmox node.
5. **Save.** The host is added under its Proxmox node name. Bellhop then discovers its bridges, storage and guests, the same as `sync-inventory --apply`.
6. **Cluster nodes.** If the host is in a cluster, the other nodes are listed with their addresses. Add each the same way, or skip it.
7. **MID scheme.** For each host, Bellhop suggests a `midScheme` (VMID base, IP prefix, gateway) from the host's bridge network. Adjust it and save it. See [Configuration](configuration.md) for what the MID scheme does.

Every action in this step is safe to repeat. Saving a host again updates it rather than duplicating it, and keeps its guests.

## Step 2: Domain and basics

- **Domain** (required): the base domain your subdomains are served under, e.g. `example.com`.
- **LAN DNS server**, **backup storage** and **NFS server** (optional): see [Inventory-wide settings](configuration.md#inventory-wide-settings) for what each one does and what happens while it is unset.

## Finish

Finish is available once both steps are complete. It turns the walkthrough off, deletes the setup token and opens the Dashboard.

The web UI's sign-in mode is not changed by finishing. On a fresh install that is `none`: anyone who can reach the port is a full admin, as before setup existed. Configure sign-in afterwards as described in [Authentik](authentik.md).

## Resuming

Progress is saved after every step. Closing the browser or restarting the service is safe: open the setup address again and the walkthrough opens at the first unfinished step, with what you already saved.
