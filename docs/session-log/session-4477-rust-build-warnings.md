# Session 4477 — the fuzz and Android builds compile without warnings

Tonight's deep checks (run 45727675233) built the Rust workspace in two configurations that the PR lanes never compile, and both printed warnings.

**Fuzz build (the pinned nightly).**
- `recursion_depth_exceeding_limit` ([rust-lang/rust#159228](https://github.com/rust-lang/rust/issues/159228)) fired in three places. It is a future-incompatibility lint that will become a hard error. Proving three async futures `Send` nests past the default limit of 128: the materializer's foreground task (`agaric-engine`), the session supervisor (`agaric-sync`) and the MCP read-only tools (`agaric_lib`). Each crate gets `#![recursion_limit = "256"]`, as the compiler suggests.
- 65 items in `src/lib.rs` were dead in that build, each warned once per fuzz target. The fuzz crate builds the lib without `run()` (`#[cfg(not(fuzzing))]`), so everything only `run()` reaches is dead by design. A fuzzing-only `expect(dead_code, unused_macros)` with its reason replaces them. Being `expect`, it fails if the fuzz build ever stops leaving that code out.

**Android build.** `boot_failure_dialog_body` and `BOOT_RECOVERY_DOCS_URL` were never used. Only desktop code calls them, so they take `#[cfg(desktop)]`, as `boot_failure_details` beside them already did.

**Ran.**
- `cargo fmt --all --check`.
- `SQLX_OFFLINE=true cargo clippy --workspace --all-targets -- -D warnings`.
- `SQLX_OFFLINE=true cargo check --workspace --all-targets`.
- The nightly fuzz build and the Android build do not fit on this box, so the `fuzz` and `android-launch` lanes of `scheduled-deep-checks.yml` run on this branch to show the warnings gone.
