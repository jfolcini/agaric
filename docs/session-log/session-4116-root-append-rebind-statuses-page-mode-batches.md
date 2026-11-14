# Session 4116 — A root entering a space appends; a rebind clears two statuses; page mode batches its creates and deletes

Four leftovers from older issues, one PR: #6527's last box, #6526's two latching statuses, #5363's boot measurement, #6559 box 4.

## #6527: a page or tag create no longer reads every root

The seed at space assignment ranked a top-level block by its stamp against every root of the space (`ranked_slot`), then read the whole root order back for the reprojection. The stamp is a rank the block held somewhere else (among every space's roots when it was created, or in the space it left), so the slot it gave was arbitrary, and nothing arranges top-level blocks. The seed now appends (`apply_append_root_block`) and reads the order from the root before its own slot (`children_ordered_block_ids_from`); `reproject_dense_tail` takes that window. When the root before the tail is off its rank the caller reads the whole group again and writes it, as before.

Visible change: a page or tag moved into a space, and the first page of a new space, take the last root rank. The mock ranked arrivals ahead of residents to imitate the stamps (`rankArrivals`); it now puts them after, in arrival order, and the fixtures that pin those ranks were re-authored by the backend.

Traps:
- The tail's oracle (the whole-group write, debug test builds only) reads every sibling, so it runs under `sibling_read_spy::uncounted`; otherwise the read-count test counts the oracle.
- A replayed seed and a repair still write the whole group. Only the slot rule changed for a replay.
- `create_page_in_space` still reads every title of the space for the name check (`SpacePageNames::read`): SQLite cannot apply the name fold. A folder import is still quadratic in that, with a smaller constant. Removing it needs a stored name key, which is a schema change.

Measured with the `page_heavy` probes of `interactive_slo` (33,000 pages, `--profile release-test`, a 4-core cloud box at load 1.5, two interleaved runs each): `create_page_in_space` 154 and 135 ms before, 47 and 46 ms after; a one-block file import 296 and 289 ms before, 208 and 199 ms after. The probes the change does not touch moved by under 10% between runs.

## #6526: a rebind clears what the last endpoint reported

`SyncEvent::EndpointBinding` is emitted first in `bring_up_endpoint`. `TauriEventSink` resets `MdnsStatusState` and `BindExposureStatusState` on it, and `useMdnsStatus` / `useBindExposure` reset on `sync:endpoint_binding`. The events that follow in the same bring-up set them again when they still hold. It is an app event, not a wire message.

## #5363: boot with the mirror on and off

No code. The numbers and commands are in the issue's comment of 2026-11-13: the mirror's task sleeps one tick before it opens the folder, so it cannot delay `boot resolved`, and the measured difference (+20 ms) is inside the noise. `scripts/measure-boot.mjs` stops each boot before the mirror's first pass, so contention after boot is not something it can show.

## #6559 box 4: page mode's creates and deletes go out as one batch each

`CreateBlockSpec.block_id` is the client id `create_block` already took; `delete_blocks_by_ids` answers `WithOps` with `deleted_at`, its refs in the order of the ids given. `savePage` sends two or more creates ahead of a restore, and two or more deletes, as one batch. A batch is all or nothing, so a refused one is sent again a write at a time, which keeps the per-write failure handling. A single create or delete keeps its own command.

Call counts on the mock, page mode: a 20-line paste was `create_block` ×19, now `create_blocks_batch` ×1; a 21-block delete was `delete_block` ×20, now `delete_blocks_by_ids` ×1. The `set_property` ×19 of a list paste is the list style, written a block at a time after the save; not changed.

Traps:
- The batch delete skips an id that is already deleted where `delete_block` refuses it. When every id was skipped `deleted_at` is null and page mode falls back to single deletes. When only some were, page mode records the batch's `deleted_at` for the skipped block, and a later undo of it goes through the refused-write reread.
- One Ctrl+Z already undid a 300-line paste: page mode's undo is ProseMirror's history. The real limit is `MAX_REVERT_OPS` for a page-level undo after leaving page mode, before and after this change.
- `e2e-tauri/page-mode-batch-paste-undo.e2e.ts` was not run locally (no tauri-driver here); CI's real-backend lane is its first run.

## What ran

Full vitest; `npm run typecheck`; `npm run lint`; the page-mode and spaces Playwright specs plus the new one (`just e2e-related` selects both whole lanes, which CI runs); `just gen-sqlx` and `just gen-bindings`; `SQLX_OFFLINE=true cargo check --workspace --all-targets`; clippy over the workspace; the whole nextest suite in two halves; doc-tests; `prek run --hook-stage manual --all-files`. Each new test was shown red by breaking the code it covers.
