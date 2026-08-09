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
  # Refuse to continue on an empty $tmp rather than building on it. EVERY path
  # below is `$tmp/…`, so an empty value silently retargets all of them at the
  # filesystem ROOT: the stub binaries become `/zizmor` and `/curl`, the sandbox
  # becomes `/sandbox` with ~70 shims written into it, the EXIT trap degrades to
  # `rm -rf ""` so none of it is cleaned up, and run_stub's `PATH="$tmp:$PATH"`
  # acquires a LEADING EMPTY ELEMENT — which bash resolves as the current
  # directory, putting cwd ahead of the stubs on PATH. Observed for real during
  # #3559's review (a shadowed `mktemp` on PATH was enough to trigger it), and
  # the new sandbox turns what used to be a two-file spill into a ~70-file one.
  if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then
    echo "self-test: mktemp -d produced no usable directory — refusing to run" >&2
    exit 1
  fi
  trap 'rm -rf "$tmp"' EXIT

  setup_hooks="$(dirname "$SELF")/setup-hooks.sh"

  # `have()` in the sandbox prelude below (used by block (6)'s sandbox_bash
  # payloads) must be setup-hooks.sh's REAL, CURRENT `have()` — sourced via
  # `sed`, the same direction-reversed shape as ZIZMOR_PINNED_VERSION and
  # ZIZMOR_VERSION_AWK are sourced below (#3554), not retyped here. A retyped
  # copy agrees with setup-hooks.sh today and silently reverts to a fixed
  # string that only RESEMBLES the real definition the moment setup-hooks.sh's
  # `have()` changes and this one does not — the exact accident this sandbox
  # exists to prevent, one level up (#3578). Sourcing means there is only ever
  # one `have()` to change.
  #
  # Fail closed, same as the other extractors in this file: an empty result
  # (renamed function, moved file, reshaped onto multiple lines) must not
  # silently hand block (6) a sandbox with no `have()` at all — that degrades
  # every `have` call inside the payload to plain "command not found" (127),
  # which is a THIRD, uninspected behaviour, not the real one. Exit here,
  # before anything downstream can mistake silence for coverage.
  setup_hooks_have="$(
    sed -n '/^have() { .*; }$/p' "$setup_hooks" 2>/dev/null | head -n 1
  )"
  if [ -z "$setup_hooks_have" ]; then
    echo "self-test: could not source have() from setup-hooks.sh (looked for a line matching '^have() { .*; }\$' in $setup_hooks) — refusing to build the sandbox prelude on a guess (#3578)" >&2
    exit 1
  fi

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

  # ─── sandbox for block (6)'s `bash -c` payloads ──────────────────────
  # Block (6) proves setup-hooks.sh and this wrapper agree by EXECUTING
  # setup-hooks.sh's own statements — text selected by a line window. Those
  # windows fail closed (see the extractors below), which bounds WHAT gets
  # executed; this bounds what executing the wrong thing can DO.
  #
  # It has been wrong before: during #3554's review an unbounded extractor
  # really did hand ~190 lines of setup-hooks.sh's top-level PROVISIONER to
  # `bash -c`. It stopped short of `cargo install` / `sudo apt-get` / `curl`
  # only because `have()` happens to be defined ABOVE the extraction window, so
  # the payload carried no `have` and every installer's guard exited non-zero.
  # That is safety by accident of layout, not by construction — move `have()`
  # up in setup-hooks.sh and it changes (#3559).
  #
  # So both payloads run with PATH pointing at THIS directory and nothing else:
  #   * the text tools the real statements legitimately need (sed, head,
  #     dirname, …) are symlinked in, so a benign refactor of the sourcing
  #     statement does not spuriously redden;
  #   * every tool that could mutate the box is a shim that prints
  #     SANDBOX-VIOLATION on stderr and exits 97;
  #   * anything else is simply not on PATH.
  #
  # KNOWN BOUNDARY — this constrains BARE-NAME COMMAND LOOKUP, and only that.
  # Stating it precisely because a sandbox that reads as broader than it is is
  # worse than none. Four things it does NOT stop, all verified during #3559's
  # review:
  #   1. An ABSOLUTE path (`/usr/bin/sudo`, `awk 'BEGIN{system("/usr/bin/…")}'`).
  #      setup-hooks.sh invokes every one of these by bare name today, so the
  #      shims make a regression to an absolute path loud rather than silent.
  #   2. The symlinked tools' own WRITE modes. They are not "read-only" tools,
  #      they are tools the extracted statements happen to use read-only:
  #      `sed -i`, `awk 'BEGIN{print > "f"}'`, `sort -o` and `uniq out` all
  #      write. setup-hooks.sh uses none of those forms; if it ever does, the
  #      allowlist is the thing to revisit.
  #   3. Shell BUILTINS. `>` creates files, `cd` moves, `.` sources. Hence the
  #      `cd "$HOME"` in sandbox_bash below: without it the payload inherits
  #      this process's cwd — the developer's checkout — and a stray `> f` in a
  #      mis-extraction lands in the working tree. With it, relative writes are
  #      confined to the temp HOME and only absolute ones (case 1) escape.
  #   4. A payload that re-mutates PATH. `export PATH="…:$PATH"` restores
  #      everything on the next command. This is not hypothetical: it is
  #      setup-hooks.sh's own `export PATH="$HOME/.cargo/bin:…"` line (grep for
  #      it rather than trusting a line number — this cited "line 51" until the
  #      number rotted), and a runaway window CAN cover it. It is inert only
  #      because HOME is pinned at an empty temp tree, so the
  #      `$HOME/.cargo/bin` / `$HOME/.local/bin` it prepends do not exist. That
  #      makes the HOME pin load-bearing for PATH INTEGRITY, not just for
  #      environment privacy — do not "simplify" it away. A future
  #      setup-hooks.sh that prepends a non-$HOME directory would defeat this,
  #      which is what block (9) below now executes and asserts rather than
  #      leaving to this comment (#3578 item 2, #3635).
  #
  # Within that boundary the guarantee holds, and block (8) below is what
  # tests it rather than asserting it here: a deliberately runaway extraction
  # that hands setup-hooks.sh's whole provisioner to the payload is seen being
  # intercepted 28 times — including 10x `cargo install --locked`, `sudo
  # apt-get install`, `prek install-hooks` and a `curl` to github.com, every
  # one of which the same payload under a plain `bash -c` runs for real
  # (#3559) — and leaves nothing behind in the sandbox HOME.
  sandbox="$tmp/sandbox"
  sandbox_home="$tmp/sandbox-home"
  # Where the poisoned shims record every interception. sandbox_bash truncates
  # it per call, so it always holds exactly the LAST payload's violations and
  # never an accumulation across blocks (#3635).
  sandbox_violations="$tmp/sandbox-violations.log"
  mkdir -p "$sandbox" "$sandbox_home"
  # `$BASH` is this interpreter's own absolute path. The payload's interpreter
  # must NOT be resolved through the stub PATH — `bash` is poisoned on it.
  sandbox_bash_bin="${BASH:-$(command -v bash)}"
  for sbx_tool in sed awk gawk mawk grep egrep fgrep head tail cut tr sort \
                  uniq wc cat dirname basename readlink realpath expr uname \
                  true false; do
    sbx_path="$(command -v "$sbx_tool" 2>/dev/null)" || continue
    # `command -v` returns the BARE NAME for a shell builtin, not a path --
    # `command -v true` is `true`, not `/usr/bin/true`. Linking that would make
    # `$sandbox/true` point at itself and every use ELOOP ("Too many levels of
    # symbolic links"). Harmless today only because bash resolves `true`/`false`
    # as builtins and never consults PATH for them, so the broken link is never
    # followed -- i.e. the allowlist quietly did not do what it says for those
    # two. Require an absolute path; builtins remain available to the payload
    # regardless, because they are builtins. (#3580 review)
    case "$sbx_path" in
      /*) ln -sf "$sbx_path" "$sandbox/$sbx_tool" ;;
      *)  : ;;   # builtin or relative -- not something we can or need to link
    esac
  done
  for sbx_tool in cargo cargo-binstall cargo-sqlx rustup sudo doas su apt \
                  apt-get dnf yum pacman apk brew port curl wget git ssh scp \
                  npm npx pnpm yarn pip pip3 python python3 go prek install \
                  tar unzip gunzip chmod chown mkdir mktemp rm rmdir mv cp ln \
                  touch dd tee sh bash zsh env xargs eval systemctl; do
    # `rm -f` first, and this loop runs LAST, so a name that ever appears in
    # BOTH lists ends up poisoned rather than allowed. Without it `cat >` would
    # follow the symlink left by the loop above and truncate the real system
    # binary — the two lists are disjoint today, and this keeps a future edit
    # from making that a discovery.
    rm -f "$sandbox/$sbx_tool"
    cat > "$sandbox/$sbx_tool" <<'POISON'
#!/bin/sh
# Poisoned shim — see scripts/zizmor-hook.sh's self-test sandbox (#3559).
sbx_msg="$(printf 'SANDBOX-VIOLATION: self-test payload tried to run `%s %s`' \
  "${0##*/}" "$*")"
