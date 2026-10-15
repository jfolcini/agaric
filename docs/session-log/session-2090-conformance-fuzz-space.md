# Session 2090 — Conformance fuzz: generated `create_block` carries its space

The ignored `conformance_fuzz` lane went red in the weekly `bench-slo` job:
"the mock REJECTED a chain the backend applied: create_block requires an active
space scope". Since #5415 (#5473) the mock refuses a `create_block` without an
active `SpaceScope`, but `chain_to_fixture` still rendered generated creates
without one, and the backend harness applied them anyway.

The renderer now writes `"scope": { "kind": "active", "space_id": "$SPACE" }` on
every generated `create_block`, the same shape the hand-written fixtures use and
the harnesses on both sides already expand to the test space.

Suites run: `cargo nextest run --workspace --run-ignored all -E
'test(conformance_fuzz)'`, red on `main` with the error above and green with the
fix.
