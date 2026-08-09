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
    # path can expand to `rm -rf ""` (the same guard --self-test carries
    # since #3621).
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
# `.github/workflows/_validate.yml` and `scheduled-deep-checks.yml`). This is
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
# A plain `case` (not an associative array) so this stays bash-3.2/macOS
# compatible. Keep in lockstep with the `tool:` pins above — bumping one
# without the other reintroduces the exact drift this table exists to
# prevent (there is no automated cross-check of *installability*, only of
# the version strings agreeing — see the `--self-test` cross-check below and
# its caveat).
pinned_version_for() {
  case "$1" in
    sqruff) echo "0.38.0" ;;
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
    # TEST-ONLY: never a real crate `cargo_get` installs in production —
    # exercised by --self-test's Test 2b below so `cargo_get`'s
    # `[ -n "$msrv_fallback" ]` branches don't silently rot now that this
    # table is empty in production (an empty table is otherwise a plausible
    # end state, not a bug, so nothing else would ever redden if these
    # branches broke).
    selftest-msrv-fallback-crate) echo "9.9.9" ;;
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
# the cargo tools, shellcheck, go or python3 would be reached. The cost of the
# warning being missed is bounded because scripts/zizmor-hook.sh --self-test
# executes THIS statement and reddens on it (#3545, finding 1) — the guard
# below is the runtime notice, that self-test is the enforcement.
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

# ── self-test (#3602, #3611) ─────────────────────────────────────────────
# Falsifiable coverage for the sqruff pin's actual reach, in three parts:
#   Test 1  — cargo_get_pinned requests the pinned version FIRST, never
#             "latest" first (the original #3602 bug).
#   Test 1b — cargo_get_pinned detects and REPLACES a wrong version already
#             on PATH, rather than accepting it as "already installed" (the
#             #3611 bug: `cargo_get`'s early return skipped its old pin
#             branch entirely for any box that already had SOME sqruff —
#             exactly the population #3602's fix was meant to cover).
#   Test 1c — the real call site actually routes sqruff through
#             `cargo_get_pinned`, not `cargo_get`. Test 1b alone can't catch
#             a regression back to `cargo_get sqruff`: it calls
#             `cargo_get_pinned` directly, so it stays green even if the
#             call site stops using it.
#   Test 2b — `cargo_get`'s own MSRV-fallback retry (a table that is empty
#             for every real crate now that sqruff moved off it) still
#             works, via a TEST-ONLY table entry.
# Stubs `cargo` / `cargo-binstall` on an isolated PATH — no network, no real
# installs, no repo mutation. Wired as the `setup-hooks-selftest` prek hook
# (mirrors the established `push.sh --self-test` /
# `verify-ci-equivalent.sh --self-test` convention) so a regression in any of
# these reddens instead of silently re-diverging.
if [ "${1:-}" = "--self-test" ]; then
  st_fail=0
  st_ok() { printf '  ok   - %s\n' "$1"; }
  st_bad() { printf '  FAIL - %s: %s\n' "$1" "$2" >&2; st_fail=1; }

  stub_dir="$(mktemp -d -t setup-hooks-selftest.XXXXXX)"
  # This script runs under `set -u` but deliberately NOT `set -e` (see the
  # header), so a failed `mktemp -d` does not abort — it leaves $stub_dir
  # empty, and every "$stub_dir/<name>" below then resolves to "/<name>". The
  # self-test would try to write /cargo, /cargo-binstall and /sqruff at the
  # filesystem ROOT, and the `rm -rf "$stub_dir"` cleanup would expand to
  # `rm -rf ""` and clean up nothing. Bail out loudly instead — and BEFORE
  # arming the EXIT trap, so the trap can never fire with an empty $stub_dir
  # (#3619).
  if [ -z "$stub_dir" ] || [ ! -d "$stub_dir" ]; then
    echo "setup-hooks.sh self-test: mktemp -d failed (no writable temp dir?) — refusing to run" >&2
    echo "setup-hooks.sh self-test FAILED" >&2
    exit 2
  fi
  trap 'rm -rf "$stub_dir"' EXIT

  # Fake `cargo-binstall` — only needs to EXIST on PATH so `have
  # cargo-binstall` succeeds; cargo_get/cargo_get_pinned then shell out to
  # `cargo binstall …`, not to this file directly.
  cat >"$stub_dir/cargo-binstall" <<'FAKEBINSTALL'
