#!/usr/bin/env bash
# The npm floor, in one place. package.json carries both halves:
#   engines.npm      the floor (">=12.0.0"); `npm install` / `npm ci` enforce it
#                    through .npmrc `engine-strict`, `npm run` does not.
#   packageManager   the exact npm every installer pulls ("npm@12.2.0").
#
#   scripts/require-npm.sh             fail unless the npm on PATH meets the floor
#   scripts/require-npm.sh --install   first install the pinned npm globally when it does not
#
# The check exists for the callers that never reach `npm ci`: `just` recipes,
# the pre-push verify and the release, which would otherwise run on an older
# npm and fail halfway.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

install=0
case "${1:-}" in
  '') ;;
  --install) install=1 ;;
  *) echo "usage: scripts/require-npm.sh [--install]" >&2; exit 2 ;;
esac

# Floor major and pin, from package.json. Fail closed on a shape this cannot read.
read -r floor pin < <(node -e '
  const p = require("./package.json");
  const f = /^>=(\d+)\.\d+\.\d+$/.exec((p.engines || {}).npm || "");
  const m = /^npm@(\d+\.\d+\.\d+)$/.exec(p.packageManager || "");
  if (!f || !m) {
    console.error("package.json needs engines.npm like \">=12.0.0\" and packageManager like \"npm@12.2.0\"");
    process.exit(1);
  }
  console.log(f[1], m[1]);
')

have_major() { local v; v="$(npm -v)"; echo "${v%%.*}"; }

if [ "$(have_major)" -lt "$floor" ]; then
  if [ "$install" -eq 1 ]; then
    echo "npm $(npm -v) is older than the required npm ${floor}+ — installing npm@${pin} into $(npm prefix -g)…"
    # Run from outside the repo: the project .npmrc and engines gate must not apply to npm's own install.
    (cd / && npm install -g "npm@${pin}")
    hash -r
  fi
  if [ "$(have_major)" -lt "$floor" ]; then
    echo "error: npm $(npm -v) at $(command -v npm) is older than the required npm ${floor}+ (engines.npm in package.json)." >&2
    echo "       Fix: run 'bash scripts/setup.sh' (or 'npm install -g npm@${pin}')." >&2
    exit 1
  fi
fi
echo "npm $(npm -v) satisfies engines.npm"
