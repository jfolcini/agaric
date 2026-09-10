# Session 1691 — four mutation survivors in the audit-ingest path

The weekly mutation lane left four survivors in
`agaric-sync/src/sync_protocol/operations.rs` (#4933): the out-of-order
comparison `record.seq < highest` mutated to `<=`, `outcome.already_held += 1`
mutated to `*=` and to `-=`, and the wire-batch cap `current_bytes + rec_bytes >
max_bytes` mutated to `>=`. All four are boundary or counter mutants, and all
four survived for the same reason — the existing tests never present a case
where the boundary is the answer.

The first three fall to one scenario the estate had no test for: a device
presenting the same `seq` twice inside one batch. `<` is the intended
comparison, and the code already says why in prose — a record arriving *below*
the frontier this batch moved past can never be re-offered, while a record
arriving *at* it strands nothing, because its own seq is the one already
presented. `INSERT OR IGNORE` matches the existing row and it lands in
`already_held`. So the new test hands `ingest_replicated_batch` the seqs
6, 6, 7, 7 — interleaved rather than 6, 7, 6, 7, so the repeat is always the
highest seq so far and a genuine violation cannot be confused for the duplicate
— and asserts the whole outcome exactly: `out_of_order == 0`, `ingested == 2`,
`already_held == 2`, `deferred == 0`, `rejected == 0`, plus two rows in
`op_log`, which is the durable half. The `<=` mutant reports two violations
where there are none; `*=` leaves `already_held` at zero; `-=` overflows a
`usize` at the first duplicate.

The fourth is the wire-batch cap, and the existing test could not reach it: it
sized the cap to fit exactly one record, where `>` and `>=` agree (two records
exceed a one-record cap either way). The boundary only shows when a batch fills
to *exactly* `max_bytes`, so the test now also runs a two-record cap — five
records partition 2 + 2 + 1 under `>`, and one-per-batch under `>=` — and the
one-byte-short cap, which must split. It also takes its record size from
`billed_bytes` instead of re-deriving `len() + 2` inline, so the test cannot
drift from the helper the production loop bills with.

No production change: all four mutants are ordinary weak-test survivors, none
revealed a defect, and none was judged equivalent.

## Verified

- `cargo nextest run --workspace -E 'test(/batch_ops_for_wire|duplicate_seq_is_already_held|out_of_order|shuffled_batch/)'`:
  8 tests run, 8 passed.
- Falsified on a copy of `operations.rs`, restored `cmp`-clean after each:
  - `228 <` → `<=`: `out_of_order` left 2, right 0.
  - `257 +=` → `*=`: `already_held` left 0, right 2.
  - `257 +=` → `-=`: "attempt to subtract with overflow" at `operations.rs:257`.
  - `731 >` → `>=`: batch count left 5, right 3.
- Not run locally: the full suites, clippy, prek (CI carries them).
