// Seeds the demo's app_update_status table (issue #61) so the Update
// page's badges/notes have something to show without the demo ever running
// a real check-app-updates job. One fixed timestamp, same convention as
// demo-jobs.ts's DEMO_JOBS_DATE, so every seeded "Checked <time>" reads the
// same across runs rather than being wall-clock-dependent.
//
// One guest per visible outcome (research R11/FR-024): jellyfin shows the
// prominent "Update available" badge, homeassistant a quiet "Up to date"
// note, paperless-ngx a quiet "Update check failed" note, and grafana (one
// of DemoSSHClient's two simulated-stopped guests, demo-ssh.ts) a quiet
// "Not checked" note -- the same reason a real stopped guest gets
// (check-app-updates.ts). Every other lxc+app guest in the demo inventory
// is left unseeded, which the Update page renders the same way an
// unsupported/never-checked app does: no badge at all.
import { replaceAppUpdateResults } from '../../src/lib/app-update-store.ts';

const CHECKED_AT = '2026-09-14T04:00:41.000Z';

export function seedDemoAppUpdates(dbPath: string): void {
  replaceAppUpdateResults(dbPath, [
    {
      guest: 'jellyfin',
      app: 'jellyfin',
      status: 'update-available',
      installedVersion: '10.8.13',
      latestVersion: '10.9.0',
      repo: 'jellyfin/jellyfin',
      checkedAt: CHECKED_AT,
    },
    {
      guest: 'homeassistant',
      app: 'homeassistant',
      status: 'up-to-date',
      installedVersion: '2026.9.0',
      checkedAt: CHECKED_AT,
    },
    {
      guest: 'paperless-ngx',
      app: 'paperless-ngx',
      status: 'error',
      message: 'GitHub API rate limit reached; the next scheduled check will retry',
      checkedAt: CHECKED_AT,
    },
    {
      guest: 'grafana',
      app: 'grafana',
      status: 'not-checked',
      message: 'Guest is stopped',
      checkedAt: CHECKED_AT,
    },
  ]);
}
