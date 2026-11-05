#!/usr/bin/env bash
# RUSTC_WRAPPER for scripts/clippy-sqlx-check.sh: give each crate's sqlx query
# macros their own SQLX_OFFLINE_DIR, split into its lib and its test builds,
# so each `.sqlx/` cache is checked against the queries that fill it.
set -euo pipefail
if [ -n "${SQLX_CHECK_DIR:-}" ] && [ -n "${CARGO_PKG_NAME:-}" ]; then
  kind=lib
  for arg in "$@"; do
    if [ "$arg" = --test ]; then kind='test'; fi
  done
  export SQLX_OFFLINE_DIR="$SQLX_CHECK_DIR/$CARGO_PKG_NAME/$kind"
  mkdir -p "$SQLX_OFFLINE_DIR"
fi
exec "$@"
