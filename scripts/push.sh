#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# push.sh — verify-then-push.
#
# WHY THIS EXISTS
# ---------------
# `git push` opens (and *holds*) the SSH connection for ref negotiation
# BEFORE it runs the `pre-push` hook. Our pre-push hook runs the full
# CI-equivalent verification (`scripts/verify-ci-equivalent.sh`), which
# takes several minutes. By the time it finishes and git tries to send
# the pack, GitHub has already closed the now-idle connection:
#
#     Connection to github.com closed by remote host.
#     error: failed to push some refs
#
# (Observed deterministically once the verify suite grew past GitHub's
# git-over-SSH idle window — the hook passed in full, then the transport
# died.)
#
# THE FIX
# -------
# Run the verification HERE, before any network connection is opened.
# Only once it is green do we invoke `git push` — and we pass
# `SKIP_CI_VERIFY=<reason>` so the pre-push hook short-circuits instantly
# (the work is already done), letting the freshly-opened connection be
# used immediately. The fast `no-commit-to-branch` guard still runs.
# (The verifier rejects a bare `SKIP_CI_VERIFY=1`, so we pass a real
# reason string — see scripts/verify-ci-equivalent.sh, CI-R16.)
#
# USAGE
# -----
#   scripts/push.sh [<git push args…>]
#
#   scripts/push.sh                       # push the current branch
#   scripts/push.sh -u origin my-branch   # set upstream + push
#   scripts/push.sh --force-with-lease    # any git push flag is forwarded
#   scripts/push.sh --self-test           # fixture suite, no network (#3380)
#
# A plain `git push` still works and still auto-verifies (via the
# pre-push hook) — it just risks the stale-connection failure above on a
# slow verify. Prefer this wrapper for anything non-trivial.
#
# EXIT CODES (#3883) — every non-success path is non-zero, and the two
# failure classes are DELIBERATELY distinguishable so a caller (script, CI
# step, or an agent driving `git push` through this wrapper) can tell "you
# invoked me wrong" from "the push itself failed" without parsing output:
#
#   0   verified, pushed, AND confirmed landed on the remote.
#   1   a genuine push/verify failure: the CI-equivalent gate failed, `git
#       push` itself failed (refused, rejected, or dropped — see
#       PUSH_FAILURE_KIND below), or the post-push landed-check failed.
#       Something was attempted and did not succeed.
#   2   pre-flight refusal: `preflight_push_target` determined BEFORE the
#       gate ran that this invocation cannot land as given (mismatched
#       upstream, detached HEAD, push.default=nothing, …). Nothing was
#       attempted — this is a usage/config problem, not a push failure.
#
# A caller that only checks "zero or not" still gets the right answer for
# both; the 1-vs-2 split is for a caller that wants to react differently
# (e.g. retry a transient 1, but never retry a 2 without fixing the config
# first). Nothing in this script prints its own diagnosis and then falls
# through to exit 0 — every `echo "✗ …"` branch ends in an `exit`.
#
# `--self-test` (below) is a SEPARATE mode, not a real invocation, and its
# codes are its own, not part of the 0/1/2 contract above (#3922): 0 on a
# clean fixture run, 3 when a fixture assertion fails. It used to reuse 2
# for a failed fixture run, which made 2 no longer mean "pre-flight
# refusal, nothing was attempted" one-to-one — harmless today (prek only
# checks non-zero) but an inaccurate contract for a caller that inspects
# the actual code. 3 is unused elsewhere in this script.
#
# THE PUSH ITSELF CAN STILL FAIL (#3380)
# ---------------------------------------
# Verifying before opening the connection fixes the *idle-timeout* drop,
# but the transport can still be dropped mid-push (GitHub is a known
# intermittent here) — or, rarer, git can report success while the
# remote ref did not actually move. Both used to leave this script
# reporting exit 0 for a push that never landed. Two guarantees now:
#
#   1. `push_with_retry` propagates git push's real exit status. A
#      failure whose stderr matches a known-transient connection-drop
#      signature gets a small bounded retry (the drop this script exists
#      to route around is transient by nature, and re-pushing already-
#      landed content is a safe no-op); anything else — rejected,
#      non-fast-forward, auth, etc. — fails immediately, uncushioned,
#      so a real problem is never silently retried into obscurity.
#   2. `verify_landed` is the actual guarantee: after git push reports
#      success, it independently compares local HEAD against the
#      remote's ref via `git ls-remote` and fails loudly on any mismatch
#      (or if the remote can't be read at all) — catching a half-landed
#      push that git itself called a success. Best-effort: it only runs
#      when a tracking upstream can be resolved (covers the no-args path,
#      `--force-with-lease`, and any push that sets/uses an upstream); a
#      custom remote/refspec push it can't confidently attribute to a
#      branch skips the check with a note rather than guessing.
#
# THE DESTINATION IS CHECKED FIRST (#3683)
# ----------------------------------------
# Whether the refspec is pushable is knowable in zero seconds and has
# nothing to do with whether the tree is good — but it used to be
# discovered by `git push` itself, i.e. after the whole gate. A branch
# made with `git worktree add -b <new> origin/main` carries an upstream
# pointing at `origin/main`; a bare `git push` resolves the destination
# from it, sees `main` != the branch name, and refuses. Correctly — but
# ~8 minutes late, reported as "the PUSH FAILED", with the one
# explanatory `fatal:` line ~7700 lines up the log, above the entire
# nextest transcript.
#
# So `preflight_push_target` resolves and validates the destination
# BEFORE the verifier runs, and fails in under a second naming the
# branch, the upstream it found, and the one-line fix — exiting 2 (see
# EXIT CODES above), not 1, and not falling through to `exit 0` the way
# a bare `echo "✗ …"` followed by nothing did until #3883. And when a
# push does fail, the message distinguishes THREE causes, not two:
#   - a LOCAL refusal (nothing left the machine — a refspec/upstream
#     problem; look at branch config, not the connection),
#   - a LOCAL REJECTION (the connection opened, but nothing landed
#     because a pre-push git hook or the ref negotiation itself said no —
#     see THE PRE-PUSH HOOK IS NOT FULLY COVERED below), and
#   - a genuine failure on the wire (look at the connection),
# and echoes git's own last words at the bottom either way.
#
# THE PRE-PUSH HOOK IS NOT FULLY COVERED (#3883)
# -----------------------------------------------
# "Verifying (CI-equivalent)" above runs `verify-ci-equivalent.sh`, which
# is Phase A of the real pre-push hook (`prek run --all-files --hook-stage
# pre-commit`, plus vitest/nextest scoped to the push range) — deliberately
# only the SLOW checks, run once, before the connection opens. It is a
# SUBSET: prek hooks staged `pre-push` in prek.toml (cargo-clippy,
# cargo-fmt --check, better-npm-audit, knip, lychee, …) are NOT re-run by
# `verify-ci-equivalent.sh` and are NOT short-circuited by
# `SKIP_CI_VERIFY` — they still run for real, inline, inside the `git
# push` below, on the theory that they are individually fast enough not
# to risk the idle-timeout this script exists to avoid. When one of THEM
# rejects the push (e.g. a clippy lint), the failure surfaces from `git
# push` itself, classified as a LOCAL REJECTION above — "✓ Verification
# passed" was true of what this script checked; it was never a claim that
# nothing else could still say no.
#
# `--self-test` exercises these functions against a stubbed `git` — no
# network, no repo mutation — wired as a prek pre-commit hook so a
# regression here is caught before it reaches the push path every push
# depends on.
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── git push wrapper: bounded retry on known-transient drops only ──
# Exit status mirrors the last `git push` attempt. Overridable via
# PUSH_MAX_ATTEMPTS / PUSH_RETRY_SLEEP (used by --self-test to run fast).
PUSH_TRANSIENT_RE='Connection.*closed by remote host|Could not read from remote repository|remote end hung up unexpectedly|early EOF|RPC failed|unexpected disconnect while reading sideband packet'

# ── Did the push leave the machine, or was it refused here? (#3683) ──
# `git push` fails for two categorically different reasons and the script
# used to report both as "the PUSH FAILED", which reads as network or
# permissions — the failure mode this wrapper exists to route around —
# and sends you to look at the connection. A refspec/upstream problem is
# refused BEFORE anything is sent: nothing touched the remote, and the
# fix is one line of local branch config. Name which one it was.
PUSH_LOCAL_REFUSAL_RE='The upstream branch of your current branch does not match|has no upstream branch|src refspec .* does not match any|dst refspec .* matches more than one|matches more than one|does not appear to be a git repository|--set-upstream-to|You are pushing to remote .* which is not the upstream'

