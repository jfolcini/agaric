## Session 971 — Scope per-block FTS ref-map load to the block's own refs (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Subagents** | orchestrator build + 1 review |
| **Items closed** | `#418` |
| **Items modified** | — |
| **Tests added** | +2 backend (`load_ref_maps_for_block_is_scoped_to_block_refs`, `load_ref_maps_for_block_empty_for_no_refs`) |
| **Files touched** | 4 |

**Summary:** Fifth batch of the 2026-06-05 SQL backend audit. The per-block
`UpdateFtsBlock` materializer handler called `load_ref_maps`, which loads *every*
page and tag block in the vault into a `HashMap` on **every single edited block**
(O(pages + tags) per edit) just to resolve the handful of `#[ULID]` / `[[ULID]]`
refs in that block. The new `load_ref_maps_for_block` extracts only the refs
present in the block's own content and fetches just those rows via two bounded
`id IN (json_each(?))` seeks, then feeds them to the unchanged
`update_fts_for_block_with_maps` (so NFC normalisation and conflict-row filtering
are preserved). The full-scan `load_ref_maps` stays for the batch rebuild paths
in `index.rs`, where loading once and reusing across all blocks is the right
trade-off.

**Files touched (this session):**
- `src-tauri/src/fts/strip.rs` — new `load_ref_maps_for_block`.
- `src-tauri/src/fts/mod.rs` — re-export swap (`load_ref_maps` → `load_ref_maps_for_block`; `load_ref_maps` still reachable via `strip` for `index.rs` + tests).
- `src-tauri/src/materializer/handlers.rs` — `UpdateFtsBlock` uses the scoped loader.
- `src-tauri/src/fts/tests.rs` — 2 new tests + updated 2 existing refs to `crate::fts::strip::load_ref_maps`.

**Verification:**
- `cargo nextest run -E 'test(load_ref_maps) or test(fts)'` — 283 passed; `-E 'test(materializer) or test(update_fts)'` — 256 passed.
- Review subagent: confirmed the scoped path routes through the NFC-correct `_with_maps` variant, raw-content ref-extraction is a safe superset (markup delimiters never overlap ref tokens), the `deleted_at IS NULL` filters match the old loader, and no dangling references after the re-export swap.
- No migration / `.sqlx` change (the per-block content `query_scalar!` matched an existing cached query; the IN-queries are runtime-checked `query_as`).

**Commit plan:** single commit; pushed; PR against `main`.
