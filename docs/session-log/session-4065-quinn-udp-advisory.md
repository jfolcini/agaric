# Session 4065 — `quinn-udp` advisory reddens `main`

`main`'s `lint` job failed at `cargo audit` on two pushes of 2026-11-13: RUSTSEC-2026-0538, "Receive loop can spin after a truncated datagram", in `quinn-udp` 0.5.14 (under iroh's QUIC transport, so the sync path). Pull requests stayed green because the audit runs only when the dependency files change.

## Shipped

`quinn-udp` 0.5.14 → 0.5.16 in `src-tauri/Cargo.lock` and `src-tauri/fuzz/Cargo.lock`. No manifest changes: 0.5.16 is inside every existing requirement.

## Trap

`cargo update -p quinn-udp --precise 0.5.16` with the container's cargo also re-pointed eleven unrelated packages at older `windows-sys` lines and one at `syn` 1. The bump here edits the version and checksum of the one package by hand instead, and `cargo metadata --locked` accepts both lockfiles.

## What ran

- `cargo audit`: no vulnerability left (the `rustix` unsound warning and the yanked-crate warnings are not blocking and were there before).
- `cargo metadata --locked` in `src-tauri` and `src-tauri/fuzz`: both pass.
- `SQLX_OFFLINE=true cargo check -p agaric-sync --all-targets`: finished clean.

Not run: the test suites. CI is the check.
