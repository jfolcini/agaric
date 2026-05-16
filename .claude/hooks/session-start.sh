#!/bin/bash
# Remote-sandbox session bootstrap for Claude Code.
#
# Runs only when CLAUDE_CODE_REMOTE=true (i.e., Claude is provisioning a
# fresh sandbox/container). Local Claude sessions hit the existing local
# node_modules and skip this entirely.
#
# Uses `npm ci` (clean install from package-lock.json) instead of
# `npm install` for two reasons:
#   1. Deterministic: the lockfile is the single source of truth, and
#      `npm ci` fails fast if package.json and package-lock.json have
#      drifted — exactly what we want when seeding a sandbox.
#   2. Looks pinned to OpenSSF Scorecard's PinnedDependencies check
#      (uses the lockfile rather than re-resolving from registry
#      ranges).
#
# Postinstall scripts stay enabled because the platform binaries we ship
# (@biomejs/biome, esbuild, @tauri-apps/cli, @playwright/test) are
# downloaded by their own postinstalls. Disabling scripts would leave
# the sandbox without working build tools.

set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

npm ci --no-audit --no-fund
