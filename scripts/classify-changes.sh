#!/usr/bin/env bash
# The one change classifier: which CI lanes a change set must run. Read by
# `_validate.yml`'s `detect-changes` (and, through its outputs, `ci.yml`'s two
# bundle jobs), `codeql.yml`'s language pick, and `e2e-tauri-weekly.yml`'s
# relevance check.
#
# Usage:
#   classify-changes.sh           classify the GitHub event's diff (env below)
#   classify-changes.sh --stdin   classify a newline-separated path list
# Prints `key=value` lines on stdout, for `>> "$GITHUB_OUTPUT"`; the log goes
# to stderr.
#
# Event env: EVENT_NAME; PR_BASE_SHA and PR_HEAD_SHA on `pull_request`,
# PUSH_BEFORE and PUSH_AFTER on anything else. A caller that leaves
# PUSH_BEFORE unset gets the full set on every non-PR event.
#
# FAIL-CLOSED: every path where the diff cannot be computed (no base, an
# unreachable base, a failing `git diff`, an empty diff) emits the full set,
# and each class below that SKIPS work holds only when EVERY changed path
# matches its patterns. `validate-all` and `e2e-tauri-gate` also fail when the
# job running this did not succeed. A classifier error costs CI minutes, never
# a weakened gate.
set -euo pipefail

# Outputs (OR semantics unless noted; a path may match several, except a docs
# path, which sets `docs` and nothing else):
#   docs_only    every path matches the docs allowlist (drives lint/docs-lint).
#   docs         any docs path.
#   frontend     any src/, e2e/, e2e-tauri/, *.ts/tsx/js/jsx/css, package*.json,
#                vite/vitest/tailwind/postcss/tsconfig config, index.html.
#   backend      any src-tauri/, *.rs, Cargo.*, migrations, .sqlx/.
#   ci           any .github/, scripts/, .claude/, prek.toml, .taplo.toml,
#                lychee.toml, .gitleaks.toml.
#   desktop      a Linux-bundle-relevant path: `ci.yml`'s `build`.
#   android      an Android-package-relevant path: `ci.yml`'s `android-build`.
#   vitest       the whole sharded suite and its coverage gate: any `frontend`
#                path outside the three lane-local trees below, or a vitest
#                test file.
#   vitest_e2e_tauri  only `npx vitest run e2e-tauri`: the diff's vitest paths
#                are all `e2e-tauri/` non-specs. Never true with `vitest`.
#   playwright   the Playwright suite: any `frontend` path except vitest test
#                files and `e2e-tauri/`, and the non-frontend files a spec
#                reads (`pw_reads_re`).
#   playwright_specs  when non-empty, Playwright runs only these changed specs
#                (space-separated); empty with `playwright` means every shard.
#   real_backend a path the real-backend lane builds or runs.
#   real_backend_specs  when non-empty, that lane runs only these changed
#                `e2e-tauri/*.e2e.ts` specs; empty means every spec.
#   codeql_languages  JSON list of the CodeQL languages the diff touches.
# Run it from the repo root with the head checked out: a changed spec that is
# not on disk was deleted, so it is never listed.
# A backend change that regenerates src/lib/bindings.ts also flips frontend
# (bindings-drift / mock-parity tests run); keep that.

emit() {
  printf '%s\n' \
    "docs_only=$docs_only" "docs=$docs" "frontend=$frontend" "backend=$backend" \
    "ci=$ci" "desktop=$desktop" "android=$android" "vitest=$vitest" \
    "vitest_e2e_tauri=$vitest_e2e_tauri" "playwright=$playwright" \
    "playwright_specs=$playwright_specs" "real_backend=$real_backend" \
    "real_backend_specs=$real_backend_specs" "codeql_languages=$codeql_languages"
}

# The "run everything" classification, then exit 0.
full_suite() {
  echo "$1" >&2
  docs_only=false docs=true frontend=true backend=true ci=true desktop=true android=true
  vitest=true vitest_e2e_tauri=false playwright=true playwright_specs='' real_backend=true
  real_backend_specs=''
  codeql_languages='["actions","javascript-typescript","rust"]'
  emit
  exit 0
}

if [ "${1:-}" = "--stdin" ]; then
  diff_out="$(cat)"
elif [ "$#" -ne 0 ]; then
  echo "usage: $0 [--stdin]" >&2
  exit 2
