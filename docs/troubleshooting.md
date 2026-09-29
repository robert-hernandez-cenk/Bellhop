# Troubleshooting

## Validation

```bash
npm run typecheck   # tsc --noEmit — run after editing any TypeScript file
npm test            # unit tests, against a FakeSSHClient — no real network
```

`src/lib/ssh-client.ts`'s `Ssh2SSHClient` (the only file that opens a real
SSH connection) has no automated test; dry-run mode against real
infrastructure is the safety net for that piece specifically.

## Known hardware issues

One host's onboard NIC (Intel I219-LM, `e1000e` driver,
`nic0`) chronically threw `Detected Hardware Unit Hang` errors — hundreds
per boot, in bursts, throughout normal uptime rather than as a one-off. Each
burst stalls the NIC's TX queue, which breaks corosync cluster heartbeats
(`Token has not been received`) and drops any live connection over that
NIC, including SSH sessions — this is what "the host keeps dying" turned
out to be. On 2026-07-27 one burst was severe enough to hang the
filesystem sync during shutdown and force a reboot.

Root cause: Energy Efficient Ethernet (EEE) was enabled on the NIC, a
known trigger for this exact failure signature on Intel I219 controllers.
Fixed by disabling EEE (`ethtool --set-eee nic0 eee off`) and persisting it
across reboots via `/etc/systemd/system/disable-eee-nic0.service` (enabled,
`WantedBy=multi-user.target`) directly on that host — this is a host-level
OS fix, not something `inventory/bellhop.db` or any command in this repo
manages.
