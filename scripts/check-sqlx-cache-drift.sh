#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# sqlx offline-cache drift guard (#3901).
#
# `cargo sqlx prepare` deletes any cache entry it does not OBSERVE in
# that run — and what it observes is whatever happened to recompile.
# The bare `cargo sqlx prepare --workspace` run from `src-tauri/` (or
# any partial/warm-tree `cargo sqlx prepare`) only sees its own
# scope, so every entry belonging to a query it didn't recompile looks
# orphaned and gets pruned — 83, then 260, then 273 entries in the
# three documented incidents. Everything still compiles locally (the
# DB is present, so online mode papers over it); only CI's offline
# lane notices, minutes later, in a different crate's cache than the
# one that was touched.
#
# This hook can't run `cargo sqlx prepare` itself (needs a live DB and
# a full recompile — too slow for a commit hook, and #3901 shows a
# *partial* recompile is exactly the trap). Instead it inspects the
# DIFF, per jfolcini's suggested phrasing (#3901 comment): a `.sqlx`
# entry that disappears from one cache while an IDENTICAL filename
# (content-addressed by query hash, so identical name = identical
# query) still exists in a sibling `.sqlx` cache is the signature of a
# partial/wrong-scope prepare — the caches now disagree about whether
# the query exists. An entry that disappears from EVERY cache at once
# is the signature of a real, fully-propagated cleanup (the correct
# `just gen-sqlx` shape, or a deliberate `.sqlx` prune like #3910's —
# see that issue for why the guard must tolerate this shape). The
# escape valve for a genuinely-partial-but-intentional cleanup is the
# same diff removing AT LEAST AS MANY `query!`/`query_as!`/`query_scalar!`/
# `query_file!`/`query_file_as!`/`query_file_scalar!` call sites as there
# are suspicious entries — a count bound, not a per-entry correlation (see
# the comment at the count comparison below for why: correlating a
# specific removal to a specific entry would require reproducing sqlx's
# content hash, which is not plain sha256(sql-text)).
#
# Known scope limits (both DIFF-check limitations, not cross-cache
# audits):
#   1. An entry ALREADY stale in a cache untouched by the current commit
#      (not part of the diff at all) is invisible to it — same limitation
#      `check-migrations-immutable.sh` accepts for the same reason
#      (rescanning the whole tree on every commit regardless of relevance
#      would be a different, heavier check).
#   2. An entry that exists in ONLY ONE cache to begin with (no sibling
#      copy — true of most root-cache entries that are private to the
#      `agaric` crate, since root/.sqlx is a union cache but most queries
#      aren't shared) has no sibling to compare against. If it is
#      spuriously pruned by a partial/wrong-scope prepare while its
#      source `query!` call site is untouched, this check cannot tell
#      that apart from a genuine full retirement — both look like "gone
#      from every cache that ever had it." This is the SAME failure mode
#      #3901 exists to catch, just outside this check's blind spot;
#      `cargo sqlx prepare --check` in CI (Phase E) is still the backstop
#      of record for this shape.
#
# Modes (mirrors check-migrations-immutable.sh's #806 shape):
#   (default)        — pre-commit: inspect the staged index
#                      (`git diff --cached --name-status`).
#   --range REVSPEC  — pre-push / CI backstop: inspect a commit range.
#                      Pass a THREE-DOT revspec (`base...HEAD`) so a
#                      cache pruned on `base` after this branch was cut
#                      doesn't read as this branch's doing.
#   --self-test      — run the fixture suite below and exit.
#
# Usage: scripts/check-sqlx-cache-drift.sh [--range REVSPEC | --self-test]
# Exit:  0 = clean, 1 = suspicious cross-cache drift found, 2 = usage error.
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

# The four committed `.sqlx/` caches (AGENTS.md invariant #6 / #2621
# layered-workspace split). Hardcoded to match every sibling guard that
# enumerates these same four crate roots (check-raw-tx.py,
# check-dynamic-sql.py, check-table-ownership.py).
SQLX_DIRS=(
  "src-tauri/.sqlx"
  "src-tauri/agaric-store/.sqlx"
  "src-tauri/agaric-engine/.sqlx"
  "src-tauri/agaric-sync/.sqlx"
)

QUERY_MACRO_RE='\b(query|query_as|query_scalar|query_file|query_file_as|query_file_scalar)!\s*\('

RANGE=""
SELF_TEST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --range)
      RANGE="${2:-}"
      shift 2 || true
      [ -z "$RANGE" ] && { echo "ERROR: --range requires a revspec" >&2; exit 2; }
      ;;
    --self-test)
      SELF_TEST=1
      shift
      ;;
    *)
      echo "ERROR: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# ── Self-test ──────────────────────────────────────────────────────