printf '%s\n' "$sbx_msg" >&2
# …and append the same line to the sandbox's own log, which the payload cannot
# redirect away (#3635). The captured stderr is NOT a record of what was
# blocked: setup-hooks.sh runs nearly every installer as `cmd >/dev/null 2>&1`,
# so the interceptions that matter most — `cargo install --locked`, `sudo
# apt-get install`, `prek install-hooks` — are swallowed by the PAYLOAD's own
# redirections and never reach the harness. Measured on block (8)'s canary: 4
# of 28 violations visible on stderr, and none of those 4 an installer. A
# canary counting the visible 4 would report the sandbox proven while saying
# nothing about the ten `cargo install`s it exists to stop.
if [ -n "${SANDBOX_VIOLATION_LOG:-}" ]; then
  printf '%s\n' "$sbx_msg" >> "$SANDBOX_VIOLATION_LOG" 2>/dev/null || true
fi
exit 97
POISON
    chmod +x "$sandbox/$sbx_tool"
  done

  # `mktemp` is shimmed like the rest — running it IS a violation and is
  # recorded as one — but unlike the rest it must still SUCCEED. A shim's job
  # is to block the side effect while leaving the payload's control flow
  # intact. A shim that also fails truncates the run, and the canary then
  # covers a shorter provisioner than the one it claims to.
  #
  # Not hypothetical: #3622 added a guard at both download sites, because a
  # failed `mktemp -d` yields an empty STRING (neither `set -u` nor an absent
  # `set -e` stops it) and the old code curled into `-o /cb.tgz`. With a plain
  # `exit 97` shim that guard now fires every time, the payload skips both
  # downloads, and `curl` — the interception proving the network is closed —
  # is never reached. Measured: 25 violations and no `curl` line, against 28
  # with the downloads live. The count floor still passed while the fetch
  # silently stopped being covered, which is #3635's failure mode arriving
  # from the other direction. So the fix belongs in the shim, not in the
  # assertion.
  rm -f "$sandbox/mktemp"
  cat > "$sandbox/mktemp" <<'MKTEMP_SHIM'
#!/bin/sh
# Poisoned-but-succeeding shim — see scripts/zizmor-hook.sh's self-test sandbox.
sbx_msg="$(printf 'SANDBOX-VIOLATION: self-test payload tried to run `%s %s`' \
  "${0##*/}" "$*")"
printf '%s\n' "$sbx_msg" >&2
if [ -n "${SANDBOX_VIOLATION_LOG:-}" ]; then
  printf '%s\n' "$sbx_msg" >> "$SANDBOX_VIOLATION_LOG" 2>/dev/null || true
fi
# Absolute paths below: `mkdir` is itself poisoned on the sandbox PATH. The
# scratch lives under the sandbox root, so nothing the payload writes escapes
# it, and the provisioner proceeds to the download it would really attempt —
# straight into `curl`'s shim.
sbx_out="${SANDBOX_MKTEMP_ROOT:?sandbox mktemp root not set}/mktemp.$$.${RANDOM:-0}"
case "$*" in
  *-d*) /bin/mkdir -p "$sbx_out" 2>/dev/null || exit 1 ;;
  *)    : > "$sbx_out" 2>/dev/null || exit 1 ;;
