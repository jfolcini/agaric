#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Smoke test for the CI-R16 SKIP_CI_VERIFY bypass guard at the top of
# scripts/verify-ci-equivalent.sh.
#
# Only the guard's early-exit branches are exercised — reject a truthy
# flag, reject a too-short reason, accept a descriptive reason. Each of
# those exits immediately (before the multi-minute verifier body), so the
# test is fast and side-effect-free. The unset path (which WOULD run the
# full verifier) is deliberately never invoked here.
#
# Wired as a pre-commit hook in prek.toml (scoped to the guard scripts).
# ─────────────────────────────────────────────────────────────────────
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/verify-ci-equivalent.sh"
fail=0

run() { # <expected_exit> <SKIP value> <label>
    local expect="$1" val="$2" label="$3" got
    SKIP_CI_VERIFY="$val" bash "$SCRIPT" >/dev/null 2>&1
    got=$?
    if [ "$got" != "$expect" ]; then
        printf '✗ %s: expected exit %s, got %s (SKIP_CI_VERIFY=%q)\n' \
            "$label" "$expect" "$got" "$val" >&2
        fail=1
    else
        printf '✓ %s (exit %s)\n' "$label" "$got"
    fi
}

# Bare truthy / boolean flags are rejected (exit 1) — these are the
# muscle-memory bypasses the guard exists to stop.
for v in 1 0 y n on off yes no true false TRUE Yes OFF; do
    run 1 "$v" "reject truthy flag '$v'"
done

# A truthy flag padded with whitespace must still be rejected (the guard
# trims before evaluating) — closes the "1      " bypass.
run 1 "1      " "reject whitespace-padded truthy '1      '"
run 1 "   yes  " "reject whitespace-padded truthy '   yes  '"

# Non-empty but too-short reasons (< 8 chars) are rejected (exit 1).
run 1 "wip" "reject too-short reason 'wip'"
run 1 "rebase" "reject 6-char reason 'rebase'"

# A descriptive reason (≥ 8 chars, not a truthy token) short-circuits
# the verifier cleanly (exit 0).
run 0 "12345678" "accept exact-8-char reason (lower bound)"
run 0 "docs typo, no source change" "accept descriptive reason"
run 0 "rebasing onto main" "accept reason 'rebasing onto main'"

if [ "$fail" != 0 ]; then
    echo "SKIP_CI_VERIFY guard test FAILED" >&2
    exit 1
fi
echo "SKIP_CI_VERIFY guard test passed"
