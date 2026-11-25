---
name: sync-before-code
description: Before writing, editing or committing code in any git repository, or before pushing/opening a PR on GitHub, check what branches actually exist (local and remote), pull/sync the latest code from the correct branch, and only then make changes. Use at the start of any coding task in a git repo, before creating a branch or PR, and again right before a push. Prevents working from a stale local copy and the garbled, unreviewable merge conflicts that causes when two histories have actually diverged.
---

# sync-before-code

Works in any project. The point: never start editing files, and never `git merge` a branch, without first knowing what the real, current state of the code is — locally and on every remote branch that matters.

## Why this exists
Working from a stale branch and then merging in newer work from elsewhere produces merge conflicts that are not clean "both sides changed one line" conflicts — the two histories disagree about what the file even looks like, so the merge result is scrambled and unsafe to trust. The fix is not a smarter merge; it's not getting into that situation: always sync first, inspect before merging, and when histories have truly diverged, re-apply the change by hand on top of current code instead of merging.

## Before starting any coding task
1. `git status` — see what's already here (uncommitted work, current branch). If there's uncommitted work that isn't yours to discard, stash it (`git stash -u`) or ask before doing anything that could lose it.
2. `git fetch --all --prune` — see every remote branch's real current state, not just what was cached locally.
3. `git branch -a` and `git log --oneline --all -20` (or `git log --oneline --all --graph -20`) — identify which branch actually has the latest intended work. If the user named a branch, use that. If it's ambiguous which branch is "current," ask rather than guess.
4. Pull/sync the branch you're about to work on *before* touching any files: `git pull` (or `git fetch` + `git merge`/`git rebase` onto `origin/<branch>`). Do this even if you think you already have the latest — branches move.

## Before merging or pulling in work from another branch/commit
Do not assume a plain `git merge` will produce something sane. First check whether the branches actually share a sane common history for the files you're touching:
- `git merge-base <branchA> <branchB>` — find the real common ancestor.
- `git log <branchA>..<branchB>` / `git show <commit> -- <file>` — read what the other branch actually changed, and when, relative to what you have now.
- If the other branch/commit was built on an older, different lineage of the same files (confirmed by the diff looking like it's rewriting things already superseded, not cleanly layering on top) — **do not** run `git merge` and fight through the conflicts. `git merge --abort` if you already started, then re-implement just the intended feature/fix by hand on top of the current, correct code, using the current code's own naming and structure. This is slower per step but far more reliable than untangling a garbled merge.
- Only merge directly when the history is a clean, linear ancestor relationship (the incoming branch is actually based on what's currently there).

## Before pushing or opening a PR
1. `git fetch` again right before pushing — confirm nothing new landed on the target branch while you were working.
2. If something did land, pull/rebase again and resolve *that* before pushing, rather than force-pushing over it.
3. Never force-push over someone else's new commits without explicit confirmation from the user.

## What this does not change
This does not override the user's own standing instructions about committing/pushing (e.g. "never commit without being asked," "share a plan before implementing"). Syncing and inspecting branches is a safe, read-mostly step (fetch, log, status, merge-base) and can be done freely; the actual commit/push/merge action still follows whatever permission rules are already in place for this project or user.
