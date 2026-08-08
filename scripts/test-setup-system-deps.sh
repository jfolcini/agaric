#!/usr/bin/env bash
# Behavioural self-test for setup-system-deps.sh and its remote-session wiring.
# Every privileged/network command is a fake placed first on PATH.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
helper="$repo_root/scripts/setup-system-deps.sh"
setup="$repo_root/scripts/setup.sh"
session_hook="$repo_root/.claude/hooks/session-start.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fake_bin="$tmp/bin"
state="$tmp/installed"
log="$tmp/calls"
mkdir -p "$fake_bin"
: >"$state"
: >"$log"

cat >"$fake_bin/fake-command" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
# Pure parameter expansion, not `basename`: these fakes must keep working under
# a PATH restricted to this directory alone (see the non-Debian probe), where
# no coreutils binary is reachable.
name="${0##*/}"
case "$name" in
  uname)
    printf '%s\n' "${FAKE_UNAME:-Linux}"
    ;;
  id)
    [ "${1:-}" = '-u' ] || exit 64
    printf '%s\n' "${FAKE_UID:-0}"
    ;;
  dpkg-query)
    package="${*: -1}"
    if grep -Fxq "$package" "$FAKE_STATE"; then
      printf 'install ok installed'
      exit 0
    fi
    exit 1
    ;;
  apt-get)
    printf 'apt-get|%s|DEBIAN_FRONTEND=%s\n' "$*" "${DEBIAN_FRONTEND:-}" >>"$FAKE_LOG"
    if [[ " $* " == *' update '* ]] && [ "${FAKE_APT_UPDATE_FAIL:-0}" = 1 ]; then
      exit 42
    fi
    if [[ " $* " == *' install '* ]]; then
      [ "${FAKE_APT_INSTALL_FAIL:-0}" = 1 ] && exit 43
      # "apt exits 0 but installed nothing" — a stale index, a package that
      # resolves to a no-op virtual, or a mirror serving an empty set. apt is
      # truthful about its own exit code and still leaves the build broken,
      # which is exactly what the post-install re-verification exists to catch.
      [ "${FAKE_APT_INSTALL_NOOP:-0}" = 1 ] && exit 0
      installing=false
      for arg in "$@"; do
        if [ "$installing" = true ]; then
          case "$arg" in
            -*) ;;
            *) printf '%s\n' "$arg" >>"$FAKE_STATE" ;;
          esac
        elif [ "$arg" = install ]; then
          installing=true
        fi
      done
    fi
    ;;
  sudo)
    printf 'sudo|%s\n' "$*" >>"$FAKE_LOG"
    [ "${1:-}" = '-n' ] || exit 88
    shift
    [ "${FAKE_SUDO_OK:-0}" = 1 ] || exit 89
    [ "${1:-}" = true ] && exit 0
    exec "$@"
    ;;
  *)
    exit 127
    ;;
esac
FAKE
chmod +x "$fake_bin/fake-command"
for command_name in uname id dpkg-query apt-get sudo; do
  ln -s fake-command "$fake_bin/$command_name"
done

# Hardening: this whole file is only safe because the fakes above shadow the
# REAL apt-get/sudo/dpkg-query. If PATH construction ever regressed, the tests
# would quietly start driving the host's package manager. Assert the shadowing
# before anything privileged-looking runs, and fail closed if it does not hold.
for command_name in uname id dpkg-query apt-get sudo; do
  resolved="$(PATH="$fake_bin:$PATH" command -v "$command_name" || true)"
  case "$resolved" in
    "$fake_bin/$command_name") ;;
    *)
      echo "not ok - refusing to run: '$command_name' resolves to '${resolved:-<nothing>}'," >&2
      echo "         not the fake in $fake_bin. The host must never be mutated." >&2
      exit 1
      ;;
  esac
done
echo 'ok - fakes shadow every privileged command (host cannot be touched)'

# The exact contract this installer owes #3556. Duplicated here on purpose:
# the point of the assertion is that changing the production list is a
# deliberate act that has to be made twice, not a silent drift.
readonly -a expected_packages=(
  libwebkit2gtk-4.1-dev
  libgtk-3-dev
  libssl-dev
  librsvg2-dev
  libsoup-3.0-dev
  pkg-config
  patchelf
)

