# Session 1952 — empty-block cleanup keeps blocks that hold an attachment (#5412)

A block whose only content is an attachment was treated as empty. The blur
cleanup soft-deleted it, not undoably, the next time the user clicked into
it and left; the boot sweep deleted it after 7 days. `/attach` into a blank
block or a non-image drop hit it today; voice notes (#5364) and audio
attachments (#5410) would hit it on every recording.

What shipped:

- `src/lib/empty-block-cleanup.ts`: `carriesNothing` runs a fourth probe,
  `listAttachments`, alongside the other three; a rejected probe keeps the
  block.
- `agaric-engine/src/empty_blocks.rs`: `select_candidates` skips any block
  with an `attachments` row. No `deleted_at` filter: attachments are
  hard-deleted everywhere and nothing in production sets that column, and
  `list_attachments_inner` (the frontend probe) counts the same rows.
  `.sqlx` caches regenerated.
- The toolbar's Discard no longer deletes the just-created block itself. It
  had none of the cleanup's guards, and the focus change right after it
  already runs the guarded cleanup on that block. The `justCreatedBlockIds`
  bookkeeping it existed for is gone.
- `e2e-tauri/attachment-only-block-survives-blur.e2e.ts`: a control case (a
  blank block without an attachment is cleaned up by the same sequence) and
  the attachment case (it survives a round trip).

Verified: both arms falsified on copies on each side (SQL clause removed,
clause always true; probe ignored, probe always keeping, probe failure
swallowed; Discard removal re-added), all red and restored with `cmp`. Full
`cargo nextest run --workspace` 6,732 passed; full vitest 20,793 passed;
clippy, `SQLX_OFFLINE=true cargo check`, fmt, typecheck (including the
e2e-tauri project), oxlint and oxfmt clean. The e2e-tauri spec is
typechecked only; that lane runs in CI.
