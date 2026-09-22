#!/usr/bin/env bash
# #5089 — one transient registry hiccup must not red `main`. `better-npm-audit
# audit` is a single network round-trip to the registry advisory endpoint, and
# the hook is a blocking step feeding the required `validate-all` context, so
# one `read ECONNRESET` reddened `main` and every open PR with it.
#
# 3 attempts, 5s then 15s: modest picks around that one data point, not a
# measured optimum.

set -euo pipefail

# One entry per RETRY, so the attempt budget is this many plus the first try.
BACKOFF_SECONDS=(5 15)
TOTAL_ATTEMPTS=$((${#BACKOFF_SECONDS[@]} + 1))

# Fail-closed: the loop exits early only on SUCCESS, so a real advisory fails
# every attempt and this script exits with its code. That is what makes
# classifying npm's error text unnecessary — it would change how fast the same
# verdict is reached, never which verdict it is.
attempt=1
while true; do
  # Not captured: the output streams through, so a failure surfaces npm's own
  # text verbatim.
  rc=0
  npx better-npm-audit audit || rc=$?
  if [ "$rc" -eq 0 ]; then exit 0; fi

  if [ "$attempt" -ge "$TOTAL_ATTEMPTS" ]; then
    echo "npm-audit-retry: attempt ${attempt} of ${TOTAL_ATTEMPTS} failed (exit ${rc}); no attempts left." >&2
    exit "$rc"
  fi

  wait_seconds=${BACKOFF_SECONDS[attempt - 1]}
  echo "npm-audit-retry: attempt ${attempt} of ${TOTAL_ATTEMPTS} failed (exit ${rc}); retrying in ${wait_seconds}s." >&2
  sleep "$wait_seconds"
  attempt=$((attempt + 1))
done
