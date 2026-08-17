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
#   exit 0 — computed, and every ratchet guard passed on the merged tree.
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
#            or python3 is unavailable. Split from exit 2 deliberately — 2
#            says "not mine to judge", 3 says "I judged nothing", and CI
#            must treat 3 as a failure. base/head resolution, mktemp, `git
#            worktree add`, and (initially) EVERY non-zero `git merge` used
#            to share exit 2 with the genuine textual-conflict case — which
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
        [ -d "$workdir/$root" ] || continue
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
      # A merged tree is a hypothetical: it exists as files in a worktree and
      # was never staged anywhere, so "the staged index" has no meaning for
      # it. AUTO keys on `GIT_INDEX_FILE`, which under a commit hook names
      # the COMMITTING repository's index — a different tree entirely. The
      # guards now refuse that combination (exit 2) rather than guess, so
      # omitting this flag would be an invocation error rather than a wrong
      # verdict; naming it means this call site does not depend on either
      # behaviour, and reads the same under prek, under CI and by hand.
      python3 "$workdir/scripts/$guard" --worktree "$@"
      ;;
    *.py)
      # check-table-ownership.py has no source flags: it ignores argv and
      # rescans its own crate roots off the filesystem, so it only ever reads
      # the worktree in the first place.
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
      # accidentally. Pinned as source text in the self-test, because the
      # two forms are behaviourally identical for a guard that really is
      # cwd-independent — the assertion exists to keep the CLAIM honest.
      node "$workdir/scripts/$guard"
      ;;
    *)
      # An unknown guard must be a hard FAILURE, never a silent pass:
      # returning 0 here would let a typo in RATCHET_GUARDS — or a new guard
      # added to the list with no invocation rule written for it — buy a
      # green "merge result verified" from a guard that never ran. Pinned by
      # calling this function directly in the self-test.
      echo "pr-merge-result-check: internal error — no invocation rule for guard '$guard'" >&2
      return 1
      ;;
  esac
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
# the same code CI runs. Covers all six RATCHET_GUARDS (#3978) plus the
# prerequisite files/dirs each of the three newer ones refuses to run
# without (a MISSING allowlist/baseline file is a hard ERROR for those
# guards, not a vacuous pass) — so every existing fixture below, seeded
# through this one function, keeps getting a clean verdict from all six
# guards unless a fixture deliberately breaks one of them.
mr_seed_guards() {
  local dir="$1"
  mkdir -p "$dir/scripts/lib" "$dir/src-tauri" "$dir/src"
  cp "$REPO_ROOT/scripts/check-raw-tx.py" "$dir/scripts/check-raw-tx.py"
  cp "$REPO_ROOT/scripts/check-dynamic-sql.py" "$dir/scripts/check-dynamic-sql.py"
  cp "$REPO_ROOT/scripts/check-table-ownership.py" "$dir/scripts/check-table-ownership.py"
  cp "$REPO_ROOT/scripts/check-unsafe-allowlist.sh" "$dir/scripts/check-unsafe-allowlist.sh"
  cp "$REPO_ROOT/scripts/check-migrations-immutable.sh" "$dir/scripts/check-migrations-immutable.sh"
  cp "$REPO_ROOT/scripts/check-tauri-import-baseline.mjs" "$dir/scripts/check-tauri-import-baseline.mjs"
  cp "$REPO_ROOT/scripts/lib/js-scanner.mjs" "$dir/scripts/lib/js-scanner.mjs"
  # The three Python guards load this by PATH, relative to their own
  # directory, on every run (#4017) — so a fixture that seeds the guards but
  # not this file gives all three a FileNotFoundError at import time. That is
  # exit 1 with a traceback, which this script reads as "the guard FAILED on
  # the merged tree", i.e. a content verdict about a merge, produced by a
  # guard that never ran. It is declared in RATCHET_PREREQS as well, so the
  # same absence in a REAL merged tree is reported as the infrastructure gap
  # it is rather than as a merge failure.
  cp "$REPO_ROOT/scripts/lib/guard_file_source.py" "$dir/scripts/lib/guard_file_source.py"
  # unsafe-allowlist.sh hard-errors (exit 1) if this file is absent at all;
  # empty is a legitimate "nothing allowlisted yet" state.
  : > "$dir/src-tauri/unsafe-allowlist.txt"
  # tauri-import-baseline.mjs hard-errors (exit 2) if src/ or the baseline
  # file is absent; an empty array is a legitimate "no importers yet" state.
  printf '[]\n' > "$dir/scripts/tauri-import-baseline.json"
  # readSanctioned() does NOT hard-error on this file's absence (it degrades
  # to an empty Set) — but RATCHET_PREREQS now treats it as required for
  # THIS script's purposes (#3989 note 1), so every fixture needs one too,
  # same as the two files above. An empty array is a legitimate "nothing
  # sanctioned yet" state.
  printf '[]\n' > "$dir/scripts/tauri-sanctioned-symbols.json"
  # git does not track empty directories — without a tracked file inside
  # it, `src/` above would vanish the moment this fixture is committed and
  # re-checked out in a worktree, and the guard's own `fs.existsSync(SRC_DIR)`
  # would then hard-error on every fixture that never adds a real `src/`
  # file of its own (every one of them except the tauri-import fixtures).
  : > "$dir/src/.gitkeep"
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

# #3989's fix, pinned behaviourally: `targets` is built from CRATE_ROOTS as
# read out of the MERGED TREE's OWN check-raw-tx.py, not a bash constant.
# Simulates a crate-root rename that updated check-raw-tx.py's CRATE_ROOTS
# (the one list this script now reads) by appending a reassignment onto the
# copied file — Python executes top to bottom, so this simply rebinds the
# module-level name after the real definition runs, no other side effects.
# An UNMANAGED raw-tx call (check-raw-tx.py's own violation shape, not
# dynamic-sql's baseline-count shape) lives under the renamed root on the
# `pr` branch; the merge must fail because check-raw-tx.py's OWN (patched)
# CRATE_ROOTS says to scan that root, not because this script hand-declares
# it anywhere.
mr_make_crateroots_rename_repo() {
  local dir="$1"
  local newroot="src-tauri/renamed/src"
  git_scratch_init "$dir"
  mkdir -p "$dir/$newroot"
  mr_seed_guards "$dir"
  # The override MUST land BEFORE `if __name__ == "__main__":`, not merely
  # appended at end-of-file: `sys.exit(main(...))` inside that block returns
  # before a plain `cat >>` addition below it is ever reached when the file
  # runs as a SCRIPT (this guard's own entry point) — only an IMPORT (as
  # derive_crate_roots itself uses) skips past `__main__` and would reach
  # it. A fixture that only worked for the importer and not the real
  # invocation would validate nothing about run_one_guard's own python3
  # call.
  python3 - "$dir/scripts/check-raw-tx.py" "$newroot" <<'PYEOF'
import sys
path, newroot = sys.argv[1], sys.argv[2]
src = open(path, encoding="utf-8").read()
marker = 'if __name__ == "__main__":'
assert marker in src, "check-raw-tx.py layout changed; fixture needs updating"
patch = (
    "\n# TEST-ONLY override (pr-merge-result-check.sh self-test, #3989):\n"
    "# simulate a crate-root rename that this fixture's file layout uses.\n"
    f'CRATE_ROOTS = ["{newroot}/"]\n\n\n'
)
src = src.replace(marker, patch + marker, 1)
open(path, "w", encoding="utf-8").write(src)
PYEOF
  printf 'pub fn top() {}\n\npub fn bottom() {}\n' > "$dir/$newroot/shared.rs"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m base
  git -C "$dir" branch pr

  git -C "$dir" checkout --quiet pr
  printf 'pub fn top() { let _ = begin_with(&pool); }\n\npub fn bottom() {}\n' \
    > "$dir/$newroot/shared.rs"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m 'pr: an unmanaged raw-tx call under the renamed root'
  git -C "$dir" checkout --quiet main
}

# #3978: unsafe-allowlist wired into THIS harness, invoked exactly as
# run_one_guard calls it (cwd = the worktree, since the script resolves its
# repo root off cwd via `git rev-parse --show-toplevel`, not off its own
# path). main adds unrelated, safe code; pr introduces a file carrying
# `#![allow(unsafe_code)]` with no matching entry in
# src-tauri/unsafe-allowlist.txt. Different files, clean merge; the merged
# tree still carries the unlisted unsafe file.
mr_make_unsafe_allowlist_break_repo() {
  local dir="$1"
  git_scratch_init "$dir"
  mkdir -p "$dir/src-tauri/src"
  mr_seed_guards "$dir"
  printf 'pub fn noop() {}\n' > "$dir/src-tauri/src/lib.rs"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m base
  git -C "$dir" branch pr

  printf 'pub fn ok() {}\n' > "$dir/src-tauri/src/ok.rs"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m 'main: unrelated safe file'

  git -C "$dir" checkout --quiet pr
  printf '#![allow(unsafe_code)]\npub unsafe fn danger() {}\n' > "$dir/src-tauri/src/bad.rs"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m 'pr: unsafe file with no allowlist entry'
  git -C "$dir" checkout --quiet main
}

# #3978: migrations-immutable wired into THIS harness with `--range` — the
# default staged-index mode sees nothing staged in a freshly merged
# worktree and would pass vacuously, having examined nothing (the exact
# note in the issue). base ships one migration; main adds an unrelated
# SECOND migration (a legitimate ADD, self-consistent); pr, from the SAME
# base, MODIFIES the FIRST shipped migration's content — the append-only
# violation. Different files, clean merge; the merged tree still carries
# pr's modification to a shipped migration.
mr_make_migrations_break_repo() {
  local dir="$1"
  git_scratch_init "$dir"
  mkdir -p "$dir/src-tauri/src" "$dir/src-tauri/migrations"
  mr_seed_guards "$dir"
  printf 'pub fn noop() {}\n' > "$dir/src-tauri/src/lib.rs"
  printf 'CREATE TABLE a(x);\n' > "$dir/src-tauri/migrations/0001_a.sql"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m base
  git -C "$dir" branch pr

  printf 'CREATE TABLE b(x);\n' > "$dir/src-tauri/migrations/0002_b.sql"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m 'main: a new, legitimate migration'

  git -C "$dir" checkout --quiet pr
  printf 'CREATE TABLE a(x, y);\n' > "$dir/src-tauri/migrations/0001_a.sql"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m 'pr: edits a shipped migration'
  git -C "$dir" checkout --quiet main
}

# #3978: tauri-import-baseline wired into THIS harness — and, unlike the two
# fixtures above, genuinely near-miss-shaped (#3724's own shape), because it
# carries a STATE FILE (tauri-import-baseline.json) both branches edit from
# a shared base, the same way dynamic-sql-baseline.txt does for the
# original trio. main "migrates" shared.ts off the wrapper — removes its
# only import AND (correctly, from its OWN view) removes shared.ts from the
# baseline, since after ITS edit the file no longer depends on the wrapper
# at all. pr, unaware, independently adds a SECOND, unrelated import
# elsewhere in the SAME file — a real thing a concurrent PR can do — and
# does NOT touch the baseline, because from pr's own view shared.ts was
# ALREADY baselined in the base it forked from. Both edits land on
# non-overlapping lines (pr makes no edit at all to the lines main deletes),
# so `git merge` combines them cleanly: the merged shared.ts still imports
# the wrapper (via pr's addition), but the merged baseline.json no longer
# lists it (main's deletion had nothing on pr's side to conflict with, so
# it wins outright). Each branch is right about its own diff; the merge is
# wrong.
mr_make_tauri_import_near_miss_repo() {
  local dir="$1"
  git_scratch_init "$dir"
  mkdir -p "$dir/src" "$dir/src-tauri/src"
  mr_seed_guards "$dir"
  # A benign Rust file so the crate-root scan (the Python trio, unrelated to
  # this guard) has something to find — a merge with zero .rs files
  # anywhere is legitimately "verified nothing" (#3989), and this fixture
  # is specifically testing that a merge with SOME .rs content but a
  # frontend-only regression still gets caught, not that case.
  printf 'pub fn noop() {}\n' > "$dir/src-tauri/src/lib.rs"
  cat > "$dir/src/shared.ts" <<'EOF'
import { one } from '@/lib/tauri'

export function top() {}

export function bottom() {}
EOF
  printf '[\n  "src/shared.ts"\n]\n' > "$dir/scripts/tauri-import-baseline.json"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m base
  git -C "$dir" branch pr

  cat > "$dir/src/shared.ts" <<'EOF'
export function top() {}

export function bottom() {}
EOF
  printf '[]\n' > "$dir/scripts/tauri-import-baseline.json"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m 'main: migrates shared.ts off the wrapper, prunes the baseline entry'

  git -C "$dir" checkout --quiet pr
  cat > "$dir/src/shared.ts" <<'EOF'
import { one } from '@/lib/tauri'

export function top() {}

export function bottom() {}

import { two } from '@/lib/tauri/domain'
EOF
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m 'pr: an unrelated second import in the same already-baselined file'
  git -C "$dir" checkout --quiet main
}

# #3989's MEASURED residual, as a fixture. The three Python guards replicate
# the crate-root list by hand, so one of them can name a root the other two
# do not. Here check-raw-tx.py's own CRATE_ROOTS gains `src-tauri/extra/src/`
# — the list this script reads, so `targets` picks the file up and the
# zero-target check never fires — while check-dynamic-sql.py and
# check-table-ownership.py keep the five real roots and reject every file
# they are handed. The content under the extra root is a genuine
# dynamic-SQL near-miss (both branches self-consistent, the MERGE at 2 sites
# against a baseline of 1), so there is a real violation to miss.
#
# Measured before the examined-count check existed: exit 0, "the ratchet
# guards pass on the ACTUAL merge", with check-dynamic-sql.py and
# check-table-ownership.py having read nothing at all.
mr_make_extra_root_repo() {
  local dir="$1"
  local extra="src-tauri/extra/src"
  git_scratch_init "$dir"
  mkdir -p "$dir/$extra"
  mr_seed_guards "$dir"
  # APPENDS a root to check-raw-tx.py's own list (the rename fixture above
  # REPLACES it) — the drift shape being reproduced is "one guard learned
  # about a root the others did not", not "the layout moved wholesale".
  # Same before-`__main__` placement, for the same reason as that fixture.
  python3 - "$dir/scripts/check-raw-tx.py" "$extra" <<'PYEOF'
import sys
path, extra = sys.argv[1], sys.argv[2]
src = open(path, encoding="utf-8").read()
marker = 'if __name__ == "__main__":'
assert marker in src, "check-raw-tx.py layout changed; fixture needs updating"
patch = (
    "\n# TEST-ONLY override (pr-merge-result-check.sh self-test, #3989):\n"
    "# one guard learns about a crate root its two siblings do not.\n"
    f'CRATE_ROOTS = CRATE_ROOTS + ["{extra}/"]\n\n\n'
)
src = src.replace(marker, patch + marker, 1)
open(path, "w", encoding="utf-8").write(src)
PYEOF
  printf 'pub fn top() {}\n\npub fn bottom() {}\n' > "$dir/$extra/shared.rs"
  : > "$dir/src-tauri/dynamic-sql-baseline.txt"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m base
  git -C "$dir" branch pr

  printf 'pub fn top() { let _ = sqlx::query("SELECT 1"); }\n\npub fn bottom() {}\n' \
    > "$dir/$extra/shared.rs"
  printf '1 %s/shared.rs\n' "$extra" > "$dir/src-tauri/dynamic-sql-baseline.txt"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m 'main: top()+1 under the extra root, baselined at 1'

  git -C "$dir" checkout --quiet pr
  printf 'pub fn top() {}\n\npub fn bottom() { let _ = sqlx::query("SELECT 2"); }\n' \
    > "$dir/$extra/shared.rs"
  printf '1 %s/shared.rs\n' "$extra" > "$dir/src-tauri/dynamic-sql-baseline.txt"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m 'pr: bottom()+1 under the extra root, baselined at 1'
  git -C "$dir" checkout --quiet main
}

# MULTIPLE targets, with the violation in a NON-FIRST one. Every other
# fixture here carries exactly one relevant `.rs`, which makes
# `python3 <guard> "$@"` and `python3 <guard> "${1:-}"` indistinguishable —
# a guard handed only the first of its targets would pass every one of them.
# The benign file lives under `src-tauri/agaric-store/src`, which
# check-raw-tx.py's CRATE_ROOTS names FIRST, so the crate-root scan emits it
# before the near-miss under `src-tauri/src` (the LAST root in that list):
# the violation is guaranteed not to be argv[1].
mr_make_multi_target_repo() {
  local dir="$1"
  mr_make_near_miss_repo "$dir"
  mkdir -p "$dir/src-tauri/agaric-store/src"
  printf 'pub fn first() {}\n' > "$dir/src-tauri/agaric-store/src/first.rs"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m 'main: a benign .rs under an EARLIER crate root'
}

# check-raw-tx.py PRESENT but unparseable. Distinct from "the layout moved"
# (a valid guard whose roots match nothing) and from "the guard is ABSENT" —
# and, before #3989's nit was fixed, indistinguishable from the first of
# those, because the traceback went to /dev/null and the reader was told the
# crate roots had changed.
mr_make_broken_rawtx_repo() {
  local dir="$1"
  mr_make_near_miss_repo "$dir"
  printf '\n\ndef this_will_not_parse(:\n' >> "$dir/scripts/check-raw-tx.py"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m 'main: check-raw-tx.py no longer parses'
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

  # A call site that forgot the head-sha argument entirely (not merely an
  # unresolvable one) is `main()`'s own arg-count check, not
  # `run_merge_check` — a different code path, but the same "verified
  # nothing, so it must be 3, not the advisory 2" rule applies. Kept here
  # with the other argument-shaped exit-3 cases rather than beside the
  # python3-missing fixture below, which it has nothing to do with.
  ( cd "$nearmiss" && bash "$SELF" main ) >/dev/null 2>&1; rc2=$?
  st_expect 'a call site that forgot an argument is exit 3, not an advisory exit 2' '3' "$rc2"

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

  # Note 6 (#3989): `mr_cleanup` (called on the conflict-abort path this
  # fixture is about to take) must NOT reach beyond its own worktree into
  # the rest of the caller's repo. Plant an unrelated, orphaned worktree
  # entry in this same repo first — same technique as the worktree-add-
  # failure/prune fixture below, which exercises the OTHER, deliberately
  # still-pruning cleanup path — so this assertion is non-vacuous: there IS
  # something a bare `git worktree prune` inside `mr_cleanup` could have
  # cleaned, and the point is that it does NOT.
  local conflict_stale_wt="$tmp/conflict-stale-wt"
  git -C "$conflict" worktree add --quiet --detach "$conflict_stale_wt" main >/dev/null 2>&1
  rm -rf "$conflict_stale_wt"
  st_expect 'fixture sanity: the second orphaned worktree is also registered and stale before any run' \
    '1' "$(git -C "$conflict" worktree list | grep -c "$conflict_stale_wt" || true)"

  ( cd "$conflict" && bash "$SELF" main pr ) >"$tmp/conflict.out" 2>"$tmp/conflict.err"; rc2=$?
  st_expect 'a real textual conflict is STILL exit 2, never exit 3 and never a pass' '2' "$rc2"
  # Note 2: git's own conflict text must reach the log — the step summary
  # says "See the job log above for the conflict", and before this fix the
  # job log carried only this script's own three lines.
  st_expect "git's own conflict output (CONFLICT/Automatic merge failed) reaches stderr, not just this script's own lines" \
    '1' "$(grep -q -E 'CONFLICT|Automatic merge failed' "$tmp/conflict.err" && echo 1 || echo 0)"
  st_expect "mr_cleanup does NOT reach beyond its own worktree — an UNRELATED stale entry in the same repo survives it untouched" \
    '1' "$(git -C "$conflict" worktree list | grep -c "$conflict_stale_wt" || true)"

  # ── 3e. A `git merge` FAILURE that is NOT a content conflict is exit 3,
  #        never exit 2 — the fourth case the exit-2/3 split originally
  #        missed. Unrelated histories is the deterministic repro: `git
  #        merge` refuses outright (`fatal: refusing to merge unrelated
  #        histories`, exit 128) WITHOUT ever starting a merge, so `git
  #        ls-files -u` stays empty — verified by hand. A leftover
  #        index.lock or ENOSPC take the same "non-zero, no unmerged paths"
  #        shape; unrelated histories is the one this fixture can build
  #        without touching the filesystem's actual free space or racing a
  #        lock file.
  local unrelated="$tmp/unrelated"
  mkdir -p "$unrelated"
  git_scratch_init "$unrelated"
  mkdir -p "$unrelated/src-tauri/src"
  mr_seed_guards "$unrelated"
  printf 'pub fn noop() {}\n' > "$unrelated/src-tauri/src/lib.rs"
  git -C "$unrelated" add -A
  git -C "$unrelated" commit --quiet -m base
  git -C "$unrelated" checkout --quiet --orphan pr
  git -C "$unrelated" rm -rf --quiet . >/dev/null 2>&1 || true
  mkdir -p "$unrelated/src-tauri/src"
  printf 'pub fn other() {}\n' > "$unrelated/src-tauri/src/lib.rs"
  git -C "$unrelated" add -A
  git -C "$unrelated" commit --quiet -m 'unrelated pr history, shares no ancestor with main'
  git -C "$unrelated" checkout --quiet main

  ( cd "$unrelated" && bash "$SELF" main pr ) >"$tmp/unrelated.out" 2>"$tmp/unrelated.err"; rc2=$?
  st_expect 'a non-conflict git-merge failure (unrelated histories) is exit 3, NOT exit 2' '3' "$rc2"
  st_expect 'and it is NOT reported using the content-conflict wording ("do NOT merge cleanly")' \
    '0' "$(grep -c 'do NOT merge cleanly' "$tmp/unrelated.err" || true)"
  st_expect "git's own refusal text (refusing to merge unrelated histories) reaches stderr" \
    '1' "$(grep -c 'refusing to merge unrelated histories' "$tmp/unrelated.err" || true)"

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

  # PARTIAL absence, not total — the shape `noguards` above cannot see.
  # check-dynamic-sql.py and check-table-ownership.py both importlib-load
  # check-raw-tx.py FROM THE MERGED TREE (shared comment-stripper/test-file
  # helpers); if check-raw-tx.py alone is missing — verified by hand: both
  # crash with FileNotFoundError, exit 1, a traceback naming
  # check-raw-tx.py, NOT their own guard logic — then BOTH of the other two
  # guards fail too, `failures=2`, and the failure count used to win over
  # the missing-guard note: exit 1, "a ratchet guard fails on the merge
  # result", telling the author to merge main and re-run prek for an
  # infrastructure problem that is not their diff. The `missing` check must
  # win regardless of how many guards crashed BECAUSE of the absence.
  local partial="$tmp/partial"
  mkdir -p "$partial"
  mr_make_near_miss_repo "$partial"
  git -C "$partial" rm -q scripts/check-raw-tx.py
  git -C "$partial" commit --quiet -m 'check-raw-tx.py alone is gone; the other two guards still import it'

  ( cd "$partial" && bash "$SELF" main pr ) >"$tmp/partial.out" 2>"$tmp/partial.err"; rc2=$?
  st_expect 'a PARTIAL guard absence (the other guards still import the missing one, and crash) is ALSO exit 3, not exit 1' \
    '3' "$rc2"
  # The OTHER two guards still get invoked (the loop cannot know in advance
  # that they will crash on the shared import) and still print their own
  # crash as a "FAILED" line — that stays; the review calls it diagnosable,
  # not the defect. What must change is which check wins the RETURN CODE:
  # the absence note, not the failure count, so the verdict a human acts on
  # says "ABSENT", not "fails on the merge result".
  st_expect 'and it still names check-raw-tx.py as the ABSENT guard, which is the note that must govern the verdict' \
    '1' "$(grep -c 'merged tree: check-raw-tx.py' "$tmp/partial.err" || true)"

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
      b=${f##*/}
      case "$b" in python3* | python) ;; *) ln -sf "$f" "$nopy/$b" 2>/dev/null || true ;; esac
    done
  done

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
  # `always()` also fires on a CANCELLED run, and this workflow sets
  # `concurrency.cancel-in-progress: true` — so `always()` was the wrong
  # primitive: it would let a superseded run's merge-result job start
  # against a stale head. `!cancelled()` gives the same "run despite
  # overlap's tolerated failure" behaviour without that. Pinned as a pair:
  # the right primitive is present, AND the wrong one (which would silently
  # satisfy the assertion below alone, since both contain "&& (") is gone.
  st_expect 'and the merge-result job runs with !cancelled(), not always() — the primitive that also fires on a cancelled run' \
    '1' "$(grep -c '!cancelled() && (' "$wf" || true)"
  st_expect 'and always() && ( is NOT the condition anymore (the wrong primitive from an earlier revision)' \
    '0' "$(grep -c '^ *always() && ($' "$wf" || true)"

  # A structural pin, not a behavioural one, and deliberately so: `find`
  # without `-type f` would let a directory or dangling symlink named
  # `*.rs` into `targets`, but every guard already filters on `p.is_file()`
  # (check-dynamic-sql.py:957 and its siblings), so removing `-type f` here
  # produces NO observable difference in exit code or output through the
  # CLI this self-test drives — an end-to-end assertion for it would be
  # exactly the "guard whose branch cannot be taken" shape to reject. This
  # pins the source text instead, so the property (defence in depth against
  # a guard that ever stops filtering) cannot silently regress unnoticed.
  # Searched only in the portion of THIS file before `run_self_test`
  # itself: the pattern below is the literal source text of the real `find`
  # call, and grepping the whole file would also match this assertion's own
  # source line, self-matching regardless of what the real code says.
  # BOTH crate-root scans: the one that builds `targets` and the one
  # `count_examined` uses for check-table-ownership.py (#3989), which walks
  # the tree itself rather than filtering argv.
  st_expect "both crate-root scans' find(1) are anchored on -type f" '2' \
    "$(sed -n '/^run_self_test()/q;p' "$SELF" | grep -Fc 'find "$workdir/$root" -type f -name' || true)"

  # ── 3f. CRATE_ROOTS is read from the MERGED TREE's own check-raw-tx.py,
  #        not hand-duplicated here (#3989) ─────────────────────────────────
  # A crate-root rename that updated check-raw-tx.py's own CRATE_ROOTS (the
  # single list this script now reads) is picked up with NO change to this
  # script. Before #3989's fix, this repo's crate roots were a bash constant
  # that could drift from check-raw-tx.py's own list; a fixture whose only
  # violation lives under a root NOT in that hardcoded bash list would have
  # scanned zero files (this fixture's `crateroots` root is not among the
  # real five), which the pre-existing zero-target check already turns into
  # exit 3 rather than a false pass — but exit 3 ("verified nothing") is
  # STILL the wrong answer here: the merged tree genuinely carries an
  # unmanaged raw-tx call, and this script has everything it needs
  # (check-raw-tx.py's OWN, patched CRATE_ROOTS) to see it.
  local crateroots="$tmp/crateroots"
  mkdir -p "$crateroots"
  mr_make_crateroots_rename_repo "$crateroots"
  ( cd "$crateroots" && bash "$SELF" main pr ) >"$tmp/crateroots.out" 2>"$tmp/crateroots.err"; rc2=$?
  st_expect 'a renamed crate root check-raw-tx.py itself now accepts is scanned and its violation caught (exit 1)' \
    '1' "$rc2"
  st_expect 'and it names check-raw-tx.py as the guard that failed' \
    '1' "$(grep -c 'check-raw-tx.py FAILED on the MERGED tree' "$tmp/crateroots.err" || true)"

  # ── 3g. THE OTHER THREE WHOLE-TREE RATCHETS, wired into THIS call site,
  #        not just proven to run on their own (#3978) ──────────────────────
  # #3978: RATCHET_GUARDS used to list 3 of the 6 whole-tree ratchets this
  # repo carries. Each of the three added here gets its own constructed
  # merge that breaks it — the invocation (this script's, cwd/argv shape and
  # all), not just the guard's own body, which each guard's own --self-test
  # already covers on its own.
  local unsafeallow="$tmp/unsafeallow"
  mkdir -p "$unsafeallow"
  mr_make_unsafe_allowlist_break_repo "$unsafeallow"
  ( cd "$unsafeallow" && bash "$SELF" main pr ) >"$tmp/unsafeallow.out" 2>"$tmp/unsafeallow.err"; rc2=$?
  st_expect 'unsafe-allowlist: an unlisted #![allow(unsafe_code)] file introduced by the merge fails (exit 1)' \
    '1' "$rc2"
  st_expect 'and it names check-unsafe-allowlist.sh as the guard that failed' \
    '1' "$(grep -c 'check-unsafe-allowlist.sh FAILED on the MERGED tree' "$tmp/unsafeallow.err" || true)"

  local migbreak="$tmp/migbreak"
  mkdir -p "$migbreak"
  mr_make_migrations_break_repo "$migbreak"
  ( cd "$migbreak" && bash "$SELF" main pr ) >"$tmp/migbreak.out" 2>"$tmp/migbreak.err"; rc2=$?
  st_expect 'migrations-immutable: a shipped migration modified by the merge fails (exit 1)' \
    '1' "$rc2"
  st_expect 'and it names check-migrations-immutable.sh as the guard that failed' \
    '1' "$(grep -c 'check-migrations-immutable.sh FAILED on the MERGED tree' "$tmp/migbreak.err" || true)"

  local tauriimport="$tmp/tauriimport"
  mkdir -p "$tauriimport"
  mr_make_tauri_import_near_miss_repo "$tauriimport"
  ( cd "$tauriimport" && bash "$SELF" main pr ) >"$tmp/tauriimport.out" 2>"$tmp/tauriimport.err"; rc2=$?
  st_expect 'tauri-import-baseline: the #3724-shaped near-miss (each branch right alone, merge wrong) fails (exit 1)' \
    '1' "$rc2"
  st_expect 'and it names check-tauri-import-baseline.mjs as the guard that failed' \
    '1' "$(grep -c 'check-tauri-import-baseline\.mjs FAILED on the MERGED tree' "$tmp/tauriimport.err" || true)"

  # node missing is the mirror of the pre-existing python3-missing fixture
  # below: check-tauri-import-baseline.mjs needs `node`, so its absence must
  # be "verified nothing" (exit 3), never a claimed guard failure. A
  # separate stub PATH from the python3 one below — excluding `node*`
  # specifically, not `python3*` — since reusing the python3-less PATH would
  # still carry a real `node` and not test this case at all.
  local nonode="$tmp/nonode-bin"
  mkdir -p "$nonode"
  local np nf nb
  for np in /usr/bin /bin /usr/local/bin; do
    [ -d "$np" ] || continue
    for nf in "$np"/*; do
      nb=${nf##*/}
      case "$nb" in node*) ;; *) ln -sf "$nf" "$nonode/$nb" 2>/dev/null || true ;; esac
    done
  done

  local nonode_out
  nonode_out=$( cd "$nearmiss" && PATH="$nonode" bash "$SELF" main pr 2>&1 ); rc2=$?
  st_expect 'node missing is exit 3 (verified nothing), not exit 1 (a guard failed)' '3' "$rc2"
  st_expect 'and it does NOT claim a guard failed on the merged tree' \
    '0' "$(printf '%s' "$nonode_out" | grep -c 'FAILED on the MERGED tree' || true)"

  # ── 3h. THE CLEAN MERGE with all six guards is still exit 0 ──────────────
  # `mr_seed_guards` now seeds every fixture with the prerequisites the
  # three newer guards refuse to run without (an allowlist file, a baseline
  # file, a src/ dir) — this re-runs the ORIGINAL clean fixture end to end
  # once more, after all of the above, as a guard against the seeding
  # change itself silently breaking the already-passing case.
  ( cd "$clean" && bash "$SELF" main pr ) >/dev/null 2>&1; rc2=$?
  st_expect 'the clean merge is still exit 0 with all six guards wired in' '0' "$rc2"

  # ── 3i. A GUARD THAT EXAMINED NOTHING IS NOT A PASS (#3989) ──────────────
  # The residual the reviewer MEASURED: reading CRATE_ROOTS out of the merged
  # tree's check-raw-tx.py closes the bash-vs-Python drift for ONE guard;
  # check-dynamic-sql.py and check-table-ownership.py keep their own copies
  # of the list. A root only check-raw-tx.py names puts files in `targets`
  # (so the zero-target check above cannot fire) that those two silently
  # reject — and a genuine dynamic-SQL near-miss under it exited 0, "the
  # ratchet guards pass", with two of the three guards having read nothing.
  local extraroot="$tmp/extraroot"
  mkdir -p "$extraroot"
  mr_make_extra_root_repo "$extraroot"
  ( cd "$extraroot" && bash "$SELF" main pr ) >"$tmp/extraroot.out" 2>"$tmp/extraroot.err"; rc2=$?
  st_expect 'a guard that examined ZERO files is exit 3, not the green "guards pass" it used to be' \
    '3' "$rc2"
  st_expect 'and it names BOTH guards that read nothing, not just the fact that something was wrong' \
    '1' "$(grep -c 'EXAMINED ZERO FILES' "$tmp/extraroot.err" || true)"
  st_expect 'and names check-dynamic-sql.py and check-table-ownership.py as the two' \
    '1' "$(grep -c 'passed vacuously: check-dynamic-sql.py check-table-ownership.py' "$tmp/extraroot.err" || true)"
  # Non-vacuity: it must be the EXAMINED-COUNT check that fired, not the
  # pre-existing zero-target one. `targets` is non-empty here (check-raw-tx.py
  # accepts the extra root and scanned it), which is exactly why the old
  # check could not see this.
  st_expect 'and it is NOT the pre-existing zero-target check firing — targets was non-empty' \
    '0' "$(grep -c 'carries no .rs file under ANY crate' "$tmp/extraroot.err" || true)"

  # ── 3j. A MISSING PREREQUISITE IS NOT A GUARD VIOLATION (#3989) ──────────
  # Measured before this: each of the first three exited 1 — which
  # pr-overlap.yml renders as "a ratchet guard fails on the merge result"
  # and answers with "merge main and re-run prek" — and the js-scanner case
  # did it with a raw ERR_MODULE_NOT_FOUND stack trace as the entire
  # explanation. None of them is a verdict on the PR: the guard could not
  # run at all. tauri-sanctioned-symbols.json (added by review note #4005/1)
  # is the fourth and worst of the four: absent it, readSanctioned() does
  # not error at all, so the OLD behaviour here was not "exit 1 with an
  # honest ERROR line" like the other three — it was the guard running to
  # completion and MISreporting sanctioned-only importers as new debt. This
  # loop only proves the generic exit-3 mechanic (mr_make_clean_repo's src/
  # carries no importer at all, so removing the file cannot also flip a
  # verdict); the false-verdict shape itself — a sanctioned-only importer
  # flipping to a false "new importer" when the file goes missing — was
  # falsified by hand against a dedicated fixture (a file whose only
  # `@/lib/tauri` dependency is a sanctioned symbol, with no
  # tauri-sanctioned-symbols.json committed at all): exit 1 misreporting it
  # as a new importer before this prereq entry existed, exit 3 correctly
  # naming the missing prerequisite after. Not wired in here as a fifth
  # committed fixture because 3j's loop already exists to prove the
  # PREREQUISITE mechanic once per file, generically; the false-verdict
  # shape is what motivated adding this entry to the table in the first
  # place, not a new mechanic this loop needs to reprove per-entry.
  local prereq prereq_dir prereq_rc
  for prereq in scripts/lib/js-scanner.mjs src-tauri/unsafe-allowlist.txt \
      scripts/tauri-import-baseline.json scripts/tauri-sanctioned-symbols.json; do
    prereq_dir="$tmp/prereq-$(printf '%s' "$prereq" | tr '/.' '--')"
    mkdir -p "$prereq_dir"
    mr_make_clean_repo "$prereq_dir"
    git -C "$prereq_dir" rm -q "$prereq"
    git -C "$prereq_dir" commit --quiet -m "main: $prereq is gone from the merged tree"
    ( cd "$prereq_dir" && bash "$SELF" main pr ) \
      >"$tmp/prereq.out" 2>"$tmp/prereq.err"; prereq_rc=$?
    st_expect "a merged tree missing $prereq is exit 3 (nothing verified), not exit 1" \
      '3' "$prereq_rc"
    st_expect "and the message NAMES $prereq as the missing prerequisite" \
      '1' "$(grep -cF "  $prereq — " "$tmp/prereq.err" || true)"
    st_expect "and it does NOT accuse a guard of failing on the merged tree over it" \
      '0' "$(grep -c 'FAILED on the MERGED tree' "$tmp/prereq.err" || true)"
    # js-scanner.mjs specifically is a library the mjs guard IMPORTS — not a
    # RATCHET_GUARDS entry, so it can never surface as an ABSENT guard — and
    # its old symptom was a raw ERR_MODULE_NOT_FOUND stack trace with no
    # explanation attached. The fix must REPLACE that, not prefix it. Asserted
    # only for this one of the three: the other two prerequisites make their
    # guard print its own one-line ERROR, so a "no stack trace" assertion for
    # them could never go red and would be counting itself for nothing.
    case "$prereq" in
      *js-scanner.mjs)
        st_expect 'and no raw interpreter stack trace is left as the explanation' \
          '0' "$(grep -c 'ERR_MODULE_NOT_FOUND\|at ModuleLoader' "$tmp/prereq.err" || true)"
        ;;
    esac
  done

  # ── 3k. EVERY target is handed to the guard, not just the first ──────────
  # `python3 <guard> "$@"` reduced to `"${1:-}"` survived every assertion
  # above, because each fixture carries exactly one relevant `.rs`. Here the
  # merged tree carries two, and the violation is in the LATER one.
  local multi="$tmp/multitarget"
  mkdir -p "$multi"
  mr_make_multi_target_repo "$multi"
  st_expect 'fixture sanity: the FIRST target alone is clean, so a guard handed only argv[1] would pass' \
    '0' "$(python3 "$multi/scripts/check-dynamic-sql.py" \
      "$multi/src-tauri/agaric-store/src/first.rs" >/dev/null 2>&1; echo $?)"
  ( cd "$multi" && bash "$SELF" main pr ) >"$tmp/multi.out" 2>"$tmp/multi.err"; rc2=$?
  st_expect 'a violation in a NON-FIRST target is still caught (exit 1) — every target is passed, not just one' \
    '1' "$rc2"
  st_expect 'and it names check-dynamic-sql.py, the guard whose later target carried the violation' \
    '1' "$(grep -c 'check-dynamic-sql.py FAILED on the MERGED tree' "$tmp/multi.err" || true)"

  # ── 3l. AN UNKNOWN GUARD IS A HARD FAILURE, never a silent pass ──────────
  # `run_one_guard`'s `*)` arm cannot be reached through the CLI (every name
  # in RATCHET_GUARDS has a rule), so it is exercised directly — the function
  # is defined in this same file and process. Returning 0 there would let a
  # typo in RATCHET_GUARDS, or a newly added guard with no invocation rule,
  # buy a green verdict from something that never ran.
  local unknown_out unknown_rc
  unknown_out=$(run_one_guard 'no-such-guard.qqq' "$tmp" HEAD 2>&1); unknown_rc=$?
  st_expect 'a guard with no invocation rule FAILS (returns 1), it does not silently pass' \
    '1' "$unknown_rc"
  st_expect 'and it says so, naming the guard it could not invoke' \
    '1' "$(printf '%s' "$unknown_out" | grep -c "no invocation rule for guard 'no-such-guard.qqq'" || true)"

  # ── 3m. THE mjs GUARD IS INVOKED cwd-INDEPENDENTLY ───────────────────────
  # The comment on `run_one_guard`'s `*.mjs` arm claims cwd does not matter
  # (the guard resolves its root from import.meta.dirname). Two pins, because
  # neither alone is enough:
  #   * behavioural — the guard really does return the same verdict from two
  #     unrelated cwds, so the claim is true of the guard;
  #   * structural — the arm really does invoke it WITHOUT a cd, so the claim
  #     is not being satisfied by accident. Wrapping the arm in a cd is
  #     behaviourally identical PRECISELY BECAUSE the claim holds, so no
  #     end-to-end assertion can distinguish the two forms; this is the same
  #     "pin the source text" case as the `-type f` assertion above.
  local mjs_rc_root mjs_rc_tmp
  mjs_rc_root=$( cd / && node "$tauriimport/scripts/check-tauri-import-baseline.mjs" \
    >/dev/null 2>&1; echo $? )
  mjs_rc_tmp=$( cd "$tmp" && node "$tauriimport/scripts/check-tauri-import-baseline.mjs" \
    >/dev/null 2>&1; echo $? )
  st_expect 'the tauri-import guard returns the same verdict from two unrelated cwds' \
    '0/0' "$mjs_rc_root/$mjs_rc_tmp"
  local mjs_arm
  mjs_arm="$(sed -n '/^run_one_guard()/,/^}/p' "$SELF" \
    | sed -n '/^    \*\.mjs)$/,/^      ;;$/p' | grep -v '^ *#' || true)"
  st_expect "and the *.mjs arm invokes node on the worktree's own path, with no cd" \
    '1' "$(printf '%s\n' "$mjs_arm" | grep -Fc 'node "$workdir/scripts/$guard"' || true)"
  st_expect 'and that arm contains no cd at all (which would make the claim above untestable)' \
    '0' "$(printf '%s\n' "$mjs_arm" | grep -c 'cd ' || true)"

  # ── 3n. A BROKEN check-raw-tx.py IS DIAGNOSED, not misreported ───────────
  # The `2>/dev/null` on the crate-root read discarded the traceback, so a
  # guard that was PRESENT but unparseable produced "the layout moved" —
  # sending the reader to look at crate roots for a syntax error.
  local brokenraw="$tmp/brokenraw"
  mkdir -p "$brokenraw"
  mr_make_broken_rawtx_repo "$brokenraw"
  ( cd "$brokenraw" && bash "$SELF" main pr ) >"$tmp/brokenraw.out" 2>"$tmp/brokenraw.err"; rc2=$?
  st_expect 'a present-but-unparseable check-raw-tx.py is exit 3 (verified nothing)' '3' "$rc2"
  st_expect "and the interpreter's own cause reaches stderr instead of /dev/null" \
    '1' "$(grep -c 'SyntaxError' "$tmp/brokenraw.err" || true)"
  st_expect 'and it is NOT reported as "the layout moved", which is a different fault' \
    '0' "$(grep -c 'carries no .rs file under ANY crate' "$tmp/brokenraw.err" || true)"

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
