#!/usr/bin/env bash
# Format the files changed vs HEAD (staged + unstaged) with oxfmt.
#
# oxfmt only touches JS/TS/JSON and silently ignores every other path, so
# handing it the full changed-file list is safe (TOML is formatted separately
# via `npm run format:toml`). This is the single source of truth for the
# "format only what I changed" workflow — both `npm run format:changed` and
# `just fmt` call it, and CONTRIBUTING.md points here, so the logic lives in
# exactly one place. Prefer this over `npm run format` (`oxfmt --write .`),
# which reformats the whole repo and produces large unrelated diffs.
#
# --diff-filter=d drops deleted paths (oxfmt would error on a missing file).
# Paths are read NUL-delimited (`git diff -z` into an array) so filenames with
# spaces or newlines survive intact, and the array-length guard avoids invoking
# `oxfmt --write` with no arguments. The read loop (rather than `xargs -0 -r`)
# keeps this portable to the macOS system bash, whose xargs lacks `-r`.
set -euo pipefail

cd "$(dirname "$0")/.."

files=()
while IFS= read -r -d '' f; do
  files+=("$f")
done < <(git diff -z --name-only --diff-filter=d HEAD)

if [ ${#files[@]} -gt 0 ]; then
  oxfmt --write "${files[@]}"
fi
