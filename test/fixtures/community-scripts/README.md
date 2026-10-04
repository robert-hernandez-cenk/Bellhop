# community-scripts `ct/*.sh` fixtures

Captured live from `community-scripts/ProxmoxVE`'s `main` branch on
2026-10-03. Public upstream source, not operator data -- no redaction
needed (constitution Principle I). Stored exactly as fetched.

| File | How it was produced | Why it was picked |
| --- | --- | --- |
| `homepage.sh` | `curl -s https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/homepage.sh` | Its first (and only) `check_for_gh_release` call is a plain one with no pin: `check_for_gh_release "homepage" "gethomepage/homepage"`. |
| `immich.sh` | `curl -s https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/immich.sh` | Its first `check_for_gh_release` call pins through a variable reference resolved from a literal assignment earlier in the script: `RELEASE="v3.2.4"` then `check_for_gh_release "Immich" "immich-app/immich" "${RELEASE}" "..."` (research R2's surveyed `"${RELEASE}"` case). |
