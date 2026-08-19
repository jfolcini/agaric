#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# seed-worktree.sh — one-command idempotent seeding for a fresh git worktree.
#
# WHY THIS EXISTS (issue #3171)
# -----------------------------
# `git worktree add` gives you a checkout, but not a build/commit/push-ready
# one. Three gaps each cost a full failed verify/push cycle before the real
# cause is visible:
#
#   1. node_modules must be symlinked to the main checkout's BEFORE anything
#      can run `tsc -b`. If a real node_modules directory gets created first
#      (e.g. by `npm install`/`tsc -b`), a later `ln -s` nests the symlink
#      INSIDE that directory instead of replacing it, producing confusing
#      TS2688 `vite/client` + `node` failures that `ls` doesn't make obvious.
#   2. push.sh Phase E (`cargo sqlx prepare --check`) reads `DATABASE_URL`
#      from `src-tauri/.env` — NOT a repo-root `.env` (no such file exists
#      at the repo root at all) — and needs a migrated `dev.db` alongside
#      it. Copying a snapshot `dev.db` from the main checkout goes stale as
#      soon as new migrations land, so this runs scripts/setup-dev-db.sh
#      instead of copying the database file.
#   3. `git worktree add -b <branch> origin/main` sets the new branch's
#      upstream to `origin/main`. push.sh's no-args path takes a bare
#      `git push` whenever an upstream is configured, and `git push` errors
#      out on the name mismatch (local branch vs `main`) instead of pushing.
#      Unsetting the bogus upstream makes push.sh fall through to its
#      `--set-upstream origin <branch>` path, which pushes to the right ref.
#
# The MCP prebuilt binary (`node scripts/prepare-external-bins.mjs`) is a
# `cargo build --release` — expensive — so it is NOT run by default. Pass
# `--mcp` when your diff touches `src/mcp/` (pre-push Phase F's MCP UDS
# smoke test needs the resulting `agaric-mcp` binary).
#
# USAGE
# -----
#   scripts/seed-worktree.sh [--mcp]
#
# Safe to re-run any time: every step detects already-seeded state and
# skips it instead of redoing or duplicating work.
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/seed-worktree.sh [--mcp] [-h|--help]

Idempotently seed a freshly-created git worktree so it can build, commit,
and push without the friction documented in issue #3171:

  - symlinks node_modules to the main checkout's, before anything could
    run `tsc -b` and create a real directory in its place
  - copies src-tauri/.env from the main checkout and provisions a freshly
    migrated dev.db (via scripts/setup-dev-db.sh), so push.sh Phase E's
    `sqlx prepare --check` passes
  - corrects the upstream that `git worktree add -b <branch> origin/main`
    leaves pointed at origin/main, which makes push.sh take its bare
    `git push` path and fail on a branch-name mismatch

Options:
  --mcp       Also build the MCP sidecar binary via
              scripts/prepare-external-bins.mjs. This runs
              `cargo build --release`, so it is opt-in — only needed when
              your diff touches src/mcp/ (pre-push Phase F's MCP UDS smoke
              test needs the resulting binaries/agaric-mcp-$TRIPLE
              artifact). Safe/cheap to skip otherwise.
  -h, --help  Show this help.
EOF
}

RUN_MCP=0
for arg in "$@"; do
  case "$arg" in
    --mcp) RUN_MCP=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "seed-worktree.sh: unknown argument: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
cd "$WORKTREE_ROOT"
# --path-format=absolute is inconsistently honored: for a linked worktree it
# correctly returns an absolute path to the main checkout's .git dir, but
# when run inside the main checkout itself (git 2.43, observed) it returns
# a plain relative ".git" instead. realpath normalizes either case now that
# we've already cd'd to WORKTREE_ROOT, so a relative result resolves right.
MAIN_GIT_DIR="$(git rev-parse --git-common-dir --path-format=absolute)"
MAIN_ROOT="$(realpath "$MAIN_GIT_DIR/..")"

