#!/usr/bin/env bash
# Android dev-environment setup (`just setup-android`). Idempotent: whatever is
# already present is skipped, so re-running is cheap and safe.
#
# Versions are NOT repeated here. The SDK packages and the Rust targets are read
# from the `android-build` job in .github/workflows/ci.yml, so this script and CI
# cannot disagree; the script refuses to run if it cannot parse them.
#
# It never edits your shell profile and never downloads Google's command-line
# tools: with no SDK it prints how to get them. It does not run the emulator.
set -euo pipefail

usage() {
  echo 'Usage: bash scripts/setup-android.sh [--check] [--init-project]'
  echo '  --check         Report what is present and what would be done; change nothing.'
  echo '                  Exit 0 when nothing is left to do, 1 otherwise.'
  echo '  --init-project  Also regenerate src-tauri/gen/android (cargo tauri android init,'
  echo '                  then scripts/patch-android-build.sh). Destructive to untracked files'
  echo '                  under that directory, hence opt-in.'
}

# `--help` wins regardless of position, same as scripts/setup.sh.
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
  esac
done

check=false
init_project=false
for arg in "$@"; do
  case "$arg" in
    --check) check=true ;;
    --init-project) init_project=true ;;
    *)
      echo "error: unknown setup-android option: $arg" >&2
      exit 64
      ;;
  esac
done

cd "$(dirname "${BASH_SOURCE[0]}")/.."

avd_name=spike_test
ci_file=.github/workflows/ci.yml
# A cold NDK download is large; this only catches a genuine hang.
install_timeout=1800

die() { echo "error: $*" >&2; exit 1; }

# --- Versions: read from CI -------------------------------------------------
# Scoped to the android-build job so the Linux build job's own steps are never
# mistaken for it. A job key sits at two-space indent.
ci_job="$(awk '/^  android-build:/{on=1; next} on && /^  [A-Za-z0-9_-]+:/{exit} on' "$ci_file")"
[ -n "$ci_job" ] || die "no android-build job found in $ci_file; this script reads its versions from there"

ci_packages=()
while IFS= read -r line; do ci_packages+=("$line"); done < <(
  printf '%s\n' "$ci_job" | awk '
    /packages: >/ {on=1; next}
    on && /;/ {gsub(/^[ \t]+|[ \t]+$/, ""); print; next}
    on {exit}'
)
rust_targets=()
while IFS= read -r line; do rust_targets+=("$line"); done < <(
  printf '%s\n' "$ci_job" | sed -n 's/^ *targets: *//p' | head -1 | tr ',' '\n'
)

platform_pkg=''
ndk_pkg=''
buildtools_pkg=''
for p in ${ci_packages[@]+"${ci_packages[@]}"}; do
  case "$p" in
    platforms\;*) platform_pkg="$p" ;;
    build-tools\;*) buildtools_pkg="$p" ;;
    ndk\;*) ndk_pkg="$p" ;;
  esac
done
{ [ -n "$platform_pkg" ] && [ -n "$buildtools_pkg" ] && [ -n "$ndk_pkg" ] && [ "${#rust_targets[@]}" -gt 0 ]; } \
  || die "could not read the platform, build-tools, NDK and Rust targets from the android-build job in $ci_file"

ndk_version="${ndk_pkg#ndk;}"
api_level="${platform_pkg#platforms;android-}"
image_pkg="system-images;android-${api_level};google_apis;x86_64"
# CI does not pin these; they track the platform above or are unversioned.
sdk_packages=("platform-tools" "$platform_pkg" "$buildtools_pkg" "$ndk_pkg" "emulator" "$image_pkg")

problems=()
installed=()
present=()
pending=()   # check mode: what a real run would do

# --- 1. Prerequisites -------------------------------------------------------
echo "== Prerequisites"

java_bin=''
if [ -n "${JAVA_HOME:-}" ]; then
  java_bin="$JAVA_HOME/bin/java"
  [ -x "$java_bin" ] || { problems+=("JAVA_HOME ($JAVA_HOME) has no bin/java; point it at a JDK 17"); java_bin=''; }
elif command -v java >/dev/null 2>&1; then
  java_bin="$(command -v java)"
  echo "note: JAVA_HOME is unset; using $java_bin. Gradle works with this, but export JAVA_HOME to a JDK 17 to be explicit."
else
  problems+=("Java 17 not found: install a JDK 17 and export JAVA_HOME (for example /usr/lib/jvm/java-17-openjdk-amd64)")
fi
if [ -n "$java_bin" ]; then
  java_major="$("$java_bin" -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1 || true)"
  if [ "$java_major" = 17 ]; then
    echo "[ok] Java 17 ($java_bin)"
  else
    problems+=("Java ${java_major:-unknown} at $java_bin; the Android build needs Java 17 (set JAVA_HOME to a JDK 17)")
  fi
fi

sdk="${ANDROID_HOME:-}"
if [ -z "$sdk" ] && [ -d "$HOME/Android/Sdk" ]; then
  sdk="$HOME/Android/Sdk"
  echo "note: ANDROID_HOME is unset; using $sdk"
