#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Migrations append-only check.
#
# Enforces the AGENTS.md invariant under "Database" and
# "Architectural Stability": SQLite migrations under
# src-tauri/migrations/ are append-only — never modify, delete,
# rename, or copy a shipped migration. The sqlx runtime catches
# checksum drift via `_sqlx_migrations`, but that only fires the
# next time the app boots; this hook fails fast at commit time.
#
# Modes (#806):
#   (default)        — pre-commit: inspect the staged index
#                      (`git diff --cached --name-status`). The prek
#                      hook sets `always_run = true` so a staged
#                      DELETION still triggers this script (prek's
#                      changed-file set excludes deletions, so a
#                      `files`-filtered hook would silently skip).
#   --range REVSPEC  — CI / pre-push backstop: inspect a commit range.
#                      Pass a THREE-DOT revspec (`base...HEAD`): two dots
#                      compares the two tips, so a migration that landed
#                      on base after this branch was cut reads as a
#                      deletion and fails a branch that never touched it.
#                      Three dots diffs from the merge-base — only what
#                      this branch did. Catches a one-time `--no-verify`
#                      bypass that the staged-index mode can never see
#                      retroactively.
#   --self-test      — run the fixture suite below and exit.
#
# Allows additions (A); rejects modifications (M), deletions (D),
# renames (R*), copies (C*), and type changes (T).
#
# Usage: scripts/check-migrations-immutable.sh [--range REVSPEC | --self-test]
# Exit:  0 = clean, 1 = at least one shipped migration was changed,
#        2 = usage error.
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

RANGE=""
SELF_TEST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --range)
      RANGE="${2:-}"
      shift 2 || true
      [ -z "$RANGE" ] && { echo "ERROR: --range requires a revspec" >&2; exit 2; }
      ;;
    --self-test)
      SELF_TEST=1
      shift
      ;;
    *)
      echo "ERROR: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# ── Self-test ──────────────────────────────────────────────────────
