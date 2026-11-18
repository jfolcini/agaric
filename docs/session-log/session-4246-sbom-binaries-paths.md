# Session 4246 — the SBOM step names the shipped executables

The #6877 review note: the `binaries` glob `target/<triple>/release/agaric*` also took in cargo's `agaric.d` and, on Windows, `agaric.pdb`. syft ignored them, so this changes no SBOM; the input now says what ships.

## What changed

- **Desktop builds.** `release.yml` and `ci.yml` name the two Rust executables the bundle ships: `agaric` and its `agaric-mcp` sidecar, with `.exe` on Windows. `prepare-external-bins.mjs` builds the sidecar under the same cargo auditable wrapper, so its crates are read from it too.
- **Android.** Already named the one shipped library, `libagaric_lib.so`; unchanged.
- **`.github/actions/syft-sbom`.** The input description now asks for paths, not a glob. A path that does not exist still fails the step.

## What ran

- Read `prepare-external-bins.mjs`: the sidecar lands in `target/<triple>/release` when `CARGO_BUILD_TARGET` is set (release) and in `target/release` otherwise (`ci.yml`'s build), matching the paths.
- `prek run` on the changed files, actionlint and zizmor included.

## Not run here

The paths existing on a real build: `ci.yml`'s `build` job on this PR checks the Linux pair, and the first release tag checks macOS and Windows.
