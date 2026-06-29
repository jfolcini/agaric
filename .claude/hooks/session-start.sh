#!/bin/bash
# Remote-sandbox session bootstrap for Claude Code.
#
# Runs only when CLAUDE_CODE_REMOTE=true (i.e., Claude is provisioning a
# fresh sandbox/container). Local Claude sessions hit the existing local
# toolchain and skip this entirely.
#
# Delegates to scripts/setup.sh — the single canonical post-clone bootstrap.
# That script provisions the pinned Node version (.nvmrc) and then runs
# `npm ci`, installs Playwright's chromium, seeds src-tauri/.env, provisions
# the sqlx dev DB, and installs the prek hook toolchain + wires the git hooks
# (just, prek, cargo-deny, sqruff, typos, zizmor, taplo, lychee, shellcheck, …).
#
# It is idempotent and best-effort: re-running on each remote session start
# only fills gaps — already-installed tools are skipped — so a fresh VM lands
# build-, test-, and commit-ready with prek hooks fully functional.

set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

bash scripts/setup.sh