else
  if [ "${EVENT_NAME:-}" = "pull_request" ]; then
    base="${PR_BASE_SHA:-}"
    head="${PR_HEAD_SHA:-}"
  else
    # push (feature branch / main), tag (release.yml), schedule, dispatch.
    # A tag or a schedule never resolves a meaningful `before`; fail-closed
    # handles it.
    base="${PUSH_BEFORE:-}"
    head="${PUSH_AFTER:-}"
  fi

  # New-branch / orphan push (`before` is all zeros), or an event with
  # nothing to diff against.
  if [ -z "$base" ] || [ -z "$head" ] || [ "$base" = "0000000000000000000000000000000000000000" ]; then
    full_suite "Base sha unresolved: running the full set (fail-closed)."
  fi

  # A force-push rewrote the old tip out of the runner clone.
  if ! git cat-file -e "$base" 2>/dev/null; then
    full_suite "Base sha $base unreachable: running the full set (fail-closed)."
  fi

  # Three-dot diff: only the files this branch changed relative to the
  # merge-base, never files where `main` moved ahead while the branch sat
  # behind; a two-dot diff would mislabel a code PR as docs-only whenever
  # main had unrelated doc churn. `--no-renames` lists both sides of a
  # rename: rename detection would print only the new name, so moving
  # `src/x.ts` to `docs/x.md` would read as docs-only. Checked explicitly:
  # a failed diff must fail closed, not vanish into a process substitution.
  if ! diff_out=$(git diff --no-renames --name-only "$base"..."$head"); then
    full_suite "::warning::git diff $base...$head failed: running the full set (fail-closed)."
  fi
fi

changed=()
if [ -n "$diff_out" ]; then
  mapfile -t changed <<< "$diff_out"
fi

# An empty diff is more likely a base/head confusion than an intentional
# no-op PR, and there is nothing to fast-path.
if [ "${#changed[@]}" -eq 0 ]; then
  full_suite "Empty diff: running the full set (fail-closed)."
fi

echo "Changed files:" >&2
printf '  %s\n' "${changed[@]}" >&2

# Conservative docs allowlist, anchored at repo root: any Markdown file,
# anything under docs/, and the LICENSE / NOTICE / AUTHORS / CHANGELOG text
# files. NOT included: lockfiles, .toml/.yml/.yaml config, source, workflow
# YAML, prek.toml. When in doubt, a path is NOT docs and the full suite runs.
docs_re='^(docs/|.*\.md$|LICENSE([.-].*)?$|NOTICE$|AUTHORS$|CHANGELOG$)'

# `^src-tauri/` already subsumes the Cargo/migrations alternatives; they are
# listed so the intent is legible.
backend_re='(^src-tauri/|\.rs$|^src-tauri/Cargo\.(toml|lock)$|src-tauri/migrations/|\.sqlx/|^scripts/(check-sqlx-cache-drift|check-unsafe-allowlist)\.sh$|^scripts/coverage-ratchet\.mjs$|^scripts/coverage-baseline\.json$)'
frontend_re='(^src/|^e2e/|\.(ts|tsx|js|jsx|css)$|^package(-lock)?\.json$|^(vite|vitest|tailwind|postcss)\.config\.|^tsconfig.*\.json$|^index\.html$|^scripts/check-(axe-presence|test-file-naming)\.sh$|^scripts/(coverage-ratchet|print-coverage-thresholds|check-bundle-budget(\.test)?)\.mjs$|^scripts/(bundle-budgets|coverage-baseline)\.json$|^scripts/check-(bare-icon-buttons|import-cycles|store-layering|migrations-strict|mutants-scope|mutation-reports|stryker-modules)\.mjs$|^scripts/lib/js-scanner\.mjs$|^scripts/classify-changes\.sh$|^src-tauri/src/commands/(queries|blocks/queries|pages/metadata)\.rs$|^src-tauri/agaric-store/src/(fts/(toggle_filter|metadata_filter)|query/engine)\.rs$)'
# `scripts/` and `.claude/` are tooling: the guards and their manual-stage
# self-tests run in `lint` (a `scripts/*.test.mjs` runs wherever it is
# named: `pr-diff-base` in `lint`, `check-bundle-budget` in
# `vitest-coverage`), so a tooling-only PR is `ci` and pays no suite. The few
# files a suite consumes are routed to that suite above, data files included,
# so a re-baseline PR still runs the gate that reads it: the sqlx drift check
# and the unsafe allowlist to backend; the axe/test-naming hook owners, the
# bundle-budget guard with its `bundle-budgets.json`, the two coverage
# scripts, and every script a `src/**/*.test.ts` imports or spawns (the seven
# `check-*.mjs` guards with unit tests in `src/__tests__/`,
# `scripts/lib/js-scanner.mjs`, and this classifier) to frontend, since only
# the vitest shards run those tests, and likewise the six Rust files
# `conformance-coverage.test.ts` parses for their dispatch (a Rust-only
# refactor of one of them, #4988, reached main with the guard never run and
# broke the 0.13.0 release run); the ratchet and its `coverage-baseline.json`
# also to backend, since `cargo-coverage` runs it with `--gate`. Adding a
# vitest test for another script means adding that script here too. A script
# that no suite executes is linted by `lint`'s oxlint/oxfmt, which the shared
# SKIP list keeps on whenever `ci` is present.
# `scripts/verify-ci-equivalent.sh` keeps the same `ci` set (`CI_PATH_RE`;
# its self-test ratchets the two against each other) but leaves the
# coverage/bundle scripts and their baselines as `ci` alone: no local phase
# runs either coverage gate or the bundle budget, so there is no suite to
# route them to.
ci_re='(^\.github/|^scripts/|^\.claude/|^prek\.toml$|^\.taplo\.toml$|^lychee\.toml$|^\.gitleaks\.toml$)'

