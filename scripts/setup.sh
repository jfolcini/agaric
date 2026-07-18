#!/usr/bin/env bash
# One-shot post-clone setup. Idempotent: safe to re-run.
set -euo pipefail

# --- Transient-failure retry ----------------------------------------------
# Retry a flaky network command with exponential backoff (2s, 4s, 8s, 16s;
# 5 attempts total). Container provisioning sometimes runs this script before
# the proxied network is fully up, so a SINGLE transient fetch failure would
# otherwise abort the whole `set -euo pipefail` bootstrap — and with it the
# best-effort steps that follow (npm ci, .env, dev DB, git hooks), leaving a
# clone that can't build/test/commit. A retry lets that startup race self-heal.
# Mirrors the git push retry convention used elsewhere in this repo.
retry() {
  local -i attempt=1 max=5 delay=2
  while true; do
    if "$@"; then
      return 0
    fi
    if [ "$attempt" -ge "$max" ]; then
      echo "retry: command failed after ${max} attempts: $*" >&2
      return 1
    fi
    echo "retry: attempt ${attempt}/${max} failed: $* — retrying in ${delay}s…" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

# --- Node toolchain --------------------------------------------------------
# Everything below needs the Node version pinned in .nvmrc. package.json's
# `engines` enforces it (>=24), so a mismatched node makes the very first
# `npm ci` abort with EBADENGINE. Don't assume the caller's shell is already on
# the right node: Claude's cloud VMs ship Node 20/21/22 (via nvm) by default,
# all older than we need, so provision the pinned version here.
#
# This deliberately uses nvm over plain HTTPS — Node from nodejs.org, and (only
# if nvm.sh is missing) nvm.sh from raw.githubusercontent.com — and NEVER
# `git clone`. In a sandboxed session the git credential is scoped to THIS repo,
# so cloning a third-party repo (e.g. nvm-sh/nvm) over git returns 403, whereas
# both HTTPS hosts are on the default "Trusted" network allowlist. So this works
# at every network-access level without touching the git proxy.
ensure_node() {
  local want want_major
  want="$(tr -d '[:space:]' < .nvmrc 2>/dev/null || true)"
  : "${want:=24}"
  want_major="${want%%.*}"

  # Already on a new-enough node? Nothing to do.
  if command -v node >/dev/null 2>&1; then
    local have_major
    have_major="$(node -v | sed 's/^v//; s/\..*//')"
    if [ "${have_major:-0}" -ge "$want_major" ] 2>/dev/null; then
      echo "node $(node -v) satisfies Node >=${want_major} — skipping nvm"
      return 0
    fi
    echo "node $(node -v) is older than required Node ${want} — provisioning via nvm…"
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  # nvm is NOT compatible with `set -euo pipefail` — its own README says so.
  # Sourcing nvm.sh and running nvm subcommands trip errexit/nounset/pipefail on
  # code paths we don't control. On the first-time-install path this surfaced as
  # a silent `exit 3` that aborted the whole bootstrap before the best-effort
  # steps (npm ci, dev DB, hooks) ran — and BEFORE the `retry` below, since the
  # death was at `. nvm.sh` / `nvm use`, neither of which was guarded. So: relax
  # the strict options for the entire nvm region (source + install + use +
  # alias) and restore them after. Only `nvm install` is retried — it owns the
  # network-prone steps (nvm's pre-fetch version resolution and the nodejs.org
  # tarball download) that hit the provisioning-time race; `use`/`alias` chain
  # after it as local-state ops that need no retry. All of it is idempotent.
  #
  # We hard-restore `set -euo pipefail` afterwards rather than snapshotting with
  # `set +o`: command substitution `$(set +o)` captures errexit as OFF (bash
  # auto-disables errexit inside `$(...)`), so an eval-restore would silently
  # leave errexit disabled for the rest of the bootstrap. The script header pins
  # these three options, so re-asserting them literally is correct and clearer.
  set +e +u +o pipefail           # relax: nvm trips errexit/nounset/pipefail
  # nvm ships pre-installed on the cloud VMs; restore just nvm.sh over HTTPS if a
  # box is missing it (never `git clone` — see note above).
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "nvm not found — fetching nvm.sh over HTTPS…"
    mkdir -p "$NVM_DIR"
    # Retry: the proxied network may not be ready at provisioning time.
    retry curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/nvm.sh -o "$NVM_DIR/nvm.sh"
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  retry nvm install "$want" \
    && nvm use "$want" >/dev/null \
    && nvm alias default "$want" >/dev/null
  set -euo pipefail               # restore the strict bootstrap options

  # Verify we actually ended up on a new-enough node and fail LOUD + actionable,
  # rather than letting `npm ci` die later with a cryptic EBADENGINE (or, worse,
  # the bootstrap exiting with an opaque code and no explanation).
  if ! command -v node >/dev/null 2>&1; then
    echo "error: node provisioning failed — no 'node' on PATH after 'nvm install ${want}'." >&2
    echo "       Fix: run 'nvm install ${want}' manually, then re-run scripts/setup.sh." >&2
    exit 1
  fi
  local now_major
  now_major="$(node -v | sed 's/^v//; s/\..*//')"
  if ! [ "${now_major:-0}" -ge "$want_major" ] 2>/dev/null; then
    echo "error: node $(node -v) is still older than required Node ${want} after provisioning." >&2
    echo "       Fix: run 'nvm install ${want} && nvm use ${want}', then re-run scripts/setup.sh." >&2
    exit 1
  fi
  echo "using node $(node -v) (npm $(npm -v)); nvm default -> Node ${want}"

  # Make the provisioned Node the one EVERY shell sees — not just the ones that
  # source nvm.sh. Agent tooling and CI steps spawn non-login, non-interactive
  # shells that read a captured PATH placing the system Node (/opt/node22) ahead
  # of nvm's shims; nvm only rewrites PATH for shells that source it, so those
  # shells fall through to the old Node and trip `engine-strict` (Node ${want}
  # required) on `npm ci` / `npm test`. `~/.local/bin` is already first on PATH
  # in these environments, so a node/npm/npx symlink there wins everywhere with
  # no per-command `nvm use`. Idempotent; harmless if ~/.local/bin isn't on PATH.
  local node_bin shim_dir b
  node_bin="$(dirname "$(command -v node)")"
  shim_dir="$HOME/.local/bin"
  if [ -n "$node_bin" ] && [ -d "$node_bin" ] && [ "$node_bin" != "$shim_dir" ]; then
    mkdir -p "$shim_dir"
    for b in node npm npx corepack; do
      [ -x "$node_bin/$b" ] && ln -sf "$node_bin/$b" "$shim_dir/$b"
    done
    echo "shimmed $shim_dir/{node,npm,npx} -> $node_bin (Node ${want} wins on PATH for all shells)"
  fi
}
ensure_node

npm ci
# Playwright's chromium for e2e (no longer pulled by a package.json postinstall
# — removed in #816, dead weight on the many CI jobs that never run e2e). This
# is BEST-EFFORT: e2e is not needed to build, test, or commit, and the 177 MB
# download from cdn.playwright.dev is both flaky and off the default "Trusted"
# network allowlist, so it must never sink the rest of the bootstrap. Skip the
# download whenever a Chromium is ALREADY available:
#   * PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 — explicit opt-out (some CI/VMs); or
#   * an existing chromium build under PLAYWRIGHT_BROWSERS_PATH (or the default
#     cache) — Claude's cloud VMs preinstall one and point
#     PLAYWRIGHT_BROWSERS_PATH at it, so e2e runs against that browser (via
#     playwright.config's executablePath when the pinned build differs) instead
#     of re-downloading a version-matched build that may not even be reachable.
pw_path="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
if [ "${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-}" = "1" ]; then
  echo "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 — skipping playwright install"
elif compgen -G "$pw_path/chromium-*" >/dev/null 2>&1 || [ -e "$pw_path/chromium" ]; then
  echo "Chromium already present under $pw_path — skipping playwright install"
else
  npx playwright install chromium \
    || echo "warning: playwright chromium install failed — run 'npx playwright install chromium' before e2e tests"
fi
cp -n src-tauri/.env.example src-tauri/.env 2>/dev/null || true
node scripts/prepare-external-bins.mjs --placeholder-only
# Provision the sqlx offline-check dev DB so `cargo sqlx prepare --check`
# (pre-push Phase E) passes locally. Non-fatal: a frontend-only setup (or one
# without network for the sqlx-cli install) still completes.
bash scripts/setup-dev-db.sh || echo "warning: dev DB setup skipped — run scripts/setup-dev-db.sh before pushing Rust changes"

# --- Rust link-speed: auto-wire a faster linker (Linux, best-effort) --------
# The link step is the long pole of incremental Rust compiles on this codebase
# (see docs/BUILD.md → "Speed up Rust builds"), and a faster linker (mold, else
# lld) cuts it substantially. This used to be a manual
# `cp .cargo/config.toml.example .cargo/config.toml` step — which meant the
# single biggest build-time win sat unused on most machines. Wire it here so it
# applies by default instead of by opt-in.
#
# Best-effort and idempotent: guarded from `set -e`, only touches the Linux host
# triple (so Android/cross builds are unaffected), skips when no fast linker is
# on PATH, and NEVER overwrites an existing `.cargo/config.toml` (a manual
# override always wins). The file it writes is gitignored, so it never leaks
# into the tree — a fresh clone without mold/lld just keeps the default linker.
ensure_fast_linker() {
  local host ld
  host="$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')"
  case "$host" in
    *-linux-gnu) ;;                # only the Linux host toolchain
    *) return 0 ;;                 # macOS/Windows/cross: leave the default linker
  esac
  if [ -f .cargo/config.toml ]; then
    echo "fast-linker: .cargo/config.toml already present — leaving it untouched"
    return 0
  fi
  if command -v mold >/dev/null 2>&1; then
    ld=mold
  elif command -v ld.lld >/dev/null 2>&1 || command -v lld >/dev/null 2>&1; then
    ld=lld
  else
    echo "fast-linker: no mold/lld on PATH — using the default linker (install mold for ~60% faster incremental links)"
    return 0
  fi
  mkdir -p .cargo
  cat > .cargo/config.toml <<EOF
