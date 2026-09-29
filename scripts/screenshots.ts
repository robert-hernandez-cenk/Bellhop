// The documentation's screenshot set: one entry per image under
// docs/images/, captured against the demo instance by
// scripts/capture-screenshots.ts. Data only -- no browser is launched here.
// See specs/014-web-ui-screenshots/contracts/screenshot-set.md.
//
// Selectors key on visible text, roles and accessible names (aria-label)
// rather than CSS classes where the UI offers one, so a styling change does
// not break capture. Class selectors appear only where nothing else names
// the element (the modal box an element capture crops to, the job log).
import type { Page } from 'playwright-core';

export type ScreenshotViewport = 'desktop' | 'phone';
export type ScreenshotTheme = 'light' | 'dark';

export interface ScreenshotDefinition {
  // File name under docs/images/. Stable: the docs link to it (FR-013).
  file: string;
  // Page path to open, relative to the demo's base URL. A function when the
  // path depends on demo data looked up at capture time.
  path: string | ((baseUrl: string) => Promise<string>);
  viewport: ScreenshotViewport;
  theme: ScreenshotTheme;
  // Selector that only exists once the screen's data has loaded.
  ready: string;
  // Steps after navigation (open a modal, type into a field). Runs before
  // the ready selector is awaited, so `ready` can name its end state.
  prepare?: (page: Page) => Promise<void>;
  // Element to capture instead of the whole viewport.
  target?: string;
}

// An enabled Shutdown button means /api/guests/status has come back: the
// power buttons stay disabled until a guest's status is known.
const GUEST_STATUSES_LOADED = 'button[aria-label="Shutdown"]:enabled';

// The seeded install-app job's id, from the demo's own job list -- never
// hardcoded, since ids are assigned by the jobs database at seed time.
async function installAppJobPath(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/jobs`);
  if (!res.ok) throw new Error(`GET /api/jobs returned ${res.status}`);
  const jobs = (await res.json()) as Array<{ id: number; command: string }>;
  const job = jobs.find((j) => j.command === 'install-app');
  if (!job) throw new Error('the demo has no seeded install-app job');
  return `/jobs/${job.id}`;
}

export const SCREENSHOTS: ScreenshotDefinition[] = [
  {
    file: 'dashboard.png',
    path: '/',
    viewport: 'desktop',
    theme: 'light',
    ready: GUEST_STATUSES_LOADED,
  },
  {
    file: 'install-app-catalog.png',
    path: '/provisioning/install-app',
    viewport: 'desktop',
    theme: 'light',
    // "ar" matches a few stable apps and one development app, so the list
    // shows both catalog groups without scrolling.
    ready: 'role=option[name="budget-board"]',
    prepare: async (page) => {
      // The suggestion list opens once the field has a query and the catalog
      // has loaded (in either order).
      const app = page.getByPlaceholder('e.g. plex, or paste a full script URL');
      await app.click({ timeout: 15_000 });
      await app.pressSequentially('ar');
    },
  },
  {
    file: 'job-log.png',
    path: installAppJobPath,
    viewport: 'desktop',
    theme: 'dark',
    ready: 'pre.job-log:has-text("install-app completed successfully.")',
    prepare: async (page) => {
      // The Job page scrolls its log to the end once it loads; make sure the
      // page itself starts at the top, so the job title and status badge
      // are in view above the log.
      await page.locator('pre.job-log:has-text("install-app completed successfully.")').waitFor({ timeout: 15_000 });
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        document.querySelector('main')?.scrollTo(0, 0);
      });
    },
  },
  {
    file: 'update-page.png',
    path: '/update',
    viewport: 'desktop',
    theme: 'light',
    ready: 'button[aria-label="Update via community-script"]:enabled',
  },
  {
    file: 'dashboard-phone.png',
    path: '/',
    viewport: 'phone',
    theme: 'light',
    ready: GUEST_STATUSES_LOADED,
  },
  {
    file: 'guest-access-oidc.png',
    path: '/',
    viewport: 'desktop',
    theme: 'light',
    ready: 'role=tab[name="Access"][selected=true]',
    prepare: async (page) => {
      // The demo itself has no Authentik (UnconfiguredAuthentikClient), so
      // /api/auth-groups reports `configured: false` and the auth group
      // dropdown shows a "not configured" warning -- out of place in docs
      // about a feature that needs Authentik. This route answers it the way
      // a configured deployment whose ladder groups all exist would; it is
      // registered on this screenshot's own page only, so no other
      // screenshot and nothing on the demo server is affected.
      await page.route('**/api/auth-groups', async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { canLower: boolean; rungs: Array<{ name: string }> };
        await route.fulfill({
          json: { configured: true, canLower: body.canLower, rungs: body.rungs.map((r) => ({ name: r.name, exists: true })) },
        });
      });
      // vaultwarden is the demo's one guest in OIDC mode.
      const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'vaultwarden', exact: false }) });
      await row.getByRole('button', { name: 'advanced' }).click({ timeout: 15_000 });
      await page.getByRole('heading', { name: 'Advanced — vaultwarden' }).waitFor({ timeout: 15_000 });
      await page.getByRole('tab', { name: 'Access' }).click();
    },
    target: '.modal-box',
  },
  {
    file: 'settings-proxy-driver.png',
    path: '/settings',
    viewport: 'desktop',
    theme: 'light',
    ready: 'role=combobox[name=/^Proxy driver/][disabled=false]',
    prepare: async (page) => {
      // The proxy driver field sits below the fold; bring it and the
      // driver-dependent fields after it to the top of the viewport.
      const driver = page.getByRole('combobox', { name: /^Proxy driver/ });
      await driver.and(page.locator(':enabled')).waitFor({ timeout: 15_000 });
      await driver.evaluate((el) => {
        const field = el.closest<HTMLElement>('.settings-field');
        if (!field) return;
        field.style.scrollMarginTop = '12px';
        field.scrollIntoView({ block: 'start' });
      });
    },
  },
];
