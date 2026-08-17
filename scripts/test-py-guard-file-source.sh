#!/usr/bin/env bash
# Falsification suite for the #4017 sweep of the three PYTHON guards —
# check-raw-tx.py, check-dynamic-sql.py, check-command-arity.py.
#
# ─── Why this is a shell script and not a Python self-test ────────────────
#
# It builds git fixtures, and there is no Python sibling of
# `scripts/lib/git-scratch-guard.sh` to build them safely through. Writing
# one just to host these tests would be a fourth copy of the scrubber by a
# different route — the exact thing #3722's shared helper and
# `scripts/check-git-fixture-isolation.mjs` exist to prevent, and that
# meta-guard now flags a `.py` fixture-builder for precisely this reason
# (#4015). So the fixtures are built here, in the language that already has
# the shared scrub, and the guards are driven as SUBPROCESSES — which is
# also the only way to observe the thing under test, an exit code.
#
# ─── What is under test ───────────────────────────────────────────────────
#
# Each guard took prek's changed-file list and `open()`ed those paths from
# disk, so its verdict described the WORKING TREE while `git commit` was
# about to write the INDEX. Both directions are real:
#
#   * FALSE GREEN — the violation is staged and the author has already
#     fixed it on disk without `git add`. The guard reads the fixed copy,
#     exits 0, and the broken content is committed. THIS is the case each
#     guard below plants: a staged violation behind a clean working tree.
#   * FALSE RED  — the fix is staged and the working tree still carries the
#     violation. The commit is blocked over a file already fixed.
#
# Every assertion is a PAIR — the source that must go red and the source
# that must stay green on the SAME fixture — plus a clean baseline. A
# one-sided "the fixed guard fails" would pass just as well against a guard
# that fails on everything, and a suite that only ever ran the clean case
# would prove nothing at all.
#
# Usage: bash scripts/test-py-guard-file-source.sh
# Exit:  0 all assertions passed / 1 at least one failed.

set -uo pipefail

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=scripts/lib/git-scratch-guard.sh
. "$SCRIPTS_DIR/lib/git-scratch-guard.sh"

failures=0
_ok() { printf '  ok   - %s\n' "$1"; }
_bad() {
  failures=$((failures + 1))
  printf '  FAIL - %s: %s\n' "$1" "$2" >&2
}

# Run a guard inside a fixture and report its exit code. `env -u` is belt and
# braces on top of `git_scratch_guard`: these guards RESOLVE THEIR SOURCE
# from `GIT_INDEX_FILE`, so a leaked one would silently turn every "auto"
# assertion below into an index read and the suite would pass without ever
# testing the default.
_run() {
  local dir="$1"
  shift
  (
    cd "$dir" || exit 99
    env -u GIT_INDEX_FILE python3 "$@" >/dev/null 2>&1
  )
  printf '%s\n' "$?"
}

# …and the same, with the RELATIVE `.git/index` a real `git commit` exports
# (measured on git 2.43 / prek 0.3.8). It resolves against the hook's cwd,
# which git fixes at the work-tree toplevel — here, the fixture. Nothing in
# this file ever points GIT_INDEX_FILE outside the fixture it belongs to.
_run_auto_commit() {
  local dir="$1"
  shift
  (
    cd "$dir" || exit 99
    GIT_INDEX_FILE=.git/index python3 "$@" >/dev/null 2>&1
  )
  printf '%s\n' "$?"
}

_eq() { if [ "$2" = "$3" ]; then _ok "$1"; else _bad "$1" "expected [$2], got [$3]"; fi; }

# Put the guards INSIDE the fixture, and drive that copy.
#
# A guard judges the tree that contains it (scripts/lib/guard_file_source.py,
# "Which TREE is judged"), so a fixture is driven by seeding it — the same
# thing `mr_seed_guards` does in pr-merge-result-check.sh, for the same
# reason. The earlier shape here — run the REAL scripts/ copy with `cd
# $fixture` — only worked while the guards derived their root from the cwd,
# and that derivation is exactly what broke pr-merge-result-check by making a
# guard invoked from elsewhere reject every target and exit 0.
#
# check-raw-tx.py comes along unconditionally: the other two `importlib` it
# for the comment stripper, from THEIR OWN directory.
_seed_guards() {
  local dir="$1"
  mkdir -p "$dir/scripts/lib"
  cp "$SCRIPTS_DIR/check-raw-tx.py" "$SCRIPTS_DIR/check-dynamic-sql.py" \
    "$SCRIPTS_DIR/check-command-arity.py" "$dir/scripts/"
  cp "$SCRIPTS_DIR/lib/guard_file_source.py" "$dir/scripts/lib/"
}

