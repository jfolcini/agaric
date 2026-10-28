# Session 2967 — The mock keeps a block's space only in `space_id` (#6054 D1)

Set out to remove the mock's second copy of space membership (#6054 item D1).

**The problem.** The backend has no `space` property row: migration 0087 deleted those rows, and 0088's `key_not_reserved` CHECK forbids them. `SetProperty(space)` and `DeleteProperty(space)` project onto `blocks.space_id`. The mock kept a `space` row beside the column, synced the two by hand at nine writes and thirteen reads, and hid the row from property reads, the snapshot and revert.

**Shipped:**
- The row is gone. Every read goes through the column, either the block's own `space_id` or its owning page's.
- `set_property(space)` writes the column after the backend's target checks, `delete_property(space)` clears it, and revert restores it.
- Seeded and imported pages, which only ever got the row, now get `space_id`.
- The import path stamped `''` instead of null for "no space", which the own-first readers did not fall through on. Fixed.

**Review fixes:**
- **Page-group fan-out.** The backend writes a space over the whole page group (`UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?`). The mock's move, set, delete and revert wrote only the page row, so a child kept its old space and `add_tag` refused a same-space tag. All four now go through `setPageGroupSpace`.
- **One live-space check.** `isLiveSpace` replaces four inline copies. `import_bibliography` now refuses what `require_live_space_in_tx` refuses: a live page that is no space, or a deleted space. It and `move_blocks_to_space` throw that function's exact message.

**Traps:**
- A rebase onto #6134 conflicted in `conformance-query.ts` `stampMockSpace`, which B4 had widened to stamp a `space` property on root tags. The resolution keeps the column-only stamp and B4's `opLog` import.
- The mock's `create_block` still leaves a block created under a page with a null `space_id`, where the backend stamps the page's space in the same transaction. That is why the readers still fall back to the owner page.
- `move_blocks_to_space` still accepts content blocks, which the backend refuses. That is #6054 B3.

**Suites:**
- vitest `src/lib` after the rebase: 211 files, 5729 passed;
- `src/stores`, `src/hooks` and `src/components` in batches;
- the conformance suite;
- typecheck, lint and knip;
- Playwright: the spaces, properties, tags and templates specs, 86 passed.
