# Quickstart: verifying the condensed CLAUDE.md

Run every command from the worktree root.

1. **Root size (SC-001)**: `wc -l CLAUDE.md` should report about 250 lines or fewer.
2. **Total size (SC-002)**:

   ```sh
   find . -name CLAUDE.md -not -path '*/node_modules/*' -exec cat {} + | wc -c
   ```

   The result should be at most 70% of 286,151 bytes, which is 200,305 or fewer.
3. **Destinations exist**: every file listed under "Destination files" in [data-model.md](data-model.md) exists. Each one starts with a heading that names its scope.
4. **Topic coverage (SC-003)**: for every row in the data-model topic map, the primary destination has a heading or bold label covering that topic.
5. **Citations (research R4)**:

   ```sh
   grep -rl --include=CLAUDE.md -e sortInventoryForFile -e 'Web UI authentication' -e 'Dry-run convention' -e 'Project philosophy' .
   ```

   Every name should resolve.
6. **Links (SC-005)**: `node --import tsx --test test/docs/links.test.ts` passes.
7. **No dropped rules (SC-004)**: an independent reviewer compares each original line range against its destination and reports zero unresolved omissions.
8. **No code changes (FR-009)**: `git diff --stat origin/main -- src test web-client/src scripts` lists only `CLAUDE.md` files.

The full test suite is not run for this documentation-only change.
