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
# same diff NET-removing (removed minus added, so a plain code move nets
# to zero) AT LEAST AS MANY `query!`/`query_as!`/`query_scalar!`/
# `query_file!`/`query_file_as!`/`query_file_scalar!` call sites as there
# are suspicious entries — a count bound, not a per-entry correlation (see
# the comment at the count comparison below for why: correlating a
# specific removal to a specific entry would require reproducing sqlx's
# content hash, which is not plain sha256(sql-text)).
#
# This is a DELETION-drift check, not a cache-freshness or liveness audit:
# it fires only on entries that appear as deleted somewhere in the diff it
# inspects, and says nothing about an entry that is stale (nothing hashes
# to it) but was never deleted from ANY cache in the commit(s) under
# inspection — see scope limit 3 below, and PR #3945 review note 6.
#
# Known scope limits (all DIFF-check limitations, not cross-cache audits):
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
#      #3901 exists to catch, just outside this check's blind spot; the
#      per-PR CI net for this shape is `.github/actions/sqlx-offline-check`'s
#      `cargo sqlx prepare --check` lanes in `_validate.yml`'s `lint` job
#      (one per crate, run on every PR via `ci.yml`) — see prek.toml's
#      hook comment for the full picture, including the LOCAL-only
#      `--range` backstop and the separate scheduled
#      `cargo sqlx prepare --check` in `scheduled-deep-checks.yml`.
#   3. An entry that is stale in EVERY cache (nothing hashes to it
#      anywhere) but was never deleted from any of them — #3910's actual
#      shape before its manual cleanup — produces NO deletion in the diff
#      at all, so this check has nothing to inspect and stays silent. It
#      does not enforce that the four caches move in lockstep on
#      additions/staleness, only that a DELETION which does appear
#      doesn't disagree with a sibling.
#
# Modes (mirrors check-migrations-immutable.sh's #806 shape):
#   (default)        — pre-commit: inspect the staged index
#                      (`git diff --cached --name-status`).
#   --range REVSPEC  — pre-push / CI backstop: inspect a commit range.
#                      Pass a THREE-DOT revspec (`base...HEAD`) so a
#                      cache pruned on `base` after this branch was cut
#                      doesn't read as this branch's doing.
#
# Usage: scripts/check-sqlx-cache-drift.sh [--range REVSPEC]
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
while [ $# -gt 0 ]; do
  case "$1" in
    --range)
      RANGE="${2:-}"
      shift 2 || true
      [ -z "$RANGE" ] && { echo "ERROR: --range requires a revspec" >&2; exit 2; }
      ;;
    *)
      echo "ERROR: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# ── Main ──────────────────────────────────────────────────────────
# The four SQLX_DIRS entries, the pathspecs built from them, and the
# `[ -f ... ]`-turned-`sibling_exists` probe are all repo-root-relative.
# Without this `cd`, invoking the script from any other CWD (most
# plausibly `src-tauri/` — the very directory this header's own opening
# paragraph names as where people wrongly run a bare `cargo sqlx
# prepare`) makes every pathspec resolve to a nonexistent nested path
# (`src-tauri/src-tauri/.sqlx/*.json`), matches nothing, and the guard
# prints "no .sqlx entries deleted" over real staged drift. prek and
# `verify-ci-equivalent.sh` both invoke this from the repo root already,
# so this only matters for manual/direct invocation — see PR #3945
# review note 4 (and `check-migrations-immutable.sh`, which shares the
# same gap).
cd "$(git rev-parse --show-toplevel)"

pathspecs=()
for d in "${SQLX_DIRS[@]}"; do
  pathspecs+=("$d/*.json")
done

