#!/usr/bin/env bash
# Install the prek hook toolchain and wire the git hooks.
#
# Every hook in prek.toml is `language = "system"`, so prek provisions
# NOTHING itself — each hook shells out to a binary that must already be on
# PATH. Without these, the very first `git commit` aborts. This script
# installs that toolchain so a fresh clone is commit/push-ready, and mirrors
# the install set CI uses in `.github/workflows/_validate.yml` so the local
# gate (`prek run --all-files` / `just check`) matches CI.
#
# Best-effort and idempotent by design:
#   * tools already on PATH are skipped (fast re-runs);
#   * a tool that can't be auto-installed on this platform prints a manual
#     hint instead of aborting — a partial toolchain still lets you build and
#     run the app, you just can't commit until the gap is filled.
# Hence `set -u` but NOT `set -e`: a single failed installer must never sink
# the whole bootstrap.
set -uo pipefail

have() { command -v "$1" >/dev/null 2>&1; }

ok()   { printf '  \033[32m✓ %s\033[0m\n' "$*"; }
note() { printf '  \033[36m%s\033[0m\n' "$*"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$*"; }

OS="$(uname -s)"

# pkg_install <brew-name> <apt-name> <binary> — install a NON-cargo host tool
# via the platform package manager, or warn with a manual hint.
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
        if sudo apt-get install -y "$apt_name" >/dev/null 2>&1; then ok "$bin (apt)"
        else warn "apt has no '$apt_name' — install $bin manually (see its release page)"; fi
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

# cargo_get <crate> [binary] — install a Rust hook tool. Prefer cargo-binstall
# (prebuilt release binaries — seconds, not the multi-minute from-source
# `cargo install` compile); fall back to `cargo install --locked`.
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

# sqlx-cli needs custom features (rustls + sqlite only) — same as CI.
install_sqlx_cli() {
  if have cargo-sqlx; then ok "sqlx-cli (already installed)"; return; fi
  if have cargo-binstall && cargo binstall -y sqlx-cli >/dev/null 2>&1; then
    ok "sqlx-cli (binstall)"; return
  fi
  if cargo install --locked sqlx-cli --no-default-features --features rustls,sqlite >/dev/null 2>&1; then
    ok "sqlx-cli (cargo install)"
  else
    warn "install sqlx-cli manually: cargo install --locked sqlx-cli --no-default-features --features rustls,sqlite"
  fi
}

echo "Setting up the prek hook toolchain…"

if ! have cargo; then
  warn "Rust/cargo not found — install via https://rustup.rs, then re-run."
  warn "Skipping the cargo-based tools (prek, cargo-deny, sqlx-cli, …)."
else
  # cargo-binstall makes the rest near-instant; bootstrap it once if missing.
  if ! have cargo-binstall; then
    note "installing cargo-binstall (prebuilt-binary fetcher) for fast tool installs…"
    if cargo install --locked cargo-binstall >/dev/null 2>&1; then ok "cargo-binstall"
    else warn "cargo-binstall unavailable — using cargo install (slower)"; fi
  fi

  # The Rust-based hook tools (matches the taiki-e/install-action set in CI).
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
  cargo_get lychee
  install_sqlx_cli
fi

# Non-cargo host tools used by `system`-language hooks.
pkg_install shellcheck shellcheck shellcheck
pkg_install gitleaks gitleaks gitleaks
pkg_install actionlint actionlint actionlint

# Frontend hook tools (oxlint, oxfmt, knip, markdownlint-cli2) ship as npm
# devDependencies — `scripts/setup.sh` already ran `npm ci`, so they are on
# PATH via node_modules/.bin and need nothing here.

# Finally, wire the git hooks so commit/push run the suite.
if have prek; then
  if prek install >/dev/null 2>&1; then ok "git hooks installed (prek install)"
  else warn "prek install failed — run it manually"; fi
else
  warn "prek not on PATH — install it, then run: prek install"
fi

echo "Hook toolchain setup complete (warnings above, if any, are non-fatal)."
