# Contract: `set-config` (CLI) and MCP `set_config`

```
bellhop set-config <key> [value] [--stdin] [--unset] [--apply]
```

- `<key>`: any non-secret or secret setting key (list in `--help`).
- Non-secret keys: unchanged behaviour; `--stdin` additionally reads the value from standard input.
- Secret keys (`authentikApiToken`, `cloudflareDnsApiToken`, `npmApiPassword`, `githubApiToken`):
  - A positional `value` is refused: `<key> is a secret -- pass it on standard input with --stdin
    (or omit the value to be prompted), never as an argument`. Exit 1 -- with `--unset` too, since the value is already in
    shell history either way.
  - `--stdin`: reads all of stdin, strips one trailing newline (`\r\n` or `\n`). Empty -> refused
    (`--unset` clears).
  - No value, no `--stdin`, stdin is a TTY: prompts `Value for <key>: ` without echo.
    Input that ends before a line is entered (Ctrl+D) is refused: `Cancelled -- nothing was written`.
  - No value, no `--stdin`, stdin not a TTY: refused, naming `--stdin`.
  - Dry run prints `Would set <key> (value hidden)` / `Would clear <key>`.
  - Apply prints `Set <key> in <path>` / `Cleared <key> in <path>`.
- Any key whose env var is set in the CLI's own environment: stored anyway, plus a warning
  `<VAR> is set in this environment and overrides the stored <key>`.

MCP `set_config`: `key` enum is the non-secret keys only, so secrets cannot be read or written over
MCP. No MCP tool returns a secret value.
