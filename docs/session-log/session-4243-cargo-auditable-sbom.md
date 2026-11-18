# Session 4243 — SBOM crates from cargo auditable

Follow-up to session 4240, at the maintainer's request: the Rust half of each release SBOM now comes from the shipped binaries, not from a `cargo metadata` reconstruction.

## What changed

- **Builds embed their crate list.** `release.yml`'s desktop and Android jobs, and `ci.yml`'s Linux bundle and aarch64 Android release builds, install `cargo-auditable` (pinned in `pins.txt`, through taiki-e/install-action) and set `RUSTC_WORKSPACE_WRAPPER` plus `CARGO_AUDITABLE_ORIG_ARGS`. `cargo auditable build` cannot wrap `cargo tauri build`; the wrapper env is what `cargo auditable` sets itself. The `cargo install tauri-cli` steps run without it.
- **`.github/actions/syft-sbom`** takes a `binaries` input (globs that must each match a file), scans those binaries apart from the bundle, and passes that scan to `sbom.mjs augment --binaries-cyclonedx`.
- **`scripts/sbom.mjs`** takes the `pkg:cargo` components syft read from either scan, adds `Cargo.lock` sha256s, and keeps the npm half and the completeness gate. The `cargo metadata` path is gone.
- **CI gate.** `ci.yml` runs the SBOM action after both builds, so an SBOM that would come out empty reds on the pull request rather than on a tag. `classify-changes.sh` now runs those jobs when `sbom.mjs` or `generate-vex.mjs` change.

## What ran

- `cargo-auditable` 0.7.7 in wrapper-env mode on a bin and a cdylib: both carry the `.dep-v0` section (read back with `rust-audit-info`). An empty `RUSTC_WORKSPACE_WRAPPER` builds without a wrapper.
- `node --test scripts/sbom.test.mjs scripts/pins.test.mjs`. The `rustComponents` test was falsified by dropping the de-duplication.
- `prek run` on the changed files.

## Not run here

syft reading the embedded data. Downloaded binaries cannot run in this sandbox, so the first proof is `ci.yml`'s SBOM gate on this pull request.
