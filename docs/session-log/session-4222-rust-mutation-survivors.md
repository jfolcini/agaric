# Session 4222 — the Rust mutation-survivor tracker (#4690)

Worked the 19 survivors #4690 tracked from scheduled-deep-checks run 43718156458: `loro/engine/snapshot.rs` and `agaric-store/src/op.rs` (8 each), and one each in `apply.rs`, `property_defs.rs` and `sync.rs`. The frontend tracker went in its own PR.

## What shipped

- **`snapshot.rs`:** the newer-build test exports through `export_snapshot_as_format`, and asserts that a fresh engine reads no stamp and that the refusing engine reads the newer stamp the boot dialog names (`format_version_stamp`). The boot test in the app crate already pinned both, but the weekly lane mutates a package against that package's own suite.
- **`import_saved_rows`** no longer reads `pending` off the snapshot import. A full snapshot holds its whole history, so it is never pending; the `|=` survivor was that dead read.
- **`op.rs`:** a store test writes a `PropertyList` as its column text and reads it back through SQLite, and changes its string items in place. `PropertyList`'s `compatible` override is deleted: it repeated the default, which accepts exactly the `TEXT` type `&str` accepts. `texts_mut` arrived after the sweep with #6834 and the same test now pins it too.
- **`apply.rs`:** `seed_block_at_slot` gets a test that seeded blocks land at the slots given.
- **`property_defs.rs`:** the list option-rename test adds a block whose list holds only the old name, the case `any(s != old)` gets wrong.
- **`sync.rs`:** a test pins `imported_since` false for the version just read and for the engine's own writes, true for a later foreign import.

## What ran

- `cargo mutants --workspace` over every mutant of the tracked functions in the five files (46), scanned with the weekly lane's narrowed nextest filters: 28 caught, 13 unviable, 5 missed, none of them tracked. Re-run without the filter, the two `import_saved_rows` misses are caught; the three `texts_mut` ones were caught once the test pinned it.
- `cargo mutants` runs a mutant against its own package's tests, which is why the weekly lane saw survivors the app crate's tests would kill.
- nextest on the new tests and the loro, op and snapshot slices; workspace clippy.
