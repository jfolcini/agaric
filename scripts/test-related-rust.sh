#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Related-test runner for the Rust workspace.
#
# Maps every changed file to the workspace crate that owns it and runs
# that crate's tests plus the tests of every crate that depends on it:
#
#   cargo nextest run --workspace --no-tests=pass -E 'rdeps(=a) + rdeps(=b)'
#
# Crate granularity, because a module-name filter misses tests whose
# names do not mirror the source path (the `commands` integration binary,
# a dependent crate's suite) and so passes having run nothing relevant.
#
# Mapping, first match wins:
#   *.md                                   ignored
#   src-tauri/fuzz/**, src-tauri/gen/**    reported as not covered (own
#                                          workspace / Android project)
#   migrations, a Cargo.toml or            full suite: every crate
#   Cargo.lock, nextest config and setup   compiles or runs against them
#   scripts, rust-toolchain.toml
#   conformance/**, src/lib/bindings.ts    agaric (its tests read them)
#   src-tauri/<member>/**                  that member's package
#   any other src-tauri/** path            agaric (the root package)
#   anything else                          not a Rust test input
#
# A `.sqlx/` cache maps to the crate it sits in: test builds compile
# `query!` against the dev DB, and pre-push Phase E checks the caches.
# Members come from `cargo metadata`, so a new crate is mapped the day it
# joins the workspace.
#
# Diff sources (the last one given wins):
#   --cached         (default) files in the git index
#   --range REVSPEC  files differing in a commit range (pre-push Phase D),
#                    e.g. `--range @{upstream}..HEAD`
#   --worktree       uncommitted work: staged, unstaged and untracked files
#                    against HEAD (`just test-be-related`)
#   --dry            print the selection instead of running it
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

# shellcheck disable=SC1091
. "$HOME/.cargo/env"

SOURCE="cached"
LABEL="staged"
RANGE=""
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --cached)
      SOURCE="cached"; LABEL="staged"; shift ;;
    --range)
      [ -n "${2:-}" ] || { echo "ERROR: --range requires a revspec" >&2; exit 2; }
      SOURCE="range"; RANGE="$2"; LABEL="range $RANGE"; shift 2 ;;
    --worktree)
      SOURCE="worktree"; LABEL="working tree"; shift ;;
    --dry)
      DRY=1; shift ;;
    *)
      echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if ! REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "ERROR: test-related-rust.sh must run inside a Git worktree." >&2
  exit 2
fi
REPO_ROOT=$(cd "$REPO_ROOT" && pwd -P)
# Hardcoded, not `${CARGO_BIN:-cargo}` (#3431): an ambient variable must not
# be able to point the gate at a different binary.
CARGO_BIN=cargo

list_changed() {
  case "$SOURCE" in
    cached)  git -C "$REPO_ROOT" diff --cached --name-only --no-renames -z ;;
    range)   git -C "$REPO_ROOT" diff "$RANGE" --name-only --no-renames -z ;;
    worktree) git -C "$REPO_ROOT" diff HEAD --name-only --no-renames -z \
               && git -C "$REPO_ROOT" ls-files --others --exclude-standard -z ;;
  esac
}

# A git failure (a bad revspec) must not read as "nothing changed".
if ! CHANGED_RAW=$(list_changed | tr '\0' '\n'); then
  echo "ERROR: could not list the $LABEL changes." >&2
  exit 2
fi
mapfile -t CHANGED <<< "$CHANGED_RAW"

