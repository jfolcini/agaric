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
# Two DIFFERENT version tables, opposite precedence (issue #3602): a crate
# CI pins explicitly (today: sqruff, `sqruff@0.38.0` in the `tool:` lists of
# `.github/workflows/_validate.yml` and `scheduled-deep-checks.yml`) must
# install that EXACT version here too, tried FIRST — `cargo_get` used to try
# latest first and only fall back to the pinned value if that failed, so on
# any box where binstall could fetch a newer sqruff, local silently ran a
# different linter version than CI, the exact divergence the pin exists to
# prevent. `pinned_version_for()` is that table — consulted first, and wins
# outright (no latest attempt for a pinned crate at all). It is a distinct
# concept from `msrv_fallback_version_for()`'s MSRV-skew escape hatch, which
# stays tried SECOND, only after a real latest-install attempt fails, for a
# crate with no CI pin.
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

# pinned_version_for <crate> — echoes the EXACT version this crate must
# install as, matching a version CI pins explicitly (today: sqruff, via
# `sqruff@0.38.0` in the `taiki-e/install-action` `tool:` lists of
# `.github/workflows/_validate.yml` and `scheduled-deep-checks.yml`). This
# table is consulted FIRST in `cargo_get` and WINS outright — no "try latest,
# fall back to this on failure": that was precisely the bug (#3602). If a
# pinned install fails, `cargo_get` warns rather than silently falling
# through to latest, because installing *something* that isn't the pin is
# not actually a fix for "local ran the wrong version" — it is the same bug
# with different arithmetic.
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
# here. This table is empty today (sqruff moved to `pinned_version_for`
# above); it stays as the escape hatch for a FUTURE crate that has MSRV skew
# but no CI pin. A plain `case` (not an associative array) so this stays
# bash-3.2/macOS compatible.
msrv_fallback_version_for() {
  case "$1" in
    *) echo "" ;;
  esac
}

# cargo_get <crate> [binary] — install a Rust hook tool. Precedence:
#   1. `pinned_version_for` — if the crate has a CI-matching pin, install
#      EXACTLY that version (binstall, else `cargo install --locked`) and
#      stop there — no latest attempt, no MSRV fallback. A failure here
#      warns; it does not fall through to installing an unpinned version.
#   2. No pin: install latest (prebuilt via binstall, else from source).
#   3. Latest failed: `msrv_fallback_version_for`'s pinned-version retry, for
#      a crate with MSRV skew but no CI pin.
cargo_get() {
  local crate="$1" bin="${2:-$1}" pinned msrv_fallback
  if have "$bin"; then ok "$bin (already installed)"; return; fi

  pinned="$(pinned_version_for "$crate")"
  if [ -n "$pinned" ]; then
    if have cargo-binstall && cargo binstall -y "${crate}@${pinned}" >/dev/null 2>&1; then
      ok "$bin $pinned (binstall — pinned to match CI)"; return
    fi
    if cargo install --locked "${crate}@${pinned}" >/dev/null 2>&1; then
      ok "$bin $pinned (cargo install — pinned to match CI)"; return
    fi
    warn "could not install pinned ${crate}@${pinned} (must match CI) — run: cargo install --locked ${crate}@${pinned}"
    return
  fi

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

# ── self-test (#3602) ────────────────────────────────────────────────────
# Falsifiable coverage for cargo_get's pin-vs-latest PRECEDENCE: proves a
# pinned crate (sqruff) is requested at its exact pinned version FIRST, never
# at "latest" first. Before this fix, `cargo_get sqruff` tried latest first
# and only fell back to the pin if binstall's latest attempt failed — so on
# any box where binstall could fetch a newer sqruff, local silently ran a
# different linter version than the one CI pins (`sqruff@0.38.0` in the
# `tool:` lists of `.github/workflows/_validate.yml` and
# `scheduled-deep-checks.yml`), and the pin was never reached. Stubs `cargo`
# / `cargo-binstall` on an isolated PATH — no network, no real installs, no
# repo mutation. Wired as the `setup-hooks-selftest` prek hook (mirrors the
# established `push.sh --self-test` / `verify-ci-equivalent.sh --self-test`
# convention) so a future reordering of this precedence reddens instead of
# silently re-diverging.
if [ "${1:-}" = "--self-test" ]; then
  st_fail=0
  st_ok() { printf '  ok   - %s\n' "$1"; }
  st_bad() { printf '  FAIL - %s: %s\n' "$1" "$2" >&2; st_fail=1; }

  stub_dir="$(mktemp -d -t setup-hooks-selftest.XXXXXX)"
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
  # line per request IN ORDER, to $REQUEST_LOG, and always SUCCEEDS. Both the
  # bare ("latest") and pinned requests succeed here on purpose: the point of
  # this stub is to isolate INSTALL ORDER — which version cargo_get asks for
  # FIRST — not failure/retry handling.
  cat >"$stub_dir/cargo" <<'FAKECARGO'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$REQUEST_LOG"
case "${1:-}" in
  binstall|install) exit 0 ;;
  *) echo "fake cargo: unhandled subcommand: $*" >&2; exit 99 ;;
