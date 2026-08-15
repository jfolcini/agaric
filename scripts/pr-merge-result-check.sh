#!/usr/bin/env bash
# #3672 steps 2/3 — verify the MERGE RESULT for a PR the overlap lane
# (scripts/pr-file-overlap.mjs / .github/workflows/pr-overlap.yml) has
# flagged as sharing or diverging on a whole-tree ratchet file.
#
# ─── Why this exists, and why it is scoped this narrowly ──────────────────
#
# #3672's own root cause: nothing verifies the merge RESULT before it
# becomes `main`. A PR's checks run against its own branch (or a merge ref
# GitHub computed when the workflow STARTED); neither is the tree that
# actually lands once `main` has moved further. The #3724 near-miss is the
# concrete shape: two branches each self-consistently re-anchor the same
# ratchet file from a common base, share no CONFLICTING line, merge with no
# textual conflict — and the merged tree is wrong anyway, in a guard, not a
# test. `git diff` cannot see this (scripts/pr-overlap-diverged.sh only
# reports which FILES moved); the only thing that can is running the guard
# ON THE ACTUAL MERGE.
#
# Running the full `prek --all-files` suite here (#3672 comment 3's step 3)
# needs the full Rust/Node toolchain this lane deliberately does not carry —
# that is the cost side of the issue's own option 1 (branch-protection
# "require up to date"), paid per-overlap instead of per-merge. This script
# runs the toolchain-free subset that actually polices whole-tree ratchet
# files: the Rust guard trio that shares the five-crate-root scan (#3107) —
# check-raw-tx, check-dynamic-sql, check-table-ownership — all stdlib-only
# Python, no cargo, no node_modules. `tauri-import-baseline` (node, needs
# node_modules), `unsafe-allowlist` and `migrations-immutable` (bash) are
# deliberately NOT run here yet; extending RATCHET_GUARDS to cover them is
# follow-up work, not a claim this script already makes.
#
# ─── What this does NOT replace, and what protection actually exists ───────
#
# `main` IS protected. `gh api repos/<owner>/<repo>/branches/main/protection`
# returns 404, but that endpoint is the LEGACY branch-protection API and it
# cannot see rulesets — reading its 404 as "unprotected" is the same defect
# this whole lane is about: a check reporting on something it structurally
# cannot observe. `gh api repos/<owner>/<repo>/branches/main --jq .protected`
# is `true`, and the real configuration lives in a ruleset that
# `.github/workflows/branch-protection-assert.yml` already asserts against
# drift: enforcement active on the default branch, required status-check
# contexts `validate-all` + `dco`, and — the relevant one —
# `strict_required_status_checks_policy: true`, which IS GitHub's "require
# branches to be up to date before merging".
#
# So #3672's option 1 is not a recommendation to adopt; it is the status
# quo. A merge that goes THROUGH the ruleset re-runs `validate-all` on the
# up-to-date tree, and `validate-all` runs `prek run --all-files`, ratchet
# guards included. This script is therefore NOT the protection nobody turned
# on. It is two narrower things:
#
#   1. The ruleset carries `bypass_actors: [{actor_id: 5, actor_type:
#      "RepositoryRole", bypass_mode: "always"}]` — role 5 is the built-in
#      `admin` role — and this repo merges with `gh pr merge --admin` in
#      practice, which #3672's own body already names as the reason the
#      freshness rule does not bite. An admin merge skips the required
#      checks AND the up-to-date requirement, so on precisely those merges
#      nothing verifies the merge result. This job cannot restore that —
#      nothing that is not a required check can — but it puts the ratchet
#      verdict on the PR BEFORE the bypass is used.
#   2. Strict makes you pay a rebase and a full ~15-minute re-run to learn
#      the answer. This costs a checkout, one `git merge` and three Python
#      invocations, and answers the ratchet half up front.
#
# Neither is "closing the hole". The residual hole is the bypass actor, and
# it closes by not merging with `--admin`, or by narrowing `bypass_actors` —
# a merge-policy decision, not a script. See #3672.
#
# ─── Contract ───────────────────────────────────────────────────────────────
#   exit 0 — computed, and every ratchet guard passed on the merged tree.
#   exit 1 — computed, and at least one guard FAILED on the merged tree
#            specifically. stdout/stderr names which guard and why.
#   exit 2 — NOT computed, and not this script's to judge: the merge
#            conflicted at the git level — a real textual conflict, which
#            GitHub's own merge check already refuses to let through. This
#            is the ONLY exit-2 case. Never conflate this with exit 0.
#   exit 3 — VERIFIED NOTHING: the check itself could not run, for a reason
#            that is this script's or the runner's fault, not a verdict on
#            the merge. Covers: base/head could not be resolved, `mktemp`
#            failed, `git worktree add` failed, a guard named in
#            RATCHET_GUARDS is absent from the merged tree, no `.rs` file
#            exists under any known crate root, or python3 is unavailable.
#            Split from exit 2 deliberately — 2 says "not mine to judge", 3
#            says "I judged nothing", and CI must treat 3 as a failure.
#            base/head resolution, mktemp, and `git worktree add` used to
#            share exit 2 with the genuine textual-conflict case — which
#            pr-overlap.yml renders as a `::warning::` on an otherwise GREEN
#            job, so a runner-side failure that verified nothing reported
#            the lane as passing. All of these cases returned **0** ("guards
#            pass on the actual merge") before this script's original
#            review, which is exactly how a guard goes quietly decorative.
#
# Usage:
#   scripts/pr-merge-result-check.sh <base-ref> <head-sha>
#   scripts/pr-merge-result-check.sh --self-test
#
# Run from inside the repo whose merge result is under test (the workflow
# runs it from the checkout root, exactly like pr-overlap-diverged.sh).
# Freshness is the CALLER's job — `git fetch origin <base-ref>` before
# invoking — mirroring pr-overlap-diverged.sh's own division of labour.

