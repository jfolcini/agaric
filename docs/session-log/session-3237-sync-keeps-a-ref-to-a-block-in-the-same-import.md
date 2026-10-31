# Session 3237 — inbound sync keeps a ref to a block that arrives in the same import

#6232: when a ref property and the block it points to arrived in the same sync import, the receiving device lost the ref. `project_pass_a` projected each changed block's core row and then its properties, one block at a time. A page's ref to its new child therefore met the FK guard in `reproject_property_row_from_engine` (#377) before the child had a `blocks` row. The row was dropped and stayed missing until the page changed again. 0.21.0 shipped the same per-block pass.

- Pass A now writes every changed block's core row before any property row, as recovery already does.
- The space's own block keeps a first chunk of its own, written whole (core, then properties). Its `is_space` row fires `spaces_register_is_space`, and every other core row reads that registration for its `space_id`. A plain two-loop split breaks `a_space_created_on_one_device_reaches_its_peer_4775` and `a_space_created_before_it_had_a_doc_reaches_its_peer_4775`, so those tests pin the chunking. The new `apply_remote_keeps_a_ref_to_a_block_the_same_import_brings_6232` pins the order.
- The definitions pass, Pass B (tags, aliases, attachments) and recovery needed nothing. A review scratch test confirmed that a holder, a retype to ref and a new target in one import keep the ref, because Pass A re-inserts the row.
- `e2e-tauri/sync-ref-to-new-block.e2e.ts` covers it end to end: the app declares a ref key, the sync peer creates a page and a child and sets the ref, and the app pulls and shows the ref row. It has not been run locally (no `tauri-driver`). CI's `e2e-tauri-gate` runs the whole real-backend lane, because the diff touches non-test Rust.
- The #6206 oracle's owner string for `engine.block_properties.row` cited this defect. It now names the one remaining way to lose a ref like this: across spaces, when the target's space is imported after the holder's, depending on import order on a fresh pairing. That is filed as #6236.

**Accepted:** a ref set on the space block itself, to a block in the same import, still drops. Nothing in the UI writes properties on a space block.

**Review.** A separate reviewer reproduced both reds (the fix reverted, and a plain two-loop split) and corrected two comments that overstated the order.

**Suites:** full `cargo nextest run --workspace` (both partitions), clippy, the `SQLX_OFFLINE` check, `cargo test --doc`, `npm run typecheck:e2e-tauri`, `prek` (both stages); after the rebase onto the oracle, the oracle and sync tests.
