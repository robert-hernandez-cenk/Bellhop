import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// utils is not visible as a named ESM export of the CommonJS ssh2 package.
import ssh2 from 'ssh2';
import { ensureBellhopKey, keyFromFile } from '../../src/lib/bellhop-key.ts';

const { utils } = ssh2;

function tempDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'bellhop-key-'));
}

test('ensureBellhopKey generates an ed25519 key pair under ssh/ once', () => {
  const dataDir = tempDataDir();
  const first = ensureBellhopKey(dataDir);
  assert.equal(first.path, path.join(dataDir, 'ssh', 'id_ed25519'));
  assert.match(first.authorizedKeysLine, /^ssh-ed25519 [A-Za-z0-9+/=]+ bellhop$/);
  assert.match(readFileSync(first.path, 'utf8'), /BEGIN OPENSSH PRIVATE KEY/);
  assert.equal(readFileSync(`${first.path}.pub`, 'utf8').trim(), first.authorizedKeysLine);
  const second = ensureBellhopKey(dataDir);
  assert.equal(second.authorizedKeysLine, first.authorizedKeysLine);
});

test('keyFromFile accepts an unencrypted OpenSSH private key and derives its public line', () => {
  const dir = tempDataDir();
  const pair = utils.generateKeyPairSync('ed25519', { comment: 'example' });
  const keyPath = path.join(dir, 'id_ed25519');
  writeFileSync(keyPath, pair.private);
  const key = keyFromFile(keyPath);
  assert.equal(key.path, keyPath);
  assert.equal(key.authorizedKeysLine.split(' ').slice(0, 2).join(' '), pair.public.split(' ').slice(0, 2).join(' '));
  assert.match(key.authorizedKeysLine, / bellhop$/);
});

test('keyFromFile refuses a passphrase-protected key', () => {
  const dir = tempDataDir();
  const pair = utils.generateKeyPairSync('ed25519', { passphrase: 'changeme', cipher: 'aes256-cbc', rounds: 2 });
  const keyPath = path.join(dir, 'id_ed25519');
  writeFileSync(keyPath, pair.private);
  assert.throws(() => keyFromFile(keyPath), /passphrase-protected keys can't be used unattended/);
});

test('keyFromFile refuses a file that is not a private key, and a missing file', () => {
  const dir = tempDataDir();
  const notKey = path.join(dir, 'notes.txt');
  writeFileSync(notKey, 'not a key');
  assert.throws(() => keyFromFile(notKey), /is not an SSH private key/);
  assert.throws(() => keyFromFile(path.join(dir, 'missing')), /can't be read/);
});
