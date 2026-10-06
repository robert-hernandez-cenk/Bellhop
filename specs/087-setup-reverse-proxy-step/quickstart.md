# Quickstart: validating the reverse-proxy step (#87)

Run from the worktree with `npm --prefix <wt> ...` (never `cd` into it).

## Automated

```bash
npm run typecheck
npm test                         # includes test/web/setup/proxy.test.ts and the per-driver check tests
```

Expected: all pass. The new tests assert, per driver, that a check issues no write, backup, restore or reload command (`ssh.history` holds only read commands), that a failing check names the entry or setting, and that no response or error contains a secret value.

## Manual: the walkthrough on a throwaway install

The walkthrough only shows on an install with no hosts, so use an empty temporary database, not the deployment checkout's.

1. Start the web service against a temp `INVENTORY_FILE` and a temp data directory, with the demo's simulated Proxmox transport (`npm run demo` shows how `DemoSSHClient` is wired; the walkthrough needs a pending install rather than the demo's seeded one). Note the setup address in the log and open it.
2. Complete **Proxmox** and **Domain and basics** (domain `example.com`).
3. Open **Reverse proxy**:
   - Pick "Nginx Proxy Manager", choose a guest, enter `http://192.0.2.30:81`, an email and a password. Save: the password field now reads "set" and never shows the value.
   - Run the check with the simulated NPM unreachable: an error naming the URL; the step stays incomplete and Finish is refused.
   - Make the simulated NPM answer: the check passes, the dry-run text appears, the step is marked complete.
4. Switch the driver to Caddy: the step becomes incomplete; the TLS source list shrinks to Caddy's sources; the NPM fields disappear.
5. Switch to "No proxy" and save: the step completes without a check.
6. Repeat 3 and 4 at a ≤640px viewport; check that no control overflows and the preview text scrolls inside its box.

## What must hold

- The proxy flag sits on exactly one entry after any sequence of saves.
- The Cloudflare token and NPM password appear nowhere in responses, logs or the DB's inventory tables.
- Reopening the walkthrough shows the saved choice and `set`/`not set` for secrets.
