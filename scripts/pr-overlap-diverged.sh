#!/usr/bin/env bash
# #3672 / #3736 review — what the BASE BRANCH has changed since this PR branch
# forked off it, one path per line.
#
# ─── Why this is a script and not four lines in the workflow ──────────────
#
# It was four lines in the workflow, and they were wrong in a way no test
# could see. On a `pull_request` event `actions/checkout` leaves HEAD at
# `refs/pull/N/merge`, a merge commit GitHub synthesises whose FIRST PARENT IS
# THE BASE TIP:
#
#     $ git cat-file -p HEAD            # on PR #3736
#     parent 065d94b3c   <- == origin/main
#     parent 0d5d341af   <- the actual PR head
#
# so `git merge-base HEAD origin/main` returns `origin/main` itself and the
# diff that follows is `git diff X X` — **empty by construction, never by
# measurement**. `git diff` exits 0, so a `|| rm -f` guard never fires: the
# output file exists and is empty, and the renderer prints "None of the files
# this PR changes have changed on `main` since its base."
#
# That is a negative ANSWER where the only honest output is "not computed" —
# the exact conflation the rest of this lane exists to refuse. And it failed on
# the incident the lane was built for: #3717 had already merged when #3724
# opened, so #3724's merge ref carries #3717 in parent 1 and the set is empty
# there too. The half described as "the only one of the two that would have
# caught the incident" could not fire on any pull request.
#
# The reason it survived review the first time is that the assertions injected
# the divergence list straight into `computeOverlap`, and the replay used
# #3724's HEAD commit — which is exactly the input the workflow does not
# supply. So the computation lives here, where `--self-test` can build the real
# topologies and drive it end to end, including a fixture that pins the OLD
# formulation returning nothing.
#
# ─── Contract ─────────────────────────────────────────────────────────────
#
#   exit 0  — computed. stdout is the list, and an EMPTY list is a real
#             answer ("nothing diverged").
#   exit 1  — NOT computed. stdout is empty, and the caller must not write an
#             empty file: "we could not look" and "we looked and found
#             nothing" are different facts.
#
# Usage:
#   scripts/pr-overlap-diverged.sh <base-ref> [<head-sha>]
#   scripts/pr-overlap-diverged.sh --print-head <base-ref> [<head-sha>]
#   scripts/pr-overlap-diverged.sh --self-test

set -uo pipefail

# ---------------------------------------------------------------------------
# core
# ---------------------------------------------------------------------------

# The base branch tip. `origin/<ref>` first because that is the CI shape; a
# bare ref second so the self-test (and a local run) resolves too.
resolve_base_tip() {
  local ref="$1" candidate
  for candidate in "origin/${ref}" "${ref}" "refs/remotes/origin/${ref}"; do
    if git rev-parse --verify --quiet "${candidate}^{commit}" >/dev/null 2>&1; then
      git rev-parse "${candidate}^{commit}"
      return 0
    fi
  done
  return 1
}

# The commit carrying THIS PULL REQUEST'S work.
#
# 1. An explicit sha wins. `github.event.pull_request.head.sha` is unambiguous
#    and is what the workflow passes.
# 2. Otherwise, detect the synthesised merge ref and take its SECOND parent.
#    The discriminator is that parent 1 is contained in the base branch's
#    history — that is what makes it the merge ref rather than a merge the
#    AUTHOR made. It matters: a branch whose last commit is `git merge
#    origin/main` is also a two-parent HEAD, and there `HEAD^2` is
#    `origin/main`, i.e. taking it blindly would compare the base branch with
#    itself and reintroduce the empty-by-construction bug wearing a different
#    hat.
# 3. Otherwise HEAD, which is the plain-checkout shape.
resolve_head() {
  local base_tip="$1" explicit="${2:-}" p1 p2
  if [ -n "$explicit" ] && git rev-parse --verify --quiet "${explicit}^{commit}" >/dev/null 2>&1; then
    git rev-parse "${explicit}^{commit}"
    return 0
  fi
  p1=$(git rev-parse --verify --quiet 'HEAD^1^{commit}' 2>/dev/null || true)
  p2=$(git rev-parse --verify --quiet 'HEAD^2^{commit}' 2>/dev/null || true)
  if [ -n "$p1" ] && [ -n "$p2" ] && git merge-base --is-ancestor "$p1" "$base_tip" 2>/dev/null; then
    printf '%s\n' "$p2"
    return 0
  fi
  git rev-parse HEAD
}

