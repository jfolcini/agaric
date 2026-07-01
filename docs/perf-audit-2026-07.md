# Agaric Performance Audit — verified findings (2026-07-01)

Method: 16 domain-scoped finder agents swept the full Rust+TS surface (~95 raw
findings), then 17 adversarial verifier agents re-read the actual code for every
finding to catch exaggerations, hallucinations, wrong complexity claims, and
correctness-breaking fixes. Only verifier-adjusted results appear below.
Outcome: ~30 actionable (verified CONFIRMED), plus low-value quick wins; ~20
findings were rejected as FALSE / already-implemented / unsafe (listed at the
end so they are not re-investigated).

Legend: **impact** and **effort** are the verifier-adjusted values (not the
finder's original optimistic rating). "hot" = runs on typing / page-load /
search / scroll / sync.

---

## Tier 1 — High impact, verified safe (do these first)

### 1. Drop `RebuildProjectedAgendaCache` from the add_tag/remove_tag dispatch arm
- `src-tauri/src/materializer/dispatch.rs:762` · category: scope-refinement · hot · effort: **small**
- Every tag toggle enqueues a **full-vault** projected-agenda rebuild, but the
  projected query reads only block core columns + `block_properties`
  (repeat*/template) and touches no tag table — a tag edge can never change it.
- Fix: delete the one-line push (keep `RebuildTagInheritanceCache`). Verifier
  confirmed cache stays consistent; precedent is the #2037 `SetProperty` gating.

### 2. Gate `clear_on_success` DELETE on a "pending retries exist" flag
- `src-tauri/src/materializer/consumer.rs:740` (→ `retry_queue.rs:578`) · do-it-once · hot · effort: **small**
- Every successful background task (UpdateFtsBlock, ReindexBlockLinks… produced
  on every edit) runs a write-pool `DELETE … WHERE block_id=? AND task_kind=?`
  even when no retry row ever existed — pure write-pool contention on the single
  writer during edit/import bursts.
- Fix: add a `QueueMetrics` atomic (seeded from `pending_count` at boot); skip
  the DELETE when zero. A stale flag is safe — the sweeper re-clears.

### 3. Move CRDT export/import off the async runtime + shard the registry mutex
- `src-tauri/src/sync_protocol/loro_sync.rs:264` (export) and `:631` (import) · main-thread-offload · hot · effort: **medium**
- `prepare_outgoing` export and `apply_remote` import run CPU-bound CRDT
  serialize/decode **synchronously while holding the process-global**
  `Mutex<HashMap<SpaceId, LoroEngine>>`, so multi-peer sync sessions
  head-of-line-block each other and stall the daemon's async loop.
- Fix: `spawn_blocking`/`block_in_place` for the encode/decode (guard is `!Send`
  — `block_in_place` is the pragmatic route), or shard the mutex per space.

### 4. Use the stored `content_hash` instead of re-hashing every attachment on send
- `src-tauri/src/sync_files.rs:967` (→ `:560`) · do-it-once · hot · effort: **small**
- The file-transfer sender streams the whole file and recomputes blake3 for
  `FileOffer.blake3_hash` on **every send**, though `attachments.content_hash`
  (migration 0093) already stores that exact digest and the receiver re-verifies.
- Fix: read `content_hash`; fall back to hashing only when NULL or size/mtime
  drift. Big win for vaults with many/large attachments and repeated re-syncs.

### 5. Batch group-undo through `revert_ops_in_tx` instead of N sequential IPCs
- `src-tauri/src/commands/history.rs:817` + `src/stores/undo.ts:325` · unify-hot-path · hot · effort: **medium**
- Holding Ctrl+Z loops `performSingleUndo` → one `undo_page_op` IPC per op, each
  re-running the recursive `page_blocks` CTE + `LIMIT 1 OFFSET N`. A 20-op group
  = 20 IPCs / 20 CTE walks / 20 writer-lock acquisitions.
- Fix: resolve the group's op refs once (the `find_undo_group` query already
  enumerates them) and hand them to the existing `revert_ops_in_tx` in one tx.
