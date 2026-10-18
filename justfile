# Agaric task runner — a thin, discoverable façade over the canonical dev
# commands. Every recipe shells out to the real entry point (npm scripts,
# cargo, prek, scripts/*), so package.json and prek.toml stay the single
# source of truth and this file cannot silently drift from them.
#
# `just` is OPTIONAL: nothing in the build, CI, or git hooks depends on it.
# Install once with `cargo install --locked just`, then run `just` (or
# `just --list`) to see every recipe below, grouped by purpose.

# Show the recipe list (grouped) when `just` is run with no arguments.
default:
    @just --list

# Fail fast where `npm run` would start on an npm older than `engines.npm`:
# `npm run` is not engine-gated, only `npm install` / `npm ci` are. Every recipe
# that runs npm (directly, or through `cargo tauri`) depends on this; `setup`
# does not, because it is what upgrades npm.
[private]
_require-npm:
    @bash scripts/require-npm.sh >/dev/null

# --- Bootstrap -------------------------------------------------------------

# One-shot post-clone setup (npm ci, Playwright, .env, dev DB). Idempotent.
[group('bootstrap')]
setup:
    npm run setup

# Set up the Android dev env (SDK, Rust targets, spike_test AVD); `--check` previews, `--init-project` regenerates gen/android.
[group('bootstrap')]
setup-android *ARGS:
    bash scripts/setup-android.sh {{ARGS}}

# Provision / refresh the local sqlx offline-check dev DB (needed before pushing Rust).
[group('bootstrap')]
setup-db:
    bash scripts/setup-dev-db.sh

# Install the prek hook TOOLCHAIN (prek + every host binary the hooks call:
# cargo-deny, sqruff, typos, zizmor, taplo, lychee, shellcheck, …) and wire
# the git hooks (pre-commit, pre-push, commit-msg, …).
# Install the prek hook toolchain and wire the git hooks; best-effort, `just setup` already calls it.
[group('bootstrap')]
install-hooks:
    bash scripts/setup-hooks.sh

# --- Develop ---------------------------------------------------------------

# Run the desktop app in dev mode with hot reload (Rust + frontend).
[group('develop')]
dev: _require-npm
    cargo tauri dev

# Run the Android app in dev mode.
[group('develop')]
android: _require-npm
    npm run android:dev

# --- Test ------------------------------------------------------------------

# Run the full test suite: frontend (Vitest), backend (cargo nextest), and Rust doc-tests.
[group('test')]
test: test-fe test-be test-doc

# Frontend unit tests (Vitest, single run); extra args go to vitest, e.g. `just test-fe src/lib/foo.test.ts`.
[group('test')]
[positional-arguments]
test-fe *ARGS: _require-npm
    npm run test -- "$@"

# Frontend tests that import what your uncommitted work touches, plus the tests reading a changed fixture or bindings.ts; `--dry` previews, `--range main...HEAD` checks a branch.
[group('test')]
[positional-arguments]
test-fe-related *ARGS: _require-npm
    bash scripts/test-related-ts.sh --worktree "$@"

# `--workspace` (#3212): bare `cargo nextest run` from `src-tauri/` (a workspace
# ROOT that is also the `agaric` root package) resolves to the `agaric` package
# ONLY — it silently skips agaric-core/store/engine/sync/observability/diagnostics
# entirely (measured: 3359 vs 5446 tests, zero agaric-engine tests without this flag).
# Backend tests (cargo nextest --workspace); extra args go to nextest, e.g. `just test-be -E 'test(name)'`. Needs the sqlx dev DB — run `just setup-db` first.
[group('test')]
[positional-arguments]
test-be *ARGS:
    cd src-tauri && cargo nextest run --workspace "$@"

# Backend tests of the crates your uncommitted work touches, and of every crate depending on them; `--dry` previews, `--range main...HEAD` checks a branch.
[group('test')]
[positional-arguments]
test-be-related *ARGS:
    bash scripts/test-related-rust.sh --worktree "$@"

# The e2e specs your uncommitted work can affect, by area tag: prints one command per lane (Playwright, WebdriverIO) and runs neither; `--range main...HEAD` checks a branch.
[group('test')]
[positional-arguments]
e2e-related *ARGS:
    bash scripts/e2e-related.sh --worktree "$@"

# Rust doc-tests, which nextest does not run. Needs the sqlx dev DB, same as `test-be`.
[group('test')]
test-doc:
    cd src-tauri && cargo test --doc --workspace

# Reach for this after promoting a `debug_assert!` (#4638) or auditing arithmetic
# on a trust boundary (#4640): the dev profile keeps assertions the shipped binary
# drops, so only this run exercises what release executes. Why `[profile.release]`
# itself cannot run tests is on `[profile.release-test]` in src-tauri/Cargo.toml.
# Needs the sqlx dev DB, same as `test-be` — run `just setup-db` first, or the
# `query!` macros fail with errors that say nothing about the profile.
# Slower than `test-be` (an optimised build of the world); not a per-change gate.
# Backend tests with RELEASE semantics: `debug_assertions` off, `overflow-checks` on.
[group('test')]
test-be-release:
    cd src-tauri && cargo nextest run --workspace --cargo-profile release-test

# Build the embedded debug binary, then run one real-backend spec under Xvfb, e.g. `just e2e-real e2e-tauri/draft-blur-persist.e2e.ts`; deps in e2e-tauri/AGENTS.md § Running.
[group('test')]
[positional-arguments]
e2e-real SPEC: _require-npm
    bash scripts/e2e-tauri-local.sh "$1"

# --- Lint & format ---------------------------------------------------------

# Lint JS/TS (oxlint).
[group('lint')]
lint: _require-npm
    npm run lint

