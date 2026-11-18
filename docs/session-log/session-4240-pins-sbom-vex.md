# Session 4240 — one pins file, stale-pin checks, Gradle regeneration, SBOMs that list what ships

Follow-up to session 4238. The maintainer asked for six things: one pins file, a weekly stale check, automatic Gradle verification regeneration, the picomatch waiver, accurate SBOMs with OpenVEX generated from them, and tests and docs to keep it all in shape.

## What changed

- **The nightly full-suite (#3388, #3394).** Two failures. The `@wdio` 10.2 packages raised the Node floor, so `engines.node` is re-derived as `^22.23.4 || ^24.22.1 || >=26.12.1` and the floor job moves to 22.23.4. Separately, RUSTSEC-2026-0543 (chrono unmaintained) is waived; specta, rmcp and schemars require chrono too.
- **picomatch GHSA-fc5q-39xc-vjpf.** No patched release exists, and it is reached only through build tooling. Waived in `.nsprc` for 90 days, as the maintainer approved.
- **`pins.txt`.** Every tool version and download sha256 lives here.
  - `scripts/pins.sh` reads it for bash, the composite actions and the workflows. Workflows add a `Read pins.txt` step and use `steps.pins.outputs.*`.
  - `setup-hooks.sh`, `setup.sh` and `zizmor-hook.sh` drop their own tables.
  - `scripts/pins.mjs` does `bump` (recomputes sha256s from the new downloads) and `stale`. They are exposed as `just pin-bump` and `just pins-stale`.
  - `check-tool-pins.mjs` and its hook are deleted: no copies are left to keep equal. `pins.test.mjs` now fails on a hard-coded version or an unknown `steps.pins.outputs` name.
- **`stale-pins` lane.** Runs weekly in `scheduled-deep-checks.yml` and is reported by the existing tracker. It applies a 7-day cooldown and fails closed when an upstream can't be read.
- **Gradle regeneration.**
  - When `ci.yml`'s Android build on a pull request fails dependency verification, the job regenerates the file under its read-only token and uploads it.
  - `gradle-verification-commit.yml` (`workflow_run`) commits that file to same-repo PR branches. It runs no PR code, and it comments asking for a review and a re-run.
  - zizmor's `dangerous-triggers` finding is ignored inline, with that reason.
- **SBOM and OpenVEX.**
  - **The defect.** The 0.25.0 SBOMs listed none of the app's Rust crates or npm packages; Android listed zero components. The single VEX document named a product no SBOM contained and marked 9 waivers `under_investigation`.
  - **SBOM.** `scripts/sbom.mjs` adds the crates each target compiles (`cargo metadata --filter-platform`, runtime dependencies only) and the npm runtime packages, both with lockfile hashes. It names the product `pkg:github/jfolcini/agaric@<version>` and gates on completeness.
  - **OpenVEX.** `scripts/generate-vex.mjs` now writes one document per SBOM. Subcomponents come from the advisory's OSV ranges, and every decided waiver is `not_affected`.
  - **Release wiring.** Both run inside `.github/actions/syft-sbom`. The separate `generate-vex` job is gone.

## What ran

- **Tests.** `node --test scripts/pins.test.mjs scripts/sbom.test.mjs`: 25 passing. Falsified four ways:
  - a hard-coded `java-version`
  - `bumpText` not rewriting hashes
  - counting a `fixed` version as affected
  - keeping proc-macros
- **Live bump.** `node scripts/pins.mjs bump` on minisign and syft at their current versions reproduced the recorded hashes.
- **Live stale check.** `node scripts/pins.mjs stale` resolved every non-GitHub upstream. GitHub rows return 401 in this sandbox and fail closed; CI passes `github.token`.
- **Installers through pins.**
  - `setup-hooks.sh` end to end.
  - Every fresh-install path in a throwaway home: cargo-binstall, uv, shellcheck, shfmt, lychee, nextest, taplo.
  - The AppImage seeding and syft actions' download paths.
- **SBOM on real data.** `sbom.mjs augment` on the 0.25.0 Linux and Android SBOMs added 1010 and 922 components. `check` failed the originals and passed the augmented ones.
- **VEX on real data.** `generate-vex.mjs` produced 35 statements on each. quick-xml is `component_not_present` (only 0.41.0, the fix, ships); chrono and picomatch carry their shipped purls.
- **Engines floor.** `npm ci` on Node 22.23.4, the new floor: passes. `cargo deny check advisories` and `cargo audit`: pass.
- **Hooks.** `prek run` on every changed file, zizmor and actionlint included.

## Not run here

These need a real CI run or a release tag:

- the Gradle regeneration and commit path
- the `stale-pins` lane with an authenticated GitHub API
- syft on macOS and Windows
- the release jobs' SBOM, OpenVEX and attestation steps