# ── A THIRD kind (#3883): a REJECTION, not a refusal or a wire failure ──
# `PUSH_LOCAL_REFUSAL_RE` above catches refspec/upstream misconfiguration —
# but there is another way `git push` fails without a byte of the push
# actually being rejected BY the remote: the LOCAL pre-push hook says no
# (a clippy/lint/test failure — see THE PRE-PUSH HOOK IS NOT FULLY
# COVERED, above), or the ref negotiation itself refuses a non-fast-
# -forward update. Neither of those originated on GitHub, but until this
# fix `classify_push_failure` fell through its `else` and called both
# "remote" — the script then printed "the PUSH FAILED on the wire",
# which sent a real #3883 incident chasing a network problem that did
# not exist; the actual cause (a clippy compile error) was on the LAST
# line of the log, not the first, because push.sh's own retry/log
# handling tails it (see PUSH_FAILURE_TAIL below) — but the HEADLINE
# diagnosis was still wrong.
#
# The reliable signal is git's own transcript shape, not the hook's
# wording (which this script cannot enumerate — clippy today, something
# else tomorrow): a rejection reported BY the remote OFTEN arrives as
# one or more `remote: …` lines (that prefix is how git marks text the
# other side sent back) — but not always: a remote pre-receive hook that
# declines SILENTLY (prints nothing) produces git's `[remote rejected]`
# marker with no `remote:` line anywhere, e.g.:
#
#   To .../repo.git
#    ! [remote rejected] HEAD -> main (pre-receive hook declined)
#   error: failed to push some refs to '.../repo.git'
#
# (verified empirically against a real bare repo + a real silent
# pre-receive hook). `[remote rejected]` is git's OWN terminology for
# "the far side refused this ref" — reliable regardless of whether the
# hook said anything — so it is checked FIRST, before the no-`remote:`
# heuristic below gets a chance to misclassify it as local. Only once
# that check has passed does absence of `remote:` become useful: a LOCAL
# hook rejection or non-fast-forward never has a `remote:` line AND
# never has `[remote rejected]` either (see PUSH_FAILURE_KIND cases in
# the self-test) — git's own trailer (`error: failed to push some refs
# to '…'`) is everything the caller of `git push` sees in those cases,
# with nothing above it attributable to the far side.
#
# The no-`remote:`-line heuristic is purely syntactic, not semantic: it
# reads git's transcript shape, not "did this reach the remote". A local
# hook that happens to echo a line starting with `remote:` (contrived,
# but possible — nothing stops a `pre-push` hook script from printing
# whatever it wants) would flip this classification to `remote`. That
# false positive is judged acceptable: it merely under-warns about a
# rare, self-inflicted hook-script choice, rather than the false
# negative this fix closes (a real GitHub-side rejection misread as
# local).
#
# `[remote rejected]` ANCHORING (#3922): the marker isn't only ever seen in
# git's default human-readable status line (` ! [remote rejected] …`) — this
# script forwards arbitrary caller args straight to `git push`, so a caller
# can pass `--porcelain`, whose rejected-ref line has a different shape
# entirely (`!\trefs/heads/x:refs/heads/x\t[remote rejected] (…)`), and git
# also emits a sibling marker, `[remote failure]` (`… (remote failed to
# report status)`), for a different far-side failure mode. Anchoring to the
# human line's exact prefix let both shapes fall through to the
# no-`remote:`-line heuristic and get misattributed as `local-rejection` —
# the SAME misread #3883 fixed, reached via a transcript the anchor didn't
# recognize. So the pattern below matches the bracketed marker text alone,
# unanchored to position or field separator: `[remote rejected]` /
# `[remote failure]` is git's own fixed vocabulary regardless of
# `--porcelain` vs. human output, and is specific enough (two literal words
# git chose, in brackets) that a hook coincidentally emitting the exact
# same substring is not a realistic false-positive source — the same
# "acceptable, bounded false-positive surface" trade-off already made for
# the no-`remote:`-line heuristic just above.
PUSH_REMOTE_REJECTED_RE='\[remote (rejected|failure)\]'
# Despite the name, this MATCHES a `remote:`-prefixed line — the "NO" in
# the old name (PUSH_NO_REMOTE_LINE_RE) came from the `!` at its one use
# site below, which read inverted at the definition. Renamed for #3922.
PUSH_REMOTE_LINE_RE='^remote:'
PUSH_GENERIC_REJECTION_RE='^error: failed to push some refs'

classify_push_failure() {
    # $1 = path to the captured git-push output. Echoes `local-refusal`
    # (refused before the connection was even used — see
    # PUSH_LOCAL_REFUSAL_RE), `local-rejection` (the connection was used,
    # but nothing landed, git did NOT mark the ref `[remote rejected]` /
    # `[remote failure]`, and no `remote:` line appears anywhere in the
    # log — a LOCAL pre-push hook or the ref negotiation itself said no),
    # or `remote` (git explicitly marked the ref rejected/failed, the far
    # side sent back a `remote:`-prefixed line, or the failure doesn't
    # match either local pattern — the safe default).
    if grep -qE "$PUSH_LOCAL_REFUSAL_RE" "$1"; then
        echo "local-refusal"
    elif grep -qE "$PUSH_REMOTE_REJECTED_RE" "$1"; then
        echo "remote"
    elif ! grep -qE "$PUSH_REMOTE_LINE_RE" "$1" \
        && grep -qE "$PUSH_GENERIC_REJECTION_RE" "$1"; then
        echo "local-rejection"
    else
        echo "remote"
    fi
}

push_with_retry() {
    local max_attempts="${PUSH_MAX_ATTEMPTS:-3}"
    local retry_sleep="${PUSH_RETRY_SLEEP:-3}"
    local attempt=1 rc=1 log
    PUSH_FAILURE_KIND=""
    PUSH_FAILURE_TAIL=""

    while [ "$attempt" -le "$max_attempts" ]; do
        log="$(mktemp -t push-sh-git-push.XXXXXX)"
        echo "→ git push (attempt $attempt/$max_attempts)…"
        # NOTE: `rc` must be read from PIPESTATUS in the SAME command list as
        # the pipeline — appending `|| true` on this line would itself run as
        # a trivial one-element pipeline when the LHS fails, clobbering
        # PIPESTATUS before the next line could read it. The if/else reads it
        # from the `else` branch, which runs before anything else does.
        if git push "$@" 2>&1 | tee "$log"; then
            rc=0
        else
            rc="${PIPESTATUS[0]}"
        fi

        if [ "$rc" -eq 0 ]; then
            rm -f "$log"
            return 0
        fi

        if [ "$attempt" -lt "$max_attempts" ] && grep -qE "$PUSH_TRANSIENT_RE" "$log"; then
            echo "  ⚠ known-transient connection failure (attempt $attempt/$max_attempts); retrying in ${retry_sleep}s…" >&2
            rm -f "$log"
            sleep "$retry_sleep"
            attempt=$((attempt + 1))
            continue
        fi

        # Failing for good: keep WHY, so the caller can say which kind of
        # failure it was and echo git's own words at the BOTTOM of the log
        # rather than leaving the one explanatory `fatal:` line thousands
        # of lines up, above the whole verify transcript (#3683).
        PUSH_FAILURE_KIND="$(classify_push_failure "$log")"
        # `|| true`: with `set -e` and `pipefail`, a grep that matches
        # nothing fails the whole substitution and would abort the
        # function outright — precisely when the fallback below is the
        # thing that should run. It survives today only because every
        # caller sits in an `if !` condition, where -e is suspended;
        # that is luck, not design.
        PUSH_FAILURE_TAIL="$(grep -E '^(fatal|error|remote:|hint):?' "$log" | tail -5 || true)"
        [ -z "$PUSH_FAILURE_TAIL" ] && PUSH_FAILURE_TAIL="$(tail -5 "$log" || true)"
        rm -f "$log"
        return "$rc"
    done

    return "$rc"
}

# ── Preflight: where would this push land? (#3683) ──────────────────
# Whether the refspec is pushable is knowable in ZERO seconds and is
# completely independent of whether the tree is good — yet it used to be
# discovered after the full gate (Phase A..D, a whole nextest run, ~8
# minutes), and then reported as though the push had failed on the wire.
#
# The canonical way in: `git worktree add -b <new> origin/main` sets the
# new branch's upstream to `origin/main`. The branch has never been
# pushed, so an argument-less `git push` resolves its destination from
# that upstream, finds `main`, sees it does not match the current branch
# name, and refuses — correctly. Cheap precondition, expensive discovery.
#
# Runs BEFORE the verifier. Builds PUSH_ARGS (the list handed to `git
# push`, also read back by resolve_push_target for the postcondition) and
# returns 1 with a named cause + remedy when the destination cannot
# resolve. Explicit args are the caller's business: forwarded verbatim.
preflight_push_target() {
    PUSH_ARGS=()
    local branch upstream upstream_branch push_default

    if [ "$#" -gt 0 ]; then
        PUSH_ARGS=("$@")
        echo "→ Push destination: as given — git push ${PUSH_ARGS[*]}"
        return 0
    fi

    branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    if [ -z "$branch" ] || [ "$branch" = "HEAD" ]; then
        echo "✗ push.sh: cannot resolve a push destination — HEAD is detached." >&2
        echo "  A bare \`git push\` has no branch to push from here." >&2
        echo "  Fix: check out a branch, or name the destination explicitly:" >&2
        echo "    scripts/push.sh origin HEAD:refs/heads/<branch>" >&2
        echo "  (Detected before the verify gate — no verification time spent.)" >&2
        return 1
    fi

    if ! upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; then
        # Never pushed: name the destination ourselves rather than letting
        # a bare `git push` abort with "no upstream branch".
        PUSH_ARGS=(--set-upstream origin "$branch")
        echo "→ Push destination: origin/$branch (first push — will set upstream)"
        return 0
    fi

    upstream_branch="${upstream#*/}"
    if [ "$upstream_branch" = "$branch" ]; then
        echo "→ Push destination: $upstream"
        return 0
    fi

    # Upstream names a DIFFERENT branch. Whether that is fatal is entirely
    # a question of push.default — and a preflight that refuses a working
    # configuration is a worse bug than the one it was written for, so
    # every value git accepts is modelled explicitly and only the ones
    # that genuinely cannot land are refused.
    push_default="$(git config --get push.default 2>/dev/null || true)"
    case "${push_default:-simple}" in
        current | matching)
            # The destination comes from the branch NAME, not the
            # upstream: `current` pushes this branch to the same-named
            # remote branch, and `matching` pushes every same-named pair
            # (naming the refspec narrows that to the branch push.sh is
            # actually about, and creates it if the remote lacks it —
            # `matching` would otherwise push nothing at all, silently,
            # and exit 0). Name the refspec rather than leaving
            # PUSH_ARGS empty: an empty list sends resolve_push_target
            # back to @{u} for the postcondition, i.e. it would compare
            # HEAD against 'origin/$upstream_branch' — the branch that was
            # NOT pushed — and report "postcondition check FAILED" for a
            # push that landed perfectly. A false "it did not land" is the
            # same class of lie #3683 is about, pointing the other way.
            PUSH_ARGS=(origin "$branch")
            echo "→ Push destination: origin/$branch (push.default=$push_default; upstream '$upstream' is not the destination)"
            return 0
            ;;
        upstream | tracking)
            # Deliberately configured to push to the tracking branch,
            # whatever it is named. This WORKS, so it is not refused —
            # but the destination is not the obvious one, so say it out
            # loud. PUSH_ARGS stays empty on purpose: the bare push
            # follows @{u}, and resolve_push_target reads @{u} too, so
            # the postcondition already checks the right ref.
            echo "→ Push destination: $upstream (push.default=$push_default)"
            echo "  NOTE: that is NOT this branch's name. '$branch' will land on"
            echo "  '$upstream_branch'. If that is not what you meant, push explicitly:"
            echo "    scripts/push.sh -u origin $branch"
            return 0
            ;;
        nothing)
            echo "✗ push.sh: push.default=nothing — a bare \`git push\` refuses to guess a destination." >&2
            echo "  Name it explicitly:" >&2
            echo "    scripts/push.sh -u origin $branch" >&2
            echo "  (Detected before the verify gate — no verification time spent.)" >&2
            return 1
            ;;
        simple) ;;
        *)
            # A value git will reject itself. Not our failure to invent a
            # diagnosis for — pass it through and let git speak.
            echo "→ Push destination: unmodelled push.default='$push_default'; deferring to git."
            return 0
            ;;
    esac

    echo "✗ push.sh: this branch cannot be pushed as invoked — refusing BEFORE the verify gate." >&2
    echo "" >&2
    echo "    branch            : $branch" >&2
    echo "    upstream (@{u})   : $upstream" >&2
    echo "    push.default      : ${push_default:-simple (unset)}" >&2
    echo "" >&2
    echo "  A bare \`git push\` resolves its destination from the upstream, finds" >&2
    echo "  '$upstream_branch', sees it does not match the branch name, and refuses —" >&2
    echo "  rather than push '$branch' onto '$upstream_branch'. That refusal is right; only its" >&2
    echo "  TIMING was wrong (it used to surface after the ~8-minute gate)." >&2
    echo "" >&2
    echo "  This is what \`git worktree add -b $branch origin/main\` leaves behind." >&2
    echo "  Fix — any one of:" >&2
    echo "    bash scripts/seed-worktree.sh            # unsets the bogus upstream (+ the other worktree prereqs)" >&2
    echo "    git branch --unset-upstream              # then re-run scripts/push.sh" >&2
    echo "    scripts/push.sh -u origin $branch" >&2
    echo "" >&2
    echo "  (Detected in under a second — the verify gate has NOT been run.)" >&2
    return 1
}

