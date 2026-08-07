#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Smart Rust test runner.
#
# Collects .rs files from a configurable diff source, converts each
# path to a nextest filter atom, and runs only the matching tests
# via cargo nextest.
#
# Two mapping tiers (#3220):
#
#   1. `src-tauri/src/**` — the app crate (`agaric`). Precise
#      path→module mapping, unchanged:
#        src-tauri/src/cache.rs           → test(~cache)
#        src-tauri/src/commands/blocks.rs → test(~commands::blocks)
#      Skips mod.rs, lib.rs, main.rs (no meaningful module filter).
#
#   2. Any other workspace member (agaric-core / agaric-store /
#      agaric-engine / agaric-sync / agaric-observability /
#      agaric-diagnostics, …) — coarse *package* mapping:
#        src-tauri/agaric-engine/src/apply/kernel.rs
#          → package(agaric-engine)
#      Before #3220 these files matched no `case` arm at all, produced
#      an empty filter list, and the hook exited 0 having run ZERO
#      tests — 2087 of the workspace's ~5452 tests had no local gate.
#      Package granularity is deliberately coarser than a per-module
#      map: the six crates do not share the app crate's layout, and a
#      wrong module guess re-creates the same false-green this fixes.
#      Running a crate's whole suite is strictly better than nothing.
#
#      The crate list is derived from `cargo metadata`, never
#      hardcoded, so a new workspace member is covered the day it is
#      added (note `diagnostics/` ships the package `agaric-diagnostics`
#      — directory name and package name are not interchangeable).
#
#   3. Anything else (`src-tauri/build.rs`, `src-tauri/benches/**`,
#      `src-tauri/fuzz/**`, strays outside the workspace) — reported
#      LOUDLY as unmapped. "I found nothing relevant" and "I found
#      something relevant and could not map it" must not look alike.
#
# Package filters force `--workspace` (#3212): a bare `cargo nextest
# run` from src-tauri/ is package-scoped to `agaric`, so
# `-E "package(agaric-engine)"` alone would silently match 0 tests.
# The `src-tauri/src/**`-only path keeps the historical bare form.
#
# Full-suite fallback: changes to the app entry/library files, the db module,
# agaric-core's error type, agaric-store's op definitions, or its pagination
# module force the whole workspace suite. These are foundational modules
# imported by broad test surfaces, so a targeted run would miss too much.
#
# Diff sources:
#   --cached         (default; pre-commit use) — files in the git index
#   --range REVSPEC  (pre-push use) — files differing in a commit range,
#                    e.g. `--range @{upstream}..HEAD` or `--range main...HEAD`
#   --dry            preview filter expressions (works with either)
#   --self-test      run the fixture suite below and exit
#
# Usage:
#   scripts/test-related-rust.sh                              # pre-commit
#   scripts/test-related-rust.sh --range @{upstream}..HEAD    # pre-push
#   scripts/test-related-rust.sh --range main...HEAD --dry    # preview
#   scripts/test-related-rust.sh --self-test                  # guard's own tests
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

# shellcheck disable=SC1091
. "$HOME/.cargo/env"

SOURCE="--cached"
RANGE=""
DRY=0
SELF_TEST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --cached)
      SOURCE="--cached"; shift ;;
    --range)
      SOURCE="--range"; RANGE="${2:-}"; shift 2
      [ -z "$RANGE" ] && { echo "ERROR: --range requires a revspec" >&2; exit 2; } ;;
    --dry)
      DRY=1; shift ;;
    --self-test)
      SELF_TEST=1; shift ;;
    *)
      echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if ! REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "ERROR: test-related-rust.sh must run inside a Git worktree." >&2
  exit 2
fi
REPO_ROOT=$(cd "$REPO_ROOT" && pwd -P)
# Which cargo the hook runs. A TEST SEAM, not a configuration knob (#3431).
#
# It used to be `CARGO_BIN="${CARGO_BIN:-cargo}"`, which is reachable from the
# production exec path: any ambient `CARGO_BIN` in a developer's shell or on a
# runner silently redirected the gate to a different binary — and a gate that
# can be pointed elsewhere by an unrelated environment variable is not a gate.
#
# The self-test cannot simply be handed the flag, because it drives the REAL
# (non-`--self-test`) path in a subprocess on purpose — that is the code it
# needs to cover. So the seam is gated on an explicit self-test marker that
# only the fixture harness exports, and both variables are namespaced to this
# script. Two deliberate, script-specific variables must be set together
# before the binary moves; nothing in a normal environment does that.
CARGO_BIN=cargo
if [ "${TEST_RELATED_RUST_SELF_TEST:-0}" = "1" ] && [ -n "${TEST_RELATED_RUST_CARGO_BIN:-}" ]; then
  CARGO_BIN="$TEST_RELATED_RUST_CARGO_BIN"
