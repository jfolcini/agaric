# Session 1999 — bump quinn-proto past five RUSTSEC advisories

CI's `validate / lint` job failed cargo-audit on quinn-proto 0.11.15, flagging five advisories: RUSTSEC-2026-0338, 0339, 0340, 0341, and 0342. The fix is a lockfile-only bump of quinn-proto to >= 0.11.18 (landed at 0.11.19). Both `src-tauri/Cargo.lock` and `src-tauri/fuzz/Cargo.lock` were updated with `cargo update -p quinn-proto` and `cargo update -p quinn-proto --precise 0.11.19` respectively; no Cargo.toml changes were needed. `cargo audit` confirmed zero vulnerabilities remain after the bump.
