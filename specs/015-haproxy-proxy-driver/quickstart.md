# Quickstart: validating the HAProxy driver

## 1. Automated

```bash
npm run typecheck
npm test
npm run web:build
```

`test/lib/proxy/drivers/haproxy.test.ts` covers the contract text, backend
naming, the forward-route backstop, and the executed delivery script
(stub `haproxy` exits 1 → both files restored byte for byte, no reload;
exits 0 → both written, reload recorded).

## 2. CLI dry run against a temp inventory

1. Build a fixture: `import-yaml-inventory --yaml-path
   inventory/hosts.yaml.example --db-path <tmp>/bellhop.db --apply`.
2. `INVENTORY_FILE=<tmp>/bellhop.db npm run bellhop -- set-config
   proxyDriver haproxy --apply`.
3. `INVENTORY_FILE=<tmp>/bellhop.db npm run bellhop -- sync-proxy` —
   expect both files printed per `contracts/haproxy-config.md`, or, if the
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

## 4. Settings page

`npm run web:dev`, open Settings: the Proxy driver dropdown lists HAProxy
between Nginx Proxy Manager and No proxy; selecting it shows the config
path field with placeholder `/etc/haproxy/bellhop.cfg` and the
whole-file/`bellhop.map` note, and hides the status page and TLS
certificate fields. Check at desktop width and at ≤640px.