fi

# ── Foundational targets that force the full workspace suite ─────────
# A trailing slash declares a directory target and matches every file below
# that path. File targets match exactly. Keeping the kind in the spelling makes
# prefix matching path-segment-aware: `src/db/` matches `src/db/pool.rs`, but
# never `src/db_extra.rs`; `src/op.rs` never matches `src/op.rs_extra.rs`.
FALLBACK_TARGETS=(
  "src-tauri/src/lib.rs"
  "src-tauri/src/main.rs"
  "src-tauri/src/db/"
  "src-tauri/agaric-core/src/error.rs"
  "src-tauri/agaric-store/src/op.rs"
  "src-tauri/agaric-store/src/pagination/"
)

validate_fallback_targets() {
  local target resolved failed=0

  for target in "${FALLBACK_TARGETS[@]}"; do
    case "$target" in
      */)
        resolved="$REPO_ROOT/${target%/}"
        if [ ! -d "$resolved" ]; then
          echo "ERROR: configured Rust fallback directory is missing: $target" >&2
          failed=1
        fi
        ;;
      *)
        resolved="$REPO_ROOT/$target"
        if [ ! -f "$resolved" ]; then
          echo "ERROR: configured Rust fallback file is missing: $target" >&2
          failed=1
        fi
        ;;
    esac
  done

  if [ "$failed" -ne 0 ]; then
    echo "ERROR: update FALLBACK_TARGETS after moving a foundational Rust path." >&2
    return 1
  fi
}

FALLBACK_MATCH=""
matches_fallback_target() { # <repo-relative-file>
  local file="$1" target
  FALLBACK_MATCH=""
  for target in "${FALLBACK_TARGETS[@]}"; do
    case "$target" in
      */)
        case "$file" in
          "$target"*) FALLBACK_MATCH="$target"; return 0 ;;
        esac
        ;;
      *)
        if [ "$file" = "$target" ]; then
          FALLBACK_MATCH="$target"
          return 0
        fi
        ;;
    esac
  done
  return 1
}

# ── Workspace crate roots, derived from cargo metadata ───────────────
# Emits one "<repo-relative-crate-dir> <package-name>" line per
# workspace member, EXCLUDING the workspace-root package (`agaric`,
# whose directory is `src-tauri/` itself and would therefore swallow
# every path below it).
#
# Derived rather than hardcoded so the mapping cannot rot when a crate
# is added to `[workspace].members`; a hardcoded array is precisely how
# the pre-#3220 blind spot survived six crate extractions.
crate_roots() {
  local manifest meta
  manifest="$REPO_ROOT/src-tauri/Cargo.toml"
  [ -f "$manifest" ] || return 1

  # --offline first (hooks must not reach the network); fall back to a
  # networked resolve only if the lockfile is incomplete.
  meta=$("$CARGO_BIN" metadata --manifest-path "$manifest" --no-deps \
           --format-version 1 --offline 2>/dev/null) \
    || meta=$("$CARGO_BIN" metadata --manifest-path "$manifest" --no-deps \
           --format-version 1 2>/dev/null) \
    || return 1

  printf '%s' "$meta" | python3 -c "
import json, os, sys
meta = json.load(sys.stdin)
ws = os.path.realpath(meta['workspace_root'])
for pkg in meta['packages']:
    d = os.path.dirname(pkg['manifest_path'])
    if os.path.realpath(d) == ws:
        continue
    print(os.path.relpath(d, sys.argv[1]), pkg['name'])
" "$REPO_ROOT"
}

CRATE_MAP=""
CRATE_MAP_LOADED=0
load_crate_map() {
  if [ "$CRATE_MAP_LOADED" = "1" ]; then
    return 0
  fi
  CRATE_MAP_LOADED=1
  CRATE_MAP=$(crate_roots || true)
}

