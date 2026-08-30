#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# prepare-commit-msg hook: auto-append a `Signed-off-by` trailer when the
# message carries none that matches the COMMIT AUTHOR, so the DCO check on
# CI (`.github/workflows/dco.yml`) never rejects a PR for a forgotten
# `git commit -s`. Mirrors what `git commit -s` would emit; idempotent —
# does nothing when a matching trailer is already present (for merge /
# amend / message-template commits).
#
# WHY THE MATCH IS ON THE AUTHOR'S EMAIL AND NOT ON "any trailer" (#4561):
# this hook used to skip whenever the message contained ANY
# `Signed-off-by:` line. CI does not accept any trailer — `dco.yml` accepts
# a commit only if some trailer names the commit AUTHOR's email:
#
#     grep -iE '^[[:space:]]*signed-off-by:[[:space:]]' | grep -qiF "<${author_email}>"
#
# So a message carrying only a CO-AUTHOR's or an agent's sign-off — e.g.
# `Signed-off-by: Claude <noreply@anthropic.com>` on a commit authored by a
# human — satisfied the old skip, suppressed the append, and produced a
# commit that passed every local hook and failed `dco` on CI. That is a
# silent fail-open in a guard whose entire job is to make CI's answer
# predictable locally, and the agent-authored-trailer style it misfires on
# is this repo's dominant commit style. Three PRs went red on it in one
# session before the cause was found, each costing a full local gate plus a
# CI round to rediscover.
#
# The email comparison is `grep -iF` on the bracketed address, NOT an ERE:
# a `+` in a valid address (`user+tag@example.com`) is a quantifier in an
# ERE and would reject a legitimate sign-off. `dco.yml` carries the same
# note for the same reason — the two must agree, and the fixed-string match
# is what makes them agree.
#
# Author identity comes from `git var GIT_AUTHOR_IDENT`, not from
# `git config user.email`, because that is what the resulting commit's
# author will be: it already accounts for `GIT_AUTHOR_EMAIL` and for
# `git commit --author=...`, both of which change what CI checks against
# while leaving `user.email` untouched.
#
# Invoked by prek's `prepare-commit-msg` stage. Git passes the commit
# message file as $1; $2/$3 are the commit source and SHA (unused).
#
# `--self-test` runs the fixture suite below. It is NOT wired as a prek
# hook: #4556 is concurrently unwiring self-test hooks wholesale, and
# adding one here would fight that decision in the same file it is
# rewriting. It earns one under #4556's own criterion 5 (a text-parsing
# guard with a RECORDED fail-open incident — this one), so wiring it
# belongs in #4556 Phase 2, which is where self-tests get restaged.
# Until then: run it by hand after touching the matching logic.
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

# Email of the identity the commit will actually be authored by.
# `git var GIT_AUTHOR_IDENT` yields `Name <email> <ts> <tz>`.
author_email() {
    local ident
    ident="$(git var GIT_AUTHOR_IDENT 2>/dev/null || true)"
    if [ -n "$ident" ]; then
        printf '%s' "$ident" | sed -n 's/.*<\([^>]*\)>.*/\1/p' | head -n1
        return 0
    fi
    git config --get user.email 2>/dev/null || true
}

author_name() {
    local ident
    ident="$(git var GIT_AUTHOR_IDENT 2>/dev/null || true)"
    if [ -n "$ident" ]; then
        printf '%s' "$ident" | sed -n 's/^\(.*\) <[^>]*>.*/\1/p' | head -n1
        return 0
    fi
    git config --get user.name 2>/dev/null || true
}

