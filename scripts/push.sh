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
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── git push wrapper: bounded retry on known-transient drops only ──
# Exit status mirrors the last `git push` attempt. Overridable via
# PUSH_MAX_ATTEMPTS / PUSH_RETRY_SLEEP.
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
# never has `[remote rejected]` either — git's own trailer (`error:
# failed to push some refs
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
