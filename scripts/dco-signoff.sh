#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# prepare-commit-msg hook: auto-append a `Signed-off-by` trailer when
# missing, so the DCO check on CI (`.github/workflows/dco.yml`) never
# rejects a PR for a forgotten `git commit -s`. Mirrors what `git commit
# -s` would emit; idempotent — does nothing when the trailer is already
# present (for merge / amend / message-template commits).
#
# Invoked by prek's `prepare-commit-msg` stage. Git passes the commit
# message file as $1; $2/$3 are the commit source and SHA (unused).
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

msg_file="${1:?prepare-commit-msg: missing message file argument}"

# Skip if the message already carries any Signed-off-by trailer (matches
# the CI regex, case-insensitive). Avoids stacking duplicates on amend
# and respects a pre-existing sign-off in a templated message.
if grep -qiE '^[[:space:]]*signed-off-by:[[:space:]]' "$msg_file"; then
    exit 0
fi

name="$(git config --get user.name || true)"
email="$(git config --get user.email || true)"
if [ -z "$name" ] || [ -z "$email" ]; then
    # No identity configured — let git's own validation surface the error
    # instead of crashing the hook.
    exit 0
fi

# Append a trailing newline if the message doesn't already end with one,
# then the sign-off trailer. `git interpret-trailers` would also work but
# pulls in extra normalisation we don't want for human-edited messages.
if [ -s "$msg_file" ] && [ "$(tail -c1 "$msg_file" | wc -l)" -eq 0 ]; then
    printf '\n' >> "$msg_file"
fi
printf '\nSigned-off-by: %s <%s>\n' "$name" "$email" >> "$msg_file"