echo "▶ worktree root : $WORKTREE_ROOT"
echo "▶ main checkout : $MAIN_ROOT"

IS_MAIN_CHECKOUT=0
if [ "$WORKTREE_ROOT" = "$MAIN_ROOT" ]; then
  IS_MAIN_CHECKOUT=1
fi

DONE=()
SKIPPED=()
PROBLEMS=()

# ── 1. node_modules symlink — do this FIRST, before anything else could ────
#      invoke npm/tsc and create a real directory in its place.
echo
echo "▶ [1/4] node_modules"
if [ "$IS_MAIN_CHECKOUT" -eq 1 ]; then
  echo "  this IS the main checkout — leaving node_modules as-is."
  SKIPPED+=("node_modules (this is the main checkout, not a worktree)")
elif [ -L node_modules ]; then
  link_target="$(readlink -f node_modules || true)"
  main_nm="$(readlink -f "$MAIN_ROOT/node_modules" 2> /dev/null || echo "$MAIN_ROOT/node_modules")"
  if [ "$link_target" = "$main_nm" ]; then
    echo "  already symlinked -> $link_target"
    SKIPPED+=("node_modules (already symlinked to main checkout)")
  else
    echo "  WARNING: node_modules is a symlink, but points elsewhere:" >&2
    echo "    current: $link_target" >&2
    echo "    expected: $main_nm" >&2
    PROBLEMS+=("node_modules symlink points at $link_target, not $main_nm")
  fi
elif [ -d node_modules ]; then
  echo "  ERROR: a REAL node_modules directory already exists here." >&2
  echo "  This is the ordering bug from issue #3171: once something (tsc -b," >&2
  echo "  npm install, ...) has created a real directory, a symlink can no" >&2
  echo "  longer replace it -- 'ln -s' would nest INSIDE it instead, which" >&2
  echo "  produces confusing TS2688 vite/client + node failures later." >&2
  echo "  Not touching it automatically. To fix:" >&2
  echo "    rm -rf node_modules && bash scripts/seed-worktree.sh" >&2
  # #4169 (follow-up 5): scripts/pr-merge-result-check.sh's provision_node_modules
  # deliberately builds exactly the shape this branch refuses -- a REAL
  # node_modules directory, with only its top-level ENTRIES symlinked in, not
  # this whole-tree symlink. That is not the same bug: its worktree is
  # disposable and its tsconfigs put tsBuildInfoFile under node_modules/.tmp/,
  # so a whole-tree symlink there would write the merged tree's incremental
  # state into the BORROWED install. Two different contexts, two different
  # shapes; if you are reconciling them, read that function's own header first.
  PROBLEMS+=("node_modules is a real directory, not a symlink -- see message above")
else
  ln -s "$MAIN_ROOT/node_modules" node_modules
  echo "  symlinked node_modules -> $MAIN_ROOT/node_modules"
  DONE+=("node_modules symlinked to main checkout")
fi

# ── 2. src-tauri/.env + migrated dev.db ─────────────────────────────────────
echo
echo "▶ [2/4] src-tauri/.env + migrated dev.db"
MAIN_ENV="$MAIN_ROOT/src-tauri/.env"
DEST_ENV="$WORKTREE_ROOT/src-tauri/.env"
if [ -f "$DEST_ENV" ]; then
  echo "  src-tauri/.env already present -- skipping copy."
  SKIPPED+=("src-tauri/.env (already present)")
elif [ ! -f "$MAIN_ENV" ]; then
  echo "  ERROR: source file missing: $MAIN_ENV" >&2
  echo "  (this is the file push.sh Phase E's 'cargo sqlx prepare --check'" >&2
  echo "  actually reads -- NOT a repo-root .env, which does not exist in" >&2
  echo "  this repo at all). Run scripts/setup.sh in the main checkout" >&2
  echo "  first, then re-run this script." >&2
  PROBLEMS+=("main checkout has no src-tauri/.env at $MAIN_ENV")
