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
#   * tools already on PATH are skipped (fast re-runs), a pinned one only at
#     its pinned version;
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
# --locked`, before giving up.
#
# Every tool installs at the exact version in pins.txt, the same one CI reads,
# and replaces a differing one already on PATH (#3602, #3611). A tarball this
# script downloads itself is checked against its pins.txt sha256 (AGENTS.md
# § Supply-chain pinning); binstall, `uv tool` and `cargo install` take no hash,
# so for them the exact version is the pin.
set -uo pipefail

have() { command -v "$1" >/dev/null 2>&1; }

ok() { printf '  \033[32m✓ %s\033[0m\n' "$*"; }
note() { printf '  \033[36m%s\033[0m\n' "$*"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$*"; }

OS="$(uname -s)"

# Every version and download digest below comes from pins.txt through
# scripts/pins.sh (AGENTS.md § Supply-chain pinning).
pin() { bash "$(dirname "$0")/pins.sh" "$@"; }
PLATFORM="$(pin platform 2>/dev/null || true)"

# Cargo / local binaries land here; make sure they're visible to the rest of
# the script (a fresh shell may not have sourced the cargo env yet).
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

# pkg_install <brew-name> <apt-name> <binary> — install a system package via
# the platform package manager, or warn with a manual hint. (apt name doubles
# as the dnf/pacman name; override by hand if a distro diverges.)
pkg_install() {
  local brew_name="$1" apt_name="$2" bin="$3"
  if have "$bin"; then
    ok "$bin (already installed)"
    return
  fi
  case "$OS" in
    Darwin)
      if have brew; then
        if brew install "$brew_name" >/dev/null 2>&1; then
          ok "$bin (brew)"
        else warn "brew install $brew_name failed — install $bin manually"; fi
      else
        warn "Homebrew not found — install $bin manually (https://brew.sh)"
      fi
      ;;
    Linux)
      if have apt-get; then
        sudo apt-get update -qq >/dev/null 2>&1 || true
        if sudo apt-get install -y "$apt_name" >/dev/null 2>&1; then
          ok "$bin (apt)"
        else warn "apt could not install '$apt_name' — install $bin manually"; fi
      elif have dnf; then
        if sudo dnf install -y "$apt_name" >/dev/null 2>&1; then
          ok "$bin (dnf)"
        else warn "install $bin manually"; fi
      elif have pacman; then
        if sudo pacman -S --noconfirm "$apt_name" >/dev/null 2>&1; then
          ok "$bin (pacman)"
        else warn "install $bin manually"; fi
      else
        warn "no supported package manager — install $bin manually"
      fi
      ;;
    *) warn "unsupported OS '$OS' — install $bin manually" ;;
  esac
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
BINSTALL_VERSION="$(pin version cargo-binstall)"
ensure_cargo_binstall() {
  if have cargo-binstall; then
    ok "cargo-binstall (already installed)"
    return
  fi
  note "installing cargo-binstall (prebuilt-binary fetcher)…"
  if pin asset cargo-binstall "$PLATFORM" >/dev/null 2>&1; then
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
      if pin fetch cargo-binstall "$PLATFORM" "$tmp/cb.tgz" \
        && tar -xzf "$tmp/cb.tgz" -C "$tmp" cargo-binstall \
        && install -m 0755 "$tmp/cargo-binstall" "$dest/cargo-binstall" \
        && have cargo-binstall; then
        ok "cargo-binstall (prebuilt v${BINSTALL_VERSION}, ${PLATFORM})"
        rm -rf "$tmp"
        return
      fi
      rm -rf "$tmp"
      warn "prebuilt cargo-binstall download/verify failed — falling back to cargo install"
    fi
  fi
  if cargo install --locked "cargo-binstall@${BINSTALL_VERSION}" >/dev/null 2>&1; then
    ok "cargo-binstall ${BINSTALL_VERSION} (cargo install)"
  else
    warn "cargo-binstall unavailable — remaining cargo tools will compile from source (slow)"
  fi
}