# ---------------------------------------------------------------------------
# self-test
# ---------------------------------------------------------------------------

SELFTEST_FAILURES=0

st_ok() { printf '  ok   - %s\n' "$1"; }
st_fail() {
  SELFTEST_FAILURES=$((SELFTEST_FAILURES + 1))
  printf '  FAIL - %s: %s\n' "$1" "$2" >&2
}
st_expect() {
  if [ "$2" = "$3" ]; then st_ok "$1"; else st_fail "$1" "expected [$2], got [$3]"; fi
}

# A repo shaped like the #3724 near-miss:
#
#   A ── B      main; B is #3717 re-anchoring the baseline
#    \
#     └─ C      the PR branch, which ALSO edits the baseline from base A
#
# `$1` receives the repo path. Leaves `main` and `pr` as local branches.
st_make_repo() {
  local dir="$1"
  # `git_scratch_init` rather than a bare `git init` + `config`: it disables
  # inherited hooks and signing, sets a fixture identity, and asserts the repo
  # really resolved to `$dir` before anything is committed into it.
  git_scratch_init "$dir"
  printf '1\n' > "$dir/dynamic-sql-baseline.txt"
  printf 'x\n' > "$dir/unrelated.rs"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m A
  git -C "$dir" branch pr
  # B — #3717 lands on main and moves the baseline.
  printf '2\n' > "$dir/dynamic-sql-baseline.txt"
  printf 'docs\n' > "$dir/tooling.md"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m 'B (#3717 re-anchors the baseline)'
  # C — the PR branch re-anchors the same file from base A.
  git -C "$dir" checkout --quiet pr
  printf '1-but-mine\n' > "$dir/dynamic-sql-baseline.txt"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m 'C (this PR re-anchors the same baseline)'
  git -C "$dir" checkout --quiet main
}

# Run this script inside a fixture repo. An exit code the contract does not
# define (127 "not found", 2, a shell error) is surfaced INTO stdout, so a
# broken invocation cannot be mistaken for the empty output that several
# assertions legitimately expect. That is not hypothetical: the first run of
# this file used a relative `$SELF`, every invocation died 127, and three
# assertions went green on the resulting empty string.
st_run() {
  local dir="$1" out rc
  shift
  out=$(cd "$dir" && bash "$SELF" "$@" 2>/dev/null)
  rc=$?
  if [ "$rc" -gt 1 ]; then
    printf '<<UNEXPECTED EXIT %s>>\n' "$rc"
    return 0
  fi
  printf '%s' "$out"
  # The contract's own 0/1 is preserved, because two assertions below are ABOUT
  # the exit code.
  return "$rc"
}

