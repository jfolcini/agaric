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

package_is_installed() {
  [ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null || true)" = 'install ok installed' ]
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
#   0 = every BUILD_PACKAGES entry installed.
#   2 = patchelf is the only one still missing — compile/test set intact.
#   1 = anything else (including "can't tell" cases like a missing dpkg-query).
fail_status() {
  if only_patchelf_missing; then
    warn 'patchelf (bundle-time only, used by "cargo tauri build" to rewrite RPATH) is the only package still missing — the compile/test package set installed fine.'
    return 2
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
