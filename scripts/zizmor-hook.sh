#!/usr/bin/env bash
# Wrapper around the `zizmor` binary for the prek hook (prek.toml `[[repos]]
# id = "zizmor"`). Not called directly by scripts/setup-hooks.sh, but is the
# fallback prek points at once setup-hooks.sh has provisioned `zizmor` onto
# PATH — keep the two in sync (issue #2535).
#
# Why this wrapper exists: zizmor's online audits (e.g. `artipacked`) call
# the GitHub API. In CI that works — a real `GITHUB_TOKEN` is set. Locally,
# and especially inside a network-scoped remote-container session, the
# session-scoped token 401s against api.github.com ("no audit was
# performed"), which then hard-fails every `git push` for a reason that has
# nothing to do with the diff being pushed.
#
# Degradation policy:
#   * CI (`CI` env set, as every GitHub Actions runner does): ALWAYS run the
#     full online audit. CI must never silently skip a check.
#   * Local: probe api.github.com first as a fast bail-out when the box is
#     obviously offline/unauthorized. If that probe passes, still attempt
#     the real online run — the probe is NOT a reliable predictor of
#     success. Verified live (issue #2535): `artipacked` resolves action
#     refs against github.com's git smart-HTTP endpoint (`git-upload-pack`),
#     a different host/protocol/auth-check than `api.github.com/rate_limit`,
#     and a token the REST probe accepts can still 401 there — crashing
#     zizmor outright (exit 1, zero stdout, "fatal: no audit was
#     performed" on stderr) rather than reporting findings. So the real
#     online run is also guarded: if it dies with that same top-level fatal
#     signature (zizmor's generic "the collection/audit phase never
#     finished" error — see zizmor's main.rs error handler), retry with
#     `--no-online-audits`. A genuinely broken workflow/config fails the
#     same way on the retry (nothing is masked); this only rescues the
#     network/auth case. Local pushes stay usable; CI still catches
#     anything an offline-only local run would miss.
set -uo pipefail

have() { command -v "$1" >/dev/null 2>&1; }

. "$HOME/.cargo/env" 2>/dev/null || true

# CI always runs the real, online audit — never degrade there.
if [ -n "${CI:-}" ]; then
  exec zizmor "$@"
fi

# No curl on this box: can't probe, so just attempt the normal (online) run
# rather than silently degrading on a guess.
if ! have curl; then
  exec zizmor "$@"
fi

# Quick reachability + auth probe against the same API zizmor's online
# audits use. --max-time keeps this from hanging the commit/push if the
# proxy blackholes the request instead of returning a fast 401/403.
# GitHub validates a bad/scoped Authorization header even on the
# unauthenticated-friendly `rate_limit` endpoint, so sending the same token
# zizmor would use (GH_TOKEN / GITHUB_TOKEN / ZIZMOR_GITHUB_TOKEN, in that
# precedence — see `zizmor --help`) makes this a useful FAST bail-out for
# the "obviously offline/unauthorized" case. It is NOT sufficient on its own
# — see the runtime fallback below — because it only proves api.github.com
# accepts the token, not that every host/endpoint zizmor's online audits
# touch does too.
probe_github_api() {
  local token="${GH_TOKEN:-${GITHUB_TOKEN:-${ZIZMOR_GITHUB_TOKEN:-}}}"
  if [ -n "$token" ]; then
    curl -fsS --max-time 3 -H "Authorization: Bearer $token" https://api.github.com/rate_limit >/dev/null 2>&1
  else
    curl -fsS --max-time 3 https://api.github.com/rate_limit >/dev/null 2>&1
  fi
}

degrade_note() {
  echo "zizmor: $1 — degrading to offline audits only (--no-online-audits). Online-only rules (e.g. artipacked) still run in CI." >&2
}

if ! probe_github_api; then
  degrade_note "api.github.com unreachable or unauthorized (proxy/session-scoped token)"
  exec zizmor --no-online-audits "$@"
fi

# The probe passed — attempt the real online run. Capture stderr (to a file,
# not a `>(process substitution)`, to avoid the classic race where the
# parent reads the capture before the async subshell has finished writing
# it) so it can be inspected for zizmor's fatal-collection signature before
# deciding whether to retry. stdout is left to stream directly: on the fatal
# path zizmor emits no stdout at all (verified — the whole run is atomic),
# so a retry never duplicates output.
tmp_err="$(mktemp 2>/dev/null || true)"
if [ -z "$tmp_err" ] || [ ! -f "$tmp_err" ]; then
  # Couldn't get a scratch file to capture stderr into — fall back to the
  # plain online run. Still covered by the probe above; just without the
  # extra runtime fallback.
  exec zizmor "$@"
fi

zizmor "$@" 2>"$tmp_err"
status=$?
cat "$tmp_err" >&2

if [ "$status" -ne 0 ] && grep -q "no audit was performed" "$tmp_err"; then
  rm -f "$tmp_err"
  degrade_note "online audit collection failed against github.com even though the api.github.com probe passed (see stderr above)"
  exec zizmor --no-online-audits "$@"
fi

rm -f "$tmp_err"
exit "$status"
