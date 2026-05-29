## Session 883 — BlockId newtype propagation, batch 7 (snapshot types) (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | orchestrator + 1 build (verified independently incl. snapshot round-trip tests) |
| **Items closed** | — |
| **Items modified** | `#107` (batch 7 of N — the sensitive snapshot batch) |
| **Tests added** | — (type migration; test fixtures canonicalised) |
| **Files touched** | 5 (+ .sqlx) |

**Summary:** Batch 7 of the `BlockId` newtype migration (#107) — the `snapshot/types.rs` row structs the plan flagged for encode/decode review. Converted the block-ULID fields to `BlockId`. Because `BlockId` is `#[serde(transparent)]` over `String`, the CBOR (`ciborium`) snapshot wire format is byte-identical; the snapshot round-trip tests are the empirical proof and they pass. Type-only — no behaviour change.

**Fields converted (`src/snapshot/types.rs`):** `BlockSnapshot.{id, parent_id}`, `BlockTagSnapshot.block_id`, `BlockPropertySnapshot.block_id`, `BlockLinkSnapshot.{source_id, target_id}`, `AttachmentSnapshot.{id, block_id}`. Left `String`: all `*page_id*` (separate question), `tag_id`, `key`, `device_id`, hashes, dates, mime/filename/fs_path, value_type.

**Files touched (this session):**
- `src/snapshot/types.rs` — the 8 field conversions.
- `src/snapshot/create.rs` — the `blocks` `query_as!` gained `id`/`parent_id` column-type annotations.
- `src/sync_daemon/snapshot_transfer.rs` — one test fixture `.into()`.
- `src/snapshot/tests.rs` — fixture/proptest id construction via `BlockId::test_id` / `.into()`; **toy lowercase block-id literals canonicalised to uppercase** (147 + 6 tag-block tokens) because `BlockId` normalises to uppercase on deserialize/construct (the blake3-determinism invariant), so non-canonical test IDs round-tripped uppercase while assertions / embedded SQL `WHERE` / FK refs still used lowercase. CBOR bytes are unchanged for canonical inputs; this only affected toy IDs.
- `src-tauri/.sqlx/` — 1 query JSON swapped.

**Verification:**
- `cargo build --tests` — 0 errors (orchestrator re-ran independently; subagent green held).
- `cargo nextest run` — 4067 passed, 0 failed (1 unrelated pre-existing flaky self-recovered). **All 64 `snapshot::` tests pass — the round-trip/CBOR encode-decode proof.**
- `cargo clippy --all-targets` — 0 errors / 0 new warnings.
- `cargo sqlx prepare --check` passes; `bindings.ts` unchanged (snapshot types not specta-exposed); pre-commit + pre-push hooks pass.

**Commit plan:** single commit / pushed. This clears the FromRow surface the #107 plan enumerated (the `*page_id*` typing is a separate follow-up question). #107 stays open for the maintainer to confirm remaining scope (command-param inputs, page-id typing).