run_self_test() {
  local tmp
  tmp=$(mktemp -d -t pr-overlap-diverged-selftest.XXXXXX)
  # shellcheck disable=SC2064 # expand $tmp now, not at trap time
  trap "rm -rf '$tmp'" EXIT

  # BEFORE a single fixture command (#3722 — and #3736, where THIS FILE caused
  # it). This self-test is wired as a prek hook, so it runs inside the
  # pre-commit environment, where git exports GIT_DIR / GIT_INDEX_FILE /
  # GIT_WORK_TREE pointing at the REAL repository — and those OUTRANK the
  # `git -C "$dir"` used throughout the fixtures below. Unscrubbed, the first
  # `git -C "$dir" init` re-inits the developer's own repository instead of
  # creating the fixture, and every command after it lands there: identity
  # overwritten, `core.worktree` rewritten to a temp directory that is about
  # to be deleted, index left claiming every tracked file was deleted. All of
  # that happened.
  #
  # The guard is SHARED code, not a copy local to this script, because three
  # scripts already carried their own private version and none of them stopped
  # this one from repeating the failure. It scrubs, then verifies, then aborts
  # rather than proceeding on a polluted environment.
  # shellcheck source=scripts/lib/git-scratch-guard.sh
  . "$(dirname "$SELF")/lib/git-scratch-guard.sh"
  git_scratch_guard "$tmp"

  # ── 1. THE MERGE-REF TOPOLOGY, which is what CI actually checks out ──────
  local r1="$tmp/mergeref"
  mkdir -p "$r1"
  st_make_repo "$r1"
  # Synthesise `refs/pull/N/merge` exactly as GitHub does: a merge whose FIRST
  # parent is the base tip and whose second is the PR head. Detached, because
  # that is how the runner sits.
  local base_tip head_sha merge_ref
  base_tip=$(git -C "$r1" rev-parse main)
  head_sha=$(git -C "$r1" rev-parse pr)
  merge_ref=$(git -C "$r1" commit-tree -p "$base_tip" -p "$head_sha" \
    -m 'Merge pull request' "$(git -C "$r1" rev-parse 'pr^{tree}')")
  git -C "$r1" checkout --quiet --detach "$merge_ref"

  st_expect 'the fixture really is the merge-ref shape (parent 1 IS the base tip)' \
    "$base_tip" "$(git -C "$r1" rev-parse 'HEAD^1')"

  # THE BUG, pinned. The old formulation is `merge-base HEAD <base>`, and on
  # this topology it returns the base tip itself, so the diff is `X..X`. If
  # this assertion ever starts failing, the bug stopped being a bug and the
  # rest of this file can be simplified.
  local old_mb old_count
  old_mb=$(git -C "$r1" merge-base HEAD "$base_tip")
  old_count=$(git -C "$r1" diff --name-only "$old_mb" "$base_tip" | grep -c . || true)
  st_expect 'OLD formulation: merge-base(HEAD, base) IS the base tip' "$base_tip" "$old_mb"
  st_expect 'OLD formulation: therefore reports ZERO diverged files (empty by construction)' \
    '0' "$old_count"

  # …and the fix, on the same repo, with no arguments beyond the base ref —
  # so the merge-ref detection itself is what is under test.
  st_expect 'NEW: the head resolves to the PR head, not to the merge ref' \
    "$head_sha" "$(st_run "$r1" --print-head main)"
  st_expect 'NEW: the diverged set is the baseline file main moved under the branch' \
    'dynamic-sql-baseline.txt
tooling.md' "$(st_run "$r1" main)"

  # An explicit head sha (what the workflow passes) reaches the same answer by
  # the other route, so the two do not silently disagree.
  st_expect 'an explicit head sha wins and agrees with the detected one' \
    'dynamic-sql-baseline.txt
tooling.md' "$(st_run "$r1" main "$head_sha")"

  # ── 2. A PLAIN CHECKOUT of the branch (no merge ref) ─────────────────────
  local r2="$tmp/plain"
  mkdir -p "$r2"
  st_make_repo "$r2"
  git -C "$r2" checkout --quiet pr
  st_expect 'a plain branch checkout resolves to HEAD and still reports the divergence' \
    'dynamic-sql-baseline.txt
tooling.md' "$(st_run "$r2" main)"

  # ── 3. A BRANCH THAT MERGED main IN — the sibling rejection ──────────────
  # Also a two-parent HEAD. Taking `HEAD^2` blindly would yield the base tip
  # and compare the base branch against itself, which is the original bug
  # wearing a different hat. Parent 1 here is branch work, not base history.
  local r3="$tmp/merged-main"
  mkdir -p "$r3"
  st_make_repo "$r3"
  git -C "$r3" checkout --quiet pr
  # `-X ours`: both sides edit the baseline on purpose, so the merge conflicts.
  # An unresolved conflict would leave HEAD at C and the fixture would silently
  # stop being the shape under test — which is exactly what happened on the
  # first run of this file, and why the merge is now asserted below.
  git -C "$r3" merge --quiet --no-edit -X ours -m 'Merge main into the branch' main >/dev/null 2>&1
  if [ -z "$(git -C "$r3" rev-parse --verify --quiet 'HEAD^2' 2>/dev/null)" ]; then
    st_fail 'fixture: the branch really merged main in' 'HEAD is not a merge commit'
  fi
  st_expect 'a branch that merged main in is NOT mistaken for the merge ref' \
    "$(git -C "$r3" rev-parse HEAD)" "$(st_run "$r3" --print-head main)"
  st_expect 'and it reports nothing diverged, because it is now up to date' \
    '' "$(st_run "$r3" main)"

  # ── 4. NOT COMPUTED vs COMPUTED-AND-EMPTY ────────────────────────────────
  # The whole contract. An unresolvable base must exit non-zero with NOTHING
  # on stdout, so the caller writes no file; an up-to-date branch must exit 0
  # with an empty list, which is a real answer.
  local rc out
  out=$(st_run "$r3" no-such-branch); rc=$?
  st_expect 'an unresolvable base ref exits non-zero' '1' "$rc"
  st_expect 'and prints nothing, so the caller cannot mistake it for "none"' '' "$out"
  out=$(st_run "$r3" main); rc=$?
  st_expect 'an up-to-date branch exits ZERO with an empty list (a real answer)' '0' "$rc"

  # ── 5. Only files the BASE moved are reported ────────────────────────────
  # The branch's own edit to `dynamic-sql-baseline.txt` is not a divergence by
  # itself; `unrelated.rs` was touched by neither side. Without this the list
  # is every file in the diff and every PR carries a warning.
  st_expect 'a file neither side moved is absent from the list' \
    '' "$(st_run "$r1" main | grep -c 'unrelated.rs' | sed 's/^0$//')"

  # ── 6. THE POST-CONDITION on the REAL repository ─────────────────────────
  # Everything above built git repos. The guard is supposed to make that
  # harmless, and this is the assertion that says so out loud rather than
  # trusting it: `core.worktree` unset, and the checkout still resolvable.
  # Those are the two observable symptoms of the #3736 leak — a
  # `core.worktree` pointing at a deleted temp directory made every later
  # `git` in the repo die with "fatal: Invalid path", including the ones `gh`
  # shells out to.
  local repo_root
  repo_root="$(cd "$(dirname "$SELF")/.." && pwd -P)"
  st_expect 'the REAL repository has no core.worktree after all fixture work' \
    '' "$(git -C "$repo_root" config --local --get core.worktree 2>/dev/null || true)"
  st_expect 'the REAL repository still resolves its own toplevel' \
    "$repo_root" "$(git -C "$repo_root" rev-parse --show-toplevel 2>/dev/null || echo UNRESOLVABLE)"

  if [ "$SELFTEST_FAILURES" -gt 0 ]; then
    printf '\nself-test: %s assertion(s) failed\n' "$SELFTEST_FAILURES" >&2
    exit 2
  fi
  printf 'self-test: all assertions passed\n'
}

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

