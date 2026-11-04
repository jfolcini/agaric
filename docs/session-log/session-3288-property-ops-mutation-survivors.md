# Session 3288 — property_ops.rs mutation survivors

The weekly Rust mutation sweep left three survivors in
`agaric-engine/src/reverse/property_ops.rs` (#6246), in the undo of a property
rewrite and the key walk under it (#5841).

The two field-deletion survivors in `reverse_rewrite_properties` were not an
empty `defs` or `values`, as the issue text suggests: the struct ends in
`..payload`, so a deleted field is filled from the forward payload, and the
undo carries the forward writes unswapped. No test compared the reversed
payload. A new test reverses the phase-into-area merge fixture and compares
the whole reversed payload with `assert_eq!`. Both mutants fail on it.

The third, `==` to `!=` in `forward_in_space`'s `else if key == p.new_key`, sat
on a branch no test took: a rename onto the walked key. The new test walks a
key back through a rename onto it, and past a rename of two other keys, so
both arms are pinned.

Each red was shown by hand against the exact mutant. A scoped cargo-mutants
run (`-p agaric-engine --in-place --file …property_ops.rs`, as the weekly lane
shards by package) caught all three. The other ten mutants it generated
for the file do not compile.

Ran: the two tests through `cargo nextest run --workspace`,
`cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`.
