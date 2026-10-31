# Session 3236 — the oracle checks every property row and definition against the space docs

#6206 slice 2 of 5. Before this, `reconcile_engine` compared only the four promoted columns with the engine. It left out "the other `block_properties` rows". The maintainer asked for every value to be checked once slice 1 gave each engine value a row, and for `property_definitions` to be checked against each space doc's root.

**`engine.block_properties.row`.** For each block that both the engine and SQL hold, `admissible_rows` folds each engine value into the rows it may legitimately have, using the oracle's own type check:
- Rules: `Num` → `value_num`, `Bool` → `value_bool`, `Null` → none, a `Str` that fits → its typed column, anything else → `value_text`.
- The check has its own ULID regex, date round-trip and number parse, transcribed from the projection rather than called. The maintainer required that.
- Promoted keys and `space` are left out. The membership check keeps blocks on one side only.

**The encoded legitimate differences:**
- **A dangling ref:** a ULID under a ref key whose block has no `blocks` row admits no row (the FK guard and the purge cascade).
- **A ULID under a text-like or undeclared key:** it may sit in `value_text` or `value_ref`. The local apply writes the payload's slot, the re-projection writes `value_text`, and a text→url retype leaves the row where it is.
- **A date under a text-like or undeclared key:** it may sit in `value_text` or `value_date`, for the same reasons.

The doc states the trade-off: a projection that wrongly sends such a string to `value_ref` or `value_date` reads as a local write and is not reported.

**`engine.property_definitions.row`.**
- It compares `value_type` and the stored options string of the SQL table against each doc's `property_definitions` root.
- Built-ins are in neither. Spaces with no engine are left out.
- A SQL-only row is reported, with an owner naming `repair_property_definitions`. That repair runs on every boot after recovery, so a booted vault cannot keep one.

**Traps.**
- The check found a real defect: a ref to a block projected later in the same import is dropped. Filed as #6232; the owner string cites it.
- Keys carry ids only (`{space} / {block}`, `{space}`). Property names and values sit in `expected`/`actual`, which the integrity report drops.
- Coverage is partly vacuous. The proptests generate only undeclared string keys, so typed columns, numbers, booleans, refs, values that don't fit and definitions are covered by unit tests only. Widening the shared generator would ripple into other suites' oracles.
- **Left for the maintainer:** a pre-§2.1 vault (numbers and booleans stored as strings in the engine) that was never re-projected would report a number or boolean under an undeclared key whose SQL row is in `value_num` or `value_bool`.

**Review.** A separate reviewer re-ran four reds: the projection's misfit drop, the ref-under-text encoding, the definitions upsert, and the dangling-ref encoding. It traced every flow (type change, merge, remove and undo, purge, a space with no engine, built-ins, promoted keys) for false positives and found none. It replaced an options-JSON normaliser that nothing needed with a direct comparison.

**Suites:** full `cargo nextest run --workspace`, clippy, `SQLX_OFFLINE` check, the four `sqlx prepare --check` lanes, `cargo test --doc`, and `prek` (both stages).
