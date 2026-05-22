#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Pre-push CI-equivalent verifier (PEND-39 follow-on).
#
# Runs the same blocking + warn-only checks that `.github/workflows/_validate.yml`
# runs in CI, parallelized for local speed. Catches failures BEFORE the push
# wastes GitHub Actions minutes.
#
# Wired via `prek.toml` as the `verify-ci-equivalent` pre-push hook; this is
# the single chokepoint that replaces the prior individual pre-push hooks
# (playwright + sqlx-prepare-check). Bundling them into one script lets us
# parallelize across cores instead of serializing through prek's per-hook
# scheduler.
#
# Coverage match against CI's `_validate.yml`:
#   lint job        — runs on every commit via prek's pre-commit stage, NOT
#                     here (would duplicate work). The single exception is
#                     cargo audit / npm audit signatures, which only fire
#                     in CI today — included as warn-only below.
#   vitest job      — full `npx vitest run` here (per-commit only runs the
#                     related-subset for speed; CI runs all 9874 tests).
#   playwright job  — full `npx playwright test` here.
#   cargo-tests job — full `cargo nextest run --profile ci` + agaric-mcp
#                     build + MCP UDS smoke + externalBin verification.
#
# What is NOT covered (intentionally out of scope for pre-push):
#   * The desktop Tauri bundle build (`cargo tauri build`). Adds 5-10 min
#     wall clock to every push; counter-productive for daily-push cadence.
#     Run `scripts/verify-release-build.sh` manually before tagging a
#     release if you want pre-flight bundle-build coverage.
#   * Cross-OS builds (macOS, Windows). No way to run them locally.
#   * SLSA provenance attestations / `gh release upload`. Need a CI runner
#     identity / GH token.
#
# Exit code: non-zero on ANY blocking check failure. Warn-only checks
# (matching CI's warn-only steps) print a warning but do not block.
#
# Skip override: `SKIP_CI_VERIFY=1 git push` short-circuits this hook.
# Intended for "I know what I'm doing" pushes (e.g. fixing a typo in
# docs that obviously can't break anything). Use sparingly.
# ─────────────────────────────────────────────────────────────────────

set -uo pipefail

if [ "${SKIP_CI_VERIFY:-0}" = "1" ]; then
    echo "→ SKIP_CI_VERIFY=1; pre-push CI-equivalent skipped."
    exit 0
fi

# Resolve repo root so the script works regardless of which dir prek
# invokes it from.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# Source cargo env (the existing pre-push hooks rely on this; some
# shells launched by prek do not inherit it automatically).
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

# ── Helpers ────────────────────────────────────────────────────────
# Each background job writes its stdout/stderr to a tempfile and its
# exit code to a sibling tempfile. The wait loop reads both back.
#
# Cleanup trap: on Ctrl+C / SIGTERM / normal exit, terminate any
# surviving background jobs (otherwise they get re-parented to init
# and keep eating CPU / corrupting the cargo target tree if killed
# mid-link) and remove any stray tempfiles.

JOB_SPECS=()
PHASE3_TEMPS=()

cleanup() {
    for spec in "${JOB_SPECS[@]:-}"; do
        [ -z "$spec" ] && continue
        IFS='|' read -r pid _ logfile <<< "$spec"
        kill -TERM "$pid" 2>/dev/null || true
        rm -f "$logfile" "$logfile.exit"
    done
    for tmp in "${PHASE3_TEMPS[@]:-}"; do
        [ -n "$tmp" ] && rm -f "$tmp"
    done
}
trap cleanup EXIT INT TERM

launch() {
    local name="$1"; shift
    local logfile
    logfile="$(mktemp -t ci-verify.XXXXXX)"
    # shellcheck disable=SC2068
    ( "$@" >"$logfile" 2>&1; printf '%s' "$?" >"$logfile.exit" ) &
    JOB_SPECS+=("$!|$name|$logfile")
}

