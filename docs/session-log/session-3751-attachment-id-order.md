# Session 3751 — Attachments made in one millisecond list in the order they were made

`conformance_fixtures_match_backend` went red on #6484 at random, in fixture `meeting_add`, query `the_recording_blocks_files`: the meeting's audio and transcript came back transcript first.

- **Cause.** `list_attachments` already orders by `created_at, id`, so the brief's "no tiebreaker" premise was wrong. The tiebreaker itself was random: `persist_attachment_in_tx` minted ids with `Ulid::generate()`, whose random part orders two ids from the same millisecond either way. `add_meeting` writes its files in one transaction, so they usually share a millisecond.
- **Fix.** Attachment ids come from one process-wide `ulid::Generator`, which is monotonic within a millisecond, so `id` follows creation order. No SQL change. The fixture stays as the backend authored it.
- **User-visible.** A block's attachments render in the order `list_attachments` returns, so a meeting's files no longer swap places between loads. The `meeting_add` fixture pins that order on both stacks.
- **Ran.** The new `attachment_ids_follow_the_order_they_were_minted_in_5364` (red with `Ulid::generate()` restored, green with the fix), `conformance_fixtures_match_backend`, and `cargo clippy --workspace --all-targets -- -D warnings`.
