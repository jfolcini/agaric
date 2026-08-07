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
#
# What #3476 added on top of that policy — the degradation stays, its
# INVISIBILITY does not:
#
#   * Every degradation now prints a block naming the audits that did not
#     run, written to the terminal when there is one. That matters because
#     prek prints `zizmor...Passed` and swallows a passing hook's output
#     entirely: before this, a degraded local run and a full one were
#     indistinguishable, so a green pre-push read as full coverage when an
#     entire audit class had been skipped.
#   * The zizmor VERSION is pinned and asserted. It used to float on both
#     sides (`cargo install zizmor --locked` locally, `zizmor` unpinned in
#     taiki-e/install-action in CI), so local and CI routinely ran different
#     binaries with different audit sets — how ten `ref-version-mismatch`
#     findings reached every open PR (#3475) from an audit that did not
#     exist in the local build. Note that `ref-version-mismatch` is an
#     OFFLINE audit (docs.zizmor.sh marks "Works offline: ✅"), so the
#     online degradation was never what hid it; the version drift was.
set -uo pipefail

# ─── version pin ───────────────────────────────────────────────────────
# The single source of truth for which zizmor this repo runs. Three places
# must agree, and the assertion below is what proves they do rather than
# assuming it:
#   1. this constant                       (what the gate asserts)
#   2. `tool: …,zizmor@<v>,…` in .github/workflows/_validate.yml and
#      .github/workflows/scheduled-deep-checks.yml   (what CI installs)
#   3. `cargo_get_pinned zizmor …` in scripts/setup-hooks.sh (what a dev box
#      installs)
# A mismatch is a hard error in CI — CI is the run whose result everyone
# trusts, and a CI binary that is not the pinned one voids the pin — and a
# loud, visible warning locally, where hard-failing a push over a tool
# version would recreate exactly the #2535 breakage this wrapper exists to
# prevent.
ZIZMOR_PINNED_VERSION="1.28.0"

# The single source of truth for how `zizmor --version`'s one-line
# `zizmor <semver>` output is turned into a bare version string. Extracted
# as `$2` (the second field) rather than `$NF` (the last field) — the two
# agree today but silently diverge the moment the output ever grows a
# trailing token. scripts/setup-hooks.sh reads this constant via `sed`, the
# same way it reads ZIZMOR_PINNED_VERSION above, instead of hard-coding its
# own awk program (#3545): before this, a divergence would leave the
# wrapper's assertion silent while `cargo_get_pinned` decided the installed
# version no longer matched and reinstalled zizmor on every run — a hook
# that quietly became expensive with no error anywhere.
ZIZMOR_VERSION_AWK='NR == 1 { print $2 }'

have() { command -v "$1" >/dev/null 2>&1; }

# `--self-test` drives this wrapper as a subprocess against stub `zizmor` and
# `curl` binaries on PATH, asserting the real exit codes and the real output.
# Defined (and dispatched) before anything else runs, because everything after
# this point either execs zizmor or exits.
if [ "${1:-}" = "--self-test" ]; then
  SELF="$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")"
  fails=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  cat > "$tmp/zizmor" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ZIZMOR_STUB_LOG"
if [ "${1:-}" = "--version" ]; then echo "zizmor ${ZIZMOR_STUB_VERSION}"; exit 0; fi
# Reproduce the "collection phase never finished" failure the wrapper's
# runtime fallback exists for — but only for the ONLINE invocation.
case " $* " in
  *" --no-online-audits "*) echo "No findings to report. Good job!"; exit 0 ;;
esac
if [ "${ZIZMOR_STUB_FATAL:-0}" = "1" ]; then
  echo "error: fatal: no audit was performed" >&2
  exit 1
fi
echo "No findings to report. Good job!"
STUB
  cat > "$tmp/curl" <<'STUB'
