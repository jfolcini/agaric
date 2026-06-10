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
# Behavior:
#   - Looks at the staged index only (`git diff --cached --name-status`).
#   - Allows additions (A); rejects modifications (M), deletions (D),
#     renames (R*), copies (C*), and type changes (T).
#   - When run via `prek run --all-files` with nothing staged under
#     src-tauri/migrations/ this exits 0 — the invariant is enforced
#     at commit, not retroactively walked through history.
#
# Usage: scripts/check-migrations-immutable.sh
# Exit:  0 = clean, 1 = at least one shipped migration was changed.
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

# git diff status letters:
#   A = added,     M = modified, D = deleted,
#   R = renamed,   C = copied,   T = type changed.
# Only A is allowed under src-tauri/migrations/. The append-only
# invariant covers the *.sql migration files themselves — docs that
# live alongside them (AGENTS.md) are editable and excluded here
# (the prek `files` filter is also .sql-scoped, but this script
# rescans the index itself, so it must apply the same scope).
violations=$(
  git diff --cached --name-status -- 'src-tauri/migrations/*.sql' \
    | awk '$1 != "" && $1 !~ /^A/ {print}'
)

if [ -n "$violations" ]; then
  echo "ERROR: shipped migration files are append-only (AGENTS.md invariant)." >&2
  echo "" >&2
  echo "The following staged changes modify, delete, rename, or copy a" >&2
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