# `git_scratch_init` + seed, since every fixture below needs both.
_new_fixture() {
  local dir="$1"
  git_scratch_init "$dir"
  _seed_guards "$dir"
}

tmp="$(mktemp -d -t py-guard-file-source.XXXXXX)"
# shellcheck disable=SC2064 # expand $tmp now, not at trap time
trap "rm -rf '$tmp'" EXIT
git_scratch_guard "$tmp"

# ---------------------------------------------------------------------------
# 1. check-raw-tx.py — a raw write transaction (#110)
# ---------------------------------------------------------------------------
GUARD_RAW_TX="scripts/check-raw-tx.py"
RAW_TX_FILE="src-tauri/src/thing_4017.rs"
RAW_TX_BAD='fn f() {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
}'
RAW_TX_GOOD='fn f() {
    let n = 1;
}'

fx="$tmp/raw-tx-clean"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf '%s\n' "$RAW_TX_GOOD" > "$fx/$RAW_TX_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
_eq 'raw-tx baseline: a clean fixture is green under --worktree' \
  '0' "$(_run "$fx" "$GUARD_RAW_TX" --worktree "$RAW_TX_FILE")"
_eq 'raw-tx baseline: a clean fixture is green under --cached' \
  '0' "$(_run "$fx" "$GUARD_RAW_TX" --cached "$RAW_TX_FILE")"

# THE DEFECT: violation STAGED, working tree clean.
fx="$tmp/raw-tx-false-green"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf '%s\n' "$RAW_TX_GOOD" > "$fx/$RAW_TX_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
printf '%s\n' "$RAW_TX_BAD" > "$fx/$RAW_TX_FILE"
git -C "$fx" add -A                             # the breakage is now STAGED
printf '%s\n' "$RAW_TX_GOOD" > "$fx/$RAW_TX_FILE" # …the working tree is clean again
_eq 'raw-tx false green: reading the WORKING TREE passes a staged violation (the defect)' \
  '0' "$(_run "$fx" "$GUARD_RAW_TX" --worktree "$RAW_TX_FILE")"
_eq 'raw-tx false green: reading the INDEX fails it (the fix)' \
  '1' "$(_run "$fx" "$GUARD_RAW_TX" --cached "$RAW_TX_FILE")"
_eq 'raw-tx AUTO reads the index when git exports GIT_INDEX_FILE (a real commit)' \
  '1' "$(_run_auto_commit "$fx" "$GUARD_RAW_TX" "$RAW_TX_FILE")"
_eq 'raw-tx AUTO reads the working tree when no commit is in flight' \
  '0' "$(_run "$fx" "$GUARD_RAW_TX" "$RAW_TX_FILE")"

# FALSE RED: the FIX is staged, the working tree reintroduces the violation.
fx="$tmp/raw-tx-false-red"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf '%s\n' "$RAW_TX_BAD" > "$fx/$RAW_TX_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
printf '%s\n' "$RAW_TX_GOOD" > "$fx/$RAW_TX_FILE"
git -C "$fx" add -A                            # the fix is STAGED
printf '%s\n' "$RAW_TX_BAD" > "$fx/$RAW_TX_FILE" # …the working tree is dirty again
_eq 'raw-tx false red: the WORKING TREE blocks a commit that is already fixed (the defect)' \
  '1' "$(_run "$fx" "$GUARD_RAW_TX" --worktree "$RAW_TX_FILE")"
_eq 'raw-tx false red: the INDEX passes it (the fix)' \
  '0' "$(_run "$fx" "$GUARD_RAW_TX" --cached "$RAW_TX_FILE")"

# STAGED DELETION — prek omits deletions from its file list, so pin what
# happens when the path IS handed over anyway: `git rm --cached` leaves a
# violating file on disk that is NOT in the commit. The working-tree reader
# blocks the commit that removes it; the index reader passes.
fx="$tmp/raw-tx-staged-deletion"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf '%s\n' "$RAW_TX_BAD" > "$fx/$RAW_TX_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
git -C "$fx" rm -q --cached "$RAW_TX_FILE"
_eq 'raw-tx staged deletion: the WORKING TREE reader judges a file leaving the commit (the defect)' \
  '1' "$(_run "$fx" "$GUARD_RAW_TX" --worktree "$RAW_TX_FILE")"
_eq 'raw-tx staged deletion: the INDEX reader passes — the path is not being committed' \
  '0' "$(_run "$fx" "$GUARD_RAW_TX" --cached "$RAW_TX_FILE")"

