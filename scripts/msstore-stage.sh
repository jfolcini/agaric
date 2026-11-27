#!/usr/bin/env bash
# Write the Microsoft Store MSIX's AppxManifest.xml and visual assets into a
# package directory, for publish-msstore.yml to add the app's files and pack
# (docs/BUILD.md § Microsoft Store).
#
#   msstore-stage.sh <package-dir>
#
# The manifest is packaging/msstore/AppxManifest.xml with each @MSIX_<NAME>@
# replaced by the environment variable MSIX_<NAME>, XML-escaped; an unset or
# empty one fails. The assets are src-tauri/icons/icon.png scaled by
# ImageMagick's `magick`, which GitHub's Windows runner images preinstall.
set -euo pipefail

dest="${1:?usage: msstore-stage.sh <package-dir>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
icon="$root/src-tauri/icons/icon.png"

mkdir -p "$dest/Assets"
perl -pe '
  sub xml {
    my $v = $ENV{$_[0]};
    die "msstore-stage.sh: $_[0] is unset or empty\n" unless defined $v && length $v;
    $v =~ s/&/&amp;/g;
    $v =~ s/</&lt;/g;
    $v =~ s/>/&gt;/g;
    $v =~ s/"/&quot;/g;
    return $v;
  }
  s/\@(MSIX_[A-Z_]+)\@/xml($1)/ge;
' "$root/packaging/msstore/AppxManifest.xml" >"$dest/AppxManifest.xml"

# png <pixels> <file>: the icon scaled to a square, RGBA, without metadata.
png() {
  magick "$icon" -resize "$1x$1" -strip -define png:color-type=6 "$dest/Assets/$2"
}

# The logos the manifest names, at the scales Microsoft asks for at least:
# Square44x44Logo is the app-list icon, Square150x150Logo the medium tile the
# Store requires, StoreLogo the package logo.
for scale in 100 200 400; do
  png $((44 * scale / 100)) "Square44x44Logo.scale-$scale.png"
  png $((150 * scale / 100)) "Square150x150Logo.scale-$scale.png"
  png $((50 * scale / 100)) "StoreLogo.scale-$scale.png"
done

# The taskbar, Start and search draw the app-list icon at these exact sizes.
# Without the unplated copies (dark and light theme) Windows shrinks it onto a
# coloured plate.
for px in 16 20 24 30 32 36 40 48 60 64 72 80 96 256; do
  name="Square44x44Logo.targetsize-$px"
  png "$px" "$name.png"
  cp "$dest/Assets/$name.png" "$dest/Assets/${name}_altform-unplated.png"
  cp "$dest/Assets/$name.png" "$dest/Assets/${name}_altform-lightunplated.png"
done
