# Session 1217 — Expand mock-vs-real conformance coverage + fix create_block page_id

**Issues:** #155, #763

## Problem

The mock-vs-real conformance harness (#763) verifies the JS Tauri mock against the real
Rust backend by replaying op sequences against backend-authored `expected` state. Coverage
was thin on multi-op lifecycles (interleaved create/edit/move/delete/restore, tag re-add,
cross-page moves that must retain properties, cascade restore after reorder). While
extending it, the mock's `create_block`/`create_blocks_batch` handlers were found to stamp
a child's `page_id` with the raw immediate `parentId` instead of the parent's **root**
page_id — a #1775-class divergence from the backend, which copies the parent's own
`page_id` (one hop, resolving to the root page for content-under-content creates).

## Fix

Two changes, confined to the conformance domain + the mock create handler:

1. **`src/lib/tauri-mock/handlers/blocks.ts`** — `create_block` and `create_blocks_batch`
   now resolve the parent's ROOT `page_id` (page parent → own id; content parent → the
   parent's `page_id` column), mirroring the move handler (blocks.ts:571-582) and the
   backend's `set_block_page_id_from_parent` (`agaric-store/src/cache/page_id.rs:286-299`).
   The old `page_id: parentId` only diverged for nested (content-under-content) creates.

2. **7 new conformance fixtures** (`conformance/fixtures/*.json`), each with a
   backend-authored `expected` (`CONFORMANCE_UPDATE=1` against the real Rust runner):
   `interleaved_lifecycle`, `edit_then_move_link_survives`, `multi_property_delete_one`,
   `tag_readd_after_remove`, `reorder_then_cascade_restore`, `agenda_reset`,
   `move_cross_page_retains_property`. All seed only `blocks` (no seed properties/tags) to
   keep op_log_digest parity between the TS direct-store seed and the Rust op-log path.

## Verification

- `cd src-tauri && cargo nextest run -E 'test(conformance_fixtures_match_backend)'` → 1 passed
  (re-run WITHOUT `CONFORMANCE_UPDATE` proves fixtures are backend-authored, not hand-tuned).
- `npx vitest run src/lib/tauri-mock/__tests__/conformance.test.ts` → 23 passed (incl. 7 new).
- `npx vitest run src/lib/tauri-mock` → 199 passed (handler-fix regression check).
- `npx vitest run` (full) → 15617 passed across 712 files.
- Adversarial review confirmed the page_id fix against the real backend's incremental stamp
  and the nested-create runtime path (fixture `interleaved_lifecycle` B5.page_id = B1 root),
  and that no e2e spec relied on the old immediate-parent behavior.