# Builds a throwaway repo and asserts the guard's verdict on each
# shape. The stale-base case is the regression that motivated this:
# a two-dot range failed every branch cut before a migration merged.
if [ "$SELF_TEST" -eq 1 ]; then
  SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  fails=0

  assert() { # <label> <expected-exit> <actual-exit>
    if [ "$2" -eq "$3" ]; then
      echo "  ✓ $1"
    else
      echo "  ✗ $1 (expected exit $2, got $3)" >&2
      fails=$((fails + 1))
    fi
  }

  # The fixture must not inherit the caller's git context. When this runs
  # from a git hook, GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE point at the REAL
  # repository — `git init` there is a re-init that rewrites core.worktree
  # to $tmp and leaves the checkout unusable once $tmp is removed. Hooks are
  # disabled too: the fixture inherits core.hooksPath, and prek aborts on a
  # repo with no prek.toml. Shared code (#3722), not a private copy: three
  # other scripts each reinvented this scrub independently and none of them
  # stopped the next one from repeating the incident.
  # shellcheck source=scripts/lib/git-scratch-guard.sh
  . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/git-scratch-guard.sh"
  git_scratch_guard "$tmp"
  git_scratch_init "$tmp"
  cd "$tmp"
  mkdir -p src-tauri/migrations
  echo "CREATE TABLE a(x);" > src-tauri/migrations/0001_a.sql
  git add -A && git commit -qm shipped
  base="$(git rev-parse HEAD)"

  # main advances with a new migration the branch will never see.
  echo "CREATE TABLE b(x);" > src-tauri/migrations/0002_b.sql
  git add -A && git commit -qm "main adds 0002"

  # (1) stale base, branch untouched — the regression case.
  git checkout -q "$base"
  set +e; bash "$SELF" --range "main...HEAD" >/dev/null 2>&1; rc=$?; set -e
  assert "stale base, no migration change -> pass" 0 "$rc"

  set +e; bash "$SELF" --range "main..HEAD" >/dev/null 2>&1; rc=$?; set -e
  assert "same base with two dots -> fails (why three dots is required)" 1 "$rc"

  # (2) branch edits a shipped migration — must still be caught.
  git checkout -q -b edits "$base"
  echo "CREATE TABLE a(x, y);" > src-tauri/migrations/0001_a.sql
  git add -A && git commit -qm "edit shipped"
  set +e; bash "$SELF" --range "main...HEAD" >/dev/null 2>&1; rc=$?; set -e
  assert "branch modifies a shipped migration -> fail" 1 "$rc"

  # (3) branch deletes a shipped migration.
  git checkout -q -b deletes "$base"
  git rm -q src-tauri/migrations/0001_a.sql
  git commit -qm "delete shipped"
  set +e; bash "$SELF" --range "main...HEAD" >/dev/null 2>&1; rc=$?; set -e
  assert "branch deletes a shipped migration -> fail" 1 "$rc"

  # (4) branch adds a new migration — the legitimate shape.
  git checkout -q -b adds "$base"
  echo "CREATE TABLE c(x);" > src-tauri/migrations/0003_c.sql
  git add -A && git commit -qm "add new"
  set +e; bash "$SELF" --range "main...HEAD" >/dev/null 2>&1; rc=$?; set -e
  assert "branch adds a new migration -> pass" 0 "$rc"

  # (5) an edit still caught when the branch is ALSO behind main —
  #     three dots must not become a blanket amnesty.
  git checkout -q -b stale-and-edits "$base"
  echo "CREATE TABLE a(x, z);" > src-tauri/migrations/0001_a.sql
  git add -A && git commit -qm "edit shipped from stale base"
  set +e; bash "$SELF" --range "main...HEAD" >/dev/null 2>&1; rc=$?; set -e
  assert "stale base AND a real edit -> still fail" 1 "$rc"

  # (6) staged-index mode still works.
  git checkout -q -b staged "$base"
  echo "CREATE TABLE a(x, w);" > src-tauri/migrations/0001_a.sql
  git add -A
  set +e; bash "$SELF" >/dev/null 2>&1; rc=$?; set -e
  assert "staged modification -> fail" 1 "$rc"

  # (7) run from a SUBDIRECTORY with a real violation staged (#3949).
  #     The pathspec is relative to the invocation directory, so from
  #     src-tauri/ it became 'src-tauri/src-tauri/migrations/*.sql',
  #     matched nothing, and the guard reported success. Both modes are
  #     covered: a guard that answers "fine" from the wrong directory is
  #     worse than one that errors, and the range mode resolves its
  #     revspec from the same cwd.
  git checkout -q -b subdir "$base"
  echo "CREATE TABLE a(x, v);" > src-tauri/migrations/0001_a.sql
  git add -A
  cd "$tmp/src-tauri"
  set +e; bash "$SELF" >/dev/null 2>&1; rc=$?; set -e
  assert "staged modification, run from a subdirectory -> fail" 1 "$rc"
  git commit -qm "edit shipped from subdir"
  set +e; bash "$SELF" --range "main...HEAD" >/dev/null 2>&1; rc=$?; set -e
  assert "range mode, run from a subdirectory -> fail" 1 "$rc"
  # …and the legitimate shape must still pass from there, so the fix is
  # not "make the guard fail from subdirectories".
  cd "$tmp"
  git checkout -q -b subdir-adds "$base"
  echo "CREATE TABLE d(x);" > src-tauri/migrations/0004_d.sql
  git add -A
  cd "$tmp/src-tauri"
  set +e; bash "$SELF" >/dev/null 2>&1; rc=$?; set -e
  assert "staged ADDITION, run from a subdirectory -> pass" 0 "$rc"
  cd "$tmp"

  # (8) usage errors.
  set +e; bash "$SELF" --bogus >/dev/null 2>&1; rc=$?; set -e
  assert "unknown arg -> exit 2" 2 "$rc"
  set +e; bash "$SELF" --range >/dev/null 2>&1; rc=$?; set -e
  assert "--range with no revspec -> exit 2" 2 "$rc"

  # (9) outside a git repository the toplevel cannot be resolved. Without the
  #     emptiness check this exits 129 from git's own arg parser with a page of
  #     usage text — an undocumented code and a message that never mentions
  #     migrations. Pinned to the documented exit 2.
  outside="$(mktemp -d)"
  set +e; (cd "$outside" && bash "$SELF") >/dev/null 2>&1; rc=$?; set -e
  rm -rf "$outside"
  assert "run outside any git repository -> documented exit 2, not git's opaque 129" 2 "$rc"

  if [ "$fails" -ne 0 ]; then
    echo "self-test: $fails assertion(s) failed" >&2
    exit 1
  fi
  echo "self-test: all assertions passed"
  exit 0
