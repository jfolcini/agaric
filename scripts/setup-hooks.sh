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
# VM provisioning).
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
# of the multi-minute from-source `cargo install` compile. Bootstrap it once
# via its official prebuilt installer, falling back to `cargo install`.
#
# Pinned-Dependencies (OpenSSF Scorecard, code-scanning #215): the installer
# is fetched and run, so it must NOT come from a mutable ref piped straight
# into a shell. Pin it to a cargo-binstall release *commit* (immutable) and
# verify the script's SHA-256 before executing it, and pin the binary it then
# downloads via BINSTALL_VERSION. A moved tag, a tampered CDN response, or a
# truncated download therefore can never reach `bash`; on any mismatch we fall
# back to the equally-pinned `cargo install --locked`.
#
# To bump: pick the new release, set BINSTALL_REF to that tag's commit SHA and
# BINSTALL_VERSION to the tag, then set BINSTALL_INSTALLER_SHA256 to
#   curl -fsSL https://raw.githubusercontent.com/cargo-bins/cargo-binstall/<ref>/install-from-binstall-release.sh | sha256sum
BINSTALL_REF="732870f031d2fb36309d0deaf36abcc704a7be65"  # tag v1.20.1
BINSTALL_VERSION="1.20.1"
BINSTALL_INSTALLER_SHA256="d3a93702160e0ec03e2a4e996855db1f01adee801fb84a43add24e0877ef8eae"
ensure_cargo_binstall() {
  if have cargo-binstall; then ok "cargo-binstall (already installed)"; return; fi
  note "installing cargo-binstall (prebuilt-binary fetcher)…"
  local url="https://raw.githubusercontent.com/cargo-bins/cargo-binstall/${BINSTALL_REF}/install-from-binstall-release.sh"
  local tmp
  tmp="$(mktemp)"
  if curl -fsSL --proto '=https' --tlsv1.2 "$url" -o "$tmp" \
       && verify_sha256 "$tmp" "$BINSTALL_INSTALLER_SHA256" \
       && BINSTALL_VERSION="$BINSTALL_VERSION" bash "$tmp" >/dev/null 2>&1 \
       && have cargo-binstall; then
    ok "cargo-binstall (prebuilt, pinned v${BINSTALL_VERSION})"
  elif cargo install --locked cargo-binstall >/dev/null 2>&1; then
    ok "cargo-binstall (cargo install)"
  else
    warn "cargo-binstall unavailable — remaining cargo tools will compile from source (slow)"
  fi
  rm -f "$tmp"
}

# cargo_get <crate> [binary] — install a Rust hook tool (prebuilt via binstall,
# else from source).
cargo_get() {
  local crate="$1" bin="${2:-$1}"
  if have "$bin"; then ok "$bin (already installed)"; return; fi
  if have cargo-binstall && cargo binstall -y "$crate" >/dev/null 2>&1; then
    ok "$bin (binstall)"; return
  fi
  if cargo install --locked "$crate" >/dev/null 2>&1; then
    ok "$bin (cargo install)"
  else
    warn "could not install $crate — run: cargo install --locked $crate"
  fi
}

# lychee is a heavy crate that cargo-binstall can't fetch prebuilt (it falls
# back to a slow from-source compile), so — exactly like CI — pull the official
# prebuilt release tarball instead. macOS prefers brew.
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
    *) warn "no prebuilt lychee for $OS-$arch — install manually (https://github.com/lycheeverse/lychee/releases)"; return ;;
  esac
  local url="https://github.com/lycheeverse/lychee/releases/latest/download/lychee-${triple}.tar.gz"
  mkdir -p "$HOME/.local/bin"
  # Extract to a temp dir and FIND the binary rather than hard-coding its path:
  # recent release tarballs nest it under `lychee-<triple>/lychee`, older ones
  # under `<triple>/lychee`, and pinning one layout silently broke the install
  # when upstream changed it (the curl|tar just found no such member and the
  # hook went missing). `find` is layout- and portable across GNU/bsd tar.
  local tmp bin=""
  tmp="$(mktemp -d)"
  if curl -fsSL "$url" | tar -xz -C "$tmp" >/dev/null 2>&1; then
    bin="$(find "$tmp" -type f -name lychee 2>/dev/null | head -1)"
  fi
  if [ -n "$bin" ] && install -m 0755 "$bin" "$HOME/.local/bin/lychee" 2>/dev/null; then
    ok "lychee (prebuilt $triple)"
  else
    warn "could not download prebuilt lychee — install manually (https://github.com/lycheeverse/lychee/releases)"
  fi
  rm -rf "$tmp"
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

echo "Hook toolchain setup complete (warnings above, if any, are non-fatal)."