fail() {
  echo "not ok - $*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1" needle="$2"
  [[ "$haystack" == *"$needle"* ]] || fail "expected output to contain: $needle"
}

assert_empty_log() {
  [ ! -s "$log" ] || fail "expected no privileged/network calls, got: $(tr '\n' ';' <"$log")"
}

run_helper() {
  local status=0
  output="$({
    PATH="$fake_bin:$PATH" \
      FAKE_STATE="$state" \
      FAKE_LOG="$log" \
      FAKE_UID="${FAKE_UID:-0}" \
      FAKE_UNAME="${FAKE_UNAME:-Linux}" \
      FAKE_SUDO_OK="${FAKE_SUDO_OK:-0}" \
      FAKE_APT_UPDATE_FAIL="${FAKE_APT_UPDATE_FAIL:-0}" \
      FAKE_APT_INSTALL_FAIL="${FAKE_APT_INSTALL_FAIL:-0}" \
      FAKE_APT_INSTALL_NOOP="${FAKE_APT_INSTALL_NOOP:-0}" \
      bash "$helper"
  } 2>&1)" || status=$?
  helper_status=$status
}

# 1. Already-provisioned hosts must not touch apt, sudo, or the network.
printf '%s\n' "${expected_packages[@]}" >"$state"
: >"$log"
run_helper
[ "$helper_status" -eq 0 ] || fail 'already-installed case failed'
assert_contains "$output" 'already installed — skipping apt'
assert_empty_log
echo 'ok - installed packages skip every privileged/network command'

# 2. Root installs the exact compile/test set, then a rerun is a no-op.
: >"$state"
: >"$log"
FAKE_UID=0 run_helper
[ "$helper_status" -eq 0 ] || fail 'root install failed'
[ "$(sort -u "$state" | wc -l)" -eq "${#expected_packages[@]}" ] || fail 'wrong package count'
for package in "${expected_packages[@]}"; do
  grep -Fxq "$package" "$state" || fail "missing install package $package"
done
grep -Fq 'apt-get|-o Acquire::Retries=3 update -qq|' "$log" || fail 'missing bounded apt update'
grep -Fq "apt-get|-o Acquire::Retries=3 install -y ${expected_packages[*]}|DEBIAN_FRONTEND=noninteractive" "$log" \
  || fail 'install argv or noninteractive environment drifted'
if grep -Fq 'sudo|' "$log"; then fail 'root path unexpectedly used sudo'; fi
: >"$log"
FAKE_UID=0 run_helper
[ "$helper_status" -eq 0 ] || fail 'idempotent rerun failed'
assert_empty_log
echo "ok - root installs the exact ${#expected_packages[@]}-package set and reruns idempotently"

# 3. A non-root remote uses noninteractive sudo for every privileged call.
: >"$state"
: >"$log"
FAKE_UID=1000 FAKE_SUDO_OK=1 run_helper
[ "$helper_status" -eq 0 ] || fail 'passwordless-sudo install failed'
grep -Fq 'sudo|-n true' "$log" || fail 'sudo capability probe was not noninteractive'
grep -Fq 'sudo|-n apt-get -o Acquire::Retries=3 update -qq' "$log" \
  || fail 'apt update lost sudo -n'
grep -Fq 'sudo|-n env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 install -y' "$log" \
  || fail 'apt install lost sudo -n or noninteractive mode'
echo 'ok - non-root install retains sudo -n throughout'

# 4. Missing privilege fails safely without attempting apt.
: >"$state"
: >"$log"
FAKE_UID=1000 FAKE_SUDO_OK=0 run_helper
[ "$helper_status" -ne 0 ] || fail 'no-privilege case falsely succeeded'
assert_contains "$output" 'without root or passwordless sudo'
if grep -Fq 'apt-get|' "$log"; then fail 'apt ran without privilege'; fi
echo 'ok - unavailable privilege is actionable and never prompts/runs apt'

