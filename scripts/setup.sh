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
echo "Ready. Run: cargo tauri dev"
