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
# Full-suite fallback: if any matched file is lib.rs, main.rs, db.rs,
# error.rs, op.rs, or pagination.rs — these are foundational modules
# imported by nearly every test, so a targeted run would miss too much.
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
  local repo_root manifest meta
  repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  manifest="$repo_root/src-tauri/Cargo.toml"
  [ -f "$manifest" ] || return 1

  # --offline first (hooks must not reach the network); fall back to a
  # networked resolve only if the lockfile is incomplete.
  meta=$(cargo metadata --manifest-path "$manifest" --no-deps \
           --format-version 1 --offline 2>/dev/null) \
    || meta=$(cargo metadata --manifest-path "$manifest" --no-deps \
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
" "$repo_root"
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

  # The fixture must not inherit the caller's git context. When this
  # runs from a git hook, GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE point at
  # the REAL repository — `git init` there is a re-init that rewrites
  # core.worktree to $tmp and leaves the checkout unusable once $tmp is
  # removed. Hooks are disabled too: the fixture would otherwise
  # inherit core.hooksPath and prek aborts on a repo with no prek.toml.
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_CONFIG \
    GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_PREFIX GIT_INTERNAL_GETTEXT_SH_SCHEME
  export GIT_CEILING_DIRECTORIES="$tmp"

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
  mkdir -p src-tauri/src/commands src-tauri/src/loro \
    src-tauri/agaric-engine/src/apply src-tauri/agaric-core/src \
    src-tauri/diagnostics/src tools
  cat > src-tauri/Cargo.toml <<'TOML'
[workspace]
resolver = "2"
members = [".", "agaric-core", "agaric-engine", "diagnostics"]

[package]
name = "agaric"
version = "0.0.0"
edition = "2021"
TOML
  for member in agaric-core:agaric-core agaric-engine:agaric-engine \
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
  : > README.md
  git add -A
  git commit -qm "fixture scaffold"

  stage() { # <path> — create (if absent) and stage a single file
    mkdir -p "$(dirname "$1")"
    printf '// fixture\n' > "$1"
    git add -- "$1"
  }

  run_sel() { # → combined stdout+stderr of a --dry run; never aborts
    local out rc
    set +e
    out=$(bash "$SELF" --dry 2>&1)
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

  if [ "$fails" -gt 0 ]; then
    echo "self-test: $fails assertion(s) failed" >&2
    exit 1
  fi
  echo "self-test: all assertions passed"
  exit 0
fi

if [ "$SOURCE" = "--cached" ]; then
  STAGED_RS=$(git diff --cached --name-only --diff-filter=ACMR -- '*.rs' || true)
  LABEL="staged"
else
  STAGED_RS=$(git diff "$RANGE" --name-only --diff-filter=ACMR -- '*.rs' || true)
  LABEL="range $RANGE"
fi

if [ -z "$STAGED_RS" ]; then
  echo "No $LABEL .rs files — skipping cargo nextest"
  exit 0
fi

# ── Foundational files that trigger a full test run ──────────────────
# These modules are imported by nearly every test — targeted filtering
# would give a false sense of safety.
FALLBACK_PATTERNS="src-tauri/src/lib.rs src-tauri/src/main.rs src-tauri/src/db.rs src-tauri/agaric-core/src/error.rs src-tauri/src/op.rs src-tauri/src/pagination.rs"

for pat in $FALLBACK_PATTERNS; do
  if echo "$STAGED_RS" | grep -qx "$pat"; then
    echo "Foundational file in $LABEL set ($pat) — running full test suite"
    if [ "$DRY" = "1" ]; then
      echo "  → cargo nextest run --workspace (full)"
      exit 0
    fi
    # --workspace (#3212): the bare form is package-scoped to `agaric` only and
    # silently skips agaric-core/store/engine/sync/observability/diagnostics —
    # exactly the workspace members a foundational-file change (error.rs lives
    # in agaric-core) needs to re-verify.
    cd src-tauri && exec cargo nextest run --workspace
  fi
done

# ── Build filter atoms ───────────────────────────────────────────────
MODULE_FILTERS=()
PKG_FILTERS=()
UNMAPPED=()
NEED_SPECTA=0
for file in $STAGED_RS; do
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
      module=$(echo "$module" | sed 's|/|::|g')

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

cd src-tauri && exec cargo nextest run "${SCOPE[@]}" --no-tests=pass -E "$EXPR"
