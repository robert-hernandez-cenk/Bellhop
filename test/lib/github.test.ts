import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { githubApiHeaders, githubUnauthorizedError } from '../../src/lib/github.ts';
import { resetConfigStore, tempConfigStore } from '../support/config-store.ts';

afterEach(() => resetConfigStore());

test('githubApiHeaders sends only a User-Agent when no token is configured', () => {
  assert.deepEqual(githubApiHeaders(undefined, {}), { 'User-Agent': 'bellhop' });
});

test('githubApiHeaders adds Authorization: Bearer <token> when GITHUB_API_TOKEN is set', () => {
  assert.deepEqual(githubApiHeaders(undefined, { GITHUB_API_TOKEN: 'github_pat_example0000' }), {
    'User-Agent': 'bellhop',
    Authorization: 'Bearer github_pat_example0000',
  });
});

test('githubApiHeaders merges extra headers ahead of Authorization', () => {
  assert.deepEqual(
    githubApiHeaders({ Accept: 'application/vnd.github.sha' }, { GITHUB_API_TOKEN: 'github_pat_example0000' }),
    {
      'User-Agent': 'bellhop',
      Accept: 'application/vnd.github.sha',
      Authorization: 'Bearer github_pat_example0000',
    }
  );
});

test('githubApiHeaders reads a stored githubApiToken when a config store is registered', () => {
  tempConfigStore({}, { githubApiToken: 'github_pat_example0000' });
  assert.deepEqual(githubApiHeaders(undefined, {}), {
    'User-Agent': 'bellhop',
    Authorization: 'Bearer github_pat_example0000',
  });
});

test('githubApiHeaders prefers GITHUB_API_TOKEN over a stored value', () => {
  tempConfigStore({}, { githubApiToken: 'github_pat_stored0000' });
  assert.deepEqual(githubApiHeaders(undefined, { GITHUB_API_TOKEN: 'github_pat_env00000000' }), {
    'User-Agent': 'bellhop',
    Authorization: 'Bearer github_pat_env00000000',
  });
});

test('githubUnauthorizedError names githubApiToken and the Settings page fix, never the token', () => {
  const err = githubUnauthorizedError('Checking some-repo');
  assert.equal(
    err.message,
    "Checking some-repo: GitHub rejected the configured GitHub API token (401) -- replace or clear githubApiToken: run: bellhop set-config githubApiToken --stdin --apply, or set it on the web UI's Settings page"
  );
});