# Typecheck every tsconfig project (tsc -b --noEmit). Bare `npx tsc --noEmit` checks NOTHING — see AGENTS.md.
[group('lint')]
typecheck: _require-npm
    npm run typecheck

# Format what you changed vs HEAD: oxfmt (JS/TS/JSON), taplo (TOML), and cargo fmt (all Rust).
[group('lint')]
fmt: _require-npm
    npm run format:changed
    npm run format:toml
    cd src-tauri && cargo fmt --all

# Clippy exactly as CI runs it. `--lib` skips test code and `-p` skips the other crates; neither is enough.
[group('lint')]
clippy:
    cd src-tauri && cargo clippy --workspace --all-targets -- -D warnings

# --- Verify ----------------------------------------------------------------

# Every pre-commit-stage prek hook over the whole tree. Not all of CI's validate job: pre-push and manual hooks (clippy, knip, lychee, npm-audit, …) and the sqlx lanes are not run. Needs the prek host binaries (typos-cli, shellcheck, …).
[group('verify')]
check: _require-npm
    prek run --all-files

# Frontend inner loop: typecheck, oxlint, then the tests your uncommitted work can break.
[group('verify')]
check-fe: typecheck lint test-fe-related

# Backend inner loop: cargo fmt --check, clippy as CI runs it, then the tests your uncommitted work can break.
[group('verify')]
check-be: && clippy test-be-related
    cd src-tauri && cargo fmt --all --check

# Pre-push verifier: pre-commit hooks + vitest/nextest scoped to the push range + sqlx cache check (clippy, knip, lychee, npm-audit run only in the pre-push hook).
[group('verify')]
verify:
    bash scripts/verify-ci-equivalent.sh

# Verify-then-push. Runs the CI-equivalent verifier BEFORE opening the push
# connection, so a slow verify can't leave the SSH connection idle long enough
# for GitHub to drop it ("Connection closed by remote host"). Prefer this over
# raw `git push` for any .rs change.
# Verify, then push; extra args go to git push, e.g. `just push -- -u origin my-branch`.
[group('verify')]
push *ARGS:
    bash scripts/push.sh {{ARGS}}

# --- Codegen ---------------------------------------------------------------

# Regenerate Tauri IPC TypeScript bindings (src/lib/bindings.ts) after changing IPC-exposed Rust types.
[group('codegen')]
gen-bindings:
    cd src-tauri && cargo test --lib -- specta_tests --ignored

# After changing a command: bindings, conformance fixtures, mock tests, typecheck.
[group('codegen')]
ipc-check: gen-bindings _require-npm
    cd src-tauri && CONFORMANCE_UPDATE=1 cargo nextest run --workspace --test command_integration -E 'test(conformance_fixtures_match_backend)'
    npx oxfmt --write conformance/fixtures/
    npx vitest run src/lib/tauri-mock
    npm run typecheck

# Regenerate ALL FOUR committed sqlx offline query caches after changing SQL:
# the workspace root (`src-tauri/.sqlx`) plus each layered-workspace member
# that carries its own crate-local cache — `agaric-store`, `agaric-engine`,
# `agaric-sync` (#2621 split; each has its own CI lane in
# `.github/workflows/_validate.yml` via `.github/actions/sqlx-offline-check`).
# Mirrors those CI lanes exactly — see that composite action for the
# authoritative shape of each.
#
# Root pass: `--workspace` (both to sqlx and cargo) is REQUIRED: the CI `lint`
# job runs `cargo clippy --workspace --all-targets` with NO DATABASE_URL, so
# every workspace member's `query!` sites — including the leaf bin-only
# `diagnostics` crate that nothing depends on — must be in the shared
# workspace-root `.sqlx/`. A bare `cargo sqlx prepare` builds only the default
# member (`agaric`) + its deps and silently drops `diagnostics`'s queries,
# reddening `lint` on the next non-docs PR. sqlx's own `--workspace` only sets
# the write location; cargo's `--workspace` (after the `--`) is what forces the
# leaf crates to actually compile so their queries get captured.
#
# Member passes: each crate's OWN `.sqlx/` is regenerated by running
# `cargo sqlx prepare` FROM WITHIN that crate's directory (no `--workspace` —
# CI's per-crate lanes don't pass it either) against a throwaway ABSOLUTE-path
# SQLite DB. The DATABASE_URL must be absolute for a non-root member: `query!`
# resolves a *relative* sqlite path at compile time from rustc's CWD — the
# WORKSPACE ROOT (src-tauri), not the crate dir — so a relative URL creates
# the DB under the crate but looks for it under src-tauri/, failing every
# query with "unable to open database file". Each crate's `migrations ->
# ../migrations` symlink lets `cargo sqlx migrate run` resolve the shared
# workspace migrations. `-- --tests` (matches the CI lanes' default) so
# test-only query drift is captured too.
# Regenerate all four committed sqlx offline caches (root + agaric-store/engine/sync) after changing SQL.
[group('codegen')]
gen-sqlx:
    cd src-tauri && cargo sqlx prepare --workspace -- --workspace --tests
    for crate in agaric-store agaric-engine agaric-sync; do \
        db="${TMPDIR:-/tmp}/$crate-sqlx-prepare.db"; \
        rm -f "$db"; \
        ( cd "src-tauri/$crate" \
          && DATABASE_URL="sqlite:$db" cargo sqlx database create \
          && DATABASE_URL="sqlite:$db" cargo sqlx migrate run \
          && DATABASE_URL="sqlite:$db" cargo sqlx prepare -- --tests \
        ) || exit 1; \
        rm -f "$db"; \
    done