# One "<repo-relative-dir> <package>" line per workspace member, deepest
# directory first so a member wins over the root package (`src-tauri/`).
crate_roots() {
  local meta
  # --offline first (hooks must not reach the network).
  meta=$("$CARGO_BIN" metadata --manifest-path "$REPO_ROOT/src-tauri/Cargo.toml" \
           --no-deps --format-version 1 --offline 2>/dev/null) \
    || meta=$("$CARGO_BIN" metadata --manifest-path "$REPO_ROOT/src-tauri/Cargo.toml" \
           --no-deps --format-version 1) \
    || return 1
  printf '%s' "$meta" | node -e '
const { readFileSync } = require("node:fs")
const { dirname, relative } = require("node:path")
const meta = JSON.parse(readFileSync(0, "utf8"))
const rows = meta.packages.map((p) => [relative(process.argv[1], dirname(p.manifest_path)), p.name])
rows.sort((a, b) => b[0].length - a[0].length)
for (const [dir, name] of rows) console.log(dir, name)
' "$REPO_ROOT"
}

CRATE_MAP=""
CRATE=""
crate_of() { # <repo-relative-file> → sets CRATE
  local dir name
  CRATE=""
  if [ -z "$CRATE_MAP" ] && ! CRATE_MAP=$(crate_roots); then
    echo "ERROR: cargo metadata failed; cannot map changes to crates." >&2
    exit 1
  fi
  while read -r dir name; do
    case "$1" in
      "$dir"/*) CRATE="$name"; return 0 ;;
    esac
  done <<< "$CRATE_MAP"
}

# Tests that read a sibling crate's source files as data. They depend on
# that crate with no Cargo edge for rdeps() to follow.
source_readers() { # <package>
  case "$1" in
    agaric)
      echo '(package(=agaric-store) & test(/^(block_descendants::cohort_cascade_drift_guard|space_filter_canonical)::/))' ;;
    agaric-engine)
      echo '(package(=agaric-store) & test(/^block_descendants::cohort_cascade_drift_guard::/))' ;;
    agaric-diagnostics)
      echo '(package(=agaric) & test(/^commands::(observability|bug_report)::/))' ;;
  esac
}

FULL=""
CRATES=()
NOT_COVERED=()
for file in "${CHANGED[@]}"; do
  [ -n "$file" ] || continue
  case "$file" in
    *.md) ;;
    src-tauri/fuzz/*|src-tauri/gen/*)
      NOT_COVERED+=("$file") ;;
    src-tauri/migrations/*|src-tauri/Cargo.lock|src-tauri/Cargo.toml|src-tauri/*/Cargo.toml|src-tauri/.config/*|src-tauri/scripts/*|rust-toolchain.toml)
      FULL="$file"; break ;;
    conformance/*|src/lib/bindings.ts)
      CRATES+=(agaric) ;;
    src-tauri/*)
      crate_of "$file"
      CRATES+=("$CRATE") ;;
  esac
done

if [ ${#NOT_COVERED[@]} -gt 0 ]; then
  {
    echo "Not covered by nextest (src-tauri/fuzz is its own workspace, src-tauri/gen is Android):"
    printf '    ! %s\n' "${NOT_COVERED[@]}"
  } >&2
fi

cd "$REPO_ROOT/src-tauri"

if [ -n "$FULL" ]; then
  echo "$FULL changed in the $LABEL set — running the full workspace suite"
  if [ "$DRY" = "1" ]; then
    echo "  → cargo nextest run --workspace"
    exit 0
  fi
  exec "$CARGO_BIN" nextest run --workspace
fi

if [ ${#CRATES[@]} -eq 0 ]; then
  echo "No Rust test inputs in the $LABEL set — skipping cargo nextest"
  exit 0
fi

readarray -t CRATES < <(printf '%s\n' "${CRATES[@]}" | sort -u)
EXPR=""
for crate in "${CRATES[@]}"; do
  EXPR="${EXPR:+$EXPR + }rdeps(=$crate)"
  extra=$(source_readers "$crate")
  EXPR="$EXPR${extra:+ + $extra}"
done

echo "Changed crates in the $LABEL set: ${CRATES[*]}"
if [ "$DRY" = "1" ]; then
  echo "  → cargo nextest run --workspace --no-tests=pass -E '$EXPR'"
  exit 0
fi
# --workspace (#3212, #3443): the bare form covers the `agaric` package only.
exec "$CARGO_BIN" nextest run --workspace --no-tests=pass -E "$EXPR"
