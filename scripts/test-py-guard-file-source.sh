#!/usr/bin/env bash
# Falsification suite for the #4017 sweep of the PYTHON guards —
# check-raw-tx.py. check-dynamic-sql.mjs's half lives in
# scripts/lib/check-dynamic-sql.test.mjs.
#
# ─── Why this is a shell script and not a Python self-test ────────────────
#
# It builds git fixtures, and there is no Python sibling of
# `scripts/lib/git-scratch-guard.sh` to build them safely through. Writing
# one just to host these tests would be another copy of the scrubber by a
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
_seed_guards() {
  local dir="$1"
  mkdir -p "$dir/scripts/lib"
  cp "$SCRIPTS_DIR/check-raw-tx.py" "$dir/scripts/"
  cp "$SCRIPTS_DIR/lib/guard_file_source.py" "$dir/scripts/lib/"
  # Every declared CRATE_ROOTS directory, empty (#4501). The seeded guard
  # REFUSES a tree in which a declared crate root is absent, because a
  # renamed or misspelled segment used to make it exempt every file under
  # that crate in silence; without these, the assertions here go red for a
  # reason that has nothing to do with the file source under test.
  #
  # SEEDED, not suppressed with `--synthetic-tree` — the opposite choice from
  # `pr-merge-result-check.sh`, and the difference is what the fixtures are
  # FOR. That script's merge fixtures have deliberately foreign roots
  # (`src-tauri/source`, `src-tauri/extra/src`) because following the merged
  # tree's own layout is the property under test, so seeding real roots would
  # destroy it. These fixtures already use the REAL app root `src-tauri/src`
  # and are about which COPY of a file a guard reads; their crate topology is
  # incidental, so completing it costs nothing, keeps the roots assertion LIVE
  # here rather than switched off, and — the deciding reason — adds no second
  # opt-out surface for something else to have to police.
  #
  # Each root gets a TRACKED `.gitkeep`, not a bare `mkdir`: section 9 builds
  # linked worktrees with `git worktree add`, which reproduces the committed
  # tree — and git does not track empty directories, so an unseeded worktree
  # would have the guards but not the roots and fail for a reason section 9
  # is not about. `.gitkeep` is not `.rs`, so no scan sees it.
  local root
  for root in agaric-store/src agaric-engine/src agaric-sync/src \
              diagnostics/src src; do
    mkdir -p "$dir/src-tauri/$root"
    : > "$dir/src-tauri/$root/.gitkeep"
  done
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
# 4. AN INDEX THAT CANNOT BE READ
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

# An INHERITED GIT_DIR must not let the ownership probe answer about the
# OTHER repository (#4061). `_index_belongs_to` asks `git -C <root>
# rev-parse --absolute-git-dir`, and an ambient GIT_DIR outranks `-C`
# (measured: `GIT_DIR=<other>/.git git -C <root> rev-parse
# --absolute-git-dir` answers about <other>, not <root>). A real commit hook
# running INSIDE `other` would leave BOTH GIT_DIR and GIT_INDEX_FILE
# exported from it — the shape below — and before the fix the leaked
# GIT_DIR made the probe answer about `other`, so `GIT_INDEX_FILE` (also
# naming a path under that same leaked git dir) compared EQUAL to it: a
# false ACCEPT of the foreign index as belonging to `fx`, silently defeating
# the exit-2 refusal this whole section is about.
_run_foreign_commit_and_git_dir() {
  local cwd="$1" dir="$2"
  shift 2
  (
    cd "$cwd" || exit 99
    GIT_DIR="$other/.git" GIT_INDEX_FILE="$other/.git/index" \
      python3 "$dir/$GUARD_RAW_TX" "$@" >/dev/null 2>&1
  )
  printf '%s\n' "$?"
}
_eq 'merge-result: an inherited GIT_DIR must not make the probe answer about the OTHER repo (#4061)' \
  '2' "$(_run_foreign_commit_and_git_dir "$other" "$fx" "$fx/$RAW_TX_FILE")"
# THE CONTROL: --worktree sidesteps AUTO (and therefore the probe) entirely,
# so it must stay green under the very same leaked GIT_DIR — the refusal
# above is about the ambiguous index, not a guard that has stopped working
# under a foreign GIT_DIR.
_eq 'merge-result: …and --worktree is unaffected by the same leaked GIT_DIR' \
  '1' "$(cd "$other" || exit 99
    GIT_DIR="$other/.git" GIT_INDEX_FILE="$other/.git/index" \
      python3 "$fx/$GUARD_RAW_TX" --worktree "$fx/$RAW_TX_FILE" >/dev/null 2>&1
    echo $?)"