wait_all() {
    local failed=0
    for spec in "${JOB_SPECS[@]}"; do
        IFS='|' read -r pid name logfile <<< "$spec"
        wait "$pid" 2>/dev/null || true
        local rc
        rc="$(cat "$logfile.exit" 2>/dev/null || echo 1)"
        if [ "$rc" = "0" ]; then
            printf '  ✓ %s\n' "$name"
        else
            printf '  ✗ %s (exit %s)\n' "$name" "$rc"
            printf '      ─── tail of log (200 lines) ───\n'
            tail -200 "$logfile" | sed 's/^/      /'
            printf '      ─── end log ───\n'
            failed=$((failed + 1))
        fi
        rm -f "$logfile" "$logfile.exit"
    done
    JOB_SPECS=()
    return "$failed"
}

# ── Phase 1: externalBin placeholder ───────────────────────────────
# Tauri's build.rs validates the externalBin path on every cargo
# invocation; without the placeholder, `cargo nextest` and `cargo build`
# in Phase 2 would fail with a misleading "missing external-binary" error.

echo "→ Phase 1: externalBin placeholder"
if ! node scripts/prepare-external-bins.mjs --placeholder-only > /dev/null 2>&1; then
    echo "  ✗ externalBin placeholder setup failed"
    exit 1
fi
echo "  ✓ externalBin placeholder"

# ── Phase 2a: CPU-bound checks (vitest, then cargo — serialized) ────
# vitest and cargo nextest are BOTH CPU-bound at *run* time (node test
# workers vs. compiled Rust test threads), and each sizes its pool to the
# core count. Running them together oversubscribes the box, so
# timing-sensitive frontend tests (userEvent keypresses, Radix overlay
# mounts, axe audits) miss their deadlines and flake — a pure scheduling
# artifact, not a real failure. GitHub CI never hits this because it runs
# vitest and cargo as SEPARATE jobs on SEPARATE runners; serializing the two
# here mirrors that isolation. The cost is a minute or two of wall time,
# which is far cheaper than a flaky push.
fail_phase2() {
    echo ""
    echo "✗ Pre-push verification FAILED. Push aborted."
    echo "  Re-run a single check with the command shown above to iterate."
    echo "  Bypass (use sparingly): SKIP_CI_VERIFY=1 git push"
    exit 1
}

echo "→ Phase 2a (i): vitest (full)"
launch 'vitest (full)' \
    npx vitest run
wait_all || fail_phase2

echo "→ Phase 2a (ii): cargo (nextest + agaric-mcp + sqlx-prepare)"
launch 'cargo (nextest + agaric-mcp + sqlx-prepare)' \
    bash -c 'cd src-tauri && cargo nextest run --profile ci && cargo build --bin agaric-mcp && cargo sqlx prepare --check -- --tests'
wait_all || fail_phase2

# ── Phase 2b: playwright (serialized) ──────────────────────────────
# Playwright owns the vite dev server (started via webServer config) and
# spawns its own browser workers. Running it alongside vitest+cargo
# overloads the box: vite's startup probe loses to CPU contention,
# Playwright sees ERR_CONNECTION_REFUSED on localhost:5173, and a wave
# of unrelated tests fail with flaky-looking errors. Serializing here
# trades a few minutes of wall time for deterministic e2e results.

echo "→ Phase 2b: playwright e2e (serial)"
# Self-heal the browser cache. `playwright install chromium` is
# idempotent — when the matching revision is already in
# `~/.cache/ms-playwright/` it exits in ~1s without downloading.
# When `@playwright/test` was bumped (e.g. via `npm install`) and the
# expected chromium revision has changed, this fetches the new one
# before the e2e job launches — otherwise the verifier fails with
# "Executable doesn't exist" pointing at the new revision.
# `--with-deps` is intentionally omitted here: it would attempt apt
# installs which require sudo (CI handles that path separately in
# `_validate.yml`).
echo "  ↳ ensuring chromium binary matches @playwright/test revision"
if ! npx playwright install chromium >/dev/null 2>&1; then
    echo "    (playwright install chromium failed — continuing; e2e may surface a clearer error)"
fi
launch 'playwright (full e2e)' \
    npx playwright test

