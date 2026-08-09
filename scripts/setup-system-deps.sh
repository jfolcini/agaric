#!/usr/bin/env bash
# Install the Linux native libraries needed to compile and test Agaric's Rust
# workspace (#3556).
#
# THE GATE — the whole point of this script is *when* it runs, not what it
# installs. Installing system packages is right in a disposable sandbox and
# intrusive on a developer's own machine, so nothing here is reachable by
# default. The chain is, in order:
#
#   .claude/hooks/session-start.sh   exits 0 unless CLAUDE_CODE_REMOTE=true
#     └─ scripts/setup.sh --install-system-deps   the flag is the only way in
#          └─ this script
#
# `bash scripts/setup.sh` with no flag — which is what `npm run setup`,
# `just setup`, and every documented local invocation do — never reaches this
# file and keeps the long-standing warn-only contract. The flag, not an
# environment sniff, is the gate inside setup.sh, so that pasting
# `bash scripts/setup.sh --install-system-deps` into a cloud environment's
# "Setup script" field (documented in docs/BUILD.md) also works, where
# CLAUDE_CODE_REMOTE is not necessarily exported.
#
# Everything below is idempotent, noninteractive (never prompts for a
# password), and best-effort: it reports failure truthfully to setup.sh's
# final summary rather than aborting bootstrap.
set -euo pipefail

# Provenance, so this list can be re-derived rather than guessed:
#   * The first six are exactly the apt list in the Rust compile/test lane of
#     .github/workflows/_validate.yml — the lane that runs clippy, nextest and
#     `sqlx prepare`. Those are what `gdk-sys` (via `wry`) needs to configure;
#     without them the crate does not compile, so `cargo check --all-targets`
#     and `cargo nextest` fail, not merely `cargo tauri dev` (#3556).
#   * `patchelf` is the one addition beyond that lane: it is bundle-time only
#     (linuxdeploy rewrites RPATH with it — see .github/workflows/ci.yml), but
#     it is cheap, has no dev headers, and #3556 names it explicitly, so a
#     sandbox that goes on to run `cargo tauri build` does not hit this again.
# Deliberately NOT included: `mold` (an optional linker speed-up — setup.sh's
# ensure_fast_linker degrades cleanly without it) and `libappindicator3-dev`
# (AppImage tray bundling only).
readonly -a BUILD_PACKAGES=(
  libwebkit2gtk-4.1-dev
  libgtk-3-dev
  libssl-dev
  librsvg2-dev
  libsoup-3.0-dev
  pkg-config
  patchelf
)

warn() { printf 'warning: %s\n' "$*" >&2; }

manual_install_hint() {
  printf 'Install manually: sudo apt-get install -y'
  printf ' %q' "${BUILD_PACKAGES[@]}"
  printf '\n'
}

# One record PER LINE — NOT an exact-string compare on a bare `${Status}`
# (#3637). dpkg-query renders the format string once per matching record and
# inserts no separator of its own, so on a multi-arch host
# (`dpkg --add-architecture i386`) a package installed for two architectures
# came back as the single run-on string `install ok installedinstall ok
# installed`, which equals nothing, so a *present* package read as MISSING.
# The consequence was not a harmless miss: the post-install re-verification
# below then printed "apt reported success but N package(s) are still
# missing" and set the "will not compile or test" advisory on a fully
# provisioned box — the exact false-negative class this script exists to
# prevent. `${binary:Package}` carries the arch qualifier, so the trailing
# `\n` unambiguously ends each record.
#
# Captured into a variable and matched with `[[ ]]`, NOT piped into `grep -q`:
# this script runs under `set -o pipefail` and `grep -q` exits the instant it
# matches, so dpkg-query is killed by SIGPIPE while still writing and the
# pipeline returns 141 — a package would read as missing on a coin-flip
# (observed immediately when this fix was first written that way). A package
# name cannot contain a space, so a substring test against the leading space
# of the status field cannot be satisfied by anything but a real record.
package_is_installed() {
  local records
  records="$(dpkg-query -W -f='${binary:Package} ${Status}\n' "$1" 2>/dev/null || true)"
  [[ "$records" == *" install ok installed"* ]]
}

use_sudo=false
run_as_root() {
  if [ "$use_sudo" = true ]; then
    sudo -n "$@"
  else
    "$@"
  fi
}

# True iff patchelf is the ONLY package in BUILD_PACKAGES not currently
# installed (queried fresh via dpkg, not assumed from a pre-attempt scan —
# apt can leave partial state behind). patchelf is bundle-time only
# (linuxdeploy/`cargo tauri build`); the other six are what the Rust
# workspace needs to compile and test. Every failure path below calls this to
# decide its exit code, so a patchelf-only miss is never reported with the
# same severity as a compile/test-set miss (#3629 review).
only_patchelf_missing() {
  local -a still=()
  local package
  for package in "${BUILD_PACKAGES[@]}"; do
    package_is_installed "$package" || still+=("$package")
  done
  [ "${#still[@]}" -eq 1 ] && [ "${still[0]}" = 'patchelf' ]
}

