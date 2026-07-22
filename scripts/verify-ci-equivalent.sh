#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Pre-push verifier.
#
# Wired via `prek.toml` as the `verify-ci-equivalent` pre-push hook (the
# hook ID is kept for stability — actual scope is narrower than CI now).
#
# Strategy (re-scoped from full CI mirror to fast-feedback):
#
#   Phase A — `prek run --all-files --hook-stage pre-commit`
#             Runs every pre-commit hook against the WHOLE tree, not just
#             staged files. Catches the "latent breach in an untouched
# File" class ('s `useAppKeyboardShortcuts`
#             cognitive-complexity drift that the staged-only pre-commit
#             missed). Tests are skipped here because the prek vitest /
#             cargo-test hooks read `--cached` and there's nothing staged
#             at push time — the SKIP= env var below silences their
#             "no staged files" log noise.
#
#   Phase B/C/D — vitest + cargo nextest scoped to the **commit range**
#                 being pushed (`@{upstream}..HEAD`, override with
#                 `PRE_PUSH_RANGE`). Uses `scripts/test-related-{ts,rust}.sh
#                 --range REVSPEC` (same scripts the pre-commit hooks use,
#                 just with a different diff source).
#
#   Phase E — `cargo sqlx prepare --check` if any .rs changed in range,
#             against all four committed `.sqlx/` caches (workspace root +
#             `agaric-store`/`agaric-engine`/`agaric-sync`) — mirrors every
#             `sqlx-offline-check` lane in `_validate.yml`.
#
#   Phase F — `agaric-mcp` release build + MCP UDS smoke + externalBin
#             host-triple verify. **Only when MCP paths change**
#             (`src-tauri/src/mcp/`, `src-tauri/src/commands/mcp.rs`,
#             `src-tauri/src/bin/agaric-mcp.rs`, `src-tauri/binaries/`).
#             Skipped for unrelated pushes — the release build is the
#             slowest non-test step and most pushes don't touch MCP.
#
#   Phase G — warn-only `cargo audit` + `npm audit signatures`.
#
# Explicitly NOT here (vs the prior CI-equivalent verifier):
#
#   * **Playwright e2e.** CI still runs the full suite on every PR — local
#     skip trades a delayed safety signal for a much faster push (Playwright
#     dominated the prior pre-push wall clock). If you've touched anything
#     interaction-heavy, run `npx playwright test` manually before pushing.
#   * **Full `vitest run` / `cargo nextest run --profile ci`.** Scoped to
#     the push range above; CI still runs the full suites.
#   * **Desktop bundle build / cross-OS / SLSA attestations.** Same as
#     before — run `scripts/verify-release-build.sh` manually for the
#     bundle pre-flight.
#
# Skip override (CI-R16): set `SKIP_CI_VERIFY` to a short, descriptive
# REASON to short-circuit the hook, e.g.
#   SKIP_CI_VERIFY='docs typo, no source change' git push
# A bare truthy flag (`SKIP_CI_VERIFY=1`) is REJECTED — the escape hatch
# exists for genuine one-offs, and forcing a reason keeps it from quietly
# becoming the default push path. Range override:
# `PRE_PUSH_RANGE=origin/main..HEAD git push` for branches without a
# tracking upstream.
# ─────────────────────────────────────────────────────────────────────

set -uo pipefail

# ── Bypass guard (CI-R16) ──────────────────────────────────────────
# Reject a bare truthy flag; require an explicit, self-documenting reason
# of at least 8 characters. The reason is echoed so the skip leaves a
# trace in the push output rather than being silent.
SKIP_REASON="${SKIP_CI_VERIFY:-}"
# Trim leading/trailing whitespace (internal spaces preserved) so a padded
# truthy flag like "1   " can't slip past the truthy/length checks below.
SKIP_REASON="${SKIP_REASON#"${SKIP_REASON%%[![:space:]]*}"}"
SKIP_REASON="${SKIP_REASON%"${SKIP_REASON##*[![:space:]]}"}"
if [ -n "$SKIP_REASON" ]; then
    case "$(printf '%s' "$SKIP_REASON" | tr '[:upper:]' '[:lower:]')" in
        1 | 0 | y | n | on | off | yes | no | true | false)
            printf '✗ SKIP_CI_VERIFY=%s rejected: bypassing the verifier requires a REASON, not a truthy flag.\n' "$SKIP_REASON" >&2
            printf "  Re-run with a short explanation, e.g.:\n" >&2
            printf "    SKIP_CI_VERIFY='docs typo, no source change' git push\n" >&2
            exit 1
            ;;
    esac
    if [ "${#SKIP_REASON}" -lt 8 ]; then
        printf '✗ SKIP_CI_VERIFY reason too short (%s chars, need ≥8): "%s"\n' "${#SKIP_REASON}" "$SKIP_REASON" >&2
        printf "  Give a real reason, e.g. SKIP_CI_VERIFY='rebasing onto main, already verified' git push\n" >&2
        exit 1
    fi
    echo "→ Pre-push verifier skipped. Reason: $SKIP_REASON"
    exit 0
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

