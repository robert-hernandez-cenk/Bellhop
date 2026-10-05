import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localUsername } from '../../src/mcp/local-user.ts';

// The stdio server's job attribution (#65/#66). os.userInfo() throws for a
// uid with no passwd entry (containers run with --user <uid>); the server
// must still start, falling back to the pre-#65 'mcp'.
test('localUsername is the OS user name', () => {
  assert.equal(localUsername(() => ({ username: 'operator' })), 'operator');
});

test('localUsername falls back to mcp when the OS cannot name the user', () => {
  assert.equal(
    localUsername(() => {
      throw new Error('uv_os_get_passwd returned ENOENT');
    }),
    'mcp'
  );
  assert.equal(localUsername(() => ({ username: '' })), 'mcp');
});
