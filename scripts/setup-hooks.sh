#!/usr/bin/env bash
# Install the prek hook toolchain and wire the git hooks.
#
# prek runs the hooks in prek.toml, but it does NOT ship their tools — each
# hook shells out to a binary (local `language = "system"` hooks) or is built
# by prek from a pinned upstream repo (the `gitleaks` / `actionlint` Go hooks
# and the `conventional-pre-commit` Python hook). Without the underlying
# toolchain on the box, the very first `git commit` aborts. This script
# installs that toolchain so a fresh clone — or a fresh dev VM — is
# commit/push-ready, mirroring CI's install set in
# `.github/workflows/_validate.yml` so the local gate matches CI.
#
# Target platforms: Ubuntu 24.04 / 26.04 (primary — apt), other Linux
# (dnf/pacman, best-effort), macOS (brew, best-effort).
#
# Best-effort and idempotent by design:
#   * tools already on PATH are skipped (fast re-runs);
#   * anything that can't be auto-installed on a platform prints a manual hint
#     instead of aborting — a partial toolchain still builds and runs the app,
#     you just can't run every hook until the gap is filled.
# Hence `set -u` but NOT `set -e`: a single failed installer must never sink
# the whole bootstrap (so it is safe to call from `scripts/setup.sh` and from
# VM provisioning). Because a failed installer is silent-by-exit-code, the
# script ends with a loud `MISSING:` summary (issue #2535) listing every hook
# binary still absent after all fallbacks ran — read that block, not the
# exit code, to know whether provisioning fully succeeded.
#
# Remote-container / egress-proxy hardening (issue #2535): some sandboxed
# sessions only allow crates.io + cargo-binstall traffic through the egress
# proxy and 403 on GitHub release-tarball downloads. Every installer below
# that pulls a prebuilt GitHub release tarball (lychee, cargo-binstall
# itself) therefore falls back to `cargo binstall`, then `cargo install
# --locked`, before giving up. Separately, a crate's newest release can
# require a newer rustc than this box's pinned toolchain (MSRV skew), which
# fails both binstall AND the from-source fallback identically — see
# `msrv_fallback_version_for()` below for the pinned-version retry that
# handles that case.
#
# Two DIFFERENT version tables, opposite precedence (issue #3602, and #3611
# for the sequel): a crate CI pins explicitly (today: sqruff, `sqruff@0.38.0`
# in the `tool:` lists of `.github/workflows/_validate.yml` and
# `scheduled-deep-checks.yml`) must install that EXACT version here too, and
# — #3611 — REPLACE a differing one already on PATH, not just skip installing
# because *something* is already there. `cargo_get` used to try latest first
# and only fall back to the pinned value if that failed, so on any box where
# binstall could fetch a newer sqruff, local silently ran a different linter
# version than CI. That got one layer worse before it got fixed: routing the
# pin through a branch INSIDE `cargo_get` still lost to `cargo_get`'s own
# `have "$bin"` early return (grep `if have "$bin"` to land on it — the first
# statement `cargo_get` runs after its `local` declaration; this cited a line
# number until #3619 found the number had rotted to a stale "~230", so a
# greppable anchor replaced it rather than a fresher number that would rot
# the same way) on any box that had already
# installed a wrong version — which, for a crate #3602 had just made local
# ever install unpinned, was every box that ran this script before the pin
# existed. So a pinned crate is instead routed to `cargo_get_pinned` directly
# at its call site — `cargo_get` is never invoked for it at all, and has no
# pin-handling branch to bypass. `pinned_version_for()` is the version TABLE
# a pinned crate's `cargo_get_pinned` call reads from; it is a distinct
# concept from `msrv_fallback_version_for()`'s MSRV-skew escape hatch, which
# stays tried SECOND inside `cargo_get`, only after a real latest-install
# attempt fails, for a crate with no CI pin.
set -uo pipefail

have() { command -v "$1" >/dev/null 2>&1; }

