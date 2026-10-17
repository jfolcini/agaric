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

# Fail closed: a missing npm or a version this cannot parse is an error, never a pass.
npm_major() {
  local v
  v="$(npm -v 2>/dev/null)" || true
  if [[ ! "$v" =~ ^([0-9]+)\. ]]; then
    echo "error: could not read npm's version (npm -v printed '${v}')." >&2
    exit 1
  fi
  echo "${BASH_REMATCH[1]}"
}

major="$(npm_major)"
if [ "$major" -lt "$floor" ]; then
  if [ "$install" -eq 1 ]; then
    echo "npm $(npm -v) is older than the required npm ${floor}+ — installing npm@${pin} into $(npm prefix -g)…"
    # The pinned npm installs itself: an older npm that replaces its own files
    # mid-install can crash (npm 10 -> 12: MODULE_NOT_FOUND). Run from outside
    # the repo so the project .npmrc and engines gate do not apply.
    (cd / && npx -y "npm@${pin}" install -g "npm@${pin}")
    hash -r
    major="$(npm_major)"
  fi
  if [ "$major" -lt "$floor" ]; then
    echo "error: npm $(npm -v) at $(command -v npm) is older than the required npm ${floor}+ (engines.npm in package.json)." >&2
    echo "       Fix: run 'bash scripts/setup.sh' (or 'npx -y npm@${pin} install -g npm@${pin}')." >&2
    exit 1
  fi
fi
echo "npm $(npm -v) satisfies engines.npm"