# ── Determine the commit range being pushed ────────────────────────
# Default: commits ahead of the tracking upstream. Override via
# PRE_PUSH_RANGE for branches without an upstream (e.g. fresh feature
# branches that haven't been pushed yet — set PRE_PUSH_RANGE=origin/main..HEAD).

RANGE="${PRE_PUSH_RANGE:-}"
if [ -z "$RANGE" ]; then
    if git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
        RANGE="@{upstream}..HEAD"
    elif git rev-parse --verify origin/main >/dev/null 2>&1; then
        RANGE="origin/main..HEAD"
        echo "→ No tracking upstream; falling back to range '$RANGE'"
    else
        echo "✗ Cannot determine push range (no upstream, no origin/main)."
        echo "  Set PRE_PUSH_RANGE=<revspec> and retry."
        exit 1
    fi
fi

if ! git rev-list --count "$RANGE" >/dev/null 2>&1; then
    echo "✗ Range '$RANGE' does not resolve to a valid revision range."
    exit 1
fi

RANGE_COUNT="$(git rev-list --count "$RANGE" 2>/dev/null || echo 0)"
echo "→ Pre-push verifier: range '$RANGE' ($RANGE_COUNT commit(s))"

# Fail-closed change detection: keep the git-diff exit status so we can tell a
# genuinely EMPTY diff apart from a diff that could not be computed. If the
# command fails we cannot know what changed, so we run EVERY category below.
if CHANGED="$(git diff "$RANGE" --name-only --diff-filter=ACMR 2>/dev/null)"; then
    CHANGED_OK=1
else
    CHANGED_OK=0
    CHANGED=""
fi

has_match() {
    [ -n "$CHANGED" ] && printf '%s\n' "$CHANGED" | grep -qE "$1"
}

# Per-category change flags. HAS_RS/HAS_MCP gate the Rust/MCP phases (unchanged);
# HAS_TS/HAS_CI/HAS_DOCS join them to make Phase A's prek SKIP category-aware
# (mirroring the CI `lint` job's per-category plan — see the SKIP build below).
HAS_RS=0
HAS_TS=0
HAS_CI=0
HAS_DOCS=0
HAS_MCP=0
if [ "$CHANGED_OK" = "0" ]; then
    # Could not compute the changed-file set → fail closed: run everything.
    echo "→ Could not compute changed-file set for '$RANGE'; failing closed (running every category)."
    HAS_RS=1
    HAS_TS=1
    HAS_CI=1
    HAS_DOCS=1
    HAS_MCP=1