ok()   { printf '  \033[32m✓ %s\033[0m\n' "$*"; }
note() { printf '  \033[36m%s\033[0m\n' "$*"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$*"; }

OS="$(uname -s)"

# Cargo / local binaries land here; make sure they're visible to the rest of
# the script (a fresh shell may not have sourced the cargo env yet).
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

# pkg_install <brew-name> <apt-name> <binary> — install a system package via
# the platform package manager, or warn with a manual hint. (apt name doubles
# as the dnf/pacman name; override by hand if a distro diverges.)
pkg_install() {
  local brew_name="$1" apt_name="$2" bin="$3"
  if have "$bin"; then ok "$bin (already installed)"; return; fi
  case "$OS" in
    Darwin)
      if have brew; then
        if brew install "$brew_name" >/dev/null 2>&1; then ok "$bin (brew)"
        else warn "brew install $brew_name failed — install $bin manually"; fi
      else
        warn "Homebrew not found — install $bin manually (https://brew.sh)"
      fi
      ;;
    Linux)
      if have apt-get; then
        sudo apt-get update -qq >/dev/null 2>&1 || true
        if sudo apt-get install -y "$apt_name" >/dev/null 2>&1; then ok "$bin (apt)"
        else warn "apt could not install '$apt_name' — install $bin manually"; fi
      elif have dnf; then
        if sudo dnf install -y "$apt_name" >/dev/null 2>&1; then ok "$bin (dnf)"
        else warn "install $bin manually"; fi
      elif have pacman; then
        if sudo pacman -S --noconfirm "$apt_name" >/dev/null 2>&1; then ok "$bin (pacman)"
        else warn "install $bin manually"; fi
      else
        warn "no supported package manager — install $bin manually"
      fi
      ;;
    *) warn "unsupported OS '$OS' — install $bin manually" ;;
  esac
}

# verify_sha256 <file> <expected-hex> — true iff <file>'s SHA-256 equals the
# pinned digest. Uses sha256sum (Linux/coreutils) or `shasum -a 256` (macOS);
# returns non-zero if neither tool exists, so the caller can fail closed.
verify_sha256() {
  local file="$1" want="$2" got=""
  if have sha256sum; then
    got="$(sha256sum "$file" | awk '{print $1}')"
  elif have shasum; then
    got="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    return 1
  fi
  [ "$got" = "$want" ]
}

