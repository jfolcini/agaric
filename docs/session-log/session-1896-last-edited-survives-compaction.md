# Session 1896 — "Last modified" survives op-log compaction (#5286)

This is another `/batch-issues` batch from the session that logged 1877. A
builder subagent wrote the change while #5318 (#5295) waited on CI. This
session reviewed the diff and re-ran the checks below.

## #5286

- **The bug.** Every created and last-edited value was read from `op_log`, and
  the 90-day compaction deletes each block's old ops without a snapshot. After
  compaction, most pages read "Last modified never". They fell into the NULL
  tail of "Recently modified", and Advanced Query bucketed old blocks as
  "none".
  - Created buckets used `MIN(op_log)`, so an old block edited recently landed
    in its last-edit month. The Created sort already used the ULID.
- **The fix.** One definition, in `filters/primitive.rs`:
  - `ulid_created_ms_sql` decodes the creation ms a ULID embeds. A non-ULID id
    decodes to NULL, so callers keep their existing fallback.
  - `last_edited_ms_sql` takes the newest op, else that creation time.
- **Where it is used.**
  - The Pages `last_modified_at` column and the "Recently modified" keyset.
  - The `LastEdited` filter primitive.
  - Advanced Query's last-edited sort and column. Its Created bucket now comes
    from the ULID, and its LastEdited bucket from the newest op, else creation
    time.
  - The legacy FTS filter.
- **The mock mirrors it.** `blockLastEditedAt` returns the newest op, else the
  ULID time, and the Pages and Advanced Query handlers read it.
  - The conformance fixtures were re-authored from the backend, and no values
    changed.

## Verified

- New tests, each turned red by a mutation run against a copy:
  - the SQL decode matches the Rust decoder for five ULIDs and is NULL for six
    non-ULID strings;
  - Advanced Query's Created and LastEdited buckets and its last-edited sort;
  - the Pages command after a real `compact_op_log_cmd_inner(…, 90)`: the
    value, the "Recently modified" order and a last-edited Range filter;
  - five mock tests for the same values, filter and sort.
- An existing test whose "no op" page id happened to be a valid ULID now uses
  a non-ULID id, so it still covers the sentinel tail.
- Builder: `cargo nextest run --workspace`, 6697 tests pass; clippy and
  `cargo fmt --check` are clean; the mock suites pass, 54 files and 1394
  tests.
- Re-run here on the final tree: the 26 matching Rust tests, the two touched
  mock test files (128 tests), and `npm run typecheck`.
