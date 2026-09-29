# Contract: Documentation link check

`test/docs/links.test.ts` runs under `npm test`, which means CI runs it too.

## Inputs

`README.md`, `CONTRIBUTING.md` and `CLAUDE.md`, plus every `*.md` file under `docs/`, found recursively from the repository root. The two contributor docs are included because they link into the README (`#prerequisites`, `#setup`), so renaming a README heading has to fail the check (added in code review).

## Checks

1. **README budget**: `README.md` has 200 lines or fewer. On failure the message states the current count and the limit.
2. **Links**: for every inline link `[text](target)` outside fenced code blocks and inline code spans, where the target has no URL scheme:
   - The path part, resolved relative to the linking file, exists as a file or directory. An empty path means the same file.
   - If there is an `#anchor` and the resolved target is a `.md` file, a heading in that file has that GitHub slug (research R1).

## Failure output

One assertion lists every broken link, one per line, in the form `<source file>: <target> (<reason>)`. The reason is `missing file` or `no heading "#<anchor>"`, so a single run shows every break.

## Out of scope

External URLs, reference-style links, HTML `<a>` tags, and Markdown files other than those listed under Inputs (`specs/` is not scanned).