# 5. Network/update failure is loud and never reports a false success.
: >"$state"
: >"$log"
FAKE_UID=0 FAKE_APT_UPDATE_FAIL=1 run_helper
[ "$helper_status" -ne 0 ] || fail 'failed apt update falsely succeeded'
assert_contains "$output" 'Rust builds/tests may remain unavailable'
if [[ "$output" == *'dependencies installed.'* ]]; then fail 'failure printed success'; fi
echo 'ok - apt failure remains a truthful build/test blocker'

# 6. Package-install failure is independently loud after a successful update.
# The whole compile/test set is missing here (state was cleared), so this is
# THE COMPILE-SET ARM of the #3629 review note-2 pair: it must classify as
# exit 1, not the patchelf-only exit 2 that test 6c below pins.
: >"$state"
: >"$log"
FAKE_UID=0 FAKE_APT_INSTALL_FAIL=1 run_helper
[ "$helper_status" -ne 0 ] || fail 'failed apt install falsely succeeded'
[ "$helper_status" -eq 1 ] || fail "compile-set apt install failure did not classify as exit 1 (got $helper_status)"
assert_contains "$output" 'apt-get install failed; Rust builds/tests may remain unavailable'
grep -Fq 'apt-get|-o Acquire::Retries=3 update -qq|' "$log" \
  || fail 'install-failure case never completed apt update'
grep -Fq 'apt-get|-o Acquire::Retries=3 install -y' "$log" \
  || fail 'install-failure case never exercised apt install'
if [[ "$output" == *'dependencies installed.'* ]]; then fail 'install failure printed success'; fi
echo 'ok - apt install failure remains a truthful build/test blocker (classified exit 1)'

# 6c. THE PATCHELF-ONLY ARM of the same pair (#3629 review note 2). The
# compile/test set (all six non-patchelf packages) is already installed;
# only patchelf is missing, and installing it fails. This must NOT be
# reported with the same severity as #6: exit 2 (not 1), plus wording that
# says the compile/test set is intact rather than an undifferentiated
# "may remain unavailable" that would wrongly implicate the whole workspace.
# Asserting only this arm (without #6 above) would be a half-covered pair —
# a helper that always returned exit 2 would pass this block alone.
: >"$state"
: >"$log"
for package in "${expected_packages[@]}"; do
  [ "$package" = 'patchelf' ] || printf '%s\n' "$package" >>"$state"
done
FAKE_UID=0 FAKE_APT_INSTALL_FAIL=1 run_helper
[ "$helper_status" -ne 0 ] || fail 'patchelf-only apt install failure falsely succeeded'
[ "$helper_status" -eq 2 ] || fail "patchelf-only apt install failure did not classify as exit 2 (got $helper_status)"
assert_contains "$output" 'patchelf'
assert_contains "$output" 'is the only package still missing — the compile/test package set installed fine'
if [[ "$output" == *'dependencies installed.'* ]]; then fail 'patchelf-only failure printed success'; fi
echo 'ok - a patchelf-only install failure is classified separately (exit 2) from a compile-set failure (exit 1)'

# 6b. The other half of #6: apt exits 0 yet the packages are still absent. The
# exit code alone is not evidence of a working build, so the helper re-queries
# dpkg afterwards. Without this arm the whole post-install verification loop
# could be deleted and every other assertion here would still pass green.
: >"$state"
: >"$log"
FAKE_UID=0 FAKE_APT_INSTALL_NOOP=1 run_helper
[ "$helper_status" -ne 0 ] || fail 'apt exiting 0 while installing nothing was reported as success'
assert_contains "$output" 'apt reported success but'
assert_contains "$output" 'build/test package(s) are still missing'
if [[ "$output" == *'dependencies installed.'* ]]; then
  fail 'unverified install printed the success line'
fi
echo 'ok - a lying apt exit code is caught by post-install re-verification'

# 7. The helper is a no-op outside Linux.
: >"$state"
: >"$log"
FAKE_UNAME=Darwin run_helper
[ "$helper_status" -eq 0 ] || fail 'non-Linux no-op failed'
assert_contains "$output" 'not needed on this platform'
assert_empty_log
echo 'ok - non-Linux hosts are untouched'