# uv is the only way zizmor installs on a box whose proxy 403s binstall's
# GitHub API lookup: binstall then builds from source, and zizmor's dependency
# tree needs a newer rustc than rust-toolchain.toml pins, so both cargo paths
# fail (#4808). That is arch-independent, hence a matrix covering every
# platform this repo builds on rather than binstall's Linux-only one. uv also
# runs .mcp.json's code-review-graph, which needs no cargo — hence
# ~/.local/bin, exported onto PATH above.
#
# Tarball-and-digest, never upstream's install.sh: a downloaded file reaching
# a shell is the download-then-run Scorecard flags (#215) whatever verifies it.
#
UV_VERSION="$(pin version uv)"
ensure_uv() {
  if have uv; then
    ok "uv (already installed)"
    return
  fi
  if ! pin asset uv "$PLATFORM" >/dev/null 2>&1; then
    warn "no pinned uv build for ${OS}-$(uname -m) — zizmor may be MISSING; it now rests on binstall finding a prebuilt, since a source build hits the rust-toolchain.toml pin"
    return
  fi
  note "installing uv (zizmor's wheel installer)…"
  local dest="$HOME/.local/bin" tmp
  tmp="$(mktemp -d)"
  # Same guard, same reasoning as ensure_cargo_binstall above (#3622).
  if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then
    warn "mktemp -d failed (no writable temp dir?) — skipping the uv download"
    return
  fi
  mkdir -p "$dest"
  # Verify the pinned digest, then extract the two binaries. No downloaded
  # content is ever handed to a shell interpreter.
  if pin fetch uv "$PLATFORM" "$tmp/uv.tgz" \
    && tar -xzf "$tmp/uv.tgz" -C "$tmp" --strip-components=1 \
    && install -m 0755 "$tmp/uv" "$dest/uv" \
    && install -m 0755 "$tmp/uvx" "$dest/uvx" \
    && have uv; then
    ok "uv ${UV_VERSION} (prebuilt, ${PLATFORM})"
  else
    warn "uv download/verify failed — zizmor may be MISSING; it now rests on binstall finding a prebuilt, since a source build hits the rust-toolchain.toml pin"
  fi
  rm -rf "$tmp"
}

# pinned_version_for <crate> — the EXACT version a tool installs at, shared
# with CI (the `taiki-e/install-action` `tool:` lists, and sqruff's
# .github/actions/install-sqruff). prek is pinned because it IS the hook
# runner (#3742): a newer CI prek enforced a YAML limit the local one did not.
# The shellcheck and shfmt rows are not crates: `release_get_pinned` reads
# them. A plain `case` so this stays bash-3.2/macOS compatible.
pinned_version_for() { pin version "$1" 2>/dev/null || echo ""; }

# prebuilt_get <crate> <version> <binary> — fetch a prebuilt binary by its
# release URL, for a box where binstall cannot: a cloud session's proxy 403s
# api.github.com, which binstall needs to find a release, so every tool there
# compiled from source (#6560). Release downloads pass that proxy. The tarball
# is cargo-quickinstall's, the one binstall's quick-install strategy picks, so
# like binstall it has no recorded sha256 and the exact version is the pin;
# taplo-cli has none there, so it comes from upstream's release, sha256-checked.
prebuilt_get() {
  local crate="$1" version="$2" bin="$3" arch libc tmp
  local dest="${CARGO_HOME:-$HOME/.cargo}/bin"
  [ "$OS" = Linux ] || return 1
  arch="$(uname -m)"
  [ "$arch" = arm64 ] && arch=aarch64
  [ -n "$version" ] || return 1
  mkdir -p "$dest" || return 1
  if [ "$crate" = taplo-cli ]; then
    # The pinned version only: pins.txt holds no digest for any other.
    [ "$version" = "$(pin version taplo-cli)" ] || return 1
    tmp="$(mktemp)"
    [ -n "$tmp" ] || return 1
    if pin fetch taplo-cli "linux-$arch" "$tmp.gz" 2>/dev/null \
      && gunzip -c "$tmp.gz" >"$tmp" 2>/dev/null \
      && install -m 0755 "$tmp" "$dest/taplo"; then
      rm -f "$tmp" "$tmp.gz"
      return 0
    fi
    rm -f "$tmp" "$tmp.gz"
    return 1
  fi
  for libc in gnu musl; do
    if curl -fsSL "https://github.com/cargo-bins/cargo-quickinstall/releases/download/${crate}-${version}/${crate}-${version}-${arch}-unknown-linux-${libc}.tar.gz" 2>/dev/null \
      | tar -xzf - -C "$dest" >/dev/null 2>&1 && have "$bin"; then
      return 0
    fi
  done
  return 1
}

