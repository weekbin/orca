# Fork Maintenance

This repository is a personal fork of [stablyai/orca](https://github.com/stablyai/orca) that layers custom features on top of upstream without waiting for the official release cadence.

## Branch layout

| Branch                     | Tracks                              | Purpose                                                              |
| -------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| `main`                     | `origin/main` (stablyai/orca)       | Pure upstream mirror. Never commit to it directly.                   |
| `main-weekbin`             | none (rebase-only)                  | The branch you develop on. Contains upstream + this fork's commits.  |
| `fix/14264-minimax-cn-endpoint` | `fork/fix/14264-minimax-cn-endpoint` (weekbin/orca) | Historical: the original PR branch. Now folded into `main-weekbin`. |

> The two remotes are deliberately named from this fork's perspective:
> `origin` = the upstream `stablyai/orca`, `fork` = your own fork `weekbin/orca`.

`main-weekbin` is configured (`branch.main-weekbin.rebase = true`) so a plain `git pull` on it refuses to merge and re-applies your commits on top of fetched upstream instead. The two custom commits currently sitting on the tip are the only thing the script ever has to replay.

## Daily workflow

You do all of your development on `main-weekbin`. Each custom feature should land as an atomic, replayable commit on top of the tip.

```bash
git checkout main-weekbin          # always work here
# edit, test, commit
git add -p
git commit -m "feat(...): …"
```

When you want to push the tip to your fork (so another machine or a PR draft can see it):

```bash
git push fork main-weekbin --force-with-lease
```

`--force-with-lease` (not plain `--force`) refuses to push if the remote moved out from under you, which is the right safety net once `main-weekbin` gets rebased.

## Syncing upstream

When you want to pull in newer commits from `stablyai/orca`:

```bash
git sync-upstream                 # fetch + rebase, leave the result local
git sync-upstream --check         # dry run: print what would happen
git sync-upstream --push          # also push to fork/main-weekbin
```

The alias `git sync-upstream` runs `fork/sync-upstream.sh`, which:

1. Verifies you are on `main-weekbin` with a clean working tree.
2. `git fetch origin` (and prunes dead remote refs).
3. Reports how many fork-specific commits are at the tip and how far behind upstream you are.
4. Moves untracked files out of the way (and restores them after a successful rebase), so a rebase never silently loses them.
5. `git rebase origin/main` — replays the fork-specific commits on top of the latest upstream.
6. Runs `pnpm run typecheck` to catch obvious incompatibilities before you push.
7. With `--push`: `git push fork main-weekbin --force-with-lease`.

### When rebase conflicts happen

A rebase can stop mid-way when a fork commit touches a file the new upstream has also changed. The script exits with status 2 and tells you. To finish:

```bash
# 1. Open the files git status marked as "both modified", resolve the
#    conflicts, then:
git add <resolved files>
git rebase --continue

# 2. If there are more commits, repeat until rebase finishes. Then:
git sync-upstream --push           # or: git push fork main-weekbin --force-with-lease
```

If you want to abandon the rebase and start over:

```bash
git rebase --abort
```

### When upstream is far behind

A first sync with hundreds of new upstream commits is the riskiest moment. Hot files like `src/main/index.ts` may have hundreds of upstream changes since the last sync, so a single `git rebase origin/main` will almost certainly stop in the middle with conflicts. Two reasonable strategies:

**Strategy 1: chunked rebase (recommended for the first sync)**

```bash
# Create a temp ref pointing at a midpoint in upstream history:
git fetch origin main
git update-ref refs/heads/upstream-step origin/main
# Walk it back N commits at a time:
git update-ref refs/heads/upstream-step $(git rev-list -n 1 "~${N}" origin/main)
# Rebase main-weekbin onto that midpoint:
git rebase upstream-step
# Repeat with progressively larger N until you can rebase straight onto origin/main.
```

Once you are within ~20 commits of `origin/main`, plain `git sync-upstream` finishes in one pass.

**Strategy 2: just run it and resolve as you go**

```bash
git sync-upstream
# If it stops with conflicts, fix them, then:
git add <resolved files>
git rebase --continue
git sync-upstream --push      # after the rebase finishes
```

`fork/sync-upstream.sh` keeps untracked files out of the way during the rebase and restores them after, so a half-finished rebase never silently loses work.

## Adding a new custom feature

The cleanest way to drop a new feature commit onto `main-weekbin`:

```bash
# Branch off the current tip
git checkout -b feat/my-thing main-weekbin
# …develop, commit, test…
# Replay your commits onto the current main-weekbin tip
git rebase main-weekbin           # (no-op if no upstream has changed)
# Fast-forward main-weekbin to your branch
git checkout main-weekbin
git merge --ff-only feat/my-thing
# Push
git push fork main-weekbin --force-with-lease
# Clean up
git branch -d feat/my-thing
```

If the feature is an upstream PR (still open or closed without merge), fetch it and replay it instead of working from a new branch:

```bash
git fetch origin pull/<NUMBER>/head:pr-<NUMBER>
git checkout pr-<NUMBER>
git rebase main-weekbin            # replay the PR's commits on top of our tip
git checkout main-weekbin
git merge --ff-only pr-<NUMBER>
git branch -d pr-<NUMBER>          # the pr-NNNN ref is now redundant
```

## Working with `node_modules` after a rebase

`pnpm install` only needs to re-run when `package.json` or `pnpm-lock.yaml` changes — both of which `git rebase` will not touch unless one of your fork commits does. After most syncs you can skip install.

If you do need to install, set the electron mirror once per shell (or in `~/.zshrc`):

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
pnpm install --frozen-lockfile
```

## Files in this fork's maintenance layer

- `fork/sync-upstream.sh` — the sync script invoked by `git sync-upstream`.
- `FORK_MAINTENANCE.md` — this file.
- Local-only git config under `.git/config` (`branch.main-weekbin.rebase = true`, the `sync-upstream` alias) — these are not committed and won't leak if you ever push a real PR to upstream.
