#!/usr/bin/env bash
# verify-updater-signatures.sh — CI-only cryptographic verification of Tauri
# updater artifacts against the pubkey pinned in the app (#2971).
#
# WHY THIS EXISTS
#   The release workflow signs each updater payload (`tauri signer sign`) and
#   only asserts the resulting `.sig` FILE EXISTS. That catches a missing
#   signature but NOT a signature made with the wrong secret: if the signing
#   secret is ever rotated/mismatched relative to the pubkey baked into the app
#   (src-tauri/tauri.conf.json → plugins.updater.pubkey), every installed
#   client's auto-update fails `verify_signature` at install time — after the
#   release has already shipped. This script closes that gap by performing, at
#   build time, exactly the minisign verification that tauri-plugin-updater's
#   `updater.rs::verify_signature` performs at install time. Any artifact whose
#   `.sig` does not verify against the embedded pubkey fails the release.
#
# ENCODING (base64-wrapped minisign — the non-obvious part)
#   Tauri's updater uses minisign. BOTH of these values are base64-encoded
#   wrappers around standard minisign text files, so they must be base64-decoded
#   before a stock `minisign` CLI can consume them:
#     * plugins.updater.pubkey (tauri.conf.json) — base64 of a minisign public
#       key file ("untrusted comment: minisign public key: ...\n<key line>").
#     * each `<payload>.sig` produced by `tauri signer sign` — base64 of a
#       minisign signature file ("untrusted comment: ...\n<sig>\ntrusted
#       comment: ...\n<global sig>"), i.e. a `.minisig`.
#   We decode both, then verify with `minisign -V -p <pub> -x <minisig> -m <payload>`.
#
# USAGE
#   verify-updater-signatures.sh <pubkey-b64> <dir>
#     <pubkey-b64>  base64 minisign pubkey (the raw plugins.updater.pubkey value)
#     <dir>         directory containing updater payloads and their `.sig` files
#                   (each `<name>.sig` is matched to the `<name>` payload sitting
#                   beside it). Fails if any `.sig` lacks its payload, if no
#                   `.sig` files are present, or if any signature does not verify.
#
# Requires the `minisign` CLI on PATH. Hermetic and CI-only.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "::error::usage: verify-updater-signatures.sh <pubkey-b64> <dir>" >&2
  exit 2
fi

PUBKEY_B64="$1"
DIR="$2"

command -v minisign >/dev/null 2>&1 || { echo "::error::minisign CLI not found on PATH" >&2; exit 2; }
[ -d "$DIR" ] || { echo "::error::not a directory: $DIR" >&2; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# base64 -> minisign public key file. `tr -d` strips any stray whitespace/newlines
# that a copied-in config value might carry before decoding.
pub="$work/updater.pub"
printf '%s' "$PUBKEY_B64" | tr -d '[:space:]' | base64 -d > "$pub" || {
  echo "::error::failed to base64-decode updater pubkey" >&2; exit 1; }
# Sanity-check we decoded a real minisign public key, not garbage.
grep -q 'minisign public key' "$pub" || {
  echo "::error::decoded pubkey is not a minisign public key file" >&2; exit 1; }

shopt -s nullglob
sigs=("$DIR"/*.sig)
if [ "${#sigs[@]}" -eq 0 ]; then
  echo "::error::no .sig files found in $DIR" >&2
  exit 1
fi

failed=0
verified=0
for sig in "${sigs[@]}"; do
  payload="${sig%.sig}"
  if [ ! -f "$payload" ]; then
    echo "::error::signature $sig has no corresponding payload $payload" >&2
    failed=1
    continue
  fi
  # base64 -> minisign signature file (`.minisig`).
  minisig="$work/$(basename "$sig").minisig"
  if ! printf '%s' "$(cat "$sig")" | tr -d '[:space:]' | base64 -d > "$minisig"; then
    echo "::error::failed to base64-decode signature $sig" >&2
    failed=1
    continue
  fi
  # The crux: cryptographically verify the payload bytes against the pinned
  # pubkey. Non-zero exit here == a rotated/mismatched signing secret.
  if minisign -V -p "$pub" -x "$minisig" -m "$payload" >/dev/null 2>&1; then
    echo "verified: $(basename "$payload")"
    verified=$((verified + 1))
  else
    echo "::error::signature verification FAILED for $(basename "$payload") — .sig does not match the pubkey pinned in tauri.conf.json (rotated/mismatched signing secret?)" >&2
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "::error::one or more updater artifacts failed signature verification" >&2
  exit 1
fi

echo "all $verified updater artifact signature(s) verified against the pinned updater pubkey."