# 7b. Linux, but not Debian/Ubuntu. The symmetric partner of #7: "not Linux"
# was covered while "Linux without apt" — Fedora/Arch/Alpine — was not, so the
# branch could return 0 and falsely tell setup.sh the deps were provisioned.
#
# PATH here is the fake directory and NOTHING else, deliberately: dropping a
# fake out of a *prepended* PATH would expose the real /usr/bin/apt-get on a
# Debian host. With a single self-owned entry there is no real package manager
# to reach even if this assertion regresses. `$BASH` is absolute, so the
# restricted PATH cannot break the interpreter lookup itself.
nodebian_bin="$tmp/nodebian-bin"
mkdir -p "$nodebian_bin"
for command_name in uname id; do
  ln -s "$fake_bin/fake-command" "$nodebian_bin/$command_name"
done
# The fakes are `#!/usr/bin/env bash`, so the interpreter has to be resolvable
# from the restricted PATH too. An interpreter is not a package manager: the
# safety property asserted below is specifically that apt/dpkg/sudo are gone.
ln -s "$BASH" "$nodebian_bin/bash"
for command_name in apt-get dpkg-query sudo; do
  [ -z "$(PATH="$nodebian_bin" command -v "$command_name" || true)" ] \
    || fail "non-Debian probe is unsafe: '$command_name' is still reachable"
done

: >"$state"
: >"$log"
nodebian_status=0
nodebian_output="$(
  PATH="$nodebian_bin" FAKE_UNAME=Linux FAKE_UID=0 \
    "$BASH" "$helper" 2>&1
)" || nodebian_status=$?
[ "$nodebian_status" -ne 0 ] || fail 'non-Debian Linux falsely reported deps provisioned'
assert_contains "$nodebian_output" 'supports Debian/Ubuntu only'
assert_contains "$nodebian_output" 'Install manually: sudo apt-get install -y'
if [[ "$nodebian_output" == *'dependencies installed.'* ]]; then
  fail 'non-Debian path printed the success line'
fi
assert_empty_log
echo 'ok - non-Debian Linux fails loudly instead of claiming success'

# 8–9. Execute the real outer setup script in an isolated fake project. Every
# subordinate script/tool is a local stub, HOME/TMPDIR point inside the test
# tempdir, and Playwright download is disabled: this proves dispatch and final
# summary propagation without npm, Cargo, apt, sudo, or network side effects.
outer_project="$tmp/outer-project"
outer_bin="$tmp/outer-bin"
outer_home="$tmp/outer-home"
outer_tmp="$tmp/outer-tmp"
outer_log="$tmp/outer-calls"
mkdir -p "$outer_project/scripts" "$outer_project/src-tauri" "$outer_project/.cargo" \
  "$outer_bin" "$outer_home" "$outer_tmp"
cp "$setup" "$outer_project/scripts/setup.sh"
printf '{"engines":{"node":"^24.15.0"}}\n' >"$outer_project/package.json"
printf '24.15.0\n' >"$outer_project/.nvmrc"
printf '[toolchain]\nchannel = "1.95.0"\n' >"$outer_project/rust-toolchain.toml"
: >"$outer_project/src-tauri/.env.example"
: >"$outer_project/.cargo/config.toml"
: >"$outer_log"

cat >"$outer_project/scripts/setup-system-deps.sh" <<'OUTER_HELPER'
#!/usr/bin/env bash
printf 'system-deps|%s\n' "$*" >>"$OUTER_LOG"
exit "${FAKE_OUTER_HELPER_STATUS:-0}"
OUTER_HELPER
cat >"$outer_project/scripts/setup-dev-db.sh" <<'OUTER_DEV_DB'
#!/usr/bin/env bash
printf 'dev-db\n' >>"$OUTER_LOG"
OUTER_DEV_DB
cat >"$outer_project/scripts/setup-hooks.sh" <<'OUTER_HOOKS'
#!/usr/bin/env bash
printf 'hooks\n' >>"$OUTER_LOG"
OUTER_HOOKS