# ── Attribute the postcondition to the ACTUAL push target ───────────
# Reads PUSH_ARGS (exactly what was handed to `git push`) and works out
# which remote + branch was really just updated, instead of blindly
# trusting the current branch's own `@{u}`. That distinction matters:
# an explicit refspec (`push.sh origin HEAD:release`, `push.sh origin
# some-other-branch`) can target a remote branch that is NOT what @{u}
# tracks — checking @{u} there checks the WRONG ref, which can both
# false-FAIL a push that landed fine, and — worse — false-PASS if local
# HEAD happens to already equal that unrelated ref's remote SHA.
#
# Sets RESOLVED_REMOTE / RESOLVED_BRANCH / RESOLVED_LOCAL_REF on success.
# Returns 1 when the target can't be confidently attributed to a single
# remote branch (multiple refspecs, `--all`/`--mirror`/`--tags`, a
# refspec with an empty local side i.e. a delete) — callers must skip
# rather than guess in that case.
resolve_push_target() {
    RESOLVED_REMOTE=""
    RESOLVED_BRANCH=""
    RESOLVED_LOCAL_REF="HEAD"

    local -a positional=()
    local a upstream refspec
    for a in ${PUSH_ARGS[@]+"${PUSH_ARGS[@]}"}; do
        case "$a" in
            --all | --mirror | --tags | --follow-tags)
                return 1
                ;;
            -*)
                continue
                ;;
            *)
                positional+=("$a")
                ;;
        esac
    done

    case "${#positional[@]}" in
        0)
            # No explicit remote/branch (either truly no args, or flags
            # only, e.g. `--force-with-lease` alone) — the implicit
            # target is whatever @{u} resolves to right now.
            if ! upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; then
                return 1
            fi
            RESOLVED_REMOTE="${upstream%%/*}"
            RESOLVED_BRANCH="${upstream#*/}"
            RESOLVED_LOCAL_REF="HEAD"
            ;;
        1)
            # `push.sh origin` — remote given, branch follows push.default
            # (current branch).
            RESOLVED_REMOTE="${positional[0]}"
            RESOLVED_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
            RESOLVED_LOCAL_REF="HEAD"
            ;;
        2)
            # `push.sh origin <refspec>` — explicit remote + refspec.
            # `<local>:<remote>` names both sides; a bare `<branch>`
            # pushes the LOCAL ref of that name (not necessarily HEAD)
            # to the SAME-named remote branch, per git's own semantics.
            RESOLVED_REMOTE="${positional[0]}"
            refspec="${positional[1]#+}"
            case "$refspec" in
                :*)
                    return 1 # delete refspec — nothing local to verify
                    ;;
                *:*)
                    RESOLVED_LOCAL_REF="${refspec%%:*}"
                    RESOLVED_BRANCH="${refspec#*:}"
                    ;;
                *)
                    # A bare name with no colon: if it names a local TAG
                    # and not a local branch, it's a tag push (checked
                    # under refs/tags/, not refs/heads/) — out of scope
                    # for this branch-postcondition check, so skip rather
                    # than false-fail against a refs/heads/ lookup that
                    # will never match.
                    if git rev-parse --verify --quiet "refs/tags/$refspec" >/dev/null 2>&1 \
                        && ! git rev-parse --verify --quiet "refs/heads/$refspec" >/dev/null 2>&1; then
                        return 1
                    fi
                    RESOLVED_LOCAL_REF="$refspec"
                    RESOLVED_BRANCH="$refspec"
                    ;;
            esac
            RESOLVED_BRANCH="${RESOLVED_BRANCH#refs/heads/}"
            [ -z "$RESOLVED_BRANCH" ] && return 1
            ;;
        *)
            return 1 # multiple refspecs — too ambiguous to attribute
            ;;
    esac

    [ -n "$RESOLVED_REMOTE" ] && [ -n "$RESOLVED_BRANCH" ]
}

# ── Postcondition: did the branch actually land? ────────────────────
# `git push` exiting 0 is necessary but, per #3380, not sufficient —
# verify independently by comparing the local ref that was pushed to
# what the remote actually has for the branch that was actually
# targeted (see resolve_push_target above). Best-effort: only runs when
# the target can be confidently attributed; anything else (tag push,
# `--all`/`--mirror`/`--tags`, multiple refspecs, a delete refspec, or
# no resolvable upstream on an implicit push) skips with a note instead
# of guessing at the caller's intent.
verify_landed() {
    local local_sha remote_sha

    if ! resolve_push_target; then
        echo "  (postcondition check skipped — could not confidently attribute this push to a single remote branch; not guessing)"
        return 0
    fi

    if ! local_sha="$(git rev-parse "$RESOLVED_LOCAL_REF" 2>/dev/null)"; then
        echo "✗ postcondition check FAILED: \`git rev-parse $RESOLVED_LOCAL_REF\` failed — cannot determine the local commit to compare." >&2
        return 1
    fi
    remote_sha="$(git ls-remote "$RESOLVED_REMOTE" "refs/heads/$RESOLVED_BRANCH" 2>/dev/null | cut -f1)"

    if [ -z "$remote_sha" ]; then
        echo "✗ postcondition check FAILED: \`git ls-remote $RESOLVED_REMOTE refs/heads/$RESOLVED_BRANCH\` returned nothing — cannot confirm the branch landed." >&2
        return 1
    fi

    if [ "$local_sha" != "$remote_sha" ]; then
        echo "✗ postcondition check FAILED: local $RESOLVED_LOCAL_REF ($local_sha) != $RESOLVED_REMOTE/$RESOLVED_BRANCH on the remote ($remote_sha)." >&2
        echo "  git push reported success but the remote ref does not match — treat this push as NOT landed." >&2
        return 1
    fi

    echo "  ✓ postcondition: $RESOLVED_REMOTE/$RESOLVED_BRANCH == local $RESOLVED_LOCAL_REF ($local_sha)"
    return 0
}

# ── self-test (#3380) ────────────────────────────────────────────────
# Fixture suite for push_with_retry / verify_landed above, run against a
# stubbed `git` on PATH — no network, no repo mutation. Wired as the
# `push-sh-selftest` prek hook so a regression in either function is
# caught at commit time rather than live, mid-push. Runs before any real
# work below, so it's fast and side-effect free (mirrors the
# `verify-ci-equivalent.sh --self-test` convention).
if [ "${1:-}" = "--self-test" ]; then
    st_fail=0
    st_ok() { printf '  ok   - %s\n' "$1"; }
    st_bad() { printf '  FAIL - %s: %s\n' "$1" "$2" >&2; st_fail=1; }

    fake_git_dir="$(mktemp -d -t push-sh-selftest-fakegit.XXXXXX)"
    cat >"$fake_git_dir/git" <<'FAKEGIT'
