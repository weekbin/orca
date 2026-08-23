#!/usr/bin/env bash
# sync-upstream.sh — Replay main-weekbin's fork-specific commits on top of
# the latest upstream `main` and (optionally) push the result to the user's
# fork. See FORK_MAINTENANCE.md for the full workflow.
#
# Why this exists: orca's official pace is slow, so this fork layers
# approved-but-unmerged PRs (and any future custom features) on top of
# upstream via rebase. A rebase-based sync keeps history linear and the
# "what's ours" diff at the tip trivially small.
#
# Usage:
#   fork/sync-upstream.sh           # rebase only, leave result local
#   fork/sync-upstream.sh --push    # also push to fork/main-weekbin
#   fork/sync-upstream.sh --check   # dry run: report what would happen

set -euo pipefail

# Resolve repo root from this script's location so it works from any cwd.
# Why: when invoked via a `git <alias>`, git exports GIT_DIR, which makes
# `git -C <subdir> rev-parse --show-toplevel` return <subdir> instead of
# walking up to the real toplevel. Walking up looking for a .git entry is
# robust whether the script is called directly, from a git alias, or from
# inside a worktree (where .git is a gitdir pointer file, not a directory).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
REPO_ROOT="$SCRIPT_DIR"
while [[ ! -e "$REPO_ROOT/.git" && "$REPO_ROOT" != "/" ]]; do
  REPO_ROOT="$(dirname "$REPO_ROOT")"
done
[[ -n "$REPO_ROOT" && "$REPO_ROOT" != "/" ]] || die "Could not locate repo root from $SCRIPT_DIR"

BRANCH="main-weekbin"
UPSTREAM_REMOTE="origin"
UPSTREAM_BRANCH="main"
FORK_REMOTE="fork"

log() { printf '\033[1;34m[sync]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[err ]\033[0m %s\n' "$*" >&2; exit 1; }

# --- Pre-flight --------------------------------------------------------------

# In a normal clone $REPO_ROOT/.git is a directory; in a worktree it is a
# gitdir pointer file. The rev-parse --show-toplevel call above would already
# have failed if we weren't in a real working tree, so we just verify it now.
[[ -e "$REPO_ROOT/.git" ]] || die "Not inside a git working tree."

current_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
if [[ "$current_branch" != "$BRANCH" ]]; then
  die "Expected to be on '$BRANCH' (currently on '$current_branch'). Run: git checkout $BRANCH"
fi

# Note: in a git worktree, $REPO_ROOT/.git is a file (gitdir pointer) not a
# directory. The earlier toplevel call would already have failed if we weren't
# in a working tree, so we don't re-check.

if ! git -C "$REPO_ROOT" diff --quiet --ignore-submodules HEAD; then
  die "Working tree has uncommitted changes. Commit or stash them first."
fi
if ! git -C "$REPO_ROOT" diff --quiet --ignore-submodules --cached HEAD; then
  die "Index has staged but uncommitted changes. Commit or stash them first."
fi

# Confirm the remotes look the way we expect.
if ! git -C "$REPO_ROOT" remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  die "Remote '$UPSTREAM_REMOTE' is missing. Expected: origin -> stablyai/orca"
fi
if ! git -C "$REPO_ROOT" remote get-url "$FORK_REMOTE" >/dev/null 2>&1; then
  die "Remote '$FORK_REMOTE' is missing. Expected: fork -> weekbin/orca (or your fork)"
fi

# --- Parse args --------------------------------------------------------------

do_push=0
do_check=0
for arg in "$@"; do
  case "$arg" in
    --push) do_push=1 ;;
    --check) do_check=1 ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *) die "Unknown argument: $arg (use --push, --check, or no args)" ;;
  esac
done

# --- Main flow ---------------------------------------------------------------

log "Fetching ${UPSTREAM_REMOTE}…"
git -C "$REPO_ROOT" fetch --prune "$UPSTREAM_REMOTE"

# How many fork-specific commits are at the tip?
# commits in $BRANCH but not in upstream/$UPSTREAM_BRANCH
tip_ahead="$(git -C "$REPO_ROOT" rev-list --count "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}..${BRANCH}")"
tip_behind="$(git -C "$REPO_ROOT" rev-list --count "${BRANCH}..${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}")"