# cargo-binstall pulls prebuilt release binaries (seconds, low disk) instead
# of the multi-minute from-source `cargo install` compile. Install it from the
# pinned upstream prebuilt release TARBALL — NOT by piping the upstream install
# script into a shell.
#
# Pinned-Dependencies (OpenSSF Scorecard, code-scanning #215): a `curl | bash`
# — or a curl-to-temp-then-`bash` — of the install script is a download-then-run
# that Scorecard flags *regardless of any hash check*, because the static check
# only cares that a downloaded file reaches a shell interpreter. So fetch the
# release *binary* tarball directly (the same `curl … | tar` shape as
# `install_lychee`, which Scorecard accepts) and verify its SHA-256 before
# extracting. The matrix below is Linux-only (where the dev VMs run and where
# the prebuilt speed matters); macOS / other arches fall back to the
# equally-pinned `cargo install --locked` to keep the pinned-hash set small.
#
# To bump: set BINSTALL_VERSION to the new release tag and refresh the two
# linux-musl digests with, for each <triple>:
#   curl -fsSL https://github.com/cargo-bins/cargo-binstall/releases/download/v<ver>/cargo-binstall-<triple>.tgz | sha256sum
BINSTALL_VERSION="1.20.1"
BINSTALL_SHA256_X86_64="f12954bc382e1d0b2df3fbfb217a05d92c25570e4517841e0613499a24f4594e"
BINSTALL_SHA256_AARCH64="23679581c4cfa1782953264a6e36965198aed995b3a5287550dd78a113ce2288"
ensure_cargo_binstall() {
  if have cargo-binstall; then ok "cargo-binstall (already installed)"; return; fi
  note "installing cargo-binstall (prebuilt-binary fetcher)…"
  local triple="" want=""
  case "${OS}-$(uname -m)" in
    Linux-x86_64)               triple="x86_64-unknown-linux-musl";  want="$BINSTALL_SHA256_X86_64" ;;
    Linux-aarch64|Linux-arm64)  triple="aarch64-unknown-linux-musl"; want="$BINSTALL_SHA256_AARCH64" ;;
  esac
  if [ -n "$triple" ]; then
    local url="https://github.com/cargo-bins/cargo-binstall/releases/download/v${BINSTALL_VERSION}/cargo-binstall-${triple}.tgz"
    local dest="$HOME/.cargo/bin" tmp
    tmp="$(mktemp -d)"
    # `set -u` does NOT fire on a failed `mktemp -d` (#3622): the command
    # substitution yields an empty STRING, and assigning "" is not an unset
    # variable — and this script deliberately runs without `set -e` (see the
    # header), so nothing stops it either. With $tmp="" the download below
    # writes `/cb.tgz` at the filesystem ROOT (root-owned in the CI
    # containers this runs in), `tar -C ""` then fails, `rm -rf ""` removes
    # nothing, and the function falls back to `cargo install` — so
    # provisioning "succeeds" and the stray root-owned file is never even
    # reported. Bail out BEFORE anything is written, and before any cleanup
    # path can expand to `rm -rf ""`.
    if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then
      warn "mktemp -d failed (no writable temp dir?) — skipping the prebuilt cargo-binstall download, falling back to cargo install"
    else
      mkdir -p "$dest"
      # Download the tarball, verify its pinned SHA-256, then extract the
      # single `cargo-binstall` binary and install it. No downloaded content
      # is ever handed to a shell interpreter.
      if curl -fsSL --proto '=https' --tlsv1.2 "$url" -o "$tmp/cb.tgz" \
           && verify_sha256 "$tmp/cb.tgz" "$want" \
           && tar -xzf "$tmp/cb.tgz" -C "$tmp" cargo-binstall \
           && install -m 0755 "$tmp/cargo-binstall" "$dest/cargo-binstall" \
           && have cargo-binstall; then
        ok "cargo-binstall (prebuilt v${BINSTALL_VERSION}, ${triple})"
        rm -rf "$tmp"
        return
      fi
      rm -rf "$tmp"
      warn "prebuilt cargo-binstall download/verify failed — falling back to cargo install"
    fi
  fi
  if cargo install --locked cargo-binstall >/dev/null 2>&1; then
    ok "cargo-binstall (cargo install)"
  else
    warn "cargo-binstall unavailable — remaining cargo tools will compile from source (slow)"
  fi
}

# pinned_version_for <crate> — echoes the EXACT version this crate must
# install as, matching a version CI pins explicitly (today: sqruff, via
# `sqruff@0.38.0` in the `taiki-e/install-action` `tool:` lists of
# `.github/workflows/_validate.yml` and `scheduled-deep-checks.yml`; and,
# since #3742, prek/taplo-cli/typos-cli in the same lists). This is
# purely a DATA table — it does not itself install anything and is not
# consulted by `cargo_get`. A pinned crate's `cargo_get_pinned` call site
# (see sqruff's below) reads it and WINS outright: no "try latest, fall back
# to this on failure" (#3602), and no "skip because something is already on
# PATH" either (#3611 — that is exactly what `cargo_get`'s early return would
# do, which is why a pinned crate is never routed through `cargo_get` at
# all). If a pinned install fails, `cargo_get_pinned` warns rather than
# silently falling through to latest, because installing *something* that
# isn't the pin is not actually a fix for "local ran the wrong version" — it
# is the same bug with different arithmetic.
#
# prek is pinned for a DIFFERENT reason than the MSRV-skew concern behind
# sqruff's pin (#602): prek IS the hook runner, so there is no wrapper for it
# the way zizmor-hook.sh wraps zizmor with a runtime `--version` assertion —
# an unpinned prek just silently runs whatever `cargo_get` last fetched.
# #3742 hit this live: CI resolved a newer prek than any dev box had
# installed, and that newer prek enforces a YAML parser limit
# (`.github/zizmor.yml`'s comment-count cap) the older local prek does not —
# a green tree went red with no repo change, and the fix that passed locally
# still failed in CI, unreproducible by construction until the two matched.
#
# A plain `case` (not an associative array) so this stays bash-3.2/macOS
# compatible. Keep in lockstep with the `tool:` pins above — bumping one
# without the other reintroduces the exact drift this table exists to
# prevent (there is no automated cross-check of *installability*, only of
# the version strings agreeing — see scripts/check-prek-version-pin.mjs and
# its caveat).
pinned_version_for() {
  case "$1" in
    sqruff) echo "0.38.0" ;;
    prek) echo "0.3.8" ;;
    taplo-cli) echo "0.10.0" ;;
    typos-cli) echo "1.46.0" ;;
    *) echo "" ;;
  esac
}