#!/usr/bin/env bash
# Stub git for push.sh --self-test. Behavior selected via env vars:
#   FAKE_PUSH_BEHAVIOR      ok | fail_hard | fail_transient | fail_transient_then_ok |
#                           fail_hook_rejected
#   FAKE_SUCCEED_ON_ATTEMPT attempt number fail_transient_then_ok succeeds on
#   FAKE_PUSH_ATTEMPT_FILE  counter file, one push invocation per line
#   FAKE_UPSTREAM           value for `rev-parse --abbrev-ref --symbolic-full-name @{u}`
#                           (unset/empty => that rev-parse fails, like no upstream)
#   FAKE_CURRENT_BRANCH     value for `rev-parse --abbrev-ref HEAD` (default: stub-branch)
#   FAKE_LOCAL_SHA          value for `rev-parse HEAD` and the default for
#                           `rev-parse <other-ref>` (override per-ref via
#                           FAKE_LOCAL_SHA_<ref-with-non-alnum-as-_>)
#   FAKE_LSREMOTE_BEHAVIOR  ok | empty | fail
#   FAKE_REMOTE_SHA         default SHA returned by `ls-remote` when
#                           FAKE_LSREMOTE_BEHAVIOR=ok (override per queried
#                           branch via FAKE_REMOTE_SHA_<branch-with-non-alnum-as-_>)
set -uo pipefail
cmd="${1:-}"
case "$cmd" in
    push)
        if [ -n "${FAKE_PUSH_ATTEMPT_FILE:-}" ]; then
            n="$(cat "$FAKE_PUSH_ATTEMPT_FILE" 2>/dev/null || echo 0)"
            n=$((n + 1))
            echo "$n" >"$FAKE_PUSH_ATTEMPT_FILE"
        else
            n=1
        fi
        case "${FAKE_PUSH_BEHAVIOR:-ok}" in
            ok)
                echo "To github.com:org/repo.git"
                exit 0
                ;;
            fail_hard)
                echo "remote: Permission to org/repo.git denied to user." >&2
                echo "fatal: unable to access repository: The requested URL returned error: 403" >&2
                exit 128
                ;;
            fail_transient)
                echo "Connection to github.com closed by remote host." >&2
                echo "fatal: Could not read from remote repository." >&2
                exit 128
                ;;
            fail_transient_then_ok)
                if [ "$n" -lt "${FAKE_SUCCEED_ON_ATTEMPT:-2}" ]; then
                    echo "Connection to github.com closed by remote host." >&2
                    echo "fatal: Could not read from remote repository." >&2
                    exit 128
                fi
                echo "To github.com:org/repo.git"
                exit 0
                ;;
            fail_hook_rejected)
                # A LOCAL pre-push hook rejection (#3883) — modeled on a
                # real `clippy` failure inside the real pre-push hook.
                # NO `remote:` line anywhere: this is git's own trailer
                # after a hook says no, never text the far side sent.
                echo "error: could not compile \`agaric-store\` (lib) due to 3 previous errors" >&2
                echo "error: failed to push some refs to 'github.com:org/repo.git'" >&2
                exit 1
                ;;
            *)
                echo "fake git: unknown FAKE_PUSH_BEHAVIOR '$FAKE_PUSH_BEHAVIOR'" >&2
                exit 99
                ;;
        esac
        ;;
    rev-parse)
        rest="$*"
        case "$rest" in
            *'@{u}'*)
                if [ -z "${FAKE_UPSTREAM:-}" ]; then
                    echo "fatal: no upstream configured for branch" >&2
                    exit 128
                fi
                echo "$FAKE_UPSTREAM"
                exit 0
                ;;
            'rev-parse --abbrev-ref HEAD')
                echo "${FAKE_CURRENT_BRANCH:-stub-branch}"
                exit 0
                ;;
            'rev-parse --show-toplevel')
                # Used only by the real end-to-end self-test invocations
                # below, which spawn the actual script as a subprocess.
                echo "${FAKE_TOPLEVEL:?FAKE_TOPLEVEL must be set for --show-toplevel}"
                exit 0
                ;;
            'rev-parse --verify --quiet refs/tags/'*)
                name="${rest#rev-parse --verify --quiet refs/tags/}"
                if [ "${FAKE_TAG_EXISTS:-}" = "$name" ]; then
                    echo "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
                    exit 0
                fi
                exit 1
                ;;
            'rev-parse --verify --quiet refs/heads/'*)
                name="${rest#rev-parse --verify --quiet refs/heads/}"
                if [ "${FAKE_LOCAL_BRANCH_EXISTS:-}" = "$name" ]; then
                    echo "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
                    exit 0
                fi
                exit 1
                ;;
            'rev-parse HEAD' | *' HEAD')
                echo "${FAKE_LOCAL_SHA:-0000000000000000000000000000000000000000}"
                exit 0
                ;;
            'rev-parse '*)
                ref="${rest#rev-parse }"
                varname="FAKE_LOCAL_SHA_$(printf '%s' "$ref" | tr -c 'A-Za-z0-9' '_')"
                eval "val=\"\${$varname:-\${FAKE_LOCAL_SHA:-0000000000000000000000000000000000000000}}\""
                echo "$val"
                exit 0
                ;;
            *)
                echo "fake git: unhandled rev-parse args: $rest" >&2
                exit 99
                ;;
        esac
        ;;
    config)
        # Only `--get push.default` is consulted (preflight_push_target).
        # Unset config exits 1 with no output, like the real thing.
        case "$*" in
            *push.default*)
                if [ -n "${FAKE_PUSH_DEFAULT:-}" ]; then
                    echo "$FAKE_PUSH_DEFAULT"
                    exit 0
                fi
                exit 1
                ;;
            *)
                exit 1
                ;;
        esac
        ;;
    ls-remote)
        case "${FAKE_LSREMOTE_BEHAVIOR:-ok}" in
            ok)
                queried_ref="${3:-refs/heads/stub-branch}"
                queried_branch="${queried_ref#refs/heads/}"
                varname="FAKE_REMOTE_SHA_$(printf '%s' "$queried_branch" | tr -c 'A-Za-z0-9' '_')"
                eval "sha=\"\${$varname:-\${FAKE_REMOTE_SHA:-0000000000000000000000000000000000000000}}\""
                printf '%s\t%s\n' "$sha" "$queried_ref"
                exit 0
                ;;
            empty)
                exit 0
                ;;
            fail)
                echo "fatal: unable to access remote" >&2
                exit 128
                ;;
        esac
        ;;
    *)
        echo "fake git: unhandled subcommand: $cmd" >&2
        exit 99
        ;;
