# Data Model: ProxmoxVED → DevScripts

No stored data changes (research R3).

| Entity | Before | After |
|---|---|---|
| `ShadowedRepo` (computed, `src/lib/app-source.ts`) | `'ProxmoxVE' \| 'ProxmoxVED'` | `'ProxmoxVE' \| 'DevScripts'` |
| Upstream development base URL | `https://raw.githubusercontent.com/community-scripts/ProxmoxVED/main` | `https://raw.githubusercontent.com/community-scripts/DevScripts/main` |
| Compare upstream | `community-scripts/ProxmoxVED` | `community-scripts/DevScripts` |
| Catalog dev listing | `api.github.com/repos/community-scripts/ProxmoxVED/contents/ct` | `.../community-scripts/DevScripts/contents/ct` |

Resolution (unchanged apart from the name): the custom fork only for apps its branch changes or only it has; otherwise ProxmoxVE, then DevScripts.