# STAGED BUT ABSENT FROM DISK — `git add`ed, then deleted from the working
# tree. `p.is_file()` skipped it: a silent pass on a file that IS committed.
fx="$tmp/raw-tx-staged-absent"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf '%s\n' "$RAW_TX_GOOD" > "$fx/$RAW_TX_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
printf '%s\n' "$RAW_TX_BAD" > "$fx/$RAW_TX_FILE"
git -C "$fx" add -A
rm "$fx/$RAW_TX_FILE"
_eq 'raw-tx staged-but-absent: the WORKING TREE reader silently skips it (the defect)' \
  '0' "$(_run "$fx" "$GUARD_RAW_TX" --worktree "$RAW_TX_FILE")"
_eq 'raw-tx staged-but-absent: the INDEX reader judges it' \
  '1' "$(_run "$fx" "$GUARD_RAW_TX" --cached "$RAW_TX_FILE")"

# A misspelled source flag must be an exit-2 invocation error, not a silent
# AUTO that judges a copy the caller did not ask for. Run against the
# false-green fixture, so a guard that swallowed it would exit 0 with the
# staged violation unseen — against a clean fixture this would be satisfied
# by "nothing to find".
_eq 'raw-tx: a misspelled --cache is an exit-2 invocation error, not a silent AUTO' \
  '2' "$(_run "$tmp/raw-tx-false-green" "$GUARD_RAW_TX" --cache "$RAW_TX_FILE")"

# ---------------------------------------------------------------------------
# 2. check-command-arity.py — the tauri-specta 10-argument ceiling (#1317)
# ---------------------------------------------------------------------------
GUARD_ARITY="scripts/check-command-arity.py"
ARITY_FILE="src-tauri/src/commands/thing_4017.rs"
ARITY_BAD='#[tauri::command]
pub async fn too_many(a: u8, b: u8, c: u8, d: u8, e: u8, f: u8, g: u8, h: u8, i: u8, j: u8, k: u8) -> u8 { 0 }'
ARITY_GOOD='#[tauri::command]
pub async fn fine(a: u8, b: u8) -> u8 { 0 }'

fx="$tmp/arity-clean"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src/commands"
printf '%s\n' "$ARITY_GOOD" > "$fx/$ARITY_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
_eq 'arity baseline: a clean fixture is green under --worktree' \
  '0' "$(_run "$fx" "$GUARD_ARITY" --worktree "$ARITY_FILE")"
_eq 'arity baseline: a clean fixture is green under --cached' \
  '0' "$(_run "$fx" "$GUARD_ARITY" --cached "$ARITY_FILE")"

fx="$tmp/arity-false-green"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src/commands"
printf '%s\n' "$ARITY_GOOD" > "$fx/$ARITY_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
printf '%s\n' "$ARITY_BAD" > "$fx/$ARITY_FILE"
git -C "$fx" add -A
printf '%s\n' "$ARITY_GOOD" > "$fx/$ARITY_FILE"
_eq 'arity false green: reading the WORKING TREE passes a staged 11-arg command (the defect)' \
  '0' "$(_run "$fx" "$GUARD_ARITY" --worktree "$ARITY_FILE")"
_eq 'arity false green: reading the INDEX fails it (the fix)' \
  '1' "$(_run "$fx" "$GUARD_ARITY" --cached "$ARITY_FILE")"
_eq 'arity AUTO reads the index when git exports GIT_INDEX_FILE (a real commit)' \
  '1' "$(_run_auto_commit "$fx" "$GUARD_ARITY" "$ARITY_FILE")"
_eq 'arity AUTO reads the working tree when no commit is in flight' \
  '0' "$(_run "$fx" "$GUARD_ARITY" "$ARITY_FILE")"

fx="$tmp/arity-false-red"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src/commands"
printf '%s\n' "$ARITY_BAD" > "$fx/$ARITY_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
printf '%s\n' "$ARITY_GOOD" > "$fx/$ARITY_FILE"
git -C "$fx" add -A
printf '%s\n' "$ARITY_BAD" > "$fx/$ARITY_FILE"
_eq 'arity false red: the WORKING TREE blocks a commit that is already fixed (the defect)' \
  '1' "$(_run "$fx" "$GUARD_ARITY" --worktree "$ARITY_FILE")"
_eq 'arity false red: the INDEX passes it (the fix)' \
  '0' "$(_run "$fx" "$GUARD_ARITY" --cached "$ARITY_FILE")"

# ---------------------------------------------------------------------------
# 3. check-dynamic-sql.py — the #646 ratchet
# ---------------------------------------------------------------------------
# This one has a second surface its siblings do not: the BASELINE file, and
# the orphan sweep that reclaims entries whose file has gone. Both are read
# from the judged source too, so a staged re-anchor is judged against the
# staged baseline and a staged DELETION is seen as the deletion it is.
GUARD_DYN="scripts/check-dynamic-sql.py"
DYN_FILE="src-tauri/src/thing_4017.rs"
DYN_BAD='async fn f() {
    let rows = sqlx::query("SELECT 1").fetch_all(&pool).await?;
}'
DYN_GOOD='async fn f() {
    let rows = sqlx::query!("SELECT 1").fetch_all(&pool).await?;
}'