fi

# Pathspecs below are repo-relative, and `git diff` resolves them against the
# CWD, not the toplevel. Run from src-tauri/ and 'src-tauri/migrations/*.sql'
# becomes 'src-tauri/src-tauri/migrations/*.sql', matches nothing, and the
# guard reports success with a real migration edit staged (#3949). Automation
# is unaffected — prek and verify-ci-equivalent.sh both run from the toplevel —
# but manual invocation is exactly what someone does to check whether their
# change is safe before pushing, and a guard that answers "fine" from the wrong
# directory is worse than one that errors. This must stay BELOW the --self-test
# block, which cd's into its own fixture and must not be redirected here.
#
# Resolved into a variable and checked rather than `cd "$(git rev-parse …)"`.
# Measured, not assumed: on failure that substitution is empty, and `cd ""`
# SUCCEEDS while changing nothing — so the naive form carries on into the scan
# from wherever it started. It does not then pass silently; `git diff --cached`
# outside a repository reinterprets itself as `--no-index`, rejects `--cached`,
# and exits 129 with a page of git usage text. That is a code this script does
# not document (0/1/2) and a message that names nothing about migrations. The
# explicit check turns it into the documented exit 2 and one clear line.
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$TOPLEVEL" ]; then
  echo "ERROR: not inside a git repository — cannot scope the migration scan." >&2
  exit 2
fi
cd "$TOPLEVEL"

# git diff status letters:
#   A = added,     M = modified, D = deleted,
#   R = renamed,   C = copied,   T = type changed.
# Only A is allowed under src-tauri/migrations/. The append-only
# invariant covers the *.sql migration files themselves — docs that
# live alongside them (AGENTS.md) are editable and excluded here
# (the prek `files` filter is also .sql-scoped, but this script
# rescans the diff itself, so it must apply the same scope).
if [ -n "$RANGE" ]; then
  violations=$(
    git diff "$RANGE" --name-status -- 'src-tauri/migrations/*.sql' \
      | awk '$1 != "" && $1 !~ /^A/ {print}'
  )
  scope_label="range $RANGE"
else
  violations=$(
    git diff --cached --name-status -- 'src-tauri/migrations/*.sql' \
      | awk '$1 != "" && $1 !~ /^A/ {print}'
  )
  scope_label="staged"
fi

if [ -n "$violations" ]; then
  echo "ERROR: shipped migration files are append-only (AGENTS.md invariant)." >&2
  echo "" >&2
  echo "The following $scope_label changes modify, delete, rename, or copy a" >&2
  echo "previously-shipped migration under src-tauri/migrations/:" >&2
  echo "" >&2
  while IFS= read -r line; do
    echo "  $line" >&2
  done <<<"$violations"
  echo "" >&2
  echo "If you need to evolve the schema, write a NEW migration file" >&2
  echo "(e.g., 0042_<name>.sql) instead of editing an existing one." >&2
  echo "Migrations are tracked by checksum in _sqlx_migrations and" >&2
  echo "must remain byte-identical once shipped." >&2
  exit 1
fi
exit 0