#!/usr/bin/env bash
exit 0
FAKEBINSTALL
  chmod +x "$stub_dir/cargo-binstall"

  # Fake `cargo` — logs every `binstall`/`install` request it receives, one
  # line per request IN ORDER, to $REQUEST_LOG, and SUCCEEDS for everything
  # except one deliberate exception. Both the bare ("latest") and pinned
  # requests succeed by default on purpose: the point of this stub is to
  # isolate INSTALL ORDER — which version cargo_get asks for FIRST — not
  # failure/retry handling. The one exception is `selftest-msrv-fallback-crate`
  # requested bare: it FAILS, so Test 2b below can exercise cargo_get's
  # otherwise-dead MSRV-fallback retry (that crate exists only in
  # msrv_fallback_version_for's TEST-ONLY entry — nothing else ever requests
  # it, so this exception cannot affect any other test's behavior).
  cat >"$stub_dir/cargo" <<'FAKECARGO'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$REQUEST_LOG"
case "$*" in
  "binstall -y selftest-msrv-fallback-crate") exit 1 ;;
esac
case "${1:-}" in
  binstall|install) exit 0 ;;
  *) echo "fake cargo: unhandled subcommand: $*" >&2; exit 99 ;;
esac
FAKECARGO
  chmod +x "$stub_dir/cargo"

  # Symlink the two real external tools this stub environment still needs
  # into $stub_dir, rather than falling back to a host directory like
  # /usr/bin:/bin, so `stub_path` is fully self-contained: no dependency on
  # which system dirs happen to exist or what they contain on this
  # particular host.
  #   - awk:  cargo_get_pinned's version-field extraction (Test 1b below)
  #           needs a real one.
  #   - bash: the fake cargo/cargo-binstall scripts above are executed via
  #           their `#!/usr/bin/env bash` shebang — that path is absolute so
  #           the kernel finds `env` directly, but `env` then resolves
  #           `bash` itself via a PATH lookup, so `bash` has to be ON this
  #           stub PATH too or every stub invocation fails to launch.
  for real_tool in awk bash; do
    if command -v "$real_tool" >/dev/null 2>&1; then
      ln -sf "$(command -v "$real_tool")" "$stub_dir/$real_tool"
    fi
  done

  # Deliberately excludes $HOME/.cargo/bin and $HOME/.local/bin (where a real
  # sqruff/prek would live if this box already has one) — only the stubs
  # above, so the test is deterministic regardless of what is actually
  # installed here.
  stub_path="$stub_dir"

  # The version every assertion below compares against, read from the pin
  # TABLE rather than repeated as a literal (#3623). The table is the single
  # source of truth the CI cross-check (Test 4/4b) already uses; spelling the
  # value out again here made bumping the pin redden a handful of tests that
  # are not about the value at all, which is exactly the kind of friction
  # that invites weakening an assertion instead of reading it. The value
  # itself is still anchored — by Test 4/4b, against CI's `tool:` lists.
  want_pin="$(pinned_version_for sqruff)"
  if [ -z "$want_pin" ]; then
    st_bad "pinned_version_for sqruff returns a version" "got an empty string — every sqruff assertion below is vacuous without it"
    echo "setup-hooks.sh self-test FAILED" >&2
    exit 2
  fi

  # ── Test 1 (the falsifiable core) ── a PINNED crate is requested at its
  # exact pinned version FIRST — never at "latest" first. Calls
  # `cargo_get_pinned` with the exact arguments the real call site below
  # passes — not `cargo_get`, which has no pin awareness at all (#3611).
  req_log="$stub_dir/requests.log"
  : >"$req_log"
  out="$(PATH="$stub_path" REQUEST_LOG="$req_log" cargo_get_pinned sqruff "$want_pin" sqruff "$SQRUFF_VERSION_AWK" 2>&1)"
  first_req="$(head -n1 "$req_log" 2>/dev/null || true)"
  if [ "$first_req" = "binstall -y sqruff@$want_pin" ]; then
    st_ok "cargo_get_pinned sqruff requests the PINNED version first (pinned_version_for says $want_pin)"
  else
    st_bad "cargo_get_pinned sqruff requests the PINNED version first (pinned_version_for says $want_pin)" \
      "first cargo request was '${first_req:-<none>}', wanted 'binstall -y sqruff@$want_pin' — full log: $(tr '\n' ';' <"$req_log" 2>/dev/null)"
  fi
  case "$out" in
    *"$want_pin"*) st_ok "cargo_get_pinned sqruff's own report names the pinned version ($want_pin)" ;;
    *) st_bad "cargo_get_pinned sqruff's own report names the pinned version ($want_pin)" "output was: $out" ;;
  esac
  # A bare/unversioned request IS "latest" — the exact thing #3602 forbids
  # for a pinned crate. It must never appear in the log at all.
  if grep -qxF 'binstall -y sqruff' "$req_log" 2>/dev/null; then
    st_bad "cargo_get_pinned sqruff never requests the bare (latest) version" \
      "found an unversioned 'binstall -y sqruff' request — full log: $(tr '\n' ';' <"$req_log")"
  else
    st_ok "cargo_get_pinned sqruff never requests the bare (latest) version"
  fi

  # ── Test 2 ── an UNPINNED crate is unaffected: still tries latest first,
  # exactly as before — the fix must not change this path at all.
  req_log2="$stub_dir/requests2.log"
  : >"$req_log2"
  out2="$(PATH="$stub_path" REQUEST_LOG="$req_log2" cargo_get prek 2>&1)"
  first_req2="$(head -n1 "$req_log2" 2>/dev/null || true)"
  if [ "$first_req2" = "binstall -y prek" ]; then
    st_ok "cargo_get prek (unpinned) still requests latest first, unaffected by the sqruff pin"
  else
    st_bad "cargo_get prek (unpinned) still requests latest first, unaffected by the sqruff pin" \
      "first cargo request was '${first_req2:-<none>}'"
  fi
  case "$out2" in
    *"(binstall)"*) st_ok "cargo_get prek's own report names a plain (latest) install" ;;
    *) st_bad "cargo_get prek's own report names a plain (latest) install" "output was: $out2" ;;
  esac

  # ── Test 2b (MSRV-fallback coverage) ── `msrv_fallback_version_for` is
  # empty for every REAL crate today, so `cargo_get`'s
  # `[ -n "$msrv_fallback" ]` retry branches are otherwise dead and
  # uncovered — an empty table is a plausible, correct end state, so nothing
  # would ever redden if one of those branches broke. `selftest-msrv-fallback-crate`
  # is a TEST-ONLY entry in that table (never installed in production); the
  # fake cargo above fails its bare/latest request and succeeds its
  # `@9.9.9` retry, exercising the binstall MSRV-fallback success path.
  req_log2b="$stub_dir/requests2b.log"
  : >"$req_log2b"
  out2b="$(PATH="$stub_path" REQUEST_LOG="$req_log2b" cargo_get selftest-msrv-fallback-crate 2>&1)"
  if grep -qxF 'binstall -y selftest-msrv-fallback-crate@9.9.9' "$req_log2b" 2>/dev/null; then
    st_ok "cargo_get retries at the MSRV fallback version after the latest binstall request fails"
  else
    st_bad "cargo_get retries at the MSRV fallback version after the latest binstall request fails" \
      "expected a 'binstall -y selftest-msrv-fallback-crate@9.9.9' retry after the bare request failed — full log: $(tr '\n' ';' <"$req_log2b" 2>/dev/null || echo '<none>')"
  fi
  case "$out2b" in
    *"9.9.9"*"exceeds this box's rustc"*) st_ok "cargo_get's MSRV-fallback success report names the fallback version and the reason" ;;
    *) st_bad "cargo_get's MSRV-fallback success report names the fallback version and the reason" "output was: $out2b" ;;
  esac

  # ── Test 1b (#3611 finding 1) ── a WRONG version of sqruff ALREADY on
  # PATH must be DETECTED and REINSTALLED at the pin, not accepted as
  # "already installed". Test 1 above starts from a PATH with no sqruff at
  # all, so `have sqruff` is false there and never exercises the
  # already-installed case that actually caused the divergence: on any box
  # that already ran this script once and picked up a newer sqruff, `have
  # sqruff` is TRUE (#3602 was filed on exactly that population). This is
  # `cargo_get_pinned`'s own job — it already did this correctly for zizmor
  # before this PR — so this guards its correctness in isolation; Test 1c
  # below guards the other half, that sqruff's call site actually reaches
  # this function at all. Stub a sqruff binary that reports a version other
  # than the pin — `0.0.0-selftest-wrong`, which no real release can ever
  # carry, so this stays a wrong version no matter what the pin is bumped to
  # (#3623: nothing here may hardcode the pinned value).
  wrong_pin="0.0.0-selftest-wrong"
  cat >"$stub_dir/sqruff" <<FAKESQRUFF
