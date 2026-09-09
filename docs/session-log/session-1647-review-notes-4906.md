# Session 1647 — deleting the machinery the last fix did not need

Two non-blocking notes on #4906, both deletions, both correct.

## A struct that stopped earning its keep

#4906 changed the caller's gate from a row-count delta to "did the pass
scan". That made `LinkBackfill.added` dead weight: it gated nothing, and the
two `SELECT COUNT(*) FROM block_links` scans that produced it ran inside the
boot `BEGIN IMMEDIATE` purely to fill a log field.

Worse, it was the same net count the PR had just argued cannot describe a
pass. A vault that swaps one edge for another logged
`link-graph backfill filled the graph added=0` — a line that is wrong in
exactly the way the fix above it was about.

The struct, both scans and the log field are gone; the function returns
`bool`. Its two `.sqlx` cache entries went with it, in all four caches.

## Said once

"No arithmetic over `COUNT(*)` can answer this" appeared four times: the field
doc, the block comment above the return, the test doc, and session 1646. It
now lives in the function's `# Returns` section, which is where a caller
deciding what to do with the value will actually look.

## Verification

Four tests green unfiltered, whole workspace compiled, `cargo clippy
--workspace --all-targets -- -D warnings` clean, and `just gen-sqlx` drops
exactly the four orphaned entries and nothing else.

The tests keep their exact-count assertions — the two that used
`LinkBackfill.added` now read `count_rows(&pool, "block_links")`, which is the
same claim about the table rather than about a return value that no longer
carries it.