else
    # Backend: Rust sources, the crate manifests/lockfile, shipped migrations.
    has_match '\.rs$|^src-tauri/Cargo\.(toml|lock)$|^src-tauri/migrations/.*\.sql$' && HAS_RS=1
    # Frontend: TS/JS/CSS sources, e2e specs, and the FE build/config surface.
    has_match '^src/|^e2e/|\.(ts|tsx|js|jsx|css)$|package(-lock)?\.json$|(vite|vitest|tailwind|postcss)\.config\.|tsconfig.*\.json$|index\.html$' && HAS_TS=1
    # CI/tooling: workflows plus the lint-tool configs the CI lint job keys on.
    has_match '^\.github/|prek\.toml$|\.taplo\.toml$|lychee\.toml$|\.gitleaks\.toml$' && HAS_CI=1
    # Docs: any Markdown file plus the docs/ tree.
    has_match '\.md$|^docs/' && HAS_DOCS=1
    # MCP gate: only the binary, its module, the Tauri command wrapper, and
    # the prebuilt-binary directory. Catches the surface that affects the
    # agaric-mcp release build + UDS smoke + externalBin pin verification.
    has_match '^src-tauri/src/mcp/|^src-tauri/src/commands/mcp\.rs$|^src-tauri/src/bin/agaric-mcp\.rs$|^src-tauri/binaries/' && HAS_MCP=1

    # Fail-closed for UNRECOGNIZED non-docs paths (mirrors _validate.yml's
    # classifier): a changed file matching neither docs nor any known category
    # (frontend/backend/ci) — e.g. rust-toolchain.toml, .cargo/config.toml, a
    # root *.sh — is a build/toolchain change we cannot attribute to a suite.
    # Without this the per-category SKIP below would drop nearly every hook for
    # such a push. Pin frontend+backend+ci so their hooks still run — the ci
    # hooks (shell lint + the skip-ci-verify guard) then cover *.sh. The
    # recognizer regexes are the SAME patterns that set HAS_TS/HAS_RS/HAS_CI
    # above (so "recognized" ⟺ "set some category flag"), plus a broad docs
    # matcher (LICENSE/NOTICE/… beyond the HAS_DOCS *.md set) so a licence edit
    # is NOT over-escalated to the full suite. A file matching none of these set
    # no flag → fail closed.
    unrec_docs='^(docs/|.*\.md$|LICENSE([.-].*)?$|NOTICE$|AUTHORS$|CHANGELOG$)'
    unrec_fe='^src/|^e2e/|\.(ts|tsx|js|jsx|css)$|package(-lock)?\.json$|(vite|vitest|tailwind|postcss)\.config\.|tsconfig.*\.json$|index\.html$'
    unrec_be='\.rs$|^src-tauri/Cargo\.(toml|lock)$|^src-tauri/migrations/.*\.sql$'
    unrec_ci='^\.github/|prek\.toml$|\.taplo\.toml$|lychee\.toml$|\.gitleaks\.toml$'
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        if [[ "$f" =~ $unrec_docs || "$f" =~ $unrec_fe || "$f" =~ $unrec_be || "$f" =~ $unrec_ci ]]; then
            continue
        fi
        echo "→ Unrecognized non-docs path: $f → failing closed (frontend+backend+ci)."
        HAS_TS=1
        HAS_RS=1
        HAS_CI=1
        break
    done <<< "$CHANGED"
fi

# ── Phase A: prek run --all-files (pre-commit hooks against whole tree) ──
# SKIP silences the vitest/cargo-test hooks (they'd read `--cached` and log
# "no staged files — skipping" — wasted noise since Phase C/D run them with
# --range below) AND, category-aware, the hooks whose category did NOT change.
#
# This mirrors the CI `lint` job's per-category plan (an audit produced the
# exact lists): a hook is skipped only when the category it guards is absent
# from this push. The nightly `full-suite` job in
# .github/workflows/scheduled-deep-checks.yml runs the FULL unskipped prek
# suite over the whole tree as the backstop, so this trades per-push
# whole-tree coverage of the ABSENT categories for a faster push; a latent
# breach in an untouched, unchanged-category file is caught nightly instead.
#
# NEVER skipped (run every push regardless of category): trailing-whitespace,
# end-of-file-fixer, check-merge-conflict, check-added-large-files,
# check-shebang-scripts-are-executable, check-executables-have-shebangs,
# mixed-line-ending, detect-private-key, gitleaks, typos.

# Base: the two test hooks (always scoped in Phases C/D, never here).
skip_items=(vitest cargo-test)

# Frontend absent → skip the FE lint/type/architecture hooks.
if [ "$HAS_TS" = "0" ]; then
    skip_items+=(oxlint oxfmt tsc no-hsl-rgb-var-wrap no-direct-sonner-import \
        no-ui-store-imports no-legacy-react-apis check-elevation-tiers \
        check-elevation-tiers-self-test import-cycles store-layering axe-presence \
        test-file-naming ipc-error-path-coverage ipc-error-path-coverage-selftest \
        no-raw-invoke no-raw-invoke-selftest no-raw-local-storage \
        no-raw-local-storage-selftest trace-interactions-named \
        trace-interactions-named-selftest license-checker)
