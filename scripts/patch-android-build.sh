#!/usr/bin/env bash
# scripts/patch-android-build.sh
#
# Patch the Tauri-generated src-tauri/gen/android/ scaffold with our
# project-specific overrides:
#
#   - minSdk: 24 -> 30          (Android 11, Sep 2020 — our platform baseline)
#   - jvmTarget: "1.8" -> "17"  (Java 17 LTS, matches JAVA_HOME in CI)
#   - compileOptions.sourceCompatibility / targetCompatibility = VERSION_17
#   - distributionSha256Sum in the Gradle wrapper properties, so the wrapper
#     refuses a Gradle distribution that differs from the one we vetted.
#   - launcher icons: replace Tauri's generic placeholder with the agaric
#     mushroom (regenerated from app-icon.json -> public/agaric.svg).
#
# The Tauri Android generated folder (`src-tauri/gen/android/`) is listed
# in `.gitignore` because Tauri regenerates it on `cargo tauri android init`
# and on a missing-folder state. That means any manual edits we make to
# the generated `build.gradle.kts` are fragile — this script re-applies
# them idempotently and should be run:
#
#   1. After `cargo tauri android init` on a fresh checkout.
#   2. After a Tauri upgrade if the generated file structure shifts
#      (rerun this script and eyeball the diff; update the sed patterns
#      here if Tauri's template changes the exact lines).
#
# CI calls this script between `cargo tauri android init` (implicit, on
# first `android build` invocation) and the actual build.
#
# The sed patterns below match the line shape Tauri 2 emits today. If
# Tauri reshapes the template, this script will no-op silently (leaving
# the defaults in place) rather than fail — if that happens, re-derive
# the patterns from the diff and update this file.

set -euo pipefail

FILE="src-tauri/gen/android/app/build.gradle.kts"

if [[ ! -f "$FILE" ]]; then
  echo "error: $FILE not found — run 'cargo tauri android init' first" >&2
  exit 1
fi

# Apply minSdk bump (24 -> 30). Already-patched files are a no-op.
sed -i.bak -E 's/^(\s*minSdk = )24$/\130/' "$FILE"

# Apply jvmTarget bump ("1.8" -> "17"). Already-patched files are a no-op.
sed -i.bak -E 's/^(\s*jvmTarget = )"1\.8"$/\1"17"/' "$FILE"

# Add compileOptions block with sourceCompatibility / targetCompatibility
# if it isn't already present. We insert right before the existing
# `kotlinOptions {` block so Java settings sit next to Kotlin settings.
if ! grep -q 'sourceCompatibility = JavaVersion.VERSION_17' "$FILE"; then
  # Use awk because sed's multi-line insert syntax is ugly and fragile.
  awk '
    /^    kotlinOptions \{/ && !inserted {
      print "    compileOptions {"
      print "        sourceCompatibility = JavaVersion.VERSION_17"
      print "        targetCompatibility = JavaVersion.VERSION_17"
      print "    }"
      inserted = 1
    }
    { print }
  ' "$FILE" > "$FILE.new"
  mv "$FILE.new" "$FILE"
fi

rm -f "$FILE.bak"

echo "patched $FILE — minSdk=30, jvmTarget=17, Java 17 compileOptions"

# ── Gradle wrapper checksum ───────────────────────────────────────────
# The wrapper downloads Gradle at build time; distributionSha256Sum makes it
# verify what it downloaded. Unlike the sed patterns above this FAILS CLOSED:
# a Gradle version bump from `tauri-cli` must come with its checksum here, from
# the matching https://services.gradle.org/distributions/gradle-<ver>-bin.zip.sha256
# (the Gradle project's official checksum for that exact distribution). The
# version is the one the pinned `@tauri-apps/cli` template emits (its
# `gradle-wrapper.properties`).
WRAPPER="src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties"

if [[ ! -f "$WRAPPER" ]]; then
  echo "error: $WRAPPER not found — run 'cargo tauri android init' first" >&2
  exit 1
fi

distribution_url="$(sed -n 's/^distributionUrl=//p' "$WRAPPER")"
case "$distribution_url" in
  'https\://services.gradle.org/distributions/gradle-9.6.1-bin.zip')
    gradle_sha256="9c0f7faeeb306cb14e4279a3e084ca6b596894089a0638e68a07c945a32c9e14"
    ;;
  *)
    echo "error: no pinned checksum for $WRAPPER distributionUrl '$distribution_url'." >&2
    echo "  Add a case above with the value from <distributionUrl>.sha256 and re-run." >&2
    exit 1
    ;;
esac

sed -i.bak '/^distributionSha256Sum=/d' "$WRAPPER"
rm -f "$WRAPPER.bak"
# The properties file may lack a trailing newline.
[[ -z "$(tail -c1 "$WRAPPER")" ]] || echo >> "$WRAPPER"
echo "distributionSha256Sum=$gradle_sha256" >> "$WRAPPER"

echo "patched $WRAPPER — distributionSha256Sum pinned"

# ── Launcher icons ────────────────────────────────────────────────────
# `cargo tauri android init` emits Tauri's generic placeholder launcher
# icon. Regenerate the Android mipmaps + adaptive icon from our manifest
# (app-icon.json -> public/agaric.svg foreground on a white background).
# `tauri icon` also rewrites the committed desktop/iOS icons under
# src-tauri/icons/ (already correct and version-controlled), so we restore
# those afterwards to keep the working tree clean.
MANIFEST="app-icon.json"
if [[ -f "$MANIFEST" ]]; then
  if npm run --silent tauri -- icon "$MANIFEST" >/dev/null 2>&1; then
    git checkout -- src-tauri/icons 2>/dev/null || true
    git clean -fdq src-tauri/icons 2>/dev/null || true
    echo "regenerated Android launcher icons from $MANIFEST"
  else
    echo "warning: 'npm run tauri -- icon $MANIFEST' failed — Android icons left as generated by 'android init'" >&2
  fi
else
  echo "warning: $MANIFEST not found — skipping Android icon regeneration" >&2
fi