esac
FAKECARGO
  chmod +x "$stub_dir/cargo"

  # Deliberately excludes $HOME/.cargo/bin and $HOME/.local/bin (where a real
  # sqruff/prek would live if this box already has one) — only the stubs
  # above plus the minimal system dirs `have`/awk/mktemp/etc. need, so the
  # test is deterministic regardless of what is actually installed here.
  stub_path="$stub_dir:/usr/bin:/bin"

  # ── Test 1 (the falsifiable core) ── a PINNED crate is requested at its
  # exact pinned version FIRST — never at "latest" first.
  req_log="$stub_dir/requests.log"
  : >"$req_log"
  out="$(PATH="$stub_path" REQUEST_LOG="$req_log" cargo_get sqruff 2>&1)"
  first_req="$(head -n1 "$req_log" 2>/dev/null || true)"
  if [ "$first_req" = "binstall -y sqruff@0.38.0" ]; then
    st_ok "cargo_get sqruff requests the PINNED version first (matches CI's sqruff@0.38.0)"
  else
    st_bad "cargo_get sqruff requests the PINNED version first (matches CI's sqruff@0.38.0)" \
      "first cargo request was '${first_req:-<none>}', wanted 'binstall -y sqruff@0.38.0' — full log: $(tr '\n' ';' <"$req_log" 2>/dev/null)"
  fi
  case "$out" in
    *0.38.0*) st_ok "cargo_get sqruff's own report names the pinned version" ;;
    *) st_bad "cargo_get sqruff's own report names the pinned version" "output was: $out" ;;
  esac
  # A bare/unversioned request IS "latest" — the exact thing #3602 forbids
  # for a pinned crate. It must never appear in the log at all.
  if grep -qxF 'binstall -y sqruff' "$req_log" 2>/dev/null; then
    st_bad "cargo_get sqruff never requests the bare (latest) version" \
      "found an unversioned 'binstall -y sqruff' request — full log: $(tr '\n' ';' <"$req_log")"
  else
    st_ok "cargo_get sqruff never requests the bare (latest) version"
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

  # ── Test 3 ── the pin/fallback tables carry sqruff under the right NAME:
  # a hard pin (pinned_version_for), no longer an MSRV-skew fallback
  # (msrv_fallback_version_for) — the name/precedence mismatch is how #3602
  # happened in the first place.
  if [ "$(pinned_version_for sqruff)" = "0.38.0" ]; then
    st_ok "pinned_version_for sqruff == 0.38.0"
  else
    st_bad "pinned_version_for sqruff == 0.38.0" "got '$(pinned_version_for sqruff)'"
  fi
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
  repo_root="$(cd "$(dirname "$0")/.." && pwd)"
  for wf in .github/workflows/_validate.yml .github/workflows/scheduled-deep-checks.yml; do
    wf_path="$repo_root/$wf"
    if [ ! -f "$wf_path" ]; then
      st_bad "sqruff pin cross-check: $wf exists" "file not found at $wf_path"
      continue
    fi
    ci_pin="$(grep -oE 'sqruff@[0-9][^,[:space:]"]*' "$wf_path" | head -n1 | cut -d@ -f2)"
    if [ -z "$ci_pin" ]; then
      st_bad "sqruff pin cross-check: $wf pins a sqruff version" "no 'sqruff@<version>' found in $wf"
    elif [ "$ci_pin" = "$(pinned_version_for sqruff)" ]; then
      st_ok "sqruff pin cross-check: $wf's sqruff@$ci_pin matches pinned_version_for's $(pinned_version_for sqruff)"
    else
      st_bad "sqruff pin cross-check: $wf's sqruff@$ci_pin matches pinned_version_for's $(pinned_version_for sqruff)" \
        "CI says $ci_pin, scripts/setup-hooks.sh says $(pinned_version_for sqruff)"
    fi
  done

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
  cargo_get sqruff
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
