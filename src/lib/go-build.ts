import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export interface GoBuilder {
  build(sourceDir: string): Promise<Buffer>;
}

// Cross-compiles vpn-gateway-agent/ for the gateway LXC's architecture
// (linux/amd64 -- every host in this toolkit's inventory is amd64) and
// returns the resulting binary's bytes. Shells out to the real `go`
// toolchain -- like Ssh2SSHClient, this has no automated test of its own
// (verified manually: `go build -o ... .` against vpn-gateway-agent/'s own
// source tree, confirmed live during that module's own implementation).
// deploy-vpn-gateway takes a GoBuilder so its own tests can inject a fake
// instead of actually invoking `go`.
export class LocalGoBuilder implements GoBuilder {
  async build(sourceDir: string): Promise<Buffer> {
    const dir = await mkdtemp(path.join(tmpdir(), 'vpn-gateway-agent-build-'));
    const outPath = path.join(dir, 'vpn-gateway-agent');
    try {
      await execFileAsync('go', ['build', '-o', outPath, '.'], {
        cwd: sourceDir,
        env: { ...process.env, GOOS: 'linux', GOARCH: 'amd64' },
      });
      return await readFile(outPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
