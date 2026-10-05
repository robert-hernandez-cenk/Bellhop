# Contract: the ProxmoxVED fork installer

Files on the fork's `bellhop` branch (merged into `local`):

## `ct/bellhop.sh`

- `APP="Bellhop"`, `var_tags="${var_tags:-proxmox;homelab;dashboard}"`, `var_cpu` 2, `var_ram` 2048, `var_disk` 8, `var_os` debian, `var_version` 13, `var_unprivileged` 1.
- `update_script()`:
  1. `header_info`, `check_container_storage`, `check_container_resources`.
  2. If `/opt/bellhop` is missing: `msg_error "No ${APP} Installation Found!"` and exit.
  3. `if check_for_gh_release "bellhop" "robert-hernandez-cenk/Bellhop"`:
     stop `bellhop`; `NODE_VERSION="24" setup_nodejs`; `CLEAN_INSTALL=1 fetch_and_deploy_gh_release "bellhop" "robert-hernandez-cenk/Bellhop" "tarball"`; `npm ci`; `npm run web:build`; start `bellhop`; `msg_ok "Updated successfully!"`.
  4. Never reads or writes `/var/lib/bellhop` or `/etc/default/bellhop`.
- Final output: the URL `http://${IP}:3000`, then a pointer to `docs/lxc-container.md`. The public key is printed by the install script, inside the container's install log, and the docs say how to read it again (`cat /var/lib/bellhop/.ssh/id_ed25519.pub`).

## `install/bellhop-install.sh`

In order:

1. Standard preamble (`setting_up_container`, `network_check`, `update_os`).
2. `apt install -y build-essential python3 git openssh-client`.
3. `NODE_VERSION="24" setup_nodejs`.
4. `fetch_and_deploy_gh_release "bellhop" "robert-hernandez-cenk/Bellhop" "tarball"`, then `npm ci` and `npm run web:build` in `/opt/bellhop`.
5. `useradd --system --home-dir /var/lib/bellhop --create-home --shell /bin/bash bellhop` (skipped if it exists); `mkdir -p /var/lib/bellhop/{inventory,data,.ssh}`; `chown -R bellhop:bellhop /var/lib/bellhop`; `.ssh` mode 0700.
6. `ssh-keygen -t ed25519 -N "" -C "bellhop@$(hostname)" -f /var/lib/bellhop/.ssh/id_ed25519` as `bellhop`, only if the key is absent.
7. Write `/etc/default/bellhop`:

   ```sh
   PORT=3000
   INVENTORY_FILE=/var/lib/bellhop/inventory/bellhop.db
   WEB_DATA_DIR=/var/lib/bellhop/data
   ```

8. Write `/usr/local/bin/bellhop` (0755):

   ```sh
   #!/bin/sh
   set -a
   . /etc/default/bellhop
   set +a
   if [ "$(id -u)" -eq 0 ]; then
     exec runuser -u bellhop -- env PORT="$PORT" INVENTORY_FILE="$INVENTORY_FILE" WEB_DATA_DIR="$WEB_DATA_DIR" node /opt/bellhop/bin/bellhop.js "$@"
   fi
   exec node /opt/bellhop/bin/bellhop.js "$@"
   ```

9. (No setting is written: a fresh install has no inventory yet, see research R7.)
10. Write `/etc/systemd/system/bellhop.service`:

    ```ini
    [Unit]
    Description=Bellhop web UI
    After=network-online.target
    Wants=network-online.target

    [Service]
    Type=simple
    User=bellhop
    Group=bellhop
    WorkingDirectory=/opt/bellhop
    EnvironmentFile=/etc/default/bellhop
    ExecStart=/usr/bin/node --import tsx src/web/server.ts
    Restart=on-failure
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
    ```

    then `systemctl enable -q --now bellhop`.
11. Print the public key with instructions (append to `/root/.ssh/authorized_keys` on a Proxmox host, which is cluster-wide), and the exact `bellhop set-config bellhopGuest <hostname> --apply` line to run once the inventory is imported.
12. `motd_ssh`, `customize`, `cleanup_lxc`.

No `read`, no secret, no prompt anywhere.

## `json/bellhop.json`

Same shape as the fork's other app manifests: `slug` `bellhop`, `type` `ct`, `updateable` true, `privileged` false, `interface_port` 3000, `config_path` `/etc/default/bellhop`, resources matching `ct/bellhop.sh`, null default credentials, notes on the SSH key, sign-in, and where data lives.