# Validate the REAL checkout before the self-test builds its faithful fixture.
# Otherwise the fixture could recreate a path that has gone stale in the
# checkout and let the always-run self-test report a false green.
if ! validate_fallback_targets; then
  exit 1
fi

# ── Self-test ────────────────────────────────────────────────────────
# Builds a throwaway workspace + git repo and asserts the selector's
# verdict for each shape. The #3220 regression this pins: a staged file
# under a non-app crate must produce a non-empty filter, and an
# unmappable Rust file must be reported loudly rather than blend into
# the "nothing to do" path.
if [ "$SELF_TEST" -eq 1 ]; then
  SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  fails=0

  assert_out() { # <label> <grep-pattern> <output>
    if printf '%s' "$3" | grep -qF -- "$2"; then
      echo "  ✓ $1"
    else
      echo "  ✗ $1 (expected output to contain: $2)" >&2
      printf '%s\n' "$3" | sed 's/^/      | /' >&2
      fails=$((fails + 1))
    fi
  }

  refute_out() { # <label> <grep-pattern> <output>
    if printf '%s' "$3" | grep -qF -- "$2"; then
      echo "  ✗ $1 (expected output NOT to contain: $2)" >&2
      printf '%s\n' "$3" | sed 's/^/      | /' >&2
      fails=$((fails + 1))
    else
      echo "  ✓ $1"
    fi
  }

  assert_eq() { # <label> <expected> <actual>
    if [ "$2" = "$3" ]; then
      echo "  ✓ $1"
    else
      echo "  ✗ $1 (expected: $2; actual: $3)" >&2
      fails=$((fails + 1))
    fi
  }

  # The fixture must not inherit the caller's git context. When this
  # runs from a git hook, GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE point at
  # the REAL repository — `git init` there is a re-init that rewrites
  # core.worktree to $tmp and leaves the checkout unusable once $tmp is
  # removed. Hooks are disabled too: the fixture would otherwise
  # inherit core.hooksPath and prek aborts on a repo with no prek.toml.
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_CONFIG \
    GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_PREFIX GIT_INTERNAL_GETTEXT_SH_SCHEME
  ceiling_dir=$(dirname "$tmp")
  export GIT_CEILING_DIRECTORIES="$ceiling_dir"

  cd "$tmp"
  git init -q -b main . >/dev/null
  # Belt-and-braces: if anything above were ever missed, the re-init
  # would be visible as a core.worktree pointing somewhere other than
  # $tmp, or a toplevel outside $tmp.
  if [ "$(git rev-parse --show-toplevel)" != "$(cd "$tmp" && pwd -P)" ]; then
    echo "FATAL: self-test fixture escaped its temp dir — aborting" >&2
    exit 1
  fi
  git config core.hooksPath /dev/null
  git config user.email self-test@example.invalid
  git config user.name "self test"

  # Minimal but structurally faithful workspace: a root package whose
  # dir is src-tauri/ itself, plus two members — one whose directory
  # name matches its package name, one where it does not
  # (diagnostics/ → agaric-diagnostics), which is exactly the case a
  # hardcoded crate array gets wrong.
  mkdir -p src-tauri/src/commands src-tauri/src/db src-tauri/src/loro \
    src-tauri/agaric-engine/src/apply src-tauri/agaric-core/src \
    src-tauri/agaric-store/src/pagination src-tauri/diagnostics/src tools
  cat > src-tauri/Cargo.toml <<'TOML'
[workspace]
resolver = "2"
members = [".", "agaric-core", "agaric-engine", "agaric-store", "diagnostics"]

[package]
name = "agaric"
version = "0.0.0"
edition = "2021"
TOML
  for member in agaric-core:agaric-core agaric-engine:agaric-engine \
    agaric-store:agaric-store \
    diagnostics:agaric-diagnostics; do
    dir="${member%%:*}"; pkg="${member##*:}"
    cat > "src-tauri/$dir/Cargo.toml" <<TOML
