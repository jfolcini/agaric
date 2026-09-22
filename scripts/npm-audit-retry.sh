#!/usr/bin/env bash
# #5089 — one transient registry hiccup must not red `main`.
#
# `better-npm-audit audit` shells out to `npm audit`, a single network
# round-trip to the registry advisory endpoint. Run 35276134291 died after one
# second on `read ECONNRESET`; the identical job passed 20 minutes later with
# no code change. The hook is a BLOCKING step inside `validate / lint`, which
# feeds the required `validate-all` context, so that one reset reddened `main`
# and every open PR with it.
#
# ─── Why retry-on-any-failure is not a hole ────────────────────────────────
#
# The loop exits early only on SUCCESS. A real advisory fails every attempt
# and this script exits with the last attempt's code, so the gate is unchanged
# for anything that is not a hiccup that clears on its own. That fail-closed
# shape is what makes classifying npm's error text unnecessary: telling
# ECONNRESET from a finding would only change how FAST we reach the same
# verdict, never which verdict it is.
#
# ─── The numbers ───────────────────────────────────────────────────────────
#
# 3 attempts, waiting 5s then 15s. The observed failure was an immediate
# connection reset, not a slow response, so the wait only has to outlast a
# momentary blip — and that lane recovered on its own without intervention.
# These are modest picks around that one data point, not a measured optimum;
# the cost of being wrong is bounded at 20s of added latency on a genuine
# advisory, against `lint`'s 30-minute budget.

set -euo pipefail

# One entry per RETRY, so the attempt budget is this many plus the first try.
BACKOFF_SECONDS=(5 15)
TOTAL_ATTEMPTS=$((${#BACKOFF_SECONDS[@]} + 1))

attempt=1
while true; do
  # The audit's own output is not captured: it streams straight through, so
  # the final failure surfaces npm's text verbatim, as before this wrapper.
  rc=0
  npx better-npm-audit audit || rc=$?
  if [ "$rc" -eq 0 ]; then exit 0; fi

  if [ "$attempt" -ge "$TOTAL_ATTEMPTS" ]; then
    echo "npm-audit-retry: attempt ${attempt} of ${TOTAL_ATTEMPTS} failed (exit ${rc}); no attempts left." >&2
    exit "$rc"
  fi

  # One line per retry, to stderr: a CI log then SAYS why the step took
  # longer instead of leaving a reader to guess.
  wait_seconds=${BACKOFF_SECONDS[attempt - 1]}
  echo "npm-audit-retry: attempt ${attempt} of ${TOTAL_ATTEMPTS} failed (exit ${rc}); retrying in ${wait_seconds}s." >&2
  sleep "$wait_seconds"
  attempt=$((attempt + 1))
done
