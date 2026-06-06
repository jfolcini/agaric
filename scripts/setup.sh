#!/usr/bin/env bash
# One-shot post-clone setup. Idempotent: safe to re-run.
set -euo pipefail
npm ci
cp -n src-tauri/.env.example src-tauri/.env 2>/dev/null || true
node scripts/prepare-external-bins.mjs --placeholder-only
echo "Ready. Run: cargo tauri dev"
