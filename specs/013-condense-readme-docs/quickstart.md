# Quickstart: validating the README split

Run from the worktree root.

## 1. Automated checks

```bash
npm run typecheck
npm test            # includes test/docs/links.test.ts
npm run web:build
```

Expected: all three pass. The link test reports zero broken links and a README of 200 lines or fewer.

## 2. The link test catches breakage

Temporarily change one link in `docs/configuration.md` to `#no-such-heading` and run:

```bash
node --import tsx --test test/docs/links.test.ts
```

Expected: the test fails with `docs/configuration.md: #no-such-heading (no heading "#no-such-heading")`. Revert the change.

## 3. No content lost

Compare the old README's words against the union of the new files. Code blocks and table rows are compared by line, so moved text shows up as matched:

```bash
git show origin/main:README.md > /tmp/old-readme.md
cat README.md docs/*.md docs/reverse-proxy/*.md > /tmp/new-docs.md
git diff --no-index --word-diff=porcelain /tmp/old-readme.md /tmp/new-docs.md | grep '^-' | grep -v '^---'
```

Expected: only seam words are removed ("above", "below", and the old quoted section names that became links). Every removed fragment has to be traceable to a seam rule in [contracts/docs-layout.md](contracts/docs-layout.md).

## 4. No stale pointers

```bash
git grep -n -E "README('s)? \"|in README|README\.md#" -- ':!specs' ':!.specify/extensions'
```

Expected: only `CONTRIBUTING.md`'s `README.md#prerequisites` and `README.md#setup`, which still resolve.

## 5. Render check

Open the branch on GitHub, then open `README.md`, `docs/reverse-proxy/` and `docs/authentik.md`. Confirm that tables render and that the index and seam links land on the right headings.
