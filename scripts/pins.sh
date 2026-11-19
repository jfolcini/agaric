#!/usr/bin/env bash
# Read pins.txt (AGENTS.md § Supply-chain pinning) for bash, the composite
# actions and the workflows. Bumping and staleness live in scripts/pins.mjs.
#
#   pins.sh version <name>                   the pinned version
#   pins.sh asset <name> <platform>          "<sha256> <url>" for that platform
#   pins.sh fetch <name> <platform> <dest>   download the asset to <dest> and
#                                            check its sha256; exit 1 on mismatch
#   pins.sh platform                         this machine's platform key
#   pins.sh github-output                    every version as `<name>=<version>`
#                                            (dashes as underscores) into
#                                            $GITHUB_OUTPUT, for `steps.pins.outputs`
#
# Every lookup fails loudly for a name or platform pins.txt does not list.
set -euo pipefail

PINS_FILE="${PINS_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pins.txt}"

die() {
  echo "pins.sh: $*" >&2
  exit 1
}

[ -r "$PINS_FILE" ] || die "cannot read $PINS_FILE"

pin_version() {
  local v
  v="$(awk -v n="$1" '$1 == "version" && $2 == n { print $3; found = 1 } END { exit !found }' "$PINS_FILE")" \
    || die "no \`version $1\` line in $PINS_FILE"
  printf '%s\n' "$v"
}

pin_asset() {
  local version line
  version="$(pin_version "$1")"
  line="$(awk -v n="$1" -v p="$2" '$1 == "asset" && $2 == n && ($3 == p || $3 == "any") { print $4, $5; found = 1; exit } END { exit !found }' "$PINS_FILE")" \
    || die "no \`asset $1 $2\` line in $PINS_FILE"
  printf '%s\n' "${line//\{version\}/$version}"
}

pin_platform() {
  local os arch
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT) os=windows ;;
    *) die "unknown OS $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64 | AMD64) arch=x86_64 ;;
    aarch64 | arm64) arch="$([ "$os" = darwin ] && echo arm64 || echo aarch64)" ;;
    *) die "unknown architecture $(uname -m)" ;;
  esac
  printf '%s-%s\n' "$os" "$arch"
}

# From stdin: given a path with a backslash (Windows' $RUNNER_TEMP is
# D:\a\_temp), sha256sum escapes its output line with a leading `\`.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum <"$1" | awk '{ print $1 }'
  else
    shasum -a 256 <"$1" | awk '{ print $1 }'
  fi
}

pin_fetch() {
  local line sha url got
  line="$(pin_asset "$1" "$2")"
  read -r sha url <<<"$line"
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$3" "$url" || die "download failed: $url"
  got="$(sha256_of "$3")"
  if [ "$got" != "$sha" ]; then
    rm -f "$3"
    die "sha256 mismatch for $1 ($2): pins.txt has $sha, $url has $got"
  fi
}

case "${1:-}" in
  version) pin_version "${2:?name}" ;;
  asset) pin_asset "${2:?name}" "${3:?platform}" ;;
  fetch) pin_fetch "${2:?name}" "${3:?platform}" "${4:?dest}" ;;
  platform) pin_platform ;;
  github-output)
    : "${GITHUB_OUTPUT:?github-output runs inside a GitHub Actions step}"
    awk '$1 == "version" { gsub(/-/, "_", $2); print $2 "=" $3 }' "$PINS_FILE" >>"$GITHUB_OUTPUT"
    ;;
  *) die "usage: pins.sh version|asset|fetch|platform|github-output …" ;;
esac
