# Performance & Scalability Analysis (Agaric)

**Summary**: The Rust backend hot paths (pool config, keyset pagination, FTS search,
backlink query, tag resolution, the advanced-query engine, cache rebuilds, the
materializer consumer) are exceptionally well-optimized, with documented rationale,
covering indexes, set-based SQL, chunked transactions, memory-bounded rebuilds, and
Criterion benches at nearly every turn. Low-hanging fruit is gone. After a rigorous
sweep I found one concrete, mechanism-based backend issue (a defeated LIKE index
optimization, low-to-medium impact because the affected table is small) plus a few
already-optimal areas worth recording. Frontend findings are appended from the FE
sweep below.

**Count by severity (backend)**: CRITICAL 0 · HIGH 0 · MEDIUM 1 · LOW 2

---

## Backend findings

### [MEDIUM] Tag-prefix `LIKE … ESCAPE '\'` defeats the SQLite LIKE-to-range index optimization
- **Location**: `src-tauri/src/tag_query/resolve.rs:91-145` (`resolve_tag_prefix_leaves`),
  `src-tauri/src/tag_query/resolve.rs:193-225` (`prefix_leaf_subquery_body`); the same
  shape recurs in `src-tauri/src/backlink/filters.rs` (HasTagPrefix) and the
  `resolve_expr_cte` oracle (`resolve.rs:461-485`). Index defined in migrations as
  `idx_tags_cache_name_nocase ON tags_cache(name COLLATE NOCASE)`.
- **Evidence**: every prefix arm runs
  `... FROM tags_cache tc JOIN block_tags bt ... WHERE tc.name LIKE ?1 ESCAPE '\' ...`
  with the bound pattern built as `format!("{}%", escape_like(prefix))`.