esac
printf '%s\n' "$sbx_out"
exit 0
MKTEMP_SHIM
  chmod +x "$sandbox/mktemp"

  # setup-hooks.sh defines warn/ok/note/have at its top — ABOVE both extraction
  # windows — so neither payload ever carries them. Provide all four, not just
  # `warn` (#3559): with only `warn` defined, anything future work adds inside
  # either block runs unstubbed, and `have` in particular then degrades to
  # "command not found" (127 → false) purely by accident.
  #
  # `have` is setup-hooks.sh's REAL definition — sourced above into
  # $setup_hooks_have, not retyped here — not a stub returning a fixed
  # answer. A fixed answer would just relocate the accident: `return 1` makes
  # a swallowed provisioner skip every installer (it looks safe, but only
  # because of how setup-hooks.sh happens to nest its `have` guards today),
  # while `return 0` drives it elsewhere. With the real definition the payload
  # behaves the same whether or not the extraction window happens to include
  # `have`, and under the stub PATH "installed" means "is a poisoned shim" — so
  # an installer that believes a tool is present runs straight into a
  # SANDBOX-VIOLATION instead of into `cargo install`.
  sandbox_prelude='set -u
warn() { printf "%s\n" "$*"; }
ok()   { :; }
note() { :; }
'"$setup_hooks_have"

  # sandbox_bash <payload> <argv0> — run <payload> under the stub PATH, with
  # `$0` bound to <argv0> so setup-hooks.sh's `$(dirname "$0")` resolves the
  # way it does in a real run. `env -i` also drops CI/GH_TOKEN/locale, so a
  # payload cannot read this session's environment.
  #
  # `cd "$HOME"` (the temp tree) first: `env -i` does not change cwd, so
  # without it the payload runs in the developer's checkout and a shell
  # redirection — which no PATH can intercept — writes there. Both payloads
  # take <argv0> as an ABSOLUTE path, so nothing they do depends on cwd;
  # verified by running the whole self-test from an unrelated directory.
  #
  # ZIZMOR_VERSION_AWK is seeded EMPTY here, via the environment, rather than
  # by an assignment line inside the guard payload. A column-0
  # `ZIZMOR_VERSION_AWK=` in THIS file is the exact literal setup-hooks.sh's
  # sourcing `sed` and the extractors below key on; one living inside a payload
  # string is a trap for any future extraction that runs over the wrapper
  # instead of the installer (#3559). Line 79's real constant is now the only
  # column-0 occurrence in this file, which is what every one of those patterns
  # intends to find.
  #
  # SANDBOX_VIOLATION_LOG is the one other variable `env -i` lets through, and
  # it carries only the path of a file inside this run's own $tmp — nothing
  # about the session. The shims append to it because stderr is not a reliable
  # record of what they blocked (see the shim body above). Truncated on every
  # call so a block reading it after a `sandbox_bash` sees that payload's
  # violations and not the previous one's (#3635).
  # SANDBOX_MKTEMP_ROOT is passed for the same reason and with the same
  # exposure: a path inside this run's own $tmp. It is where the succeeding
  # `mktemp` shim puts its scratch, so the provisioner's download paths stay
  # reachable without anything landing outside the sandbox.
  # Deliberately a SIBLING of $sandbox_home, not a child: block (8) asserts the
  # payload created nothing under the pinned HOME, and scratch the harness
  # hands out is not the payload escaping — but putting it inside HOME would
  # make that assertion unable to tell the two apart.
  sandbox_mktemp_root="$tmp/sandbox-mktemp"
  mkdir -p "$sandbox_mktemp_root"
  sandbox_bash() { # <payload> <argv0>
    : > "$sandbox_violations"
    env -i "PATH=$sandbox" "HOME=$sandbox_home" ZIZMOR_VERSION_AWK= \
      "SANDBOX_VIOLATION_LOG=$sandbox_violations" \
      "SANDBOX_MKTEMP_ROOT=$sandbox_mktemp_root" \
      "$sandbox_bash_bin" -c "cd \"\$HOME\" || exit 98
$sandbox_prelude
$1" "$2"
  }

  # Captured program output is spliced into the ✗ diagnostics below. The
  # fail-closed line budget bounds its LENGTH; nothing bounds its bytes. A
  # stray ESC in there repaints, clears or colours the rest of the terminal, so
  # a failing assertion becomes an unreadable one — the same "the harness
  # reports wrong" failure as everything else in this cluster (#3559). Newline/
  # tab/CR become spaces (the diagnostics are single-line); the remaining C0
  # controls and DEL are deleted. C1 (0x80–0x9F) is deliberately left alone: on
  # a UTF-8 terminal those bytes are continuation bytes, and deleting them
  # would mangle the very characters this file prints (✓ / ✗).
  #
  # The length cap serves the same end. The fail-closed budget bounds captured
  # output to ~20 lines on the paths that are still guarded, but the whole
  # point of a diagnostic is to survive the case where a guard did NOT hold:
  # verified here, a deliberately unbounded extraction produced a single ✗ line
  # of ~3 KB that buried its own SANDBOX-VIOLATION lines. Truncation only ever
  # touches the message — every assertion above tests the UNsanitized value.
  #
  # It reports the ORIGINAL length rather than truncating silently. The cap is
  # applied per FIELD, and the field carrying the substance (the payload's
  # stderr, i.e. the SANDBOX-VIOLATION lines) measured 391 bytes against a 400
  # cap in the review's own canary — one more violation and the decisive line
  # would have been cut with nothing to say so. A reader who can see "1902
  # bytes total" knows to re-run for the rest; silent truncation is the same
  # "the harness reports wrong" failure as everything else here (#3559).
  #
  # `local LC_ALL=C` pins BYTE semantics for `${#s}` / `${s:0:400}` (hence
  # "bytes" in the notice). Without it the cap silently means characters under
  # LANG=…UTF-8 and bytes under the unset-LANG default that CI runs with — and
  # in the byte case the cut lands mid-UTF-8-sequence and emits a dangling lead
  # byte, mangling the very ✓/✗ this function leaves C1 alone to protect
  # (verified: `✓`×300 cut at byte 400 yielded `… e2` + space). The loop then
  # drops any trailing continuation bytes and the expansion after it drops a
  # trailing lead byte, so a partial sequence never survives; that costs at
  # most one whole character at a cut which is already lossy, and the
  # diagnostic is always valid UTF-8.
  sanitize() {
    local s raw orig LC_ALL=C
    # Measure the ORIGINAL length, before control characters are stripped. The
    # truncation notice exists so a cut can never hide substance silently, so it
    # must report what was actually there: measuring post-`tr -d` under-reports
    # by exactly the bytes most likely to have made the value long in the first
    # place (a control-character-heavy payload). (#3580 review)
    orig="$*"
    raw=${#orig}
    s="$(printf '%s' "$orig" | tr '\n\t\r' '   ' | tr -d '\000-\037\177')"
    if [ "${#s}" -gt 400 ]; then
      s="${s:0:400}"
      while [ -n "$s" ]; do
        case "$s" in *[$'\200'-$'\277']) s="${s%?}" ;; *) break ;; esac
      done
      s="${s%[$'\300'-$'\377']}"
      s="$s …[truncated, ${raw} bytes total]"
    fi
    printf '%s' "$s"
  }

  # HOME is redirected at a temp dir so the wrapper's `. "$HOME/.cargo/env"`
  # is a silent no-op and cannot prepend a real zizmor ahead of the stub.
  run_stub() { # <expected-version> [env assignments...] → output + [exit N]
    local out rc errexit_was_on=0
    : > "$tmp/stub.log"
    # Save and restore the ACTUAL prior state. This used to be a bare
    # `set +e` … `set -e` pair, but this script sets `set -uo pipefail` (line
    # 51) and never `-e` — so the restoring `set -e` ENABLED errexit rather
    # than restoring it. Harmless only by luck: all five call sites are
    # `out=$(run_stub …)` command substitutions, so the change died with the
    # subshell. One non-substitution call site away from silently turning
    # errexit on for the rest of the self-test (#3559).
    case "$-" in *e*) errexit_was_on=1 ;; esac
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
    if [ "$errexit_was_on" = 1 ]; then set -e; fi
    printf '%s\n[exit %s]' "$out" "$rc"
  }
  # Substring tests are done with `case`, NOT `printf … | grep -qF`. This file
  # runs under `set -o pipefail` (line 51), and `grep -q` exits 0 the instant
  # it matches — closing the pipe while `printf` may still have bytes to
  # write. `printf` then takes SIGPIPE and exits 141, and pipefail reports the
  # PIPELINE as 141 even though grep matched, so the `if` takes the else
  # branch: a phantom ✗ plus a phantom `fails` increment, on an assertion
  # whose own error message contradicts the output it just printed.
  # Measured: a 200 KB haystack reproduces it 300/300 with pipefail and 0/300
  # without; at the self-test's haystack sizes it is a scheduling race that
  # fired once in ~1700 runs here. That is the "self-test that reports wrong"
  # failure mode — it can over-count as easily as it could under-count.
  # `case "$hay" in *"$needle"*)` is the same fixed-string semantics as
  # `grep -F` (quoting $needle makes glob metacharacters literal, which is why
  # needles like `[exit 0]` still match), with no subprocess and no pipe.
  assert_out() { # <label> <needle> <output>
    case "$3" in
      *"$2"*) echo "  ✓ $1" ;;
      *) echo "  ✗ $1 (expected output to contain: $2)" >&2
         fails=$((fails + 1)) ;;
    esac
  }
  refute_out() { # <label> <needle> <output>
    case "$3" in
      *"$2"*) echo "  ✗ $1 (unexpected output: $2)" >&2
              fails=$((fails + 1)) ;;
      *) echo "  ✓ $1" ;;
    esac
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
  #     land on the same field.
  sample_version_line="zizmor ${ZIZMOR_PINNED_VERSION} (deadbeef)"
  wrapper_field="$(printf '%s\n' "$sample_version_line" | awk "$ZIZMOR_VERSION_AWK")"
  # $setup_hooks was already resolved above, before the sandbox prelude was
  # built (#3578) — not re-derived here.
  # The value under test has to come from setup-hooks.sh's OWN code, not from
  # a copy of its sed pasted here. A pasted copy re-derives the answer from
  # THIS file and so passes no matter what setup-hooks.sh contains: the
  # original form of this check ran its sed against "$SELF", so breaking
  # setup-hooks.sh's sed outright still went green while `cargo_get_pinned`
  # silently fell back to `$NF`. Instead, lift setup-hooks.sh's verbatim
  # `ZIZMOR_VERSION_AWK=$( … )` statement out of the file and EXECUTE it,
  # with `$0` bound to setup-hooks.sh so its `$(dirname "$0")` resolves the
  # same way it does in a real run. Any regression there — a broken sed, a
  # renamed constant, a hard-coded `$NF` written back in place of the
  # sourcing — now reddens this assertion.
  # The extractor must FAIL CLOSED. It buffers instead of streaming and emits
  # nothing unless it actually saw the statement's terminator within a small
  # line budget, because both failure directions of an unbounded "print until
  # the closing line" loop are worse than an empty result:
  #   * it swallows the rest of setup-hooks.sh and hands ~190 lines of the
  #     PROVISIONER to the payload below — top-level code that echoes, and that
  #     would call `cargo install` / `sudo apt-get install` / `curl` the
  #     moment the swallowed range happens to contain a definition of `have`.
  #     (That is now caught a second time by the poisoned-PATH sandbox above,
  #     which turns such a run into a loud SANDBOX-VIOLATION and a red
  #     assertion. The budget is still the FIRST line of defence: the sandbox
  #     bounds the blast radius, it does not make a wrong window correct.);
  #   * and the sibling guard check then still finds its needle in that
  #     runaway output and goes GREEN — a guard that passes on a cosmetic
  #     refactor, which is the exact bug #3545 is about.
  # Verified: with the streaming form, adding a trailing comment to the
  # guard's `fi` made the extraction grab 98 lines and the self-test still
  # printed "all assertions passed". The terminator match is a prefix (`^)`),
  # not `^)"`, so the equally-valid unquoted `VAR=$( … )` spelling is accepted
  # rather than spuriously reddened; anything the budget does not close comes
  # back empty and reddens the assertion below.
  installer_stmt="$(
    awk '
      /^(export[ \t]+)?ZIZMOR_VERSION_AWK=/ && !grab {
        grab = 1; buf = $0
        # Single-line form: the statement is this line and nothing else.
        if ($0 !~ /\$\($/) { print buf; exit }
        next
      }
      grab {
        buf = buf "\n" $0
        if ($0 ~ /^\)/) { print buf; exit }
        if (++n >= 20)  { exit }   # runaway — print NOTHING, fail loud
      }
    ' "$setup_hooks" 2>/dev/null
  )"
  # Executed through sandbox_bash (stub PATH + poisoned shims), never a bare
  # `bash -c` — see the sandbox block above. stderr is captured to a file
  # rather than discarded so a SANDBOX-VIOLATION shows up in the ✗ below
  # instead of vanishing behind an empty value.
  installer_awk="$(
    sandbox_bash "$installer_stmt"'