fi
# Backend absent → skip the Rust/cargo/SQL/migration hooks.
if [ "$HAS_RS" = "0" ]; then
    skip_items+=(cargo-fmt cargo-clippy cargo-deny cargo-machete sqruff \
        tauri-command-sanitize tauri-command-instrumented \
        tauri-command-instrumented-selftest check-raw-tx check-raw-tx-self-test \
        check-dynamic-sql check-dynamic-sql-self-test check-command-arity \
        check-command-arity-self-test check-space-filter-drift unsafe-allowlist \
        audit-toml-in-sync migrations-immutable migrations-strict-tables \
        migrations-rebuild-cascade)
fi
# CI/tooling absent → skip the workflow/shell lint hooks.
if [ "$HAS_CI" = "0" ]; then
    skip_items+=(actionlint zizmor shellcheck skip-ci-verify-guard)
fi
# Docs absent → skip the Markdown/doc hooks.
if [ "$HAS_DOCS" = "0" ]; then
    skip_items+=(markdownlint md-link-targets doc-vs-code-paths session-log-numbering)
fi

# Compound guards: skip only when EVERY category they straddle is absent, so a
# binding-boundary / cross-cutting hook still runs if ANY adjacent category
# changed.
[ "$HAS_CI" = "0" ] && [ "$HAS_RS" = "0" ] && skip_items+=(taplo-fmt taplo-lint)
# tauri-*-parity / snapshot-redaction / retired-pending guard the FE↔BE binding
# boundary — they MUST run if frontend OR backend changed.
[ "$HAS_TS" = "0" ] && [ "$HAS_RS" = "0" ] && \
    skip_items+=(tauri-mock-parity tauri-bindings-parity snapshot-redaction no-retired-pending-doc-refs)
[ "$HAS_DOCS" = "0" ] && [ "$HAS_TS" = "0" ] && [ "$HAS_RS" = "0" ] && \
    skip_items+=(architecture-citations)
[ "$HAS_TS" = "0" ] && [ "$HAS_CI" = "0" ] && skip_items+=(check-json)
[ "$HAS_RS" = "0" ] && [ "$HAS_CI" = "0" ] && skip_items+=(check-toml)
[ "$HAS_CI" = "0" ] && skip_items+=(check-yaml)

PHASE_A_SKIP="$(IFS=,; printf '%s' "${skip_items[*]}")"

echo ""
echo "→ Phase A: prek run --all-files (pre-commit stage)"
echo "  SKIP=$PHASE_A_SKIP"
if ! SKIP="$PHASE_A_SKIP" prek run --all-files --hook-stage pre-commit; then
    echo ""
    echo "✗ Pre-push verification FAILED at Phase A (prek --all-files)."
    echo "  Bypass (use sparingly): SKIP_CI_VERIFY='<reason>' git push"
    exit 1
fi
echo "  ✓ prek --all-files"

# Migrations append-only backstop (#806): the migrations-immutable hook
# scans the STAGED index, which is empty at push time, so a commit made
# with `--no-verify` would sail through Phase A unnoticed. Re-check the
# whole push range for M/D/R/C/T under src-tauri/migrations/*.sql.
if ! bash scripts/check-migrations-immutable.sh --range "$RANGE"; then
    echo ""
    echo "✗ Pre-push verification FAILED: shipped migration changed in range '$RANGE' (#806)."
    echo "  Bypass (use sparingly): SKIP_CI_VERIFY='<reason>' git push"
    exit 1
fi
echo "  ✓ migrations append-only over '$RANGE'"

# ── Phase B: externalBin placeholder (only if Rust changed) ────────
# Tauri's build.rs validates the externalBin path on every cargo
# invocation; without the placeholder, `cargo nextest` in Phase D
# would fail with a misleading "missing external-binary" error.

if [ "$HAS_RS" = "1" ]; then
    echo ""
    echo "→ Phase B: externalBin placeholder"
    if ! node scripts/prepare-external-bins.mjs --placeholder-only > /dev/null 2>&1; then
        echo "  ✗ externalBin placeholder setup failed"
        exit 1
    fi
    echo "  ✓ externalBin placeholder"
