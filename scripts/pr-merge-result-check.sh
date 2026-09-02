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
# files, PLUS one thing that is not toolchain-free and earns its keep
# anyway (the typecheck — see the #4078 section below): the Rust guard trio
# that shares the five-crate-root scan (#3107) —
# check-raw-tx, check-dynamic-sql, check-table-ownership — all stdlib-only
# Python, no cargo, no node_modules; plus (#3978) the three OTHER whole-tree
# ratchets that were previously left out — `unsafe-allowlist` and
# `migrations-immutable` (bash) and `tauri-import-baseline` (node — it
# imports nothing beyond the stdlib and `scripts/lib/js-scanner.mjs`, so
# despite the name it needs no `node_modules` either; ubuntu-24.04 runners
# carry `node` preinstalled). All six are invoked exactly as their own prek
# hook would (prek.toml's `entry =`), against the merged tree's OWN copy of
# each script — see `run_one_guard` below for the per-guard invocation
# shape, which differs because each guard resolves "which repo am I in"
# differently.
#
# ─── #4078 — the guards were the whole story, and that was the hole ───────
#
# Everything above verifies RATCHETS on the merge result. Nothing verified
# ORDINARY SOURCE, so the identical failure class in ordinary source walked
# straight through this script with a green "merge result verified".
#
# It happened on 2026-08-18. #4074 and #4075 were green on their own
# branches and merged minutes apart. #4074 consolidated the property seeds
# in `markdown-roundtrip.property.test.ts` and deleted `hasKnownIssue4049Drift`;
# #4075 added three properties to the SAME file still referencing both. The
# hunks were disjoint, so git merged them with no conflict, and the merged
# tree did not compile:
#
#   markdown-roundtrip.property.test.ts(860,42): error TS2304: Cannot find name 'NESTING_SEED'.
#   markdown-roundtrip.property.test.ts(916,17): error TS2304: Cannot find name 'hasKnownIssue4049Drift'.
#
# `main` sat un-compilable until a release build failed on it (#4077). Per-PR
# CI structurally cannot see this — it tests the branch, not the branch
# merged into whatever `main` has become. This script CAN see it, and until
# #4078 it declined to look.
#
# So the merged tree is now type-checked too, via `npm run typecheck` — the
# repo's SINGLE definition of "does this tree typecheck" (`tsc -b --noEmit`;
# tsconfig.json's own header explains why every gate must go through that
# one script rather than inventing a sixth spelling). It is deliberately not
# vitest and not cargo: both are minutes, the typecheck is seconds.
#
# ─── What that costs, measured, not guessed ───────────────────────────────
#
# On this repo at the time of writing (1757 tracked .ts/.tsx files, ~535k
# lines; TypeScript 7.0.2, the native compiler):
#
#   * `npm ci` on a GitHub ubuntu-24.04 runner, `actions/setup-node` npm
#     cache warm: 16-21 s (three sampled `_validate.yml` runs: 21 s, 19 s,
#     16 s). Paid ONCE, in the workflow, in the job checkout.
#   * `npm run typecheck` cold (no `.tsbuildinfo`) on the same runners:
#     7-8 s (`vitest-node22` step, two sampled runs: 8 s, 7 s). Locally on
#     a developer machine: 3.1-3.4 s.
#   * borrowing that install into the merged worktree (see
#     `provision_node_modules`): 0.03 s — ONE `ln -s` for ~710 top-level
#     entries, not one `ln` per entry.
#
# The `merge-result` job measured 23-25 s before this (two sampled
# `pr-overlap.yml` runs), so the whole typecheck stage roughly doubles a
# 25-second job to ~55-65 s, inside a 10-minute ceiling. That is the trade:
# ~35 s per PR against `main` sitting un-compilable until a release build
# notices.
#
# `node_modules` is BORROWED, not installed here. The workflow runs `npm ci`
# once in its own checkout — which for a `pull_request` event is
# `refs/pull/N/merge`, i.e. very nearly the tree this script computes — and
# `provision_node_modules` symlinks that install's top-level entries into
# the merged worktree. It is only "very nearly": if the merged tree's
# `package-lock.json` does NOT match the one the borrowed install came
# from, the borrowed tree is the wrong dependency set and a typecheck
# against it proves nothing about the merge. That case re-installs with
# `npm ci` IN the merged worktree rather than borrowing (rare: it needs
# `main`'s lockfile to move in the seconds between the job's checkout and
# this script's fetch), and if that cannot be done, it is exit 3 — verified
# nothing — never a quiet pass against the wrong deps.
#
# `CRATE_ROOTS` (the five-crate-root set the Python trio scans) used to be
# hand-duplicated here as a bash array, kept in sync by hand with the SAME
# list already declared in check-raw-tx.py. #3989: hand-duplicated copies
# drift, and when they did, this script's own "did we scan anything" check
# tested the BASH list's `find` output while each Python guard re-filters
# argv against ITS OWN list — so a drift let every guard silently reject
# every file it was handed and still exit 0, and this script printed "the
# ratchet guards pass on the ACTUAL merge" having read nothing. `CRATE_ROOTS`
# below is gone; `derive_crate_roots` reads the list straight out of the
# MERGED TREE's own check-raw-tx.py instead, so THIS script's file list
# cannot drift from what check-raw-tx.py itself accepts.
#
# Reading ONE guard's list closes the bash-vs-Python drift, not ALL of it.
# check-dynamic-sql.py and check-table-ownership.py each still declare their
# OWN CRATE_ROOTS — by deliberate REPLICATION, per their own comments, to
# avoid a dependency edge between the guards — so a crate root added to
# check-raw-tx.py and not to those two puts files in `targets` that THEY
# silently reject, and the same fail-open returned for those two guards:
# measured, on a fixture whose extra root `src-tauri/extra/src/` only
# check-raw-tx.py names, a genuine dynamic-SQL near-miss under it (2 sites,
# baseline 1) exited **0, "the ratchet guards pass"**, because `targets` was
# non-empty and so the zero-target check below never fired.
#
# So #3989's OTHER suggested fix is implemented too, and it is the one that
# covers all three: `count_examined` asserts each Python guard EXAMINED a
# non-zero number of files, computed from that guard's OWN CRATE_ROOTS (read
# out of the merged tree, same importlib route as `derive_crate_roots`) —
# never from a list this script declares. A guard that examined nothing
# cannot have verified anything, so a green verdict is refused (exit 3) when
# any of the three examined zero files. See `count_examined` for the exact
# per-guard counting rule and for the two residuals it does NOT close.
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
#   exit 0 — computed, and every ratchet guard passed on the merged tree,
#            AND the merged tree type-checks (#4078).
#   exit 1 — computed, and at least one guard FAILED on the merged tree
#            specifically. stdout/stderr names which guard and why.
#   exit 2 — NOT computed, and not this script's to judge: `git merge`
#            failed AND left actual unmerged paths behind (`git ls-files -u`
#            non-empty) — a real content conflict, which GitHub's own merge
#            check already refuses to let through. This is the ONLY exit-2
#            case. Never conflate this with exit 0.
#   exit 3 — VERIFIED NOTHING: the check itself could not run, for a reason
#            that is this script's or the runner's fault, not a verdict on
#            the merge. Covers: base/head could not be resolved, `mktemp`
#            failed, `git worktree add` failed, `git merge` failing for a
#            reason OTHER than a content conflict (unrelated histories, a
#            leftover index.lock, ENOSPC — non-zero exit but NO unmerged
#            paths), a guard named in RATCHET_GUARDS is absent from the
#            merged tree, a PREREQUISITE a present guard refuses to run
#            without is absent from the merged tree (#3989 — a missing
#            `scripts/lib/js-scanner.mjs`, `src-tauri/unsafe-allowlist.txt`
#            or `scripts/tauri-import-baseline.json` used to surface as
#            that guard "FAILING on the MERGED tree", i.e. exit 1, which
#            pr-overlap.yml renders as "a ratchet guard fails on the merge
#            result" and tells the author to merge main — wrong advice for
#            infrastructure breakage), one of the Python guards examined
#            ZERO files, no `.rs` file exists under any known crate root,
#            or python3 is unavailable. #4078 adds the typecheck stage's own
#            "could not run" cases to the same code: no `node_modules` to
#            borrow, the merged tree carries no `package.json` or no
#            `typecheck` script in it, the merged tree's `package-lock.json`
#            disagrees with the borrowed install's and cannot be reconciled,
#            or npm is unavailable. Every one of those is "the typecheck did
#            not happen", which must never render as "the merge type-checks".
#            Split from exit 2 deliberately — 2
#            says "not mine to judge", 3 says "I judged nothing", and CI
#            must treat 3 as a failure. base/head resolution, mktemp, `git
#            worktree add`, and (initially) EVERY non-zero `git merge` used
#            to share exit 2 with the genuine textual-conflict case — which
#            pr-overlap.yml renders as a `::warning::` on an otherwise GREEN
#            job, so a runner-side failure that verified nothing reported
#            the lane as passing. All of these cases returned **0** ("guards
#            pass on the actual merge") before this script's original
#            review, which is exactly how a guard goes quietly decorative.
#   exit 4 — computed, every ratchet guard passed, and the merged tree does
#            NOT TYPECHECK (#4078). Its own code rather than exit 1's on
#            purpose: pr-overlap.yml renders exit 1 as "a ratchet guard
#            fails on the merge result" and points the author at
#            `prek --all-files`, which is the wrong instrument and the
#            wrong reading for a TS2304 in ordinary source. The remedy is
#            the same shape (merge `main` in, re-run), but the author has
#            to be told WHAT broke to act on it, and a guard-shaped message
#            for a compiler error is how a real finding gets dismissed as
#            "the ratchet lane being noisy again". Exit 1 keeps precedence
#            when BOTH are true — a ratchet violation is the more specific
#            verdict and its guard names the file directly.
#            NOTE for anyone adding a code: pr-overlap.yml's `else` branch
#            catches everything it does not name, so an unnamed new code
#            silently inherits exit 1's guard wording. Add the branch there
#            in the same commit.
#
# Usage:
#   scripts/pr-merge-result-check.sh <base-ref> <head-sha>
#
# Run from inside the repo whose merge result is under test (the workflow
# runs it from the checkout root, exactly like pr-overlap-diverged.sh).
# Freshness is the CALLER's job — `git fetch origin <base-ref>` before
# invoking — mirroring pr-overlap-diverged.sh's own division of labour.