# ABSOLUTE, because the self-test `cd`s into each fixture repo before invoking
# this script. A relative path there resolves against the fixture and every
# invocation dies with "No such file or directory" — which, since the shell
# then reports empty output, made three assertions PASS for the wrong reason on
# the first run of this file. Hence `st_run`'s exit-code guard below as well.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

main() {
  local print_head=no
  if [ "${1:-}" = "--print-head" ]; then
    print_head=yes
    shift
  fi
  local base_ref="${1:-}" explicit="${2:-}"
  if [ -z "$base_ref" ]; then
    echo "pr-overlap-diverged: usage: $0 [--print-head] <base-ref> [<head-sha>]" >&2
    exit 1
  fi

  local base_tip head merge_base
  base_tip=$(resolve_base_tip "$base_ref") || {
    echo "pr-overlap-diverged: cannot resolve base ref '$base_ref'" >&2
    exit 1
  }
  head=$(resolve_head "$base_tip" "$explicit") || {
    echo "pr-overlap-diverged: cannot resolve a head commit" >&2
    exit 1
  }
  if [ "$print_head" = yes ]; then
    printf '%s\n' "$head"
    exit 0
  fi
  merge_base=$(git merge-base "$head" "$base_tip" 2>/dev/null) || {
    echo "pr-overlap-diverged: no merge base between $head and $base_tip" >&2
    exit 1
  }
  # An empty diff here IS the answer, and the exit code says so.
  git diff --name-only "$merge_base" "$base_tip" || {
    echo "pr-overlap-diverged: diff failed" >&2
    exit 1
  }
}

if [ "${1:-}" = "--self-test" ]; then
  run_self_test
else
  main "$@"
fi
