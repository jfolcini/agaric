# Session 4004 — Mirror mutation survivors in the helper files (#5363, PR 4a)

A cargo-mutants run over `src-tauri/src/mirror/*.rs` left mutants that survive the whole mirror suite. This session settled the ones in `store.rs`, `paths.rs`, `assets.rs`, `splice.rs` and `read_back.rs`. `mod.rs` and `ingest.rs` are PR 4b's. The hardening session drafted an overlapping patch at the same time; the tests here merge the two.

## Decisions and traps

- Root ignores file permissions, so a permission error can't stand in for "any error but NotFound". The store and read_back tests put a directory where a file belongs, or a file where a directory belongs, and assert the exact `ErrorKind`.
- `adopt_legacy`'s rename (store.rs) does fail in a test: point the new state directory at a dangling symlink. `exists()` is false for it, and renaming a directory over it gives ENOTDIR. Its NotFound arm is reachable only when another bind adopts the states between `exists()` and `rename`, so the two mutants that need it are explained, not killed.
- `Laid::of`'s line-order guard (splice.rs) is reachable: the reader ends a line at a lone `\r`, and `split('\n')` does not. Without the guard, `Laid::of` panics on such text.
- `asset_name`'s first Untitled check was redundant: the trim and the check after it give Untitled for an empty or all-dots name too. It is deleted, and the export vectors still pass.
- Falsification applied each mutant by hand, one subshell per mutant with a `trap` restore. A textual `a || b && c` is not the AST mutant `(a || b) && c`; write the parentheses.

## Shipped

PR (this one). Suites run: `cargo nextest run --workspace -E 'test(/mirror::/)'`, each new test against its mutant, and `cargo clippy --workspace --all-targets -- -D warnings`.
