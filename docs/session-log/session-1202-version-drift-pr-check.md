# Session 1202 — Catch version-manifest drift at PR time, not release-tag time

**Date:** 2026-07-23
**Branch:** `fix/version-drift-pr-check`
**Closes:** #2975

## Summary

The 5-way version agreement across `tauri.conf.json`, `Cargo.toml`, `package.json`,
`package-lock.json`, and `Cargo.lock` was asserted **only** by `release.yml`'s
`verify-version` job on a tag push. A stale-base PR that reverts one manifest's version
(the known live failure mode) merged green and was discovered only mid-release, after
`release.sh`'s preflight/build had already burned 5–10 minutes. This lifts the mutual-
agreement half of that check into an always-on validation job so drift is rejected at PR
time.

## The change (`.github/workflows/_validate.yml` only — `release.yml` untouched)

New job `verify-version-agreement`, always-on (no `needs:`/`if:`), added before `lint`.
It reuses `release.yml`'s exact extraction expressions character-for-character:

- `jq -r .version src-tauri/tauri.conf.json`
- `grep -m1 '^version' src-tauri/Cargo.toml | cut -d'"' -f2`
- `jq -r .version package.json`
- `jq -r .version package-lock.json`
- `awk '/^name = "agaric"$/{getline; print; exit}' src-tauri/Cargo.lock | cut -d'"' -f2`

Only the 5-way mutual-agreement loop is kept; the **tag-equality** assertion is dropped
(there is no tag at PR time) and remains solely in `release.yml`, which still verifies the
tag matches the manifests at release time.

Wired as a **required** gate, not informational: `verify-version-agreement` is added to
`validate-all`'s `needs:` array and to its aggregation step via
`check_job verify-version-agreement "false"` (skip never allowed), matching the exact shape
of the sibling required-job calls. A drift failure therefore fails the merge-required
`validate-all` aggregate check.

## Why it fires on every PR

`ci.yml` triggers on `pull_request: branches: [main]` and unconditionally does
`uses: ./.github/workflows/_validate.yml` (no `if:`), so the new always-on job runs on
every PR.

## Verification

Both `_validate.yml` and `release.yml` parse as valid YAML (`yaml.safe_load`); new job's
indentation matches sibling jobs exactly. Extraction traced against the real manifests:
all five report `0.8.0` today (passes on a clean base). Non-tautological — the fail loop
compares each of the four followers against `CONF` and sets `fail=1` on any mismatch;
empirically, `PKG=0.7.9` (a follower diverges) and `CONF=0.7.9` (the reference itself is
the outlier) both exit 1, while all-agree exits 0. Adversarial review confirmed extraction
fidelity, gate wiring, trigger chain, YAML validity, and fail-logic correctness with zero
defects.