log "Branch '$BRANCH' is $tip_ahead ahead / $tip_behind behind ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}."

if [[ "$tip_behind" -eq 0 ]]; then
  log "Already up to date. Nothing to rebase."
else
  if [[ "$do_check" -eq 1 ]]; then
    log "[check mode] Would run: git rebase ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
    log "[check mode] Then push with --push, or manually: git push $FORK_REMOTE $BRANCH --force-with-lease"
    exit 0
  fi

  # Stash any untracked files so a rebase never silently loses them. We don't
  # touch the index (we already verified it's clean above).
  untracked_backup="$(mktemp -t orca-sync-untracked.XXXXXX)"
  if ! git -C "$REPO_ROOT" ls-files --others --exclude-standard > "$untracked_backup"; then
    die "Failed to enumerate untracked files."
  fi
  if [[ -s "$untracked_backup" ]]; then
    warn "Stashing untracked files to: $untracked_backup"
    warn "They will be restored if rebase succeeds; otherwise left in place."
    # Move them to a temp dir; restore after rebase.
    untracked_dir="$(mktemp -d -t orca-sync-untracked.XXXXXX)"
    while IFS= read -r path; do
      mkdir -p "$untracked_dir/$(dirname "$path")"
      mv "$REPO_ROOT/$path" "$untracked_dir/$path"
    done < "$untracked_backup"
  fi

  log "Rebasing $tip_ahead fork-specific commit(s) onto ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}…"
  if ! git -C "$REPO_ROOT" rebase "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"; then
    warn "Rebase hit conflicts. Resolve them, then: git rebase --continue"
    warn "When done, re-run this script to push."
    warn "Untracked files were moved to: $untracked_dir"
    echo "$untracked_dir" > "$REPO_ROOT/.git/.orca-sync-untracked-dir"
    exit 2
  fi

  # Restore untracked files (if any).
  if [[ -n "${untracked_dir:-}" && -d "$untracked_dir" ]]; then
    log "Restoring untracked files from $untracked_dir"
    # Use rsync if available, else cp -R. Both are non-destructive to existing
    # files (we already verified the working tree was clean pre-rebase).
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --ignore-existing "$untracked_dir"/ "$REPO_ROOT/"
    else
      cp -R "$untracked_dir"/. "$REPO_ROOT/"
    fi
    rm -rf "$untracked_dir"
  fi
  if [[ -n "${untracked_backup:-}" ]]; then
    rm -f "$untracked_backup"
  fi
  # If we crashed mid-restore on a previous run, surface the leftover dir.
  if [[ -f "$REPO_ROOT/.git/.orca-sync-untracked-dir" ]]; then
    warn "Found leftover untracked-restore dir from a previous run. Check and remove:"
    warn "  $(cat "$REPO_ROOT/.git/.orca-sync-untracked-dir")"
    rm -f "$REPO_ROOT/.git/.orca-sync-untracked-dir"
  fi
fi

# --- Verify (light) ----------------------------------------------------------

log "Running typecheck…"
if ! (cd "$REPO_ROOT" && pnpm run typecheck) >/tmp/orca-sync-typecheck.log 2>&1; then
  warn "Typecheck failed. Inspect /tmp/orca-sync-typecheck.log"
  warn "The rebase itself succeeded; fix upstream incompatibility or skip --push."
  if [[ "$do_push" -eq 1 ]]; then
    die "Refusing to push because typecheck failed."
  fi
else
  log "Typecheck OK."
fi

# --- Push (optional) ---------------------------------------------------------

if [[ "$do_push" -eq 1 ]]; then
  log "Pushing to $FORK_REMOTE/$BRANCH (force-with-lease)…"
  git -C "$REPO_ROOT" push "$FORK_REMOTE" "$BRANCH" --force-with-lease
  log "Pushed."
else
  log "Done. Inspect with: git log --oneline -10"
  log "When satisfied, run: git push $FORK_REMOTE $BRANCH --force-with-lease"
  log "Or re-run with: fork/sync-upstream.sh --push"
fi