# cargo_get_pinned <crate> <version> [binary] — install an EXACT version, and
# REPLACE a differing one that is already on PATH.
#
# Skipping any binary that merely exists is wrong where local/CI agreement is
# the property being bought (#3476): zizmor's audit SET changes between
# releases, so an older local build gates pushes with fewer rules than CI.
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
    warn "no pinned version found for $crate — not installing it unpinned"
    return 1
  fi
  if have "$bin"; then
    current="$("$bin" --version 2>/dev/null | awk "$field")"
    if [ "$current" = "$version" ]; then
      ok "$bin $version (already installed)"
      return
    fi
    note "$bin ${current:-unknown} differs from the pinned $version — reinstalling"
  fi
  if have cargo-binstall && cargo binstall -y --disable-strategies compile "${crate}@${version}" >/dev/null 2>&1; then
    ok "$bin $version (binstall)"
    return
  fi
  if prebuilt_get "$crate" "$version" "$bin"; then
    ok "$bin $version (prebuilt)"
    return
  fi
  # zizmor also ships prebuilt wheels on PyPI. Try that before a source
  # build: binstall fails in seconds when a proxy blocks its GitHub lookup,
  # but `cargo install` compiles for minutes before an MSRV mismatch kills it.
  # `uv tool install` rather than `pip install --user`: Scorecard's
  # Pinned-Dependencies wants a pip install hash-pinned (`--require-hashes`),
  # so it flagged the pip form even with an exact `==` (#273). uv is not a pip
  # command, keeps the same exact pin, and installs into its own environment
  # instead of the shared user site-packages; `--reinstall` makes a differing
  # cached build lose to the pin. The bin directory is unchanged — `uv tool dir
  # --bin` is ~/.local/bin, where pip --user wrote too — so the `--version`
  # assertion below remains what proves what actually landed.
  # prek takes the same route: cargo-quickinstall carries no build of it.
  if { [ "$crate" = zizmor ] || [ "$crate" = prek ]; } && have uv \
    && uv tool install --reinstall --quiet "${crate}==${version}" >/dev/null 2>&1; then
    local uv_bin
    uv_bin="$(uv tool dir --bin 2>/dev/null)/$bin"
    if [ -x "$uv_bin" ] && mkdir -p "$HOME/.cargo/bin" \
      && ln -sf "$uv_bin" "$HOME/.cargo/bin/$bin" && [ -x "$HOME/.cargo/bin/$bin" ]; then
      ok "$bin $version (uv tool, linked into ~/.cargo/bin)"
      return
    fi
  fi
  if cargo install --locked "${crate}@${version}" >/dev/null 2>&1; then
    ok "$bin $version (cargo install)"
    return
  fi
  warn "could not install ${crate}@${version} — run: cargo install --locked ${crate}@${version}"
}

# The pin lives in scripts/zizmor-hook.sh (single source of truth; the same
# version is pinned in the CI `tool:` lists, and the wrapper hard-fails a CI
# run whose binary disagrees).
ZIZMOR_PINNED_VERSION="$(pin version zizmor)"

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
# exit here is taken BEFORE every installer below, so it would take every
# other hook binary in HOOK_BINS down with it. The guard below is the runtime
# notice (#3545, finding 1).
if [ -z "$ZIZMOR_VERSION_AWK" ]; then
  warn "could not source ZIZMOR_VERSION_AWK from zizmor-hook.sh — falling back to cargo_get_pinned's \$NF default, which can disagree with the wrapper's \$2 and reinstall zizmor on every run (#3545)"
fi

# `sqruff --version` prints `sqruff 0.44.0` — unlike zizmor, no separate
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
# zizmor-hook.sh stands in front of zizmor.
PREK_VERSION_AWK='NR == 1 { print $2 }'
TAPLO_VERSION_AWK='NR == 1 { print $2 }'
TYPOS_VERSION_AWK='NR == 1 { print $2 }'

# The shellcheck and shfmt hooks run the upstream release binary at the
# pinned version, verified against these digests: the ones the CI lint job's
# taiki-e/install-action manifest checks for the same `tool:` pins. A package
# manager's copy is whatever its distro carries, so a differing one on PATH is
# replaced, as `cargo_get_pinned` does. It lands in ~/.cargo/bin, which
# rustup's env puts ahead of the system directories that hold an apt or brew
# copy.
#
# `shellcheck --version` prints `version: 0.11.0` on its second line;
# `shfmt --version` prints `v3.14.1`.
SHELLCHECK_VERSION_AWK='$1 == "version:" { print $2 }'
SHFMT_VERSION_AWK='NR == 1 { sub(/^v/, ""); print }'