set -uo pipefail

# The six whole-tree ratchet guards this script runs (#3672, #3978), in the
# order they are cheapest to fail fast on. Each is a `language = "system"`
# prek hook (prek.toml) invoked exactly as its own `entry =` names it — this
# script calls the same entry point prek would, just against the merged
# tree's OWN copy of it (a merge can change the guard scripts too, and the
# merged tree's version is the one that matters). See `run_one_guard` for
# how each one is actually invoked — the shape differs per guard.
RATCHET_GUARDS=(
  check-raw-tx.py
  check-dynamic-sql.py
  check-table-ownership.py
  check-unsafe-allowlist.sh
  check-migrations-immutable.sh
  check-tauri-import-baseline.mjs
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
  local workdir="$1" parent="$2"
  # `remove --force --force` (double force overrides a lock) first, then
  # remove the physical files. This is called on every path through
  # run_merge_check that reaches a successfully-created worktree (the
  # conflict-abort branch and the ordinary success/failure-after-guards
  # branches), so it is the more heavily used of the two cleanup sites, not
  # the less.
  #
  # #3989: this used to ALSO run a bare `git worktree prune` as a backstop.
  # That reaches beyond this function's own leak — `remove --force --force`
  # above already closes it — into the CALLER's repo globally. A no-op in a
  # fresh CI checkout, but run locally in a repo carrying a legitimate
  # worktree whose directory is temporarily absent (an unmounted volume, an
  # external drive), a bare `prune` here would silently drop that
  # registration on every invocation of this script, for a worktree this
  # script never touched. The worktree-add-failure path below plants its
  # OWN `prune` deliberately, with its own reasoning — that one is scoped to
  # cleaning up staleness THIS SCRIPT'S OWN failed `git worktree add` can
  # leave in the caller's .git/worktrees/; this function has no equivalent
  # justification for reaching past its own worktree.
  git worktree remove --force --force "$workdir" >/dev/null 2>&1 || true
  rm -rf "$parent"
}

