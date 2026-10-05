# Proxmox ACL/realm fixtures

Captured from Proxmox VE 9.2.10 on 2026-10-03 via the commands in
`specs/016-pve-creator-acl/research.md` (R1-R5), with every identifying value
(emails, realm name, VMIDs) replaced by example values per the constitution
(Principle I) -- field names, types, nesting, and array lengths are
otherwise unchanged from the live capture.

## Setup walkthrough discovery fixtures (#86)

`version.json`, `cluster-status.json`, `cluster-status-standalone.json` and
`network.json` were captured from Proxmox VE 9.2.10 on 2026-10-05 with
`pvesh get /version`, `/cluster/status` and `/nodes/<node>/network`
(`--output-format json`), then redacted: node names became `pve1`/`pve2`,
addresses became RFC 5737 (`192.0.2.x`), and the repo id, cluster name and
interface MAC-derived names became examples. Field names, types, nesting and
array lengths are unchanged.

`cluster-status-standalone.json` is not a separate capture: no standalone node
was available, so it is the clustered capture reduced to its local node entry
(a standalone node reports only itself, with no `cluster` entry).
