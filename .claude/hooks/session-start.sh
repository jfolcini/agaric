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
# This hook runs under a hard ~600s provisioning timeout. The fast critical
# path (Node, npm ci, .env, dev DB) runs synchronously and finishes well inside
# it, so the clone lands build- and test-ready before this hook returns. The
# slow prek hook-toolchain install (~10 cargo tools, some compiled from source)
# is launched DETACHED by setup.sh under CLAUDE_CODE_REMOTE — it overran the
# 600s budget when inline and got SIGKILLed mid-install, leaving the git hooks
# unwired. Backgrounded, it finishes a couple of minutes after this hook
# returns; until then commits still work and those checks run in CI. See the
# retro in scripts/setup.sh for details.
#
# Everything is idempotent and best-effort: re-running on each remote session
# start only fills gaps — already-installed tools are skipped — so even if a
# detached install is cut short, the next session start completes it.

set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

bash scripts/setup.sh