cat >"$outer_bin/node" <<'OUTER_NODE'
#!/usr/bin/env bash
case "${1:-}" in
  -v) printf 'v24.15.0\n' ;;
  -p) printf '%s\n' '^24.15.0' ;;
  *) ;;
esac
OUTER_NODE
cat >"$outer_bin/npm" <<'OUTER_NPM'
#!/usr/bin/env bash
if [ "${1:-}" = '-v' ]; then printf '11.0.0\n'; fi
OUTER_NPM
cat >"$outer_bin/rustc" <<'OUTER_RUSTC'
#!/usr/bin/env bash
case "${1:-}" in
  --version) printf 'rustc 1.95.0 (fake)\n' ;;
  -vV) printf 'rustc 1.95.0 (fake)\nhost: x86_64-apple-darwin\n' ;;
esac
OUTER_RUSTC
cat >"$outer_bin/cargo" <<'OUTER_CARGO'
#!/usr/bin/env bash
exit 0
OUTER_CARGO
cat >"$outer_bin/uname" <<'OUTER_UNAME'
#!/usr/bin/env bash
printf '%s\n' "${FAKE_OUTER_UNAME:-Darwin}"
OUTER_UNAME
# pkg-config drives setup.sh's Linux preflight banner — the text #3556 says is
# wrong. FAKE_OUTER_WEBKIT=1 means "headers present".
cat >"$outer_bin/pkg-config" <<'OUTER_PKGCONFIG'
#!/usr/bin/env bash
if [ "${1:-}" = '--exists' ]; then
  [ "${FAKE_OUTER_WEBKIT:-0}" = 1 ] && exit 0
  exit 1
fi
exit 0
OUTER_PKGCONFIG
# Tripwires. The default (no-flag) outer setup must reach NEITHER of these; if
# it ever does, the log is non-empty and the assertions below fail loudly.
for privileged in apt-get sudo dpkg-query; do
  cat >"$outer_bin/$privileged" <<'OUTER_PRIVILEGED'
#!/usr/bin/env bash
printf '%s|%s\n' "$(basename "$0")" "$*" >>"$OUTER_PRIV_LOG"
exit 1
OUTER_PRIVILEGED
done
chmod +x "$outer_project/scripts/"*.sh "$outer_bin/"*
outer_priv_log="$tmp/outer-privileged"
: >"$outer_priv_log"

# The same fail-closed check the inner fakes get, applied to the outer PATH.
# The tripwires below are the only thing standing between a regressed gate and
# the host's real apt-get, so verify they actually shadow it before running
# setup.sh even once — a tripwire that silently failed to be created would
# otherwise turn "the gate broke" into "the host got mutated".
for privileged in apt-get sudo dpkg-query; do
  resolved="$(PATH="$outer_bin:$PATH" command -v "$privileged" || true)"
  [ "$resolved" = "$outer_bin/$privileged" ] || fail \
    "refusing to run: '$privileged' resolves to '$resolved', not the outer tripwire in $outer_bin."
done

run_outer_setup() {
  local status=0
  outer_output="$({
    cd "$outer_project"
    PATH="$outer_bin:$PATH" \
      HOME="$outer_home" \
      TMPDIR="$outer_tmp" \
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
      CLAUDE_CODE_REMOTE=false \
      OUTER_LOG="$outer_log" \
      OUTER_PRIV_LOG="$outer_priv_log" \
      FAKE_OUTER_HELPER_STATUS="${FAKE_OUTER_HELPER_STATUS:-0}" \
      FAKE_OUTER_UNAME="${FAKE_OUTER_UNAME:-Darwin}" \
      FAKE_OUTER_WEBKIT="${FAKE_OUTER_WEBKIT:-0}" \
      bash scripts/setup.sh "$@"
  } 2>&1)" || status=$?
  outer_status=$status
}

assert_no_privileged_calls() {
  [ ! -s "$outer_priv_log" ] \
    || fail "setup.sh reached a privileged command: $(tr '\n' ';' <"$outer_priv_log")"
}