# Reads CRATE_ROOTS out of $1 (a path to a copy of ANY of the three Python
# guards) by importing it as a Python module — importlib, exactly the
# technique check-dynamic-sql.py and check-table-ownership.py themselves
# already use to load check-raw-tx.py's shared helpers, so this carries no
# new risk beyond what those two guards already do on every run. Only
# module-level statements execute (CRATE_ROOTS' own assignment, `re.compile`,
# function defs) — `if __name__ == "__main__":` is never entered under this
# loader name, so `main()` never runs.
#
# The three guards spell the SAME set three different ways, so this
# normalises rather than assuming one shape: check-raw-tx.py declares
# repo-relative strings with a trailing slash, check-dynamic-sql.py absolute
# `REPO_ROOT / …` Paths, check-table-ownership.py `(crate-label, Path)`
# TUPLES. Output is one repo-relative root per line, no trailing slash,
# whichever shape it came from.
#
# On failure it prints the CAUSE on stderr and exits non-zero (#3989 nit): a
# check-raw-tx.py that is present but BROKEN (a syntax error, a bad import)
# used to be swallowed by a `2>/dev/null` at the call site and reported as
# "the layout moved", which points the reader at the crate roots instead of
# at the traceback that actually explains it.
derive_crate_roots() {
  python3 -c '
import importlib.util, os, sys, traceback
path = sys.argv[1]
spec = importlib.util.spec_from_file_location("_pmrc_crate_roots", path)
mod = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(mod)
except Exception:
    print("could not import %s to read its CRATE_ROOTS:" % path, file=sys.stderr)
    traceback.print_exc()
    sys.exit(1)
roots = getattr(mod, "CRATE_ROOTS", None)
if not roots:
    print("%s defines no non-empty CRATE_ROOTS list" % path, file=sys.stderr)
    sys.exit(1)
repo_root = str(getattr(mod, "REPO_ROOT",
                        os.path.dirname(os.path.dirname(os.path.abspath(path)))))
for r in roots:
    # (crate-label, Path) tuples — check-table-ownership.py.
    if isinstance(r, (tuple, list)):
        r = r[-1]
    r = str(r)
    if os.path.isabs(r):
        r = os.path.relpath(r, repo_root)
    print(r.strip("/"))
' "$1"
}

# Prerequisites: files a guard that IS present refuses to run without, and
# the guard that needs each one (#3989). A missing prerequisite is NOT a
# ratchet violation — it is infrastructure breakage, and mapping it to exit 1
# ("a ratchet guard fails on the merge result") tells the PR author to merge
# main and re-run prek for something their diff did not cause. Measured
# before this table existed: a merged tree missing scripts/lib/js-scanner.mjs
# exited 1 with a raw ERR_MODULE_NOT_FOUND stack trace; missing
# src-tauri/unsafe-allowlist.txt and missing scripts/tauri-import-baseline.json
# exited 1 with the guard's own ERROR line and a "FAILED on the MERGED tree"
# verdict on top of it.
#
# Keyed by the OWNING guard, and only checked when that guard is present, so
# a tree with no scripts/ at all still gets the ABSENT-guard message (which
# is the more fundamental diagnosis) rather than a prerequisite one.
#
# js-scanner.mjs is not itself in RATCHET_GUARDS — it is a library the mjs
# guard imports, so it can never appear in the ABSENT-guard note, which is
# exactly why it needs naming here.
#
# scripts/tauri-sanctioned-symbols.json is here for a DIFFERENT reason than
# the other three: the guard's own readSanctioned() does not hard-error on
# its absence, it silently degrades to an empty Set (see that function's own
# comment). Left off this table, a merged tree missing the file does not
# fail closed the way the other prerequisites do — it runs the guard to
# completion and gets a WRONG answer: every file whose only @/lib/tauri
# dependency was a sanctioned symbol now reads as a brand-new importer, so
# the guard reports "FAILED on the MERGED tree" over infrastructure
# breakage the PR did not cause. That is worse than the other three, which
# at least fail LOUDLY (a stack trace or the guard's own ERROR line) — this
# one fails with a plausible-looking wrong verdict. Listing it here routes
# that same breakage through check_prereqs' exit-3 "nothing was verified"
# path instead, before the guard ever runs.
RATCHET_PREREQS=(
  'check-unsafe-allowlist.sh|src-tauri/unsafe-allowlist.txt|the allowlist it ratchets against'
  'check-tauri-import-baseline.mjs|scripts/lib/js-scanner.mjs|the shared scanner it imports'
  'check-tauri-import-baseline.mjs|scripts/tauri-import-baseline.json|the baseline it ratchets against'
  'check-tauri-import-baseline.mjs|scripts/tauri-sanctioned-symbols.json|the sanctioned-symbols list a missing copy of which silently turns sanctioned-only importers into false new-importer verdicts'
  'check-tauri-import-baseline.mjs|src/|the frontend tree it scans'
  # All three Python guards load this by PATH at import time (#4017). Absent,
  # they die with a FileNotFoundError traceback — exit 1, which this script
  # would otherwise read as "the guard FAILED on the merged tree": a content
  # verdict about a merge, from a guard that never ran. Same shape as the
  # js-scanner.mjs entry above, and the same remedy.
  'check-raw-tx.py|scripts/lib/guard_file_source.py|the file-source helper it loads at import time'
  'check-dynamic-sql.py|scripts/lib/guard_file_source.py|the file-source helper it loads at import time'
  'check-command-arity.py|scripts/lib/guard_file_source.py|the file-source helper it loads at import time'
)

# Returns 0 if every prerequisite of every PRESENT guard exists in the merged
# tree; otherwise names the first missing one on stderr and returns 3.
check_prereqs() {
  local workdir="$1" entry guard path why target
  for entry in "${RATCHET_PREREQS[@]}"; do
    guard="${entry%%|*}"
    path="${entry#*|}"
    why="${path#*|}"
    path="${path%%|*}"
    [ -f "$workdir/scripts/$guard" ] || continue
    target="$workdir/${path%/}"
    case "$path" in
      */) [ -d "$target" ] && continue ;;
      *) [ -f "$target" ] && continue ;;
    esac
    echo "pr-merge-result-check: the merged tree is missing a PREREQUISITE, not a guard:" >&2
    echo "  $path — $why (needed by $guard)" >&2
    echo "  NOTHING was verified. This is infrastructure breakage in the merged tree," >&2
    echo "  not a ratchet violation in this PR: the guard cannot run at all, so it has" >&2
    echo "  no verdict to give. Reported as 3, never as 1 — exit 1 renders as 'a ratchet" >&2
    echo "  guard fails on the merge result', which would tell the author to merge main" >&2
    echo "  and re-run prek for a problem their diff did not cause." >&2
    return 3
  done
  return 0
}

