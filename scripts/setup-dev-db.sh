#!/usr/bin/env bash
# Provision the local sqlx offline-check database.
#
# The pre-push verifier (`scripts/verify-ci-equivalent.sh`, Phase E) runs
# `cargo sqlx prepare --check` whenever a push touches Rust — and that CONNECTS
# to the DB named by `DATABASE_URL` (src-tauri/.env → `sqlite:dev.db`). On a
# fresh clone `setup.sh` writes that .env but the DB file does not exist yet, so
# the check errors and the push gets bounced toward `git push --no-verify`.
# This script creates the DB and applies every migration so local Rust pushes
# verify out of the box.
#
# Idempotent: `database create` is a no-op if the file exists and `migrate run`
# applies only pending migrations, so re-run this after pulling new migrations
# to refresh the schema. Mirrors the CI provisioning in `_validate.yml`.
set -euo pipefail

cd "$(dirname "$0")/../src-tauri"

if [ ! -f .env ]; then
  echo "✗ src-tauri/.env missing — run scripts/setup.sh first (it copies .env.example)." >&2
  exit 1
fi

# sqlx-cli with the same feature set CI uses (sqlx 0.9.x, sqlite + rustls).
# Only install when missing — `cargo install` is slow and networked.
if ! command -v cargo-sqlx >/dev/null 2>&1; then
  echo "→ installing sqlx-cli (sqlite, rustls)…"
  cargo install --locked sqlx-cli --no-default-features --features rustls,sqlite
fi

# DATABASE_URL is read from src-tauri/.env by sqlx-cli.
cargo sqlx database create
cargo sqlx migrate run

echo "✓ Local sqlx dev DB ready (src-tauri/dev.db). Rust pushes now verify locally."