printf %s "${ZIZMOR_VERSION_AWK:-}"' "$setup_hooks" 2>"$tmp/installer.err"
  )"
  installer_err="$(cat "$tmp/installer.err" 2>/dev/null)"
  installer_field="$(printf '%s\n' "$sample_version_line" | awk "$installer_awk" 2>/dev/null)"
  if [ -n "$installer_stmt" ] && [ -n "$installer_awk" ] \
    && [ "$wrapper_field" = "$installer_field" ] \
    && [ "$wrapper_field" = "$ZIZMOR_PINNED_VERSION" ]; then
    echo "  ✓ setup-hooks.sh's own sourcing statement, executed, agrees with the wrapper's extraction on a trailing-token version string"
  else
    echo "  ✗ setup-hooks.sh's own sourcing statement does not reproduce the wrapper's extraction (wrapper: '$(sanitize "$wrapper_field")', installer: '$(sanitize "$installer_field")', installer_awk: '$(sanitize "$installer_awk")', statement found: $([ -n "$installer_stmt" ] && echo yes || echo no), stderr: '$(sanitize "$installer_err")')" >&2
    fails=$((fails + 1))
  fi

  # The extractor above takes the FIRST `^ZIZMOR_VERSION_AWK=` statement, and
  # the wiring grep below matches the `cargo_get_pinned` call site. A SECOND
  # top-level assignment placed between the two would satisfy both while
  # changing what actually reaches the installer (#3559, item 2), so assert
  # there is exactly one — anchored on the same construct the extractor anchors
  # on, so the two do not disagree about what they are counting. Both accept an
  # optional `export ` prefix: `export ZIZMOR_VERSION_AWK=…` sits at column 0,
  # is a thoroughly plausible spelling, and under a bare `^ZIZMOR_VERSION_AWK=`
  # anchor it was invisible to BOTH — so a second one could take effect at
  # runtime while the extractor kept cross-checking the first and this count
  # kept reading 1 (found in #3559's review).
  #
  # Precisely: the two patterns are EQUIVALENT, not textually identical. The
  # extractor is awk and spells the gap `[ \t]+` (line ~446); this is grep -E
  # and spells it `[[:space:]]+`. On a single line those accept the same thing,
  # so the property holds today — but they are two spellings, and widening one
  # without the other is exactly the drift this assertion exists to catch. Keep
  # them in step by hand; nothing enforces it (#3578).
  #
  # KNOWN BOUNDARY, do not over-trust this pair: it closes top-level
  # re-assignment only. An INDENTED re-assignment (inside an `if`, a function,
  # a `case`) is invisible to both this count and the extractor, as is a second
  # assignment sharing a line with the first (`FOO=a; FOO=b` is one matching
  # LINE, and grep -c counts lines). And neither
  # this nor the execution check above enforces "one source of truth" — the
  # cross-check tests AGREEMENT ON A SAMPLE, so writing a hard-coded
  # `ZIZMOR_VERSION_AWK='NR == 1 { print $2 }'` back into setup-hooks.sh in
  # place of the sourcing sed still passes (a hard-coded DIFFERENT program,
  # e.g. `$NF`, does redden — that is the regression that actually happened).
  # Asserting "setup-hooks.sh contains no literal awk program of its own" is a
  # materially more brittle check and is deliberately not made here.
  awk_assign_count="$(grep -cE '^(export[[:space:]]+)?ZIZMOR_VERSION_AWK=' "$setup_hooks" 2>/dev/null || true)"
  if [ "${awk_assign_count:-0}" = 1 ]; then
    echo "  ✓ setup-hooks.sh has exactly one top-level ZIZMOR_VERSION_AWK assignment (the one executed above)"
  else
    echo "  ✗ setup-hooks.sh has ${awk_assign_count:-0} top-level ZIZMOR_VERSION_AWK assignments, not 1 — the cross-check above only ever executes the first, so a later one would reach cargo_get_pinned unchecked (#3559)" >&2
    fails=$((fails + 1))
  fi
  # The statement above CAN come back empty (renamed constant, moved file).
  # setup-hooks.sh deliberately warns instead of exiting in that case — it is
  # a best-effort bootstrap that must not sink the other fourteen hook
  # binaries it installs (HOOK_BINS's fourteen names plus sqlx-cli, less
  # zizmor itself) — so
  # the warning is the only runtime notice a developer gets, and it has to
  # name the `$NF` fallback that silently takes over. Execute setup-hooks.sh's
  # own guard with an empty value (stubbing only `warn`) and assert it
  # actually says so; a guard that warns nothing, or warns without naming the
  # consequence, is the silent degradation this whole cluster is about.
  # Same fail-closed, line-budgeted shape as the extractor above, and for the
  # same reason — this one is the case that actually went green on a runaway.
  # `^fi` is matched with a delimiter alternation so `fi  # end guard` still
  # terminates the block; an `fi` that moves (indented, renamed) yields an
  # empty statement and reddens rather than swallowing the installer.
  guard_stmt="$(
    awk '
      /^if \[ -z "\$ZIZMOR_VERSION_AWK" \]; then/ && !grab { grab = 1; buf = $0; next }
      grab {
        buf = buf "\n" $0
        if ($0 ~ /^fi([ \t;#]|$)/) { print buf; exit }
        if (++n >= 20)             { exit }   # runaway — print NOTHING
      }
    ' "$setup_hooks" 2>/dev/null
  )"
  # Same sandbox as the statement above: stub PATH, poisoned shims, and
  # warn/ok/note/have all stubbed (this payload used to stub `warn` alone).
  # The empty ZIZMOR_VERSION_AWK the guard is being tested against arrives
  # through sandbox_bash's environment, so no column-0 `ZIZMOR_VERSION_AWK=`
  # decoy is left inside this file (#3559).
  guard_out="$(sandbox_bash "$guard_stmt" "$setup_hooks" 2>&1)"
  # `case`, not `printf … | grep -qF` — same pipefail/SIGPIPE phantom-failure
  # hazard documented on assert_out above.
  guard_names_nf=no
  case "$guard_out" in *'$NF'*) guard_names_nf=yes ;; esac
  if [ -n "$guard_stmt" ] && [ "$guard_names_nf" = yes ]; then
    echo "  ✓ setup-hooks.sh's empty-ZIZMOR_VERSION_AWK guard fires and names the \$NF fallback it degrades to"
  else
    echo "  ✗ setup-hooks.sh's empty-ZIZMOR_VERSION_AWK guard is missing or does not name the \$NF fallback (guard found: $([ -n "$guard_stmt" ] && echo yes || echo no), output: '$(sanitize "$guard_out")')" >&2
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

  # The grep above proves the ARGUMENT is passed; it cannot prove the callee
  # receives it INTACT. It did not, once: a `${4:-NR == 1 { print $NF }}`
  # default truncates at the first unquoted `}` (a bare `{` does not nest —
  # only `${` does) and appends a literal one, so a supplied $4 arrived as
  # `<field>}` and awk died of a syntax error. Its stderr was unredirected,
  # `current` came back empty, and zizmor reinstalled on every run.
  #
  # Asserted against the source because `cargo_get_pinned` installs crates and
  # cannot be invoked here. `bash -n` and shellcheck both accept the broken
  # form — it is valid bash that means the wrong thing — so only a targeted
  # check sees it.
  if grep -nE 'field="\$\{4:-.*\{' "$setup_hooks" >/dev/null 2>&1; then
    echo "  ✗ cargo_get_pinned's field default uses \${4:-...{...}} — bash truncates that at the first unquoted } and appends a literal one, so a supplied field arrives corrupted (#3545)" >&2
    fails=$((fails + 1))
  else
    echo "  ✓ cargo_get_pinned's field default does not use the brace-truncating \${4:-...} form"
  fi

  # (7) #3578 — the sandbox prelude's `have()` (sourced from setup-hooks.sh
  # above, into $setup_hooks_have) must be the REAL command-v check, not a
  # fixed answer that merely resembles it. Sourcing removes the ability to
  # DRIFT out of sync with setup-hooks.sh's have(), but a sourcing bug (wrong
  # line grabbed, extraction pattern too loose) could still land something
  # that isn't the real check — and because $setup_hooks_have came from
  # setup-hooks.sh's OWN text, this exercises that text's actual behaviour
  # rather than re-asserting what block (6) already established. Probe both
  # arms, not just one, exactly per the comment above sandbox_prelude: a
  # `return 0` fixed answer and a `return 1` fixed answer are two DIFFERENT
  # wrong behaviours, and a check that only rules out one leaves the sibling
  # open. `cat` is real and symlinked into the sandbox (see the sbx_tool loop
  # above) so `have cat` is true under a real check; the made-up tool name
  # below is on no PATH anywhere, sandboxed or not, so `have` on it is false
  # under a real check.
  sandbox_have_probe="$(
    sandbox_bash 'if have cat
then echo SANDBOX_HAVE_CAT_YES
else echo SANDBOX_HAVE_CAT_NO
fi
if have zz_definitely_not_a_real_tool_3578
then echo SANDBOX_HAVE_MISSING_YES
else echo SANDBOX_HAVE_MISSING_NO
fi' "$setup_hooks" 2>&1
  )"
  assert_out "sandbox have(): a real, present tool (cat) is reported available" \
    "SANDBOX_HAVE_CAT_YES" "$sandbox_have_probe"
  assert_out "sandbox have(): a tool absent from the sandboxed PATH is reported unavailable" \
    "SANDBOX_HAVE_MISSING_NO" "$sandbox_have_probe"
  refute_out "sandbox have() is not a fixed 'always available' answer (rules out setup-hooks.sh's have() becoming e.g. \`return 0\`)" \
    "SANDBOX_HAVE_MISSING_YES" "$sandbox_have_probe"
  refute_out "sandbox have() is not a fixed 'never available' answer (rules out setup-hooks.sh's have() becoming e.g. \`return 1\`)" \
    "SANDBOX_HAVE_CAT_NO" "$sandbox_have_probe"

  # The extraction above takes the FIRST line matching `^have() { .*; }$` and
  # exits loud only on ZERO matches — same as the ZIZMOR_VERSION_AWK extractor
  # once did, before this file's own review (#3559) found that a SECOND
  # top-level assignment sharing the same anchor would satisfy that extractor
  # while changing what actually reaches the installer, and added the
  # `awk_assign_count` check above to close it. `head -n 1` here has the same
  # gap: a second line matching this pattern — a decoy `have() { ... }`
  # placed earlier in the file, e.g. a stale debug override left in — would
  # be silently preferred over the real one with no error, no red assertion,
  # and no signal that block (7) just verified the WRONG function's
  # behaviour. Demonstrated directly: two literal `have() { ... }` lines in a
  # test file, `sed -n '/^have() { .*; }$/p' | head -n 1` returns the FIRST,
  # not the one that would actually win at runtime (bash function
  # redefinition means the LAST one defined is the one that executes) —
  # exactly the "matches, but the wrong line" failure mode fail-closed
  # extraction is supposed to rule out, not just "matches nothing".
  # Counted in EVERY definition form bash accepts, not just the one the sed
  # above matches. `function have {`, `have () {` and an indented redefinition
  # all escape that stricter pattern, so counting only `^have() {` would let
  # precisely the redefinitions that beat the extractor go unnoticed while
  # this assertion claimed to have checked for them.
  have_def_count="$(grep -cE '^[[:space:]]*(function[[:space:]]+have([[:space:]]*\(\))?|have[[:space:]]*\(\))[[:space:]]*\{' "$setup_hooks" 2>/dev/null || true)"
  if [ "${have_def_count:-0}" = 1 ]; then
    echo "  ✓ setup-hooks.sh defines have() exactly once, in any form (the one sourced above)"
  else
    echo "  ✗ setup-hooks.sh has ${have_def_count:-0} have() definitions, not 1 — bash runs the LAST one defined, while the sed extraction above silently prefers the first, and this count is the only thing that would notice (#3578)" >&2
    fails=$((fails + 1))
  fi

  # (8) #3635 — the sandbox is PROVEN load-bearing, not assumed to be.
  #
  # Everything above bounds WHAT gets executed: fail-closed extraction windows
  # that come back empty rather than swallowing the file. This block is about
  # what executing the wrong thing can DO. It hands the payload a deliberately
  # runaway window over setup-hooks.sh's REAL provisioner and requires the
  # sandbox to be SEEN intercepting the installers that window reaches.
  #
  # Why the window is anchored at `^OS=` rather than at an extractor's own
  # anchor. A runaway from the real `^ZIZMOR_VERSION_AWK=` anchor swallows 569
  # lines and reads like the honest canary to write. It is vacuous. `OS` is
  # assigned ABOVE that anchor, the prelude runs under `set -u`, and the
  # payload dies inside setup-hooks.sh's `echo "Setting up the prek hook
  # toolchain (OS: $OS)…"` with `OS: unbound variable`, exit 127 and ZERO
  # SANDBOX-VIOLATIONs — before reaching a single installer. It reddens for a
  # reason that has nothing to do with containment, and a reader would take
  # that red as proof the sandbox fired. `set -u` on `$OS` is a SECOND,
  # ACCIDENTAL line of defence: the same accident-of-layout the sandbox exists
  # to replace, one screen further down the file, and it evaporates the day
  # `OS=` moves below that anchor (#3635, split out of #3578 item 3).
  #
  # So the window starts at setup-hooks.sh's first top-level assignment
  # (`OS="$(uname -s)"`) and runs to EOF: every function definition and every
  # top-level statement the file has. That is a CONSTRUCTED worst case rather
  # than one today's extractors can produce, deliberately — the property under
  # test here is "the sandbox contains a whole provisioner", not "this
  # extractor's line budget holds" (the budgets have their own assertions
  # above, and they are the first line of defence; this is the second).
  #
  # An earlier note here warned that "moving the window up changes the
  # scenario". It does, and that is the point: the scenario it changes to is
  # the only one that exercises the thing being claimed.
  runaway_stmt="$(
    awk '/^OS=/ && !grab { grab = 1 } grab { print }' "$setup_hooks" 2>/dev/null
  )"
  runaway_out="$(sandbox_bash "$runaway_stmt" "$setup_hooks" 2>"$tmp/runaway.err")"
  runaway_err="$(cat "$tmp/runaway.err" 2>/dev/null)"
  # Counted from the shims' own log rather than from $runaway_err — see the
  # shim body: setup-hooks.sh redirects nearly every installer's stderr to
  # /dev/null, so the capture holds 4 of the 28 and none of the decisive ones.
  runaway_violations="$(grep -c 'SANDBOX-VIOLATION' "$sandbox_violations" 2>/dev/null || true)"
  runaway_log="$(cat "$sandbox_violations" 2>/dev/null)"
  # The assertion is on the COUNT OF INTERCEPTIONS, deliberately, and not on
  # the payload's exit status. The broken form of this canary exited 127, so a
  # `[ "$rc" -ne 0 ]` check would have called it a pass while it proved
  # nothing. Any early abort — the #3635 one, or a new one further down the
  # file — collapses this count to near zero, so this is the assertion that
  # notices. Floor of 20 against 28 measured (2026-08): dropping a crate from
  # setup-hooks.sh's list costs 2 interceptions and must not redden a working
  # sandbox, while an abort costs all of them.
  if [ "${runaway_violations:-0}" -ge 20 ]; then
    echo "  ✓ a runaway extraction of setup-hooks.sh's whole provisioner is intercepted by the sandbox (${runaway_violations} violations)"
  else
    echo "  ✗ the runaway payload produced only ${runaway_violations:-0} SANDBOX-VIOLATIONs, expected at least 20 — either the sandbox stopped intercepting, or the payload died before it reached the installers and this canary is proving nothing (#3635). window: $([ -n "$runaway_stmt" ] && echo "found" || echo "EMPTY — no '^OS=' line in $setup_hooks"), payload stderr: '$(sanitize "$runaway_err")'" >&2
    fails=$((fails + 1))
  fi
  # Name the specific calls, not just the count: a count alone stays green if
  # the payload aborts halfway and racks up its 20 on `mktemp`/`rm` while every
  # installer goes unreached. These four are the ones a real runaway would have
  # run against the developer's box.
  assert_out "the runaway's from-source crate installs are intercepted" \
    'tried to run `cargo install --locked' "$runaway_log"
  # `pkg_install` branches on `$OS`, and the window now assigns `$OS` for real
  # from `uname -s` — so the spelling of the intercepted call depends on the
  # box: `sudo apt-get install` on Linux, `brew install` on macOS. Accept
  # either rather than pinning the Linux one and reddening this file on a
  # macOS dev box (CI is ubuntu-24.04, the pre-commit hook is not). The
  # dnf/pacman arms cannot be reached from here whatever the host: `apt-get` is
  # always present inside the sandbox as a poisoned shim, so `have apt-get`
  # takes the apt branch on every Linux.
  pkg_install_intercepted=no
  case "$runaway_log" in
    *'tried to run `sudo apt-get install'*|*'tried to run `brew install'*)
      pkg_install_intercepted=yes ;;
  esac
  if [ "$pkg_install_intercepted" = yes ]; then
    echo "  ✓ the runaway's system-package installs are intercepted"
  else
    echo "  ✗ the runaway's system-package installs are NOT intercepted (expected a violation naming \`sudo apt-get install\` or \`brew install\` in the sandbox log)" >&2
    fails=$((fails + 1))
  fi
  assert_out "the runaway's hook-environment provisioning is intercepted" \
    'tried to run `prek install-hooks' "$runaway_log"
  assert_out "the runaway's network fetch is intercepted" \
    'tried to run `curl ' "$runaway_log"
  # The fetch above is only reachable because the `mktemp` shim SUCCEEDS while
  # still recording itself (#3622's guard falls back to `cargo install` on a
  # failed `mktemp -d`, and then no download is attempted at all). Dropping
  # `mktemp` from the poisoned set would also restore the fetch — and would
  # silently stop observing every temp directory the provisioner creates. This
  # pins the half that the curl assertion cannot see.
  assert_out "the runaway's temp-directory creation is still recorded as a violation" \
    'tried to run `mktemp ' "$runaway_log"
  # Reaching the END of the provisioner is what rules out the #3635 shape
  # returning somewhere new: an abort anywhere in those 843 lines drops this
  # line, whatever the violation count happened to be by then.
  assert_out "the runaway payload ran the provisioner to completion (nothing aborted it early)" \
    "Hook toolchain setup complete" "$runaway_out"
  refute_out "the runaway payload did not die on an unbound variable before reaching the installers (#3635)" \
    "unbound variable" "$runaway_err"
  # The other half of the claim: intercepted AND inert. `mkdir`, `install`,
  # `mktemp` and `tar` are all shims, so a provisioner that ran end-to-end must
  # still have created nothing. A file here means something mutating got
  # through by a route the PATH shims do not cover (an absolute path, or a
  # shell redirection — boundary cases 1 and 3 above). No `| head` on the
  # `find`: `head` closing the pipe early is the same pipefail/SIGPIPE trap
  # documented on assert_out, and `sanitize` already bounds the message.
  runaway_spill="$(find "$sandbox_home" -mindepth 1 2>/dev/null)"
  if [ -z "$runaway_spill" ]; then
    echo "  ✓ the runaway payload created nothing in the sandbox HOME"
  else
    echo "  ✗ the runaway payload wrote into the sandbox HOME: '$(sanitize "$runaway_spill")' — every mutating call is supposed to become a violation instead (#3635)" >&2
    fails=$((fails + 1))
  fi

  # (9) #3578 item 2 / #3635 — the HOME pin is load-bearing for PATH
  # INTEGRITY, and now something executes it instead of a comment asserting it.
  #
  # setup-hooks.sh re-prepends two directories to PATH near its top, and the
  # sandboxed payload runs that line for real (block (8)'s window covers it).
  # It is inert only because HOME is pinned at an empty temp tree, so the
  # `$HOME/.cargo/bin` / `$HOME/.local/bin` it prepends do not exist and the
  # poisoned shims keep winning the lookup. That was verified by hand in both
  # directions — pinned HOME: `cargo` resolves to the shim; HOME pointed at a
  # tree containing a real `~/.cargo/bin/cargo`: the real binary wins the PATH
  # race and runs uncontained — and then documented as a known boundary with
  # nothing exercising it, because the line sits ABOVE both of block (6)'s
  # extraction windows. This makes the first direction automatic.
  #
  # setup-hooks.sh's OWN line is lifted and executed, not retyped here — the
  # same discipline as every other check in this file. A retyped copy tests
  # this file against itself and stays green through any change over there.
  #
  # Three separate properties, because "cargo exited 97" on its own would also
  # hold on a box that simply has no real cargo anywhere:
  #   * the export does not displace the shim — `command -v cargo` still
  #     resolves INSIDE the sandbox directory after it has run;
  #   * executing it is still intercepted (exit 97 plus a logged violation);
  #   * and every element of the resulting PATH is either the sandbox or under
  #     the pinned HOME. That third one is the actual guarantee: a future
  #     setup-hooks.sh prepending an absolute `/usr/local/bin` reddens here on
  #     EVERY box, including the ones where that directory is empty today and
  #     the first two checks would happily stay green.
  path_export_count="$(grep -cE '^export PATH=' "$setup_hooks" 2>/dev/null || true)"
  path_export_stmt="$(sed -n '/^export PATH=/{p;q;}' "$setup_hooks" 2>/dev/null)"
  if [ "${path_export_count:-0}" = 1 ] && [ -n "$path_export_stmt" ]; then
    echo "  ✓ setup-hooks.sh has exactly one top-level 'export PATH=' (the one executed below)"
  else
    echo "  ✗ setup-hooks.sh has ${path_export_count:-0} top-level 'export PATH=' lines, not 1 — the check below only executes the first, so a second one could prepend a directory outside \$HOME with nothing to notice (#3578 item 2)" >&2
    fails=$((fails + 1))
  fi
  # `cargo --version`'s own stderr is discarded inside the payload on purpose:
  # it makes this block depend on the violation LOG the way the real installer
  # call sites do, rather than on a redirection setup-hooks.sh does not use.
  home_pin_probe="$(
    sandbox_bash "$path_export_stmt"'