: >"$outer_log"
FAKE_OUTER_HELPER_STATUS=91 run_outer_setup
[ "$outer_status" -eq 0 ] || fail 'default outer setup failed in isolated harness'
if grep -Fq 'system-deps|' "$outer_log"; then
  fail 'default outer setup invoked the opt-in system-dependency helper'
fi
assert_contains "$outer_output" 'Ready. Run: cargo tauri dev'
assert_no_privileged_calls
echo 'ok - default outer setup never dispatches the privileged helper'

# 9b. The flag is only a gate if a near-miss is rejected rather than ignored.
# `--install-system-dep` must not silently degrade to a no-flag run (which
# would look identical to success while the remote VM never gets its headers),
# and must not be waved through into the privileged branch either. Strict
# parsing runs before any side effect, so this exits 64 having done nothing.
: >"$outer_log"
: >"$outer_priv_log"
run_outer_setup --install-system-dep
[ "$outer_status" -eq 64 ] || fail "typo'd flag was not rejected with exit 64 (got $outer_status)"
assert_contains "$outer_output" 'unknown setup option: --install-system-dep'
[ ! -s "$outer_log" ] || fail "typo'd flag still dispatched the privileged helper"
assert_no_privileged_calls
echo 'ok - a near-miss flag exits 64 instead of silently skipping'

# 8b. THE NEGATIVE ARM THAT MATTERS. A Linux workstation missing the headers,
# invoking setup.sh the way `npm run setup` / `just setup` do — no flag. The
# gate must hold: nothing privileged runs, the helper is never dispatched, and
# the user gets the *corrected* advisory instead of an install. This is the
# regression that would be worst to ship, so it is asserted end-to-end against
# the real setup.sh rather than by reading its source.
: >"$outer_log"
: >"$outer_priv_log"
FAKE_OUTER_UNAME=Linux FAKE_OUTER_WEBKIT=0 run_outer_setup
[ "$outer_status" -eq 0 ] || fail 'linux warn-only outer setup failed'
if grep -Fq 'system-deps|' "$outer_log"; then
  fail 'linux setup without the flag invoked the privileged helper'
fi
assert_no_privileged_calls
assert_contains "$outer_output" 'Ready except:'
assert_contains "$outer_output" 'libwebkit2gtk-4.1 (system webkit) not found via pkg-config'
# The #3556 wording fix, asserted on real output: the advisory must name the
# compile/test impact, not merely running the app.
assert_contains "$outer_output" 'required to build and test the Rust workspace, not just to run the app'
assert_contains "$outer_output" 'cargo check/nextest fail without them'
if [[ "$outer_output" == *'before running the Tauri app'* ]]; then
  fail 'stale run-only wording resurfaced in the live advisory'
fi
if [[ "$outer_output" == *'Ready. Run: cargo tauri dev'* ]]; then
  fail 'missing headers were reported as fully ready'
fi
echo 'ok - linux without the opt-in warns (corrected copy) and installs nothing'

# 8c. The satisfied case must be quiet: opt-in, helper succeeds, headers now
# resolve — no leftover advisory. Without this, 8b could pass by the advisory
# being unconditional.
: >"$outer_log"
: >"$outer_priv_log"
FAKE_OUTER_UNAME=Linux FAKE_OUTER_WEBKIT=1 FAKE_OUTER_HELPER_STATUS=0 \
  run_outer_setup --install-system-deps
[ "$outer_status" -eq 0 ] || fail 'successful opt-in outer setup failed'
[ "$(grep -Fc 'system-deps|' "$outer_log")" -eq 1 ] \
  || fail 'successful opt-in did not dispatch the helper exactly once'
assert_contains "$outer_output" 'Ready. Run: cargo tauri dev'
if [[ "$outer_output" == *'Ready except:'* ]]; then
  fail 'a satisfied host still reported a system-dependency problem'
fi
echo 'ok - a satisfied host reports ready with no residual advisory'

