#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${NEXTEST_ENV:-}" ]]; then
  echo "nextest did not provide NEXTEST_ENV; refusing to run an unobservable DNS control" >&2
  exit 1
fi

bypass='*'
printf 'NO_PROXY=%s\nno_proxy=%s\n' "$bypass" "$bypass" >> "$NEXTEST_ENV"