fi

# ── Phase C: vitest related (scoped to push range) ─────────────────

echo ""
echo "→ Phase C: vitest related (range $RANGE)"
if ! bash scripts/test-related-ts.sh --range "$RANGE"; then
    echo ""
    echo "✗ Pre-push verification FAILED at Phase C (vitest related)."
    echo "  Iterate: bash scripts/test-related-ts.sh --range $RANGE"
    echo "  Bypass (use sparingly): SKIP_CI_VERIFY='<reason>' git push"
    exit 1
fi

# ── Phase D: cargo nextest related (scoped to push range) ──────────

if [ "$HAS_RS" = "1" ]; then
    echo ""
    echo "→ Phase D: cargo nextest related (range $RANGE)"
    if ! bash scripts/test-related-rust.sh --range "$RANGE"; then
        echo ""
        echo "✗ Pre-push verification FAILED at Phase D (cargo nextest related)."
        echo "  Iterate: bash scripts/test-related-rust.sh --range $RANGE"
        echo "  Bypass (use sparingly): SKIP_CI_VERIFY='<reason>' git push"
        exit 1
    fi
fi

# ── Phase D2: cargo test --doc (only if Rust changed) ──────────────
# nextest (Phase D) does NOT execute doc-tests, so a broken `/// ```` example
# would compile-fail invisibly. Run the doc-tests explicitly here so executable
# doc-comment examples on pure helpers stay honest (#2555). Cheap while there
# are few doc-tests; each compiles as its own binary, so scope grows the cost.

if [ "$HAS_RS" = "1" ]; then
    echo ""
    echo "→ Phase D2: cargo test --doc"
    if ! ( cd src-tauri && cargo test --doc ); then
        echo ""
        echo "✗ Pre-push verification FAILED at Phase D2 (cargo test --doc)."
        echo "  Iterate: ( cd src-tauri && cargo test --doc )"
        echo "  Bypass (use sparingly): SKIP_CI_VERIFY='<reason>' git push"
        exit 1
    fi
fi

# ── Phase E: cargo sqlx prepare --check, ALL FOUR lanes (only if Rust
# changed) ──────────────────────────────────────────────────────────
#
# Mirrors every `sqlx-offline-check` lane in `_validate.yml`: the workspace
# root (`src-tauri`) plus each layered-workspace member with its own
# crate-local `.sqlx/` cache — `agaric-store`, `agaric-engine`, `agaric-sync`
# (#2621 split). Checking only the root here let member-crate cache drift
# (e.g. #2849) slip past local verification and land only visible on CI —
# the exact gap this phase now closes.
#
# The root lane reuses `src-tauri/.env`'s `DATABASE_URL=sqlite:dev.db`
# (relative — fine because the app crate IS the workspace root) and runs
# `cargo sqlx migrate run` first so a freshly-pulled `dev.db` with pending
# migrations doesn't masquerade as query drift. Each member lane needs its
# own ABSOLUTE-path throwaway DB: `query!` resolves a *relative* sqlite path
# at compile time from rustc's CWD — the WORKSPACE ROOT, not the crate dir —
# so a relative URL there creates the DB under the crate but looks for it
# under `src-tauri/`, failing every query ("unable to open database file").
# Each member's `migrations -> ../migrations` symlink lets `migrate run`
# resolve the shared workspace migrations against that throwaway DB.

