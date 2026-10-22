# Session 2867 — moves and edits record their prior state, so undo works on a block a peer made or changed

This session fixes #6046, from the 2026-10-22 architecture review (#6055).

**What was broken:**
1. **A move of a block created on another device couldn't be undone.** `find_prior_position` and its batch twin read only `is_replicated = 0` rows, and that block's only create row is replicated.
2. **Text undo could restore a stale version.** `prev_edit` was stamped by `LatestCausal`, which orders by `seq` across devices. `seq` is a per-device counter.
3. **Undoing a redo could overwrite a value a peer wrote in between.** A reverse `SetProperty` carried `prior: None`.

**The change.** An op records the state it replaces, and the reverse kernels read that record first.
- **`MoveBlockPayload.prior`** (`BlockPlacement { parent, index }`): `move_block_in_tx` stamps it from the live SQL siblings (`live_placement`) in the same `BEGIN IMMEDIATE` transaction as the append.
- **`EditBlockPayload.prior_text`:** `find_prev_edit_in_tx` reads `blocks.content` in the transaction. It points `prev_edit` at the newest row holding that text, replicated rows included (`LatestHolding`). Only when no row holds the text does it fall back to the causal row and record `prior_text`.
- **Reverse ops.** Every append site in `history.rs` stamps through `with_recorded_prior_in_tx`: positional undo, redo, and batch revert. Undo and redo of a move or a property are then exact inverses, and a redo never writes an older local value over a peer's.
- **Revert order.** `plan_reverse_apply_order` reverts newest-first when the moves carry priors. Moves written before this change keep the legacy ascending path.
- **Byte and hash stability.** The new fields are `serde(default, skip_serializing_if = "Option::is_none")`, so old ops keep their bytes and hashes. A test pins both. Remote ingest hashes the raw payload, and no op payload lives in Loro, so `ENGINE_FORMAT_VERSION` is unchanged.

**Caught in review: a performance regression.**
- **The cost.** `LatestHolding` ordered by `seq DESC, device_id DESC`, which made SQLite sort every row of the block and `json_extract` each payload on every edit commit. On a dev build that roughly doubled the old stamp. The 10,000-edit, 4 KB block went from about 40 ms to about 100 ms per commit.
- **The fix.** It now orders by `created_at DESC LIMIT 1`, which follows `idx_op_log_block_created`, so the walk stops at the newest holder and the cost no longer grows with the edit count. Which holder row is named doesn't matter: all hold the same text, and the kernels read only the text.
- **Measured.** The measuring harness was temporary and is not committed, so the figures are directional only. With the fix, the stamp is about 0.2–0.3 ms at every size measured.
- **Two store tests pin it:** the newest holder wins, and an older row with a non-JSON payload is never decoded.

**AGENTS.md.** With the maintainer's approval, one clause in `src-tauri/src/commands/AGENTS.md` now says that a create with no slot makes the block's first move non-reversible only when that move records no `prior`. That means a move written before this change, or a boot repair's. The stale copies of the old claim in `block_ops.rs` and the mock's `appendSlot` doc were fixed too.

**Accepted trades, from the review:**
- A reverse edit and a reverse delete-property are not stamped. Their redo differs only after a peer write in between, which the undo had already lost.
- Boot-repair moves and draft recovery record nothing.
- `compute_edit_diff_inner` keeps its timestamp scan, because it is display-only.

**Shown red:** with these mutated, the predicted assertions failed:
- the holder query's old order;
- `prior: None` on forward moves;
- reverse moves left unstamped;
- the redo site's stamp;
- the batch kernel ignoring `prior`;
- the order planner's prior check;
- `LatestCausal` in `find_prev_edit_in_tx`.

The failing tests included the conformance fixture `redo_of_a_move_undone_out_of_order` and `undo_and_redo_keep_a_value_a_peer_set_in_between_6046`.

**Suites run:**
- `cargo nextest run --workspace` in four quarters: 7,137 passed;
- doc-tests;
- clippy with `-D warnings`;
- `SQLX_OFFLINE` check;
- the four `sqlx prepare --check` lanes;
- vitest over the tauri mock;
- typecheck;
- `prek run --hook-stage manual --all-files`.
