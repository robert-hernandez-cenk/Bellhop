---
name: prune-branches
description: Use when local branches, worktrees, or origin branches are lingering after their pull request merged into main and need cleanup, or when asked to prune/clean up merged branches in this repo.
---

# Prune Branches

## Overview

Removes the local branch, local worktree, and origin branch for every
feature branch whose PR has already merged into `main` — leaving open-PR
and no-PR branches untouched.

## Steps

1. **Inventory local state:**
   ```
   git branch -vv
   git worktree list
   ```

2. **Get merged PRs:**
   ```
   gh pr list --state merged --limit 30 --json number,title,headRefName,mergedAt
   ```

3. **Classify each local branch/worktree** against that list:
   - Merged PR + local branch/worktree exists → **prune**
   - No PR, or PR still `OPEN` (spot-check with
     `gh pr list --head <branch> --json number,state`) → **leave alone**
   - The operator's deployment checkout (the permanent worktree the web
     service runs from, named in the operator's private notes rather than
     this repository) → **never touch**, regardless of merge state — it has
     no PR and is never removed.

4. **Before removing a worktree, confirm it's clean:**
   ```
   git -C <worktree-path> status --short
   ```
   Non-empty output means uncommitted work — stop and ask the user rather
   than discarding it.

5. **Remove worktree, then local branch** (use `-d`, not `-D` — a
   fully-merged check protects against deleting unmerged work):
   ```
   git worktree remove <worktree-path>
   git branch -d <branch-name>
   ```

6. **Delete the origin branch.** GitHub usually already auto-deletes the
   head branch on PR merge, so a direct `git push origin --delete
   <branch>` often fails with "remote ref does not exist" — that's
   expected, not an error to fix. Just prune the stale local
   remote-tracking refs instead:
   ```
   git fetch origin --prune
   ```
   Only merged branches whose remote ref *does* still exist need an
   explicit `git push origin --delete <branch>`.

7. **Report** what was pruned vs. left alone, and why (open PR, no PR, or
   permanent worktree).

## Common Mistakes

- Deleting a worktree/branch for a PR that's merged into a *feature*
  branch but not into `main` — always check `mergedAt`/base against `main`
  via `gh pr list`, not just PR "merged" state in isolation.
- Treating a `git push origin --delete` failure as something to
  troubleshoot — it's the normal case once GitHub's own merge-triggered
  auto-delete already ran.
- Force-removing a worktree (`git worktree remove --force`) without
  checking `git status --short` first.
