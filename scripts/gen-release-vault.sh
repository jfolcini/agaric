#!/usr/bin/env bash
# Writes src-tauri/tests/fixtures/release-vault/<version>/: a small vault
# written by a release's code, for the upgrade test that opens it with head
# (src-tauri/src/upgrade_vault_tests.rs, #6567). It replaces the vault of any
# other version: the test opens the one that is there.
#
#   scripts/gen-release-vault.sh 0.23.0          # the code at the tag
#   scripts/gen-release-vault.sh 0.24.0 HEAD     # scripts/release.sh, before it tags
#
# The ref is checked out into a throwaway worktree and builds there, in its
# own target dir. Only the generator comes from the working tree: it is copied
# in as an example, so the boot path and every command that writes the vault
# are the ref's. Needs a toolchain that builds the ref.
set -euo pipefail

version=${1:?usage: scripts/gen-release-vault.sh <version> [<ref>, default refs/tags/<version>]}
ref=${2:-refs/tags/$version}
root=$(git rev-parse --show-toplevel)
fixtures="$root/src-tauri/tests/fixtures/release-vault"
work=$(mktemp -d)
trap 'git -C "$root" worktree remove --force "$work/src" >/dev/null 2>&1; rm -rf "$work"' EXIT

git -C "$root" worktree add --detach "$work/src" "$ref"
mkdir -p "$work/src/src-tauri/examples" "$work/vault"
cp "$fixtures/generator.rs" "$work/src/src-tauri/examples/gen_release_vault.rs"
(
  cd "$work/src"
  node scripts/prepare-external-bins.mjs --placeholder-only
  cd src-tauri
  SQLX_OFFLINE=true cargo run --example gen_release_vault -- "$work/vault"
)

out="$fixtures/$version"
find "$fixtures" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
mkdir -p "$out"
gzip -9 -n -c "$work/vault/notes.db" >"$out/notes.db.gz"
cp -r "$work/vault/attachments" "$work/vault/export-projects.txt" "$work/vault/counts.txt" "$out/"
# With the newline the end-of-file hook would add.
printf '%s\n' "$(cat "$work/vault/device-id")" >"$out/device-id"
echo "wrote $out"