: >"$outer_log"
FAKE_OUTER_HELPER_STATUS=91 run_outer_setup --install-system-deps
[ "$outer_status" -eq 0 ] || fail 'helper failure aborted the useful outer setup work'
[ "$(grep -Fc 'system-deps|' "$outer_log")" -eq 1 ] \
  || fail 'opt-in outer setup did not dispatch the helper exactly once'
assert_contains "$outer_output" 'Ready except:'
assert_contains "$outer_output" \
  'Linux build/test system dependencies could not be installed automatically'
if [[ "$outer_output" == *'Ready. Run: cargo tauri dev'* ]]; then
  fail 'outer setup hid helper failure behind a false all-ready summary'
fi
echo 'ok - opt-in helper failure reaches the final Ready-except summary'

# 9d/9e. #3629 review note 2, at the setup.sh level: a patchelf-only failure
# (helper exit 2) must get an accurate message (never the compile/test-set
# claim) AND must not suppress the pkg-config webkit probe — the only other
# consumer of the system packages. Two arms, same status=2, opposite webkit
# state, so passing one arm without the other cannot make this block green.
: >"$outer_log"
: >"$outer_priv_log"
FAKE_OUTER_UNAME=Linux FAKE_OUTER_WEBKIT=0 FAKE_OUTER_HELPER_STATUS=2 \
  run_outer_setup --install-system-deps
[ "$outer_status" -eq 0 ] || fail 'patchelf-only outer setup (webkit missing) failed'
assert_no_privileged_calls
assert_contains "$outer_output" 'Ready except:'
assert_contains "$outer_output" 'patchelf (used only when bundling with "cargo tauri build"'
assert_contains "$outer_output" 'the Rust workspace will still compile and test without it'
if [[ "$outer_output" == *'the Rust workspace will not compile or test until they are present'* ]]; then
  fail 'patchelf-only failure (exit 2) was reported with the compile/test-set message'
fi
# The probe must have actually run: with headers genuinely absent it reports
# them absent. If the old blanket "any system_deps_problem -> skip the probe"
# gate regressed, this line would be silently missing instead.
assert_contains "$outer_output" 'libwebkit2gtk-4.1 (system webkit) not found via pkg-config'
echo 'ok - patchelf-only failure gets accurate wording and the webkit probe still runs (headers absent)'

: >"$outer_log"
: >"$outer_priv_log"
FAKE_OUTER_UNAME=Linux FAKE_OUTER_WEBKIT=1 FAKE_OUTER_HELPER_STATUS=2 \
  run_outer_setup --install-system-deps
[ "$outer_status" -eq 0 ] || fail 'patchelf-only outer setup (webkit present) failed'
assert_no_privileged_calls
assert_contains "$outer_output" 'patchelf (used only when bundling with "cargo tauri build"'
if [[ "$outer_output" == *'the Rust workspace will not compile or test until they are present'* ]]; then
  fail 'patchelf-only failure (exit 2) was reported with the compile/test-set message'
fi
# The probe ran and correctly found webkit present: no false "not found" line
# should ride along with the (real, separate) patchelf note.
if [[ "$outer_output" == *'libwebkit2gtk-4.1 (system webkit) not found via pkg-config'* ]]; then
  fail 'webkit probe falsely reported missing headers when FAKE_OUTER_WEBKIT=1'
fi
echo 'ok - patchelf-only failure leaves the (satisfied) webkit probe result untouched'

# 9f. #3629 review note 1: the opt-in apt dispatch must run AFTER
# setup-dev-db.sh, not ahead of the fast Node/npm-ci/.env/dev-DB critical
# path. The outer stubs append to $outer_log in the order they actually run,
# so their relative line numbers are direct proof of dispatch order — not an
# assumption about the source layout.
: >"$outer_log"
FAKE_OUTER_UNAME=Linux FAKE_OUTER_WEBKIT=1 FAKE_OUTER_HELPER_STATUS=0 \
  run_outer_setup --install-system-deps
