# Session 1030 — release 0.6.3 (+ reconcile manifest version drift)

2026-06-15. User directive: "release 0.6.3". Cut from `main` at `5ad37a68`
(after #87 incremental VV sync merged), tag `0.6.3` pushed → Release workflow
drafting all platforms.

## Shipped — release commit `1e5357dd` + signed tag `0.6.3`

Bumped all 5 version manifests to 0.6.3 (`package.json`, `package-lock.json`,
`src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`),
GPG-signed commit + annotated signed tag, pushed `main` + tag with
`--no-verify` (the release contract; pre-push blocks `main`). Release workflow
`27544598164` — `verify-version` job green, confirming tag ⇔ manifests agree.
Workflow **drafts** the GitHub Release; maintainer reviews + clicks Publish.

## The catch — pre-existing manifest drift broke the canonical script

`main` had its 5 release manifests **split** before this session:
- Rust/tauri side (`Cargo.toml`, `Cargo.lock`, `tauri.conf.json`) → **0.6.2** ✓
- `package.json` / `package-lock.json` → **0.6.1** ✗

Root cause: the 0.6.2 bump (`4fd4e0ce`) set all five correctly, but **PR #977**
("enable React Compiler", `5ac0d98e`) was branched off a pre-0.6.2 base; its
merge carried a stale `package.json`/`package-lock.json` and **reverted the
version line to 0.6.1**. The Rust manifests were untouched by that PR, so only
the JS side regressed.

This jams `scripts/release.sh`: `bump-version.sh` reads `CURRENT_VERSION` from
`package.json` (0.6.1), then `sed`s `Cargo.toml` for a `version = "0.6.1"` line.
But Cargo.toml is at 0.6.2 → no match → the post-sed sanity check
(`ACTUAL_CARGO != NEW_VERSION`) aborts. The script cannot cut a release while
the manifests disagree.

Fix this session: **manual reconciling bump** — applied the same edits the
script does (jq for the JSON manifests, `sed` Cargo.toml from its actual 0.6.2,
`cargo update -p agaric --precise`, oxfmt the JSON), landing all five at 0.6.3.
The drift is resolved as a side effect; diff was exactly 6 version-field lines.

## Notes / lessons

- **A non-release PR can silently revert the version line.** Any PR branched off
  a base older than the last release bump will, on merge, drag the stale
  `package.json` version back — and CI never catches it (no job asserts
  manifest-version consistency between releases; `verify-version` only runs on a
  release *tag*). Before the next release, check all 5 manifests agree
  (`jq -r .version` × json, `grep -m1 '^version'` × Cargo.toml/lock). If split,
  the canonical script will abort on the Cargo.toml sed — a manual reconciling
  bump to the new version fixes it in one commit.
- Skipped the local `verify-release-build.sh` (per directive); CI is the gate.
