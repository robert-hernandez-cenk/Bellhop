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

## Step 3: Reverse proxy

Point Bellhop at the reverse proxy you already run. Installing a new one is not part of this step, and nothing is written to the proxy here.

1. **Choose the proxy.** Caddy, Caddy (admin API), nginx, Nginx Proxy Manager, HAProxy, Traefik, or **No proxy** if you configure routes yourself (see [Reverse proxy](reverse-proxy/README.md)).
2. **Choose where it runs.** Pick the host or guest from your inventory. That entry is marked as the proxy; choosing another entry later moves the mark.
3. **Fill in its settings.** Only the fields that proxy uses are shown: the config path, Traefik's certificate resolver and API URL, or Nginx Proxy Manager's URL, email and password. They are checked by the same rules as the Settings page.
4. **Choose how certificates are obtained.** Only the sources your proxy supports are offered, with its default marked: DNS-01 through Cloudflare (needs a Cloudflare API token), HTTP-01, self-signed, existing certificate and key files, or managed outside Bellhop. Passwords and tokens are stored write-only: the page shows only whether one is set, and leaving the field blank keeps the saved value.
5. **Save, then check.** The check looks at the live proxy without changing it: the config file or directory exists and the proxy's own validation passes (`caddy validate`, `nginx -t`, `haproxy -c`), or its API answers (Traefik with an API URL, Caddy admin API), or it accepts the sign-in (Nginx Proxy Manager). A failure says what to fix. A pass shows what the first `sync-proxy` would write, exactly as its dry run prints it, and completes the step.

Choosing **No proxy** completes the step with no check. Changing anything afterwards reopens the step until it passes again, and saving the same values twice changes nothing. Reviewing routes the proxy already has is a separate step.

## Finish

Finish is available once all three steps are complete. It turns the walkthrough off, deletes the setup token and opens the Dashboard.

The web UI's sign-in mode is not changed by finishing. On a fresh install that is `none`: anyone who can reach the port is a full admin, as before setup existed. Configure sign-in afterwards as described in [Authentik](authentik.md).

## Resuming

Progress is saved after every step. Closing the browser or restarting the service is safe: open the setup address again and the walkthrough opens at the first unfinished step, with what you already saved.