[package]
name = "$pkg"
version = "0.0.0"
edition = "2021"
TOML
    : > "src-tauri/$dir/src/lib.rs"
  done
  : > src-tauri/src/lib.rs
  : > src-tauri/src/main.rs
  : > src-tauri/src/db/mod.rs
  : > src-tauri/agaric-core/src/error.rs
  : > src-tauri/agaric-store/src/op.rs
  : > src-tauri/agaric-store/src/pagination/mod.rs
  : > README.md
  git add -A
  git commit -qm "fixture scaffold"

  cargo_stub="$tmp/cargo-stub"
  cargo_stub_log="$tmp/cargo-stub.log"
  cat > "$cargo_stub" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\0' "$PWD" "$@" > "$CARGO_STUB_LOG"
STUB
  chmod +x "$cargo_stub"

  stage() { # <path> — create (if absent) and stage a single file
    mkdir -p "$(dirname "$1")"
    printf '// fixture\n' > "$1"
    git add -- "$1"
  }

  run_sel_from() { # <cwd> [selector args...] → combined dry-run output
    local cwd="$1" out rc
    shift
    set +e
    out=$(cd "$cwd" && bash "$SELF" --dry "$@" 2>&1)
    rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
      out="$out
[exit $rc]"
    fi
    printf '%s' "$out"
  }

  run_sel() { # → dry run from the fixture root
    run_sel_from "$tmp"
  }

  run_real_from() { # <cwd> [selector args...] → stubbed non-dry output
    local cwd="$1" out rc
    shift
    set +e
    out=$(
      cd "$cwd" && \
        TEST_RELATED_RUST_SELF_TEST=1 TEST_RELATED_RUST_CARGO_BIN="$cargo_stub" \
        CARGO_STUB_LOG="$cargo_stub_log" bash "$SELF" "$@" 2>&1
    )
    rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
      out="$out
[exit $rc]"
    fi
    printf '%s' "$out"
  }

  # (1) app-crate file — the pre-existing precise path must be intact.
  stage src-tauri/src/cache.rs
  out=$(run_sel); git reset -q
  assert_out "src-tauri/src/cache.rs -> test(~cache)" 'test(~cache)' "$out"
  refute_out "app-crate-only run stays package-scoped (no --workspace)" \
    '--workspace' "$out"

  # (2) commands/ still pulls in the #818 specta bindings guard.
  stage src-tauri/src/commands/blocks.rs
  out=$(run_sel); git reset -q
  assert_out "commands/blocks.rs -> test(~commands::blocks)" \
    'test(~commands::blocks)' "$out"
  assert_out "commands/ -> specta bindings guard (#818)" \
    'test(~specta_tests)' "$out"

  # (3) THE #3220 REGRESSION: a crate-only change must not be silent.
  stage src-tauri/agaric-engine/src/apply/kernel.rs
  out=$(run_sel); git reset -q
  assert_out "agaric-engine file -> package(agaric-engine)" \
    'package(agaric-engine)' "$out"
  assert_out "package filter forces --workspace (#3212)" '--workspace' "$out"
  refute_out "crate-only change is not reported as unfilterable" \
    'UNMAPPED' "$out"

  # (4) directory name != package name.
  stage src-tauri/diagnostics/src/audit.rs
  out=$(run_sel); git reset -q
  assert_out "diagnostics/ -> package(agaric-diagnostics)" \
    'package(agaric-diagnostics)' "$out"

  # (5) mixed app + crate change keeps both tiers.
  stage src-tauri/src/cache.rs
  stage src-tauri/agaric-engine/src/apply/kernel.rs
  out=$(run_sel); git reset -q
  assert_out "mixed set keeps the module filter" 'test(~cache)' "$out"
  assert_out "mixed set keeps the package filter" 'package(agaric-engine)' "$out"

  # (6) non-Rust change — quiet skip, no alarm.
  stage README.md
  out=$(run_sel); git reset -q
  assert_out "non-Rust staged file -> quiet skip" 'No staged .rs files' "$out"
  refute_out "non-Rust staged file raises no alarm" 'UNMAPPED' "$out"

  # (7) Rust file in no known crate — loud, and named.
  stage tools/stray.rs
  out=$(run_sel); git reset -q
  assert_out "stray .rs -> loud UNMAPPED banner" 'UNMAPPED' "$out"
  assert_out "stray .rs -> names the offending file" 'tools/stray.rs' "$out"
  assert_out "stray .rs -> says no tests were selected" \
    'NO Rust tests were selected' "$out"

  # (8) deliberately non-filterable app file — quiet, distinct wording.
  stage src-tauri/src/loro/mod.rs
  out=$(run_sel); git reset -q
  assert_out "mod.rs only -> quiet, distinct skip message" \
    'carry no module filter' "$out"
  refute_out "mod.rs only raises no alarm" 'UNMAPPED' "$out"

  # (9) foundational file still escalates to the full workspace suite.
  stage src-tauri/agaric-core/src/error.rs
  out=$(run_sel); git reset -q
  assert_out "agaric-core/src/error.rs -> full workspace suite" \
    'cargo nextest run --workspace (full)' "$out"

  stage src-tauri/src/lib.rs
  out=$(run_sel); git reset -q
  assert_out "src/lib.rs -> full workspace suite" \
    'cargo nextest run --workspace (full)' "$out"

  stage src-tauri/src/main.rs
  out=$(run_sel); git reset -q
  assert_out "src/main.rs -> full workspace suite" \
    'cargo nextest run --workspace (full)' "$out"

  # (10) every file below the current db module directory is foundational.
  stage src-tauri/src/db/command_tx.rs
  out=$(run_sel); git reset -q
  assert_out "db/command_tx.rs -> full workspace suite" \
    'cargo nextest run --workspace (full)' "$out"

  # (11) Directory matching happens before mod.rs is treated as unfilterable.
  stage src-tauri/src/db/mod.rs
  out=$(run_sel); git reset -q
  assert_out "db/mod.rs -> full workspace suite" \
    'cargo nextest run --workspace (full)' "$out"

  # (12) The moved agaric-store op definition remains an exact-file fallback.
  stage src-tauri/agaric-store/src/op.rs
  out=$(run_sel); git reset -q
  assert_out "agaric-store/src/op.rs -> full workspace suite" \
    'cargo nextest run --workspace (full)' "$out"

  # (13) Any file below agaric-store's pagination module is foundational.
  stage src-tauri/agaric-store/src/pagination/history.rs
  out=$(run_sel); git reset -q
  assert_out "pagination/history.rs -> full workspace suite" \
    'cargo nextest run --workspace (full)' "$out"

  stage src-tauri/agaric-store/src/pagination/mod.rs
  out=$(run_sel); git reset -q
  assert_out "pagination/mod.rs -> full workspace suite" \
    'cargo nextest run --workspace (full)' "$out"

  # (14) Prefix-like siblings must stay on their normal narrow selectors.
  stage src-tauri/src/db_extra.rs
  stage src-tauri/agaric-store/src/pagination_extra/history.rs
  stage src-tauri/agaric-store/src/op_extra.rs
  stage src-tauri/agaric-store/src/op.rs_extra.rs
  out=$(run_sel); git reset -q
  assert_out "db_extra.rs remains module-filtered" 'test(~db_extra)' "$out"
  assert_out "agaric-store prefix siblings remain package-filtered" \
    'package(agaric-store)' "$out"
  refute_out "prefix siblings do not trigger the full workspace fallback" \
    'cargo nextest run --workspace (full)' "$out"
  refute_out "prefix siblings are not reported as unmapped" 'UNMAPPED' "$out"

  # (15) NUL-delimited paths keep spaces/newlines intact. Both unusual names
  # are below foundational directories and must therefore escalate cleanly.
  stage 'src-tauri/src/db/with space.rs'
  out=$(run_sel); git reset -q
  assert_out "spaced db filename -> full workspace suite" \
    'cargo nextest run --workspace (full)' "$out"
  refute_out "spaced db filename is not unmapped" 'UNMAPPED' "$out"

  newline_fallback=$'src-tauri/agaric-store/src/pagination/line\nbreak.rs'
  stage "$newline_fallback"
  out=$(run_sel); git reset -q
  assert_out "newline pagination filename -> full workspace suite" \
    'cargo nextest run --workspace (full)' "$out"
  refute_out "newline pagination filename is not unmapped" 'UNMAPPED' "$out"

  stage 'src-tauri/src/feature with space.rs'
  out=$(run_sel); git reset -q
  assert_out "nonfallback spaced filename remains module-filtered" \
    'test(~feature with space)' "$out"
  refute_out "nonfallback spaced filename does not run the full suite" \
    'cargo nextest run --workspace (full)' "$out"
  refute_out "nonfallback spaced filename is not unmapped" 'UNMAPPED' "$out"

  # (16) Both cached and range modes resolve paths from the repository root,
  # even when the hook is launched from a nested workspace directory.
  nested_cwd="$tmp/src-tauri/agaric-engine/src/apply"
  stage src-tauri/src/main.rs
  out=$(run_sel_from "$nested_cwd" --cached); git reset -q
  assert_out "nested cwd cached diff finds foundational main.rs" \
    'cargo nextest run --workspace (full)' "$out"
  refute_out "nested cwd cached diff is not unmapped" 'UNMAPPED' "$out"

  stage 'src-tauri/src/db/range nested.rs'
  git commit -qm "range-mode fixture"
  out=$(run_sel_from "$nested_cwd" --range 'HEAD^..HEAD')
  assert_out "nested cwd range diff finds foundational db file" \
    'cargo nextest run --workspace (full)' "$out"
  refute_out "nested cwd range diff is not unmapped" 'UNMAPPED' "$out"

  # (17) Exercise the REAL (non-dry) fallback branch with an injected cargo
  # binary. The stub records NUL-delimited cwd/argv, proving the selector execs
  # from the fixture's src-tauri root with the exact full-workspace command.
  stage src-tauri/src/main.rs
  out=$(run_real_from "$nested_cwd" --cached); git reset -q
  assert_out "stubbed non-dry fallback reaches the cargo exec" \
    'running full test suite' "$out"
  if [ -f "$cargo_stub_log" ]; then
    cargo_call=()
    mapfile -d '' -t cargo_call < "$cargo_stub_log"
    assert_eq "cargo stub recorded cwd plus three argv entries" "4" "${#cargo_call[@]}"
    assert_eq "full fallback cargo cwd is fixture/src-tauri" \
      "$(cd "$tmp/src-tauri" && pwd -P)" "${cargo_call[0]:-}"
    assert_eq "full fallback argv[0] is nextest" "nextest" "${cargo_call[1]:-}"
    assert_eq "full fallback argv[1] is run" "run" "${cargo_call[2]:-}"
    assert_eq "full fallback argv[2] is --workspace" "--workspace" "${cargo_call[3]:-}"
  else
    echo "  ✗ cargo stub did not write its invocation log" >&2
    fails=$((fails + 1))
  fi

  # (17b) #3431: the cargo seam must NOT be reachable from a production run.
  # An ambient `CARGO_BIN` — the pre-#3431 spelling, and a plausible thing to
  # find in a developer's shell or on a runner — must move nothing.
  #
  # A dry run keeps this cheap (no suite is executed), and the staged file is
  # deliberately a NON-fallback crate file: that is the path that resolves the
  # crate map through `$CARGO_BIN metadata`, so an honoured override both
  # writes the stub's log AND breaks the mapping (the stub returns no JSON).
  # A fallback file would short-circuit before cargo is ever consulted and the
  # assertion would pass without proving anything.
  rm -f "$cargo_stub_log"
  stage src-tauri/agaric-store/src/seam_probe.rs
  set +e
  out=$(cd "$tmp" && CARGO_BIN="$cargo_stub" CARGO_STUB_LOG="$cargo_stub_log" \
    bash "$SELF" --dry --cached 2>&1)
  set -e
  git reset -q; rm -f "$tmp/src-tauri/agaric-store/src/seam_probe.rs"
  assert_out "an ambient CARGO_BIN still produces the correct selection" \
    'package(agaric-store)' "$out"
  if [ -e "$cargo_stub_log" ]; then
    echo "  ✗ ambient CARGO_BIN redirected the hook's cargo (test seam is production-reachable)" >&2
    fails=$((fails + 1))
  else
    echo "  ✓ an ambient CARGO_BIN does not redirect the hook's cargo"
  fi

  # (18) A moved/deleted exact-file target makes the selector fail loudly.
  rm src-tauri/agaric-store/src/op.rs
  out=$(run_sel)
  assert_out "missing fallback file is reported" \
    'configured Rust fallback file is missing: src-tauri/agaric-store/src/op.rs' "$out"
  assert_out "missing fallback file fails the selector" '[exit 1]' "$out"

  # The always-run outer self-test mode must validate THIS checkout before it
  # can construct a fixture that recreates the stale target and masks the move.
  set +e
  outer_out=$(bash "$SELF" --self-test 2>&1)
  outer_rc=$?
  set -e
  if [ "$outer_rc" -ne 0 ]; then
    outer_out="$outer_out