# msrv_fallback_version_for <crate> — echoes a known-good OLDER version to
# retry SECOND, only after a real "install latest" attempt has already
# failed, when the crate's LATEST release outpaces this box's rustc (MSRV
# skew). Symptom (issue #2535, verified with sqruff 0.39.0 vs. rustc 1.95):
# both `cargo binstall -y <crate>` AND its from-source fallback fail
# identically with an MSRV error, because binstall's source fallback still
# targets the newest crates.io release. Pinning a slightly older version
# sidesteps it.
#
# This is NOT a substitute for `pinned_version_for` above and the two must
# not be confused (that confusion is how #3602 happened: this function used
# to be named `fallback_version_for` and carried sqruff's entry too, so the
# same table served both "install this first, it must match CI" and "retry
# this after latest fails" with opposite precedence under one name). A crate
# CI pins belongs in `pinned_version_for`, tried first, full stop — not
# here. This table is empty for every REAL crate today (sqruff moved to
# `pinned_version_for` above); it stays as the escape hatch for a FUTURE
# crate that has MSRV skew but no CI pin. A plain `case` (not an associative
# array) so this stays bash-3.2/macOS compatible.
msrv_fallback_version_for() {
  case "$1" in
    *) echo "" ;;
  esac
}

# cargo_get <crate> [binary] — install a Rust hook tool at LATEST (with an
# MSRV-skew fallback). Precedence:
#   1. Already on PATH: skip. "Some recent version" is fine here — that is
#      the whole point of this function, and exactly why it is the WRONG
#      function for a crate whose local/CI version agreement is itself the
#      property being bought (see cargo_get_pinned's docstring).
#   2. Not present: install latest (prebuilt via binstall, else from source).
#   3. Latest failed: `msrv_fallback_version_for`'s pinned-version retry, for
#      a crate with MSRV skew but no CI pin.
#
# Deliberately does NOT consult `pinned_version_for` (#3611): it used to,
# via a branch here that stopped at rule 1 for anything already installed —
# so a box that had already picked up a wrong sqruff via rule 1 never even
# reached the pin branch, the exact defect #3602's fix was meant to close.
# A crate with a CI pin is instead wired directly to `cargo_get_pinned` at
# its own call site (see sqruff below); `cargo_get` is never called for it.
# Do not re-add a pin branch here — that is how the same bug comes back one
# layer up with a different shape.
cargo_get() {
  local crate="$1" bin="${2:-$1}" msrv_fallback
  if have "$bin"; then ok "$bin (already installed)"; return; fi

  msrv_fallback="$(msrv_fallback_version_for "$crate")"
  if have cargo-binstall; then
    if cargo binstall -y "$crate" >/dev/null 2>&1; then
      ok "$bin (binstall)"; return
    fi
    if [ -n "$msrv_fallback" ] && cargo binstall -y "${crate}@${msrv_fallback}" >/dev/null 2>&1; then
      ok "$bin (binstall ${msrv_fallback} — latest release exceeds this box's rustc)"; return
    fi
  fi
  if [ -n "$msrv_fallback" ] && cargo install --locked "${crate}@${msrv_fallback}" >/dev/null 2>&1; then
    ok "$bin (cargo install ${msrv_fallback} — pinned fallback)"; return
  fi
  if cargo install --locked "$crate" >/dev/null 2>&1; then
    ok "$bin (cargo install)"
  elif [ -n "$msrv_fallback" ]; then
    warn "could not install $crate — tried latest and pinned fallback ${msrv_fallback} — run: cargo install --locked ${crate}@${msrv_fallback}"
  else
    warn "could not install $crate — run: cargo install --locked $crate"
  fi
}