# release_get_pinned <tool> — install shellcheck or shfmt at its pinned
# version. The download is verified before anything is extracted or
# installed, and no downloaded content reaches a shell.
release_get_pinned() {
  local bin="$1" version field current="" platform="" url member=""
  local dest="${CARGO_HOME:-$HOME/.cargo}/bin" tmp
  version="$(pinned_version_for "$bin")"
  case "$bin" in
    shellcheck) field="$SHELLCHECK_VERSION_AWK" ;;
    shfmt) field="$SHFMT_VERSION_AWK" ;;
  esac
  if have "$bin"; then
    current="$("$bin" --version 2>/dev/null | awk "$field")"
    if [ "$current" = "$version" ]; then
      ok "$bin $version (already installed)"
      return
    fi
    note "$bin ${current:-unknown} differs from the pinned $version — reinstalling"
  fi
  platform="$PLATFORM"
  if ! pin asset "$bin" "$platform" >/dev/null 2>&1; then
    warn "no pinned $bin build for $platform in pins.txt — install $bin $version by hand"
    return
  fi
  [ "$bin" = shellcheck ] && member="shellcheck-v${version}/shellcheck"
  url="$(pin asset "$bin" "$platform" | awk '{ print $2 }')"
  tmp="$(mktemp -d)"
  # Same guard, same reasoning as ensure_cargo_binstall above (#3622).
  if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then
    warn "mktemp -d failed (no writable temp dir?) — skipping the $bin download"
    return
  fi
  if pin fetch "$bin" "$platform" "$tmp/download" \
    && { [ -z "$member" ] || { tar -xJf "$tmp/download" -C "$tmp" "$member" && mv "$tmp/$member" "$tmp/download"; }; } \
    && mkdir -p "$dest" && install -m 0755 "$tmp/download" "$dest/$bin"; then
    current="$("$dest/$bin" --version 2>/dev/null | awk "$field")"
    if [ "$current" = "$version" ]; then
      ok "$bin $version (release binary, $platform)"
    else warn "$dest/$bin reports ${current:-no version} after install, not $version"; fi
  else
    warn "$bin $version download/verify failed — install it by hand from $url"
  fi
  rm -rf "$tmp"
}

# lychee is a heavy crate that cargo-binstall can't fetch prebuilt, so — like
# CI — pull the release tarball at CI's version and check its sha256. If that
# download fails (some sandbox proxies 403 GitHub release assets, #2535), fall
# back to binstall, then `cargo install --locked`, at the same version.
LYCHEE_VERSION="$(pin version lychee)"
install_lychee() {
  if have lychee && [ "$(lychee --version 2>/dev/null | awk 'NR == 1 { print $NF }')" = "$LYCHEE_VERSION" ]; then
    ok "lychee $LYCHEE_VERSION (already installed)"
    return
  fi
  if pin asset lychee "$PLATFORM" >/dev/null 2>&1; then
    local tmp bin=""
    tmp="$(mktemp -d)"
    # A failed `mktemp -d` leaves $tmp empty and nothing stops the script
    # (#3622); fail with the real reason instead of a misleading one.
    if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then
      warn "mktemp -d failed (no writable temp dir?) — skipping the prebuilt lychee download, falling back to cargo binstall"
    else
      # Find the binary rather than hard-code its path: the tarball layout
      # has changed between releases.
      if pin fetch lychee "$PLATFORM" "$tmp/lychee.tgz" \
        && tar -xzf "$tmp/lychee.tgz" -C "$tmp" >/dev/null 2>&1; then
        bin="$(find "$tmp" -type f -name lychee 2>/dev/null | head -1)"
      fi
      if [ -n "$bin" ] && mkdir -p "$HOME/.local/bin" && install -m 0755 "$bin" "$HOME/.local/bin/lychee" 2>/dev/null; then
        ok "lychee $LYCHEE_VERSION (prebuilt $PLATFORM)"
        rm -rf "$tmp"
        return
      fi
      rm -rf "$tmp"
      warn "prebuilt lychee tarball unreachable or failed its sha256 check — falling back to cargo binstall"
    fi
  else
    warn "no prebuilt lychee tarball for $PLATFORM in pins.txt — falling back to cargo binstall"
  fi
  if have cargo && have cargo-binstall && cargo binstall -y --disable-strategies compile "lychee@${LYCHEE_VERSION}" >/dev/null 2>&1; then
    ok "lychee $LYCHEE_VERSION (binstall fallback)"
    return
  fi
  if have cargo && cargo install --locked "lychee@${LYCHEE_VERSION}" >/dev/null 2>&1; then
    ok "lychee $LYCHEE_VERSION (cargo install fallback, slow from-source build)"
    return
  fi
  warn "could not install lychee $LYCHEE_VERSION (prebuilt tarball and cargo fallbacks all failed) — install it by hand from https://github.com/lycheeverse/lychee/releases"
}

