#!/usr/bin/env bash
# Fail any commit that introduces `#![allow(unsafe_code)]`
# in a file not explicitly listed in `src-tauri/unsafe-allowlist.txt`.
#
# Workspace lint is `unsafe_code = "deny"` (`src-tauri/Cargo.toml`). The
# only escape hatch is a per-file `#![allow(unsafe_code)]`. This script
# is the centralised audit point ensuring every escape hatch is reviewed.
#
# Invoked by the `unsafe-allowlist` prek hook. Operates over the whole
# tree (the hook sets `pass_filenames = false`) — fast enough at this
# repo size that a per-file invocation would not save anything.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
ALLOWLIST="$REPO_ROOT/src-tauri/unsafe-allowlist.txt"

if [ ! -f "$ALLOWLIST" ]; then
    echo "ERROR: $ALLOWLIST not found" >&2
    exit 1
fi

# Build the set of allowlisted paths (relative to `src-tauri/`), ignoring
# blank lines and lines starting with `#`.
allowed=()
while IFS= read -r line; do
    # Strip inline comments + leading/trailing whitespace.
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -z "$line" ] && continue
    allowed+=("$line")
done < "$ALLOWLIST"

# Find every Rust file under `src-tauri/` that carries the
# `#![allow(unsafe_code)]` directive at the inner-attribute scope.
#
# #3847: this used to walk `src-tauri/src/` only, so the six workspace member
# crates (`agaric-core`, `agaric-store`, `agaric-engine`, `agaric-sync`,
# `agaric-observability`, `diagnostics`) were unaudited — and the #2621 split
# had already moved `android_multicast.rs` out of `src/`, leaving a dangling
# allowlist entry and a real `unsafe` file nobody was checking. Build outputs
# and the Stryker sandboxes are excluded: they are copies/artifacts, not source.
unallowed=()
while IFS= read -r filepath; do
    rel="${filepath#"$REPO_ROOT/src-tauri/"}"
    found=0
    for a in "${allowed[@]}"; do
        if [ "$a" = "$rel" ]; then
            found=1
            break
        fi
    done
    if [ "$found" -eq 0 ]; then
        unallowed+=("$rel")
    fi
done < <(grep -rl --include='*.rs' \
    --exclude-dir=target --exclude-dir=.stryker-tmp --exclude-dir=gen \
    '#!\[allow(unsafe_code)\]' "$REPO_ROOT/src-tauri/" 2>/dev/null || true)

# Second direction: every ALLOWLIST entry must still name a real file.
#
# #3847: the entry for the multicast shim went stale when #2621 moved it
# into `agaric-sync/`, and nothing noticed — the loop above only walks
# discovered files and asks "is this one allowed?", so an entry pointing at
# a path that no longer exists is simply never consulted. That is how an
# audit hook silently stops auditing: not by failing, but by matching
# nothing. Walking the allowlist itself is what makes the rot loud.
dangling=()
while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    case "$entry" in \#*) continue ;; esac
    if [ ! -e "$REPO_ROOT/src-tauri/$entry" ]; then
        dangling+=("$entry")
    fi
done < <(sed 's/#.*//' "$ALLOWLIST" | tr -d '[:blank:]')

if [ "${#dangling[@]}" -gt 0 ]; then
    {
        echo "ERROR: $ALLOWLIST has entries that no longer name an existing file:"
        for f in "${dangling[@]}"; do
            echo "  - $f"
        done
        echo
        echo "The file was moved or deleted. Update the entry to the new path, or drop it."
        echo "A dangling entry silently un-audits whatever it used to cover (#3847)."
    } >&2
    exit 1
fi

if [ "${#unallowed[@]}" -gt 0 ]; then
    {
        echo "ERROR: the following files carry \`#![allow(unsafe_code)]\` without an entry in $ALLOWLIST:"
        for f in "${unallowed[@]}"; do
            echo "  - $f"
        done
        echo
        echo "If the unsafe block is reviewed and necessary, add the path to the allowlist with a justification comment."
        echo "Otherwise, remove the \`#![allow(unsafe_code)]\` and rewrite the code to comply with the workspace \`unsafe_code = \"deny\"\` lint."
    } >&2
    exit 1
fi

exit 0
