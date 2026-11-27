# Session 4555 — 0.27.0: the Windows SBOM lost its Rust crates (cargo-auditable 0.7.8)

Cut 0.27.0 with `scripts/release.sh`. The tag's `build-and-release (windows-2025-vs2026)` job failed twice at "Generate SBOMs": `0 Rust crates (want at least 200)`, no `pkg:cargo/tauri@*`, no `pkg:cargo/loro@*`. The Windows SBOM held 434 components, all npm; 0.26.0's held 976. Linux (1058) and both macOS jobs passed.

**Cause**

The 0.27.0 `agaric.exe` and `agaric-mcp.exe`, unpacked from the draft's MSI, have no `.dep-v0` section; 0.26.0's have one. Both builds used MSVC `link.exe`, so the linker did not drop it: cargo-auditable never injected it. Rust 1.100 (pinned since 0.26.0) stabilized Cargo's new build-dir layout, which passes one `-L dependency=…` per package, so the `agaric` binary's rustc command line passes Windows' 32,767-character limit and Cargo falls back to an `@argfile`. cargo-auditable 0.7.7 reads only `argv`, finds no `--crate-type bin`, and skips the injection without a word (rust-secure-code/cargo-auditable#276, fixed in 0.7.8). syft 1.54 → 1.57.2 (#7099) was ruled out by the missing section itself.

**Fix**

`cargo-auditable` 0.7.7 → 0.7.8 in `pins.txt`, and every `taiki-e/install-action` SHA from v2.90.6 to v2.90.11, the first whose manifest carries 0.7.8. The manifest's `x86_64_windows` sha256 matches the `.sha256` upstream published with the release. Both releases are inside the 7-day quarantine (#816); the maintainer chose to take them over holding 0.27.0 for a week. 0.7.8's format revision bump (1 → 2) is backward compatible, and syft reads the same package list.

**Release**

The 0.27.0 bump commit (`36b5738e7`) stays on main. Once this merges, the draft is deleted and the 0.27.0 tag moves onto the fixed main (docs/BUILD.md § "If the tag's CI fails after the bump landed").

**Ran**

`node --test scripts/pins.test.mjs`. The fix itself is checked only by the re-tagged release's Windows SBOM step: no PR lane builds Windows with cargo-auditable.
