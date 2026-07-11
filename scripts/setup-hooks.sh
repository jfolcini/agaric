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
# `fallback_version_for()` below for the pinned-version retry that handles
# that case.
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
    mkdir -p "$dest"
    # Download the tarball, verify its pinned SHA-256, then extract the single
    # `cargo-binstall` binary and install it. No downloaded content is ever
    # handed to a shell interpreter.
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
  if cargo install --locked cargo-binstall >/dev/null 2>&1; then
    ok "cargo-binstall (cargo install)"
  else
    warn "cargo-binstall unavailable — remaining cargo tools will compile from source (slow)"
  fi
}

# fallback_version_for <crate> — echoes a pinned known-good version to retry
# when the crate's LATEST release outpaces this box's rustc (MSRV skew).
# Symptom (issue #2535, verified with sqruff 0.39.0 vs. rustc 1.95): both
# `cargo binstall -y <crate>` AND its from-source fallback fail identically
# with an MSRV error, because binstall's source fallback still targets the
# newest crates.io release. Pinning a slightly older version sidesteps it.
# A plain `case` (not an associative array) so this stays bash-3.2/macOS
# compatible. Add an entry here — and drop it once the box's rustc pin
# (rust-toolchain.toml) catches up — mirroring the same pin CI uses via
# taiki-e/install-action in .github/workflows/_validate.yml.
fallback_version_for() {
  case "$1" in
    sqruff) echo "0.38.0" ;;
    *) echo "" ;;
  esac
}

# cargo_get <crate> [binary] — install a Rust hook tool (prebuilt via
# binstall, else a pinned-version retry if the crate has MSRV skew, else
# from source).
cargo_get() {
  local crate="$1" bin="${2:-$1}" fallback
  if have "$bin"; then ok "$bin (already installed)"; return; fi
  fallback="$(fallback_version_for "$crate")"
  if have cargo-binstall; then
    if cargo binstall -y "$crate" >/dev/null 2>&1; then
      ok "$bin (binstall)"; return
    fi
    if [ -n "$fallback" ] && cargo binstall -y "${crate}@${fallback}" >/dev/null 2>&1; then
      ok "$bin (binstall ${fallback} — latest release exceeds this box's rustc)"; return
    fi
  fi
  if [ -n "$fallback" ] && cargo install --locked "${crate}@${fallback}" >/dev/null 2>&1; then
    ok "$bin (cargo install ${fallback} — pinned fallback)"; return
  fi
  if cargo install --locked "$crate" >/dev/null 2>&1; then
    ok "$bin (cargo install)"
  elif [ -n "$fallback" ]; then
    warn "could not install $crate — tried latest and pinned fallback ${fallback} — run: cargo install --locked ${crate}@${fallback}"
  else
    warn "could not install $crate — run: cargo install --locked $crate"
  fi
}

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
  cargo_get prek
  cargo_get cargo-deny
  cargo_get cargo-machete
  cargo_get cargo-audit
  cargo_get sqruff
  cargo_get typos-cli typos
  cargo_get zizmor
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
