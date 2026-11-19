#!/usr/bin/env bash
# Prints the specs `REAL_BACKEND_SPECS` lists in `playwright.config.ts` (or the
# config given), one `e2e/<name>` per line: the specs the bridge lane runs
# (#6529). Exits 1 when the list is missing, empty, or holds a line it cannot
# read, so a caller never takes "found nothing" for "lists nothing".
set -euo pipefail

config=${1:-playwright.config.ts}
[ -f "$config" ] || {
  echo "real-backend-specs: $config not found" >&2
  exit 1
}
block=$(awk '/^const REAL_BACKEND_SPECS = \[$/,/^\]$/' "$config")
body=$(sed '1d;$d' <<<"$block")
if [ -z "$body" ]; then
  echo "real-backend-specs: no REAL_BACKEND_SPECS list in $config" >&2
  exit 1
fi
if bad=$(grep -nv "^  '[A-Za-z0-9._-]*\.spec\.ts',\$" <<<"$body"); then
  echo "real-backend-specs: unreadable REAL_BACKEND_SPECS line(s) in $config: $bad" >&2
  exit 1
fi
sed "s/^  '\(.*\)',\$/e2e\/\1/" <<<"$body"