# ---------------------------------------------------------------------------
# 5b. …AND THE LEAKED GIT_DIR REACHES THE READER, NOT ONLY THE PROBE (#4191)
# ---------------------------------------------------------------------------
# `git_env` used to strip a foreign `GIT_INDEX_FILE` and leave everything else
# "exactly as given" — including `GIT_DIR`, which re-aims the very `git
# ls-files` that env is built for. Measured on git 2.43, from a cwd inside
# repo A: `GIT_DIR=<B>/.git git -C <A> ls-files` lists B's tracked paths, not
# A's; `-C` and `cwd` both lose to it. So `--cached` under a leaked `GIT_DIR`
# enumerated the OTHER repository's index, found the path under judgement
# simply absent, read nothing, and exited 0 over a staged violation — the
# same silent false green the exit-2 refusal above exists to prevent, one
# explicit flag away from it. Measured against this exact fixture before the
# fix: exit 0 with empty stderr, both with and without a foreign
# `GIT_INDEX_FILE` beside the leak.
#
# `--worktree` is unaffected on the Python side (asserted just above): it
# reads the given path straight off disk with no `git` subprocess to
# redirect. The `.mjs` sibling has no such immunity — its `--worktree` still
# ENUMERATES through `git ls-files` — which is why scenario 9 of
# `runSourceScenarios` asserts the same fix from the other end.
_run_leaked_git_dir() {
  local cwd="$1" dir="$2" guard="$3"
  shift 3
  # Held in a variable rather than spelled inline, because
  # check-git-fixture-isolation.mjs reads an `env -u GIT_… … git …` logical
  # line as a hand-rolled fixture scrub (its design call 1) and would report
  # this file. This is the OPPOSITE of a scrub: it PLANTS a leak on the guard
  # under test, and no git command runs under that environment at all.
  local leaked_dir="$other/.git"
  (
    cd "$cwd" || exit 99
    env -u GIT_INDEX_FILE GIT_DIR="$leaked_dir" \
      python3 "$dir/$guard" "$@" >/dev/null 2>&1
  )
  printf '%s\n' "$?"
}
_eq 'leaked GIT_DIR: --cached must read THIS index, not the one GIT_DIR points at (#4191)' \
  '1' "$(_run_leaked_git_dir "$other" "$fx" "$GUARD_RAW_TX" --cached "$fx/$RAW_TX_FILE")"
_eq 'leaked GIT_DIR: …and with a foreign GIT_INDEX_FILE beside it, already stripped by belonging' \
  '1' "$(_run_foreign_commit_and_git_dir "$other" "$fx" --cached "$fx/$RAW_TX_FILE")"
# THE CONTROL. Both reds above must be about the violation, not about the
# leak: the same leaked `GIT_DIR`, over a fixture with nothing to find, is
# green. Without this, "expected 1" is satisfied by a guard that reddens on
# anything the moment it sees a `GIT_DIR` — the mirror image of the defect.
_eq 'leaked GIT_DIR: …and a CLEAN fixture under the same leak is still green (not red-on-anything)' \
  '0' "$(_run_leaked_git_dir "$other" "$tmp/raw-tx-clean" "$GUARD_RAW_TX" --cached \
    "$tmp/raw-tx-clean/$RAW_TX_FILE")"

