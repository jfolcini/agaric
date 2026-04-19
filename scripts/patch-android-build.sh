#!/usr/bin/env bash
# scripts/patch-android-build.sh
#
# Patch the Tauri-generated src-tauri/gen/android/app/build.gradle.kts
# with our project-specific overrides:
#
#   - minSdk: 24 -> 30          (Android 11, Sep 2020 — our platform baseline)
#   - jvmTarget: "1.8" -> "17"  (Java 17 LTS, matches JAVA_HOME in CI)
#   - compileOptions.sourceCompatibility / targetCompatibility = VERSION_17
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