fx="$tmp/dyn-clean"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf '%s\n' "$DYN_GOOD" > "$fx/$DYN_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
_eq 'dynamic-sql baseline: a clean fixture is green under --worktree' \
  '0' "$(_run "$fx" "$GUARD_DYN" --worktree "$DYN_FILE")"
_eq 'dynamic-sql baseline: a clean fixture is green under --cached' \
  '0' "$(_run "$fx" "$GUARD_DYN" --cached "$DYN_FILE")"

fx="$tmp/dyn-false-green"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf '%s\n' "$DYN_GOOD" > "$fx/$DYN_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
printf '%s\n' "$DYN_BAD" > "$fx/$DYN_FILE"
git -C "$fx" add -A
printf '%s\n' "$DYN_GOOD" > "$fx/$DYN_FILE"
_eq 'dynamic-sql false green: the WORKING TREE passes a staged unjustified site (the defect)' \
  '0' "$(_run "$fx" "$GUARD_DYN" --worktree "$DYN_FILE")"
_eq 'dynamic-sql false green: the INDEX fails it (the fix)' \
  '1' "$(_run "$fx" "$GUARD_DYN" --cached "$DYN_FILE")"
_eq 'dynamic-sql AUTO reads the index when git exports GIT_INDEX_FILE (a real commit)' \
  '1' "$(_run_auto_commit "$fx" "$GUARD_DYN" "$DYN_FILE")"
_eq 'dynamic-sql AUTO reads the working tree when no commit is in flight' \
  '0' "$(_run "$fx" "$GUARD_DYN" "$DYN_FILE")"

fx="$tmp/dyn-false-red"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf '%s\n' "$DYN_BAD" > "$fx/$DYN_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
printf '%s\n' "$DYN_GOOD" > "$fx/$DYN_FILE"
git -C "$fx" add -A
printf '%s\n' "$DYN_BAD" > "$fx/$DYN_FILE"
_eq 'dynamic-sql false red: the WORKING TREE blocks an already-fixed commit (the defect)' \
  '1' "$(_run "$fx" "$GUARD_DYN" --worktree "$DYN_FILE")"
_eq 'dynamic-sql false red: the INDEX passes it (the fix)' \
  '0' "$(_run "$fx" "$GUARD_DYN" --cached "$DYN_FILE")"

# THE BASELINE, staged. The site is unjustified and the ONLY thing that can
# make it legal is a baseline entry recording it. Staging that entry while
# the on-disk baseline still says 0 is a commit that is correct and that the
# working-tree reader rejects.
fx="$tmp/dyn-staged-baseline"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf '%s\n' "$DYN_BAD" > "$fx/$DYN_FILE"
printf '# Format: <count> <path-relative-to-repo-root>\n0 %s\n' "$DYN_FILE" \
  > "$fx/src-tauri/dynamic-sql-baseline.txt"
git -C "$fx" add -A
git -C "$fx" commit -qm base
printf '# Format: <count> <path-relative-to-repo-root>\n1 %s\n' "$DYN_FILE" \
  > "$fx/src-tauri/dynamic-sql-baseline.txt"
git -C "$fx" add -A                                        # the re-anchor is STAGED
printf '# Format: <count> <path-relative-to-repo-root>\n0 %s\n' "$DYN_FILE" \
  > "$fx/src-tauri/dynamic-sql-baseline.txt"               # …disk still says 0
_eq 'dynamic-sql staged baseline: the WORKING TREE reads the stale ceiling and reddens (the defect)' \
  '1' "$(_run "$fx" "$GUARD_DYN" --worktree "$DYN_FILE")"
_eq 'dynamic-sql staged baseline: the INDEX reads the ceiling being committed (the fix)' \
  '0' "$(_run "$fx" "$GUARD_DYN" --cached "$DYN_FILE")"

# THE STAGED DELETION the issue asks to be pinned. prek's file list omits
# deletions, which is why the orphan sweep is GLOBAL over the baseline rather
# than over that list. `git rm --cached` removes the file from the commit
# while leaving it on disk: `Path.is_file()` said "still there" and the
# baseline entry that should have been reclaimed survived.
fx="$tmp/dyn-staged-deletion"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf '%s\n' "$DYN_BAD" > "$fx/$DYN_FILE"
printf '# Format: <count> <path-relative-to-repo-root>\n1 %s\n' "$DYN_FILE" \
  > "$fx/src-tauri/dynamic-sql-baseline.txt"