else
  cp "$MAIN_ENV" "$DEST_ENV"
  echo "  copied $MAIN_ENV -> $DEST_ENV"
  DONE+=("src-tauri/.env copied from main checkout")
fi

if [ -f "$DEST_ENV" ]; then
  echo "  provisioning migrated dev.db via scripts/setup-dev-db.sh ..."
  bash "$WORKTREE_ROOT/scripts/setup-dev-db.sh"
  DONE+=("dev.db provisioned/migrated via setup-dev-db.sh")
else
  echo "  skipping setup-dev-db.sh -- no src-tauri/.env yet." >&2
  SKIPPED+=("setup-dev-db.sh (no src-tauri/.env)")
fi

# ── 3. branch upstream ───────────────────────────────────────────────────
echo
echo "▶ [3/4] branch upstream"
branch="$(git rev-parse --abbrev-ref HEAD)"
if upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2> /dev/null)"; then
  # Strip the leading "<remote>/" to compare branch names only -- local
  # branch names may themselves contain slashes (e.g. "claude/seed").
  upstream_branch="${upstream#*/}"
  if [ "$upstream_branch" != "$branch" ]; then
    echo "  upstream is '$upstream' but local branch is '$branch' -- this is" >&2
    echo "  exactly the 'git worktree add -b <branch> origin/main' bug:" >&2
    echo "  push.sh's bare 'git push' path would hit a branch-name mismatch." >&2
    git branch --unset-upstream
    echo "  unset upstream -- push.sh will now take its --set-upstream path" >&2
    echo "  (git push --set-upstream origin $branch) on the next push." >&2
    DONE+=("unset bogus upstream '$upstream' (branch-name mismatch with '$branch')")
  else
    echo "  upstream '$upstream' already matches local branch name -- fine as-is."
    SKIPPED+=("upstream already correct ($upstream)")
  fi
else
  echo "  no upstream configured -- push.sh will set one (origin/$branch) on first push."
  SKIPPED+=("no upstream configured (nothing to fix)")
fi

# ── 4. MCP prebuilt binary (opt-in) ─────────────────────────────────────────
echo
echo "▶ [4/4] MCP prebuilt binary (opt-in, expensive)"
if [ "$RUN_MCP" -eq 1 ]; then
  echo "  running node scripts/prepare-external-bins.mjs (release build, can be slow)..."
  node "$WORKTREE_ROOT/scripts/prepare-external-bins.mjs"
  DONE+=("MCP sidecar binary built via prepare-external-bins.mjs")
else
  echo "  skipped (opt-in). Only needed when your diff touches src/mcp/ --"
  echo "  pre-push Phase F's MCP UDS smoke test needs the agaric-mcp release"
  echo "  binary + its binaries/agaric-mcp-\$TRIPLE artifact. Run:"
  echo "    bash scripts/seed-worktree.sh --mcp"
  echo "  (or: node scripts/prepare-external-bins.mjs directly)"
  SKIPPED+=("MCP sidecar binary (opt-in -- pass --mcp if diff touches src/mcp/)")
fi

# ── summary ──────────────────────────────────────────────────────────────
echo
echo "────────────────────────────────────────────────────────────────"
echo "Summary"
echo "────────────────────────────────────────────────────────────────"
if [ "${#DONE[@]}" -gt 0 ]; then
  echo "Done:"
  for d in "${DONE[@]}"; do echo "  - $d"; done
fi
if [ "${#SKIPPED[@]}" -gt 0 ]; then
  echo "Skipped (already satisfied / opt-in):"
  for s in "${SKIPPED[@]}"; do echo "  - $s"; done
fi
if [ "${#PROBLEMS[@]}" -gt 0 ]; then
  echo "NEEDS ATTENTION:"
  for p in "${PROBLEMS[@]}"; do echo "  - $p"; done
  exit 1
fi
echo "Worktree seeded."