[exit $outer_rc]"
  fi
  assert_out "outer self-test validates the real checkout first" \
    'configured Rust fallback file is missing: src-tauri/agaric-store/src/op.rs' "$outer_out"
  assert_out "outer self-test fails before building its fixture" '[exit 1]' "$outer_out"
  git checkout -q -- src-tauri/agaric-store/src/op.rs

  # (19) Directory targets are validated too, so a future module move cannot
  # silently turn every prefix match into a dead fallback.
  mv src-tauri/agaric-store/src/pagination src-tauri/agaric-store/src/pagination-moved
  out=$(run_sel)
  assert_out "missing fallback directory is reported" \
    'configured Rust fallback directory is missing: src-tauri/agaric-store/src/pagination/' "$out"
  assert_out "missing fallback directory fails the selector" '[exit 1]' "$out"
  mv src-tauri/agaric-store/src/pagination-moved src-tauri/agaric-store/src/pagination

  if [ "$fails" -gt 0 ]; then
    echo "self-test: $fails assertion(s) failed" >&2
    exit 1
  fi
  echo "self-test: all assertions passed"
  exit 0
fi

STAGED_RS=()
if [ "$SOURCE" = "--cached" ]; then
  mapfile -d '' -t STAGED_RS < <(
    git -C "$REPO_ROOT" diff --cached --name-only -z --diff-filter=ACMR -- '*.rs' || true
  )
  LABEL="staged"