git -C "$fx" add -A
git -C "$fx" commit -qm base
_eq 'dynamic-sql staged deletion: the baselined fixture is green before the deletion' \
  '0' "$(_run "$fx" "$GUARD_DYN" --cached "$DYN_FILE")"
git -C "$fx" rm -q --cached "$DYN_FILE"
_eq 'dynamic-sql staged deletion: the WORKING TREE misses the orphaned entry (the defect)' \
  '0' "$(_run "$fx" "$GUARD_DYN" --worktree "$DYN_FILE")"
_eq 'dynamic-sql staged deletion: the INDEX reclaims it — prek never passes the deleted path' \
  '1' "$(_run "$fx" "$GUARD_DYN" --cached "$DYN_FILE")"

# ---------------------------------------------------------------------------
# 4. AN INDEX THAT CANNOT BE READ (all three)
# ---------------------------------------------------------------------------
# Found while wiring #4017, and the reason this section exists rather than a
# comment: the first draft swallowed a non-zero `git ls-files` into an EMPTY
# index. An empty index answers "absent" for every path, so each guard
# skipped the whole file list and exited 0 — a guard reporting clean over a
# tree it never read, which is the exact failure the sweep is about, arriving
# through the enumerator instead of through the reader. Measured before the
# fix: exit 0 with empty stderr against a fixture whose violation was staged.
#
# The unreadable index is spelled INSIDE the fixture (`.git` is a directory
# there, so `.git/index/nope` cannot be opened). Nothing here points
# GIT_INDEX_FILE at anything outside the fixture it belongs to.
_run_broken_index() {
  local dir="$1"
  shift
  (
    cd "$dir" || exit 99
    GIT_INDEX_FILE=.git/index/nope python3 "$@" >/dev/null 2>&1
  )
  printf '%s\n' "$?"
}
_eq 'raw-tx: an unreadable index is exit 2, NOT a clean exit 0 over an unread tree' \
  '2' "$(_run_broken_index "$tmp/raw-tx-false-green" "$GUARD_RAW_TX" "$RAW_TX_FILE")"
_eq 'arity: an unreadable index is exit 2, NOT a clean exit 0 over an unread tree' \
  '2' "$(_run_broken_index "$tmp/arity-false-green" "$GUARD_ARITY" "$ARITY_FILE")"
_eq 'dynamic-sql: an unreadable index is exit 2, NOT a clean exit 0 over an unread tree' \
  '2' "$(_run_broken_index "$tmp/dyn-false-green" "$GUARD_DYN" "$DYN_FILE")"

# ---------------------------------------------------------------------------
# 5. THE MERGE-RESULT CASE (the pr-merge-result-check contract)
# ---------------------------------------------------------------------------
# `scripts/pr-merge-result-check.sh` runs each ratchet guard out of a MERGED
# WORKTREE's own `scripts/`, against that worktree's files, from a cwd that is
# a different repository — and under prek, with a commit in flight in that
# other repository. Both halves of #4017's design are load-bearing there, and
# both were broken by it once already:
#
#   * WHICH TREE — deriving the root from cwd made the guard reject every
#     target as "outside the repository" and exit 0 over a real violation.
#     22 assertions in pr-merge-result-check's own self-test caught it; this
#     section catches it one layer down, where the cause is legible.
#   * WHICH COPY — AUTO keyed on `GIT_INDEX_FILE` being SET, so a commit in
#     the OTHER repository would have made the guard enumerate that
#     repository and report the result as a verdict about the merge.
#
# `other` stands in for the committing repository. It is a scratch fixture
# like every other one here; nothing in this file ever points GIT_INDEX_FILE
# at anything outside "$tmp".
other="$tmp/other-repo"
_new_fixture "$other"
printf 'x\n' > "$other/seed.txt"
git -C "$other" add -A
git -C "$other" commit -qm base

# The tree under judgement carries a REAL, unbaselined violation, so "exit 0"
# below can only mean the guard failed to look — never "there was nothing to
# find".
fx="$tmp/merge-result"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf '%s\n' "$RAW_TX_BAD" > "$fx/$RAW_TX_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base

# Run the FIXTURE's guard against the FIXTURE's files, from somewhere else
# entirely — pr-merge-result-check's exact invocation shape.
_run_from_elsewhere() {
  local cwd="$1" dir="$2"
  shift 2
  (
    cd "$cwd" || exit 99
    env -u GIT_INDEX_FILE python3 "$dir/$GUARD_RAW_TX" "$@" >/dev/null 2>&1
  )
  printf '%s\n' "$?"
}
_eq 'merge-result: a guard run from ANOTHER repo still judges the tree that contains it' \
  '1' "$(_run_from_elsewhere "$other" "$fx" --worktree "$fx/$RAW_TX_FILE")"
_eq 'merge-result: …and with no flag at all, since no commit is in flight' \
  '1' "$(_run_from_elsewhere "$other" "$fx" "$fx/$RAW_TX_FILE")"