fi
sdk_instructions="install the Android command-line tools: download 'Command line tools only' from
    https://developer.android.com/studio#command-line-tools-only
  and unpack it so that <sdk>/cmdline-tools/latest/bin/sdkmanager exists (for example
  <sdk> = ~/Android/Sdk), then export ANDROID_HOME=<sdk> and re-run this script."
if [ -z "$sdk" ]; then
  problems+=("no Android SDK: ANDROID_HOME is unset and ~/Android/Sdk does not exist. To fix, $sdk_instructions")
elif [ ! -d "$sdk" ]; then
  problems+=("ANDROID_HOME ($sdk) is not a directory. To fix, $sdk_instructions")
  sdk=''
else
  echo "[ok] Android SDK at $sdk"
fi

# The SDK's own tools win over PATH so they match the SDK being provisioned.
find_tool() {
  local t
  for t in "$sdk"/cmdline-tools/latest/bin/"$1" "$sdk"/cmdline-tools/*/bin/"$1"; do
    if [ -x "$t" ]; then echo "$t"; return 0; fi
  done
  command -v "$1" 2>/dev/null || true
}
android_cli=''
sdkmanager=''
avdmanager=''
if [ -n "$sdk" ]; then
  android_cli="$(find_tool android)"
  sdkmanager="$(find_tool sdkmanager)"
  avdmanager="$(find_tool avdmanager)"
  if [ -n "$android_cli" ] || [ -n "$sdkmanager" ]; then
    echo "[ok] SDK installer: ${android_cli:-$sdkmanager}"
  else
    problems+=("neither 'android' nor 'sdkmanager' found under $sdk/cmdline-tools or on PATH. To fix, $sdk_instructions")
  fi
fi

if ! command -v rustup >/dev/null 2>&1; then
  problems+=("rustup not found: install it from https://rustup.rs")
else
  echo "[ok] rustup"
fi

if [ "${#problems[@]}" -gt 0 ]; then
  for p in "${problems[@]}"; do echo "[missing] $p" >&2; done
  if [ "$check" = false ]; then
    echo "Fix the above and re-run. Nothing was changed." >&2
    exit 1
  fi
fi

# --- 2. SDK packages --------------------------------------------------------
echo "== SDK packages (versions from $ci_file)"

with_timeout() {
  if command -v timeout >/dev/null 2>&1; then timeout "${install_timeout}s" "$@"; else "$@"; fi
}

install_sdk_packages() {
  local rc=0 p
  local -a slashed=()
  if [ -n "$android_cli" ]; then
    # The android CLI downloads itself into ~/.android/bin on first use and prints
    # nothing while it does; say so, or the pause looks like a hang.
    if [ -z "$(ls -A "$HOME/.android/bin" 2>/dev/null)" ]; then
      echo "note: first run of the android CLI downloads it into ~/.android/bin and prints nothing meanwhile; give it a few minutes (gives up after ${install_timeout}s)."
    fi
    # Package names take slashes here, and licences need no separate step.
    for p in "$@"; do slashed+=("${p//;//}"); done
    with_timeout "$android_cli" --sdk="$sdk" sdk install "${slashed[@]}" || rc=$?
  else
    # No android CLI: older cmdline-tools. Accept licences non-interactively.
    with_timeout "$sdkmanager" --sdk_root="$sdk" --licenses < <(yes) >/dev/null || true
    with_timeout "$sdkmanager" --sdk_root="$sdk" "$@" || rc=$?
  fi
  if [ "$rc" -eq 124 ]; then
    die "SDK install timed out after ${install_timeout}s; re-run to resume (finished packages are skipped)"
  elif [ "$rc" -ne 0 ]; then
    die "SDK install failed (exit $rc)"
  fi
}

missing_sdk=()
for p in "${sdk_packages[@]}"; do
  if [ -n "$sdk" ] && [ -d "$sdk/${p//;//}" ]; then
    echo "[skip] $p (present)"
    present+=("$p")
  else
    echo "[$([ "$check" = true ] && echo would-install || echo install)] $p"
    missing_sdk+=("$p")
  fi
done
if [ "${#missing_sdk[@]}" -gt 0 ]; then
  if [ "$check" = true ]; then
    pending+=("SDK packages: ${missing_sdk[*]}")
  else
    install_sdk_packages "${missing_sdk[@]}"
    installed+=("${missing_sdk[@]}")
  fi
fi

# --- 3. Rust targets --------------------------------------------------------
echo "== Rust targets"
have_targets=''
command -v rustup >/dev/null 2>&1 && have_targets="$(rustup target list --installed 2>/dev/null || true)"
missing_targets=()
for t in "${rust_targets[@]}"; do
  if printf '%s\n' "$have_targets" | grep -qx "$t"; then
    echo "[skip] $t (present)"
    present+=("rust target $t")
  else
    echo "[$([ "$check" = true ] && echo would-add || echo add)] $t"
    missing_targets+=("$t")
  fi
done
if [ "${#missing_targets[@]}" -gt 0 ]; then
  if [ "$check" = true ]; then
    pending+=("Rust targets: ${missing_targets[*]}")
  else
    rustup target add "${missing_targets[@]}"
    installed+=("rust target ${missing_targets[*]}")
  fi
fi

# --- 4. Environment variables (printed, never written) ----------------------
echo "== Environment"
ndk_path="${sdk:-<sdk>}/ndk/$ndk_version"
export_lines=()
for pair in "ANDROID_HOME=${sdk:-<sdk>}" "ANDROID_NDK_HOME=$ndk_path" "NDK_HOME=$ndk_path"; do
  name="${pair%%=*}"
  want="${pair#*=}"
  if [ "${!name:-}" = "$want" ]; then
    echo "[ok] $name already set"
  else
    echo "[todo] $name is ${!name:-unset}${!name:+ (want $want)}"
    export_lines+=("export $name=\"$want\"")
  fi
done
if [ "${#export_lines[@]}" -gt 0 ]; then
  echo "Add these to your shell profile (this script does not edit it):"
  printf '  %s\n' "${export_lines[@]}"
fi

# --- 5. AVD -----------------------------------------------------------------
echo "== Emulator AVD ($avd_name)"
avd_home="${ANDROID_AVD_HOME:-${ANDROID_USER_HOME:-$HOME/.android}/avd}"
if [ -f "$avd_home/$avd_name.ini" ]; then
  echo "[skip] $avd_name (present in $avd_home)"
  present+=("AVD $avd_name")
elif [ "$check" = true ]; then
  echo "[would-create] $avd_name from $image_pkg"
  pending+=("AVD $avd_name")
elif [ -z "$avdmanager" ]; then
  die "avdmanager not found under $sdk/cmdline-tools or on PATH; install the command-line tools (see above)"
else
  # `android emulator create` cannot name the AVD, so avdmanager. The `no`
  # answers its "custom hardware profile?" prompt.
  ANDROID_HOME="$sdk" "$avdmanager" create avd -n "$avd_name" -k "$image_pkg" <<< no
  installed+=("AVD $avd_name")
fi

# --- 6. Optional: regenerate the Android project ----------------------------
gen_dir=src-tauri/gen/android
if [ "$init_project" = true ]; then
  echo "== Regenerate $gen_dir"
  if [ "$check" = true ]; then
    echo "[would-run] cargo tauri android init, then scripts/patch-android-build.sh"
    pending+=("regenerate $gen_dir")
  else
    if ! { command -v cargo >/dev/null 2>&1 && cargo tauri --version >/dev/null 2>&1; }; then
      die "cargo-tauri not found: cargo install tauri-cli --locked"
    fi
    # Same sequence as the android-build job in ci.yml: tauri validates the
    # externalBin path on every invocation, and a half-initialised scaffold
    # (only the tracked overrides present) makes init fail, so stash the tracked
    # files, wipe, init, and restore them on top.
    node scripts/prepare-external-bins.mjs --placeholder-only
    overrides="$(mktemp -d)"
    if [ -d "$gen_dir" ]; then
      while IFS= read -r f; do
        rel="${f#"$gen_dir"/}"
        mkdir -p "$overrides/$(dirname "$rel")"
        cp "$f" "$overrides/$rel"
      done < <(git ls-files "$gen_dir")
      rm -rf "$gen_dir"
    fi
    init_rc=0
    NDK_HOME="$sdk/ndk/$ndk_version" cargo tauri android init || init_rc=$?
    mkdir -p "$gen_dir"
    if find "$overrides" -mindepth 1 -print -quit | grep -q .; then
      cp -R "$overrides/." "$gen_dir/"
    fi
    rm -rf "$overrides"
    [ "$init_rc" -eq 0 ] || die "cargo tauri android init failed (exit $init_rc); the tracked overrides under $gen_dir were restored"
    # The generated gradle files need our minSdk / jvmTarget overrides.
    bash scripts/patch-android-build.sh
    installed+=("regenerated $gen_dir (patched)")
  fi
elif [ ! -f "$gen_dir/build.gradle.kts" ]; then
  echo "note: $gen_dir is not initialised; re-run with --init-project to generate it."
fi

# --- 7. Summary -------------------------------------------------------------
echo "== Summary"
if [ "$check" = true ]; then
  echo "(check mode: nothing was changed)"
  [ "${#pending[@]}" -eq 0 ] || { echo "Would do:"; printf '  - %s\n' "${pending[@]}"; }
else
  if [ "${#installed[@]}" -eq 0 ]; then
    echo "Installed: nothing new"
  else
    echo "Installed:"
    printf '  - %s\n' "${installed[@]}"
  fi
fi
echo "Already present: ${#present[@]}"
if [ "${#problems[@]}" -gt 0 ]; then
  echo "Problems:"
  printf '  - %s\n' "${problems[@]}"
fi
echo "Next:"
[ "${#export_lines[@]}" -eq 0 ] || echo "  (export the variables above first)"
echo "  just android"
echo "  ${sdk:-<sdk>}/emulator/emulator -avd $avd_name -gpu host"

if [ "$check" = true ] && { [ "${#pending[@]}" -gt 0 ] || [ "${#problems[@]}" -gt 0 ]; }; then
  exit 1
fi
