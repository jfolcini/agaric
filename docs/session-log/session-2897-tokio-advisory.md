# Session 2897 — tokio 1.53.3 for RUSTSEC-2026-0386

RUSTSEC-2026-0386 reports that `AsyncFd::new` and related `tokio` constructors violate I/O safety before 1.53.3 (or 1.51.6 on the older line). Published the same day as RUSTSEC-2026-0385, it turned `cargo deny`'s advisories check red on every PR.

Both lockfiles move `tokio` to 1.53.3 with `cargo update -p tokio --precise 1.53.3`: `src-tauri/Cargo.lock` and the fuzz workspace's lock.

That update also re-picks the version some crates resolve within their declared ranges:
- several crates (`dirs-sys`, `errno` and others) resolve to an older `windows-sys`; it is a Windows-only dependency;
- `data-encoding-macro-internal`, a proc-macro, resolves to `syn` 1 instead of 3.

A no-op update of another crate leaves the lock untouched, so the re-picks come from re-resolving around `tokio`, not from drift on main. Each pick satisfies the crate's own range, and the lock is cargo's, not hand-edited.

`cargo deny check advisories` passes locally. CI compiles the Linux and Android targets; Windows builds at release.