#!/usr/bin/env bash
echo "sqruff $wrong_pin"
FAKESQRUFF
  chmod +x "$stub_dir/sqruff"

  req_log3="$stub_dir/requests3.log"
  : >"$req_log3"
  out3="$(PATH="$stub_path" REQUEST_LOG="$req_log3" cargo_get_pinned sqruff "$want_pin" sqruff "$SQRUFF_VERSION_AWK" 2>&1)"
  if grep -qxF "binstall -y sqruff@$want_pin" "$req_log3" 2>/dev/null; then
    st_ok "cargo_get_pinned sqruff detects a wrong version already on PATH and reinstalls at the pin"
  else
    st_bad "cargo_get_pinned sqruff detects a wrong version already on PATH and reinstalls at the pin" \
      "wrong-version sqruff $wrong_pin stub was on PATH — expected a 'binstall -y sqruff@$want_pin' reinstall request, got: $(tr '\n' ';' <"$req_log3" 2>/dev/null || echo '<none>') (output: $out3)"
  fi

  # ── Test 1c (#3611 finding 1, the actual wiring) ── Test 1b above proves
  # `cargo_get_pinned` ITSELF handles a wrong version correctly — it already
  # did, for zizmor, before this PR. It proves nothing about whether
  # sqruff's call site actually USES it: reverting the call site back to
  # `cargo_get sqruff` (the exact regression this PR fixes) would leave
  # Test 1b green while the real script silently regressed, because Test 1b
  # calls `cargo_get_pinned` directly and never looks at the call site.
  # Assert the call-site text itself, the same way zizmor-hook.sh's own
  # self-test guards its `cargo_get_pinned zizmor …` wiring line. Scoped to
  # the PRODUCTION portion of the file, from the "Setting up the prek hook
  # toolchain" banner onward — this test's own grep pattern is that exact
  # literal string, and it lives (like the rest of --self-test) ABOVE that
  # banner, so searching the whole file ($0) would always match its own
  # source line regardless of what the real call site says.
  #
  # A `case` on a captured string, NOT `awk … | grep -qF`: this script runs
  # under `set -o pipefail`, `grep -q` exits the instant it matches, and awk
  # is then killed by SIGPIPE while still writing the rest of the production
  # section — so the pipeline returned 141 and this assertion FAILED
  # spuriously on roughly 1 run in 15 (measured: 3/40 on HEAD before this
  # change, and this hook runs at pre-commit). Whether awk finishes writing
  # before grep exits is pure scheduling luck, which is not something a guard
  # may depend on. Found while measuring #3623.
  call_site_region="$(awk '/^echo "Setting up the prek hook toolchain/{p=1} p' "$0")"
  call_site_needle='cargo_get_pinned sqruff "$(pinned_version_for sqruff)" sqruff "$SQRUFF_VERSION_AWK"'
  if [ "$call_site_region" != "${call_site_region#*"$call_site_needle"}" ]; then
    st_ok "setup-hooks.sh's sqruff call site is wired through cargo_get_pinned, not cargo_get"
  else
    st_bad "setup-hooks.sh's sqruff call site is wired through cargo_get_pinned, not cargo_get" \
      "expected the literal line cargo_get_pinned sqruff \"\$(pinned_version_for sqruff)\" sqruff \"\$SQRUFF_VERSION_AWK\" above the --self-test guard in $0"
  fi

  # ── Test 3 ── the pin/fallback tables carry sqruff under the right NAME:
  # a hard pin (pinned_version_for), no longer an MSRV-skew fallback
  # (msrv_fallback_version_for) — the name/precedence mismatch is how #3602
  # happened in the first place. Asserts the SHAPE, not the value (#3623):
  # sqruff must be in the pin table with a version-looking entry. The value
  # itself is anchored by Test 4/4b against CI's `tool:` lists, which is the
  # only comparison that can catch real drift — repeating the literal here as
  # well only meant a legitimate pin bump reddened a test about table
  # membership.
  case "$want_pin" in
    [0-9]*.[0-9]*) st_ok "pinned_version_for sqruff is a hard pin ($want_pin)" ;;
    *) st_bad "pinned_version_for sqruff is a hard pin" "got '$want_pin', which is not a version" ;;
  esac
  if [ -z "$(msrv_fallback_version_for sqruff)" ]; then
    st_ok "msrv_fallback_version_for sqruff is empty — sqruff moved to the pin table, not the MSRV-skew table"
  else
    st_bad "msrv_fallback_version_for sqruff is empty — sqruff moved to the pin table, not the MSRV-skew table" \
      "got '$(msrv_fallback_version_for sqruff)'"
  fi

  # ── Test 4 (cross-check; note the #3564-shaped caveat) ── the local pin
  # and CI's pin NAME the same version. This proves the two paths agree on
  # what version they MEAN — it does NOT prove either can actually OBTAIN
  # it; that gap is precisely what #3564 showed a name-only guard leaves
  # open. Test 1 above is what actually exercises install behavior.
  #
  # EVERY `sqruff@` occurrence is checked, not just the first (#3619). This
  # used to `head -n1`, and scheduled-deep-checks.yml carries TWO pins (its
  # lint job and its scheduled re-run install the same tool list): drift in
  # the second one was structurally invisible, so the guard read one of two
  # values and reported agreement while the two disagreed — the failure mode
  # a cross-check exists to make impossible.
  #
  # The expected COUNT per file is asserted too, for the same reason. Without
  # it, "check them all" still under-covers the day a third `tool:` list is
  # added to one of these files: the new pin would be read, but a pin DELETED
  # from a list nobody re-reads would just silently shrink the check. Making
  # the count explicit means adding or removing a pin reddens here and forces
  # whoever did it to look at this list.
  #
  # The per-file counts are only half of it, though: this loop reads a FIXED
  # list of files, so on its own it is another instance of the very defect it
  # exists to prevent — a check that reads a subset and reports agreement. A
  # `sqruff@` pin landing in a THIRD file (a new workflow, or one of the
  # composite actions under .github/actions) is read by nobody here while
  # every per-file assertion still prints ok. Test 4b below closes that by
  # sweeping all of .github/ (#3619).
  #
  # Note this hook's `files` pattern in prek.toml matches all of .github/ as
  # well as this script, i.e. exactly what Test 4b below reads — a cross-check
  # scoped only to the file it lives in never fires on the other side of the
  # comparison (#3619). If you narrow either one, narrow both.
  repo_root="$(cd "$(dirname "$0")/.." && pwd)"

  # sqruff_pins <file>… — emit `<path>:<lineno>:sqruff@<version>` for every
  # pin in the named files. ONE extractor for both Test 4 (per-file) and Test
  # 4b (repo-wide) so the two can never disagree about what counts as a pin.
  #
  # Whole-line comments are skipped (#3623). The regex this replaces matched
  # `sqruff@<version>` anywhere, including inside a YAML comment, so a
  # commented-out pin — the normal way to park a version while testing a bump
  # — counted toward the per-file and repo-wide COUNT assertions and reddened
  # a file where nothing had drifted. Fail-safe (it broke loudly rather than
  # passing silently), which is why this waited for a real report; a comment
  # is not a pin and must not be counted as one. Deliberately minimal: only a
  # line that is ENTIRELY a comment is skipped, so a trailing `# sqruff@x.y.z`
  # note beside a live pin is still read, and no live pin can hide behind a
  # `#` this loop chose to ignore.
  sqruff_pins() {
    awk '
      /^[[:space:]]*#/ { next }
      {
        rest = $0
        while (match(rest, /sqruff@[0-9][^,[:space:]"]*/)) {
          printf "%s:%d:%s\n", FILENAME, FNR, substr(rest, RSTART, RLENGTH)
          rest = substr(rest, RSTART + RLENGTH)
        }
      }
    ' "$@"
  }

  # Falsifiable coverage for that skip, since no file in this repo currently
  # carries a commented-out pin: a fixture with one live pin and one
  # commented-out pin must yield exactly ONE hit, at the live line.
  pin_fixture="$stub_dir/pin-fixture.yml"
  {
    printf '        tool: taplo-cli,sqruff@%s\n' "$want_pin"
    printf '        # tool: taplo-cli,sqruff@0.31.0   (parked while testing)\n'
    printf '    #tool: sqruff@0.32.0\n'
  } >"$pin_fixture"
  fixture_hits="$(sqruff_pins "$pin_fixture" | wc -l | tr -d ' ')"
  if [ "$fixture_hits" = "1" ]; then
    st_ok "sqruff pin extraction ignores commented-out pins (1 live pin, 2 commented)"
  else
    st_bad "sqruff pin extraction ignores commented-out pins (1 live pin, 2 commented)" \
      "expected 1 hit, got $fixture_hits: $(sqruff_pins "$pin_fixture" | tr '\n' ';')"
  fi

  # Summed from the per-file spec below so there is ONE list to update, not
  # two that can drift apart.
  want_total=0
  # "<workflow path>:<number of sqruff@ pins that file is expected to carry>"
  for wf_spec in \
    ".github/workflows/_validate.yml:1" \
    ".github/workflows/scheduled-deep-checks.yml:2"; do
    wf="${wf_spec%:*}"
    want_count="${wf_spec##*:}"
    want_total=$((want_total + want_count))
    wf_path="$repo_root/$wf"
    if [ ! -f "$wf_path" ]; then
      st_bad "sqruff pin cross-check: $wf exists" "file not found at $wf_path"
      continue
    fi
    # Line numbers are carried through (not just the versions) so a mismatch
    # report NAMES the offending line — with several pins per file, "CI says
    # 0.99.0" alone would not say which. Each hit reads
    # `<path>:<lineno>:sqruff@<version>`.
    ci_hits="$(sqruff_pins "$wf_path" || true)"
    pin_count=0
    seen_pins=""
    bad_pins=""
    while IFS= read -r hit; do
      [ -n "$hit" ] || continue
      pin_count=$((pin_count + 1))
      hit_line="${hit#*:}"
      hit_line="${hit_line%%:*}"
      hit_ver="${hit##*@}"
      seen_pins="$seen_pins line $hit_line=$hit_ver;"
      if [ "$hit_ver" != "$want_pin" ]; then
        bad_pins="$bad_pins line $hit_line pins $hit_ver;"
      fi
    done <<<"$ci_hits"

    if [ "$pin_count" -eq 0 ]; then
      st_bad "sqruff pin cross-check: $wf pins a sqruff version" "no 'sqruff@<version>' found in $wf"
      continue
    fi

    if [ "$pin_count" -eq "$want_count" ]; then
      st_ok "sqruff pin cross-check: $wf carries exactly $want_count sqruff@ pin(s)"
    else
      st_bad "sqruff pin cross-check: $wf carries exactly $want_count sqruff@ pin(s)" \
        "found $pin_count —$seen_pins a sqruff@ pin was added or removed; update this test's expected count for $wf so the new pin is cross-checked too"
    fi

    if [ -z "$bad_pins" ]; then
      st_ok "sqruff pin cross-check: all $pin_count sqruff@ pin(s) in $wf match pinned_version_for's $want_pin"
    else
      st_bad "sqruff pin cross-check: all $pin_count sqruff@ pin(s) in $wf match pinned_version_for's $want_pin" \
        "scripts/setup-hooks.sh says $want_pin; CI disagrees at:$bad_pins"
    fi
  done

  # ── Test 4b (same cross-check, at FILE granularity) ── everything above
  # trusts the hardcoded file list to be complete. This does not: it counts
  # and version-checks every `sqruff@` pin anywhere under .github/, so a pin
  # added to a file the list does not name reddens instead of passing
  # unexamined. Run from $repo_root so the reported paths are repo-relative.
  # Each hit reads `<path>:<lineno>:sqruff@<version>`. `grep -rl` only picks
  # the CANDIDATE files (anything mentioning the string at all, comments
  # included); sqruff_pins above is what decides which mentions are pins.
  pin_files=()
  while IFS= read -r pin_file; do
    [ -n "$pin_file" ] && pin_files+=("$pin_file")
  done < <(cd "$repo_root" && grep -rlE 'sqruff@[0-9]' .github 2>/dev/null || true)
  all_hits=""
  if [ "${#pin_files[@]}" -gt 0 ]; then
    all_hits="$(cd "$repo_root" && sqruff_pins "${pin_files[@]}" || true)"
  fi
  total_count=0
  all_seen=""
  all_bad=""
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    total_count=$((total_count + 1))
    hit_where="${hit%:sqruff@*}"
    hit_ver="${hit##*:sqruff@}"
    all_seen="$all_seen $hit_where=$hit_ver;"
    if [ "$hit_ver" != "$want_pin" ]; then
      all_bad="$all_bad $hit_where pins $hit_ver;"
    fi
  done <<<"$all_hits"

  if [ "$total_count" -eq "$want_total" ]; then
    st_ok "sqruff pin cross-check: .github carries exactly $want_total sqruff@ pin(s) in total"
  else
    st_bad "sqruff pin cross-check: .github carries exactly $want_total sqruff@ pin(s) in total" \
      "found $total_count —$all_seen a sqruff@ pin was added or removed, possibly in a file the per-file list above does not name; add that file to the list so its pins are cross-checked too"
  fi

  if [ -z "$all_bad" ]; then
    st_ok "sqruff pin cross-check: every sqruff@ pin under .github matches pinned_version_for's $want_pin"
  else
    st_bad "sqruff pin cross-check: every sqruff@ pin under .github matches pinned_version_for's $want_pin" \
      "scripts/setup-hooks.sh says $want_pin; CI disagrees at:$all_bad"
  fi

  # ── Test 5 (#3622) ── the two LIVE provisioning downloads refuse to run
  # when `mktemp -d` fails, instead of continuing with an empty $tmp.
  #
  # This is not a hypothetical: `set -u` does not fire on an empty
  # assignment and this script has no `set -e`, so pre-#3622
  # `ensure_cargo_binstall` went on to `curl … -o "$tmp/cb.tgz"` with
  # $tmp="" — i.e. it wrote `/cb.tgz`, root-owned in the containers this runs
  # in — then failed at `tar -C ""`, cleaned up nothing with `rm -rf ""`, and
  # fell back to `cargo install` so provisioning still reported success and
  # the stray file was never mentioned.
  #
  # Driving the REAL functions, not a transcription of them: a fake `curl`
  # that only RECORDS its argv (it never writes anything, so this test cannot
  # itself create the file it is about), a fake `uname` so the prebuilt-triple
  # branch is entered on every host, TMPDIR pointed at a nonexistent
  # directory so a REAL `mktemp -d` genuinely fails, and HOME redirected into
  # the scratch dir so the `mkdir -p "$HOME/…"` these functions do first
  # cannot touch the developer's actual home. The assertion is that curl is
  # never reached: without the guard it is, with the `-o /cb.tgz` argv to
  # prove it.
  probe_dir="$stub_dir/mktemp-probe"
  probe_home="$stub_dir/probe-home"
  mkdir -p "$probe_dir" "$probe_home"
  curl_log="$stub_dir/curl.log"
  : >"$curl_log"
  cat >"$probe_dir/curl" <<'FAKECURL'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CURL_LOG"
exit 1
FAKECURL
  chmod +x "$probe_dir/curl"
  cat >"$probe_dir/uname" <<'FAKEUNAME'
#!/usr/bin/env bash
case "${1:-}" in
  -m) echo x86_64 ;;
  *)  echo Linux ;;
