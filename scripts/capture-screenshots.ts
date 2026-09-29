// npm run docs:screenshots -- captures the documentation's screenshot set
// (scripts/screenshots.ts) from the demo instance with an installed browser.
// See specs/014-web-ui-screenshots/contracts/commands.md and research.md R6.
import { existsSync, mkdirSync, mkdtempSync, renameSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContextOptions } from 'playwright-core';
import { REPO_ROOT } from '../src/lib/paths.ts';
import { startDemoServer, type DemoServer } from './demo/demo-server.ts';
import { SCREENSHOTS, type ScreenshotDefinition } from './screenshots.ts';

const READY_TIMEOUT_MS = 15_000;
const IMAGES_DIR = path.join(REPO_ROOT, 'docs', 'images');

const VIEWPORTS: Record<ScreenshotDefinition['viewport'], Pick<BrowserContextOptions, 'viewport' | 'deviceScaleFactor' | 'isMobile' | 'hasTouch'>> = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
};

// Tried in order: installed Chrome, installed Edge, then Playwright's own
// Chromium (present only after `npx playwright install chromium`).
const BROWSER_CHANNELS: Array<{ name: string; channel?: string }> = [
  { name: 'chrome', channel: 'chrome' },
  { name: 'msedge', channel: 'msedge' },
  { name: 'bundled Chromium' },
];

async function launchBrowser(): Promise<Browser | undefined> {
  const failures: string[] = [];
  for (const { name, channel } of BROWSER_CHANNELS) {
    try {
      // Playwright's own SIGINT/SIGTERM handlers close the browser and call
      // process.exit(130) straight away, which would cut main()'s cleanup
      // short and leave the temp directories behind; main() closes the
      // browser itself on those signals instead.
      return await chromium.launch({ ...(channel ? { channel } : {}), handleSIGINT: false, handleSIGTERM: false });
    } catch (err) {
      failures.push(`  ${name}: ${firstLine(err)}`);
    }
  }
  console.error('No browser could be launched:');
  for (const line of failures) console.error(line);
  console.error('Install Google Chrome or Microsoft Edge, or run: npx playwright install chromium');
  return undefined;
}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n').find((line) => line.trim() !== '')?.trim() ?? message;
}

function moveInto(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

async function capture(browser: Browser, demo: DemoServer, shot: ScreenshotDefinition, tempDir: string): Promise<void> {
  const context = await browser.newContext({
    ...VIEWPORTS[shot.viewport],
    colorScheme: shot.theme,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    const pagePath = typeof shot.path === 'function' ? await shot.path(demo.url) : shot.path;
    await page.goto(`${demo.url}${pagePath}`, { waitUntil: 'networkidle' });
    if (shot.prepare) await shot.prepare(page);
    await page.locator(shot.ready).first().waitFor({ timeout: READY_TIMEOUT_MS });
    // Let any fetch the ready state triggered settle before capturing.
    await page.waitForLoadState('networkidle');
    const tempFile = path.join(tempDir, shot.file);
    if (shot.target) {
      await page.locator(shot.target).first().screenshot({ path: tempFile, animations: 'disabled' });
    } else {
      await page.screenshot({ path: tempFile, animations: 'disabled' });
    }
    moveInto(tempFile, path.join(IMAGES_DIR, shot.file));
  } finally {
    await context.close();
  }
}

async function main(): Promise<number> {
  if (!existsSync(path.join(REPO_ROOT, 'web-client', 'dist', 'index.html'))) {
    console.error('The web UI has not been built yet. Run: npm run web:build');
    return 1;
  }

  const browser = await launchBrowser();
  if (!browser) return 1;

  const tempDir = mkdtempSync(path.join(tmpdir(), 'bellhop-screenshots-'));
  // Kept as a promise so cleanup can close a demo that is still starting
  // when Ctrl+C arrives, and so its own temp dir is removed too.
  const demoStarting = startDemoServer({ port: 0 });

  // One idempotent cleanup for both the normal path (finally below) and a
  // SIGINT/SIGTERM, mirroring scripts/demo/serve.ts's shuttingDown pattern:
  // without it, Ctrl+C mid-capture left the demo's and this script's temp
  // directories behind. Each step is guarded so one failure (e.g. a browser
  // the same Ctrl+C already killed) never skips the rest.
  let cleaning: Promise<void> | undefined;
  const cleanup = () => {
    cleaning ??= (async () => {
      await browser.close().catch(() => {});
      await demoStarting.then((demo) => demo.close()).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    })();
    return cleaning;
  };
  let shuttingDown = false;
  const onSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error('Interrupted -- cleaning up.');
    void cleanup().finally(() => process.exit(1));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const demo = await demoStarting;
    mkdirSync(IMAGES_DIR, { recursive: true });
    for (const shot of SCREENSHOTS) {
      try {
        await capture(browser, demo, shot, tempDir);
      } catch (err) {
        // An interrupt closes the browser under an in-flight capture; that
        // failure is the interrupt itself, already reported by onSignal.
        if (!shuttingDown) console.error(`Screenshot ${shot.file} failed: ${firstLine(err)}`);
        return 1;
      }
      console.log(`  wrote docs/images/${shot.file}`);
    }
    return 0;
  } finally {
    await cleanup();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
