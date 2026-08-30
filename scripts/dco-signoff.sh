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
    local file="$1" email="$2"
    [ -n "$email" ] || return 1
    grep -iE '^[[:space:]]*signed-off-by:[[:space:]]' "$file" 2>/dev/null \
        | grep -qiF "<${email}>"
}

append_signoff() {
    local file="$1" name="$2" email="$3" last
    # Append a trailing newline if the message doesn't already end with one.
    # `git interpret-trailers` would also work but pulls in extra
    # normalisation we don't want for human-edited messages.
    if [ -s "$file" ] && [ "$(tail -c1 "$file" | wc -l)" -eq 0 ]; then
        printf '\n' >>"$file"
    fi
    # Join the existing trailer block rather than starting a second one.
    # A blank line between trailers splits them into two blocks, and git's
    # own trailer parsing (`git interpret-trailers --parse`, and anything
    # built on it) then reads only the LAST block — so a message ending in
    # `Signed-off-by: <agent>` would get the author trailer in a block of
    # its own and the agent's would stop being visible as a trailer at all.
    # CI's `dco.yml` greps the raw message and does not care, but the commit
    # this produces is the permanent record, and it should be well-formed.
    last="$(grep -v '^[[:space:]]*$' "$file" | tail -n1 || true)"
    if ! printf '%s' "$last" | grep -qE '^[A-Za-z][A-Za-z-]*:[[:space:]]'; then
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
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' RETURN

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

    printf '\ndco-signoff self-test: %d checked, %d failed\n' "$checked" "$fails"
    [ "$fails" -eq 0 ]
}

if [ "${1:-}" = "--self-test" ]; then
    self_test
    exit $?
fi

main "$@"