esac
FAKEUNAME
  chmod +x "$probe_dir/uname"
  # Real tools the probed code paths need. `mktemp` above all: if it were
  # missing, `mktemp -d` would fail as "command not found" and this test
  # would pass without ever exercising the documented TMPDIR failure. `cargo`
  # is the stub from Test 1 (both functions fall back to `cargo install`);
  # `cargo-binstall` is deliberately NOT linked here, or
  # `ensure_cargo_binstall` would early-return before reaching any of this.
  for real_tool in bash mktemp mkdir rm; do
    if command -v "$real_tool" >/dev/null 2>&1; then
      ln -sf "$(command -v "$real_tool")" "$probe_dir/$real_tool"
    fi
  done
  ln -sf "$stub_dir/cargo" "$probe_dir/cargo"
  probe_req_log="$stub_dir/requests5.log"
  : >"$probe_req_log"

  saved_os="$OS"
  OS="Linux"
  for probe_fn in ensure_cargo_binstall install_lychee; do
    : >"$curl_log"
    probe_out="$(PATH="$probe_dir" HOME="$probe_home" TMPDIR="/nonexistent-dir" \
      CURL_LOG="$curl_log" REQUEST_LOG="$probe_req_log" "$probe_fn" 2>&1)"
    if [ -s "$curl_log" ]; then
      st_bad "$probe_fn aborts its download when mktemp -d fails, instead of running with an empty \$tmp" \
        "curl was invoked despite no temp dir: $(tr '\n' ';' <"$curl_log") — an empty \$tmp interpolates to the filesystem ROOT"
    else
      st_ok "$probe_fn aborts its download when mktemp -d fails, instead of running with an empty \$tmp"
    fi
    case "$probe_out" in
      *"mktemp -d failed"*) st_ok "$probe_fn names the temp-dir failure as the reason it fell back" ;;
      *) st_bad "$probe_fn names the temp-dir failure as the reason it fell back" "output was: $probe_out" ;;
    esac
  done
  OS="$saved_os"

  rm -rf "$stub_dir"
  trap - EXIT

  if [ "$st_fail" != 0 ]; then
    echo "setup-hooks.sh self-test FAILED" >&2
    exit 2
  fi
  echo "setup-hooks.sh self-test passed"
  exit 0
fi

echo "Setting up the prek hook toolchain (OS: $OS)…"

# --- Rust hook tools -------------------------------------------------------
if ! have cargo; then
  warn "Rust/cargo not found — install via https://rustup.rs, then re-run."
  warn "Skipping the cargo-based tools (prek, cargo-deny, sqlx-cli, …)."
else
  ensure_cargo_binstall
  cargo_get prek
  cargo_get cargo-deny
  cargo_get cargo-machete
  cargo_get cargo-audit
  cargo_get_pinned sqruff "$(pinned_version_for sqruff)" sqruff "$SQRUFF_VERSION_AWK"
  cargo_get typos-cli typos
  cargo_get_pinned zizmor "$ZIZMOR_PINNED_VERSION" zizmor "$ZIZMOR_VERSION_AWK"
  cargo_get taplo-cli taplo
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
