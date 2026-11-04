# Session 3307 — MCP lists attachments with their paths on disk

Slice S1 of #5410's build plan: the read half of the MCP attachment surface,
so a local agent can find a synced voice note's audio and read it from disk.

`list_attachments { space_id, block_id | page_id, cursor?, limit? }` returns
each attachment's id, block, filename, MIME type, size, created time and
absolute path. The page form joins `blocks.page_id` with `deleted_at IS NULL`,
so it covers the page's own files and every live block's. Attachments are
hard-deleted, so the block predicate is the only one needed. The existing
`list_attachments_inner` has no cursor, so both forms got their own keyset
query on the attachment id. `get_block` and `get_page` carry
`{ id, filename, mime_type }` entries, left out when empty; `get_page` fills
the page and its children from one `list_attachments_batch_inner` call.

The plan put `app_data_dir` on `ReadWriteTools` in S2; it had to come now,
since `ReadWriteTools::new` builds its own `ReadOnlyTools`. Both take it as a
constructor parameter, so a missing wire fails to compile.

Trap: ULIDs keep creation order only across milliseconds, so tests that
expected creation order were flaky; they expect id order, which is what the
query promises.

Ran: `cargo nextest run --workspace` in two partitions, clippy over the
workspace, `just gen-sqlx` (no drift), `prek run --hook-stage manual
--all-files`. Falsified the deleted-block predicate, the child entries in
`get_page`, both cursors (`>` to `>=`) and the space check.