- Note: the op_log-domain finder surfaced the identical issue — same fix.

### 6. Bulk tag-apply: resolve tag-space once, batch block-spaces
- `src-tauri/src/commands/tags.rs:184` (loop at `:719`) · big-o · hot · effort: **medium**
- `apply_tag_to_block_in_tx` issues **two** `resolve_block_space` JOIN queries
  per block; the tag's space is loop-invariant (single tag_id) and block spaces
  can be pre-resolved via the existing `resolve_block_spaces_batch`. ~2N → ~O(1).

### 7. Attachment add (bytes path): hash the in-memory buffer, don't write-then-reread
- `src-tauri/src/commands/attachments.rs:130` (bytes path via `:309`) · do-it-once · hot · effort: **small**
- `add_attachment_with_bytes` writes bytes to disk then re-reads the entire file
  (up to 50 MB) to blake3-hash for dedup — a full redundant read on image
  paste/drop. Hash the buffer before/while writing; stored hash is identical.

### 8. Memoize `renderRichContent` in backlink list rows
- `src/components/backlinks/BacklinkGroupRenderer.tsx:105` · do-it-once · hot · effort: **small**
- The renderBlock prop calls `renderRichContent` inline with no memo, and the
  parent re-renders on every arrow-key (focusedIndex state) → full markdown
  **re-parse of every visible backlink per keystroke**. Every other call site
  already wraps this in `useMemo`; this one is the outlier.
- Fix: extract a memoized row keyed on `block.content` + resolve version; wrap
  `BacklinkGroupRenderer` in `React.memo`.

### 9. Graph worker: add an `update` message instead of respawning the simulation
- `src/hooks/useGraphSimulation.ts:499` + `src/workers/graph-worker.ts` · main-thread-offload · hot · effort: **medium**
- Every filter toggle calls `handle.cleanup()` → `worker.terminate()` then spawns
  a fresh worker and re-seeds all six d3-forces from scratch (~300-tick
  re-converge, positions re-scattered).
- Fix: add an `update` message that swaps `simulation.nodes()`/`forceLink.links()`
  in place (mirroring the existing `resize` path) and nudges alpha.

### 10. Route grouped/unlinked backlink filters through the SQL-pushdown compiler
- `src-tauri/src/backlink/grouped.rs:147` (+ `eval_unlinked_references`) · unify-hot-path · hot · effort: **large**
- The **flat** backlink path compiles filters to correlated SQL via
  `compile_backlink_filter`; the **grouped/unlinked** paths still call
  `resolve_filter_with_candidates` into a Rust `FxHashSet` and, for negative/broad
  leaves (`Not`, `Or`, `BlockType`, `PropertyIsEmpty`), materialize the whole-vault
  complement then re-embed via `json_each`.
- Fix: reuse `compile_backlink_filter` in the grouped SQL. Unifies the two engines
  (they can no longer diverge) and removes the last whole-vault Rust
  materialization on the backlink read path. Subsumes several smaller grouped
  findings (`Or`/`Not` round-trip, PropertyIsEmpty/BlockType full scan).

---

## Tier 2 — Medium, verified