# cargo_get_pinned <crate> <version> [binary] — install an EXACT version, and
# REPLACE a differing one that is already on PATH.
#
# `cargo_get` returns early for any binary that exists, which is the right
# policy for tools where "some recent version" is fine. It is the wrong policy
# where local/CI version agreement is itself the property being bought
# (#3476): zizmor's audit SET changes between releases, so a box holding an
# older build silently gates pushes with fewer rules than CI applies. The
# version is read from the hook wrapper so this script cannot drift from the
# constant the wrapper asserts against.
# <version-awk> lets a caller share the EXACT field-extraction its own
# `--version` assertion uses (see zizmor's ZIZMOR_VERSION_AWK below) instead
# of this function guessing its own — two independent awk programs parsing
# the same `<tool> --version` line is how #3545 happened: they agreed until
# the output grew a trailing token, then one stayed silent while the other
# decided the version didn't match and reinstalled on every run. Defaults to
# `$NF` (last field) for any future caller that has no shared extraction to
# pass.
cargo_get_pinned() {
  local crate="$1" version="$2" bin="${3:-$1}" field="${4-}" current=""
  # NOT `${4:-NR == 1 { print $NF }}`: bash ends `${param:-word}` at the first
  # unquoted `}` — a bare `{` does not increment the nesting count, only `${`
  # does. That form parses as the expansion up to the first `}` plus a LITERAL
  # trailing `}`, so a supplied $4 becomes `<field>}` and awk dies of a syntax
  # error. Its stderr is not redirected below, `current` comes back empty, the
  # version comparison fails, and the crate reinstalls on every run — which is
  # the exact failure this file was being changed to prevent (#3545).
  [ -n "$field" ] || field='NR == 1 { print $NF }'
  if [ -z "$version" ]; then
    warn "no pinned version found for $crate — falling back to an unpinned install"
    cargo_get "$crate" "$bin"
    return
  fi
  if have "$bin"; then
    current="$("$bin" --version 2>/dev/null | awk "$field")"
    if [ "$current" = "$version" ]; then ok "$bin $version (already installed)"; return; fi
    note "$bin ${current:-unknown} differs from the pinned $version — reinstalling"
  fi
  if have cargo-binstall && cargo binstall -y "${crate}@${version}" >/dev/null 2>&1; then
    ok "$bin $version (binstall)"; return
  fi
  # zizmor also ships prebuilt wheels on PyPI. Try that before a source
  # build: binstall fails in seconds when a proxy blocks its GitHub lookup,
  # but `cargo install` compiles for minutes before an MSRV mismatch kills it.
  if [ "$crate" = zizmor ] && have python3 \
    && python3 -m pip install --user --quiet "zizmor==${version}" >/dev/null 2>&1; then
    local wheel_bin
    wheel_bin="$(python3 -m site --user-base)/bin/zizmor"
    if [ -x "$wheel_bin" ] && mkdir -p "$HOME/.cargo/bin" \
      && ln -sf "$wheel_bin" "$HOME/.cargo/bin/zizmor" && [ -x "$HOME/.cargo/bin/zizmor" ]; then
      ok "$bin $version (pip wheel, linked into ~/.cargo/bin)"; return
    fi
  fi
  if cargo install --locked "${crate}@${version}" >/dev/null 2>&1; then
    ok "$bin $version (cargo install)"; return
  fi
  warn "could not install ${crate}@${version} — run: cargo install --locked ${crate}@${version}"
}

# The pin lives in scripts/zizmor-hook.sh (single source of truth; the same
# version is pinned in the CI `tool:` lists, and the wrapper hard-fails a CI
# run whose binary disagrees).
ZIZMOR_PINNED_VERSION="$(
  sed -n 's/^ZIZMOR_PINNED_VERSION="\([^"]*\)".*/\1/p' \
    "$(dirname "$0")/zizmor-hook.sh" 2>/dev/null | head -n 1
)"