# cargo-nextest is never compiled here: from source it was the longest step of
# a cloud session's boot, and it competed with the agent's own first cargo run.
# binstall without its compile fallback, then upstream's tarball, checked against pins.txt.
install_nextest() {
  local version
  version="$(pinned_version_for cargo-nextest)"
  if have cargo-nextest && [ "$(cargo-nextest --version 2>/dev/null | awk 'NR == 1 { print $2 }')" = "$version" ]; then
    ok "cargo-nextest $version (already installed)"
    return
  fi
  if have cargo-binstall && cargo binstall -y --disable-strategies compile "cargo-nextest@${version}" >/dev/null 2>&1; then
    ok "cargo-nextest $version (binstall)"
    return
  fi
  local dest="${CARGO_HOME:-$HOME/.cargo}/bin" tmp
  tmp="$(mktemp -d)"
  if [ -n "$tmp" ] && mkdir -p "$dest" \
    && pin fetch cargo-nextest "$PLATFORM" "$tmp/nextest.tgz" \
    && tar -xzf "$tmp/nextest.tgz" -C "$dest" >/dev/null 2>&1 \
    && have cargo-nextest; then
    ok "cargo-nextest $version (prebuilt $PLATFORM)"
    rm -rf "$tmp"
    return
  fi
  [ -n "$tmp" ] && rm -rf "$tmp"
  warn "could not install cargo-nextest $version — run: bash scripts/pins.sh fetch cargo-nextest $PLATFORM /tmp/nextest.tgz && tar -xzf /tmp/nextest.tgz -C \"$dest\""
}

# sqlx-cli needs custom features (rustls + sqlite only) — same as CI, and at
# CI's version.
SQLX_CLI_VERSION="$(pin version sqlx-cli)"
install_sqlx_cli() {
  if have sqlx && [ "$(sqlx --version 2>/dev/null | awk 'NR == 1 { print $NF }')" = "$SQLX_CLI_VERSION" ]; then
    ok "sqlx-cli $SQLX_CLI_VERSION (already installed)"
    return
  fi
  if have cargo-binstall && cargo binstall -y --disable-strategies compile "sqlx-cli@${SQLX_CLI_VERSION}" >/dev/null 2>&1; then
    ok "sqlx-cli $SQLX_CLI_VERSION (binstall)"
    return
  fi
  if prebuilt_get sqlx-cli "$SQLX_CLI_VERSION" sqlx; then
    ok "sqlx-cli $SQLX_CLI_VERSION (prebuilt)"
    return
  fi
  if cargo install --locked --force sqlx-cli --version "$SQLX_CLI_VERSION" --no-default-features --features rustls,sqlite >/dev/null 2>&1; then
    ok "sqlx-cli $SQLX_CLI_VERSION (cargo install)"
  else
    warn "install sqlx-cli by hand: cargo install --locked sqlx-cli --version $SQLX_CLI_VERSION --no-default-features --features rustls,sqlite"
  fi
}

echo "Setting up the prek hook toolchain (OS: $OS)…"

# --- Rust hook tools the pre-commit stage needs ------------------------------
# Only these come before the wiring below: in a cloud session the setup runs
# in the background, and every minute the hooks are unwired is a minute of
# commits with no hook feedback. The pre-push-only tools follow the wiring.
# uv first, and OUTSIDE the cargo gate: it needs no cargo, and .mcp.json's
# code-review-graph wants it on a box that has no Rust at all.
ensure_uv
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
  cargo_get_pinned cargo-deny "$(pinned_version_for cargo-deny)"
  cargo_get_pinned cargo-machete "$(pinned_version_for cargo-machete)"
  cargo_get_pinned sqruff "$(pinned_version_for sqruff)" sqruff "$SQRUFF_VERSION_AWK"
  cargo_get_pinned typos-cli "$(pinned_version_for typos-cli)" typos "$TYPOS_VERSION_AWK"
  cargo_get_pinned zizmor "$ZIZMOR_PINNED_VERSION" zizmor "$ZIZMOR_VERSION_AWK"
  cargo_get_pinned taplo-cli "$(pinned_version_for taplo-cli)" taplo "$TAPLO_VERSION_AWK"
fi

# --- System hook tools -----------------------------------------------------
release_get_pinned shellcheck
release_get_pinned shfmt

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
    if prek install >/dev/null 2>&1; then
      ok "git hooks wired (prek install)"
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

# --- Tools only the pre-push stage and the verifier need -------------------
if have cargo; then
  cargo_get_pinned cargo-audit "$(pinned_version_for cargo-audit)"
  install_nextest
  cargo_get_pinned just "$(pin version just)"
  install_lychee
  install_sqlx_cli
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
HOOK_BINS="prek cargo-deny cargo-machete cargo-audit sqruff typos zizmor taplo cargo-nextest just lychee shellcheck shfmt go python3"
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