set -uo pipefail

# The Rust ratchet-guard trio, in the order they are cheapest to fail fast
# on. Each is a `language = "system"` prek hook (prek.toml) invoked exactly
# as `entry = "python3 scripts/<name>"` names it — this script calls the
# same entry point prek would, just against the merged tree's OWN copy of
# it (a merge can change the guard scripts too, and the merged tree's
# version is the one that matters).
RATCHET_GUARDS=(check-raw-tx.py check-dynamic-sql.py check-table-ownership.py)

CRATE_ROOTS=(
  src-tauri/src
  src-tauri/agaric-store/src
  src-tauri/agaric-engine/src
  src-tauri/agaric-sync/src
  src-tauri/diagnostics/src
)

# ---------------------------------------------------------------------------
# core
# ---------------------------------------------------------------------------

# Mirrors scripts/pr-overlap-diverged.sh's resolve_base_tip exactly, so the
# two scripts cannot silently disagree about what "the base" means.
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

mr_cleanup() {
  git worktree remove --force "$1" >/dev/null 2>&1 || true
  rm -rf "$2"
}

# Build a fresh merge of base-tip + head in a disposable worktree, run the
# ratchet-guard trio against it, and report. Never touches the caller's own
# working tree or index.
run_merge_check() {
  local base_ref="$1" head_sha="$2"
  local base_tip parent workdir

  # Checked BEFORE any work: the guards are stdlib-only Python, so without
  # python3 there is nothing to run. Reported as "verified nothing" rather
  # than as three guards "FAILING on the MERGED tree" — which is what a
  # missing interpreter produced before, an accusation against the PR for an
  # absent tool.
  if ! command -v python3 >/dev/null 2>&1; then
    echo "pr-merge-result-check: python3 is not on PATH — the ratchet guards are" >&2
    echo "  stdlib-only Python and cannot run at all. NOTHING was verified; this is" >&2
    echo "  neither a pass nor a finding against this PR." >&2
    return 3
  fi

  base_tip=$(resolve_base_tip "$base_ref") || {
    echo "pr-merge-result-check: cannot resolve base ref '$base_ref'" >&2
    echo "  NOTHING was verified — this is a runner/call-site failure, not a" >&2
    echo "  verdict on the merge, and CI must treat it as a failure, not a pass." >&2
    return 3
  }
  if ! git rev-parse --verify --quiet "${head_sha}^{commit}" >/dev/null 2>&1; then
    echo "pr-merge-result-check: cannot resolve head '$head_sha'" >&2
    echo "  NOTHING was verified — same reasoning as an unresolvable base ref." >&2
    return 3
  fi

  parent=$(mktemp -d -t pr-merge-result-check.XXXXXX) || {
    echo "pr-merge-result-check: mktemp failed" >&2
    echo "  NOTHING was verified — a runner-side failure, not a verdict on the PR." >&2
    return 3
  }
  # `git worktree add` must create the leaf directory itself, or it refuses
  # a non-empty target — mktemp -d already created $parent, so the worktree
  # goes one level below it, into a path git has never seen.
  workdir="$parent/wt"

  if ! git worktree add --quiet --detach "$workdir" "$base_tip" >/dev/null 2>&1; then
    echo "pr-merge-result-check: could not create a worktree at $base_tip" >&2
    echo "  NOTHING was verified — a runner-side failure, not a verdict on the PR." >&2
    # A `git worktree add` that fails partway can still register an entry
    # under this (the CALLER's) repo's .git/worktrees/ even though $workdir
    # itself never got fully populated — `rm -rf "$parent"` only removes the
    # working-tree files, not that administrative registration.
    #
    # A killed/interrupted `git worktree add` (an OOM-killed or timed-out
    # runner, not a clean refusal) leaves that registration marked `locked,
    # reason: initializing` — verified by hand with `timeout -s KILL` against
    # a large fixture. `git worktree prune` deliberately refuses to touch a
    # locked entry (that is what locking is for), so it alone would not
    # close this specific case. `git worktree remove --force --force`
    # (double force overrides a lock) is tried first for exactly that
    # reason; it is a no-op if nothing is registered at that path.
    git worktree remove --force --force "$workdir" >/dev/null 2>&1 || true
    # Remove the physical files, THEN prune, so `git worktree prune` (which
    # decides staleness by whether the linked path still exists on disk) can
    # see any OTHER orphaned-but-unlocked registration and clean it, instead
    # of leaking a stale entry into the repo this script was invoked from.
    rm -rf "$parent"
    git worktree prune >/dev/null 2>&1 || true
    return 3
  fi

  if ! git -C "$workdir" -c user.email=pr-merge-result-check@invalid \
      -c user.name='pr-merge-result-check' \
      merge --quiet --no-edit "$head_sha" >/dev/null 2>&1; then
    echo "pr-merge-result-check: base and head do NOT merge cleanly — a real" >&2
    echo "  textual conflict, which GitHub's own merge check already refuses" >&2
    echo "  to let through. Not computed by this script; not this script's job." >&2
    # The ONLY exit-2 case left in this script: everything above and below
    # this branch is exit 3 ("I judged nothing"); this is the one genuine
    # "not mine to judge".
    git -C "$workdir" merge --abort >/dev/null 2>&1 || true
    mr_cleanup "$workdir" "$parent"
    return 2
  fi

  local -a targets
  targets=()
  local root
  for root in "${CRATE_ROOTS[@]}"; do
    [ -d "$workdir/$root" ] || continue
    while IFS= read -r -d '' f; do
      targets+=("$f")
    done < <(find "$workdir/$root" -name '*.rs' -print0 2>/dev/null)
  done

  # Nothing to scan is NOT a pass. If the layout moved (a crate root renamed,
  # a new crate added and CRATE_ROOTS not updated) every guard below would be
  # handed an empty file list and report clean, and this script would print
  # "the ratchet guards pass on the ACTUAL merge" having read no source at
  # all. Measured, on a fixture whose crate root is `src-tauri/source`: exit
  # 0, no output, zero files examined.
  if [ "${#targets[@]}" -eq 0 ]; then
    echo "pr-merge-result-check: the merged tree carries no .rs file under ANY crate" >&2
    echo "  root this script knows about (${CRATE_ROOTS[*]}). The layout moved, or this" >&2
    echo "  is not that repository. NOTHING was verified — not a pass." >&2
    mr_cleanup "$workdir" "$parent"
    return 3
  fi

  local guard failures=0 missing=''
  for guard in "${RATCHET_GUARDS[@]}"; do
    local script="$workdir/scripts/$guard"
    if [ ! -f "$script" ]; then
      missing="${missing:+$missing }$guard"
      continue
    fi
    if ! python3 "$script" "${targets[@]}"; then
      echo "pr-merge-result-check: $guard FAILED on the MERGED tree" >&2
      failures=$((failures + 1))
    fi
  done

  mr_cleanup "$workdir" "$parent"

  # A guard that failed is the more actionable verdict, so it wins the exit
  # code; the absence note is still printed either way.
  if [ -n "$missing" ]; then
    echo "pr-merge-result-check: guard(s) named in RATCHET_GUARDS are ABSENT from the" >&2
    echo "  merged tree: $missing" >&2
    echo "  Either the guard was renamed and RATCHET_GUARDS was not, or the merge" >&2
    echo "  removed it. Previously this printed 'skipping' and still exited 0, i.e." >&2
    echo "  a mistyped guard name bought a green 'merge result verified'." >&2
  fi
  if [ "$failures" -gt 0 ]; then
    return 1
  fi
  if [ -n "$missing" ]; then
    return 3
  fi
  return 0
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

# Seed a fixture repo's scripts/ dir with the REAL guard scripts (not a
# stand-in) — the falsification below is only meaningful if it exercises
# the same code CI runs.
mr_seed_guards() {
  local dir="$1"
  mkdir -p "$dir/scripts"
  cp "$REPO_ROOT/scripts/check-raw-tx.py" "$dir/scripts/check-raw-tx.py"
  cp "$REPO_ROOT/scripts/check-dynamic-sql.py" "$dir/scripts/check-dynamic-sql.py"
  cp "$REPO_ROOT/scripts/check-table-ownership.py" "$dir/scripts/check-table-ownership.py"
}

# The CLEAN case: two branches each add ONE dynamic-SQL site to a
# DIFFERENT, previously-untracked file, and each baselines only its own
# addition. Both self-consistent; the merge stays consistent too, because
# neither branch's edit interacts with the other's.
#
# The base baseline file carries one PRE-EXISTING anchor entry (zzz.rs,
# touched by neither branch) so the two additions land as non-overlapping
# hunks (one before the anchor line, one after). Without an anchor, two
# branches each turning an EMPTY file into one differing line is exactly
# the git-merge shape with no surrounding context to place either
# insertion — verified live: it CONFLICTS ("both modified"), even though
# the two additions name different files and never interact. That is a
# property of git's line-based merge on an empty base, not of this script;
# the anchor line exists so the fixture demonstrates the case this script
# is actually for (two ratchet edits that are semantically independent)
# rather than an ordinary textual conflict GitHub's merge button already
# refuses on its own.
mr_make_clean_repo() {
  local dir="$1"
  git_scratch_init "$dir"
  mkdir -p "$dir/src-tauri/src"
  mr_seed_guards "$dir"
  printf 'pub fn noop() {}\n' > "$dir/src-tauri/src/lib.rs"
  printf 'pub fn z() { let _ = sqlx::query("SELECT 0"); }\n' > "$dir/src-tauri/src/zzz.rs"
  printf '1 src-tauri/src/zzz.rs\n' > "$dir/src-tauri/dynamic-sql-baseline.txt"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m base
  git -C "$dir" branch pr

  printf 'pub fn a() { let _ = sqlx::query("SELECT 1"); }\n' > "$dir/src-tauri/src/foo.rs"
  printf '1 src-tauri/src/foo.rs\n1 src-tauri/src/zzz.rs\n' > "$dir/src-tauri/dynamic-sql-baseline.txt"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m 'main: foo.rs +1, baselined (prepended)'

  git -C "$dir" checkout --quiet pr
  printf 'pub fn b() { let _ = sqlx::query("SELECT 2"); }\n' > "$dir/src-tauri/src/bar.rs"
  printf '1 src-tauri/src/zzz.rs\n1 src-tauri/src/bar.rs\n' > "$dir/src-tauri/dynamic-sql-baseline.txt"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m 'pr: bar.rs +1, baselined (appended)'
  git -C "$dir" checkout --quiet main
}

# The NEAR-MISS: the #3724 shape, minimised. Both branches edit the SAME
# file (shared.rs), at DIFFERENT non-overlapping lines, each adding one
# dynamic-SQL site and each (correctly, from ITS OWN base) baselining that
# file at 1. `git merge` auto-resolves both hunks with no conflict — the
# source edits don't overlap, and the two branches' baseline-file additions
# are IDENTICAL text from an identical (empty) base, which git also merges
# without conflict. The merged tree then has 2 dynamic-SQL sites in a file
# baselined at 1: neither branch is wrong, the MERGE is.
#
# The second argument is the crate root to build it under, defaulting to the
# real one. Passing a root this script does NOT know about produces the same
# near-miss content where `find` can never see it — the shape a repo-layout
# change makes, and the one that used to exit 0 having scanned no file.
mr_make_near_miss_repo() {
  local dir="$1"
  local root="${2:-src-tauri/src}"
  git_scratch_init "$dir"
  mkdir -p "$dir/$root"
  mr_seed_guards "$dir"
  printf 'pub fn top() {}\n\npub fn bottom() {}\n' > "$dir/$root/shared.rs"
  : > "$dir/src-tauri/dynamic-sql-baseline.txt"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m base
  git -C "$dir" branch pr

  printf 'pub fn top() { let _ = sqlx::query("SELECT 1"); }\n\npub fn bottom() {}\n' \
    > "$dir/$root/shared.rs"
  printf '1 %s/shared.rs\n' "$root" > "$dir/src-tauri/dynamic-sql-baseline.txt"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m 'main: shared.rs top()+1, baselined at 1'

  git -C "$dir" checkout --quiet pr
  printf 'pub fn top() {}\n\npub fn bottom() { let _ = sqlx::query("SELECT 2"); }\n' \
    > "$dir/$root/shared.rs"
  printf '1 %s/shared.rs\n' "$root" > "$dir/src-tauri/dynamic-sql-baseline.txt"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m 'pr: shared.rs bottom()+1, baselined at 1 (own base was 0)'
  git -C "$dir" checkout --quiet main
}

# FRESHNESS, made falsifiable. `resolve_base_tip` tries `origin/<ref>`
# BEFORE the bare local `<ref>` on purpose: on a CI checkout the local
# branch ref is whatever the checkout action left behind, while `origin/main`
# is what the caller just fetched. Nothing pinned that ordering — swapping
# the two candidates left every assertion in this file green, because the
# other fixtures have no remote at all and so cannot tell the two apart.
#
# This one can: `down`'s local `main` is deliberately pinned at the merge
# base (stale), while its `origin/main` carries the other branch's ratchet
# edit. Resolve the fresh ref and the near-miss appears; resolve the stale
# one and the merge looks clean.
mr_make_fresh_base_repo() {
  local dir="$1"
  local up="$dir/up" down="$dir/down"
  mr_make_near_miss_repo "$up"
  git_scratch_init "$down"
  git -C "$down" remote add origin "$up"
  git -C "$down" fetch --quiet origin '+refs/heads/*:refs/remotes/origin/*'
  git -C "$down" update-ref refs/heads/main "$(git -C "$up" rev-parse 'main^')"
  git -C "$down" update-ref refs/heads/pr "$(git -C "$up" rev-parse pr)"
}

run_self_test() {
  local tmp
  tmp=$(mktemp -d -t pr-merge-result-check-selftest.XXXXXX)
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  # #3722/#3736 — see scripts/lib/git-scratch-guard.sh. BEFORE any fixture
  # command, exactly like pr-overlap-diverged.sh.
  # shellcheck source=scripts/lib/git-scratch-guard.sh
  . "$(dirname "$SELF")/lib/git-scratch-guard.sh"
  git_scratch_guard "$tmp"

  # ── 0. THE REAL GUARD, run directly, pins the fixtures' shape ───────────
  # If these ever start failing, the fixtures stopped being the shape the
  # rest of this file assumes, and everything below would be testing
  # nothing.
  local clean="$tmp/clean"
  mkdir -p "$clean"
  mr_make_clean_repo "$clean"
  st_expect 'fixture sanity: the CLEAN case, main branch alone passes check-dynamic-sql' \
    '0' "$(python3 "$clean/scripts/check-dynamic-sql.py" "$clean/src-tauri/src"/*.rs >/dev/null 2>&1; echo $?)"

  local nearmiss="$tmp/nearmiss"
  mkdir -p "$nearmiss"
  mr_make_near_miss_repo "$nearmiss"
  git -C "$nearmiss" checkout --quiet main
  st_expect 'fixture sanity: the NEAR-MISS main branch alone passes check-dynamic-sql (self-consistent)' \
    '0' "$(python3 "$nearmiss/scripts/check-dynamic-sql.py" "$nearmiss/src-tauri/src"/*.rs >/dev/null 2>&1; echo $?)"
  git -C "$nearmiss" checkout --quiet pr
  st_expect 'fixture sanity: the NEAR-MISS pr branch alone ALSO passes check-dynamic-sql (self-consistent)' \
    '0' "$(python3 "$nearmiss/scripts/check-dynamic-sql.py" "$nearmiss/src-tauri/src"/*.rs >/dev/null 2>&1; echo $?)"
  git -C "$nearmiss" checkout --quiet main

  # ── 1. THE FALSIFICATION: this script, run end to end ───────────────────
  local rc

  ( cd "$clean" && bash "$SELF" main pr ) >"$tmp/clean.out" 2>"$tmp/clean.err"
  rc=$?
  st_expect 'CLEAN merge: pr-merge-result-check exits 0 (computed, guards pass)' '0' "$rc"

  ( cd "$nearmiss" && bash "$SELF" main pr ) >"$tmp/nearmiss.out" 2>"$tmp/nearmiss.err"
  rc=$?
  st_expect 'NEAR-MISS merge: pr-merge-result-check exits 1 (computed, a guard FAILED on the merge result)' \
    '1' "$rc"
  st_expect 'and it names the guard that failed and that it failed on the MERGED tree' \
    '1' "$(grep -c 'check-dynamic-sql.py FAILED on the MERGED tree' "$tmp/nearmiss.err" || true)"

  # The point of the whole fixture, stated as one assertion: the "fixture
  # sanity" checks above already proved BOTH branches pass the real guard
  # alone (exit 0 apiece); this section proved the SAME guard, same rules,
  # fails once given their merge (exit 1 above). That pairing — clean alone,
  # broken together — is the near-miss #3672 is about, not a guard that is
  # simply capable of failing.

  # ── 2. VERIFIED NOTHING (exit 3) vs the one genuine "not mine to judge"
  #      (exit 2) — the two must NOT share a code, or a runner-side failure
  #      renders as a `::warning::` on a job pr-overlap.yml still shows GREEN.
  local rc2
  ( cd "$clean" && bash "$SELF" no-such-branch pr ) >/dev/null 2>&1; rc2=$?
  st_expect 'an unresolvable base ref is exit 3 (verified nothing), NOT exit 2' '3' "$rc2"

  ( cd "$clean" && bash "$SELF" main deadbeefdeadbeefdeadbeefdeadbeefdeadbeef ) >/dev/null 2>&1; rc2=$?
  st_expect 'an unresolvable head sha is also exit 3 (verified nothing), NOT exit 2' '3' "$rc2"

  # ── 3. A REAL TEXTUAL CONFLICT is still exit 2, never exit 3 or a pass ──
  # Both branches edit the SAME LINE of the SAME file to different values —
  # GitHub's own merge check already refuses this; this script must say so
  # (exit 2, "not mine to judge") rather than report a false pass, AND
  # rather than exit 3 ("I judged nothing") — a real conflict is a genuine
  # verdict about the merge, distinct from a runner-side failure that
  # verified nothing. This is the ONE case that must still land on 2 after
  # the split above, so the pair (this assertion + the two above) pins BOTH
  # arms rather than just narrowing exit 2 without checking anything is left
  # in it.
  local conflict="$tmp/conflict"
  mkdir -p "$conflict"
  git_scratch_init "$conflict"
  mkdir -p "$conflict/src-tauri/src"
  mr_seed_guards "$conflict"
  printf 'pub fn noop() {}\n' > "$conflict/src-tauri/src/lib.rs"
  git -C "$conflict" add -A
  git -C "$conflict" commit --quiet -m base
  git -C "$conflict" branch pr
  printf 'pub fn noop() { /* main */ }\n' > "$conflict/src-tauri/src/lib.rs"
  git -C "$conflict" add -A
  git -C "$conflict" commit --quiet -m 'main edits the same line'
  git -C "$conflict" checkout --quiet pr
  printf 'pub fn noop() { /* pr */ }\n' > "$conflict/src-tauri/src/lib.rs"
  git -C "$conflict" add -A
  git -C "$conflict" commit --quiet -m 'pr edits the same line differently'
  git -C "$conflict" checkout --quiet main

  ( cd "$conflict" && bash "$SELF" main pr ) >/dev/null 2>&1; rc2=$?
  st_expect 'a real textual conflict is STILL exit 2, never exit 3 and never a pass' '2' "$rc2"

  # ── 2b. A `git worktree add` FAILURE is exit 3, and prunes any stale
  #        registration it finds in the CALLER's .git/worktrees/ ───────────
  # Build a repo, take a real worktree, and orphan it by removing only the
  # WORKING-TREE files (bypassing `git worktree remove`) — the same shape a
  # killed/interrupted `git worktree add` leaves behind (verified by hand:
  # `timeout -s KILL ... git worktree add` on a large fixture leaves a
  # LOCKED, registered-but-directory-less entry under .git/worktrees/).
  # Planting it here, deterministically, tests the mechanism this script
  # controls — does its OWN worktree-add-failure branch clean up staleness
  # in the repo it runs from — without depending on timing to reproduce the
  # rare git-side failure that first creates one.
  local prunecheck="$tmp/prunecheck"
  mkdir -p "$prunecheck"
  mr_make_clean_repo "$prunecheck"
  local stale_wt="$tmp/prunecheck-stale-wt"
  git -C "$prunecheck" worktree add --quiet --detach "$stale_wt" main >/dev/null 2>&1
  rm -rf "$stale_wt"
  st_expect 'fixture sanity: the orphaned worktree is a registered, stale entry before any run' \
    '1' "$(git -C "$prunecheck" worktree list | grep -c "$stale_wt" || true)"

  # Force THIS script's own `git worktree add` call to fail: make a stub
  # `mktemp` return a FIXED directory whose "wt" leaf is pre-created and
  # non-empty — `git worktree add` refuses a non-empty target outright
  # (verified by hand: this leaves .git/worktrees completely untouched by
  # itself, so any change to the pre-planted stale entry below is this
  # script's OWN cleanup, not a side effect of the collision).
  local fixed_parent="$tmp/fixed-parent"
  mkdir -p "$fixed_parent/wt"
  : > "$fixed_parent/wt/blocker"
  local stubdir="$tmp/mktemp-stub-bin"
  mkdir -p "$stubdir"
  cat > "$stubdir/mktemp" <<'STUB'
#!/usr/bin/env bash
# Stand-in for the real mktemp used ONLY by the worktree-add-failure/prune
# self-test above: always returns the SAME pre-arranged directory instead of
# a fresh unique one, so the test can pre-collide "$parent/wt" before the
# real script ever calls this.
mkdir -p "$MRTEST_FIXED_PARENT"
printf '%s\n' "$MRTEST_FIXED_PARENT"
STUB
  chmod +x "$stubdir/mktemp"

  local rc3
  ( cd "$prunecheck" && MRTEST_FIXED_PARENT="$fixed_parent" PATH="$stubdir:$PATH" \
      bash "$SELF" main pr ) >/dev/null 2>&1
  rc3=$?
  st_expect 'a git-worktree-add failure is exit 3 (verified nothing), NOT exit 2' '3' "$rc3"
  st_expect "the worktree-add-failure path prunes the CALLER repo's stale entry, not just its own" \
    '0' "$(git -C "$prunecheck" worktree list | grep -c "$stale_wt" || true)"

  # ── 3b. THE BASE IS THE FRESH ONE, not whatever ref is lying around ──────
  local fresh="$tmp/fresh"
  mkdir -p "$fresh"
  mr_make_fresh_base_repo "$fresh"
  ( cd "$fresh/down" && bash "$SELF" main pr ) >/dev/null 2>&1; rc2=$?
  st_expect 'the base resolves to origin/<ref>, so a stale local branch cannot hide the near-miss' \
    '1' "$rc2"
  # The contrast that makes the assertion above non-vacuous: the SAME repo,
  # the SAME head, resolved against the stale local ref instead, merges clean.
  ( cd "$fresh/down" && bash "$SELF" refs/heads/main pr ) >/dev/null 2>&1; rc2=$?
  st_expect 'and against the STALE local ref the same merge looks clean — which is the bug' \
    '0' "$rc2"

  # ── 3c. "VERIFIED NOTHING" (exit 3) is never a pass ──────────────────────
  # Each of these three exited 0 — "computed, and every ratchet guard passed
  # on the merged tree" — before #3672's review, having examined nothing.
  # The same near-miss tree — it exits 1 above — with the guard scripts
  # removed on the base side, so the merge result has none of them.
  local noguards="$tmp/noguards"
  mkdir -p "$noguards"
  mr_make_near_miss_repo "$noguards"
  git -C "$noguards" rm -q -r scripts
  git -C "$noguards" commit --quiet -m 'the guard scripts are gone'
  ( cd "$noguards" && bash "$SELF" main pr ) >/dev/null 2>&1; rc2=$?
  st_expect 'a guard named in RATCHET_GUARDS but absent from the merged tree is exit 3, not 0' \
    '3' "$rc2"

  # The same near-miss content under a crate root this script does not know
  # about — the shape a repo-layout change produces. Every guard would be
  # handed an empty file list and report clean.
  local moved="$tmp/moved"
  mkdir -p "$moved"
  mr_make_near_miss_repo "$moved" src-tauri/source
  ( cd "$moved" && bash "$SELF" main pr ) >/dev/null 2>&1; rc2=$?
  st_expect 'zero .rs files under any known crate root is exit 3, not a green "guards pass"' \
    '3' "$rc2"

  # python3 absent: the guards are stdlib-only Python, so there is nothing to
  # run. This used to print "<guard> FAILED on the MERGED tree" three times
  # and exit 1 — an accusation against the PR for a missing interpreter.
  local nopy="$tmp/nopy-bin"
  mkdir -p "$nopy"
  local p f b
  for p in /usr/bin /bin /usr/local/bin; do
    [ -d "$p" ] || continue
    for f in "$p"/*; do
      b=$(basename "$f")
      case "$b" in python3* | python) ;; *) ln -sf "$f" "$nopy/$b" 2>/dev/null || true ;; esac
    done
  done
  ( cd "$nearmiss" && bash "$SELF" main ) >/dev/null 2>&1; rc2=$?
  st_expect 'a call site that forgot an argument is exit 3, not an advisory exit 2' '3' "$rc2"

  local nopy_out
  nopy_out=$( cd "$nearmiss" && PATH="$nopy" bash "$SELF" main pr 2>&1 ); rc2=$?
  st_expect 'python3 missing is exit 3 (verified nothing), not exit 1 (a guard failed)' '3' "$rc2"
  st_expect 'and it does NOT claim a guard failed on the merged tree' \
    '0' "$(printf '%s' "$nopy_out" | grep -c 'FAILED on the MERGED tree' || true)"

  # ── 3d. THE INVOCATION, not just the body ────────────────────────────────
  # The script is only ever run from .github/workflows/pr-overlap.yml, and
  # that call site was broken in a way no assertion here could see: `run:`
  # executes under GitHub's default shell (`bash --noprofile --norc -e -o
  # pipefail {0}`), so a bare invocation followed by `rc=$?` ABORTS the step
  # on any non-zero exit and every branch below the exit-0 one was dead code.
  local wf="$REPO_ROOT/.github/workflows/pr-overlap.yml"
  st_expect 'the workflow that invokes this script exists' '1' \
    "$(test -f "$wf" && echo 1 || echo 0)"
  st_expect "the workflow's invocation captures the exit code -e-safely (|| rc=\$?)" '1' \
    "$(grep -c 'pr-merge-result-check\.sh "\$BASE_REF" "\$HEAD_SHA" || rc=\$?' "$wf" || true)"
  st_expect 'and the workflow branches on exit 3 (verified nothing) as a failure' '1' \
    "$(grep -c '"\$rc" -eq 3' "$wf" || true)"

  # ── 4. THE REAL REPOSITORY is untouched ──────────────────────────────────
  local repo_root
  repo_root="$(cd "$(dirname "$SELF")/.." && pwd -P)"
  st_expect 'the REAL repository has no core.worktree after all fixture work' \
    '' "$(git -C "$repo_root" config --local --get core.worktree 2>/dev/null || true)"
  st_expect 'the REAL repository still resolves its own toplevel' \
    "$repo_root" "$(git -C "$repo_root" rev-parse --show-toplevel 2>/dev/null || echo UNRESOLVABLE)"
  # Not a bare count (#3672's own repo legitimately carries several
  # concurrent worktrees) — specifically, none of THIS self-test's fixture
  # worktrees (under $tmp) may still be registered against the real repo.
  st_expect "the REAL repository's worktree list carries none of this self-test's fixture paths" \
    '' "$(git -C "$repo_root" worktree list | grep -F "$tmp" || true)"

  if [ "$SELFTEST_FAILURES" -gt 0 ]; then
    printf '\nself-test: %s assertion(s) failed\n' "$SELFTEST_FAILURES" >&2
    exit 2
  fi
  printf 'self-test: all assertions passed\n'
}

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
REPO_ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"

main() {
  local base_ref="${1:-}" head_sha="${2:-}"
  if [ -z "$base_ref" ] || [ -z "$head_sha" ]; then
    echo "pr-merge-result-check: usage: $0 <base-ref> <head-sha>" >&2
    # 3, not 2: a call site that forgot an argument verified nothing, and 2
    # is the code CI is allowed to treat as an advisory warning. A broken
    # invocation must be red.
    exit 3
  fi
  run_merge_check "$base_ref" "$head_sha"
}

if [ "${1:-}" = "--self-test" ]; then
  run_self_test
else
  main "$@"
fi