# Bundle/packaging gates for `ci.yml`'s two build jobs. Narrow on purpose:
# logic correctness lives in the suites above, so these only guard bundling /
# packaging / cross-compile drift. Android is deliberately NOT every
# `src-tauri/**` change (host Rust almost always cross-compiles), so it names
# the scaffold/conf files, the cross-compile dependency graph, and each file
# carrying an `cfg(target_os = "android")` / `cfg(mobile)` gate. Move one of
# those files and move its entry here in the same commit;
# `scripts/check-android-trigger.mjs` asserts every literal path listed still
# exists. Both name `.github/actions/`: the build jobs run their toolchain
# preamble through the composites there, so a SHA bump inside one is a change
# to the bundle job and must run it.
desktop_re='^(src-tauri/|\.cargo/config\.toml\.example$|scripts/(fix-appimage-icons\.sh|check-appimage-media-plugins\.sh|prepare-external-bins\.mjs)$|package(-lock)?\.json$|\.github/workflows/ci\.yml$|\.github/actions/)'
android_re='^(src-tauri/gen/android/|src-tauri/tauri\.android\.conf\.json$|src-tauri/tauri\.conf\.json$|src-tauri/Cargo\.(toml|lock)$|src-tauri/build\.rs$|src-tauri/src/(lib|lifecycle|android_jni)\.rs$|src-tauri/agaric-store/src/db/mod\.rs$|src-tauri/agaric-sync/src/android_context\.rs$|src-tauri/agaric-sync/src/sync_daemon/(android_multicast|android_network_block|mod|session_supervisor)\.rs$|scripts/patch-android-build\.sh$|scripts/check-android-so-alignment\.mjs$|scripts/prepare-external-bins\.mjs$|\.github/workflows/ci\.yml$|\.github/actions/)'

# The real-backend lane (`e2e-tauri-weekly.yml`): could this path change what
# that lane BUILDS or RUNS? The Rust app, the frontend bundle the binary serves
# (`public/` is copied verbatim into `dist/`), the specs and their runner, and
# the manifests all of that resolves from. Not `e2e/`, the rest of `scripts/`,
# or `.github/actions/`: each can break the lane, and each is covered by a job
# that gates the merge (prek's `tsc` in `lint`, the `_validate.yml` jobs that
# share the composites).
real_backend_re='^(src/|src-tauri/|e2e-tauri/|public/|wdio\.conf\.ts$|index\.html$|vite\.config\.ts$|tsconfig[^/]*\.json$|package(-lock)?\.json$|\.github/workflows/e2e-tauri-weekly\.yml$)'

# Rust files that compile only into test targets, so they cannot change what
# `build`, `android-build` or the real-backend lane produces: a crate's
# integration tests (`src-tauri/tests/`, `src-tauri/<crate>/tests/`), and
# modules every one of whose `mod` declarations is `#[cfg(test)]`
# (`tests.rs`, `*_tests.rs`, and everything under a `tests/` or `*_tests/`
# directory). `src/commands/tests/` is the exception: it is
# `cfg(any(test, feature = "test-util"))`, so it stays non-test-only. A new
# module matching these names must be `#[cfg(test)]` or be listed as an
# exception here. Classified by FILE, never by diff hunk: an edit inside the
# `mod tests` block of a production file is a production-file change.
test_only_re='^src-tauri/(.*/)?(tests/.*|[^/]*_tests/.*|tests\.rs|[^/]*_tests\.rs)$'
test_only_exception_re='^src-tauri/src/commands/tests/'