else
  mapfile -d '' -t STAGED_RS < <(
    git -C "$REPO_ROOT" diff "$RANGE" --name-only -z --diff-filter=ACMR -- '*.rs' || true
  )
  LABEL="range $RANGE"
fi

if [ ${#STAGED_RS[@]} -eq 0 ]; then
  echo "No $LABEL .rs files — skipping cargo nextest"
  exit 0
fi

# Check the changed files against exact-file and path-bounded directory targets
# before module/package filtering. This ensures foundational mod.rs files are
# escalated instead of being skipped by the non-filterable basename rule below.
for file in "${STAGED_RS[@]}"; do
  if matches_fallback_target "$file"; then
    echo "Foundational file in $LABEL set ($file matches $FALLBACK_MATCH) — running full test suite"
    if [ "$DRY" = "1" ]; then
      echo "  → cargo nextest run --workspace (full)"
      exit 0
    fi
    # --workspace (#3212): the bare form is package-scoped to `agaric` only and
    # silently skips agaric-core/store/engine/sync/observability/diagnostics —
    # exactly the workspace members a foundational-file change (error.rs lives
    # in agaric-core) needs to re-verify.
    cd "$REPO_ROOT/src-tauri" && exec "$CARGO_BIN" nextest run --workspace
  fi
done

# ── Build filter atoms ───────────────────────────────────────────────
MODULE_FILTERS=()
PKG_FILTERS=()
UNMAPPED=()
NEED_SPECTA=0
for file in "${STAGED_RS[@]}"; do
  case "$file" in
    src-tauri/src/*)
      # Any commands/*.rs change can alter the specta surface; the
      # checked-in src/lib/bindings.ts must be regenerated in the same
      # commit or `specta_tests::ts_bindings_up_to_date` (src-tauri/src/
      # lib.rs) fails in CI ~15 min later. Pull that test into the
      # related-set here so the drift surfaces at commit time (#818).
      case "$file" in
        src-tauri/src/commands/*) NEED_SPECTA=1 ;;
      esac

      basename=$(basename "$file")

      # Skip files that don't map to a useful module filter
      case "$basename" in
        mod.rs|lib.rs|main.rs) continue ;;
      esac

      # Strip prefix (src-tauri/src/) and suffix (.rs) → module path
      module="${file#src-tauri/src/}"
      module="${module%.rs}"
      # Convert / to :: for Rust module notation
      module="${module//\//::}"

      MODULE_FILTERS+=("$module")
      continue
      ;;
  esac

  # Outside src-tauri/src/ (#3220): map the file to its owning
  # workspace member and select that package wholesale.
  load_crate_map
  crate=""
  while read -r crate_dir crate_name; do
    [ -n "$crate_dir" ] || continue
    case "$file" in
      "$crate_dir"/*) crate="$crate_name"; break ;;
    esac
  done <<< "$CRATE_MAP"

  if [ -n "$crate" ]; then
    PKG_FILTERS+=("$crate")
  else
    UNMAPPED+=("$file")
  fi
done

# Bindings-drift guard (#818): commands/ changed → also run the
# specta bindings-up-to-date test.
if [ "$NEED_SPECTA" = "1" ]; then
  MODULE_FILTERS+=("specta_tests")
fi

# ── Report unmappable Rust changes loudly (#3220) ────────────────────
# Silence here used to be indistinguishable from "nothing relevant
# changed". These files ARE relevant Rust changes the selector could
# not translate into a filter, so say so, by name, on stderr.
if [ ${#UNMAPPED[@]} -gt 0 ]; then
  {
    echo ""
    echo "──────────────────────────────────────────────────────────"
    echo "UNMAPPED Rust changes (${#UNMAPPED[@]}) in the $LABEL set:"
    for f in "${UNMAPPED[@]}"; do
      echo "    ! $f"
    done
    echo ""
    echo "  These are neither under src-tauri/src/ (module mapping) nor"
    echo "  inside a workspace member (package mapping), so NO test"
    echo "  filter covers them. This is NOT the same as \"nothing"
    echo "  relevant changed\"."
    echo ""
    echo "  If they carry test-relevant logic, verify by hand:"
    echo "    (cd src-tauri && cargo nextest run --workspace)"
    echo "──────────────────────────────────────────────────────────"
    echo ""
  } >&2
fi

if [ ${#MODULE_FILTERS[@]} -eq 0 ] && [ ${#PKG_FILTERS[@]} -eq 0 ]; then
  if [ ${#UNMAPPED[@]} -gt 0 ]; then
    echo "NO Rust tests were selected: every $LABEL .rs file is UNMAPPED (see above)." >&2
    exit 0
  fi
  echo "All $LABEL .rs files are mod.rs/lib.rs/main.rs — they carry no module filter — skipping"
  exit 0
fi

# Deduplicate, then build the nextest filter atoms.
FILTERS=()
if [ ${#MODULE_FILTERS[@]} -gt 0 ]; then
  readarray -t MODULE_FILTERS < <(printf '%s\n' "${MODULE_FILTERS[@]}" | sort -u)
  for mod in "${MODULE_FILTERS[@]}"; do
    FILTERS+=("test(~$mod)")
  done
fi
if [ ${#PKG_FILTERS[@]} -gt 0 ]; then
  readarray -t PKG_FILTERS < <(printf '%s\n' "${PKG_FILTERS[@]}" | sort -u)
  for pkg in "${PKG_FILTERS[@]}"; do
    FILTERS+=("package($pkg)")
  done
fi

# `package(...)` only resolves against packages nextest was asked to
# consider. Run from src-tauri/, the bare invocation is scoped to the
# `agaric` package alone (#3212), so a package filter without
# `--workspace` matches zero tests and — with --no-tests=pass — exits 0
# having run nothing: the exact false green #3220 is about. Module-only
# runs keep the historical narrow scope.
SCOPE=()
if [ ${#PKG_FILTERS[@]} -gt 0 ]; then
  SCOPE=(--workspace)
fi

echo "Running cargo nextest for ${#FILTERS[@]} filter(s) from $LABEL: ${FILTERS[*]}"

# Build a single -E expression: test(~mod1) + package(crate) + …
#
# `--no-tests=pass` makes nextest exit 0 (not 4) if the filter matches 0
# tests. That's the legitimate case for cfg-gated modules (e.g.
# `sync_daemon::android_multicast` which is entirely
# `#[cfg(target_os = "android")]`) where a desktop run sees no compiled
# tests but the compile step itself is already covered by `cargo clippy`.
EXPR=""
for atom in "${FILTERS[@]}"; do
  if [ -z "$EXPR" ]; then
    EXPR="$atom"
  else
    EXPR="$EXPR + $atom"
  fi
done

if [ "$DRY" = "1" ]; then
  echo "  → cargo nextest run ${SCOPE[*]:-} --no-tests=pass -E \"$EXPR\""
  exit 0
fi

cd "$REPO_ROOT/src-tauri" && exec "$CARGO_BIN" nextest run "${SCOPE[@]}" --no-tests=pass -E "$EXPR"
