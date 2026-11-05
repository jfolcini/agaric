#!/usr/bin/env bash
# CI lint: `cargo clippy --workspace --all-targets -- -D warnings` and
# `cargo sqlx prepare --check` for all four `.sqlx/` caches in ONE compile.
#
# Each `sqlx prepare --check` lane recompiled the workspace members clippy had
# just compiled. Here the query macros run online during clippy's compile, and
# `sqlx-rustc-wrapper.sh` points each crate's `SQLX_OFFLINE_DIR` at a directory
# of its own, so every cache is still checked against the queries its own
# crate generated, with sqlx-cli's rules: a generated query that is missing
# from the committed cache, or differs from it, fails; a committed entry nobody
# generated only warns. A member's cache also holds the lib queries of the
# workspace crates it depends on, since its `prepare` recompiles them too; the
# root `.sqlx/` is the workspace union that `just gen-sqlx` writes.
#
# Usage: scripts/clippy-sqlx-check.sh   (needs sqlx-cli and jq)
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo/src-tauri"

out="$PWD/target/sqlx-check"
rm -rf "$out"
mkdir -p "$out"

# `prepare --check` connects to a migrated DB to re-describe every query.
export DATABASE_URL="sqlite:$out/check.db"
cargo sqlx database create
cargo sqlx migrate run >"$out/migrate.log" 2>&1 || { cat "$out/migrate.log"; exit 1; }

# A macro only runs when its crate recompiles, so touch every member's target
# sources, as sqlx-cli does before its own check.
cargo metadata --format-version 1 --no-deps | jq -r '.packages[].targets[].src_path' | xargs touch

SQLX_OFFLINE=false SQLX_CHECK_DIR="$out/generated" RUSTC_WRAPPER="$repo/scripts/sqlx-rustc-wrapper.sh" \
  cargo clippy --workspace --all-targets -- -D warnings

shopt -s nullglob
failed=0

# check_cache <committed .sqlx dir> <generated dir>...
check_cache() {
  local cache=$1
  shift
  local generated=()
  local dir f name
  for dir in "$@"; do
    generated+=("$dir"/query-*.json)
  done
  # Fail closed: a cache whose crate generated nothing means the macros never ran.
  if [ "${#generated[@]}" -eq 0 ]; then
    echo "::error file=src-tauri/$cache::no queries generated for $cache; the macros did not run"
    failed=1
    return
  fi
  local -A seen=()
  local unused=0
  for f in "${generated[@]}"; do
    name=${f##*/}
    if [ -n "${seen[$name]:-}" ]; then continue; fi
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

check_cache .sqlx "$out/generated"/*/*
for crate in agaric-store agaric-engine agaric-sync; do
  mapfile -t deps < <(cargo tree -p "$crate" -e normal,dev --prefix none -f '{p}' | awk '{print $1}' | sort -u)
  dirs=("$out/generated/$crate/test")
  for dep in "${deps[@]}"; do
    if [ -d "$out/generated/$dep/lib" ]; then dirs+=("$out/generated/$dep/lib"); fi
  done
  check_cache "$crate/.sqlx" "${dirs[@]}"
done

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "sqlx offline caches match the live schema (root, agaric-store, agaric-engine, agaric-sync)"