# Same source, same reason: the `zizmor --version` field extraction below
# must be the exact one zizmor-hook.sh's own assertion uses, or the two can
# silently diverge (#3545) the moment that output ever grows a trailing
# token.
ZIZMOR_VERSION_AWK="$(
  sed -n "s/^ZIZMOR_VERSION_AWK='\([^']*\)'.*/\1/p" \
    "$(dirname "$0")/zizmor-hook.sh" 2>/dev/null | head -n 1
)"
# Warn loudly and NAME the consequence — this does not abort. Rename the
# constant, move the file or break the pattern and this comes back empty,
# `cargo_get_pinned` then applies its `$NF` default (see the `[ -n "$field" ]`
# line above), and the two parsers are silently back to the `$NF` vs. `$2`
# split #3545 exists to prevent. Warning rather than exiting is deliberate and
# matches this script's contract (see the header): it is best-effort, has no
# `set -e`, runs from session/VM bootstrap, and must never sink the whole
# provisioning flow over one tool — the same reason `cargo_get_pinned` warns
# and installs unpinned when ZIZMOR_PINNED_VERSION comes back empty. A
# degraded zizmor pin is a slow reinstall-every-run, not a broken box; a hard
# exit here is taken BEFORE every installer below, so it would take the other
# fourteen hook binaries down with it — HOOK_BINS names fourteen and sqlx-cli
# is checked separately, so fifteen in all, of which zizmor is one; none of
# the cargo tools, shellcheck, go or python3 would be reached. The guard below
# is the runtime notice (#3545, finding 1).
if [ -z "$ZIZMOR_VERSION_AWK" ]; then
  warn "could not source ZIZMOR_VERSION_AWK from zizmor-hook.sh — falling back to cargo_get_pinned's \$NF default, which can disagree with the wrapper's \$2 and reinstall zizmor on every run (#3545)"
fi

# `sqruff --version` prints `sqruff 0.38.0` — unlike zizmor, no separate
# hook wrapper owns a competing version assertion for sqruff to drift
# against (prek.toml's sqruff hook shells out to `sqruff lint` directly,
# with no version check of its own), so there is no second file to source
# this from. Spelled out explicitly anyway, rather than left to
# `cargo_get_pinned`'s `$NF` default, so the extraction sits next to the
# call site that uses it and stays visible if that output ever grows a
# trailing token the way zizmor's did (#3545).
SQRUFF_VERSION_AWK='NR == 1 { print $2 }'

# `prek --version` / `taplo --version` / `typos --version` all print
# `<name> <version>` on one line, same shape as sqruff (#3742). prek has no
# wrapper of its own to source this from — it IS the hook runner, there is
# nothing standing between it and the developer's shell the way
# zizmor-hook.sh stands in front of zizmor — so scripts/check-prek-version-pin.mjs
# reads this constant directly out of this file instead.
PREK_VERSION_AWK='NR == 1 { print $2 }'
TAPLO_VERSION_AWK='NR == 1 { print $2 }'
TYPOS_VERSION_AWK='NR == 1 { print $2 }'