# A commit in flight in the OTHER repository. AUTO must not read that index:
# it describes content that has nothing to do with the tree being judged.
_run_foreign_commit() {
  local cwd="$1" dir="$2"
  shift 2
  (
    cd "$cwd" || exit 99
    GIT_INDEX_FILE="$other/.git/index" python3 "$dir/$GUARD_RAW_TX" "$@" >/dev/null 2>&1
  )
  printf '%s\n' "$?"
}
_eq 'merge-result: a commit in flight in ANOTHER repo is exit 2 (ambiguous), not a guess' \
  '2' "$(_run_foreign_commit "$other" "$fx" "$fx/$RAW_TX_FILE")"
_eq 'merge-result: …and --worktree resolves it — the flag pr-merge-result-check passes' \
  '1' "$(_run_foreign_commit "$other" "$fx" --worktree "$fx/$RAW_TX_FILE")"
_eq 'merge-result: …and --cached is honoured too, so the refusal is about AUTO alone' \
  '1' "$(_run_foreign_commit "$other" "$fx" --cached "$fx/$RAW_TX_FILE")"

# …and the refusal is a DISCRIMINATION, not a guard that refuses every
# GIT_INDEX_FILE: the fixture's OWN index, absolute or relative, still
# auto-selects the index exactly as a real commit hook needs.
_eq 'merge-result: the tree OWN index (absolute) still auto-selects the index' \
  '1' "$(cd "$fx" && GIT_INDEX_FILE="$fx/.git/index" python3 "$GUARD_RAW_TX" "$RAW_TX_FILE" >/dev/null 2>&1; echo $?)"
_eq 'merge-result: …and the RELATIVE .git/index a real commit exports does too' \
  '1' "$(_run_auto_commit "$fx" "$GUARD_RAW_TX" "$RAW_TX_FILE")"

# ---------------------------------------------------------------------------
# 6. exists() AND read() ANSWER ABOUT THE SAME SET (#4058)
# ---------------------------------------------------------------------------
# `read` used to fall back to disk for ANY path with no stage-0 entry. That
# is right for an UNMERGED path — the conflicted copy on disk is where the
# markers live — but "no stage-0 entry" also covers a STAGED DELETION, and
# there the fallback contradicted `exists()`: one method said the path is not
# in the commit while the other handed back its content.
#
# The two are asserted directly (the helper's own answers) AND through a
# guard's exit code, because a helper that agrees with itself while no guard
# consults it would satisfy only the first.

# Ask the fixture's OWN helper what it thinks about `rel` under the index.
# One line, so a shell comparison can be the assertion.
_probe_source() {
  local dir="$1"
  shift
  (
    cd "$dir" || exit 99
    env -u GIT_INDEX_FILE python3 - "$@" <<'PY'
import importlib.util
import pathlib
import sys

root = pathlib.Path.cwd()
spec = importlib.util.spec_from_file_location(
    "_gfs", root / "scripts" / "lib" / "guard_file_source.py"
)
gfs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gfs)
src = gfs.FileSource(root, gfs.SOURCE_INDEX, "test probe")
for rel in sys.argv[1:]:
    print(f"{rel} exists={src.exists(rel)} read_is_none={src.read(rel) is None}")
PY
  ) 2>/dev/null
}

DYN_BASELINE="src-tauri/dynamic-sql-baseline.txt"

fx="$tmp/agreement-staged-deletion"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf '%s\n' "$DYN_BAD" > "$fx/$DYN_FILE"
printf '# Format: <count> <path-relative-to-repo-root>\n1 %s\n' "$DYN_FILE" \
  > "$fx/$DYN_BASELINE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
# The commit under judgement REMOVES the baseline while leaving it on disk.
git -C "$fx" rm -q --cached "$DYN_BASELINE"

_eq 'agreement: a staged deletion reads as absent, exactly as exists() says' \
  "$DYN_BASELINE exists=False read_is_none=True" \
  "$(_probe_source "$fx" "$DYN_BASELINE")"
# THE CONTROL. Without it, "exists() and read() agree" is satisfied by a
# helper that answers absent/None for everything — including the file this
# very commit is about.
_eq 'agreement: …and a path that IS staged reads as present, so the probe discriminates' \
  "$DYN_FILE exists=True read_is_none=False" \
  "$(_probe_source "$fx" "$DYN_FILE")"

# …and the consequence, in the guard that actually asks. The ceiling is
# leaving the commit, so the site it was licensing is unjustified in the
# commit being made.
_eq 'agreement: the INDEX judges the commit against the ceiling that commit removes' \
  '1' "$(_run "$fx" "$GUARD_DYN" --cached "$DYN_FILE")"