# THE LEGITIMATE COMMIT HOOK, which that scrub must not break. Scrubbing
# `GIT_DIR` is safe only because a hook's own `GIT_DIR` is REDUNDANT with what
# `cwd=root` discovers — never because the fix can tell an honest export from
# a hostile one — so both shapes git can produce are pinned here, over the
# false-green fixture whose violation is STAGED and whose disk copy is clean.
# A guard that had stopped honouring the exported index would exit 0.
_eq 'commit hook: a RELATIVE GIT_DIR=.git beside the index still reads the staged index' \
  '1' "$(cd "$tmp/raw-tx-false-green" || exit 99
    GIT_DIR=.git GIT_INDEX_FILE=.git/index \
      python3 "$GUARD_RAW_TX" "$RAW_TX_FILE" >/dev/null 2>&1
    echo $?)"
_eq 'commit hook: …and an ABSOLUTE GIT_DIR naming this tree own git dir does too' \
  '1' "$(cd "$tmp/raw-tx-false-green" || exit 99
    GIT_DIR="$tmp/raw-tx-false-green/.git" \
      GIT_INDEX_FILE="$tmp/raw-tx-false-green/.git/index" \
      python3 "$GUARD_RAW_TX" "$RAW_TX_FILE" >/dev/null 2>&1
    echo $?)"

# …and a PARTIAL commit, the one shape where `GIT_INDEX_FILE` carries
# something the git dir cannot reproduce: `git commit -- <path>` writes a
# `.git/next-index-<pid>.lock` TEMP index and exports THAT (measured on git
# 2.43, alongside `.git/index.lock` for `git commit -a`). The two checks above
# cannot see the difference — in an ordinary fixture `.git/index` is also what
# git falls back to when the variable is dropped — so this is what makes "keep
# GIT_INDEX_FILE, scrub the rest" a real distinction rather than a stylistic
# one. The fixture builds the divergence by hand: the staged violation is
# copied into a temp index under this tree own git dir, and `.git/index` is
# then made clean.
fx="$tmp/raw-tx-temp-index"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf '%s\n' "$RAW_TX_GOOD" > "$fx/$RAW_TX_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
printf '%s\n' "$RAW_TX_BAD" > "$fx/$RAW_TX_FILE"
git -C "$fx" add -A                               # the violation is STAGED…
cp "$fx/.git/index" "$fx/.git/next-index-fake.lock" # …captured in a temp index…
printf '%s\n' "$RAW_TX_GOOD" > "$fx/$RAW_TX_FILE"
git -C "$fx" add -A                               # …and the DEFAULT index is clean
_eq 'commit hook: the temp-index fixture really did clean the DEFAULT index (else the next case is vacuous)' \
  '0' "$(_run "$fx" "$GUARD_RAW_TX" --cached "$RAW_TX_FILE")"
_eq 'commit hook: the TEMP index of a partial commit is honoured, not replaced by the default one' \
  '1' "$(cd "$fx" || exit 99
    GIT_DIR="$fx/.git" GIT_INDEX_FILE="$fx/.git/next-index-fake.lock" \
      python3 "$GUARD_RAW_TX" "$RAW_TX_FILE" >/dev/null 2>&1
    echo $?)"