# True when $1 (a message file) already carries a Signed-off-by naming $2.
# Deliberately the same two-stage form as `.github/workflows/dco.yml`:
# select sign-off lines with a fixed regex, then match the address as a
# FIXED STRING so a `+` in it cannot act as a quantifier.
has_matching_signoff() {
    local file="$1" email="$2" signoffs
    [ -n "$email" ] || return 1
    # Two stages, but NOT as a pipeline. `set -o pipefail` is on, and a
    # pipeline ending in `grep -q` can have its producer SIGPIPE-killed by the
    # consumer's early exit, giving 141 — read as "no match", which would
    # append a duplicate trailer. A commit message is small enough that this
    # would not fire in practice, but the cost of not depending on that is a
    # single variable. (`dco.yml` carries the same pipeline shape; the same
    # reasoning applies there, where the consequence is only a re-run.)
    signoffs="$(grep -iE '^[[:space:]]*signed-off-by:[[:space:]]' "$file" 2>/dev/null || true)"
    [ -n "$signoffs" ] || return 1
    printf '%s\n' "$signoffs" | grep -qiF "<${email}>"
}

# True when $1 is shaped like a trailer line (`Token: value`). Necessary
# for a trailer, nowhere near sufficient — see `joins_trailer_block`.
looks_like_trailer() {
    printf '%s' "$1" | grep -qE '^[A-Za-z][A-Za-z-]*:[[:space:]]'
}

