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
# branch, the upstream it found, and the one-line fix. And when a push
# does fail, the message distinguishes a LOCAL refusal (nothing left the
# machine; look at branch config) from a failure on the wire (look at the
# connection), and echoes git's own last words at the bottom.
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

classify_push_failure() {
    # $1 = path to the captured git-push output. Echoes `local-refusal`
    # (git refused before opening/using the connection) or `remote`.
    if grep -qE "$PUSH_LOCAL_REFUSAL_RE" "$1"; then
        echo "local-refusal"
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
        PUSH_FAILURE_TAIL="$(grep -E '^(fatal|error|remote:|hint):?' "$log" | tail -5)"
        [ -z "$PUSH_FAILURE_TAIL" ] && PUSH_FAILURE_TAIL="$(tail -5 "$log")"
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

    # Upstream names a DIFFERENT branch. Whether that is fatal depends on
    # push.default: `current` resolves the destination from the branch
    # name and ignores the upstream entirely, so it still works.
    push_default="$(git config --get push.default 2>/dev/null || true)"
    if [ "$push_default" = "current" ]; then
        echo "→ Push destination: origin/$branch (push.default=current; upstream '$upstream' not used as the destination)"
        return 0
    fi

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
#   FAKE_PUSH_BEHAVIOR      ok | fail_hard | fail_transient | fail_transient_then_ok
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
    out="$(FAKE_CURRENT_BRANCH="feature-x" FAKE_UPSTREAM="origin/main" \
        FAKE_PUSH_DEFAULT="current" preflight_push_target 2>&1)" || rc=$?
    if [ "$rc" -eq 0 ]; then
        st_ok "mismatched upstream under push.default=current: allowed (git resolves by branch name)"
    else
        st_bad "mismatched upstream under push.default=current: allowed" "rc=$rc out=$out"
    fi

    # P3. Healthy tracking branch: allowed, and PUSH_ARGS stays empty so
    #     the bare `git push` path is preserved verbatim.
    rc=0
    PUSH_ARGS=(sentinel)
    out="$(FAKE_CURRENT_BRANCH="stub-branch" FAKE_UPSTREAM="origin/stub-branch" \
        preflight_push_target 2>&1)" || rc=$?
    FAKE_CURRENT_BRANCH="stub-branch" FAKE_UPSTREAM="origin/stub-branch" \
        preflight_push_target >/dev/null 2>&1
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
    st_pre_line="$(grep -n '^if ! preflight_push_target' "${BASH_SOURCE[0]}" | head -1 | cut -d: -f1)"
    st_verify_line="$(grep -n '^bash "\$ROOT/scripts/verify-ci-equivalent.sh"' "${BASH_SOURCE[0]}" | head -1 | cut -d: -f1)"
    if [ -n "$st_pre_line" ] && [ -n "$st_verify_line" ] && [ "$st_pre_line" -lt "$st_verify_line" ]; then
        st_ok "preflight runs BEFORE the verify gate (line $st_pre_line < $st_verify_line)"
    else
        st_bad "preflight runs BEFORE the verify gate" \
            "preflight=${st_pre_line:-<not wired>} verify=${st_verify_line:-<not found>}"
    fi

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

    if [ "$st_fail" != 0 ]; then
        echo "push.sh self-test FAILED" >&2
        exit 2
    fi
    echo "push.sh self-test passed"
    exit 0
fi

ROOT="$(git rev-parse --show-toplevel)"

# Resolve (and validate) the destination FIRST — it costs a git config
# read, and an unpushable refspec is not worth an ~8-minute gate to
# discover (#3683). PUSH_ARGS is built here and used unchanged below.
if ! preflight_push_target "$@"; then
    exit 1
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
    if [ "${PUSH_FAILURE_KIND:-}" = "local-refusal" ]; then
        echo "✗ the push was REFUSED LOCALLY — it never left this machine." >&2
        echo "  Nothing was sent to the remote and nothing there changed. This is a" >&2
        echo "  branch/refspec configuration problem, NOT a network or permissions one:" >&2
        echo "  look at the local branch config below, not at the connection." >&2
    else
        echo "✗ verification passed but the PUSH FAILED on the wire — the branch was NOT updated." >&2
        echo "  git push reached the remote and did not succeed (after retries where" >&2
        echo "  applicable); nothing landed." >&2
    fi
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