# ---------------------------------------------------------------------------
# 5c. …AND THE OBJECT STORE, WHICH THE GIT DIR IS ONLY HALF OF (#4191)
# ---------------------------------------------------------------------------
# `GIT_OBJECT_DIRECTORY` and `GIT_ALTERNATE_OBJECT_DIRECTORIES` are one
# mechanism in two variables — git's `receive-pack` quarantine exports the
# pair together — so scrubbing only the first leaves the second able to answer
# for any oid the primary store LACKS. And `git cat-file` does not verify that
# a body hashes to the name it was asked for (measured on git 2.43, through
# `cat-file blob` and `cat-file --batch` alike), so a leaked alternate can
# hand the guard an ATTACKER-CHOSEN body for an oid `git ls-files -s` named.
# That is the same "reported a verdict about content it never read from this
# tree" as a leaked `GIT_DIR`, one layer down: measured before the variable
# joined `_GIT_REDIRECT_VARS`, exit 2 (the fail-closed damaged-store refusal)
# became exit 0 over a forged clean body.
#
# Built so the answer cannot be a coincidence: the violation is staged, its
# loose object is REMOVED (a fresh fixture never packs), and the forged store
# holds the GOOD line's bytes under the VIOLATION's oid. The interesting assertion is a non-event, so the three
# before it pin that there was an event to prevent.
fx="$tmp/raw-tx-alternates"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf '%s\n' "$RAW_TX_GOOD" > "$fx/$RAW_TX_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
printf '%s\n' "$RAW_TX_BAD" > "$fx/$RAW_TX_FILE"
git -C "$fx" add -A # the violation is STAGED, and its blob is loose
_eq 'leaked alternates: the fixture really stages the violation (else the rest is vacuous)' \
  '1' "$(_run "$fx" "$GUARD_RAW_TX" --cached "$RAW_TX_FILE")"
alt_oid="$(git -C "$fx" ls-files -s -- "$RAW_TX_FILE" | awk '{print $2}')"
rm -f "$fx/.git/objects/${alt_oid:0:2}/${alt_oid:2}"
_eq 'leaked alternates: …and with its loose object removed the guard refuses fail-closed, not silently' \
  '2' "$(_run "$fx" "$GUARD_RAW_TX" --cached "$RAW_TX_FILE")"
alt_store="$tmp/forged-objects"
mkdir -p "$alt_store/${alt_oid:0:2}"
RAW_TX_GOOD="$RAW_TX_GOOD" python3 - "$alt_store/${alt_oid:0:2}/${alt_oid:2}" <<'PY'
import os, sys, zlib

body = (os.environ["RAW_TX_GOOD"] + "\n").encode()
with open(sys.argv[1], "wb") as fh:
    fh.write(zlib.compress(b"blob %d\0" % len(body) + body))
PY
_eq 'leaked alternates: …and git itself DOES serve the forged body under that oid (the leak is real)' \
  "$RAW_TX_GOOD" "$(GIT_ALTERNATE_OBJECT_DIRECTORIES="$alt_store" \
    git -C "$fx" cat-file blob "$alt_oid")"
_eq 'leaked alternates: …yet the guard still refuses, because the variable never reaches its cat-file' \
  '2' "$(cd "$fx" || exit 99
    GIT_ALTERNATE_OBJECT_DIRECTORIES="$alt_store" \
      env -u GIT_INDEX_FILE python3 "$GUARD_RAW_TX" --cached "$RAW_TX_FILE" >/dev/null 2>&1
    echo $?)"

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

DYN_FILE="src-tauri/src/thing_4017.rs"
DYN_BAD='async fn f() {
    let rows = sqlx::query("SELECT 1").fetch_all(&pool).await?;
}'
DYN_GOOD='async fn f() {
    let rows = sqlx::query!("SELECT 1").fetch_all(&pool).await?;
}'
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
mkdir -p "$fx/src-tauri/src"
printf '%s\n' "$RAW_TX_GOOD" > "$fx/$RAW_TX_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
printf '%s\n' "$RAW_TX_BAD" > "$fx/$RAW_TX_FILE"   # the violation is STAGED
git -C "$fx" add -A
printf '%s\n' "$RAW_TX_GOOD" > "$fx/$RAW_TX_FILE"  # …and clean on disk

# THE CONTROL, before the damage: the staged violation is found, so an exit
# 0 below can only mean the guard read the wrong copy — never "nothing to
# find".
_eq 'damaged object: the intact fixture fails under --cached (the control)' \
  '1' "$(_run "$fx" "$GUARD_RAW_TX" --cached "$RAW_TX_FILE")"

staged_sha="$(git -C "$fx" rev-parse ":$RAW_TX_FILE")"
rm -f "$fx/.git/objects/${staged_sha:0:2}/${staged_sha:2}"

