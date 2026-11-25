#!/usr/bin/env bash
# #5089 — one transient registry hiccup must not red `main`. `better-npm-audit
# audit` is a single network round-trip to the registry advisory endpoint, and
# the hook is a blocking step feeding the required `validate / validate-all`
# context, so one `read ECONNRESET` reddened `main` and every open PR with it.
#
# The waits add up to about four minutes: a registry fault can outlast seconds
# of retrying (#7050's first lint run, where the attestations endpoint answered
# `OK` instead of JSON). A genuine failure pays that wait once before it reds.
#
# With no arguments it retries the advisory scan; with arguments it retries
# that command instead (`npm audit signatures` in _validate.yml, which also
# fetches from the registry and blocks).

set -euo pipefail

# One entry per RETRY, so the attempt budget is this many plus the first try.
BACKOFF_SECONDS=(5 15 60 150)

# The advisory scan also fails on a `.nsprc` waiver that matches nothing, so a
# waiver goes the first run after its advisory is withdrawn or fixed; the
# nightly deep checks run this on main even when no dependency changed.
audit_strict() {
  local report
  report=$(npx better-npm-audit audit --json) || return
  node -e '
    const { unusedExceptionIds } = JSON.parse(require("node:fs").readFileSync(0, "utf8"))
    if (unusedExceptionIds.length > 0) {
      console.error(`.nsprc waives ${unusedExceptionIds.join(", ")}, which npm audit no longer reports: delete the entry.`)
      process.exit(1)
    }
  ' <<<"$report"
}

CMD=("$@")
if [ "${#CMD[@]}" -eq 0 ]; then CMD=(audit_strict); fi
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
  "${CMD[@]}" || rc=$?
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