_eq 'agreement: …while the WORKING TREE still sees the on-disk ceiling (the control)' \
  '0' "$(_run "$fx" "$GUARD_DYN" --worktree "$DYN_FILE")"

# The UNMERGED path is the one case whose right answer IS the disk, and it
# must not be swept up by the fix above. A real conflict is built by merging
# two branches that touch the same line.
fx="$tmp/agreement-unmerged"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf '%s\n' "$DYN_GOOD" > "$fx/$DYN_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
git -C "$fx" checkout -q -b other
printf '%s\n' "$DYN_BAD" > "$fx/$DYN_FILE"
git -C "$fx" commit -qam theirs
git -C "$fx" checkout -q -
printf 'async fn f() {\n    let rows = 0;\n}\n' > "$fx/$DYN_FILE"
git -C "$fx" commit -qam ours
git -C "$fx" merge -q other >/dev/null 2>&1 || true
_eq 'agreement: an UNMERGED path still reads the conflicted copy on disk' \
  "$DYN_FILE exists=False read_is_none=False" \
  "$(_probe_source "$fx" "$DYN_FILE")"

# ---------------------------------------------------------------------------
# 7. A BLOB THE INDEX NAMES THAT GIT CANNOT PRODUCE (#4046)
# ---------------------------------------------------------------------------
# `_blob` swallowed EVERY non-zero `git cat-file` into None, and `read` then
# returned the working-tree copy — under a verdict printed as "judged the
# staged index". The one case whose right answer is the disk (unmerged) never
# reaches `cat-file` at all, so everything left here is a damaged object
# store: the staged content cannot be read, and the file on disk is not a
# degraded copy of it but DIFFERENT CONTENT. Fails closed instead.
#
# The fixture deletes the loose object behind the staged blob. Nothing else
# in the repository refers to it.
fx="$tmp/damaged-object"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src/commands"
printf '%s\n' "$RAW_TX_GOOD" > "$fx/$RAW_TX_FILE"
printf '%s\n' "$ARITY_GOOD" > "$fx/$ARITY_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
printf '%s\n' "$RAW_TX_BAD" > "$fx/$RAW_TX_FILE"   # the violations are STAGED
printf '%s\n' "$ARITY_BAD" > "$fx/$ARITY_FILE"
git -C "$fx" add -A
printf '%s\n' "$RAW_TX_GOOD" > "$fx/$RAW_TX_FILE"  # …and clean on disk
printf '%s\n' "$ARITY_GOOD" > "$fx/$ARITY_FILE"

# THE CONTROL, before the damage: the staged violations are found, so an exit
# 0 below can only mean the guard read the wrong copy — never "nothing to
# find". check-dynamic-sql scans $RAW_TX_FILE too (a `sqlx::query(` site is
# not what makes that file interesting — being STAGED is).
_eq 'damaged object: the intact fixture fails under --cached (the control)' \
  '1' "$(_run "$fx" "$GUARD_RAW_TX" --cached "$RAW_TX_FILE")"
_eq 'damaged object: …and the arity fixture too (the control)' \
  '1' "$(_run "$fx" "$GUARD_ARITY" --cached "$ARITY_FILE")"

staged_sha="$(git -C "$fx" rev-parse ":$RAW_TX_FILE")"
arity_sha="$(git -C "$fx" rev-parse ":$ARITY_FILE")"
rm -f "$fx/.git/objects/${staged_sha:0:2}/${staged_sha:2}"
rm -f "$fx/.git/objects/${arity_sha:0:2}/${arity_sha:2}"

_eq 'damaged object: an unreadable staged blob is exit 2, not a working-tree verdict' \
  '2' "$(_run "$fx" "$GUARD_RAW_TX" --cached "$RAW_TX_FILE")"
_eq 'damaged object: …and the refusal names the sha rather than falling back silently' \
  '1' "$(cd "$fx" && env -u GIT_INDEX_FILE python3 "$GUARD_RAW_TX" --cached "$RAW_TX_FILE" 2>&1 >/dev/null | grep -c "$staged_sha")"
# …and the refusal is SPECIFIC to the index: --worktree is a legitimate
# request that the object store cannot break, so it still answers.
_eq 'damaged object: --worktree is unaffected — it never asks the object store' \
  '0' "$(_run "$fx" "$GUARD_RAW_TX" --worktree "$RAW_TX_FILE")"
_eq 'damaged object: the same fail-closed answer in check-dynamic-sql' \
  '2' "$(_run "$fx" "$GUARD_DYN" --cached "$RAW_TX_FILE")"
_eq 'damaged object: …and in check-command-arity' \
  '2' "$(_run "$fx" "$GUARD_ARITY" --cached "$ARITY_FILE")"