esac
FAKEGIT
    chmod +x "$fake_git_dir/git"
    export PATH="$fake_git_dir:$PATH"
    export PUSH_MAX_ATTEMPTS=3
    export PUSH_RETRY_SLEEP=0

    unset FAKE_PUSH_BEHAVIOR FAKE_SUCCEED_ON_ATTEMPT FAKE_PUSH_ATTEMPT_FILE \
        FAKE_UPSTREAM FAKE_LOCAL_SHA FAKE_LSREMOTE_BEHAVIOR FAKE_REMOTE_SHA \
        FAKE_PUSH_DEFAULT

    # ── preflight_push_target (#3683) ────────────────────────────────
    # The property under test: an unpushable destination is refused in
    # zero seconds, by name — never after the gate, and never dressed up
    # as a failed push.

    # P1. The live #3683 shape: `git worktree add -b <new> origin/main`
    #     leaves the upstream on origin/main. A bare `git push` cannot
    #     work here (push.default=simple refuses the name mismatch), and
    #     that is knowable before any verification runs.
    rc=0
    out="$(FAKE_CURRENT_BRANCH="claude/3647-repeat-grammar" FAKE_UPSTREAM="origin/main" \
        preflight_push_target 2>&1)" || rc=$?
    if [ "$rc" -ne 0 ] \
        && printf '%s' "$out" | grep -q 'origin/main' \
        && printf '%s' "$out" | grep -q 'claude/3647-repeat-grammar' \
        && printf '%s' "$out" | grep -qi 'seed-worktree.sh'; then
        st_ok "mismatched upstream: refused up front, naming branch + upstream + remedy"
    else
        st_bad "mismatched upstream: refused up front, naming branch + upstream + remedy" \
            "rc=$rc out=$out"
    fi

    # P2. Same mismatch, but push.default=current — git resolves the
    #     destination from the branch NAME there, so the push works and
    #     the preflight must NOT block it. A preflight that fires on a
    #     working configuration is a new failure, not a fix.
    rc=0
    PUSH_ARGS=()
    FAKE_CURRENT_BRANCH="feature-x" FAKE_UPSTREAM="origin/main" \
        FAKE_PUSH_DEFAULT="current" preflight_push_target >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 0 ] && [ "${PUSH_ARGS[*]}" = "origin feature-x" ]; then
        st_ok "mismatched upstream under push.default=current: allowed, destination named explicitly"
    else
        st_bad "mismatched upstream under push.default=current: allowed, destination named explicitly" \
            "rc=$rc args=${PUSH_ARGS[*]-}"
    fi

    # P2b. …and the postcondition must then check the branch that was
    #      actually pushed. With PUSH_ARGS left empty here,
    #      resolve_push_target falls back to @{u} — origin/main — and
    #      verify_landed reports "postcondition check FAILED" for a push
    #      that landed on origin/feature-x perfectly. A false "it did not
    #      land" is the same class of lie #3683 is about, aimed the other
    #      way. (Demonstrated: with the old empty PUSH_ARGS this case
    #      failed while the push was fine.)
    rc=0
    PUSH_ARGS=()
    FAKE_CURRENT_BRANCH="feature-x" FAKE_UPSTREAM="origin/main" \
        FAKE_PUSH_DEFAULT="current" preflight_push_target >/dev/null 2>&1 || rc=$?
    out="$(FAKE_CURRENT_BRANCH="feature-x" FAKE_UPSTREAM="origin/main" \
        FAKE_LOCAL_SHA_feature_x="4444000000000000000000000000000000000a" \
        FAKE_REMOTE_SHA_feature_x="4444000000000000000000000000000000000a" \
        FAKE_REMOTE_SHA_main="9999000000000000000000000000000000000b" \
        verify_landed 2>&1)" || rc=$?
    unset PUSH_ARGS
    if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'origin/feature-x'; then
        st_ok "push.default=current: the postcondition checks origin/feature-x, not the unrelated @{u}"
    else
        st_bad "push.default=current: the postcondition checks origin/feature-x, not the unrelated @{u}" \
            "rc=$rc out=$out"
    fi

    # P2c. push.default=upstream/tracking: the upstream deliberately names
    #      a different branch and git will push there. That is a WORKING
    #      configuration — refusing it would turn a fine push into a hard
    #      failure and hand out a remedy (`-u origin <branch>`) aimed at
    #      the wrong ref. Allowed, with the destination said out loud, and
    #      PUSH_ARGS left empty so both the push and the postcondition
    #      follow @{u}.
    rc=0
    PUSH_ARGS=(sentinel)
    out="$(FAKE_CURRENT_BRANCH="feature-x" FAKE_UPSTREAM="origin/main" \
        FAKE_PUSH_DEFAULT="upstream" preflight_push_target 2>&1)" || rc=$?
    FAKE_CURRENT_BRANCH="feature-x" FAKE_UPSTREAM="origin/main" \
        FAKE_PUSH_DEFAULT="upstream" preflight_push_target >/dev/null 2>&1 || true
    if [ "$rc" -eq 0 ] && [ "${#PUSH_ARGS[@]}" -eq 0 ] \
        && printf '%s' "$out" | grep -q 'origin/main'; then
        st_ok "push.default=upstream: a working mismatched-upstream config is NOT refused"
    else
        st_bad "push.default=upstream: a working mismatched-upstream config is NOT refused" \
            "rc=$rc args=${PUSH_ARGS[*]-} out=$out"
    fi

    # P2d. push.default=nothing: a bare push really does refuse, so this
    #      one IS a preflight failure — with its own diagnosis, not the
    #      worktree-upstream one.
    rc=0
    PUSH_ARGS=()
    out="$(FAKE_CURRENT_BRANCH="feature-x" FAKE_UPSTREAM="origin/main" \
        FAKE_PUSH_DEFAULT="nothing" preflight_push_target 2>&1)" || rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'push.default=nothing'; then
        st_ok "push.default=nothing: refused with its own diagnosis"
    else
        st_bad "push.default=nothing: refused with its own diagnosis" "rc=$rc out=$out"
    fi

    # P2e. A push.default value this script does not model must not be
    #      invented into a failure — git is the authority on it.
    rc=0
    PUSH_ARGS=()
    FAKE_CURRENT_BRANCH="feature-x" FAKE_UPSTREAM="origin/main" \
        FAKE_PUSH_DEFAULT="some-future-value" preflight_push_target >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 0 ]; then
        st_ok "unmodelled push.default: deferred to git, not refused"
    else
        st_bad "unmodelled push.default: deferred to git, not refused" "rc=$rc"
    fi

    # P3. Healthy tracking branch: allowed, and PUSH_ARGS stays empty so
    #     the bare `git push` path is preserved verbatim.
    rc=0
    PUSH_ARGS=(sentinel)
    out="$(FAKE_CURRENT_BRANCH="stub-branch" FAKE_UPSTREAM="origin/stub-branch" \
        preflight_push_target 2>&1)" || rc=$?
    FAKE_CURRENT_BRANCH="stub-branch" FAKE_UPSTREAM="origin/stub-branch" \
        preflight_push_target >/dev/null 2>&1 || true
    if [ "$rc" -eq 0 ] && [ "${#PUSH_ARGS[@]}" -eq 0 ]; then
        st_ok "matching upstream: allowed, PUSH_ARGS left empty (bare git push)"
    else
        st_bad "matching upstream: allowed, PUSH_ARGS left empty (bare git push)" \
            "rc=$rc args=${PUSH_ARGS[*]-}"
    fi

    # P4. Never pushed (no upstream at all): the destination is named
    #     explicitly, exactly as before this change.
    rc=0
    PUSH_ARGS=()
    FAKE_CURRENT_BRANCH="brand-new" FAKE_UPSTREAM="" \
        preflight_push_target >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 0 ] && [ "${PUSH_ARGS[*]}" = "--set-upstream origin brand-new" ]; then
        st_ok "no upstream: preflight sets the destination (--set-upstream origin <branch>)"
    else
        st_bad "no upstream: preflight sets the destination" "rc=$rc args=${PUSH_ARGS[*]-}"
    fi

    # P5. Explicit args are the caller's business: forwarded verbatim,
    #     even from a branch whose upstream is mismatched (this is the
    #     documented workaround, and it must keep working).
    rc=0
    PUSH_ARGS=()
    FAKE_CURRENT_BRANCH="claude/x" FAKE_UPSTREAM="origin/main" \
        preflight_push_target -u origin claude/x >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 0 ] && [ "${PUSH_ARGS[*]}" = "-u origin claude/x" ]; then
        st_ok "explicit args: forwarded verbatim, not second-guessed"
    else
        st_bad "explicit args: forwarded verbatim, not second-guessed" \
            "rc=$rc args=${PUSH_ARGS[*]-}"
    fi

    # P6. Detached HEAD with no args: there is no branch to push, and the
    #     gate must not be spent finding that out either.
    rc=0
    PUSH_ARGS=()
    out="$(FAKE_CURRENT_BRANCH="HEAD" FAKE_UPSTREAM="" preflight_push_target 2>&1)" || rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi 'detached'; then
        st_ok "detached HEAD: refused up front, by name"
    else
        st_bad "detached HEAD: refused up front, by name" "rc=$rc out=$out"
    fi

    # P7. ORDERING ratchet — the whole point of #3683. The preflight must
    #     be invoked BEFORE the verifier; a preflight that runs after the
    #     gate reports the same thing eight minutes later, which is the
    #     bug. P1-P6 all stay green under that regression, so assert the
    #     call order in the script body directly.
    #
    #     The lookup lives in a function called from a condition context,
    #     and each capture carries `|| true`. Both matter, because this
    #     ratchet used to defeat its own diagnostics: written inline as
    #     `st_x="$(grep -n … | head -1 | cut -d: -f1)"` under `set -euo
    #     pipefail`, a grep that matched nothing failed the substitution
    #     and aborted the whole self-test with a bare exit 1 — no FAIL
    #     line, no diagnosis — exactly when the anchor had gone missing,
    #     i.e. exactly the regression being ratcheted. The `<not wired>`
    #     message was unreachable. (Demonstrated: deleting the call line
    #     used to end the suite silently mid-run; it now names it.) The
    #     `|| true` is what keeps that true if a future caller stops using
    #     a condition context, where `set -e` would apply again.
    st_line_of() {
        # $1 = anchor regex, $2 = file. Echoes the 1-based line number of
        # the first match, or nothing. Never fails the caller.
        grep -n "$1" "$2" 2>/dev/null | head -1 | cut -d: -f1 || true
    }
    st_order_check() {
        # $1 file, $2 anchor that must come FIRST, $3 anchor that must
        # come after. Echoes a human diagnosis; returns non-zero on any
        # violation, including a MISSING anchor (unwired is a failure, not
        # an excuse to skip).
        local f="$1" first="$2" second="$3" a b
        a="$(st_line_of "$first" "$f")"
        b="$(st_line_of "$second" "$f")"
        if [ -z "$a" ]; then
            echo "<not wired>: no line matching /$first/"
            return 1
        fi
        if [ -z "$b" ]; then
            echo "<anchor missing>: no line matching /$second/"
            return 1
        fi
        if [ "$a" -lt "$b" ]; then
            echo "ok (line $a < $b)"
            return 0
        fi
        echo "<out of order>: /$first/ at line $a is not before /$second/ at line $b"
        return 1
    }

    ST_PRE_ANCHOR='^if ! preflight_push_target'
    ST_VERIFY_ANCHOR='^bash "\$ROOT/scripts/verify-ci-equivalent.sh"'
    rc=0
    out="$(st_order_check "${BASH_SOURCE[0]}" "$ST_PRE_ANCHOR" "$ST_VERIFY_ANCHOR")" || rc=$?
    if [ "$rc" -eq 0 ]; then
        st_ok "preflight runs BEFORE the verify gate — $out"
    else
        st_bad "preflight runs BEFORE the verify gate" "$out"
    fi

    # P7b. The ratchet's own diagnostics must survive the failure they
    #      describe. Two fixture copies of this script — one with the call
    #      line removed, one with the two anchors swapped — must produce a
    #      NAMED message, not a silent abort. Asserting the message, not
    #      just a non-zero status: a bare exit 1 is what the bug looked
    #      like.
    st_fix_dir="$(mktemp -d -t push-sh-st-ratchet.XXXXXX)"
    grep -v "$ST_PRE_ANCHOR" "${BASH_SOURCE[0]}" >"$st_fix_dir/unwired.sh" || true
    rc=0
    out="$(st_order_check "$st_fix_dir/unwired.sh" "$ST_PRE_ANCHOR" "$ST_VERIFY_ANCHOR")" || rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'not wired'; then
        st_ok "ratchet names an UNWIRED preflight instead of aborting silently"
    else
        st_bad "ratchet names an UNWIRED preflight instead of aborting silently" \
            "rc=$rc out=$out"
    fi

    printf 'bash "$ROOT/scripts/verify-ci-equivalent.sh"\nif ! preflight_push_target "$@"; then\n' \
        >"$st_fix_dir/swapped.sh"
    rc=0
    out="$(st_order_check "$st_fix_dir/swapped.sh" "$ST_PRE_ANCHOR" "$ST_VERIFY_ANCHOR")" || rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'out of order'; then
        st_ok "ratchet names a preflight moved BELOW the gate, with both line numbers"
    else
        st_bad "ratchet names a preflight moved BELOW the gate, with both line numbers" \
            "rc=$rc out=$out"
    fi
    rm -rf "$st_fix_dir"

    # ── P7c/P7d: TRUE end-to-end exit codes (#3883) ──────────────────────
    # Everything above exercises functions in-process, sourced-style — it
    # proves `preflight_push_target` RETURNS non-zero, but the original
    # #3883 bug was in the few lines of top-level script body that decide
    # what to do with that return value (an `exit 1` — or, before #3683,
    # nothing at all, falling through to `exit 0`). No function-level test
    # can catch a regression THERE; it requires actually spawning this
    # script and reading its real process exit code, which is what these
    # two cases do — the gap the #3883 report named explicitly ("the
    # self-test presumably exercises failures after the gate, not the
    # pre-flight refusals before it").
    e2e_root="$(mktemp -d -t push-sh-st-e2e.XXXXXX)"

    # P7c. Mismatched upstream, no explicit args: preflight refuses before
    #      the gate runs, and the SCRIPT PROCESS must exit 2 (not 0, not
    #      1 — see EXIT CODES in the header comment). This is the exact
    #      shape of the original #3883 report.
    #
    #      FAKE_PUSH_DEFAULT='' is passed explicitly, empty, on purpose
    #      (#3922): this spawn is a real subprocess that INHERITS this
    #      shell's exported environment, and P2e above sets FAKE_PUSH_
    #      DEFAULT="some-future-value" as a prefix-assignment on a
    #      FUNCTION call — bash's env-for-one-command scoping is not
    #      guaranteed to apply there the way it does for an external
    #      command, so a lingering exported value is a real risk to guard
    #      against, not a hypothetical: an unset FAKE_PUSH_DEFAULT here
    #      would silently inherit whatever is ambient, route
    #      preflight_push_target's `case` to its unmodelled-value `*)`
    #      arm, and pass (rc=0) for the wrong reason. The `unset` near the
    #      top of this self-test block runs once, long before P2e sets it,
    #      so it does not protect this line. P7c-poison, right below,
    #      proves the explicit reset actually matters by forcing exactly
    #      this ambient-leak condition and confirming P7c still exits 2.
    rc=0
    out="$(FAKE_TOPLEVEL="$e2e_root" FAKE_CURRENT_BRANCH="claude/e2e-probe" \
        FAKE_UPSTREAM="origin/main" FAKE_PUSH_DEFAULT='' \
        bash "${BASH_SOURCE[0]}" 2>&1)" || rc=$?
    if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q 'refusing BEFORE the verify gate'; then
        st_ok "end-to-end process exit code: mismatched-upstream refusal exits 2"
    else
        st_bad "end-to-end process exit code: mismatched-upstream refusal exits 2" \
            "rc=$rc out=$out"
    fi

    # P7c-poison. Directly forces the #3922 hazard P7c's comment describes,
    #      instead of relying on P2e's prefix-assignment to leak it (which
    #      this bash/mode combination does not actually do — verified: the
    #      leak is a real bash-version-dependent risk, not one reproducible
    #      here today). FAKE_PUSH_DEFAULT is exported in THIS shell right
    #      before the spawn — exactly the condition an unprotected spawn
    #      would inherit — and P7c's own explicit `FAKE_PUSH_DEFAULT=''`
    #      must still force exit 2. Reverting that explicit reset turns
    #      this case red: the poisoned value would route
    #      preflight_push_target to its unmodelled-value `*)` arm inside
    #      the spawned process and the mismatched-upstream refusal would
    #      never fire (rc=0, no "refusing BEFORE the verify gate" text).
    export FAKE_PUSH_DEFAULT="some-future-value"
    rc=0
    out="$(FAKE_TOPLEVEL="$e2e_root" FAKE_CURRENT_BRANCH="claude/e2e-probe" \
        FAKE_UPSTREAM="origin/main" FAKE_PUSH_DEFAULT='' \
        bash "${BASH_SOURCE[0]}" 2>&1)" || rc=$?
    unset FAKE_PUSH_DEFAULT
    if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q 'refusing BEFORE the verify gate'; then
        st_ok "P7c spawn is immune to an ambient/leaked FAKE_PUSH_DEFAULT (#3922)"
    else
        st_bad "P7c spawn is immune to an ambient/leaked FAKE_PUSH_DEFAULT (#3922)" \
            "rc=$rc out=$out"
    fi

    # P7d. A genuine failure past the gate must still exit 1, not 2 — the
    #      two codes must actually be distinguishable end-to-end, not just
    #      both "some nonzero number". Healthy upstream (preflight passes,
    #      no args needed), a verify-ci-equivalent.sh stub that exits 0
    #      instantly (isolates this case to the push step), and a push
    #      that fails hard.
    mkdir -p "$e2e_root/scripts"
    printf '#!/usr/bin/env bash\nexit 0\n' >"$e2e_root/scripts/verify-ci-equivalent.sh"
    rc=0
    out="$(FAKE_TOPLEVEL="$e2e_root" FAKE_CURRENT_BRANCH="stub-branch" \
        FAKE_UPSTREAM="origin/stub-branch" FAKE_PUSH_BEHAVIOR="fail_hard" \
        PUSH_MAX_ATTEMPTS=1 \
        bash "${BASH_SOURCE[0]}" 2>&1)" || rc=$?
    if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'denied'; then
        st_ok "end-to-end process exit code: a genuine push failure exits 1 (distinct from the 2 above)"
    else
        st_bad "end-to-end process exit code: a genuine push failure exits 1 (distinct from the 2 above)" \
            "rc=$rc out=$out"
    fi
    rm -rf "$e2e_root"

    # ── classify_push_failure (#3683) ────────────────────────────────
    # "verification passed but the PUSH FAILED" read as a network or
    # permissions problem for a failure that never opened a connection.

    # P8. The local refusal.
    st_log="$(mktemp -t push-sh-st-classify.XXXXXX)"
    printf 'fatal: The upstream branch of your current branch does not match\n       the name of your current branch.\n' >"$st_log"
    if [ "$(classify_push_failure "$st_log")" = "local-refusal" ]; then
        st_ok "upstream-name-mismatch failure classified as a LOCAL refusal"
    else
        st_bad "upstream-name-mismatch failure classified as a LOCAL refusal" \
            "$(classify_push_failure "$st_log")"
    fi

    # P9. A genuine remote failure must NOT be relabelled as local — the
    #     misdirection this fixes cuts both ways.
    printf 'remote: Permission to org/repo.git denied to user.\nfatal: unable to access repository: 403\n' >"$st_log"
    if [ "$(classify_push_failure "$st_log")" = "remote" ]; then
        st_ok "permission/transport failure still classified as remote"
    else
        st_bad "permission/transport failure still classified as remote" \
            "$(classify_push_failure "$st_log")"
    fi

    # P9b. A LOCAL pre-push hook rejection (#3883, live incident: a real
    #      `clippy` failure inside the real pre-push hook was reported as
    #      "the PUSH FAILED on the wire"). Fingerprint: git's generic
    #      "failed to push some refs" trailer with NO `remote:` line
    #      anywhere — that combination never originates on the far side.
    printf 'error: could not compile `agaric-store` (lib) due to 3 previous errors\nerror: failed to push some refs to '"'"'github.com:org/repo.git'"'"'\n' >"$st_log"
    if [ "$(classify_push_failure "$st_log")" = "local-rejection" ]; then
        st_ok "hook-rejection failure (no remote: line) classified as a LOCAL rejection, not the wire"
    else
        st_bad "hook-rejection failure (no remote: line) classified as a LOCAL rejection, not the wire" \
            "$(classify_push_failure "$st_log")"
    fi

    # P9d. A SILENT remote pre-receive decline — the regression case a
    #      real adversarial review caught: the far side rejects the ref
    #      but its hook prints nothing, so there is no `remote:` line
    #      either, giving the exact same shape as P9b (generic trailer,
    #      no `remote:` line) EXCEPT for git's own `[remote rejected]`
    #      marker. Verified against a real bare repo with a real
    #      `pre-receive` hook that does `exit 1` (prints nothing):
    #
    #        To .../bare.git
    #         ! [remote rejected] HEAD -> main (pre-receive hook declined)
    #        error: failed to push some refs to '.../bare.git'
    #
    #      This is common in practice (GitHub branch-protection and
    #      required-status-check rejections often present exactly this
    #      way) and MUST classify as `remote`, not `local-rejection` —
    #      the old (pre-#3883) code got this right by falling through to
    #      `remote`; a naive no-`remote:`-line-only heuristic gets it
    #      wrong.
    printf 'To .../bare.git\n ! [remote rejected] HEAD -> main (pre-receive hook declined)\nerror: failed to push some refs to '"'"'.../bare.git'"'"'\n' >"$st_log"
    if [ "$(classify_push_failure "$st_log")" = "remote" ]; then
        st_ok "silent remote pre-receive decline ([remote rejected], no remote: line) stays classified as remote"
    else
        st_bad "silent remote pre-receive decline ([remote rejected], no remote: line) stays classified as remote" \
            "$(classify_push_failure "$st_log")"
    fi

    # P9e. The SAME silent remote rejection as P9d, but reported in
    #      `git push --porcelain` shape instead of the human-readable
    #      status line (#3922): this script forwards arbitrary caller
    #      args straight to `git push`, so `--porcelain` is a shape a
    #      caller can actually select. No `remote:` line here either, and
    #      before #3922 the old anchor (`^ ! \[remote rejected\]`) did not
    #      match this line at all, so it fell through to the no-`remote:`
    #      heuristic and was misclassified as `local-rejection` — the
    #      exact #3883 misattribution, reached via a different transcript.
    printf '!\trefs/heads/main:refs/heads/main\t[remote rejected] (pre-receive hook declined)\nerror: failed to push some refs to '"'"'.../bare.git'"'"'\n' >"$st_log"
    if [ "$(classify_push_failure "$st_log")" = "remote" ]; then
        st_ok "porcelain-shape silent remote rejection ([remote rejected], no remote: line) stays classified as remote"
    else
        st_bad "porcelain-shape silent remote rejection ([remote rejected], no remote: line) stays classified as remote" \
            "$(classify_push_failure "$st_log")"
    fi

    # P9f. Git's OTHER far-side marker, `[remote failure]` — a different
    #      failure mode from `[remote rejected]` (git could not even get a
    #      status report back from the remote) but the same shape problem:
    #      no `remote:` line, and the pre-#3922 anchor only recognized the
    #      word "rejected", not "failure".
    printf 'To .../bare.git\n ! [remote failure] HEAD -> main (remote failed to report status)\nerror: failed to push some refs to '"'"'.../bare.git'"'"'\n' >"$st_log"
    if [ "$(classify_push_failure "$st_log")" = "remote" ]; then
        st_ok "[remote failure] marker (no remote: line) stays classified as remote"
    else
        st_bad "[remote failure] marker (no remote: line) stays classified as remote" \
            "$(classify_push_failure "$st_log")"
    fi

    # P9c. The same generic trailer, but WITH a `remote:` line present,
    #      must stay classified as `remote` — P9b's fingerprint is the
    #      ABSENCE of `remote:`, and a rejection GitHub itself sent back
    #      (e.g. branch protection) must not be misclassified as local
    #      just because it also ends in the same generic trailer.
    printf 'remote: error: GH006: Protected branch update failed.\nerror: failed to push some refs to '"'"'github.com:org/repo.git'"'"'\n' >"$st_log"
    if [ "$(classify_push_failure "$st_log")" = "remote" ]; then
        st_ok "branch-protection rejection (has a remote: line) stays classified as remote"
    else
        st_bad "branch-protection rejection (has a remote: line) stays classified as remote" \
            "$(classify_push_failure "$st_log")"
    fi
    rm -f "$st_log"

    # P10. push_with_retry must hand the caller BOTH the kind and git's
    #      own last words, so the explanation is at the bottom of the log
    #      instead of ~7700 lines up, above the nextest transcript.
    rc=0
    FAKE_PUSH_BEHAVIOR=fail_hard push_with_retry >/dev/null 2>&1 || rc=$?
    if [ "$rc" -ne 0 ] && [ -n "${PUSH_FAILURE_KIND:-}" ] \
        && printf '%s' "${PUSH_FAILURE_TAIL:-}" | grep -q 'denied'; then
        st_ok "push_with_retry exports the failure kind and git's own error tail"
    else
        st_bad "push_with_retry exports the failure kind and git's own error tail" \
            "rc=$rc kind=${PUSH_FAILURE_KIND:-} tail=${PUSH_FAILURE_TAIL:-}"
    fi
    unset PUSH_ARGS

    # P10b. End-to-end through push_with_retry (not just classify_push_
    #       failure in isolation): a hook-rejection-shaped `git push`
    #       failure propagates non-zero AND is classified local-rejection,
    #       so the main script body picks the right branch of its final
    #       `case` and never prints "FAILED on the wire" for this case.
    rc=0
    FAKE_PUSH_BEHAVIOR=fail_hook_rejected push_with_retry >/dev/null 2>&1 || rc=$?
    if [ "$rc" -ne 0 ] && [ "${PUSH_FAILURE_KIND:-}" = "local-rejection" ] \
        && printf '%s' "${PUSH_FAILURE_TAIL:-}" | grep -q 'could not compile'; then
        st_ok "end-to-end hook rejection: non-zero, kind=local-rejection, tail keeps git's real cause"
    else
        st_bad "end-to-end hook rejection: non-zero, kind=local-rejection, tail keeps git's real cause" \
            "rc=$rc kind=${PUSH_FAILURE_KIND:-} tail=${PUSH_FAILURE_TAIL:-}"
    fi

    # ── push_with_retry ──────────────────────────────────────────────

    # 1. A hard (non-transient) failure propagates non-zero and does NOT
    #    retry — an auth/rejected failure must surface immediately, not
    #    get masked by a retry loop.
    attempts_file="$(mktemp -t push-sh-st-attempts.XXXXXX)"
    echo 0 >"$attempts_file"
    rc=0
    FAKE_PUSH_BEHAVIOR=fail_hard FAKE_PUSH_ATTEMPT_FILE="$attempts_file" \
        push_with_retry >/dev/null 2>&1 || rc=$?
    attempts="$(cat "$attempts_file")"
    if [ "$rc" -ne 0 ] && [ "$attempts" -eq 1 ]; then
        st_ok "hard failure: propagates non-zero, exactly 1 attempt (no retry)"
    else
        st_bad "hard failure: propagates non-zero, exactly 1 attempt (no retry)" \
            "rc=$rc attempts=$attempts"
    fi
    rm -f "$attempts_file"

    # 2. A transient (connection-drop) failure that clears on retry
    #    succeeds overall, after more than one attempt.
    attempts_file="$(mktemp -t push-sh-st-attempts.XXXXXX)"
    echo 0 >"$attempts_file"
    rc=0
    FAKE_PUSH_BEHAVIOR=fail_transient_then_ok FAKE_SUCCEED_ON_ATTEMPT=2 \
        FAKE_PUSH_ATTEMPT_FILE="$attempts_file" \
        push_with_retry >/dev/null 2>&1 || rc=$?
    attempts="$(cat "$attempts_file")"
    if [ "$rc" -eq 0 ] && [ "$attempts" -eq 2 ]; then
        st_ok "transient failure: retries and succeeds on attempt 2 (rc=0)"
    else
        st_bad "transient failure: retries and succeeds on attempt 2 (rc=0)" \
            "rc=$rc attempts=$attempts"
    fi
    rm -f "$attempts_file"

    # 3. A transient failure that NEVER clears exhausts PUSH_MAX_ATTEMPTS
    #    and still propagates non-zero (retry is bounded, not a mask).
    attempts_file="$(mktemp -t push-sh-st-attempts.XXXXXX)"
    echo 0 >"$attempts_file"
    rc=0
    FAKE_PUSH_BEHAVIOR=fail_transient FAKE_PUSH_ATTEMPT_FILE="$attempts_file" \
        push_with_retry >/dev/null 2>&1 || rc=$?
    attempts="$(cat "$attempts_file")"
    if [ "$rc" -ne 0 ] && [ "$attempts" -eq "$PUSH_MAX_ATTEMPTS" ]; then
        st_ok "persistent transient failure: bounded retry exhausts at $PUSH_MAX_ATTEMPTS attempts, non-zero"
    else
        st_bad "persistent transient failure: bounded retry exhausts at $PUSH_MAX_ATTEMPTS attempts, non-zero" \
            "rc=$rc attempts=$attempts"
    fi
    rm -f "$attempts_file"

    # 4. The healthy push path: succeeds on the first attempt, rc=0.
    attempts_file="$(mktemp -t push-sh-st-attempts.XXXXXX)"
    echo 0 >"$attempts_file"
    rc=0
    FAKE_PUSH_BEHAVIOR=ok FAKE_PUSH_ATTEMPT_FILE="$attempts_file" \
        push_with_retry >/dev/null 2>&1 || rc=$?
    attempts="$(cat "$attempts_file")"
    if [ "$rc" -eq 0 ] && [ "$attempts" -eq 1 ]; then
        st_ok "healthy push: succeeds on attempt 1, rc=0"
    else
        st_bad "healthy push: succeeds on attempt 1, rc=0" "rc=$rc attempts=$attempts"
    fi
    rm -f "$attempts_file"

    # ── verify_landed ────────────────────────────────────────────────

    # 5. git push reported success, but the remote ref is STALE (the
    #    documented #3380 failure mode: connection drop after the local
    #    branch advanced, git push still exits 0). Must fail loudly.
    rc=0
    FAKE_UPSTREAM="origin/stub-branch" FAKE_LOCAL_SHA="aaaa000000000000000000000000000000000a" \
        FAKE_LSREMOTE_BEHAVIOR=ok FAKE_REMOTE_SHA="bbbb000000000000000000000000000000000b" \
        verify_landed >/dev/null 2>&1 || rc=$?
    if [ "$rc" -ne 0 ]; then
        st_ok "stale remote ref after a 'successful' push: verify_landed fails loudly"
    else
        st_bad "stale remote ref after a 'successful' push: verify_landed fails loudly" "rc=$rc"
    fi

    # 6. ls-remote itself fails (remote unreadable) — cannot confirm the
    #    push landed, must fail rather than assume success.
    rc=0
    FAKE_UPSTREAM="origin/stub-branch" FAKE_LOCAL_SHA="aaaa000000000000000000000000000000000a" \
        FAKE_LSREMOTE_BEHAVIOR=fail \
        verify_landed >/dev/null 2>&1 || rc=$?
    if [ "$rc" -ne 0 ]; then
        st_ok "ls-remote failure: verify_landed fails loudly (does not assume success)"
    else
        st_bad "ls-remote failure: verify_landed fails loudly (does not assume success)" "rc=$rc"
    fi

    # 6b. ls-remote returns nothing (empty — branch not found remotely).
    rc=0
    FAKE_UPSTREAM="origin/stub-branch" FAKE_LOCAL_SHA="aaaa000000000000000000000000000000000a" \
        FAKE_LSREMOTE_BEHAVIOR=empty \
        verify_landed >/dev/null 2>&1 || rc=$?
    if [ "$rc" -ne 0 ]; then
        st_ok "ls-remote empty result: verify_landed fails loudly"
    else
        st_bad "ls-remote empty result: verify_landed fails loudly" "rc=$rc"
    fi

    # 7. Healthy postcondition: local HEAD matches the remote ref exactly.
    rc=0
    FAKE_UPSTREAM="origin/stub-branch" FAKE_LOCAL_SHA="cccc000000000000000000000000000000000c" \
        FAKE_LSREMOTE_BEHAVIOR=ok FAKE_REMOTE_SHA="cccc000000000000000000000000000000000c" \
        verify_landed >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 0 ]; then
        st_ok "matching remote ref: verify_landed passes"
    else
        st_bad "matching remote ref: verify_landed passes" "rc=$rc"
    fi

    # 8. No resolvable upstream (custom remote/refspec push): skips
    #    gracefully (rc=0) rather than guessing — it must not be treated
    #    as a hard failure, but also must not silently claim confirmation.
    rc=0
    FAKE_UPSTREAM="" verify_landed >/tmp/push-sh-st-skip.$$ 2>&1 || rc=$?
    skip_msg="$(cat /tmp/push-sh-st-skip.$$ 2>/dev/null)"
    rm -f /tmp/push-sh-st-skip.$$
    if [ "$rc" -eq 0 ] && printf '%s' "$skip_msg" | grep -q 'skipped'; then
        st_ok "no resolvable upstream: verify_landed skips gracefully (rc=0, notes the skip)"
    else
        st_bad "no resolvable upstream: verify_landed skips gracefully (rc=0, notes the skip)" \
            "rc=$rc msg=$skip_msg"
    fi

    # 8b. Explicit refspec to a branch OTHER than @{u}: verify_landed must
    #     attribute the check to the ACTUAL pushed-to branch, not to the
    #     current branch's unrelated tracking upstream.
    rc=0
    PUSH_ARGS=(origin "HEAD:release")
    FAKE_UPSTREAM="origin/main" FAKE_LOCAL_SHA="eeee000000000000000000000000000000000e" \
        FAKE_REMOTE_SHA_release="eeee000000000000000000000000000000000e" \
        FAKE_REMOTE_SHA_main="0000000000000000000000000000000000000f" \
        verify_landed >/dev/null 2>&1 || rc=$?
    unset PUSH_ARGS
    if [ "$rc" -eq 0 ]; then
        st_ok "explicit refspec to non-@{u} branch: verify_landed checks the actual target, passes"
    else
        st_bad "explicit refspec to non-@{u} branch: verify_landed checks the actual target, passes" "rc=$rc"
    fi

    # 8c. The dangerous case: an explicit refspec target that did NOT
    #     land, while local HEAD coincidentally equals the SHA of the
    #     current branch's unrelated @{u} target. A postcondition that
    #     (wrongly) fell back to @{u} here would false-PASS. It must
    #     fail, because the branch actually targeted (release) doesn't
    #     match.
    rc=0
    PUSH_ARGS=(origin "HEAD:release")
    FAKE_UPSTREAM="origin/main" FAKE_LOCAL_SHA="ffff000000000000000000000000000000000f" \
        FAKE_REMOTE_SHA_release="0000000000000000000000000000000000000a" \
        FAKE_REMOTE_SHA_main="ffff000000000000000000000000000000000f" \
        verify_landed >/dev/null 2>&1 || rc=$?
    unset PUSH_ARGS
    if [ "$rc" -ne 0 ]; then
        st_ok "explicit refspec target mismatch is NOT masked by a coincidental @{u} SHA match"
    else
        st_bad "explicit refspec target mismatch is NOT masked by a coincidental @{u} SHA match" "rc=$rc"
    fi

    # 8d. `push.sh origin` (remote only, no explicit branch): the target
    #     branch follows the current branch name, attributed directly —
    #     without relying on @{u} at all.
    rc=0
    PUSH_ARGS=(origin)
    out="$(FAKE_CURRENT_BRANCH="stub-branch" FAKE_LOCAL_SHA="1111000000000000000000000000000000000a" \
        FAKE_REMOTE_SHA_stub_branch="1111000000000000000000000000000000000a" \
        verify_landed 2>&1)" || rc=$?
    unset PUSH_ARGS
    # Must actually attribute and check (not silently skip) — rc==0 alone
    # doesn't distinguish "correctly checked" from "gracefully skipped".
    if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'postcondition:'; then
        st_ok "remote-only explicit arg (push.sh origin): attributes via current branch name, passes"
    else
        st_bad "remote-only explicit arg (push.sh origin): attributes via current branch name, passes" \
            "rc=$rc out=$out"
    fi

    # 8e. Refspec whose LOCAL side is a named branch, not HEAD (e.g. `git
    #     push origin feature-x:remote-target` run from a different
    #     checked-out branch): the postcondition must read the SHA of the
    #     actual local ref named in the refspec, not silently fall back
    #     to HEAD.
    rc=0
    PUSH_ARGS=(origin "feature-x:remote-target")
    out="$(FAKE_LOCAL_SHA="0000000000000000000000000000000000000b" \
        FAKE_LOCAL_SHA_feature_x="2222000000000000000000000000000000000a" \
        FAKE_REMOTE_SHA_remote_target="2222000000000000000000000000000000000a" \
        verify_landed 2>&1)" || rc=$?
    unset PUSH_ARGS
    if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'postcondition:'; then
        st_ok "refspec with non-HEAD local side: verify_landed reads the named local ref, passes"
    else
        st_bad "refspec with non-HEAD local side: verify_landed reads the named local ref, passes" \
            "rc=$rc out=$out"
    fi

    # 8f. Ambiguous target (--tags, or multiple refspecs): must skip
    #     gracefully rather than guess at a single branch to check.
    rc=0
    PUSH_ARGS=(--tags)
    verify_landed >/tmp/push-sh-st-skip-tags.$$ 2>&1 || rc=$?
    skip_msg="$(cat /tmp/push-sh-st-skip-tags.$$ 2>/dev/null)"
    rm -f /tmp/push-sh-st-skip-tags.$$
    unset PUSH_ARGS
    if [ "$rc" -eq 0 ] && printf '%s' "$skip_msg" | grep -q 'skipped'; then
        st_ok "--tags: verify_landed skips gracefully (rc=0, notes the skip) rather than guessing"
    else
        st_bad "--tags: verify_landed skips gracefully (rc=0, notes the skip) rather than guessing" \
            "rc=$rc msg=$skip_msg"
    fi

    # 8g. Explicit bare tag name (`git push origin v1.2.3`): must be
    #     detected as a tag push and skipped gracefully — treating the
    #     tag name as if it were a branch would silently check (or
    #     false-fail against) the wrong ref.
    rc=0
    PUSH_ARGS=(origin "v1.2.3")
    out="$(FAKE_TAG_EXISTS="v1.2.3" verify_landed 2>&1)" || rc=$?
    unset PUSH_ARGS
    if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'skipped'; then
        st_ok "explicit bare tag name push: detected as a tag, skips gracefully"
    else
        st_bad "explicit bare tag name push: detected as a tag, skips gracefully" "rc=$rc out=$out"
    fi

    # 8h. Explicit bare name that is a BRANCH, not a tag (`git push origin
    #     release`): must NOT be treated as a tag push — it should still
    #     be attributed and checked normally.
    rc=0
    PUSH_ARGS=(origin "release")
    out="$(FAKE_LOCAL_BRANCH_EXISTS="release" \
        FAKE_LOCAL_SHA_release="3333000000000000000000000000000000000a" \
        FAKE_REMOTE_SHA_release="3333000000000000000000000000000000000a" \
        verify_landed 2>&1)" || rc=$?
    unset PUSH_ARGS
    if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'postcondition:'; then
        st_ok "explicit bare branch name push: not mistaken for a tag, attributes and checks"
    else
        st_bad "explicit bare branch name push: not mistaken for a tag, attributes and checks" \
            "rc=$rc out=$out"
    fi

    # 9. End-to-end: push fails outright -> the same non-zero/zero shape
    #    the real script below acts on (belt-and-suspenders on the
    #    push_with_retry contract the main flow relies on).
    rc=0
    FAKE_PUSH_BEHAVIOR=fail_hard push_with_retry >/dev/null 2>&1 || rc=$?
    if [ "$rc" -ne 0 ]; then
        st_ok "end-to-end: failed push -> non-zero (script would report NOT pushed)"
    else
        st_bad "end-to-end: failed push -> non-zero (script would report NOT pushed)" "rc=$rc"
    fi

    # 10. End-to-end healthy path: push succeeds AND postcondition matches
    #     -> overall zero (script would report pushed + confirmed).
    rc=0
    FAKE_PUSH_BEHAVIOR=ok push_with_retry >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 0 ]; then
        FAKE_UPSTREAM="origin/stub-branch" FAKE_LOCAL_SHA="dddd000000000000000000000000000000000d" \
            FAKE_LSREMOTE_BEHAVIOR=ok FAKE_REMOTE_SHA="dddd000000000000000000000000000000000d" \
            verify_landed >/dev/null 2>&1 || rc=$?
    fi
    if [ "$rc" -eq 0 ]; then
        st_ok "end-to-end: healthy push + matching ref -> overall zero"
    else
        st_bad "end-to-end: healthy push + matching ref -> overall zero" "rc=$rc"
    fi

    rm -rf "$fake_git_dir"

    # P11. The exit-code split documented above the fixture loop is only
    #      intent until proven end-to-end — the same reason P7c/P7d spawn
    #      a real subprocess and read its actual exit code rather than
    #      modeling it. A fixture COPY of this whole script is doctored
    #      (via sed) so its OWN self-test run always fails (`st_fail`
    #      forced to 1) and then actually run; the process's real exit
    #      code must be 3, not 2 (which now means exclusively "pre-flight
    #      refusal" — see EXIT CODES above). PUSH_SH_ST_META_DEPTH guards
    #      against infinite recursion: the spawned copy also contains this
    #      same P11 case, and would otherwise spawn a further doctored
    #      copy of itself forever; exporting the guard for the ONE nested
    #      invocation makes it skip its own P11 rather than recurse.
    if [ "${PUSH_SH_ST_META_DEPTH:-}" != "1" ]; then
        st_meta_fixture="$(mktemp -t push-sh-st-meta.XXXXXX)"
        sed 's/^    st_fail=0$/    st_fail=1 # forced failure — #3922 P11 meta-fixture/' \
            "${BASH_SOURCE[0]}" >"$st_meta_fixture"
        rc=0
        PUSH_SH_ST_META_DEPTH=1 bash "$st_meta_fixture" --self-test >/dev/null 2>&1 || rc=$?
        rm -f "$st_meta_fixture"
        if [ "$rc" -eq 3 ]; then
            st_ok "a failed self-test run exits 3, distinct from the real EXIT CODES 0/1/2 contract (#3922)"
        else
            st_bad "a failed self-test run exits 3, distinct from the real EXIT CODES 0/1/2 contract (#3922)" \
                "rc=$rc"
        fi
    fi

    if [ "$st_fail" != 0 ]; then
        echo "push.sh self-test FAILED" >&2
        exit 3
    fi
    echo "push.sh self-test passed"
    exit 0