#!/usr/bin/env bash
exit "${ZIZMOR_STUB_CURL_RC:-0}"
STUB
  chmod +x "$tmp/zizmor" "$tmp/curl"

  # HOME is redirected at a temp dir so the wrapper's `. "$HOME/.cargo/env"`
  # is a silent no-op and cannot prepend a real zizmor ahead of the stub.
  run_stub() { # <expected-version> [env assignments...] → output + [exit N]
    local out rc
    : > "$tmp/stub.log"
    set +e
    if have setsid; then
      # No controlling terminal, so `notify`'s tty mirror cannot escape the
      # capture and duplicate itself onto the developer's screen.
      out=$(env HOME="$tmp" PATH="$tmp:$PATH" ZIZMOR_STUB_LOG="$tmp/stub.log" "$@" \
        setsid bash "$SELF" .github/workflows/ci.yml 2>&1)
    else
      out=$(env HOME="$tmp" PATH="$tmp:$PATH" ZIZMOR_STUB_LOG="$tmp/stub.log" "$@" \
        bash "$SELF" .github/workflows/ci.yml 2>&1)
    fi
    rc=$?
    set -e
    printf '%s\n[exit %s]' "$out" "$rc"
  }
  assert_out() { # <label> <needle> <output>
    if printf '%s' "$3" | grep -qF -- "$2"; then
      echo "  ✓ $1"
    else
      echo "  ✗ $1 (expected output to contain: $2)" >&2
      fails=$((fails + 1))
    fi
  }
  refute_out() { # <label> <needle> <output>
    if printf '%s' "$3" | grep -qF -- "$2"; then
      echo "  ✗ $1 (unexpected output: $2)" >&2
      fails=$((fails + 1))
    else
      echo "  ✓ $1"
    fi
  }

  # (1) A local run on a DIFFERENT version says so, and still runs.
  out=$(run_stub ZIZMOR_STUB_VERSION=0.0.0 CI=)
  assert_out "local version drift is announced" "LOCAL VERSION DRIFT" "$out"
  assert_out "local version drift names the pinned version" \
    "$ZIZMOR_PINNED_VERSION" "$out"
  assert_out "local version drift does not block the push" "[exit 0]" "$out"

  # (2) The same drift in CI is a hard error: CI running an unpinned binary is
  #     what makes a green local run unpredictive (#3475).
  out=$(run_stub ZIZMOR_STUB_VERSION=0.0.0 CI=1)
  assert_out "CI version drift fails the run" "[exit 1]" "$out"
  assert_out "CI version drift explains itself" "zizmor version drift" "$out"

  # (3) The pinned version is silent — the assertion must not cry wolf.
  out=$(run_stub "ZIZMOR_STUB_VERSION=$ZIZMOR_PINNED_VERSION" CI=1)
  refute_out "a matching version says nothing about drift" "VERSION DRIFT" "$out"
  assert_out "a matching version passes" "[exit 0]" "$out"

  # (4) #3476's core claim: a degraded local run SAYS an audit class was
  #     skipped, and says which. A silent degradation is a green run that
  #     checked less than CI will.
  out=$(run_stub "ZIZMOR_STUB_VERSION=$ZIZMOR_PINNED_VERSION" CI= ZIZMOR_STUB_CURL_RC=1)
  assert_out "an unreachable API announces the skip" "AUDITS SKIPPED" "$out"
  assert_out "the skipped audits are named" "impostor-commit" "$out"
  assert_out "the weaker-than-CI consequence is stated" "LESS than CI" "$out"
  assert_out "the degraded run really passed --no-online-audits" \
    "--no-online-audits" "$(cat "$tmp/stub.log")"

  # (5) Same for the runtime fallback: probe passes, the online audit dies
  #     with zizmor's fatal-collection signature, the retry is offline-only.
  out=$(run_stub "ZIZMOR_STUB_VERSION=$ZIZMOR_PINNED_VERSION" CI= ZIZMOR_STUB_FATAL=1)
  assert_out "a fatal online audit announces the skip" "AUDITS SKIPPED" "$out"
  assert_out "the fallback still exits 0" "[exit 0]" "$out"
  assert_out "the fallback retried offline" "--no-online-audits" "$(cat "$tmp/stub.log")"

  # (6) #3545 — scripts/setup-hooks.sh must parse `zizmor --version` the
  #     SAME way this wrapper does. It sources ZIZMOR_VERSION_AWK from this
  #     file via `sed` (mirroring how it already sources
  #     ZIZMOR_PINNED_VERSION) instead of keeping an independent awk
  #     program. Prove that on a version string with a TRAILING TOKEN — the
  #     shape that made the old `$NF` vs. `$2` split diverge — both the
  #     wrapper's own extraction and setup-hooks.sh's sourced copy of it
  #     land on the same field. If setup-hooks.sh ever regresses to its own
  #     hard-coded `$NF`, this line would extract "(deadbeef)" instead of
  #     the version and the two would disagree.
  sample_version_line="zizmor ${ZIZMOR_PINNED_VERSION} (deadbeef)"
  wrapper_field="$(printf '%s\n' "$sample_version_line" | awk "$ZIZMOR_VERSION_AWK")"
  setup_hooks="$(dirname "$SELF")/setup-hooks.sh"
  # setup-hooks.sh does not hard-code the awk program — it extracts it from
  # THIS file at runtime with the sed command below. Run that exact command
  # (copy-pasted, not re-derived) to prove the sourcing itself still works,
  # then apply the result to the same sample line the wrapper used.
  installer_awk="$(
    sed -n 's/^ZIZMOR_VERSION_AWK='"'"'\([^'"'"']*\)'"'"'.*/\1/p' \
      "$SELF" 2>/dev/null | head -n 1
  )"
  installer_field="$(printf '%s\n' "$sample_version_line" | awk "$installer_awk")"
  if [ -n "$installer_awk" ] && [ "$wrapper_field" = "$installer_field" ] \
    && [ "$wrapper_field" = "$ZIZMOR_PINNED_VERSION" ]; then
    echo "  ✓ setup-hooks.sh's sourced field extraction agrees with the wrapper's own on a trailing-token version string"
  else
    echo "  ✗ the two extractions disagree on a trailing-token version string (wrapper: '$wrapper_field', installer: '$installer_field', installer_awk: '$installer_awk')" >&2
    fails=$((fails + 1))
  fi
  # And the wiring in setup-hooks.sh must actually PASS that sourced value
  # into cargo_get_pinned's zizmor call — sourcing it into an unused
  # variable would satisfy the check above while still leaving the old
  # default in effect.
  if grep -qF 'cargo_get_pinned zizmor "$ZIZMOR_PINNED_VERSION" zizmor "$ZIZMOR_VERSION_AWK"' "$setup_hooks"; then
    echo "  ✓ setup-hooks.sh's cargo_get_pinned call passes the sourced ZIZMOR_VERSION_AWK through"
  else
    echo "  ✗ setup-hooks.sh's cargo_get_pinned call no longer passes ZIZMOR_VERSION_AWK (wiring regressed)" >&2
    fails=$((fails + 1))
  fi

  if [ "$fails" -gt 0 ]; then
    echo "self-test: $fails assertion(s) failed" >&2
    exit 1
  fi
  echo "self-test: all assertions passed"
  exit 0