- **Problem**: SQLite only converts `col LIKE 'literal%'` into an indexed range scan
  (`col >= 'literal' AND col < 'literalo'`) when **no `ESCAPE` clause is present** and the
  column collation matches the `case_sensitive_like` setting (SQLite docs, "The LIKE
  optimization"). The presence of `ESCAPE '\'` unconditionally disables that rewrite, so
  `tags_cache` is **full-scanned** once per UNION arm (2 arms non-inherited, 3 inherited),
  ignoring `idx_tags_cache_name_nocase` entirely.
- **Impact**: each tag-prefix resolution scans the whole `tags_cache` table 2-3x. The
  table is one row per tag, so for typical vaults (tens-to-hundreds of tags) the absolute
  cost is small; it scales linearly with distinct-tag count and is paid on every
  prefix-tag query / backlink HasTagPrefix filter. Not catastrophic, but it is a silent
  scan where the author clearly intended an index seek (the index exists specifically for
  name lookups).
- **Fix**: the user prefix rarely contains LIKE metacharacters. When `escape_like(prefix)
  == prefix` (no `%`/`_`/`\` in the input), emit `name LIKE 'prefix%'` **without** the
  `ESCAPE` clause so the range optimization fires; keep the `ESCAPE` form only on the rare
  metacharacter path. Alternatively use `name >= ? AND name < ?` range bounds computed in
  Rust. Either restores the index seek. Verify with `EXPLAIN QUERY PLAN` before/after.
- **Confidence**: high on the mechanism (documented SQLite behavior; the `ESCAPE` clause
  is unconditionally present). Medium on impact magnitude — bounded by `tags_cache` size,
  which is small for realistic vaults.
- **Effort**: S

### [LOW] `resolve_expr` `Not` fallback materializes the entire non-deleted block universe into Rust
- **Location**: `src-tauri/src/tag_query/resolve.rs:389-410`.
- **Evidence**: the `TagExpr::Not` arm, when the inner set is empty, runs
  `SELECT id FROM blocks WHERE deleted_at IS NULL` and collects every id; otherwise it
  ships the inner set as JSON and runs `... id NOT IN (SELECT value FROM json_each(?))`,
  again returning the full complement into a Rust `FxHashSet`.
- **Problem**: this returns O(total blocks) ids into memory for a negated tag query.
- **Impact / mitigation**: this path is the **fallback oracle only** — `eval_tag_query`
  compiles shallow trees (`depth <= MAX_PUSHDOWN_DEPTH`) to a single pushed-down SQL
  subquery via `compile_candidate_subquery` (resolve.rs:259-303), which keeps the keyset/
  LIMIT in SQL and never materializes the universe. So `resolve_expr` is hit only for
  trees too deep for the pushdown (rare) or as the differential-test oracle. Real-world
  exposure is therefore low; recording it as the only remaining "materialize-the-world"
  shape in the tag path.
- **Fix**: none required given the pushdown path. If deep negated trees ever become a real
  workload, push the `Not` into the same compiled subquery (it already exists in
  `build_subquery`'s `Not` arm) rather than falling back to Rust.
- **Confidence**: high (code is explicit). Low severity because the fast path bypasses it.
- **Effort**: M (only if ever needed)

### [LOW] Advanced-query `DateBucket{Created|LastEdited}` group key runs a correlated op_log aggregate per matched row
- **Location**: `src-tauri/src/query/engine.rs:1180-1185` (`group_key_expr`).
- **Evidence**: the group-key SQL for a Created/LastEdited date bucket is
  `strftime(fmt, (SELECT MIN/MAX(created_at) FROM op_log WHERE block_id = b.id)/1000, 'unixepoch')`,
  evaluated in GROUP BY (so once per matched candidate row).
- **Problem**: a correlated subquery per row, unlike the flat path which already hoisted
  the LastEdited subquery into a pre-aggregated `LEFT JOIN (… GROUP BY block_id)` via
  `SortJoins::last_edited` (engine.rs:111-117) precisely to avoid this.
- **Impact**: `op_log(block_id)` is indexed (`idx_op_log_block_id`), so each correlation is
  an index seek + small aggregate, not a scan — cost is O(matched rows × ops-per-block-seek),
  acceptable for typical result sets but not as cheap as the hoisted join the flat sort path
  uses. Only affects grouped queries that bucket by Created/LastEdited date.
- **Fix**: reuse the same pre-aggregated `op_log` LEFT JOIN the flat path's `SortJoins`
  already builds, so the MIN/MAX is computed once per block via the join rather than as a
  per-row correlated subquery.
- **Confidence**: medium — the per-row evaluation is real, but SQLite may hoist the
  invariant subquery; confirm with `EXPLAIN QUERY PLAN`. Low severity (indexed, grouped
  path only).
- **Effort**: M

---

## Areas reviewed and found already-optimal (no action)

- **db/pool.rs**: split read(4)/write(2) WAL pools, `query_only` reader, platform-gated
  `cache_size`/`mmap_size` (#420), `wal_autocheckpoint=5000`, `temp_store=MEMORY`,
  `PRAGMA optimize` after migrations, slow-acquire logging, bounded acquire_timeout.
  Nothing to add.
- **pagination/** (hierarchy, agenda, by_type, etc.): textbook keyset/cursor seeks on
  covering indexes (`idx_blocks_parent_covering`, `idx_blocks_type`, agenda PK
  `(date, block_id)`), `LIMIT n+1` probe, `COALESCE(position, sentinel)` NULL ordering.
  Single statement per page; no N+1.
- **fts/search/fetch.rs**: dynamic MATCH SQL with relative-epsilon rank cursor, optional
  `snippet()` omission to skip per-row tokenizer walk, server-side `substr` content
  truncation, cancellation-raced `fetch_all` that frees the pool slot on unsubscribe,
  read-pool slow-acquire logging. The one acknowledged `pages_cache` GLOB scan is
  documented as cheap (small table).
- **backlink/query.rs + sort.rs**: SQL `COUNT(*)` for totals (never materializes base
  set), keyset page query projecting full BlockRow in one statement, property sort pushed
  fully into SQL with `NULLS LAST`, dual `IN(?,…)` / `json_each` branch to dodge the bind
  ceiling, denormalized `page_id` join for root-page resolution (CTE kept only as test
  oracle).
- **tag_query/resolve.rs**: boolean trees compiled to a single pushed-down SQL subquery
  (INTERSECT/UNION/EXCEPT), concurrent leaf resolution via `try_join_all`, materialized
  `block_tag_inherited` cache instead of recursive CTE at query time.
- **query/engine.rs**: correlated sort subqueries (title, last_edited) hoisted to 1:1
  LEFT JOINs evaluated once per row; keyset cursor over the full sort tuple; COUNT and
  aggregates computed first-page-only; grouped path reuses the flat predicate/binds.
- **cache/page_id.rs, projected_agenda.rs, fts/index.rs**: set-based rebuilds, chunked
  CASE-expression UPDATEs / multi-row INSERTs bounded by `MAX_SQL_PARAMS`, split
  read/write pool pattern (read CTE on reader, chunked write under one `BEGIN IMMEDIATE`),
  memory-bounded chunk-flush (CHUNK_SIZE=10k caps peak heap ~500KB vs ~18MB),
  per-block-scoped ref maps (`load_ref_maps_for_block`, #418) instead of full-vault scan
  on every edit, `FTS_REINDEX_CHUNK` to avoid long writer holds on popular-tag renames.
- **materializer/consumer.rs + dedup.rs**: FIFO foreground apply (parallel bucketing
  removed for correctness, and WAL serializes writers anyway so no throughput lost),
  `Arc`-wrapped batch payloads to keep `task.clone()` a refcount bump, FxHash dedup with
  short-lived per-drain sets, abort-on-drop attempt wrappers.
- **migrations index coverage**: comprehensive — partial indexes on
  todo/due/scheduled/deleted, covering indexes `idx_blocks_parent_covering`,
  `idx_blocks_space_type`, `idx_block_properties_space_covering`,
  `idx_block_props_key_{text,num}`, `idx_block_links_{source,target}`,
  `idx_op_log_block_id`. No obviously-missing index found for the queries in scope (the
  one exception is the LIKE/ESCAPE defeat above, which is a query-shape issue, not a
  missing index).

## Areas NOT reviewed (coverage gaps for the validator)
- `loro/` CRDT projection/snapshot serialization cost and sync payload size were only
  skimmed (out of the assigned module list except where they intersect materializer).
- `sync_*` payload/serialization paths not deeply reviewed (largely out of scope).
- I did not run `EXPLAIN QUERY PLAN` to empirically confirm the LIKE/ESCAPE and DateBucket
  plans; both findings rest on documented SQLite optimizer behavior and code reading. A
  follow-up should confirm with EQP before/after any fix.

## Cross-dimension notes
- None significant outside performance.

---

## Frontend findings

**Cross-cutting caveat**: the React Compiler is ENABLED (`vite.config.ts:74`,
`compilationMode: 'infer'`), which auto-memoizes JSX subtrees and call expressions keyed
on stable inputs. This neutralizes or weakens several classic "unmemoized in render"
findings — confidences below are stated against a compiler-on build and several should be
profiler-confirmed before investing.

**Count by severity (frontend)**: HIGH 0 · MEDIUM 3 · LOW 2 (severity mapped from the
FE sweep's confidence/impact; none are interactive-path regressions of high certainty)

### [MEDIUM] `blockActions` context bag busted every render by two inline-arrow wrappers
- **Location**: `src/components/editor/BlockTree.tsx:900` and `:904`; memo at
  `src/editor/use-block-tree-context-bags.ts:105-124`; consumer `SortableBlock.tsx:491`
  (`React.memo` at `:784`).
- **Evidence**: `onDuplicate: (blockId) => void handleDuplicate(blockId)` and
  `onBatchDelete: () => void handleBatchDelete()` are inline arrows passed into the
  `blockActions` `useMemo` deps. The published `BlockActionsProvider value={blockActions}`
  (`BlockTree.tsx:987`) is consumed via plain `useContext`.
- **Problem**: `handleDuplicate`/`handleBatchDelete` are stable `useCallback`s, but the
  inline arrows get fresh identity every BlockTree render, so the memo recomputes → new
  context value → every mounted `SortableBlock` re-renders (context updates bypass
  `React.memo`). BlockTree re-renders on every focus/selection change and every drag
  pointer-move, undercutting the per-row memo / drag-state-store optimizations.
- **Impact**: during drag-move and rapid focus changes on large pages, all visible rows
  re-render instead of 2-3.
- **Fix**: wrap both adapters in `useCallback`, matching every other handler in the file.
- **Confidence**: medium — mechanism verified; lowered because the React Compiler likely
  caches these two arrows keyed on the stable callbacks (would make it a no-op in prod).
  Profiler-confirm.
- **Effort**: S

### [MEDIUM] Per-keystroke full-document markdown serialization on the active block
- **Location**: `src/editor/use-roving-editor.ts:558-563`.
- **Evidence**: `handleEditorUpdate` fires on every TipTap `update` (every keystroke) and
  runs `serialize(editor.getJSON(), …)` synchronously. The consumer in `EditableBlock.tsx`
  rAF-batches the state write but not the `serialize` itself.
- **Problem**: O(active-block-size) serialization per keystroke (scope is the focused
  block, not the page).
- **Impact**: keystroke latency on a single very large block (many code fences / tables /
  nested lists). Moderate; single-block scope.
- **Fix**: coalesce the `serialize` into the rAF (serialize at most once per frame), or
  skip when the doc structure/version is unchanged.
- **Confidence**: high it runs per keystroke (#536 replaced a 500ms poll); medium on
  worth — single-block scope and downstream already rAF-bounded.
- **Effort**: M

### [MEDIUM] `renderRichContent` (full re-parse, no parser cache) called unmemoized in list/render bodies
- **Location**: `src/components/agenda/DuePanel.tsx:536-542` (inside `.map`),
  `src/components/backlinks/BacklinkGroupRenderer.tsx:104-112` (per row, NOT virtualized —
  `CollapsibleGroupList`, bounded by pagination limit),
  `src/components/HistoryListItem/BlockHistoryItem.tsx:~310`,
  `src/components/pages/PageTitleEditor.tsx:106`. The established codebase pattern wraps
  these in `useMemo` (BlockListItem.tsx:388, StaticBlock.tsx:102, TrashRowItem.tsx:82,
  ResultCard.tsx:53, DiffDisplay.tsx:95, HistoryItemCore.tsx:129).
- **Evidence**: `markdown-parse/parser.ts` `parse()` has no internal cache (verified), so
  each unmemoized call re-parses on every parent render.
- **Problem/Impact**: markdown re-parse on unrelated parent re-renders (focus/scroll/diff
  toggle). Backlinks is the largest (un-virtualized, up to pagination limit).
- **Fix**: wrap each in `useMemo` keyed on `[content, …stable callbacks]`; for backlinks,
  extract a memoized row component.
- **Confidence**: medium — calls and no-cache parser verified, but the React Compiler
  likely caches these call expressions keyed on stable inputs, so real savings may be
  near-zero. Profiler-confirm; these are mainly convention inconsistencies.
- **Effort**: S each

### [LOW] Graph worker re-spawned on every filter toggle (documented future-tier gap)
- **Location**: `src/hooks/useGraphSimulation.ts:491-499`; worker `src/workers/graph-worker.ts`.
- **Evidence**: in-code comment notes the worker is re-spawned on each filter change because
  the protocol exposes no "update data" message; the patch effect calls
  `state.handle.cleanup()` then `runWorker(ctx)` on each `[nodes, edges]` change.
- **Problem**: each filter toggle tears down + re-creates the worker + d3 simulation (SVG /
  zoom preserved, so no flicker, but full re-simulate occurs).
- **Impact**: filter-toggle latency on large graphs; bounded (off main thread).
- **Fix**: add an `update`/`patch` worker message that re-binds nodes/edges and nudges
  alpha (mirror the existing in-place `resize` handler at `graph-worker.ts:95-110`).
- **Confidence**: high (explicitly documented and verified) — a known accepted future-tier
  item, not an oversight.
- **Effort**: M

### [LOW] Attachment export N+1 IPC (2N sequential invokes)
- **Location**: `src/lib/export-graph.ts:165-179`; no batch wrapper in `tauri.ts:2118-2129`.
- **Evidence**: `for (const id of ids) { … await readAttachmentMeta(id); await readAttachment(id) }`
  — two sequential IPCs per inline attachment.
- **Problem**: a page with 20 images = 40 sequential round-trips.
- **Impact**: slow page/graph export with many embedded attachments; export-time only (off
  the interactive render path).
- **Fix**: add backend `read_batch_attachments` / `read_batch_attachment_metas`; fetch in
  1-2 IPCs.
- **Confidence**: high (verified await-in-loop, no batch variant).
- **Effort**: M (Rust + TS).

### Frontend areas reviewed and found already-optimal
- **Block-tree rendering**: per-row `React.memo` + drag-state external store (#1267) +
  per-id viewport `useSyncExternalStore` (#1067) + memoized context bags. Only chink is the
  inline-arrow finding above.
- **Virtualization**: agenda (tanstack `useVirtualizer`), search results
  (`VirtualizedResultListbox`), block tree (viewport-lite placeholders). Only bounded
  (pagination-capped) lists are un-virtualized (backlinks, DuePanel projected).
- **Zustand selectors**: `useShallow` used consistently (~60 sites); no naked inline-object
  selectors; `.getState()` for action access.
- **vite.config.ts**: deliberate, documented manual chunking (editor / highlight / dnd /
  datepicker / ui-radix / react-vendor / d3); React Compiler on; oxc minify; bundle
  visualizer wired. No gaps.
- **Repeated IPC**: `BatchPropertiesProvider`, `BatchAttachmentsProvider`,
  `firstChildForBlocks`, `batchResolve`, `setTodoStateBatch`, `deleteBlocksByIds` all batch
  on hot paths. Only export-time N+1 remains (finding above).
- **markdown-parse / workers**: d3 simulation in a worker with rAF-coalesced tick
  application. Markdown parsing runs on the main thread with no cache (findings above);
  not currently worker-offloaded.

### Frontend coverage gaps for the validator
- React Compiler interaction was reasoned about, not empirically confirmed via compiled
  output or a runtime profiler — findings 1 and 3 (FE) should be profiler-verified before
  any change, as the compiler may already neutralize them.
