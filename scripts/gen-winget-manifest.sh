#!/usr/bin/env bash
#
# gen-winget-manifest.sh <version> — point packaging/winget/ at a published
# release: the version, the NSIS installer's URL and SHA-256, and the date all
# come from the GitHub Release, so nothing is typed by hand.
#
# Run it after the Release workflow has published <version>
# (docs/BUILD.md § Releasing), then follow packaging/winget/README.md.

set -euo pipefail

version="${1:?usage: $0 <released-version>}"
version="${version#v}"
cd "$(git rev-parse --show-toplevel)"

asset="Agaric_${version}_x64-setup.exe"
release="$(gh api "repos/jfolcini/agaric/releases/tags/${version}")"
sha256="$(jq -r --arg name "$asset" \
  '.assets[] | select(.name == $name) | .digest // "" | ltrimstr("sha256:") | ascii_upcase' <<<"$release")"
released_on="$(jq -r '.published_at // "" | .[0:10]' <<<"$release")"

if ! [[ "$sha256" =~ ^[0-9A-F]{64}$ && "$released_on" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "ERROR: release ${version} has no published ${asset} with a sha256 digest." >&2
  exit 1
fi

download="https://github.com/jfolcini/agaric/releases/download/${version}/${asset}"
sed -i -E \
  -e "s|^(PackageVersion: ).*|\1${version}|" \
  -e "s|^(ReleaseDate: ).*|\1${released_on}|" \
  -e "s|^(\s*InstallerUrl: ).*|\1${download}|" \
  -e "s|^(\s*InstallerSha256: ).*|\1${sha256}|" \
  -e "s|^(ReleaseNotesUrl: ).*|\1https://github.com/jfolcini/agaric/releases/tag/${version}|" \
  packaging/winget/jfolcini.Agaric*.yaml

echo "packaging/winget/ now describes ${version} (${asset}, published ${released_on})."