_eq 'damaged object: an unreadable staged blob is exit 2, not a working-tree verdict' \
  '2' "$(_run "$fx" "$GUARD_RAW_TX" --cached "$RAW_TX_FILE")"
_eq 'damaged object: …and the refusal names the sha rather than falling back silently' \
  '1' "$(cd "$fx" && env -u GIT_INDEX_FILE python3 "$GUARD_RAW_TX" --cached "$RAW_TX_FILE" 2>&1 >/dev/null | grep -c "$staged_sha")"
# …and the refusal is SPECIFIC to the index: --worktree is a legitimate
# request that the object store cannot break, so it still answers.
_eq 'damaged object: --worktree is unaffected — it never asks the object store' \
  '0' "$(_run "$fx" "$GUARD_RAW_TX" --worktree "$RAW_TX_FILE")"

# ---------------------------------------------------------------------------
# 9. A LINKED WORKTREE'S OWN INDEX (#4048)
# ---------------------------------------------------------------------------
# Section 5 above pins the fail-closed rule using a FOREIGN repository's
# index — the one situation where every plausible implementation answers "not
# mine". So the sameness claim it shares with `runSourceScenarios` scenario 9
# was held in the only place that could not discriminate, and the two helpers
# diverged anyway: for a LINKED WORKTREE's own index, this one said "mine"
# while the `.mjs` twin said "somebody else's", and every citation guard exited
# 2 on every commit made from a worktree.
#
# A worktree is also the shape that exposes the OPPOSITE error, and this
# helper had it. `<main>/.git` is the COMMON dir of the main checkout and of
# every linked worktree, so accepting a path under `--git-common-dir` accepted
# a SIBLING worktree's index; and a worktree's git dir is NESTED inside the
# main one, so plain containment accepted a worktree's index as the main
# checkout's. Both are false ACCEPTS, and both fail in the silent direction:
# the guard reads a tree nobody is committing, finds nothing staged there, and
# exits 0 over the violation actually in flight.
#
# The fixture is arranged so that every wrong answer below is an exit 0 over a
# real staged violation, never a different shade of red. Both worktrees live
# under "$tmp"; nothing here names an index outside it.
WT_MAIN_FILE="src-tauri/src/main_only_4048.rs"
wt_main="$tmp/wt-main"
_new_fixture "$wt_main"
mkdir -p "$wt_main/src-tauri/src"
printf '%s\n' "$RAW_TX_GOOD" > "$wt_main/$RAW_TX_FILE"
printf '%s\n' "$RAW_TX_GOOD" > "$wt_main/$WT_MAIN_FILE"
git -C "$wt_main" add -A
# The guards travel with the tree: a guard judges the tree that CONTAINS it,
# so committing `scripts/` here is what gives each worktree its own copy.
git -C "$wt_main" commit -qm base
wt_a="$tmp/wt-linked-a"
wt_b="$tmp/wt-linked-b"
git -C "$wt_main" worktree add -q -b linked-a "$wt_a"
git -C "$wt_main" worktree add -q -b linked-b "$wt_b"

# git's own answer for each index, absolute — not a path this script
# assembles. `--git-path index` is relative in the main checkout and absolute
# in a linked worktree, and `--path-format=absolute` collapses that.
_index_of() { git -C "$1" rev-parse --path-format=absolute --git-path index; }
idx_main="$(_index_of "$wt_main")"
idx_a="$(_index_of "$wt_a")"
idx_b="$(_index_of "$wt_b")"

# THE FIXTURE REALLY HAS THE SHAPE THIS SECTION IS ABOUT. Without this, a
# `git worktree add` that quietly produced an ordinary clone would make every
# assertion below pass for the wrong reason — which is exactly how the claim
# in section 5 came to be held somewhere it could not be tested.
_eq "linked worktree: its index lives under the MAIN checkout's .git, not inside the worktree" \
  "yes yes yes" \
  "$(
    a='no' b='no' c='no'
    # `.git/worktrees/<name>` is named after the worktree DIRECTORY, not the
    # branch, so the prefix stops at `worktrees/`.
    case "$idx_a" in "$wt_main/.git/worktrees/"*) a='yes' ;; esac
    case "$idx_a" in "$wt_a/"*) : ;; *) b='yes' ;; esac
    [ -f "$idx_a" ] && [ -f "$idx_b" ] && [ -f "$idx_main" ] && [ "$idx_a" != "$idx_b" ] && c='yes'
    printf '%s %s %s\n' "$a" "$b" "$c"
  )"