### Backend
- **Drop `RebuildPageIds` from the MoveBlock arm** — `materializer/dispatch.rs:820`. In-tx `rederive_page_and_space_ids` already corrects the moved subtree's page_id before commit; the whole-vault rebuild is redundant for *every* move. Safe. small.
- **Drop `RebuildTagInheritanceCache` from the CreateBlock arm** — `materializer/dispatch.rs:619`. In-tx `inherit_parent_tags` populates the new (childless) block's inheritance; whole-vault rebuild is redundant. Big for bulk import/paste. Safe. small.
- **Same-parent reorder early-out** — `commands/blocks/move_ops.rs:258`. Skip the affected-pages CTE + `recompute_pages_cache_counts_for_pages` when parent is unchanged (counts can't change). Hottest move gesture (drag-reorder). small.
- **Collapse batch-delete saturation walk** — `commands/blocks/crud.rs:719`. One `MAX(depth)` over a multi-root CTE instead of a recursive walk per root (the purge path at `:1805` already does this). small.
- **Edit-apply content-only reader** — `loro/engine/apply.rs:182`. `apply_edit_via_diff_splice` calls `read_block` (extra parent `get_meta` + O(K) sibling-rank scan) just to read `.content`; add a content-only reader. Hot keystroke path. small.
- **zstd-compress the per-session sync wire payload** — `sync_daemon/wire.rs:86`. Snapshot path already compresses; per-session Loro deltas/snapshots go raw. medium.
- **`spawn_blocking` snapshot encode/decode** — `snapshot/create.rs:276`, `snapshot/restore.rs:152`. CBOR+zstd runs inline on the async runtime (compaction/catch-up). medium.
- **`bytes_total` pre-tally as one `IN` query** — `sync_files.rs:930`. N+1 `get_attachment_receive_meta` per attachment before a progress-enabled transfer. small.
- **`fetch_link_metadata` single-flight** — `commands/link_metadata.rs:20`. No in-flight coalescing → M concurrent identical cold URLs each do an independent HTTP fetch + upsert on page render. medium.
- **Import: defer dense-position reprojection to end-of-chunk** — `materializer/handlers/loro_apply.rs:110`. Per-block `reproject_dense_positions` over the whole sibling group = **O(N²)** for an N-sibling import; one reproject per parent per chunk yields identical final ranks (already flagged #400). import.
- **Import: recompute page counts once, not per block** — `materializer/handlers/pages_cache.rs:60`. Per-CreateBlock full descendant `COUNT(*)` = **O(N²)** per imported page; run once at import end. import.
- **Import: batch wiki-link resolution** — `commands/pages/markdown.rs:1349`. One `SELECT … LIMIT 2` per distinct `[[name]]` (N+1); snapshot in-space page titles in one query, exactly as the adjacent tag pre-pass (#1990) already does. import.

### Frontend
- **Stabilize the structural blocks-array identity on content edits** — `src/stores/page-blocks.ts:812`. `edit()` rebuilds `state.blocks` every keystroke, invalidating O(n) structural memos (`hasChildrenSet`, `visibleBlocks`, `visibleIds`, zoom) that depend only on structure. Split content into a `contentById` map or mutate in place. Correctness care needed (audit all array consumers). Hot keystroke. medium.
- **`buildIndexById` once per structural mover** — `src/stores/page-blocks.ts:1137`. indent/dedent/move each run several independent O(n) `getDragDescendants`/`siblingSlot` scans; the index helper already exists (#2041). medium.
- **Split `getProjection` for drag-move** — `src/lib/tree-utils.ts:300` (via `useBlockDnD.ts`). `offsetLeft` is a memo dep, so every horizontal pointer move re-clones the whole visible array + splice + reverse-scan; only the depth/parent tail depends on `offsetLeft`. Hot during drag. medium.
- **Module-level LRU parse cache** — `src/components/RichContentRenderer.tsx:43`. `parse()` has no cache; identical block content rendered across panels (and any un-memoized caller) re-parses. Key on the markdown string (input-only). medium.
- **`React.memo` `CollapsibleGroupList` + memoize display-name split** — `src/components/common/CollapsibleGroupList.tsx:118`. Re-splits every group title on every focus/keyboard re-render. medium.
- **Memoize `DuePanel` projected rows** — `src/components/agenda/DuePanel.tsx:537`. Inline `renderRichContent` per projected entry, re-parsed on focus nav. medium.
- **Graph worker tick: transferable `Float32Array`** — `src/workers/graph-worker.ts:84`. Posts a full `{id,x,y}[]` structured-clone every ~300 ticks; pack into a preallocated transferable / frame-throttle. medium.
- **Truncate content at the DB on the palette partitioned search** — `src-tauri/src/fts/search/partitioned.rs:149`. Both partitions pass `snippet_len=None`, shipping full bodies for up to 200 rows per keystroke; add a `substr` cap (the preview only needs a prefix; the highlight comes from `snippet()`). medium.

---

## Tier 3 — Low but real (cheap, safe quick wins)
- Skip grouped-backlink `filtered_count` when no filter (`backlink/grouped.rs:198`); first-page-only guard on backlink counts (`backlink/query.rs:97`) — both index-backed, so modest.
- Batch-delete: carry `block_type` in the `live_roots` SELECT (`crud.rs:566`) to drop the per-root lookup; hoist the `property_definitions`/space lookups out of the move-to-space loop (`crud.rs:886`). Rare batch actions, indexed lookups.
- Per-space frontier dirty-tracking so the 5-min snapshot tick re-encodes only changed spaces (`loro/registry.rs:309`) — helps idle CPU.
- Skip LRU `touch` when the resolve cache is under capacity (`src/stores/resolve.ts:317`).
- Single-pass `applyTextMarks` (7 scans → 1) (`src/components/RichContentRenderer/marks/text.tsx:62`).
- Skip the provably-identity canonical round-trip on the search query (`src/components/SearchPanel/searchFilterParams.ts:62`).
- Cost-order advanced-query AND children by `cost_hint` like the Pages path (`src/filters/expr.rs:161`).
- Materialize the page-subtree once in `restore_page_to_op` (`commands/history.rs:666`); add a `(block_id, key)` op_log index for property-reverse lookups (`reverse/property_ops.rs:115`).

---

## Latent correctness issue surfaced during verification (not perf)
Moving a repeating block into (or out of) a template page does **not** enqueue
`RebuildProjectedAgendaCache` (the MoveBlock arm omits it). Today the agenda read
path's `template` NOT EXISTS subquery masks this. This is why the "delete the
template subquery" finding was rejected as unsafe — the subquery is load-bearing
precisely because the MoveBlock arm is incomplete. Worth a correctness issue;
fixing the dispatch gap would then also unlock the read-path simplification.

---

## Rejected findings (verified FALSE / already-done / unsafe — do NOT pursue as written)
- **Materializer/pages-cache "correlated recompute per page"**, **`distinct_pages_for_blocks` N+1**, **FTS reindex "3 queries in a loop"** — already single batched `json_each` statements in current code (the hybrid finder misread them). FALSE.
- **Delete the agenda template subquery** (`agenda.rs:263`) — UNSAFE (see latent issue above).
- **Agenda on-the-fly reject-key allocation** (`agenda.rs:561`) — already implemented (#2040).
- **Export: reuse `load_page_subtree_inner`** — that loader caps at 10k blocks; export is deliberately uncapped, so this reintroduces a truncation bug.
- **`refresh_tag_usage_count` NOCASE prefilter** — rejected in-code as incorrect for non-ASCII case folding; scan is bounded by tag-vocabulary anyway.
- **Derive `block_tag_refs` from `block_links`** — different syntaxes (`#[ULID]` vs `[[ULID]]`/`((ULID))`); unsound.
- **Single FTS scan for the palette** — ranking regression (drops pages that rank below the block window; the two-scan design exists for this).
- **Switch SearchPanel to `searchBlocksPartitioned`** — regresses cursor pagination.
- **`resolve_expr` And/Or "N serial round-trips"** — already `try_join_all` + shallow-tree pushdown.
- **Boot "4 op_log aggregate scans" / `collect_frontier` "re-sorts the log"** — overcounted; already index-served (one FALSE).
- **Loro move same-parent double reproject** — already fixed (#400).
- **MCP search snippet truncation** — already DB-side `substr`.
- **Per-keystroke whole-doc serialize** (`use-roving-editor.ts`) — already RAF-coalesced and per-block.
- **Per-op `serde_json::from_str` in the materializer loop** — inherent to per-op dispatch; no asymptotic win.