# lychee is a heavy crate that cargo-binstall can't fetch prebuilt (it falls
# back to a slow from-source compile), so — exactly like CI — pull the official
# prebuilt release tarball instead. macOS prefers brew.
#
# Egress-proxy hardening (issue #2535, verified live): some remote-container
# sessions' proxy 403s the GitHub release-tarball download below (only
# crates.io + cargo-binstall's own source are allowed through), and the
# warning used to scroll past unnoticed until a later `git push` hard-failed
# on the missing `lychee` hook. If the tarball download fails for ANY reason
# — proxy 403, network, layout change — fall back to `cargo binstall`
# (crates.io, reachable), then `cargo install --locked` (slow from-source
# compile) as the last resort, instead of just warning and stopping.
install_lychee() {
  if have lychee; then ok "lychee (already installed)"; return; fi
  if [ "$OS" = "Darwin" ] && have brew && brew install lychee >/dev/null 2>&1; then
    ok "lychee (brew)"; return
  fi
  local arch triple
  arch="$(uname -m)"
  case "$OS-$arch" in
    Linux-x86_64)               triple=x86_64-unknown-linux-gnu ;;
    Linux-aarch64|Linux-arm64)  triple=aarch64-unknown-linux-gnu ;;
    Darwin-x86_64)              triple=x86_64-apple-darwin ;;
    Darwin-arm64|Darwin-aarch64) triple=aarch64-apple-darwin ;;
    *) triple="" ;;
  esac
  if [ -n "$triple" ]; then
    local url="https://github.com/lycheeverse/lychee/releases/latest/download/lychee-${triple}.tar.gz"
    mkdir -p "$HOME/.local/bin"
    # Extract to a temp dir and FIND the binary rather than hard-coding its
    # path: recent release tarballs nest it under `lychee-<triple>/lychee`,
    # older ones under `<triple>/lychee`, and pinning one layout silently
    # broke the install when upstream changed it (the curl|tar just found no
    # such member and the hook went missing). `find` is layout- and portable
    # across GNU/bsd tar.
    local tmp bin=""
    tmp="$(mktemp -d)"
    # Same guard, same reasoning as ensure_cargo_binstall above (#3622): a
    # failed `mktemp -d` leaves $tmp empty and neither `set -u` nor (absent)
    # `set -e` stops the script. Here nothing is written at the filesystem
    # root — `tar -C ""` fails first — but the resulting "prebuilt lychee
    # tarball unreachable (proxy/network)" is a lie about the cause, and
    # `rm -rf ""` cleans nothing. Fail with the real reason instead.
    if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then
      warn "mktemp -d failed (no writable temp dir?) — skipping the prebuilt lychee download, falling back to cargo binstall"
    else
      if curl -fsSL "$url" | tar -xz -C "$tmp" >/dev/null 2>&1; then
        bin="$(find "$tmp" -type f -name lychee 2>/dev/null | head -1)"
      fi
      if [ -n "$bin" ] && install -m 0755 "$bin" "$HOME/.local/bin/lychee" 2>/dev/null; then
        ok "lychee (prebuilt $triple)"
        rm -rf "$tmp"
        return
      fi
      rm -rf "$tmp"
      warn "prebuilt lychee tarball unreachable (proxy/network) — falling back to cargo binstall"
    fi
  else
    warn "no prebuilt lychee tarball for $OS-$arch — falling back to cargo binstall"
  fi
  if have cargo && have cargo-binstall && cargo binstall -y lychee >/dev/null 2>&1; then
    ok "lychee (binstall fallback)"; return
  fi
  if have cargo && cargo install --locked lychee >/dev/null 2>&1; then
    ok "lychee (cargo install fallback, slow from-source build)"; return
  fi
  warn "could not install lychee (prebuilt tarball and cargo fallbacks all failed) — install manually (https://github.com/lycheeverse/lychee/releases)"
}

# sqlx-cli needs custom features (rustls + sqlite only) — same as CI.
install_sqlx_cli() {
  # sqlx-cli ships both `cargo-sqlx` and `sqlx`; check either so the skip fires.
  if have cargo-sqlx || have sqlx; then ok "sqlx-cli (already installed)"; return; fi
  if have cargo-binstall && cargo binstall -y sqlx-cli >/dev/null 2>&1; then
    ok "sqlx-cli (binstall)"; return
  fi
  if cargo install --locked sqlx-cli --no-default-features --features rustls,sqlite >/dev/null 2>&1; then
    ok "sqlx-cli (cargo install)"
  else
    warn "install sqlx-cli manually: cargo install --locked sqlx-cli --no-default-features --features rustls,sqlite"
  fi
}

echo "Setting up the prek hook toolchain (OS: $OS)…"

# --- Rust hook tools -------------------------------------------------------
if ! have cargo; then
  warn "Rust/cargo not found — install via https://rustup.rs, then re-run."
  warn "Skipping the cargo-based tools (prek, cargo-deny, sqlx-cli, …)."
else
  ensure_cargo_binstall
  # prek/taplo-cli/typos-cli pinned (#3742), same shape as sqruff: CI pins
  # these in its `tool:` lists, so an unpinned local install can silently
  # run a different version than CI — as it did live, when a newer prek
  # enforced a YAML limit the locally-installed 0.3.8 did not.
  cargo_get_pinned prek "$(pinned_version_for prek)" prek "$PREK_VERSION_AWK"
  cargo_get cargo-deny
  cargo_get cargo-machete
  cargo_get cargo-audit
  cargo_get_pinned sqruff "$(pinned_version_for sqruff)" sqruff "$SQRUFF_VERSION_AWK"
  cargo_get_pinned typos-cli "$(pinned_version_for typos-cli)" typos "$TYPOS_VERSION_AWK"
  cargo_get_pinned zizmor "$ZIZMOR_PINNED_VERSION" zizmor "$ZIZMOR_VERSION_AWK"
  cargo_get_pinned taplo-cli "$(pinned_version_for taplo-cli)" taplo "$TAPLO_VERSION_AWK"
  cargo_get cargo-nextest cargo-nextest
  cargo_get just
  install_lychee
  install_sqlx_cli
