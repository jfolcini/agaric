## Session 1132 — fix nightly fuzz lane (musl default + generate_context coupling) (#2123) (2026-06-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-29 |
| **Subagents** | orchestrator-only (1 read-only dependabot review) |
| **Items closed** | `#2123` |
| **Items modified** | — |
| **Tests added** | — (CI-lane fix; verified by building + smoke-running both fuzz targets) |
| **Files touched** | 3 |

**Summary:** The `scheduled-deep-checks.yml` `fuzz` lane was failing at build (issue reported
exit 101 / `E0463`). Local reproduction under nightly + cargo-fuzz 0.13.2 uncovered a
**cascade of two distinct breaks**: (1) cargo-fuzz's default target is
`x86_64-unknown-linux-musl` whose nightly std isn't installed; (2) once that's bypassed, the
fuzz crate compiles the whole agaric lib — including the tauri app entry `run()` — and
`tauri::generate_context!`'s ACL codegen fails with `E0063` (`missing field referenced_by`)
under the nightly + sanitizer fuzz build, even at tauri versions that build fine normally.
Fixed both: pin the fuzz build to the gnu host target, and exclude the GUI app entry from the
fuzz build (the parser-only targets have no need for it). Both fuzz targets now build, link,
and smoke-run clean.

**Files touched (this session):**
- `.github/workflows/scheduled-deep-checks.yml` — pin `cargo +nightly fuzz run` to
  `--target x86_64-unknown-linux-gnu` (host target; std installed, dynamic libc for ASan).
- `src-tauri/src/lib.rs` — gate `pub fn run()` (the tauri `Builder` + `generate_context!`)
  behind `#[cfg(not(fuzzing))]`; only `main.rs` (not compiled by the fuzz crate's path
  dependency) calls it, so the fuzz build skips the fragile ACL codegen entirely.
- `src-tauri/Cargo.toml` — declare `cfg(fuzzing)` via `[lints.rust] unexpected_cfgs` so the
  normal `-D warnings` build doesn't reject the new gate.

**Verification:**
- `cargo +nightly fuzz build --target x86_64-unknown-linux-gnu` (both targets) — builds + links (exit 0).
- `cargo +nightly fuzz run {snapshot_decode,deeplink_parse} -- -max_total_time=10` — both DONE,
  no crash/panic (snapshot_decode 57k runs; deeplink_parse 685k runs, cov 2628).
- `cargo clippy --workspace --all-targets -- -D warnings` (online, dev.db) — clean (the
  `cfg(fuzzing)` declaration keeps the gate from tripping `unexpected_cfgs`).
- `cargo fmt --check` — clean.

**Process notes:** A red herring along the way — an intermittent "linking with cc failed" was
the local disk filling (ENOSPC) mid-link during the 2×240 MB sanitizer binaries, not a real
GUI-stack link incompatibility; freeing space let both link cleanly. Also confirmed the fuzz
crate's separate Cargo.lock trails main's tauri by a patch (2.11.2 vs 2.11.3), but with `run()`
gated out `generate_context!` never compiles, so the skew is moot — left the lock untouched to
keep the fix minimal.

**Lessons learned (for future sessions):** cargo-fuzz 0.13.x defaults `--target` to musl on
some hosts — always pin the fuzz target. And a cargo-fuzz crate that path-depends on a
GUI/Tauri lib drags the whole app (incl. `generate_context!`) into the sanitizer build; gating
the app entry behind `cfg(not(fuzzing))` keeps the parser fuzz targets decoupled.

**Commit plan:** single commit on `claude/issue-2123-fuzz-musl-target` (Closes #2123), pushed, draft PR.
