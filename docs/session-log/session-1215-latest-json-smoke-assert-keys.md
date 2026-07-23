# Session 1215 — Fix latest.json smoke-assert key set (release CI)

**Issue:** #3074 (found while diagnosing repeated `generate-latest-json` failures on the 0.9.0 / 0.9.1 releases)

## Problem

The release workflow's `generate-latest-json` job failed on **every** release since #2970,
deterministically — not the intermittent re-download flake it was initially mistaken for.

#2970 grew the generated `latest.json` from the 4 bare `{os}-{arch}` platform keys to **9**
(installer-specific `-appimage/-deb/-rpm/-nsis/-msi` keys plus the two bare `linux-x86_64` /
`windows-x86_64` fallbacks). It updated the generator step and the require-all-7-signatures
loop, but left the **Smoke-assert updater manifest** step asserting exact-set equality against
the stale 4-key list:

```
(keys|sort) == ["darwin-aarch64","darwin-x86_64","linux-x86_64","windows-x86_64"]
```

The generator now always writes 9 keys, so that equality is always `false` →
`jq -e` exits 1 → `::error::latest.json platforms incomplete`.

## Evidence

The `latest.json` uploaded to both the 0.9.0 and 0.9.1 draft releases contains all 9 keys with
valid signatures and URLs (step 1 uploads the manifest *before* the failing step 2 smoke-assert).
The manifest is correct; only the gate was wrong. The exact-4 equality was reproduced returning
`false` against both real manifests, and the replacement subset check was verified to (a) pass the
real 9-key manifest, (b) still fail when any required key is dropped, and (c) still fail on an
empty signature.

## Fix

`.github/workflows/release.yml` — replaced the exact-set equality with a **subset** assertion:
every key the generator emits must be present (`$want - (platforms|keys) == []`), tolerant of
future key additions, while a *missing* key — the real regression this gate exists to catch — still
fails. The non-empty signature/url assertion is preserved.

Tag `0.9.1` is immutable, so this lands for **0.9.2+**. The current 0.9.1 draft is publishable as-is
(complete manifest); its `generate-latest-json` red is a false negative.

## Verification

- `jq` subset check exercised against the real 0.9.1 manifest (pass), a key-dropped manifest (fail),
  and an empty-signature manifest (fail).
- YAML parses; actionlint/zizmor run via the pre-push prek hook.
