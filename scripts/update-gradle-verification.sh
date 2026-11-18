#!/usr/bin/env bash
# Regenerate src-tauri/gen/android/gradle/verification-metadata.xml, the sha256
# of every Gradle dependency the Android build resolves (AGENTS.md
# § Supply-chain pinning). Run it after a Tauri, Tauri-plugin or Android
# toolchain bump, when CI's Android build fails with "Dependency verification
# failed".
#
# Needs an initialised project (`bash scripts/setup-android.sh --init-project`)
# that has been built once (`npm run tauri -- android build --target x86_64
# --debug`), which writes tauri.settings.gradle; that build may itself stop at
# the verification failure this script fixes. It builds the variants CI builds,
# minus the Rust libraries, which resolve no Gradle dependency.
set -euo pipefail

cd "$(dirname "$0")/../src-tauri/gen/android"
if [ ! -f tauri.settings.gradle ]; then
  echo "error: src-tauri/gen/android/tauri.settings.gradle is missing — run 'npm run tauri -- android build --target x86_64 --debug' once first" >&2
  exit 1
fi

./gradlew --write-verification-metadata sha256 \
  assembleArm64Release bundleArm64Release \
  assembleX86_64Debug bundleX86_64Debug \
  assembleX86_64Release bundleX86_64Release \
  -x rustBuildArm64Release -x rustBuildX86_64Debug -x rustBuildX86_64Release

# aapt2 ships one jar per OS and Gradle records only this machine's. Add the
# others so the Android build verifies on Linux, macOS and Windows alike.
meta=gradle/verification-metadata.xml
maven=https://dl.google.com/dl/android/maven2/com/android/tools/build/aapt2
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for version in $(sed -n 's/.*name="aapt2" version="\([^"]*\)".*/\1/p' "$meta"); do
  for os in linux osx windows; do
    jar="aapt2-${version}-${os}.jar"
    grep -q "artifact name=\"$jar\"" "$meta" && continue
    curl -fsSL --proto '=https' "$maven/$version/$jar" -o "$tmp/$jar"
    sha="$(sha256sum "$tmp/$jar" | cut -d' ' -f1)"
    entry="         <artifact name=\"$jar\">\n            <sha256 value=\"$sha\" origin=\"Google Maven, added by scripts/update-gradle-verification.sh\"/>\n         </artifact>"
    awk -v v="$version" -v e="$entry" '
      { print }
      $0 ~ "name=\"aapt2\" version=\"" v "\"" { gsub(/\\n/, "\n", e); print e }
    ' "$meta" >"$tmp/meta" && mv "$tmp/meta" "$meta"
  done
done

echo "updated src-tauri/gen/android/$meta — commit it (git add -f; src-tauri/gen/ is gitignored)"
