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
      return await chromium.launch(channel ? { channel } : {});
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

  let demo: DemoServer | undefined;
  const tempDir = mkdtempSync(path.join(tmpdir(), 'bellhop-screenshots-'));
  try {
    demo = await startDemoServer({ port: 0 });
    mkdirSync(IMAGES_DIR, { recursive: true });
    for (const shot of SCREENSHOTS) {
      try {
        await capture(browser, demo, shot, tempDir);
      } catch (err) {
        console.error(`Screenshot ${shot.file} failed: ${firstLine(err)}`);
        return 1;
      }
      console.log(`  wrote docs/images/${shot.file}`);
    }
    return 0;
  } finally {
    await browser.close();
    await demo?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