if ! wait_all; then
    echo ""
    echo "✗ Pre-push verification FAILED. Push aborted."
    echo "  Re-run a single check with the command shown above to iterate."
    echo "  Bypass (use sparingly): SKIP_CI_VERIFY=1 git push"
    exit 1
fi

# ── Phase 3: post-build sequential checks ──────────────────────────
# These need Phase 2's agaric-mcp binary, so they cannot run in
# parallel with it. All tempfiles route through `mktemp` so two
# concurrent runs in different checkouts don't overwrite each other's
# logs, and they're registered in PHASE3_TEMPS so the EXIT trap above
# cleans them up.

mcp_log="$(mktemp -t ci-verify-mcp.XXXXXX)"
PHASE3_TEMPS+=("$mcp_log")

echo "→ Phase 3: MCP UDS smoke + externalBin verification"
if ! ( cd src-tauri && cargo nextest run --features ci-smoke --profile ci \
        -E 'test(stub_binary_roundtrips_initialize_over_uds)' ) > "$mcp_log" 2>&1; then
    echo "  ✗ MCP UDS smoke test failed"
    tail -200 "$mcp_log" | sed 's/^/      /'
    exit 1
fi
echo "  ✓ MCP UDS smoke"

# Full release build of agaric-mcp + externalBin pin verification.
# Mirrors CI's "Build agaric-mcp stub binary (FEAT-4f)" + "Verify
# agaric-mcp smoke (--version)" + "Verify externalBin artifact exists"
# steps.
extbin_log="$(mktemp -t ci-verify-extbin.XXXXXX)"
PHASE3_TEMPS+=("$extbin_log")

if ! node scripts/prepare-external-bins.mjs > "$extbin_log" 2>&1; then
    echo "  ✗ prepare-external-bins.mjs (release) failed"
    tail -200 "$extbin_log" | sed 's/^/      /'
    exit 1
fi
if ! src-tauri/target/release/agaric-mcp --version > /dev/null 2>&1; then
    echo "  ✗ agaric-mcp --version failed"
    exit 1
fi
# Resolve the host rustc triple instead of hardcoding the Linux one so
# this hook works on macOS / Windows contributors' machines too (matches
# `_validate.yml` which probes a Linux-only artifact path because CI only
# runs there — locally we should respect whatever OS the dev is on).
HOST_TRIPLE="$(rustc -vV 2>/dev/null | awk '/^host:/{print $2}')"
if [ -z "$HOST_TRIPLE" ]; then
    echo "  ✗ could not resolve host rustc triple"
    exit 1
fi
if ! test -x "src-tauri/binaries/agaric-mcp-$HOST_TRIPLE"; then
    echo "  ✗ externalBin artifact missing: src-tauri/binaries/agaric-mcp-$HOST_TRIPLE"
    exit 1
fi
echo "  ✓ externalBin (release + --version + artifact for $HOST_TRIPLE)"

# ── Phase 4: warn-only checks (do not block push) ──────────────────
# Match CI's warn-only steps. Findings here surface a console warning
# but do not contribute to the script's exit code. Treat the output
# as a weekly-review surface, not a gate.

echo "→ Phase 4: warn-only checks (informational)"
audit_log="$(mktemp -t ci-verify-audit.XXXXXX)"
PHASE3_TEMPS+=("$audit_log")
if ( cd src-tauri && cargo audit --no-fetch ) > "$audit_log" 2>&1; then
    echo "  ✓ cargo audit (no findings)"
else
    echo "  ⚠ cargo audit had findings (warn-only); review and triage into deny.toml if accepted"
    tail -20 "$audit_log" | sed 's/^/      /'
fi

npm_sig_log="$(mktemp -t ci-verify-npm-sig.XXXXXX)"
PHASE3_TEMPS+=("$npm_sig_log")
if npm audit signatures > "$npm_sig_log" 2>&1; then
    echo "  ✓ npm audit signatures (all verified)"
else
    echo "  ⚠ npm audit signatures had findings (warn-only); not every npm dep ships Sigstore provenance yet"
fi

echo ""
echo "✓ Pre-push CI-equivalent PASSED."
echo "  (release-specific bundle build: run scripts/verify-release-build.sh manually before tagging)"