# How many files did $1 (a Python guard, by filename) actually EXAMINE in the
# merged tree? Prints the count; returns non-zero (having explained itself on
# stderr) if the guard's own CRATE_ROOTS could not be read at all. #3989.
#
# The count is computed from the guard's OWN CRATE_ROOTS — read out of the
# merged tree by `derive_crate_roots` above — so it cannot drift from what
# that guard accepts, which is the whole point: the three guards replicate
# the crate-root list deliberately, and a root added to one and not the
# others is precisely the drift that made every file this script handed the
# other two get silently rejected.
#
# Two counting rules, because the guards do not agree on where their input
# comes from:
#   check-table-ownership.py — ignores argv entirely and rescans its own
#     crate roots off the filesystem (ownership is an AGGREGATE invariant;
#     see its main()). So the count is a filesystem scan under ITS roots.
#   the other two                — filter the argv they are handed against
#     their own roots, so the count is |targets ∩ its own roots|. Counting a
#     filesystem scan for these would over-report: a file that exists under
#     the guard's roots but was never PASSED to it was not examined.
#
# RESIDUALS, named rather than left to be reconstructed:
#   * root membership is the last filter this can reproduce without
#     duplicating each guard's exclusion logic (test globs, `#![cfg(test)]`
#     whole-file modules, bin globs). A guard handed files that its
#     EXCLUSIONS then drop all of would still count non-zero here.
#   * "examined something" is not "examined the file that mattered". In a
#     tree that ALSO carries .rs under the shared roots, a near-miss under a
#     root only check-raw-tx.py names is still missed by the other two — the
#     count is non-zero because of the other files. This closes the total
#     fail-open (a guard reading NOTHING and reporting clean), not partial
#     under-coverage. The single-list fix above is what closes that for
#     check-dynamic-sql/check-table-ownership, and it is why both fixes are
#     here rather than either alone.
count_examined() {
  local guard="$1" workdir="$2" errfile="$3"
  shift 3
  local -a roots=()
  local root f n=0
  while IFS= read -r root; do
    [ -n "$root" ] && roots+=("$root")
  done < <(derive_crate_roots "$workdir/scripts/$guard" 2>"$errfile")
  if [ "${#roots[@]}" -eq 0 ]; then
    cat "$errfile" >&2
    return 1
  fi
  case "$guard" in
    check-table-ownership.py)
      for root in "${roots[@]}"; do
        # No `[ -d ] || continue` here. `find` on a missing directory prints
        # nothing (its error is already discarded below), so the count is
        # identical either way — and this file is the one removing that
        # construct from the guard it invokes. Leaving the last copy in place
        # is how the next reader learns to skip a root that vanished.
        while IFS= read -r -d '' f; do
          n=$((n + 1))
        done < <(find "$workdir/$root" -type f -name '*.rs' -print0 2>/dev/null)
      done
      ;;
    *)
      for f in "$@"; do
        for root in "${roots[@]}"; do
          case "$f" in
            "$workdir/$root/"*)
              n=$((n + 1))
              break
              ;;
          esac
        done
      done
      ;;
  esac
  printf '%s\n' "$n"
  return 0
}

# Invokes exactly one ratchet guard against the merged tree, the way its own
# prek hook would (prek.toml's `entry =`) — but the six guards do not share
# one invocation shape, only a common "run against the merged tree" intent:
#
#   *.py                          — python3 <script> <crate-root targets>.
#   check-unsafe-allowlist.sh     — bash <script>, no args, but it calls
#                                    `git rev-parse --show-toplevel` which
#                                    resolves off CWD, not the script's own
#                                    path — must run with cwd = the worktree.
#   check-migrations-immutable.sh — bash <script> --range BASE...HEAD, cwd =
#                                    the worktree, same cwd-off-git reason.
#                                    The default (no `--range`) mode inspects
#                                    the STAGED index, which is empty in a
#                                    freshly merged worktree — it would pass
#                                    vacuously, having examined nothing
#                                    (#3978's own note). `--range` from the
#                                    merge base ($base_tip) to HEAD (the
#                                    merge commit) is the mode that actually
#                                    inspects what this merge did.
#                                    THREE dots, not two, because that is the
#                                    form this guard's own CI call site uses
#                                    and the form its `--range` contract is
#                                    written against. Here the two are
#                                    genuinely EQUIVALENT — $base_tip is a
#                                    direct PARENT of the merge commit, so
#                                    the merge base of the pair is $base_tip
#                                    itself — which is why no assertion below
#                                    pins the third dot: an equivalence that
#                                    does not hold in general is not a
#                                    property to assert.
#   *.mjs                         — node <script>, no args; it resolves its
#                                    own root from import.meta.dirname (its
#                                    OWN path), so cwd does not matter — but
#                                    its sibling scripts/lib/js-scanner.mjs
#                                    import resolves the same way, so both
#                                    must exist together in the merged tree.
run_one_guard() {
  local guard="$1" workdir="$2" base_tip="$3"
  shift 3
  case "$guard" in
    check-raw-tx.py | check-dynamic-sql.py)
      # `--worktree` is EXPLICIT, never left to the guards' AUTO rule (#4017).
      # A merged tree exists only as files in a worktree and was never staged,
      # so "the staged index" has no meaning for it; AUTO keys on
      # `GIT_INDEX_FILE`, which under a commit hook names the COMMITTING
      # repository's index. The guards refuse that combination (exit 2).
      python3 "$workdir/scripts/$guard" --worktree "$@"
      ;;
    check-table-ownership.py)
      # No source flags: it ignores argv for FILE selection and rescans its
      # own crate roots off the filesystem, so it only ever reads the
      # worktree in the first place.
      python3 "$workdir/scripts/$guard" "$@"
      ;;
    *.py)
      python3 "$workdir/scripts/$guard" "$@"
      ;;
    check-unsafe-allowlist.sh)
      ( cd "$workdir" && bash "scripts/$guard" )
      ;;
    check-migrations-immutable.sh)
      ( cd "$workdir" && bash "scripts/$guard" --range "${base_tip}...HEAD" )
      ;;
    *.mjs)
      # Deliberately NOT wrapped in `( cd "$workdir" && … )` like the two
      # bash guards: the claim above is that this guard is cwd-INDEPENDENT,
      # and a cd here would make that claim untestable by satisfying it
      # accidentally.
      node "$workdir/scripts/$guard"
      ;;
    *)
      # An unknown guard must be a hard FAILURE, never a silent pass:
      # returning 0 here would let a typo in RATCHET_GUARDS — or a new guard
      # added to the list with no invocation rule written for it — buy a
      # green "merge result verified" from a guard that never ran.
      echo "pr-merge-result-check: internal error — no invocation rule for guard '$guard'" >&2
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# typecheck (#4078)
# ---------------------------------------------------------------------------

# Where to borrow an already-installed `node_modules` from.
#
# `MR_NODE_MODULES` exists so a scratch fixture repo (which has no install of
# its own, and `npm ci`-ing one would put the network in the middle of the
# run) can point at another checkout's install. CI never sets it: the
# default — the caller repo's own toplevel, which the workflow has just run
# `npm ci` in — is the path that actually ships.
resolve_node_modules_source() {
  local src="${MR_NODE_MODULES:-}"
  if [ -z "$src" ]; then
    local toplevel
    toplevel=$(git rev-parse --show-toplevel 2>/dev/null) || return 1
    src="$toplevel/node_modules"
  fi
  [ -d "$src" ] || return 1
  ( cd "$src" && pwd -P )
}

