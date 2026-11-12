#!/usr/bin/env bash
# CI lint: `cargo clippy --workspace --all-targets -- -D warnings` and
# `cargo sqlx prepare --check` for the `.sqlx/` cache in ONE compile.
#
# A separate `sqlx prepare --check` recompiled the workspace members clippy had
# just compiled. Here the query macros run online during clippy's compile and
# write what they generate to `SQLX_OFFLINE_DIR`, which is then checked against
# the committed cache with sqlx-cli's rules: a generated query that is missing
# from the committed cache, or differs from it, fails; a committed entry nobody
# generated only warns. `src-tauri/.sqlx` is the workspace union that
# `just gen-sqlx` writes.
#
# Usage: scripts/clippy-sqlx-check.sh   (needs sqlx-cli and jq)
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo/src-tauri"

out="$PWD/target/sqlx-check"
rm -rf "$out"
mkdir -p "$out/generated"

# `prepare --check` connects to a migrated DB to re-describe every query.
export DATABASE_URL="sqlite:$out/check.db"
cargo sqlx database create
cargo sqlx migrate run >"$out/migrate.log" 2>&1 || { cat "$out/migrate.log"; exit 1; }

# A macro only runs when its crate recompiles, so touch every member's target
# sources, as sqlx-cli does before its own check.
cargo metadata --format-version 1 --no-deps | jq -r '.packages[].targets[].src_path' | xargs touch

SQLX_OFFLINE=false SQLX_OFFLINE_DIR="$out/generated" cargo clippy --workspace --all-targets -- -D warnings

shopt -s nullglob
failed=0

# check_cache <committed .sqlx dir> <generated dir>
check_cache() {
  local cache=$1
  local generated=("$2"/query-*.json)
  local f name
  # Fail closed: nothing generated means the macros never ran.
  if [ "${#generated[@]}" -eq 0 ]; then
    echo "::error file=src-tauri/$cache::no queries generated for $cache; the macros did not run"
    failed=1
    return
  fi
  local -A seen=()
  local unused=0
  for f in "${generated[@]}"; do
    name=${f##*/}
    seen[$name]=1
    if [ ! -f "$cache/$name" ]; then
      echo "::error file=src-tauri/$cache/$name::$cache is missing $name; run just gen-sqlx"
      failed=1
    elif [ "$(jq -cS . "$f")" != "$(jq -cS . "$cache/$name")" ]; then
      echo "::error file=src-tauri/$cache/$name::$cache/$name differs from the live schema; run just gen-sqlx"
      failed=1
    fi
  done
  for f in "$cache"/query-*.json; do
    name=${f##*/}
    [ -n "${seen[$name]:-}" ] || unused=$((unused + 1))
  done
  if [ "$unused" -gt 0 ]; then
    echo "warning: $unused potentially unused queries in $cache; you may want to run just gen-sqlx"
  fi
}

check_cache .sqlx "$out/generated"

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "sqlx offline cache matches the live schema"
