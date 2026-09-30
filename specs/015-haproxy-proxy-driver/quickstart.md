# Quickstart: validating the HAProxy driver

## 1. Automated

```bash
npm run typecheck
npm test
npm run web:build
```

`test/lib/proxy/drivers/haproxy.test.ts` covers the contract text
(including the `X-authentik-*` strip on every backend), backend naming, the
forward-route backstop, the `proxyConfigPath` guards, and the executed
delivery script (stub `haproxy` exits 1 → both files restored byte for
byte, no reload; exits 0 → both written, reload recorded; a file carrying
another driver's header → refused, untouched).

## 2. CLI dry run against a temp inventory

1. Build a fixture: `import-yaml-inventory --yaml-path
   inventory/hosts.yaml.example --db-path <tmp>/bellhop.db --apply`.
2. `INVENTORY_FILE=<tmp>/bellhop.db npm run bellhop -- set-config
   proxyDriver haproxy --apply`.
3. `INVENTORY_FILE=<tmp>/bellhop.db npm run bellhop -- sync-proxy` —
   expect both files printed per `contracts/haproxy-config.md`, each under
   its `==> <path> <==` label, or, if the
   example inventory has a forward-gated entry with subdomains, the
   capability error naming it, `haproxy`, and "set its authMode to oidc or
   clear authGroup".

(The dry run makes an SSH call only on `--apply`; do not pass `--apply`
against the example inventory.)

## 3. Real HAProxy check (optional, needs Docker)

Write the rendered files into a directory with a minimal `haproxy.cfg`
holding the frontend from the contract's prerequisite section, then:

```bash
docker run --rm -v "$PWD":/etc/haproxy:ro -v /etc/ssl/certs:/etc/ssl/certs:ro \
  haproxy:lts haproxy -c -f /etc/haproxy/haproxy.cfg -f /etc/haproxy/bellhop.cfg
```

Expect "Configuration file is valid" (2.x) or a silent exit 0 (3.x).

On a real Debian/Ubuntu proxy host the backends file is loaded through
`EXTRAOPTS="-S /run/haproxy-master.sock -f /etc/haproxy/bellhop.cfg"` in
`/etc/default/haproxy` (the `-S` keeps the packaged unit's own default
master socket, which that file overrides), followed once by
`systemctl restart haproxy` — a reload keeps the original command line.

## 4. Settings page

`npm run web:dev`, open Settings: the Proxy driver dropdown lists HAProxy
between Nginx Proxy Manager and No proxy; selecting it shows the config
path field with placeholder `/etc/haproxy/bellhop.cfg` and the
whole-file/`bellhop.map` note, and hides the status page and TLS
certificate fields. Check at desktop width and at ≤640px.
