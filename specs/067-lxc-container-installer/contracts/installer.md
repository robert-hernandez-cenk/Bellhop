# Contract: the ProxmoxVED fork installer

Files on the fork's `bellhop` branch (merged into `local`). They follow the fork's `AGENTS.md` conventions. Those conventions ban a dedicated service user (anti-patterns 9 and 12, "LXC containers run as root"), `echo` in place of `msg_*`, and listing preinstalled packages as dependencies.

## `ct/bellhop.sh`

- `APP="Bellhop"`, `var_tags="${var_tags:-proxmox;homelab;dashboard}"`, `var_cpu` 2, `var_ram` 2048, `var_disk` 8, `var_os` debian, `var_version` 13, `var_unprivileged` 1.
- `update_script()`:
  1. `header_info`, `check_container_storage`, `check_container_resources`.
  2. If `/opt/bellhop` is missing: `msg_error "No ${APP} Installation Found!"` and exit.
  3. `if check_for_gh_release "bellhop" "robert-hernandez-cenk/Bellhop"`: stop `bellhop`; `NODE_VERSION="24" setup_nodejs`; `CLEAN_INSTALL=1 fetch_and_deploy_gh_release "bellhop" "robert-hernandez-cenk/Bellhop" "tarball"`; `npm ci`; `npm run web:build`; start `bellhop`; `msg_ok "Updated successfully!"`.
  4. Never touches `/var/lib/bellhop`, `/etc/default/bellhop` or `/root/.ssh`.
- Final output (host side, after `description`), following the `pct exec "$CTID"` pattern of `ct/alpine-openbao.sh`:
  - the URL `http://${IP}:3000`;
  - the container's SSH public key (`pct exec "$CTID" -- cat /root/.ssh/id_ed25519.pub`), with the instruction to add it to `/root/.ssh/authorized_keys` on a Proxmox node;
  - `bellhop set-config bellhopGuest <hostname> --apply`, with the hostname read from the container, to run after the inventory import;
  - a link to `docs/lxc-container.md`.

## `install/bellhop-install.sh`

In order:

1. Standard preamble (`setting_up_container`, `network_check`, `update_os`).
2. `apt install -y build-essential python3`: `better-sqlite3`'s source-build fallback. `ssh-keygen` ships with the Debian template's OpenSSH.
3. `NODE_VERSION="24" setup_nodejs`.
4. `fetch_and_deploy_gh_release "bellhop" "robert-hernandez-cenk/Bellhop" "tarball"`, then `npm ci` and `npm run web:build` in `/opt/bellhop`.
5. `mkdir -p /var/lib/bellhop/inventory /var/lib/bellhop/data`.
6. Write `/etc/default/bellhop`:

   ```sh
   PORT=3000
   INVENTORY_FILE=/var/lib/bellhop/inventory/bellhop.db
   WEB_DATA_DIR=/var/lib/bellhop/data
   ```

7. Write `/usr/local/bin/bellhop` (executable):

   ```sh
   #!/bin/sh
   set -a
   . /etc/default/bellhop
   set +a
   exec node /opt/bellhop/bin/bellhop.js "$@"
   ```

8. `ssh-keygen -q -t ed25519 -N "" -C "bellhop@$(hostname)" -f /root/.ssh/id_ed25519`, only if that file is absent. Bellhop's default key lookup (`~/.ssh/id_ed25519` first) finds it.
9. No setting is written: a fresh install has no inventory yet (research R7).
10. Write `/etc/systemd/system/bellhop.service` (`User=root`, `WorkingDirectory=/opt/bellhop`, `EnvironmentFile=/etc/default/bellhop`, `ExecStart=/usr/bin/node --import tsx src/web/server.ts`, `Restart=on-failure`, `RestartSec=5`, after `network-online.target`), then `systemctl enable -q --now bellhop`.
11. `motd_ssh`, `customize`, `cleanup_lxc`.

No `read`, no secret, no prompt anywhere.

## `json/bellhop.json`

Same shape as the fork's other app manifests: `slug` `bellhop`, category 1 (Proxmox & Virtualization), `type` `ct`, `updateable` true, `privileged` false, `interface_port` 3000, `config_path` `/etc/default/bellhop`, resources matching `ct/bellhop.sh`, the logo taken from Bellhop's own `web-client/public/favicon.svg`, null default credentials, and notes on the SSH key, sign-in, the data location and the inventory bootstrap.
