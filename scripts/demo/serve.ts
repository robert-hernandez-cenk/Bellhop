// npm run demo -- a throwaway, no-infrastructure instance of the web UI
// against example-only data, for anyone to click through without a real
// Proxmox host, Authentik instance, or inventory. See
// specs/014-web-ui-screenshots/contracts/commands.md.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../src/lib/paths.ts';
import { startDemoServer, type DemoServer } from './demo-server.ts';

function hasErrorCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === code;
}

async function main(): Promise<number> {
  if (!existsSync(path.join(REPO_ROOT, 'web-client', 'dist', 'index.html'))) {
    console.error('The web UI has not been built yet. Run: npm run web:build');
    return 1;
  }

  const port = Number(process.env.PORT ?? 3100);

  let demo: DemoServer;
  try {
    demo = await startDemoServer({ port });
  } catch (err) {
    if (hasErrorCode(err, 'EADDRINUSE')) {
      console.error(`Port ${port} is already in use. Set PORT to another port (PORT=3200 npm run demo in a POSIX shell, $env:PORT=3200; npm run demo in PowerShell)`);
      return 1;
    }
    throw err;
  }

  console.log(`Bellhop demo running at ${demo.url} -- example data only, nothing reaches a real host. Press Ctrl+C to stop.`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void demo.close().then(
      () => process.exit(0),
      (err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return new Promise<number>(() => {
    // Runs until shutdown() calls process.exit() from a signal handler above.
  });
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
