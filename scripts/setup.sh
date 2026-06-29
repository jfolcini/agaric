#!/usr/bin/env bash
# One-shot post-clone setup. Idempotent: safe to re-run.
set -euo pipefail

# --- Node toolchain --------------------------------------------------------
# Everything below needs the Node version pinned in .nvmrc. package.json's
# `engines` enforces it (>=24), so a mismatched node makes the very first
# `npm ci` abort with EBADENGINE. Don't assume the caller's shell is already on
# the right node: Claude's cloud VMs ship Node 20/21/22 (via nvm) by default,
# all older than we need, so provision the pinned version here.
#
# This deliberately uses nvm over plain HTTPS — Node from nodejs.org, and (only
# if nvm.sh is missing) nvm.sh from raw.githubusercontent.com — and NEVER
# `git clone`. In a sandboxed session the git credential is scoped to THIS repo,
# so cloning a third-party repo (e.g. nvm-sh/nvm) over git returns 403, whereas
# both HTTPS hosts are on the default "Trusted" network allowlist. So this works
# at every network-access level without touching the git proxy.
ensure_node() {
  local want want_major
  want="$(tr -d '[:space:]' < .nvmrc 2>/dev/null || true)"
  : "${want:=24}"
  want_major="${want%%.*}"

  # Already on a new-enough node? Nothing to do.
  if command -v node >/dev/null 2>&1; then
    local have_major
    have_major="$(node -v | sed 's/^v//; s/\..*//')"
    if [ "${have_major:-0}" -ge "$want_major" ] 2>/dev/null; then
      echo "node $(node -v) satisfies Node >=${want_major} — skipping nvm"
      return 0
    fi
    echo "node $(node -v) is older than required Node ${want} — provisioning via nvm…"
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # nvm ships pre-installed on the cloud VMs; restore just nvm.sh over HTTPS if a
  # box is missing it (never `git clone` — see note above).
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "nvm not found — fetching nvm.sh over HTTPS…"
    mkdir -p "$NVM_DIR"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/nvm.sh -o "$NVM_DIR/nvm.sh"
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install "$want"                   # Node tarball comes from nodejs.org
  nvm use "$want" >/dev/null            # activate for npm ci / npx below
  nvm alias default "$want" >/dev/null  # and for fresh shells (cargo tauri dev, etc.)
  echo "using node $(node -v) (npm $(npm -v)); nvm default -> Node ${want}"
}
ensure_node

npm ci
# Playwright's chromium for e2e (no longer pulled by a package.json postinstall
# — removed in #816, dead weight on the many CI jobs that never run e2e). This
# is BEST-EFFORT: e2e is not needed to build, test, or commit, and the 177 MB
# download from cdn.playwright.dev is both flaky and off the default "Trusted"
# network allowlist, so it must never sink the rest of the bootstrap. Skip the
# download whenever a Chromium is ALREADY available:
#   * PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 — explicit opt-out (some CI/VMs); or
#   * an existing chromium build under PLAYWRIGHT_BROWSERS_PATH (or the default
#     cache) — Claude's cloud VMs preinstall one and point
#     PLAYWRIGHT_BROWSERS_PATH at it, so e2e runs against that browser (via
#     playwright.config's executablePath when the pinned build differs) instead
#     of re-downloading a version-matched build that may not even be reachable.
pw_path="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
if [ "${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-}" = "1" ]; then
  echo "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 — skipping playwright install"
elif compgen -G "$pw_path/chromium-*" >/dev/null 2>&1 || [ -e "$pw_path/chromium" ]; then
  echo "Chromium already present under $pw_path — skipping playwright install"
else
  npx playwright install chromium \
    || echo "warning: playwright chromium install failed — run 'npx playwright install chromium' before e2e tests"
fi
cp -n src-tauri/.env.example src-tauri/.env 2>/dev/null || true
node scripts/prepare-external-bins.mjs --placeholder-only
# Provision the sqlx offline-check dev DB so `cargo sqlx prepare --check`
# (pre-push Phase E) passes locally. Non-fatal: a frontend-only setup (or one
# without network for the sqlx-cli install) still completes.
bash scripts/setup-dev-db.sh || echo "warning: dev DB setup skipped — run scripts/setup-dev-db.sh before pushing Rust changes"
# Install the prek hook toolchain (every binary the commit/push hooks call)
# and wire the git hooks. Best-effort + idempotent: never fatal, so a missing
# tool can't block a fresh clone from building. Re-run scripts/setup-hooks.sh
# (or `just install-hooks`) to fill any gaps reported above.
bash scripts/setup-hooks.sh || echo "warning: hook toolchain setup skipped — run scripts/setup-hooks.sh before committing"
echo "Ready. Run: cargo tauri dev"
