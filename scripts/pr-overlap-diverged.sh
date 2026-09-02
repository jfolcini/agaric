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
# supply. So the computation lives here, where the real topologies can be built
# and driven end to end.
#
# ─── Contract ─────────────────────────────────────────────────────────────
#
#   exit 0  — computed. stdout is the list, and an EMPTY list is a real
#             answer ("nothing diverged").
#   exit 1  — NOT computed. stdout is empty, and the caller must not write an
#             empty file: "we could not look" and "we looked and found
#             nothing" are different facts.
#
# ─── A second, silent way to reach the same empty-by-construction bug ─────
#
# The bug documented above (a checkout that lands on the merge ref, base-tip
# first parent) is not the only path to it. If `pr-overlap.yml`'s `compute`
# job's trigger were ever changed to `pull_request_target` — the exact edit
# `scripts/check-pr-overlap-trust-boundary.mjs` exists to police — its
# ref-less checkout would land on the BASE branch instead (that trigger's
# default, with no explicit head ref). For a FORK PR, `HEAD_SHA` (the
# workflow's `github.event.pull_request.head.sha`) is then a commit this
# script has never fetched — not in the object DB at all — so
# `resolve_head`'s explicit-sha branch fails its `git rev-parse --verify`
# and falls through to `git rev-parse HEAD`, which IS the base tip on that
# checkout. `merge-base(base, base)` is base; `git diff base base` is empty;
# exit 0. Reported as "computed, nothing diverged" — the same false
# reassurance as the bug above, reached by a different door, and it degrades
# FORK-ONLY, so a same-repo PR (where `head.sha` resolves fine) keeps
# working and hides that the fork case is broken.
#
# `check-pr-overlap-trust-boundary.mjs`'s condition 3 — no write-scoped job
# may hold a checkout without a base-pinned `ref:` — does NOT catch this
# configuration: `compute` (the job this script runs in) holds `permissions:
# contents: read`, no write scope of any kind, so condition 3 has nothing to
# flag there. That guard polices TOKEN EXFILTRATION (a write-scoped job
# running fork-authored code); this is a DATA-CORRECTNESS hazard in a job
# that was never a write-scope risk in the first place, and nothing in this
# repo mechanically pins it today.
#
# Usage:
#   scripts/pr-overlap-diverged.sh <base-ref> [<head-sha>]
#   scripts/pr-overlap-diverged.sh --print-head <base-ref> [<head-sha>]

set -uo pipefail

# ---------------------------------------------------------------------------
# core
# ---------------------------------------------------------------------------

# The base branch tip. `origin/<ref>` first because that is the CI shape; a
# bare ref second so a local run resolves too.
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
# CLI
# ---------------------------------------------------------------------------

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

main "$@"
