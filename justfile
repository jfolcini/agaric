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

# --- Bootstrap -------------------------------------------------------------

# One-shot post-clone setup (npm ci, Playwright, .env, dev DB). Idempotent.
[group('bootstrap')]
setup:
    npm run setup

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
dev:
    cargo tauri dev

# Run the frontend only (Vite dev server, no Tauri shell).
[group('develop')]
web:
    npm run dev

# Serve the production build locally (run `just build` first).
[group('develop')]
preview:
    npm run preview

# Run the Android app in dev mode.
[group('develop')]
android:
    npm run android:dev

# --- Test ------------------------------------------------------------------

# Run the full test suite: frontend (Vitest) + backend (cargo nextest).
[group('test')]
test: test-fe test-be

# Frontend unit tests (Vitest, single run).
[group('test')]
test-fe:
    npm run test

# Backend tests (cargo nextest). Needs the sqlx dev DB — run `just setup-db` first.
[group('test')]
test-be:
    cd src-tauri && cargo nextest run

# Re-run frontend tests on change.
[group('test')]
test-watch:
    npm run test:watch

# Frontend tests with coverage (feeds the coverage ratchet).
[group('test')]
coverage:
    npm run test:coverage

# End-to-end tests (Playwright).
[group('test')]
test-e2e:
    npm run test:e2e

# --- Lint & format ---------------------------------------------------------

# Lint JS/TS (oxlint).
[group('lint')]
lint:
    npm run lint

# Lint and auto-fix JS/TS (oxlint --fix).
[group('lint')]
lint-fix:
    npm run lint:fix

# Format files you changed vs HEAD: oxfmt (JS/TS/JSON) + taplo (TOML). See fmt-all for a whole-repo pass.
[group('lint')]
fmt:
    npm run format:changed
    npm run format:toml

# Format the entire repo (large diff — reserve for intentional repo-wide passes).
[group('lint')]
fmt-all:
    npm run format
    npm run format:toml

# --- Verify ----------------------------------------------------------------

# Full local gate — CI's `validate` job mirror. Needs the prek host binaries (lychee, typos-cli, shellcheck, …).
[group('verify')]
check:
    prek run --all-files

# Pre-push CI-equivalent verifier (nextest + clippy + knip + lychee + related tests).
[group('verify')]
verify:
    bash scripts/verify-ci-equivalent.sh

# --- Build -----------------------------------------------------------------

# Type-check and build the frontend bundle.
[group('build')]
build:
    npm run build

# Build the full desktop app — release bundle, slow.
[group('build')]
build-app:
    npm run tauri:build

# Build the Android app (release).
[group('build')]
android-build:
    npm run android:build

# --- Codegen ---------------------------------------------------------------

# Regenerate Tauri IPC TypeScript bindings (src/lib/bindings.ts) after changing IPC-exposed Rust types.
[group('codegen')]
gen-bindings:
    cd src-tauri && cargo test -- specta_tests --ignored

# Regenerate the sqlx offline query cache (.sqlx/) after changing SQL.
[group('codegen')]
gen-sqlx:
    cd src-tauri && cargo sqlx prepare -- --tests

# Regenerate emoji data.
[group('codegen')]
gen-emoji:
    npm run gen:emoji