# Auto-generated by scripts/setup.sh — faster incremental links via ${ld}.
# Gitignored (never committed). Delete to revert to the default linker; edit
# freely, setup.sh won't overwrite an existing file. See docs/BUILD.md.
[target.${host}]
rustflags = ["-C", "link-arg=-fuse-ld=${ld}"]
EOF
  echo "fast-linker: wired ${ld} for ${host} (.cargo/config.toml)"
}
ensure_fast_linker || echo "warning: fast-linker auto-wire skipped (non-fatal)"
# Install the prek hook toolchain (every binary the commit/push hooks call)
# and wire the git hooks. Best-effort + idempotent: never fatal, so a missing
# tool can't block a fresh clone from building. Re-run scripts/setup-hooks.sh
# (or `just install-hooks`) to fill any gaps reported above.
#
# This is by far the SLOWEST part of setup: it fetches ~10 cargo tools and a
# system shellcheck, and only THEN wires the git hooks (the wiring is the very
# last step). Under the remote SessionStart hook, all of setup.sh shares one hard
# ~600s provisioning budget — and the hook-toolchain install reproducibly
# overran it: the provisioner SIGKILLed setup mid-install (right after
# cargo-machete), so the slower tools never landed and — because wiring runs
# last — the git hooks were left UNWIRED. The fast critical path above (Node,
# npm ci, .env, dev DB) had already finished by then, so the clone was
# build/test-ready; only the commit/push gate was missing.
#
# Fix: when provisioning a remote sandbox, run this step DETACHED instead of on
# the time-boxed critical path. setsid puts it in its own session so the
# provisioner reaping the (now fast-returning) SessionStart hook can't take it
# down with a process-group signal; output is redirected to a log. The session lands
# build/test-ready immediately and the hooks finish wiring a couple of minutes
# later. It's best-effort + idempotent, so a detached run that is itself cut
# short (e.g. the container is reclaimed) just gets completed on the next
# session start. Local/manual runs stay synchronous — there's no hook timeout
# there and a developer wants to watch it finish.
hooks_log="${TMPDIR:-/tmp}/agaric-setup-hooks.log"
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && command -v setsid >/dev/null 2>&1; then
  echo "Provisioning the prek hook toolchain in the background (log: ${hooks_log})…"
  echo "  Watch with: tail -f ${hooks_log}"
  echo "  Git hooks become active once it logs 'git hooks wired'; until then commits"
  echo "  still work (those checks run in CI). Re-run scripts/setup-hooks.sh to fill gaps."
  setsid bash scripts/setup-hooks.sh </dev/null >"${hooks_log}" 2>&1 &
  disown 2>/dev/null || true
else
  bash scripts/setup-hooks.sh || echo "warning: hook toolchain setup skipped — run scripts/setup-hooks.sh before committing"
fi
echo "Ready. Run: cargo tauri dev"