# Test-only classes, which narrow the three frontend lanes. A test file can
# break only itself and its own lane's coverage, so each lane sees a path as
# one of: nothing it reads, one of its own specs (the lane may run just the
# changed specs), or anything else (the lane runs whole).
#   - `e2e-tauri/` is read only by the real-backend lane and by the
#     `e2e-tauri/*.test.ts` vitest files: a `*.e2e.ts` spec only by
#     WebdriverIO, a `*.test.ts` only by vitest, and the shared modules
#     (`helpers.ts`, `sync-peer.ts`, …) by both, whole.
#   - `e2e/` is read only by Playwright; no vitest test imports or reads it.
#     `helpers.ts` (or anything else not a spec) runs every shard.
#   - A vitest test file under `src/` runs the whole vitest suite, whose
#     coverage gate is a whole-suite number, and nothing else: test files are
#     not bundled. Every other `src/` file is product code, shared test
#     infrastructure (`test-setup.ts`, `__tests__/mocks/`, …) included, and so
#     is every test file under `src/lib/tauri-mock/`, the mock Playwright runs
#     against. The root configs (`vitest.config.ts`, `playwright.config.ts`,
#     `wdio.conf.ts`) are product code by default.
# A spec list reaches Playwright as regexes and WebdriverIO as a word-split
# list, so a spec named outside plain path characters runs its lane whole.
e2e_tauri_re='^e2e-tauri/'
wdio_spec_re='^e2e-tauri/[A-Za-z0-9._/-]+\.e2e\.ts$'
e2e_tauri_test_re='^e2e-tauri/.*\.test\.ts$'
e2e_re='^e2e/'
pw_spec_re='^e2e/[A-Za-z0-9._/-]+\.spec\.ts$'
vitest_test_re='^src/.*\.(test|spec)\.tsx?$'
src_test_infra_re='^src/lib/tauri-mock/'
# Files outside the frontend set that a Playwright spec reads from disk:
# `e2e/interface-zoom.spec.ts` sizes its viewport from `tauri.conf.json`.
pw_reads_re='^src-tauri/tauri\.conf\.json$'
# Past this many changed specs Playwright runs every shard instead: the list
# runs on one leg, which a sweep over most specs would hold past
# `playwright.config.ts`'s `globalTimeout`.
pw_spec_list_max=20

# CodeQL languages, by the code each extractor reads. A path no category
# recognizes selects all three (the pin below), as do the CodeQL config and
# workflow; a recognized path that carries no code (a TOML or JSON config)
# selects none.
codeql_rust_re='(\.rs$|(^|/)Cargo\.(toml|lock)$|^src-tauri/)'
codeql_js_re='(\.(ts|tsx|js|jsx|mjs|cjs|html)$|(^|/)package(-lock)?\.json$|^(src|e2e|e2e-tauri|scripts)/)'
codeql_actions_re='^\.github/'
codeql_all_re='^\.github/(codeql/|workflows/codeql\.yml$)'