# True when a trailer appended to $1 (a message file) would land INSIDE an
# existing trailer block, rather than starting one.
#
# "Looks like a trailer" is not enough, and getting this wrong is worse than
# never joining at all. `^[A-Za-z][A-Za-z-]*:[[:space:]]` also matches a
# Conventional Commits subject (`chore: bump deps`, `docs: ...`; scoped forms
# escape only because `(` is outside the class) and ordinary prose
# (`Note: this matters.`). Two concrete regressions that shape caused:
#
#   1. `git commit -m "chore: bump deps"` — the subject IS the last non-blank
#      line, so no blank line was inserted and the sign-off joined the FIRST
#      paragraph. Git renders `%s` and `--oneline` as that whole paragraph
#      joined with spaces, so the subject reads
#      `chore: bump deps Signed-off-by: ...` forever after.
#   2. A body paragraph whose last line is `Word: text`. The sign-off is glued
#      onto the prose, and git-interpret-trailers(1) requires the trailer block
#      to be the last paragraph AND at least 25% trailer lines — so a body of
#      more than ~3 lines stops parsing as trailers at all. That is exactly the
#      "the sign-off stops being visible as a trailer" failure the join was
#      added to prevent, reintroduced through a different input.
#
# So require the candidate line to actually SIT in a trailer block: it is
# trailer-shaped, it is NOT the message's first line, and the line before it is
# blank (it opens the last paragraph) or is itself trailer-shaped (it continues
# one). Comment lines are dropped first — git strips them from the message, so
# they are not part of the shape being reasoned about.
joins_trailer_block() {
    local file="$1" i last prev
    local -a lines=()
    mapfile -t lines < <(grep -v '^#' "$file" 2>/dev/null || true)

    last=-1
    for ((i = ${#lines[@]} - 1; i >= 0; i--)); do
        if [ -n "${lines[i]//[[:space:]]/}" ]; then
            last=$i
            break
        fi
    done

    # No content, or the only content line is the subject: never join.
    [ "$last" -gt 0 ] || return 1
    looks_like_trailer "${lines[last]}" || return 1

    prev="${lines[last - 1]}"
    [ -z "${prev//[[:space:]]/}" ] && return 0
    looks_like_trailer "$prev"
}

append_signoff() {
    local file="$1" name="$2" email="$3"
    # Append a trailing newline if the message doesn't already end with one.
    # `git interpret-trailers` would also work but pulls in extra
    # normalisation we don't want for human-edited messages.
    if [ -s "$file" ] && [ "$(tail -c1 "$file" | wc -l)" -eq 0 ]; then
        printf '\n' >>"$file"
    fi
    # Join an existing trailer block rather than starting a second one: a
    # blank line between trailers splits them, and git's own parsing reads
    # only the LAST block — so a message ending in `Signed-off-by: <agent>`
    # would get the author trailer in a block of its own and the agent's
    # would stop being visible as a trailer at all. CI's `dco.yml` greps the
    # raw message and does not care, but the commit is the permanent record.
    if ! joins_trailer_block "$file"; then
        printf '\n' >>"$file"
    fi
    printf 'Signed-off-by: %s <%s>\n' "$name" "$email" >>"$file"
}

main() {
    local msg_file="${1:?prepare-commit-msg: missing message file argument}"
    local name email
    name="$(author_name)"
    email="$(author_email)"

    if [ -z "$name" ] || [ -z "$email" ]; then
        # No identity resolvable — let git's own validation surface the error
        # instead of crashing the hook.
        exit 0
    fi

    if has_matching_signoff "$msg_file" "$email"; then
        exit 0
    fi

    append_signoff "$msg_file" "$name" "$email"
}

# ── self-test ────────────────────────────────────────────────────────
self_test() {
    local tmp fails=0 checked=0
    local SCRIPT_PATH
    SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
    tmp="$(mktemp -d -t dco-signoff-selftest.XXXXXX)"

    # The `main()` fixtures below run `git init` in $tmp. That looks isolated
    # and is not: when this suite runs from a git hook, git has exported
    # GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE pointing at the REAL repository,
    # and those OUTRANK both `git -C <dir>` and a subshell `cd` — so an
    # unscrubbed `git init` re-inits the developer's own repo and rewrites its
    # `core.worktree` to a directory this function is about to delete. That has
    # happened here three times (#3690, #3722, #3736, #4015). Shared scrub, not
    # a private copy: a per-script fix does not end the class, it just moves the
    # next occurrence somewhere new.
    # shellcheck source=scripts/lib/git-scratch-guard.sh
    . "$(dirname "$SCRIPT_PATH")/lib/git-scratch-guard.sh"
    git_scratch_guard "$tmp"
    # EXIT, not RETURN: the closing `[ "$fails" -eq 0 ]` trips `set -e` on a
    # failing run, which is exactly the run whose temp dir a RETURN trap does
    # not reliably reap.
    # Path expanded at trap-set time: `$tmp` is `local` to this function and is
    # already out of scope when an EXIT trap fires.
    # shellcheck disable=SC2064
    trap "rm -rf -- '$tmp'" EXIT

    check() {
        local desc="$1" cond="$2"
        checked=$((checked + 1))
        if [ "$cond" = "0" ]; then
            printf '  ok  - %s\n' "$desc"
        else
            printf '  FAIL - %s\n' "$desc"
            fails=$((fails + 1))
        fi
    }

    # A message carrying ONLY an agent/co-author sign-off must still get the
    # author's own trailer appended. This is #4561, the whole reason the
    # match is on the author's email; the pre-#4561 hook returned 0 here.
    printf 'subject\n\nSigned-off-by: Claude <noreply@anthropic.com>\n' >"$tmp/agent"
    has_matching_signoff "$tmp/agent" "dev@example.com" && r=0 || r=1
    check '#4561: an agent-only sign-off does NOT satisfy a different author' "$([ "$r" = 1 ] && echo 0 || echo 1)"

    # The author's own trailer satisfies it — idempotent on amend.
    printf 'subject\n\nSigned-off-by: Dev <dev@example.com>\n' >"$tmp/own"
    has_matching_signoff "$tmp/own" "dev@example.com" && r=0 || r=1
    check 'an author-matching sign-off satisfies the check (idempotent on amend)' "$r"

    # Both present — still satisfied, so a co-authored commit is not
    # double-stamped on every amend.
    printf 'subject\n\nSigned-off-by: Claude <noreply@anthropic.com>\nSigned-off-by: Dev <dev@example.com>\n' >"$tmp/both"
    has_matching_signoff "$tmp/both" "dev@example.com" && r=0 || r=1
    check 'an agent trailer alongside the author trailer is satisfied' "$r"

    # `+` in the address must not act as an ERE quantifier. The literal
    # address is present, so this MUST match; an ERE would reject it.
    printf 'subject\n\nSigned-off-by: Dev <dev+tag@example.com>\n' >"$tmp/plus"
    has_matching_signoff "$tmp/plus" "dev+tag@example.com" && r=0 || r=1
    check 'a `+` in the address is matched literally, not as a quantifier' "$r"

    # ...and the quantifier reading must not make a DIFFERENT address pass.
    printf 'subject\n\nSigned-off-by: Dev <devvvtag@example.com>\n' >"$tmp/quant"
    has_matching_signoff "$tmp/quant" "dev+tag@example.com" && r=0 || r=1
    check 'the `+` form does not match an address an ERE would have accepted' "$([ "$r" = 1 ] && echo 0 || echo 1)"

    # Case-insensitive on both the trailer key and the address, matching CI.
    printf 'subject\n\nsigned-off-by: Dev <DEV@Example.COM>\n' >"$tmp/case"
    has_matching_signoff "$tmp/case" "dev@example.com" && r=0 || r=1
    check 'trailer key and address are both matched case-insensitively' "$r"

    # No trailer at all — the original forgotten-`-s` case.
    printf 'subject\n' >"$tmp/none"
    has_matching_signoff "$tmp/none" "dev@example.com" && r=0 || r=1
    check 'a message with no sign-off is not satisfied' "$([ "$r" = 1 ] && echo 0 || echo 1)"

    # A `Co-authored-by:` trailer is not a sign-off and must not satisfy it.
    printf 'subject\n\nCo-authored-by: Dev <dev@example.com>\n' >"$tmp/coauth"
    has_matching_signoff "$tmp/coauth" "dev@example.com" && r=0 || r=1
    check 'a Co-authored-by trailer is not a sign-off' "$([ "$r" = 1 ] && echo 0 || echo 1)"

    # append_signoff produces a trailer the check then accepts, and adds the
    # separating newline when the message does not end in one.
    printf 'subject' >"$tmp/append"
    append_signoff "$tmp/append" "Dev" "dev@example.com"
    has_matching_signoff "$tmp/append" "dev@example.com" && r=0 || r=1
    check 'append_signoff emits a trailer that satisfies the check' "$r"

    # The appended trailer JOINS an existing trailer block rather than
    # starting a second one — a blank line between them would make git's
    # own parser read only the last block, hiding the agent's trailer.
    printf 'subject\n\nSigned-off-by: Claude <noreply@anthropic.com>\n' >"$tmp/join"
    append_signoff "$tmp/join" "Dev" "dev@example.com"
    printf 'subject\n\nSigned-off-by: Claude <noreply@anthropic.com>\nSigned-off-by: Dev <dev@example.com>\n' >"$tmp/join.want"
    cmp -s "$tmp/join" "$tmp/join.want" && r=0 || r=1
    check 'the sign-off joins an existing trailer block, with no blank line' "$r"

    # ...but a message ending in PROSE still gets its separating blank line,
    # or the trailer would be swallowed into the body paragraph.
    printf 'subject\n\nSome prose paragraph.\n' >"$tmp/prose"
    append_signoff "$tmp/prose" "Dev" "dev@example.com"
    printf 'subject\n\nSome prose paragraph.\n\nSigned-off-by: Dev <dev@example.com>\n' >"$tmp/prose.want"
    cmp -s "$tmp/prose" "$tmp/prose.want" && r=0 || r=1
    check 'a message ending in prose still gets a separating blank line' "$r"

    # A single-line Conventional Commits subject is trailer-SHAPED but is not a
    # trailer block. Joining it puts the sign-off in the message's first
    # paragraph, and git renders `%s`/`--oneline` as that whole paragraph joined
    # with spaces — so the subject would read `chore: bump deps Signed-off-by:
    # ...` permanently. Scoped subjects (`fix(guards):`) never matched; every
    # unscoped `chore:`/`docs:`/`test:`/`fix:` did.
    printf 'chore: bump deps\n' >"$tmp/subj"
    append_signoff "$tmp/subj" "Dev" "dev@example.com"
    printf 'chore: bump deps\n\nSigned-off-by: Dev <dev@example.com>\n' >"$tmp/subj.want"
    cmp -s "$tmp/subj" "$tmp/subj.want" && r=0 || r=1
    check 'a single-line `chore:` subject is NOT joined — it is a subject, not a trailer block' "$r"

    # Prose whose LAST line happens to be `Word: text`, in a paragraph long
    # enough that git-interpret-trailers(1)'s 25%-trailer-lines rule would stop
    # recognising a trailer block at all if the sign-off were glued on.
    printf 'subject\n\nline one\nline two\nline three\nNote: this matters.\n' >"$tmp/notetail"
    append_signoff "$tmp/notetail" "Dev" "dev@example.com"
    printf 'subject\n\nline one\nline two\nline three\nNote: this matters.\n\nSigned-off-by: Dev <dev@example.com>\n' >"$tmp/notetail.want"
    cmp -s "$tmp/notetail" "$tmp/notetail.want" && r=0 || r=1
    check 'a body paragraph ending in `Note: ...` is NOT joined — the line before it is prose' "$r"

    # ...but a real trailer block whose predecessor is also a trailer still
    # joins, so the fix above did not simply disable joining.
    printf 'subject\n\nCo-authored-by: A <a@example.com>\nSigned-off-by: Claude <noreply@anthropic.com>\n' >"$tmp/twotrailers"
    append_signoff "$tmp/twotrailers" "Dev" "dev@example.com"
    printf 'subject\n\nCo-authored-by: A <a@example.com>\nSigned-off-by: Claude <noreply@anthropic.com>\nSigned-off-by: Dev <dev@example.com>\n' >"$tmp/twotrailers.want"
    cmp -s "$tmp/twotrailers" "$tmp/twotrailers.want" && r=0 || r=1
    check 'a multi-line trailer block is still joined (the fix did not disable joining)' "$r"

    # `main()` end to end: identity resolution plus the append, driven through
    # the real entry point rather than the helpers, with GIT_AUTHOR_EMAIL set so
    # the `git var GIT_AUTHOR_IDENT`-over-`user.email` precedence is the thing
    # under test — that precedence is the PR's other half and had no fixture.
    printf 'feat: a thing\n\nSigned-off-by: Claude <noreply@anthropic.com>\n' >"$tmp/e2e"
    mkdir -p "$tmp/repo"
    git_scratch_init "$tmp/repo"
    git -C "$tmp/repo" config user.name 'Config Name'
    git -C "$tmp/repo" config user.email 'config@example.com'
    (
        cd "$tmp/repo" || exit 1
        GIT_AUTHOR_NAME='Author Name' GIT_AUTHOR_EMAIL='author@example.com' \
            bash "$SCRIPT_PATH" "$tmp/e2e"
    ) >/dev/null 2>&1
    has_matching_signoff "$tmp/e2e" "author@example.com" && r=0 || r=1
    check 'main() signs off as GIT_AUTHOR_IDENT, which is what CI checks' "$r"

    has_matching_signoff "$tmp/e2e" "config@example.com" && r=0 || r=1
    check 'main() does NOT sign off as `user.email` when the author differs' "$([ "$r" = 1 ] && echo 0 || echo 1)"

    printf '\ndco-signoff self-test: %d checked, %d failed\n' "$checked" "$fails"
    [ "$fails" -eq 0 ]
}

if [ "${1:-}" = "--self-test" ]; then
    # Consumed here, not left in $1: `self_test` sources
    # lib/git-scratch-guard.sh, and a sourced file inherits the caller's
    # positional parameters — a leftover `--self-test` would trigger the
    # LIBRARY's own self-test as a side effect of sourcing it.
    shift || true
    self_test
    exit $?
fi

main "$@"
