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
# the git hooks (pre-commit, pre-push, commit-msg, …). Best-effort; re-run any
# time. `just setup` already calls this — use it standalone to fill gaps.
[group('bootstrap')]
install-hooks:
    bash scripts/setup-hooks.sh

# --- Develop ---------------------------------------------------------------

# Run the desktop app in dev mode with hot reload (Rust + frontend).
[group('develop')]
dev: _require-npm
    cargo tauri dev

# Run the frontend only (Vite dev server, no Tauri shell).
[group('develop')]
web: _require-npm
    npm run dev

# Serve the production build locally (run `just build` first).
[group('develop')]
preview: _require-npm
    npm run preview

# Run the Android app in dev mode.
[group('develop')]
android: _require-npm
    npm run android:dev

# --- Test ------------------------------------------------------------------

# Run the full test suite: frontend (Vitest) + backend (cargo nextest).
[group('test')]
test: test-fe test-be

# Frontend unit tests (Vitest, single run).
[group('test')]
test-fe: _require-npm
    npm run test

# `--workspace` (#3212): bare `cargo nextest run` from `src-tauri/` (a workspace
# ROOT that is also the `agaric` root package) resolves to the `agaric` package
# ONLY — it silently skips agaric-core/store/engine/sync/observability/diagnostics
# entirely (measured: 3359 vs 5446 tests, zero agaric-engine tests without this flag).
# Backend tests (cargo nextest). Needs the sqlx dev DB — run `just setup-db` first.
[group('test')]
test-be:
    cd src-tauri && cargo nextest run --workspace

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

# Re-run frontend tests on change.
[group('test')]
test-watch: _require-npm
    npm run test:watch

# Frontend tests with coverage (feeds the coverage ratchet).
[group('test')]
coverage: _require-npm
    npm run test:coverage

# End-to-end tests (Playwright).
[group('test')]
test-e2e: _require-npm
    npm run test:e2e

# --- Lint & format ---------------------------------------------------------

# Lint JS/TS (oxlint).
[group('lint')]
lint: _require-npm
    npm run lint

# Lint and auto-fix JS/TS (oxlint --fix).
[group('lint')]
lint-fix: _require-npm
    npm run lint:fix

# Typecheck every tsconfig project (tsc -b --noEmit). Bare `npx tsc --noEmit` checks NOTHING — see AGENTS.md.
[group('lint')]
typecheck: _require-npm
    npm run typecheck

# Format files you changed vs HEAD: oxfmt (JS/TS/JSON) + taplo (TOML). See fmt-all for a whole-repo pass.
[group('lint')]
fmt: _require-npm
    npm run format:changed
    npm run format:toml

# Format the entire repo (large diff — reserve for intentional repo-wide passes).
[group('lint')]
fmt-all: _require-npm
    npm run format
    npm run format:toml

# --- Verify ----------------------------------------------------------------

# Full local gate — CI's `validate` job mirror. Needs the prek host binaries (lychee, typos-cli, shellcheck, …).
[group('verify')]
check: _require-npm
    prek run --all-files

# Pre-push CI-equivalent verifier (nextest + clippy + knip + lychee + related tests).
[group('verify')]
verify:
    bash scripts/verify-ci-equivalent.sh

# Verify-then-push. Runs the CI-equivalent verifier BEFORE opening the push
# connection, so a slow verify can't leave the SSH connection idle long enough
# for GitHub to drop it ("Connection closed by remote host"). Prefer this over
# raw `git push` for any .rs change. Forwards all args, e.g.
# `just push -- -u origin my-branch` or `just push -- --force-with-lease`.
[group('verify')]
push *ARGS:
    bash scripts/push.sh {{ARGS}}

# --- Build -----------------------------------------------------------------

# Type-check and build the frontend bundle.
[group('build')]
build: _require-npm
    npm run build

# Build the full desktop app — release bundle, slow.
[group('build')]
build-app: _require-npm
    npm run tauri:build

# Build the Android app (release).
[group('build')]
android-build: _require-npm
    npm run android:build

# --- Codegen ---------------------------------------------------------------

# Regenerate Tauri IPC TypeScript bindings (src/lib/bindings.ts) after changing IPC-exposed Rust types.
[group('codegen')]
gen-bindings:
    cd src-tauri && cargo test -- specta_tests --ignored

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

# Regenerate emoji data.
[group('codegen')]
gen-emoji: _require-npm
    npm run gen:emoji
