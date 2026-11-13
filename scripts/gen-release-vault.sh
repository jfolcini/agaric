#!/usr/bin/env bash
# Writes src-tauri/tests/fixtures/release-vault/<tag>/: a small vault written
# by the code at a release tag, for the upgrade test that opens it with head
# (src-tauri/src/upgrade_vault_tests.rs, #6567).
#
#   scripts/gen-release-vault.sh 0.23.0
#
# The tag is checked out into a throwaway worktree and builds there, in its
# own target dir. Only the generator comes from head: it is copied in as an
# example, so the boot path and every command that writes the vault are the
# tag's. Needs a toolchain that builds the tag.
set -euo pipefail

tag=${1:?usage: scripts/gen-release-vault.sh <release tag>}
root=$(git rev-parse --show-toplevel)
fixtures="$root/src-tauri/tests/fixtures/release-vault"
work=$(mktemp -d)
trap 'git -C "$root" worktree remove --force "$work/src" >/dev/null 2>&1; rm -rf "$work"' EXIT

git -C "$root" worktree add --detach "$work/src" "refs/tags/$tag"
mkdir -p "$work/src/src-tauri/examples" "$work/vault"
cp "$fixtures/generator.rs" "$work/src/src-tauri/examples/gen_release_vault.rs"
(
  cd "$work/src"
  node scripts/prepare-external-bins.mjs --placeholder-only
  cd src-tauri
  SQLX_OFFLINE=true cargo run --example gen_release_vault -- "$work/vault"
)

out="$fixtures/$tag"
rm -rf "$out"
mkdir -p "$out"
gzip -9 -n -c "$work/vault/notes.db" >"$out/notes.db.gz"
cp -r "$work/vault/attachments" "$work/vault/export-projects.txt" "$work/vault/counts.txt" "$out/"
# With the newline the end-of-file hook would add.
printf '%s\n' "$(cat "$work/vault/device-id")" >"$out/device-id"
echo "wrote $out"
