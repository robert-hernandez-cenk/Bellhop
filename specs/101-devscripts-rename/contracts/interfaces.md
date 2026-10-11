# Interface changes: ProxmoxVED → DevScripts

Example values only: fork `example-user/my-scripts`, branch `my-apps`.

- **App check result** (`/api/provisioning/install-app/check-app`, MCP `check_install_app`): each `shadows` entry is `"ProxmoxVE"` or `"DevScripts"`.
- **Catalog** (`/api/provisioning/install-app/apps`, MCP `list_install_apps`): each `custom.shadows[slug]` entry uses the same two names.
- **Generated install/update command** for a bare upstream slug:
  `bash -c "$(curl -fsSL '.../community-scripts/ProxmoxVE/main/ct/<slug>.sh' 2>/dev/null || curl -fsSL '.../community-scripts/DevScripts/main/ct/<slug>.sh')"`
- **Messages**:
  - override: `"<slug>" comes from the custom script repository <label> (commit <short>) in place of the upstream copy in ProxmoxVE, DevScripts.`
  - conflict: `"<slug>" changed upstream in DevScripts since <label> branched ...`
  - fork-network error: `commit <short> not found in community-scripts/DevScripts's fork network (is <owner>/<repo> a fork of DevScripts?)`
- **Web UI**: the catalog group header reads `DevScripts (development)`, and the dev-only notice reads "community-scripts' DevScripts repo".