if [ "$HAS_RS" = "1" ]; then
    echo ""
    echo "→ Phase E: cargo sqlx prepare --check (4 lanes: root, agaric-store, agaric-engine, agaric-sync)"

    sqlx_check_failed=0

    sqlx_log="$(mktemp -t pre-push-sqlx-root.XXXXXX)"
    if ! ( cd src-tauri && cargo sqlx migrate run && cargo sqlx prepare --check -- --tests ) > "$sqlx_log" 2>&1; then
        echo "  ✗ sqlx prepare check failed (root: src-tauri)"
        tail -100 "$sqlx_log" | sed 's/^/      /'
        sqlx_check_failed=1
    else
        echo "  ✓ sqlx prepare check (root: src-tauri)"
    fi
    rm -f "$sqlx_log"

    for crate in agaric-store agaric-engine agaric-sync; do
        db="${TMPDIR:-/tmp}/$crate-sqlx-prepare.db"
        rm -f "$db"
        sqlx_log="$(mktemp -t "pre-push-sqlx-$crate.XXXXXX")"
        if ! ( cd "src-tauri/$crate" \
                && DATABASE_URL="sqlite:$db" cargo sqlx database create \
                && DATABASE_URL="sqlite:$db" cargo sqlx migrate run \
                && DATABASE_URL="sqlite:$db" cargo sqlx prepare --check -- --tests \
             ) > "$sqlx_log" 2>&1; then
            echo "  ✗ sqlx prepare check failed ($crate)"
            tail -100 "$sqlx_log" | sed 's/^/      /'
            sqlx_check_failed=1
        else
            echo "  ✓ sqlx prepare check ($crate)"
        fi
        rm -f "$sqlx_log" "$db"
    done

    if [ "$sqlx_check_failed" = "1" ]; then
        echo ""
        echo "✗ Pre-push verification FAILED at Phase E (sqlx prepare --check)."
        echo "  Iterate: just gen-sqlx (regenerates all 4 caches), then re-check the failing crate(s) above."
        echo "  Bypass (use sparingly): SKIP_CI_VERIFY='<reason>' git push"
        exit 1
    fi
fi

# ── Phase F: MCP build + UDS smoke + externalBin verify (gated) ────
# Only runs when MCP-related paths are in the push range. The release
# build is the slowest non-test step in the verifier; gating it on the
# narrow MCP surface keeps unrelated pushes fast.

if [ "$HAS_MCP" = "1" ]; then
    echo ""
    echo "→ Phase F: MCP UDS smoke + externalBin verify (MCP paths touched)"

    smoke_log="$(mktemp -t pre-push-mcp-smoke.XXXXXX)"
    if ! ( cd src-tauri && cargo nextest run --features ci-smoke --profile ci \
            -E 'test(stub_binary_roundtrips_initialize_over_uds)' ) > "$smoke_log" 2>&1; then
        echo "  ✗ MCP UDS smoke test failed"
        tail -100 "$smoke_log" | sed 's/^/      /'
        rm -f "$smoke_log"
        exit 1
    fi
    rm -f "$smoke_log"
    echo "  ✓ MCP UDS smoke"

    extbin_log="$(mktemp -t pre-push-extbin.XXXXXX)"
    if ! node scripts/prepare-external-bins.mjs > "$extbin_log" 2>&1; then
        echo "  ✗ prepare-external-bins.mjs (release) failed"
        tail -100 "$extbin_log" | sed 's/^/      /'
        rm -f "$extbin_log"
        exit 1
    fi
    rm -f "$extbin_log"

    if ! src-tauri/target/release/agaric-mcp --version > /dev/null 2>&1; then
        echo "  ✗ agaric-mcp --version failed"
        exit 1
    fi
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
fi

# ── Phase G: warn-only audits (do not block push) ──────────────────

echo ""
echo "→ Phase G: warn-only audits (informational)"

audit_log="$(mktemp -t pre-push-audit.XXXXXX)"
if ( cd src-tauri && cargo audit --no-fetch ) > "$audit_log" 2>&1; then
    echo "  ✓ cargo audit (no findings)"
else
    echo "  ⚠ cargo audit had findings (warn-only); review and triage into deny.toml if accepted"
    tail -20 "$audit_log" | sed 's/^/      /'
fi
rm -f "$audit_log"

npm_sig_log="$(mktemp -t pre-push-npm-sig.XXXXXX)"
if npm audit signatures > "$npm_sig_log" 2>&1; then
    echo "  ✓ npm audit signatures (all verified)"
else
    echo "  ⚠ npm audit signatures had findings (warn-only); not every npm dep ships Sigstore provenance yet"
fi
rm -f "$npm_sig_log"

echo ""
echo "✓ Pre-push verification PASSED."
[ "$HAS_MCP" = "0" ] && echo "  (MCP build skipped — no MCP paths in range; CI will run the full check)"
echo "  (Playwright skipped — runs in CI on every PR; run \`npx playwright test\` locally if needed)"
echo "  (release bundle build: run scripts/verify-release-build.sh manually before tagging)"