[ "$outer_status" -eq 0 ] || fail 'ordering-check outer setup failed'
dev_db_line="$(grep -n '^dev-db$' "$outer_log" | head -1 | cut -d: -f1)"
system_deps_line="$(grep -n '^system-deps|' "$outer_log" | head -1 | cut -d: -f1)"
[ -n "${dev_db_line:-}" ] || fail 'setup-dev-db.sh stub never ran'
[ -n "${system_deps_line:-}" ] || fail 'setup-system-deps.sh stub never ran'
[ "$dev_db_line" -lt "$system_deps_line" ] || fail \
  "apt dispatch ran ahead of setup-dev-db.sh (dev-db@${dev_db_line} system-deps@${system_deps_line}) — holding the fast critical path hostage to apt again"
echo 'ok - the opt-in apt dispatch runs after setup-dev-db.sh, not ahead of the fast critical path'

# 9g/9h. #3629 review note 3: --help must win regardless of position,
# including next to an otherwise-unknown flag. Same two flags, order flipped,
# same result — proves the pre-scan is genuinely position-independent rather
# than merely working for the one ordering a reviewer happened to try.
: >"$outer_log"
: >"$outer_priv_log"
run_outer_setup --bogus --help
[ "$outer_status" -eq 0 ] || fail "--bogus --help did not exit 0 (got $outer_status)"
assert_contains "$outer_output" 'Usage: bash scripts/setup.sh'
[ ! -s "$outer_log" ] || fail '--bogus --help unexpectedly dispatched a setup step'
assert_no_privileged_calls
echo 'ok - --bogus --help shows usage and exits 0 (help wins even after an unknown flag)'

: >"$outer_log"
: >"$outer_priv_log"
run_outer_setup --help --bogus
[ "$outer_status" -eq 0 ] || fail "--help --bogus did not exit 0 (got $outer_status)"
assert_contains "$outer_output" 'Usage: bash scripts/setup.sh'
[ ! -s "$outer_log" ] || fail '--help --bogus unexpectedly dispatched a setup step'
assert_no_privileged_calls
echo 'ok - --help --bogus shows usage and exits 0 (order does not change the result)'

# 10. The session hook gates setup and passes the explicit opt-in only remotely.
hook_project="$tmp/hook-project"
mkdir -p "$hook_project/scripts"
cat >"$hook_project/scripts/setup.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HOOK_LOG"
STUB
chmod +x "$hook_project/scripts/setup.sh"
hook_log="$tmp/hook-calls"
: >"$hook_log"

# UNSET is the state a developer's machine is actually in — distinct from
# "false", and the one the `${CLAUDE_CODE_REMOTE:-}` default has to handle.
# Testing only the explicit "false" would leave the real local case unproven.
env -u CLAUDE_CODE_REMOTE CLAUDE_PROJECT_DIR="$hook_project" HOOK_LOG="$hook_log" \
  bash "$session_hook"
[ ! -s "$hook_log" ] || fail 'session with CLAUDE_CODE_REMOTE unset invoked setup'

CLAUDE_CODE_REMOTE=false CLAUDE_PROJECT_DIR="$hook_project" HOOK_LOG="$hook_log" \
  bash "$session_hook"
[ ! -s "$hook_log" ] || fail 'local session invoked setup'

CLAUDE_CODE_REMOTE=true CLAUDE_PROJECT_DIR="$hook_project" HOOK_LOG="$hook_log" \
  bash "$session_hook"
[ "$(cat "$hook_log")" = '--install-system-deps' ] \
  || fail 'remote session did not pass the exact system-dependency opt-in'
grep -Fq 'bash scripts/setup-system-deps.sh' "$setup" \
  || fail 'setup no longer dispatches to the system-dependency helper'
echo 'ok - the gate opens only for CLAUDE_CODE_REMOTE=true (unset/false stay shut)'

# 11. Source-level backstop for the #3556 wording, in case the advisory is ever
# refactored out of the path 8b drives. Comment lines are stripped first: the
# fix's own commentary quotes the old string to explain why it was wrong, and
# that must not read as a regression.
if grep -v '^[[:space:]]*#' "$setup" | grep -Fq 'before running the Tauri app'; then
  fail 'stale run-only warning returned to scripts/setup.sh'
fi
echo 'ok - the stale run-only wording is gone from scripts/setup.sh'

echo 'all setup-system-deps contract tests passed'
