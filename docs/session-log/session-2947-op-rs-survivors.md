# Session 2947 — op.rs mutation survivors

#6106 listed four cargo-mutants survivors in `agaric-store/src/op.rs`, all from weekly run 40304282199:
- `SetPropertyPayload::value` replaced with `Default::default()`;
- `BuiltinPropertyDef::options_json` replaced with `None`, `Some(String::new())` and `Some("xyzzy".into())`.

**Why they survived:** their callers are the reverse ops in `agaric-engine` and the property commands in the app crate, so the tests that read the values sit in other packages. The weekly lane mutates and tests one package at a time (`cargo mutants -p agaric-store`), so only `agaric-store`'s own tests can kill a mutant there.

**Killed by two unit tests in `op.rs`:**
- A payload built with `with_value` reads back each of the five value slots. That is the value a set's undo deletes and its redo restores.
- A select built-in's options are the JSON array `property_definitions.options` stores (`priority`, `todo_state`), and a built-in of another type has none (`due_date`).

**Suites:**
- `cargo mutants --workspace --in-place --file agaric-store/src/op.rs --re 'SetPropertyPayload::value|BuiltinPropertyDef::options_json'`, the two functions against the full `agaric-store` suite: 4 mutants, 4 caught;
- each test shown red against its mutant, with the source restored on exit;
- `cargo nextest run --workspace` over the new tests and their neighbours: 5 of 5;
- `cargo clippy --workspace --all-targets -- -D warnings`: clean.