# Give the merged worktree a `node_modules` without paying for an install.
#
# Symlinks every TOP-LEVEL entry of the borrowed install (packages, scoped
# `@scope` directories, and `.bin`) into a REAL directory in the worktree.
# Real directory, not a symlink to the whole tree, because the tsconfigs put
# `tsBuildInfoFile` under `./node_modules/.tmp/` — with a whole-tree symlink
# that write lands in the borrowed install and clobbers the caller's own
# incremental state. Here `.tmp` is created inside the disposable worktree
# and dies with it.
#
# ONE `ln -s` for the whole set, not one `ln` per entry: measured 0.03 s
# vs 1.28 s for ~710 entries, and this runs inside a prek hook.
#
# Node resolves symlinks by default, so each borrowed package finds its own
# dependencies back in the borrowed install — the same mechanism npm
# workspaces rely on.
#
# #4169 (follow-up 5): this deliberately diverges from scripts/seed-worktree.sh
# (its node_modules step, ~line 108 on), which gives a worktree a whole-TREE
# symlink and hard-errors on a REAL node_modules directory (issue #3171 --
# `ln -s` nesting inside it produces confusing TS2688 vite/client + node
# failures). That divergence is intentional, for the reason above
# (tsBuildInfoFile under ./node_modules/.tmp/), not something to reconcile by
# copying either shape into the other.
provision_node_modules() {
  local workdir="$1" src="$2"
  # `src/*/` expands to package and @scope directories; `.bin` is named
  # explicitly because it is a dotfile. The dot-directories deliberately NOT
  # borrowed are build state, not resolution input: `.tmp` (tsbuildinfo, the
  # whole point above), `.cache`, `.vite`, `.vite-temp`.
  #
  # Each candidate is `[ -e ]`-tested — a shell builtin, so this stays a
  # single process for the whole set — because `ln -s` creates DANGLING
  # links without complaint. An unmatched glob would otherwise arrive here
  # as the literal pattern and become a symlink named `*`, and an empty
  # borrow source would then look successfully provisioned.
  local -a entries=()
  local e
  for e in "$src"/*/ "$src/.bin"; do
    [ -e "$e" ] || continue
    entries+=("${e%/}")
  done
  # A borrowed install with nothing in it is not an install. Without this, an
  # empty `src` would send an un-resolvable tree to tsc and every import in
  # the repo would come back as a type error — a full-red "this merge does
  # not compile" that is nothing of the sort.
  [ "${#entries[@]}" -gt 0 ] || return 1
  mkdir -p "$workdir/node_modules" || return 1
  # `ln -s -t DIR -- srcs` is a GNU coreutils extension; BSD/macOS `ln` has no
  # -t and errors "illegal option -- t", which would make provision_node_modules
  # fail and run_typecheck return 3 on macOS (a supported dev platform,
  # docs/BUILD.md). The
  # multi-source-into-directory form below is in both GNU and BSD ln, and is
  # still ONE process.
  ln -s -- "${entries[@]}" "$workdir/node_modules" || return 1
  return 0
}

# Do the merged tree's dependencies match the install we are about to
# borrow? Byte-compare the two lockfiles. Returns 0 when they agree (borrow
# is sound), 1 when they both exist but their CONTENT differs (borrowing
# would type-check the merge against the wrong dependency set), 2 when the
# merged tree has NO lockfile at all because the merge itself deleted one
# that existed on a parent (#4176 — a different claim from 1: there is no
# merged-tree lockfile left to differ FROM, so callers must not describe
# this as a content mismatch).
#
# A lockfile MISSING on either side is "agree", not "disagree" — WITH ONE
# EXCEPTION (#4169 follow-up 2). A merged tree that never had a
# `package-lock.json` makes no dependency claim for the borrowed install to
# contradict, and whether a tree ought to have one is some other lane's
# business, not this stage's — this stage answers "does it compile".
# Fixtures rely on this: a scratch repo in /tmp has no lockfile of its own
# and must still be able to borrow.
#
# But a merged tree whose lockfile EXISTED on either parent and is simply
# GONE from the merge result is a different claim entirely: the merge
# deleted it. Borrowing there would type-check "the ACTUAL merge" against a
# dependency set the merge no longer declares — a half verdict rendered as a
# full one. `base_tip`/`head_sha` distinguish the two: checked against the
# MERGED workdir's own object store (a shared clone, so both are reachable
# from it), not against the working tree, so this needs no extra checkout.
lockfiles_agree() {
  local workdir="$1" src_root="$2" base_tip="$3" head_sha="$4"
  local a="$workdir/package-lock.json" b="$src_root/package-lock.json"
  if [ ! -f "$a" ]; then
    if git -C "$workdir" cat-file -e "${base_tip}:package-lock.json" 2>/dev/null ||
       git -C "$workdir" cat-file -e "${head_sha}:package-lock.json" 2>/dev/null; then
      return 2
    fi
    return 0
  fi
  [ -f "$b" ] || return 0
  # `cmp -s` exits 2, not just 0/1, on TROUBLE unrelated to content — e.g. a
  # permission error or other I/O failure opening a file the `-f` checks
  # above already confirmed exists. Propagating that raw would collide with
  # THIS function's own explicit `return 2` above, which means something far
  # narrower and more specific: no merged-tree lockfile exists AT ALL because
  # the merge deleted it. Both files are confirmed present by this point, so
  # cmp trouble here is an anomaly, not a deletion — collapse it into 1
  # ("differs"), the pre-existing generic fallback that re-installs and
  # type-checks for real, rather than a `2` that would misroute into the
  # #4176 "the merge result has no package-lock.json" message for a file
  # that is, in fact, present.
  local cmp_rc=0
  cmp -s "$a" "$b" || cmp_rc=$?
  [ "$cmp_rc" -le 1 ] && return "$cmp_rc"
  return 1
}

# Type-check the merged tree.
#
#   0 — the merged tree type-checks
#   1 — it does not (a real finding: the #4078 shape)
#   3 — could not be established (never a pass — see the Contract)
#
# Invoked as `npm run typecheck`, from the MERGED tree's own package.json,
# for the same reason every guard above runs the merged tree's own copy of
# itself: a merge can change what "typecheck" means, and the merged tree's
# definition is the one that matters.
run_typecheck() {
  local workdir="$1" base_tip="$2" head_sha="$3"

  if [ ! -f "$workdir/package.json" ]; then
    echo "pr-merge-result-check: the merged tree has no package.json, so there is no" >&2
    echo "  typecheck to run. The layout moved, or this is not that repository." >&2
    echo "  NOTHING was type-checked — reported as 3, not as a pass." >&2
    return 3
  fi
  # `npm run <missing-script>` exits non-zero, which would arrive here
  # indistinguishable from "the merged tree does not compile". Ask first.
  if ! node -e '
const p = JSON.parse(require("fs").readFileSync(process.argv[1] + "/package.json", "utf8"))
process.exit(p.scripts && p.scripts.typecheck ? 0 : 1)
' "$workdir" 2>/dev/null; then
    echo "pr-merge-result-check: the merged tree's package.json defines no \`typecheck\`" >&2
    echo "  script. That script is the repo's single definition of 'does this tree" >&2
    echo "  compile' (see tsconfig.json's header); without it this stage has nothing" >&2
    echo "  to invoke. Either it was renamed — rename it here too — or the merge" >&2
    echo "  removed it. NOTHING was type-checked." >&2
    return 3
  fi
  if [ ! -f "$workdir/tsconfig.json" ]; then
    echo "pr-merge-result-check: the merged tree has no tsconfig.json for \`tsc -b\` to" >&2
    echo "  read. tsc would fail for that reason and this stage would report it as" >&2
    echo "  'the merge does not typecheck', blaming the PR for a missing config file." >&2
    echo "  NOTHING was type-checked." >&2
    return 3
  fi

  local src_root src
  if ! src=$(resolve_node_modules_source); then
    echo "pr-merge-result-check: no installed \`node_modules\` to type-check against." >&2
    echo "  This script borrows the caller repo's install rather than running its own" >&2
    echo "  \`npm ci\` (pr-overlap.yml installs once, in the job checkout). If you are" >&2
    echo "  running this by hand, \`npm ci\` first, or point MR_NODE_MODULES at an" >&2
    echo "  existing install. NOTHING was type-checked — this is a runner/call-site" >&2
    echo "  gap, not a verdict on the merge." >&2
    return 3
  fi
  src_root=$(dirname "$src")

  local lockfiles_rc=0
  lockfiles_agree "$workdir" "$src_root" "$base_tip" "$head_sha" || lockfiles_rc=$?
  if [ "$lockfiles_rc" -eq 0 ]; then
    if ! provision_node_modules "$workdir" "$src"; then
      echo "pr-merge-result-check: could not link the borrowed node_modules ($src)" >&2
      echo "  into the merged worktree, or it is empty. NOTHING was type-checked." >&2
      return 3
    fi
  elif [ "$lockfiles_rc" -eq 2 ]; then
    # #4176: the merge itself DELETED package-lock.json — it exists at
    # base_tip and/or head_sha but not in the merged tree. There is no
    # merged-tree lockfile left to differ from the borrowed one, so the
    # "differs" wording below would be false, and the subsequent `npm ci`
    # has nothing to install FROM (no lockfile at all), not a content
    # mismatch. That is the merge's own change, i.e. the PR's — not a
    # runner or script gap — so this points at the PR, unlike the generic
    # `npm ci` failure message the "differs" branch falls into below.
    #
    # The wording stays AGNOSTIC about intent. This branch fires on any
    # merge whose result lacks a lockfile a parent had, and that includes a
    # PR that drops `package-lock.json` ON PURPOSE — a package-manager
    # migration, say. "Restore or regenerate it" is simply the wrong
    # instruction there, so the message states the consequence (this lane
    # cannot type-check the merge) and leaves the remedy to the author,
    # which covers both the accidental deletion and the deliberate one. The
    # exit code is 3 either way: not a verdict on the merge, and never a
    # silent pass.
    echo "pr-merge-result-check: the merge result has no package-lock.json — one" >&2
    echo "  exists at $base_tip and/or $head_sha but not in the merged tree, so" >&2
    echo "  there is nothing for \`npm ci\` to install from. That is the merge's own" >&2
    echo "  change, not a script or runner problem. NOTHING was type-checked." >&2
    echo "  If the deletion was unintended, restore or regenerate the lockfile. If" >&2
    echo "  the PR drops it deliberately (a package-manager migration, say), this" >&2
    echo "  lane cannot judge the merge as written and needs teaching about the new" >&2
    echo "  lockfile — either way the fix is in the PR, not in this script." >&2
    return 3
  else
    # The borrowed install is for a DIFFERENT lockfile. Do not type-check
    # the merge against dependencies it does not declare — install the ones
    # it does. Rare by construction (see the #4078 header), and loud when it
    # cannot be done rather than quietly borrowing anyway.
    echo "pr-merge-result-check: the merged tree's package-lock.json differs from" >&2
    echo "  $src_root/package-lock.json, so the install there is the wrong dependency" >&2
    echo "  set to judge this merge by. Installing the merged tree's own instead." >&2
    if ! command -v npm >/dev/null 2>&1; then
      echo "pr-merge-result-check: npm is not on PATH, so that install cannot happen." >&2
      echo "  NOTHING was type-checked; this is a runner-side gap, not a verdict." >&2
      return 3
    fi
    if ! ( cd "$workdir" && npm ci ) >&2; then
      echo "pr-merge-result-check: \`npm ci\` FAILED in the merged tree. That is an" >&2
      echo "  install failure, not a type error — reported as 3, never as 4, because" >&2
      echo "  exit 4 tells the author their merge does not compile and nothing here" >&2
      echo "  has established that either way. NOTHING was type-checked." >&2
      return 3
    fi
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo "pr-merge-result-check: npm is not on PATH — \`npm run typecheck\` cannot run." >&2
    echo "  NOTHING was type-checked; this is a runner-side gap, not a verdict." >&2
    return 3
  fi
  # stdout AND stderr to stderr: this script's stdout is otherwise silent on
  # success, and tsc writes its diagnostics to stdout. The workflow tees the
  # whole job log into the step summary, so the actual TS errors have to
  # reach the log rather than be swallowed by a `>/dev/null`.
  if ! ( cd "$workdir" && npm run --silent typecheck ) >&2; then
    return 1
  fi
  return 0
}

# Build a fresh merge of base-tip + head in a disposable worktree, run the
# ratchet guards against it, and report. Never touches the caller's own
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
  # #3978: check-tauri-import-baseline.mjs needs `node`. Same "verified
  # nothing, not a per-guard skip" reasoning as the python3 check above —
  # this script reports ALL SIX guards or none, not a partial result that
  # would read as a pass on the five it could run.
  if ! command -v node >/dev/null 2>&1; then
    echo "pr-merge-result-check: node is not on PATH — the tauri-import-baseline" >&2
    echo "  guard needs it. NOTHING was verified; this is neither a pass nor a" >&2
    echo "  finding against this PR." >&2
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

  local merge_out merge_rc
  merge_out=$(git -C "$workdir" -c user.email=pr-merge-result-check@invalid \
      -c user.name='pr-merge-result-check' \
      merge --quiet --no-edit "$head_sha" 2>&1)
  merge_rc=$?
  if [ "$merge_rc" -ne 0 ]; then
    # NOT every non-zero `git merge` is a content conflict: unrelated
    # histories (verified live: `fatal: refusing to merge unrelated
    # histories`, exit 128, ZERO unmerged paths), a leftover index.lock,
    # ENOSPC, and others all exit non-zero here too. Returning 2 for ALL of
    # them was the same conflation this script exists to close, left open
    # on this one line — pr-overlap.yml renders 2 as a `::warning::` with no
    # `exit 1`, so any of those would report the lane GREEN having verified
    # nothing. `ls-files -u` is the actual signal: non-empty means git
    # genuinely attempted the merge and left conflict markers/stages behind,
    # which is the ONLY case that is truly "not mine to judge".
    if [ -n "$(git -C "$workdir" ls-files -u)" ]; then
      echo "pr-merge-result-check: base and head do NOT merge cleanly — a real" >&2
      echo "  textual conflict, which GitHub's own merge check already refuses" >&2
      echo "  to let through. Not computed by this script; not this script's job." >&2
      printf '%s\n' "$merge_out" >&2
      # The ONLY exit-2 case left in this script: everything above and below
      # this branch is exit 3 ("I judged nothing"); this is the one genuine
      # "not mine to judge".
      git -C "$workdir" merge --abort >/dev/null 2>&1 || true
      mr_cleanup "$workdir" "$parent"
      return 2
    fi
    echo "pr-merge-result-check: git merge failed for a reason OTHER than a" >&2
    echo "  content conflict (no unmerged paths left behind) — unrelated" >&2
    echo "  histories, a leftover index.lock, disk space, or similar." >&2
    echo "  NOTHING was verified; this is a runner-side failure, not a" >&2
    echo "  verdict on the PR." >&2
    printf '%s\n' "$merge_out" >&2
    git -C "$workdir" merge --abort >/dev/null 2>&1 || true
    mr_cleanup "$workdir" "$parent"
    return 3
  fi

  # A prerequisite a PRESENT guard cannot run without is infrastructure
  # breakage, not a ratchet violation (#3989). Checked before anything is
  # run, so the answer is "nothing was verified", not "your merge broke a
  # guard".
  if ! check_prereqs "$workdir"; then
    mr_cleanup "$workdir" "$parent"
    return 3
  fi

  # #3989: CRATE_ROOTS is read from the MERGED TREE's own check-raw-tx.py —
  # not hand-duplicated here — so the file list built below is, by
  # construction, exactly what check-raw-tx.py's under_crate_root() itself
  # accepts. See derive_crate_roots and the header comment above.
  local -a crate_roots=()
  local crate_root_script="$workdir/scripts/check-raw-tx.py"
  local roots_errfile="$parent/crate-roots.err"
  : > "$roots_errfile"
  if [ -f "$crate_root_script" ]; then
    while IFS= read -r root; do
      # Same guard as count_examined's sibling loop over this same output
      # (#4005 review): an empty element here would make the `find
      # "$workdir/$root" -type f -name '*.rs'` below sweep the whole
      # worktree instead of scanning nothing, which is the wrong failure
      # mode for a blank line derive_crate_roots should never emit.
      # Unreachable today; the two loops doing the same job must not diverge.
      [ -n "$root" ] && crate_roots+=("$root")
    done < <(derive_crate_roots "$crate_root_script" 2>"$roots_errfile")
  fi

  # A check-raw-tx.py that is PRESENT but unreadable (a syntax error, a
  # broken import, no CRATE_ROOTS at all) is a different fault from "the
  # layout moved", and the `2>/dev/null` that used to sit on the call above
  # discarded the only evidence that said which (#3989 nit): the traceback
  # went nowhere and the reader was told the crate roots had changed.
  if [ -f "$crate_root_script" ] && [ "${#crate_roots[@]}" -eq 0 ]; then
    echo "pr-merge-result-check: could not read CRATE_ROOTS out of the merged tree's" >&2
    echo "  own scripts/check-raw-tx.py. It is PRESENT but did not yield a crate-root" >&2
    echo "  list — a syntax error, a broken import, or a renamed constant, NOT 'the" >&2
    echo "  layout moved'. NOTHING was verified. The cause, verbatim:" >&2
    sed 's/^/    /' "$roots_errfile" >&2
    mr_cleanup "$workdir" "$parent"
    return 3
  fi

  local -a targets
  targets=()
  local root
  for root in "${crate_roots[@]}"; do
    [ -d "$workdir/$root" ] || continue
    while IFS= read -r -d '' f; do
      targets+=("$f")
    done < <(find "$workdir/$root" -type f -name '*.rs' -print0 2>/dev/null)
  done

  # Nothing to scan is NOT a pass. If the layout moved (a crate root renamed,
  # a new crate added and check-raw-tx.py's CRATE_ROOTS not updated) every
  # guard below would be handed an empty file list and report clean, and
  # this script would print "the ratchet guards pass on the ACTUAL merge"
  # having read no source at all. Measured, on a fixture whose crate root is
  # `src-tauri/source`: exit 0, no output, zero files examined.
  #
  # Skipped when check-raw-tx.py itself is ABSENT (as opposed to present but
  # genuinely matching nothing): that is not "the layout moved", it is "a
  # RATCHET_GUARDS entry is missing", and the ABSENT-guard note below — not
  # this one — must be the message that governs the exit code, so the
  # missing-guard loop below still gets to run (and still names
  # check-raw-tx.py, and still lets check-dynamic-sql.py / check-table-
  # ownership.py's own crash-on-missing-import get invoked and diagnosed,
  # same as before #3989).
  if [ "${#targets[@]}" -eq 0 ] && [ -f "$crate_root_script" ]; then
    echo "pr-merge-result-check: the merged tree carries no .rs file under ANY crate" >&2
    echo "  root check-raw-tx.py's own CRATE_ROOTS names in the merged tree. The" >&2
    echo "  layout moved, or this is not that repository. NOTHING was verified." >&2
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
    if ! run_one_guard "$guard" "$workdir" "$base_tip" "${targets[@]}"; then
      echo "pr-merge-result-check: $guard FAILED on the MERGED tree" >&2
      failures=$((failures + 1))
    fi
  done

  # How many files did each Python guard actually EXAMINE? Computed BEFORE
  # cleanup (it needs the merged tree) and judged after, so the more
  # fundamental diagnoses below still get to win the exit code. Only the
  # three Python guards can be probed this way — the other three do not
  # declare a file-set constant that could be read back out of the merged
  # tree; check-unsafe-allowlist.sh and check-tauri-import-baseline.mjs
  # discover their own inputs by walking the tree, and
  # check-migrations-immutable.sh reads a commit range, so for those three
  # "did it examine anything" has no counterpart to interrogate here. The
  # missing-PREREQUISITE check above is what covers their fail-open shape:
  # each of them hard-errors rather than passing vacuously when the file set
  # it walks is gone.
  local -a examine_probe_guards=(
    check-raw-tx.py
    check-dynamic-sql.py
    check-table-ownership.py
  )
  local probe cnt examined_zero='' examined_unreadable=''
  for probe in "${examine_probe_guards[@]}"; do
    [ -f "$workdir/scripts/$probe" ] || continue
    if cnt=$(count_examined "$probe" "$workdir" "$parent/examined.err" "${targets[@]}"); then
      [ "$cnt" -eq 0 ] && examined_zero="${examined_zero:+$examined_zero }$probe"
    else
      examined_unreadable="${examined_unreadable:+$examined_unreadable }$probe"
    fi
  done

  # #4078 — type-check the merged tree. LAST, and deliberately so: it is the
  # only stage that writes into the worktree (`node_modules/`), and the
  # guards above walk that tree. Nothing they scan lives under a root
  # `node_modules/`, so the order is belt-and-braces rather than load-bearing
  # — but "the cheap read-only checks all ran before anything mutated the
  # tree" is a property worth not having to re-derive later.
  #
  # #4169 follow-up 4: gated on the two verdicts below that ALREADY return
  # before `typecheck_rc` is ever consulted (`missing` at 3, `failures` at 1,
  # both further down). Running the tsc invocation (~8 s in CI, plus the
  # `npm run` startup cost) when its result cannot change the exit code pays
  # for a verdict without using it. Every current exit code is byte-identical
  # with this gate in place — `missing`/`failures` still win the same way
  # below, `typecheck_rc` simply stays 0 (never consulted on those paths).
  local typecheck_rc=0
  if [ -z "$missing" ] && [ "$failures" -eq 0 ]; then
    run_typecheck "$workdir" "$base_tip" "$head_sha" || typecheck_rc=$?
  fi

  mr_cleanup "$workdir" "$parent"

  # The absence note wins the exit code, NOT the failure count. Originally
  # this checked failures first on the theory that "a guard failed" is the
  # more actionable verdict — but check-dynamic-sql.py and
  # check-table-ownership.py both importlib-load check-raw-tx.py FROM THE
  # MERGED TREE (shared helpers), so if check-raw-tx.py alone is missing,
  # BOTH of the others crash (FileNotFoundError, non-zero exit) and get
  # counted as "failures" too — failures=2, missing=check-raw-tx.py, and
  # checking failures first returned 1: "a ratchet guard fails on the merge
  # result", telling the author to merge main and re-run prek for an
  # infrastructure problem that is not their diff. A guard absence can
  # cause OTHER guards to fail as a side effect; a guard failure can never
  # cause another guard to go missing. That asymmetry is why missing must
  # be checked first — it is the more fundamental "verified nothing"
  # regardless of how many guards crashed because of it.
  if [ -n "$missing" ]; then
    echo "pr-merge-result-check: guard(s) named in RATCHET_GUARDS are ABSENT from the" >&2
    echo "  merged tree: $missing" >&2
    echo "  Either the guard was renamed and RATCHET_GUARDS was not, or the merge" >&2
    echo "  removed it. Previously this printed 'skipping' and still exited 0, i.e." >&2
    echo "  a mistyped guard name bought a green 'merge result verified'." >&2
    return 3
  fi
  if [ "$failures" -gt 0 ]; then
    return 1
  fi

  # #4078, and in THIS position on purpose.
  #
  # BELOW the guard-failure check: a ratchet violation names a file and a
  # line and is the more specific verdict, so it keeps precedence when both
  # are true. ABOVE the examined-count checks, and above the final `return
  # 0`: a merge that does not compile must never be reported as "the merge
  # result is verified", which is exactly what it was until #4078.
  #
  # Note the asymmetry with `missing` at the top: the typecheck's own
  # "verified nothing" (3) sits HERE, not up there, because unlike a guard
  # absence it cannot have CAUSED the guard failures above it. Reporting 3
  # ahead of a genuine ratchet finding would tell the author "the check is
  # broken, not your PR" about a violation that is, in fact, their PR.
  if [ "$typecheck_rc" -eq 3 ]; then
    echo "pr-merge-result-check: the ratchet guards passed on the merged tree, but the" >&2
    echo "  TYPECHECK could not run (cause above). Half a verdict is not a pass —" >&2
    echo "  #4078 exists because a merged tree that did not compile was reported green." >&2
    return 3
  fi
  if [ "$typecheck_rc" -ne 0 ]; then
    echo "pr-merge-result-check: the MERGED tree does not TYPECHECK (#4078). The tsc" >&2
    echo "  diagnostics are above. Only the MERGE is type-checked here, so confirm" >&2
    echo "  \`validate / typecheck\` is green on this PR before concluding the merge is" >&2
    echo "  at fault — a head that is already broken produces the same message." >&2
    return 4
  fi

  # Only a PASS is gated on the examined counts, and deliberately in this
  # position: a guard that found a real violation examined something by
  # definition, and a violation is the more actionable verdict, so exit 1
  # above still wins. What must not happen is the reverse — a green
  # "the ratchet guards pass on the ACTUAL merge" from a guard that read
  # nothing. #3989's measured case: an extra crate root named only by
  # check-raw-tx.py, a genuine dynamic-SQL near-miss under it, `targets`
  # non-empty (so the zero-target check above never fired) and
  # check-dynamic-sql.py / check-table-ownership.py rejecting every file
  # they were handed — exit 0, "guards pass", nothing read.
  if [ -n "$examined_unreadable" ]; then
    echo "pr-merge-result-check: could not determine how many files these guard(s)" >&2
    echo "  examined: $examined_unreadable" >&2
    echo "  Their own CRATE_ROOTS could not be read out of the merged tree (cause" >&2
    echo "  above). A guard whose scanned file set cannot be established has not been" >&2
    echo "  shown to verify anything, so this is NOT a pass. NOTHING was verified." >&2
    return 3
  fi
  if [ -n "$examined_zero" ]; then
    echo "pr-merge-result-check: these guard(s) EXAMINED ZERO FILES and therefore" >&2
    echo "  passed vacuously: $examined_zero" >&2
    echo "  Each Python guard re-filters what it is handed against its OWN CRATE_ROOTS," >&2
    echo "  so a crate root that exists in one guard's list and not another's leaves" >&2
    echo "  the others rejecting every file — clean exit, nothing read. That is a" >&2
    echo "  fail-open, not a pass: NOTHING was verified for the guard(s) named." >&2
    echo "  Fix the crate-root lists (they are replicated by hand across" >&2
    echo "  check-raw-tx.py, check-dynamic-sql.py and check-table-ownership.py), or" >&2
    echo "  the repo layout, so every guard is handed source it accepts." >&2
    return 3
  fi
  return 0
}

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

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

main "$@"