# Builds a throwaway repo and asserts the guard's verdict on each
# shape: fully-retired cleanup (pass), partial cross-cache drift with
# no justification (fail), the same drift with a query! removal in the
# diff (pass, the escape valve), the escape valve's COUNT BOUND under
# two simultaneous suspicious entries with only one justified (fail) vs
# both justified (pass), a pure addition (pass), and both the staged and
# --range code paths. Fixture uses fake `.rs`/`.json` content only — no
# real sqlx/DB involved.
if [ "$SELF_TEST" -eq 1 ]; then
  SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  fails=0

  assert() { # <label> <expected-exit> <actual-exit>
    if [ "$2" -eq "$3" ]; then
      echo "  ✓ $1"
    else
      echo "  ✗ $1 (expected exit $2, got $3)" >&2
      fails=$((fails + 1))
    fi
  }

  # The fixture must not inherit the caller's git context (#3722): when
  # this runs from a git hook, GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE
  # point at the REAL repository — `git init` there is a re-init that
  # rewrites core.worktree to $tmp and leaves the real checkout
  # unusable once $tmp is removed. Hooks are disabled too: the fixture
  # inherits core.hooksPath, and prek aborts on a repo with no
  # prek.toml. Mirrors check-migrations-immutable.sh's --self-test.
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
        GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_CONFIG \
        GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_PREFIX GIT_INTERNAL_GETTEXT_SH_SCHEME
  export GIT_CEILING_DIRECTORIES="$tmp"

  cd "$tmp"
  git init -q -b main . >/dev/null
  if [ "$(git rev-parse --show-toplevel)" != "$(cd "$tmp" && pwd -P)" ]; then
    echo "self-test: refusing to run — fixture repo resolved outside \$tmp" >&2
    echo "  (git context leaked in; see the unset block above)" >&2
    exit 1
  fi
  git config core.hooksPath /dev/null
  git config commit.gpgsign false
  git config user.email t@t.t
  git config user.name t

  mkdir -p src-tauri/.sqlx src-tauri/agaric-store/.sqlx \
           src-tauri/agaric-engine/.sqlx src-tauri/agaric-sync/.sqlx \
           src-tauri/agaric-store/src

  # Base commit: OLD.json mirrored into three of the four caches (the
  # shape a union-cache regen produces — root + two member caches, not
  # agaric-sync), plus a fake source file that "produces" it.
  echo '{"query":"SELECT old"}' > src-tauri/.sqlx/query-OLD.json
  echo '{"query":"SELECT old"}' > src-tauri/agaric-store/.sqlx/query-OLD.json
  echo '{"query":"SELECT old"}' > src-tauri/agaric-engine/.sqlx/query-OLD.json
  # A SECOND, independent shared entry (root <-> engine, not store) so
  # cases (3b)/(3c) below can construct TWO simultaneous suspicious
  # entries and test the escape valve's count bound rather than its mere
  # presence/absence.
  echo '{"query":"SELECT old2"}' > src-tauri/.sqlx/query-OLD2.json
  echo '{"query":"SELECT old2"}' > src-tauri/agaric-engine/.sqlx/query-OLD2.json
  cat > src-tauri/agaric-store/src/fake.rs <<'EOF'