# Run a guard inside `dir` with `index` exported as the commit in flight.
_run_with_index() {
  local dir="$1" index="$2"
  shift 2
  (
    cd "$dir" || exit 99
    GIT_INDEX_FILE="$index" python3 "$@" >/dev/null 2>&1
  )
  printf '%s\n' "$?"
}

# The violation is staged in WORKTREE A only, so main's index and B's index
# both hold the clean copy: a guard that reads either exits 0.
printf '%s\n' "$RAW_TX_BAD" > "$wt_a/$RAW_TX_FILE"
git -C "$wt_a" add -A
printf '%s\n' "$RAW_TX_GOOD" > "$wt_a/$RAW_TX_FILE" # …invisible on disk

_eq "linked worktree: AUTO accepts the worktree's OWN index (the #4048 regression)" \
  '1' "$(_run_with_index "$wt_a" "$idx_a" "$GUARD_RAW_TX" "$RAW_TX_FILE")"
_eq "linked worktree: a SIBLING worktree's index is refused, not read as this tree's" \
  '2' "$(_run_with_index "$wt_a" "$idx_b" "$GUARD_RAW_TX" "$RAW_TX_FILE")"
_eq 'linked worktree: the MAIN index is refused too — a shared object store is not a shared index' \
  '2' "$(_run_with_index "$wt_a" "$idx_main" "$GUARD_RAW_TX" "$RAW_TX_FILE")"
# THE CONTROL for all three: the copy on disk is clean, so the exit 1 above is
# about the index and the exit 2s are not a guard that has stopped working.
_eq 'linked worktree: --worktree still judges the clean copy on disk' \
  '0' "$(_run_with_index "$wt_a" "$idx_a" "$GUARD_RAW_TX" --worktree "$RAW_TX_FILE")"

# …and the symmetric direction, which is the live shape in this repo: a guard
# running in the MAIN checkout while a commit is in flight in a worktree. Main
# gets its own staged violation first, so "still reads its own index" is an
# exit 1 over content only main has staged.
printf '%s\n' "$RAW_TX_BAD" > "$wt_main/$WT_MAIN_FILE"
git -C "$wt_main" add -A
printf '%s\n' "$RAW_TX_GOOD" > "$wt_main/$WT_MAIN_FILE"
_eq 'linked worktree: the MAIN checkout of a repo that HAS worktrees still reads its own index' \
  '1' "$(_run_with_index "$wt_main" "$idx_main" "$GUARD_RAW_TX" "$WT_MAIN_FILE")"
_eq "linked worktree: …and refuses a WORKTREE's index nested inside its own .git" \
  '2' "$(_run_with_index "$wt_main" "$idx_a" "$GUARD_RAW_TX" "$WT_MAIN_FILE")"

# ---------------------------------------------------------------------------
# 10. AN UNDECODABLE FILE READS IDENTICALLY UNDER BOTH SOURCES (#4062)
# ---------------------------------------------------------------------------
# `_blob` (the index) has always decoded lossily (`errors="replace"`), while
# `read`'s working-tree branch used to decode strictly and turn a
# `UnicodeDecodeError` into `None` — silently DROPPING the file from the
# scan. So a tracked file holding invalid UTF-8 was scanned as mojibake
# under --cached and skipped entirely under --worktree: the same
# copy-disagreement #4048 exists to close, arriving through the decoder
# instead of the source choice.
#
# The decoy bytes are the same ones `runSourceScenarios` scenario 7 builds
# on the Node side (`Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0xff, 0xfe,
# 0x00, 0x0a])`) — 0xe9 has no valid continuation and 0xff/0xfe are never
# valid UTF-8 lead bytes, so decoding strictly must fail.
UNDECODABLE_PREFIX='\x63\x61\x66\xe9\x20\xff\xfe\x00\n'

