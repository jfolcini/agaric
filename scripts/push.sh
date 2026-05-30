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
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"

echo "▶ Verifying (CI-equivalent) BEFORE opening any push connection…"
bash "$ROOT/scripts/verify-ci-equivalent.sh"

echo "✓ Verification passed — pushing now (pre-push verify skipped: already green)…"

# Reason string handed to the pre-push verifier so it short-circuits
# (the verifier already ran, above). Must be a descriptive reason, not a
# truthy flag — the guard rejects `SKIP_CI_VERIFY=1`.
SKIP_REASON="push.sh: verifier already ran before opening the connection"

# Forward explicit push args verbatim if the caller passed any.
if [ "$#" -gt 0 ]; then
  exec env SKIP_CI_VERIFY="$SKIP_REASON" git push "$@"
fi

# No args: push the current branch to origin. Set the upstream on first
# push (a brand-new branch has no tracking ref), otherwise a bare
# `git push` aborts with "no upstream branch".
branch="$(git rev-parse --abbrev-ref HEAD)"
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  exec env SKIP_CI_VERIFY="$SKIP_REASON" git push
fi
exec env SKIP_CI_VERIFY="$SKIP_REASON" git push --set-upstream origin "$branch"