fi

. "$HOME/.cargo/env" 2>/dev/null || true

# Announce something the developer must see even on a PASSING hook run.
# prek captures a passing hook's stdout/stderr and prints only `Passed`, so
# stderr alone is not visibility: the message goes to stderr (where a direct
# invocation and the self-test can read it) and, when stderr is NOT a
# terminal, is mirrored to the controlling terminal so it survives capture.
notify() {
  printf '%s\n' "$@" >&2
  if [ ! -t 2 ] && { : >/dev/tty; } 2>/dev/null; then
    printf '%s\n' "$@" >/dev/tty
  fi
}

# The audits that cannot run without GitHub API access, per
# docs.zizmor.sh/audits ("Works offline: ❌"). Named explicitly so a degraded
# run says WHAT went unchecked instead of "some online audits".
ONLINE_ONLY_AUDITS='impostor-commit, known-vulnerable-actions, ref-confusion, stale-action-refs (and typosquat-uses drops to low confidence)'

# ─── version assertion ────────────────────────────────────────────────
installed_version() {
  # `zizmor --version` prints `zizmor <semver>`.
  zizmor --version 2>/dev/null | awk "$ZIZMOR_VERSION_AWK"
}

if have zizmor; then
  actual="$(installed_version)"
  if [ "$actual" != "$ZIZMOR_PINNED_VERSION" ]; then
    if [ -n "${CI:-}" ]; then
      echo "ERROR: zizmor version drift — CI has '${actual:-unknown}', the repo pins ${ZIZMOR_PINNED_VERSION}." >&2
      echo "A CI binary that is not the pinned one makes the local gate's guarantee meaningless:" >&2
      echo "audits appear and disappear between versions (#3475). Update the \`tool: …,zizmor@<v>\`" >&2
      echo "pins in .github/workflows/ and ZIZMOR_PINNED_VERSION in scripts/zizmor-hook.sh together." >&2
      exit 1
    fi
    notify \
      "zizmor: LOCAL VERSION DRIFT — you have ${actual:-unknown}, CI runs ${ZIZMOR_PINNED_VERSION}." \
      "  Audits differ between versions, so a green local run does NOT predict a green CI." \
      "  Fix: cargo install --locked zizmor@${ZIZMOR_PINNED_VERSION}"
  fi
fi

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
  notify \
    "zizmor: AUDITS SKIPPED — running with --no-online-audits." \
    "  Reason: $1." \
    "  Not checked locally: ${ONLINE_ONLY_AUDITS}." \
    "  These still run in CI, so this push is gated by LESS than CI will apply."
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
