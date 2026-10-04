import { configValue } from './config.ts';
import { settingFix } from './settings-hint.ts';

// Shared by every `api.github.com` request in this codebase (issue #64,
// research R6): adds the configured GitHub API token's Authorization
// header when one is set (the stored `githubApiToken` setting, else
// GITHUB_API_TOKEN -- see the config accessor's own precedence rule), on
// top of bellhop's own User-Agent (GitHub rejects an unauthenticated
// request with none). `extra` goes in before Authorization, so a caller's
// own headers (Accept, X-GitHub-Api-Version, ...) are never the ones that
// decide whether the request is authenticated. Never used for
// raw.githubusercontent.com requests, which aren't API calls and aren't
// rate-limited (or authenticated) the same way.
export function githubApiHeaders(
  extra?: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const token = configValue('githubApiToken', env).value;
  return {
    'User-Agent': 'bellhop',
    ...extra,
    ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
  };
}

// The 401 every api.github.com call site gets when the configured
// githubApiToken is rejected -- naming the setting and where to fix it
// (settingFix's secret form, since there's nothing to pass on stdin here
// but the same remedy text every other secret error uses), and never the
// token itself. `context` is the caller's own message prefix, so the
// error reads like every other failure that call site can produce.
export function githubUnauthorizedError(context: string): Error {
  return new Error(
    `${context}: GitHub rejected the configured GitHub API token (401) -- replace or clear githubApiToken: ${settingFix('githubApiToken')}`
  );
}
