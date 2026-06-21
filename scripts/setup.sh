#!/usr/bin/env bash
# One-shot post-clone setup. Idempotent: safe to re-run.
set -euo pipefail
npm ci
# Playwright browsers are no longer pulled by a package.json postinstall
# (removed in #816 — dead weight on the many CI jobs that never run e2e).
# Install them explicitly here so a fresh clone is e2e-ready.
npx playwright install chromium
cp -n src-tauri/.env.example src-tauri/.env 2>/dev/null || true
node scripts/prepare-external-bins.mjs --placeholder-only
# Provision the sqlx offline-check dev DB so `cargo sqlx prepare --check`
# (pre-push Phase E) passes locally. Non-fatal: a frontend-only setup (or one
# without network for the sqlx-cli install) still completes.
bash scripts/setup-dev-db.sh || echo "warning: dev DB setup skipped — run scripts/setup-dev-db.sh before pushing Rust changes"
echo "Ready. Run: cargo tauri dev"
