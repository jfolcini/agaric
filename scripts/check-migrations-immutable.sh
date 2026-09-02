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
#
# Allows additions (A); rejects modifications (M), deletions (D),
# renames (R*), copies (C*), and type changes (T).
#
# Usage: scripts/check-migrations-immutable.sh [--range REVSPEC]
# Exit:  0 = clean, 1 = at least one shipped migration was changed,
#        2 = usage error.
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

RANGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --range)
      RANGE="${2:-}"
      shift 2 || true
      [ -z "$RANGE" ] && { echo "ERROR: --range requires a revspec" >&2; exit 2; }
      ;;
    *)
      echo "ERROR: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# Pathspecs below are repo-relative, and `git diff` resolves them against the
# CWD, not the toplevel. Run from src-tauri/ and 'src-tauri/migrations/*.sql'
# becomes 'src-tauri/src-tauri/migrations/*.sql', matches nothing, and the
# guard reports success with a real migration edit staged (#3949). Automation
# is unaffected — prek and verify-ci-equivalent.sh both run from the toplevel —
# but manual invocation is exactly what someone does to check whether their
# change is safe before pushing, and a guard that answers "fine" from the wrong
# directory is worse than one that errors.
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