fi

ROOT="$(git rev-parse --show-toplevel)"

# Resolve (and validate) the destination FIRST — it costs a git config
# read, and an unpushable refspec is not worth an ~8-minute gate to
# discover (#3683). PUSH_ARGS is built here and used unchanged below.
#
# Exit 2, not 1 (#3883): `preflight_push_target` already printed a full
# diagnosis to stderr and returned before the gate ran or anything was
# attempted — this is a usage/config refusal, not a push failure, and a
# caller branching on the exit code should be able to tell them apart
# (see EXIT CODES in the header comment). Exiting 0 here — the original
# #3883 report — is what made a real refusal read as a successful push.
if ! preflight_push_target "$@"; then
    exit 2
fi

echo ""
echo "▶ Verifying (CI-equivalent) BEFORE opening any push connection…"
bash "$ROOT/scripts/verify-ci-equivalent.sh"

echo "✓ Verification passed — pushing now (pre-push verify skipped: already green)…"

# Reason string handed to the pre-push verifier so it short-circuits
# (the verifier already ran, above). Must be a descriptive reason, not a
# truthy flag — the guard rejects `SKIP_CI_VERIFY=1`.
SKIP_REASON="push.sh: verifier already ran before opening the connection"
export SKIP_CI_VERIFY="$SKIP_REASON"