printf "HOME_PIN_PATH=%s\n" "$PATH"
printf "HOME_PIN_CARGO_RESOLVES_TO=%s\n" "$(command -v cargo || echo NONE)"
cargo --version >/dev/null 2>&1
printf "HOME_PIN_CARGO_RC=%s\n" "$?"' "$setup_hooks" 2>&1
  )"
  home_pin_log="$(cat "$sandbox_violations" 2>/dev/null)"
  assert_out "setup-hooks.sh's PATH export does not displace the poisoned cargo shim (the HOME pin holds)" \
    "HOME_PIN_CARGO_RESOLVES_TO=$sandbox/cargo" "$home_pin_probe"
  assert_out "running cargo after that export is still intercepted (exit 97)" \
    "HOME_PIN_CARGO_RC=97" "$home_pin_probe"
  assert_out "…and that interception is recorded as a violation" \
    'tried to run `cargo --version' "$home_pin_log"
  # Split on `:` with `read -ra`, not an unquoted `for` over an IFS-split
  # expansion: `read` does not glob, so a PATH element containing `*` or `?`
  # cannot expand into something else on its way to the comparison. It also
  # PRESERVES empty elements, which matters — an empty element is bash's
  # spelling of "the current directory", the same silent cwd-on-PATH hazard the
  # empty-$tmp guard at the top of this self-test exists for, and dropping it
  # here would let exactly that case pass unnoticed.
  home_pin_path="${home_pin_probe#*HOME_PIN_PATH=}"
  home_pin_path="${home_pin_path%%$'\n'*}"
  home_pin_foreign=""
  IFS=: read -r -a home_pin_elems <<< "$home_pin_path"
  for path_elem in "${home_pin_elems[@]}"; do
    case "$path_elem" in
      "$sandbox"|"$sandbox_home"|"$sandbox_home"/*) : ;;
      "") home_pin_foreign="$home_pin_foreign <empty element: bash reads that as the current directory>" ;;
      *) home_pin_foreign="$home_pin_foreign $path_elem" ;;
    esac
  done
  if [ -n "$home_pin_path" ] && [ -z "$home_pin_foreign" ]; then
    echo "  ✓ every PATH element after setup-hooks.sh's export is the sandbox itself or under the pinned HOME"
  else
    echo "  ✗ setup-hooks.sh's PATH export leaves element(s) outside the pinned sandbox HOME on PATH:$(sanitize "${home_pin_foreign:-<no PATH reported by the payload>}") — the sandbox's PATH guarantee rests on every prepended directory living under \$HOME (#3578 item 2)" >&2
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
