#!/usr/bin/env bash
# PEND-41 R13 — fail any commit that introduces `#![allow(unsafe_code)]`
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

# Find every Rust file under `src-tauri/src/` that carries the
# `#![allow(unsafe_code)]` directive at the inner-attribute scope.
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
done < <(grep -rl '#!\[allow(unsafe_code)\]' "$REPO_ROOT/src-tauri/src/" 2>/dev/null || true)

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