# Belt-and-suspenders: even though the pre-push hook now short-circuits (so
# the connection is not held idle), keep SSH keepalives on so a slow pack
# upload or a future longer no-skip path can't be dropped mid-transfer by
# GitHub's idle timeout. Respects any GIT_SSH_COMMAND the caller already set.
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o ServerAliveInterval=15 -o ServerAliveCountMax=60 -o TCPKeepAlive=yes"

# PUSH_ARGS was built (and validated) by preflight_push_target, above the
# verifier — an unpushable destination never gets this far (#3683).

echo ""
if ! push_with_retry "${PUSH_ARGS[@]+"${PUSH_ARGS[@]}"}"; then
    echo "" >&2
    case "${PUSH_FAILURE_KIND:-}" in
        local-refusal)
            echo "✗ the push was REFUSED LOCALLY — it never left this machine." >&2
            echo "  Nothing was sent to the remote and nothing there changed. This is a" >&2
            echo "  branch/refspec configuration problem, NOT a network or permissions one:" >&2
            echo "  look at the local branch config below, not at the connection." >&2
            ;;
        local-rejection)
            # #3883: this used to be lumped in with "remote" below, which
            # reads as a network/permissions problem — exactly wrong for a
            # LOCAL pre-push hook rejection (clippy, fmt, npm-audit, knip,
            # lychee — see THE PRE-PUSH HOOK IS NOT FULLY COVERED in the
            # header) or a non-fast-forward. Neither one is "the wire".
            echo "✗ the push was REJECTED — nothing landed, and it does NOT look like a wire failure." >&2
            echo "  Git did not mark this a remote rejection, and no \`remote:\` line appears" >&2
            echo "  anywhere in git's output below — most likely either a LOCAL pre-push hook" >&2
            echo "  said no (one of the checks push.sh's own gate above does NOT cover:" >&2
            echo "  clippy, cargo fmt --check, npm-audit, knip, lychee — see THE PRE-PUSH HOOK" >&2
            echo "  IS NOT FULLY COVERED at the top of this script), or the remote moved out" >&2
            echo "  from under this branch (non-fast-forward — fetch/rebase and retry). This" >&2
            echo "  is a heuristic based on git's transcript shape, not a certainty — read" >&2
            echo "  git's own words below before ruling out the connection." >&2
            ;;
        *)
            echo "✗ verification passed but the PUSH FAILED on the wire — the branch was NOT updated." >&2
            echo "  git push reached the remote and did not succeed (after retries where" >&2
            echo "  applicable); nothing landed." >&2
            ;;
    esac
    if [ -n "${PUSH_FAILURE_TAIL:-}" ]; then
        echo "" >&2
        echo "  git said:" >&2
        printf '%s\n' "$PUSH_FAILURE_TAIL" | sed 's/^/    /' >&2
    fi
    exit 1
fi

echo ""
echo "→ Confirming the push actually landed (postcondition: local HEAD vs remote ref)…"
if ! verify_landed; then
    echo "" >&2
    echo "✗ push.sh FAILED at the postcondition check — do not trust this push as landed." >&2
    exit 1
fi

echo ""
echo "✓ push.sh: verified, pushed, and confirmed landed on the remote."
