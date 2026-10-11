# Contract: CLI

- `configure-web-login` is removed: not registered in `src/cli.ts`, no
  command file, no docs. Running it prints the CLI's normal unknown-command
  error.
- `set-config` is unchanged: `webUiOidcIssuer`, `webUiOidcClientId`,
  `webUiOidcRedirectUri` and (via `--stdin`/prompt) `webUiOidcClientSecret`
  are still settable for installs that use custom values.
- The guest's `bellhop` flag is not a CLI flag: it is set through the guest
  editor or MCP (the CLI has no guest-edit command).