# Exit code convention consumed by scripts/setup.sh:
#   0  = every BUILD_PACKAGES entry installed.
#   42 = patchelf is the only one still missing — compile/test set intact.
#   1  = anything else (including "can't tell" cases like a missing dpkg-query).
#
# Why 42 and not 2 (#3629 review): bash itself exits 2 on ITS OWN syntax
# errors (`bash -c 'if [ 1 -eq 1'` -> exit 2), and this script runs under
# `set -euo pipefail` with no trap — a parse error in setup-system-deps.sh
# (e.g. a future edit that leaves an `if` unclosed) never reaches a line of
# our code at all; bash aborts the whole script and *that* is the exit
# status scripts/setup.sh receives. If this sentinel were 2, such a parse
# error would be silently misread by setup.sh as "patchelf-only, compile/test
# set confirmed intact" — a false all-clear from the exact script whose job
# is to prevent one. 42 is never emitted by bash for its own errors (not the
# generic failure 1, not bash's syntax-error 2, not 126/127 exec-failure, not
# 128+signal, and not 64 — this repo's own arg-parse-error convention in
# scripts/setup.sh) and this script is the only place that returns 42: every
# exit path funnels through fail_status() (0/1/42) or the explicit `return 0`
# on success, never a raw propagated apt-get/dpkg-query status. Do NOT "tidy"
# this back to 2.
#
# The wording says "is present", not "installed fine" (#3637): fail_status is
# reached from paths where NOTHING was installed — the no-privilege bail-out
# and the apt-update failure both call it before any package is touched — and
# on those a message claiming an install had gone well was simply false. The
# classification was always right; only the claim about how the compile/test
# set got there was wrong, and this script's whole value is that its messages
# can be trusted.
fail_status() {
  if only_patchelf_missing; then
    warn 'patchelf (bundle-time only, used by "cargo tauri build" to rewrite RPATH) is the only package still missing — the compile/test package set is present.'
    return 42
  fi
  return 1
}

main() {
  if [ "$(uname -s)" != 'Linux' ]; then
    echo 'Linux system dependencies are not needed on this platform — skipping.'
    return 0
  fi

  if ! command -v apt-get >/dev/null 2>&1 || ! command -v dpkg-query >/dev/null 2>&1; then
    warn 'automatic system-dependency installation currently supports Debian/Ubuntu only.'
    manual_install_hint >&2
    # dpkg-query itself may be unavailable here, but only_patchelf_missing
    # degrades safely (package_is_installed treats an unqueryable package as
    # not installed), so this still correctly falls through to the broad
    # exit-1 path rather than misreporting a patchelf-only miss. `|| rc=$?`
    # (not a bare call) because fail_status always returns nonzero, and a
    # bare failing command would trip `set -e` before its code was captured.
    local rc=1
    fail_status || rc=$?
    return "$rc"
  fi

  local -a missing=()
  local package
  for package in "${BUILD_PACKAGES[@]}"; do
    package_is_installed "$package" || missing+=("$package")
  done

  if [ "${#missing[@]}" -eq 0 ]; then
    echo 'Linux build/test system dependencies already installed — skipping apt.'
    return 0
  fi

  if [ "$(id -u)" -eq 0 ]; then
    use_sudo=false
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    # Never let an unattended SessionStart hook open an interactive password
    # prompt. `-n` is retained on every privileged command below.
    use_sudo=true
  else
    warn 'cannot install Linux build/test dependencies without root or passwordless sudo.'
    manual_install_hint >&2
    # Nothing has been attempted yet, so `missing` (just computed above) is
    # still the true state — same reasoning as fail_status's fresh query.
    local rc=1
    fail_status || rc=$?
    return "$rc"
  fi

  echo "Installing ${#missing[@]} missing Linux build/test system package(s)…"

  # Self-heal an interrupted dpkg before touching apt (#3637). This installer
  # runs synchronously inside .claude/hooks/session-start.sh's hard ~600s
  # provisioning cap; a SIGKILL landing mid-`apt-get install` leaves dpkg
  # half-configured, and every subsequent apt-get then aborts outright with
  # "dpkg was interrupted, you must manually run 'dpkg --configure -a'".
  # Every other bootstrap step in this repo is re-runnable; without this one
  # line, the step whose whole job is to make a sandbox build-ready was the
  # single one that a timeout could wedge permanently.
  #
  # Cheap and safe to run unconditionally: with nothing pending it is a no-op
  # that exits 0. Best-effort — a failure here is NOT a reason to abort, the
  # apt-get below reports the real problem with far better context, so its
  # status is deliberately swallowed rather than propagated.
  if command -v dpkg >/dev/null 2>&1; then
    if ! run_as_root dpkg --configure -a >/dev/null 2>&1; then
      warn 'dpkg --configure -a (interrupted-install self-heal) did not succeed; continuing — the apt-get below will report the real error.'
    fi
  fi

  if ! run_as_root apt-get -o Acquire::Retries=3 update -qq; then
    warn 'apt-get update failed; Rust builds/tests may remain unavailable.'
    manual_install_hint >&2
    local rc=1
    fail_status || rc=$?
    return "$rc"
  fi
  if ! run_as_root env DEBIAN_FRONTEND=noninteractive \
    apt-get -o Acquire::Retries=3 install -y "${missing[@]}"; then
    warn 'apt-get install failed; Rust builds/tests may remain unavailable.'
    manual_install_hint >&2
    # Query fresh here (not the pre-attempt `missing`) — apt can leave
    # partial state behind on a failed install.
    local rc=1
    fail_status || rc=$?
    return "$rc"
  fi

  local -a still_missing=()
  for package in "${BUILD_PACKAGES[@]}"; do
    package_is_installed "$package" || still_missing+=("$package")
  done
  if [ "${#still_missing[@]}" -ne 0 ]; then
    warn "apt reported success but ${#still_missing[@]} build/test package(s) are still missing."
    manual_install_hint >&2
    local rc=1
    fail_status || rc=$?
    return "$rc"
  fi

  echo 'Linux build/test system dependencies installed.'
}

main "$@"