pub fn old() {
    let _ = sqlx::query!("SELECT old");
}
pub fn old2() {
    let _ = sqlx::query!("SELECT old2");
}
EOF
  git add -A && git commit -qm base
  base="$(git rev-parse HEAD)"

  # Cases (1)-(4) exercise the DEFAULT (staged-index) mode, so they
  # stage the change and run the guard BEFORE committing — `git diff
  # --cached` is empty right after a commit (nothing staged against
  # the new HEAD), which would make every one of these pass vacuously
  # for the wrong reason instead of exercising the detection logic.

  # (1) Fully-retired: OLD.json removed from ALL THREE caches that had
  # it, staged in one changeset, no .rs change. This is the #3910
  # cleanup shape.
  git checkout -q -b retired "$base"
  git rm -q src-tauri/.sqlx/query-OLD.json \
            src-tauri/agaric-store/.sqlx/query-OLD.json \
            src-tauri/agaric-engine/.sqlx/query-OLD.json
  set +e; bash "$SELF" >/dev/null 2>&1; rc=$?; set -e
  assert "fully-retired deletion (gone from every cache) -> pass" 0 "$rc"
  git commit -qm "retire OLD everywhere"

  # (2) Partial drift: OLD.json removed from root ONLY; still present
  # in agaric-store and agaric-engine. No .rs change. This is the
  # #3901 wrong-scope-prepare shape.
  git checkout -q -b partial "$base"
  git rm -q src-tauri/.sqlx/query-OLD.json
  set +e; bash "$SELF" >/dev/null 2>&1; rc=$?; set -e
  assert "partial deletion, survives in a sibling cache, no query! removed -> fail" 1 "$rc"
  git commit -qm "prune root only"

  # (3) Same partial drift, but the change ALSO removes the query!
  # call site — the escape valve.
  git checkout -q -b partial-justified "$base"
  git rm -q src-tauri/.sqlx/query-OLD.json
  : > src-tauri/agaric-store/src/fake.rs
  git add -A
  set +e; bash "$SELF" >/dev/null 2>&1; rc=$?; set -e
  assert "partial deletion, survives in a sibling cache, WITH query! removed -> pass" 0 "$rc"
  git commit -qm "remove old() and its cache entry"

  # (3b) TWO suspicious entries (OLD survives in agaric-store, OLD2
  # survives in agaric-engine), but only ONE query! call site removed
  # (old(), not old2()). The count-bound escape valve (query_macro_removed
  # >= #suspicious) must still fail this — a single unrelated removal
  # must not exonerate a second, unrelated suspicious deletion. This is
  # the case the pre-tightening diff-wide "any removal at all" valve got
  # wrong.
  git checkout -q -b partial-underjustified "$base"
  git rm -q src-tauri/.sqlx/query-OLD.json src-tauri/.sqlx/query-OLD2.json
  cat > src-tauri/agaric-store/src/fake.rs <<'EOF'
pub fn old2() {
    let _ = sqlx::query!("SELECT old2");
}
EOF
  git add -A
  set +e; bash "$SELF" >/dev/null 2>&1; rc=$?; set -e
  assert "2 suspicious entries, only 1 query! removed -> fail" 1 "$rc"
  git commit -qm "prune root only (under-justified)"

  # (3c) Same two suspicious entries, BOTH call sites removed — the count
  # bound is satisfied (2 removed >= 2 suspicious) and this passes.
  git checkout -q -b partial-fullyjustified "$base"
  git rm -q src-tauri/.sqlx/query-OLD.json src-tauri/.sqlx/query-OLD2.json
  : > src-tauri/agaric-store/src/fake.rs
  git add -A
  set +e; bash "$SELF" >/dev/null 2>&1; rc=$?; set -e
  assert "2 suspicious entries, both query! removed -> pass" 0 "$rc"
  git commit -qm "prune root only (fully justified)"

  # (4) Pure addition: no deletions at all.
  git checkout -q -b addition "$base"
  echo '{"query":"SELECT new"}' > src-tauri/agaric-sync/.sqlx/query-NEW.json
  git add -A
  set +e; bash "$SELF" >/dev/null 2>&1; rc=$?; set -e
  assert "pure addition, nothing deleted -> pass" 0 "$rc"
  git commit -qm "add a new query"

  # (5) --range mode: partial drift across a range, no justification.
  git checkout -q -b range-partial "$base"
  git rm -q src-tauri/.sqlx/query-OLD.json
  git commit -qm "prune root only (range)"
  set +e; bash "$SELF" --range "$base...HEAD" >/dev/null 2>&1; rc=$?; set -e
  assert "--range: partial deletion, no query! removed -> fail" 1 "$rc"

  # (6) --range mode: fully-retired across a range.
  git checkout -q -b range-retired "$base"
  git rm -q src-tauri/.sqlx/query-OLD.json \
            src-tauri/agaric-store/.sqlx/query-OLD.json \
            src-tauri/agaric-engine/.sqlx/query-OLD.json
  git commit -qm "retire OLD everywhere (range)"
  set +e; bash "$SELF" --range "$base...HEAD" >/dev/null 2>&1; rc=$?; set -e
  assert "--range: fully-retired deletion -> pass" 0 "$rc"

  # (7) usage errors.
  set +e; bash "$SELF" --bogus >/dev/null 2>&1; rc=$?; set -e
  assert "unknown arg -> exit 2" 2 "$rc"
  set +e; bash "$SELF" --range >/dev/null 2>&1; rc=$?; set -e
  assert "--range with no revspec -> exit 2" 2 "$rc"

  if [ "$fails" -ne 0 ]; then
    echo "self-test: $fails assertion(s) failed" >&2
    exit 1
  fi
  echo "self-test: all assertions passed"
  exit 0
fi

# ── Main ──────────────────────────────────────────────────────────
pathspecs=()
for d in "${SQLX_DIRS[@]}"; do
  pathspecs+=("$d/*.json")