if [ -n "$RANGE" ]; then
  # --no-renames: a query-text change re-hashes the filename (old name
  # deleted, new name added), and the two JSONs share an identical
  # `describe` block far above git's default 50% similarity threshold —
  # so without this flag git pairs them as `R`, not `D`+`A`, and the
  # re-hash never reaches `deleted_paths` at all (the #3894->#3910 shape).
  diff_status="$(git diff --no-renames "$RANGE" --name-status -- "${pathspecs[@]}")"
  rs_diff() { git diff "$RANGE" -- "$@"; }
  scope_label="range $RANGE"
  # Sibling survival must be probed against the same post-state the
  # deletion list came from — the range's endpoint (documented as the
  # THREE-DOT revspec's right-hand side) — not the working tree: an
  # uncommitted local `rm` of a sibling copy (verify-ci-equivalent.sh
  # never requires a clean worktree) is invisible to this range and must
  # not flip a genuinely suspicious committed deletion to retired.
  range_endpoint="${RANGE##*...}"
  sibling_exists() { git cat-file -e "$range_endpoint:$1" 2>/dev/null; }
else
  diff_status="$(git diff --no-renames --cached --name-status -- "${pathspecs[@]}")"
  rs_diff() { git diff --cached -- "$@"; }
  scope_label="staged"
  # Same reasoning, staged-index direction: the INDEX is what actually
  # commits, so a sibling still tracked there (even if a full-tree
  # `just gen-sqlx` already removed it from disk and only ONE cache's
  # deletion got staged) is still a real sibling, not a retired entry.
  sibling_exists() { git cat-file -e ":$1" 2>/dev/null; }
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
    if sibling_exists "$d/$base_name"; then
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
# Netted against ADDED call sites (PR #3945 review note 3): a plain code
# move that relocates a query! call site from one file to another
# contributes one matching `-` line AND one matching `+` line — net call
# sites removed is zero, no bypass intent needed — but counting only the
# `-` side satisfied the bound and exonerated an unrelated suspicious
# deletion elsewhere in the same diff. `+++`/diff-header lines are
# excluded the same way `---` is excluded from the `-` side.
query_macro_added="$(rs_diff -- '*.rs' | grep -E '^\+' | grep -v '^+++' | grep -cE "$QUERY_MACRO_RE" || true)"
query_macro_added="${query_macro_added:-0}"
query_macro_net_removed=$(( query_macro_removed - query_macro_added ))
[ "$query_macro_net_removed" -lt 0 ] && query_macro_net_removed=0

# The escape valve is diff-wide, not correlated to which specific entry a
# removed query! site justifies (correlating them precisely would mean
# reconstructing sqlx's content hash in bash, which is NOT plain
# sha256(sql-text) — verified empirically against a real checked-in
# .sqlx entry — so a hand-rolled hash-matcher here would be an unverified,
# possibly-wrong check pretending to be a verified one, worse than the
# coarser bound below). Requiring the NET COUNT of removed call sites
# (removed minus added, floored at zero — see above) to be at least the
# count of suspicious entries closes the obvious escape-hatch abuse (one
# unrelated query! removal exonerating an unbounded number of unrelated
# suspicious deletions elsewhere in the same diff) without claiming a
# precision this check cannot actually deliver. It can still be fooled by
# removing N unrelated call sites (net, not just relocating them) to
# cover N unrelated deletions — that residual is real, deliberate, and is
# not fixed here.
if [ "$query_macro_net_removed" -ge "${#suspicious[@]}" ]; then
  echo "✓ sqlx cache drift guard: ${#suspicious[@]} entry(ies) removed from one cache while still present in a sibling cache, but the diff also net-removes $query_macro_net_removed query!-macro call site(s) (>= ${#suspicious[@]} suspicious entries) — treated as justified ($scope_label)"
  exit 0
fi

echo "ERROR: sqlx cache drift (#3901) — an entry disappeared from one .sqlx" >&2
echo "cache while an identically-named entry still exists in a sibling cache," >&2
echo "and this diff net-removes fewer query!/query_as!/query_scalar!/query_file!" >&2
echo "call sites ($query_macro_net_removed) than suspicious entries (${#suspicious[@]}) to" >&2
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