fx="$tmp/undecodable-violation"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf "$UNDECODABLE_PREFIX" > "$fx/$RAW_TX_FILE"
printf '%s\n' "$RAW_TX_BAD" >> "$fx/$RAW_TX_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
_eq 'undecodable file: the fixture really is invalid UTF-8 (else this case is vacuous)' \
  'invalid' "$(python3 -c "
try:
    open('$fx/$RAW_TX_FILE', 'rb').read().decode('utf-8')
    print('valid')
except UnicodeDecodeError:
    print('invalid')
")"
_eq 'undecodable file: the WORKING TREE scans behind the bad bytes and finds the violation (#4062)' \
  '1' "$(_run "$fx" "$GUARD_RAW_TX" --worktree "$RAW_TX_FILE")"
_eq 'undecodable file: the INDEX finds the SAME violation — the two sources now agree' \
  '1' "$(_run "$fx" "$GUARD_RAW_TX" --cached "$RAW_TX_FILE")"

# THE CONTROL: no violation behind the bad bytes. Without this, "both red"
# above would be satisfied just as well by a guard that flags every
# undecodable file outright, rather than one that scans it and finds
# nothing wrong.
fx="$tmp/undecodable-clean"
_new_fixture "$fx"
mkdir -p "$fx/src-tauri/src"
printf "$UNDECODABLE_PREFIX" > "$fx/$RAW_TX_FILE"
printf '%s\n' "$RAW_TX_GOOD" >> "$fx/$RAW_TX_FILE"
git -C "$fx" add -A
git -C "$fx" commit -qm base
_eq 'undecodable file: …and the CONTROL — no violation behind the bad bytes stays green under --worktree' \
  '0' "$(_run "$fx" "$GUARD_RAW_TX" --worktree "$RAW_TX_FILE")"
_eq 'undecodable file: …and green under --cached too' \
  '0' "$(_run "$fx" "$GUARD_RAW_TX" --cached "$RAW_TX_FILE")"

# ---------------------------------------------------------------------------
# 14. THE PYTHON AND NODE REDIRECT-VAR LISTS ARE ACTUALLY IDENTICAL (#4206)
# ---------------------------------------------------------------------------
# `_GIT_REDIRECT_VARS` (guard_file_source.py) and `GIT_REDIRECT_VARS`
# (guard-file-source.mjs) each carry a comment asserting the two lists are
# identical, citing #4062 as the class of bug a divergence would be — but
# until now nothing enforced it. `GIT_ALTERNATE_OBJECT_DIRECTORIES` missing
# from one side is exactly the shape #4206 repaired by hand; this section
# makes a future repeat fail a test instead of surviving as a comment nobody
# re-reads. Compares the two SOURCE lists directly (imported, not
# retyped) — order-independent, since neither side's order is a contract.
py_redirect_vars="$(python3 -c '
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location(
    "_gfs", pathlib.Path(sys.argv[1]) / "lib" / "guard_file_source.py"
)
gfs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gfs)
print("\n".join(sorted(gfs._GIT_REDIRECT_VARS)))
' "$SCRIPTS_DIR")"
node_redirect_vars="$(node --input-type=module -e '
import { pathToFileURL } from "node:url"
const { GIT_REDIRECT_VARS } = await import(pathToFileURL(process.argv[1]).href)
console.log([...GIT_REDIRECT_VARS].sort().join("\n"))
' "$SCRIPTS_DIR/lib/guard-file-source.mjs")"
_eq 'GIT_REDIRECT_VARS: the Python and Node lists name exactly the same variables' \
  "$py_redirect_vars" "$node_redirect_vars"

# ---------------------------------------------------------------------------
if [ "$failures" -gt 0 ]; then
  printf '\npy guard file-source suite: %s assertion(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'py guard file-source suite: all assertions passed\n'