# Single pass, no `break`: every path must be inspected. A docs path sets
# `docs` and nothing else: no suite, build, lane or CodeQL language reads
# Markdown, wherever it lives (`src/stores/AGENTS.md`, `.claude/skills/**.md`),
# and the prek hooks that do are keyed on `docs` or run in every `lint`. Any
# other path sticks the flags it matches; docs_only stays true only while
# EVERY path is docs.
#
# Each frontend lane takes a path through the test-only classes above: a path
# the lane reads that is not one of its specs sticks `*_full` (run whole), and
# a spec still on disk joins the lane's list. The list is emitted only while
# no path set `*_full`.
#
# FAIL-CLOSED default for UNRECOGNIZED non-docs paths: a file that is neither
# docs nor any known category (rust-toolchain.toml, .cargo/config.toml,
# rustfmt.toml, a root Justfile / Dockerfile / *.sh) is a build/toolchain
# change no single suite owns, so it pins frontend=backend=ci=true, every
# frontend lane whole, the real-backend lane whole and every CodeQL language.
# Recognized-but-unsuited categories (a pure `ci` change like a workflow edit)
# do NOT trip this: `lint` (incl. zizmor) covers them.
docs_only=true
docs=false
frontend=false
backend=false
ci=false
desktop=false
android=false
vitest_full=false
vitest_e2e_tauri_hit=false
pw_full=false
real_full=false
pw_specs=()
real_specs=()
lang_rust=false
lang_js=false
lang_actions=false
for f in "${changed[@]}"; do
  if [[ "$f" =~ $docs_re ]]; then docs=true; continue; fi

  if [ "$docs_only" = "true" ]; then
    echo "Non-docs path detected: $f → docs_only=false (full lint suite)." >&2
  fi
  docs_only=false
  matched_cat=false
  test_only=false
  if [[ "$f" =~ $test_only_re ]] && [[ ! "$f" =~ $test_only_exception_re ]]; then test_only=true; fi
  if [[ "$f" =~ $frontend_re ]]; then frontend=true; matched_cat=true; fi
  if [[ "$f" =~ $backend_re ]]; then backend=true; matched_cat=true; fi
  if [[ "$f" =~ $ci_re ]]; then ci=true; matched_cat=true; fi
  # Build gates only: they never suppress the fail-closed branch below, and a
  # test-only file never makes a build relevant.
  if [ "$test_only" = "false" ]; then
    if [[ "$f" =~ $desktop_re ]]; then desktop=true; fi
    if [[ "$f" =~ $android_re ]]; then android=true; fi
  fi
  if [[ "$f" =~ $e2e_tauri_re ]]; then
    if [[ "$f" =~ $wdio_spec_re ]]; then
      if [ -f "$f" ]; then real_specs+=("$f"); fi
    else
      vitest_e2e_tauri_hit=true
      if [[ ! "$f" =~ $e2e_tauri_test_re ]]; then real_full=true; fi
    fi
  elif [[ "$f" =~ $e2e_re ]]; then
    if [[ "$f" =~ $pw_spec_re ]]; then
      if [ -f "$f" ]; then pw_specs+=("$f"); fi
    else
      pw_full=true
    fi
  elif [[ "$f" =~ $vitest_test_re ]] && [[ ! "$f" =~ $src_test_infra_re ]]; then
    vitest_full=true
  else
    if [[ "$f" =~ $frontend_re ]]; then vitest_full=true; pw_full=true; fi
    if [[ "$f" =~ $pw_reads_re ]]; then pw_full=true; fi
    if [ "$test_only" = "false" ] && [[ "$f" =~ $real_backend_re ]]; then real_full=true; fi
  fi
  if [[ "$f" =~ $codeql_rust_re ]]; then lang_rust=true; fi
  if [[ "$f" =~ $codeql_js_re ]]; then lang_js=true; fi
  if [[ "$f" =~ $codeql_actions_re ]]; then lang_actions=true; fi
  if [[ "$f" =~ $codeql_all_re ]]; then lang_rust=true; lang_js=true; lang_actions=true; fi
  if [ "$matched_cat" = "false" ]; then
    echo "Unrecognized non-docs path: $f → pinning frontend=backend=ci=true, every lane whole and every CodeQL language (fail-closed)." >&2
    frontend=true
    backend=true
    ci=true
    vitest_full=true
    pw_full=true
    real_full=true
    lang_rust=true
    lang_js=true
    lang_actions=true
  fi
done

vitest="$vitest_full"
vitest_e2e_tauri=false
if [ "$vitest_full" = "false" ] && [ "$vitest_e2e_tauri_hit" = "true" ]; then vitest_e2e_tauri=true; fi

if [ "${#pw_specs[@]}" -gt "$pw_spec_list_max" ]; then pw_full=true; fi
playwright="$pw_full"
playwright_specs=''
if [ "$pw_full" = "false" ] && [ "${#pw_specs[@]}" -gt 0 ]; then
  playwright=true
  playwright_specs="${pw_specs[*]}"
fi

real_backend="$real_full"
real_backend_specs=''
if [ "$real_full" = "false" ] && [ "${#real_specs[@]}" -gt 0 ]; then
  real_backend=true
  real_backend_specs="${real_specs[*]}"
fi

langs=()
if [ "$lang_actions" = "true" ]; then langs+=('"actions"'); fi
if [ "$lang_js" = "true" ]; then langs+=('"javascript-typescript"'); fi
if [ "$lang_rust" = "true" ]; then langs+=('"rust"'); fi
codeql_languages="[$(IFS=,; echo "${langs[*]}")]"

emit | sed 's/^/  /' >&2
emit
