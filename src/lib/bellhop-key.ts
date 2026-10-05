import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// utils is not visible as a named ESM export of the CommonJS ssh2 package.
import ssh2 from 'ssh2';

const { utils } = ssh2;

// Bellhop's own SSH key (issue #86, research R5): the key the setup
// walkthrough installs on each Proxmox host and records as that host's
// ssh_identity_file, so the existing identity-file lookup in ssh-client.ts
// stays the only way a key is chosen. The generated pair lives under the
// data directory, apart from the operator's personal ~/.ssh keys, so it can
// be revoked per install.

export interface BellhopKey {
  mode: 'generated' | 'file';
  path: string;
  // The public half as one authorized_keys line, comment "bellhop".
  authorizedKeysLine: string;
}

const KEY_COMMENT = 'bellhop';

export function generatedKeyPath(dataDir: string): string {
  return path.join(dataDir, 'ssh', 'id_ed25519');
}

function authorizedKeysLine(privateKey: Buffer | string, keyPath: string): string {
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) {
    if (/passphrase/i.test(parsed.message)) {
      throw new Error(`${keyPath} is passphrase-protected -- passphrase-protected keys can't be used unattended`);
    }
    throw new Error(`${keyPath} is not an SSH private key (${parsed.message})`);
  }
  if (!parsed.isPrivateKey()) throw new Error(`${keyPath} is not an SSH private key (it is a public key)`);
  return `${parsed.type} ${parsed.getPublicSSH().toString('base64')} ${KEY_COMMENT}`;
}

// Creates <dataDir>/ssh/id_ed25519 (+ .pub) the first time and never
// overwrites it afterwards.
export function ensureBellhopKey(dataDir: string): BellhopKey {
  const keyPath = generatedKeyPath(dataDir);
  if (!existsSync(keyPath)) {
    mkdirSync(path.dirname(keyPath), { recursive: true });
    const pair = utils.generateKeyPairSync('ed25519', { comment: KEY_COMMENT });
    writeFileSync(keyPath, pair.private, { mode: 0o600 });
    // writeFileSync's mode is masked by the umask, and is a no-op on
    // Windows; chmod makes it explicit where the platform honors it.
    chmodSync(keyPath, 0o600);
    writeFileSync(`${keyPath}.pub`, `${pair.public}\n`);
  }
  return { mode: 'generated', path: keyPath, authorizedKeysLine: authorizedKeysLine(readFileSync(keyPath), keyPath) };
}

// An existing private key the operator names instead. The public half is
// derived from the private key, so no .pub file is needed.
export function keyFromFile(keyPath: string): BellhopKey {
  let content: Buffer;
  try {
    content = readFileSync(keyPath);
  } catch (err) {
    throw new Error(`${keyPath} can't be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
  }
  return { mode: 'file', path: keyPath, authorizedKeysLine: authorizedKeysLine(content, keyPath) };
}