# ---------------------------------------------------------------------------
# 8. THE WHOLE-TREE BRANCH ENUMERATES THE SOURCE (#4060 / #4047)
# ---------------------------------------------------------------------------
# `check-command-arity.py` with no path arguments scanned `COMMANDS_DIR.rglob`
# — the DISK — even under `--cached`, while its path-argument branch asked
# `src.exists()`. So the two branches disagreed about what the file set is,
# in both directions.
#
# STAGED BUT ABSENT FROM DISK is the case that isolates the ENUMERATOR: with
# the path passed explicitly the guard already judged it, so only the
# no-arguments branch can miss it.
fx="$tmp/arity-whole-tree-staged-absent"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src/commands"
printf '%s\n' "$ARITY_GOOD" > "$fx/$ARITY_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
printf '%s\n' "$ARITY_BAD" > "$fx/$ARITY_FILE"
git -C "$fx" add -A
rm "$fx/$ARITY_FILE"                                # staged, gone from disk
_eq 'whole tree: --cached enumerates the index, so a staged-but-absent file is judged' \
  '1' "$(_run "$fx" "$GUARD_ARITY" --cached)"
_eq 'whole tree: --worktree does not — there is nothing on disk to enumerate (the control)' \
  '0' "$(_run "$fx" "$GUARD_ARITY" --worktree)"

# …and the other direction: on disk, but NOT in the commit.
fx="$tmp/arity-whole-tree-uncached"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src/commands"
printf '%s\n' "$ARITY_BAD" > "$fx/$ARITY_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
git -C "$fx" rm -q --cached "$ARITY_FILE"           # leaving the commit
_eq 'whole tree: --cached does not judge a file the commit removes' \
  '0' "$(_run "$fx" "$GUARD_ARITY" --cached)"
_eq 'whole tree: --worktree still judges it — it is right there on disk (the control)' \
  '1' "$(_run "$fx" "$GUARD_ARITY" --worktree)"

# `check-dynamic-sql.py`'s `all_production_files` had the same shape. Its one
# caller is `--update-baseline`, which runs against the WORKING TREE by
# design — so the fix has to leave that alone, and the two answers are pinned
# side by side: the enumerator follows the source, and the source for a
# re-anchor is still the disk.
DYN_OTHER="src-tauri/src/other_4047.rs"
fx="$tmp/dyn-whole-tree"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf '%s\n' "$DYN_GOOD" > "$fx/$DYN_FILE"
printf '# Format: <count> <path-relative-to-repo-root>\n' > "$fx/$DYN_BASELINE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
printf '%s\n' "$DYN_BAD" > "$fx/$DYN_OTHER"          # staged only, then removed
git -C "$fx" add -A
rm "$fx/$DYN_OTHER"
printf '%s\n' "$DYN_BAD" > "$fx/$DYN_FILE"
git -C "$fx" rm -q --cached "$DYN_FILE"              # on disk only

_probe_list() {
  local dir="$1"
  shift
  (
    cd "$dir" || exit 99
    env -u GIT_INDEX_FILE python3 - "$@" <<'PY'
import importlib.util
import pathlib
import sys

root = pathlib.Path.cwd()
spec = importlib.util.spec_from_file_location(
    "_gfs", root / "scripts" / "lib" / "guard_file_source.py"
)
gfs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gfs)
for source in (gfs.SOURCE_INDEX, gfs.SOURCE_WORKTREE):
    src = gfs.FileSource(root, source, "test probe")
    listed = src.list_paths(sys.argv[1], ".rs")
    # list_paths and exists() must answer about ONE set, or the whole-tree
    # branch enumerates files the path-argument branch would skip.
    assert all(src.exists(rel) for rel in listed), (source, listed)
    print(f"{source}: {' '.join(listed) or '(none)'}")
PY
  ) 2>/dev/null
}
_eq 'whole tree: list_paths follows the source, and agrees with exists() in both' \
  "index: $DYN_OTHER
worktree: $DYN_FILE" \
  "$(_probe_list "$fx" src-tauri/src)"

# --update-baseline is dispatched BEFORE the source is resolved, so it keeps
# reading the tree you are editing. Pinned, because the enumerator it calls
# is the one just changed.
( cd "$fx" && env -u GIT_INDEX_FILE python3 "$GUARD_DYN" --update-baseline --all >/dev/null 2>&1 )
_eq 'whole tree: --update-baseline --all still re-anchors from the WORKING TREE' \
  "1 $DYN_FILE" "$(grep -Ev '^(#|$)' "$fx/$DYN_BASELINE")"

# ---------------------------------------------------------------------------
if [ "$failures" -gt 0 ]; then
  printf '\npy guard file-source suite: %s assertion(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'py guard file-source suite: all assertions passed\n'