done

if [ -n "$RANGE" ]; then
  diff_status="$(git diff "$RANGE" --name-status -- "${pathspecs[@]}")"
  rs_diff() { git diff "$RANGE" -- "$@"; }
  scope_label="range $RANGE"
else
  diff_status="$(git diff --cached --name-status -- "${pathspecs[@]}")"
  rs_diff() { git diff --cached -- "$@"; }
  scope_label="staged"
fi

deleted_paths=()
while IFS=$'\t' read -r status p1 _p2; do
  [ -z "$status" ] && continue
  case "$status" in
    D) deleted_paths+=("$p1") ;;
    # R*/C*: git paired a deletion with a similar-content addition —
    # the query survives (possibly renamed/re-hashed), not a loss.
    # A/M/T: never a loss on their own.
    *) : ;;
  esac
done <<<"$diff_status"

if [ "${#deleted_paths[@]}" -eq 0 ]; then
  echo "✓ sqlx cache drift guard: no .sqlx entries deleted ($scope_label)"
  exit 0
fi

suspicious=()
retired=()
for p in "${deleted_paths[@]}"; do
  base_name="$(basename "$p")"
  own_dir="$(dirname "$p")"
  found_elsewhere=0
  for d in "${SQLX_DIRS[@]}"; do
    [ "$d" = "$own_dir" ] && continue
    if [ -f "$d/$base_name" ]; then
      found_elsewhere=1
      break
    fi
  done
  if [ "$found_elsewhere" -eq 1 ]; then
    suspicious+=("$p")
  else
    retired+=("$p")
  fi
done

if [ "${#suspicious[@]}" -eq 0 ]; then
  echo "✓ sqlx cache drift guard: ${#retired[@]} entry(ies) fully retired (absent from every cache) — legitimate cleanup ($scope_label)"
  exit 0
fi

query_macro_removed="$(rs_diff -- '*.rs' | grep -E '^-' | grep -v '^---' | grep -cE "$QUERY_MACRO_RE" || true)"
query_macro_removed="${query_macro_removed:-0}"

# The escape valve is diff-wide, not correlated to which specific entry a
# removed query! site justifies (correlating them precisely would mean
# reconstructing sqlx's content hash in bash, which is NOT plain
# sha256(sql-text) — verified empirically against a real checked-in
# .sqlx entry — so a hand-rolled hash-matcher here would be an unverified,
# possibly-wrong check pretending to be a verified one, worse than the
# coarser bound below). Requiring the COUNT of removed call sites to be at
# least the count of suspicious entries closes the obvious escape-hatch
# abuse (one unrelated query! removal exonerating an unbounded number of
# unrelated suspicious deletions elsewhere in the same diff) without
# claiming a precision this check cannot actually deliver. It can still be
# fooled by removing N unrelated call sites to cover N unrelated
# deletions — that residual is real and is not fixed here.
if [ "$query_macro_removed" -ge "${#suspicious[@]}" ]; then
  echo "✓ sqlx cache drift guard: ${#suspicious[@]} entry(ies) removed from one cache while still present in a sibling cache, but the diff also removes $query_macro_removed query!-macro call site(s) (>= ${#suspicious[@]} suspicious entries) — treated as justified ($scope_label)"
  exit 0
fi

echo "ERROR: sqlx cache drift (#3901) — an entry disappeared from one .sqlx" >&2
echo "cache while an identically-named entry still exists in a sibling cache," >&2
echo "and this diff removes fewer query!/query_as!/query_scalar!/query_file!" >&2
echo "call sites ($query_macro_removed) than suspicious entries (${#suspicious[@]}) to" >&2
echo "justify it. This is the signature of a partial or wrong-scope" >&2
echo "'cargo sqlx prepare' (see #3901) — it only observed part of the" >&2
echo "workspace and pruned entries a sibling cache still needs." >&2
echo "" >&2
echo "Suspicious deletion(s) ($scope_label):" >&2
for p in "${suspicious[@]}"; do
  echo "  D  $p" >&2
done
echo "" >&2
echo "Fix: regenerate ALL FOUR caches together with \`just gen-sqlx\` (never" >&2
echo "the bare \`cargo sqlx prepare\` — see AGENTS.md invariant #6), then" >&2
echo "re-stage. To recover a specific entry from HEAD without a full" >&2
echo "regen:" >&2
echo "  git show HEAD:<path> > <path>" >&2
echo "If this really is a fully-intentional cross-cache cleanup (nothing" >&2
echo "hashes to these entries anywhere — see #3910), delete them from" >&2
echo "EVERY cache that still has them in the SAME commit so none survive." >&2
exit 1