fi

# --- System hook tools -----------------------------------------------------
# The ShellCheck hook calls the system `shellcheck` binary directly.
pkg_install shellcheck shellcheck shellcheck

# go: prek BUILDS the `gitleaks` and `actionlint` hooks from their pinned
# upstream repos via its Go backend, so the box needs a Go toolchain (the
# hooks do NOT use a system gitleaks/actionlint binary — which is also why
# `actionlint` isn't in apt). On macOS the brew package is `go`; on Debian/
# Ubuntu it is `golang-go`.
if have go; then ok "go (already installed)"; else pkg_install go golang-go go; fi

# python3: prek runs the `conventional-pre-commit` (commit-msg) hook via its
# Python backend. Present by default on Ubuntu and macOS; install if missing.
if have python3; then ok "python3 (already installed)"; else pkg_install python3 python3 python3; fi

# Frontend hook tools (oxlint, oxfmt, knip, markdownlint-cli2) ship as npm
# devDependencies — `scripts/setup.sh` already ran `npm ci`, so they are on
# PATH via node_modules/.bin and need nothing here.

# --- Pre-provision, then conditionally wire the git hooks ------------------
# Order matters. The `gitleaks` / `actionlint` / `conventional-pre-commit`
# hooks are CLONED+built from github.com by prek. On a network-scoped box (e.g.
# a Claude web VM whose git access is limited to this repo), those clones 403 —
# and if we wire prek's git hooks anyway, EVERY `git commit` then aborts trying
# to clone them. So: provision first; only wire the hooks if provisioning
# succeeds. When it can't, leave the hooks unwired (commits keep working; those
# three checks still run in CI) and tell the user how to wire them later.
if have prek; then
  note "pre-provisioning hook environments…"
  if prek install-hooks >/dev/null 2>&1; then
    ok "all hook environments provisioned"
    if prek install >/dev/null 2>&1; then ok "git hooks wired (prek install)"
    else warn "prek install failed — run it manually: prek install"; fi
  else
    warn "upstream hook repos (gitleaks/actionlint/conventional-pre-commit) are unreachable —"
    warn "git access looks scoped to this repo. Leaving git hooks UNWIRED so commits keep"
    warn "working (those three checks still run in CI). Once github.com clones are allowed,"
    warn "run: prek install   — or skip just those hooks: SKIP=gitleaks,actionlint,conventional-pre-commit git commit …"
  fi
else
  warn "prek not on PATH — install it, then run: prek install"
fi

# --- Summary: make gaps loud, without failing the bootstrap ----------------
# This script deliberately never exits non-zero (`set -uo pipefail`, no
# `set -e` — see header): it can run from session/VM bootstrap, where a
# non-zero exit here would abort the whole provisioning flow over one
# optional hook tool. A silently-missing binary is exactly the failure mode
# issue #2535 was filed over (a proxy 403 scrolled past as a `warn` and only
# surfaced later as a hard-failed push), so instead of relying on the exit
# code, print an impossible-to-miss `MISSING:` block naming every hook
# binary still absent after every installer + fallback above ran.
HOOK_BINS="prek cargo-deny cargo-machete cargo-audit sqruff typos zizmor taplo cargo-nextest just lychee shellcheck go python3"
missing=""
for bin in $HOOK_BINS; do
  have "$bin" || missing="$missing $bin"
done
# sqlx-cli ships two possible binary names (see install_sqlx_cli); check
# both before flagging it missing.
have cargo-sqlx || have sqlx || missing="$missing sqlx-cli"

echo
if [ -n "$missing" ]; then
  printf '\033[41;97;1m %s \033[0m\n' "MISSING: hook toolchain incomplete"
  warn "the following hook binaries are still not on PATH:"
  for bin in $missing; do
    warn "  - $bin"
  done
  warn "the matching prek hook(s) will fail until these are installed."
  warn "re-run scripts/setup-hooks.sh once network/package-manager access is fixed, or install manually."
else
  ok "all hook binaries present"
fi

echo "Hook toolchain setup complete (warnings above, if any, are non-fatal)."
