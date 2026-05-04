# PEND-20 — SQL / perf review findings (post-validation)

## Origin

Two-pass review run 2026-05-04: 6 parallel discovery subagents over the
whole codebase (commands, materializer, sync, migrations, FTS / backlink /
tag, frontend), then 3 parallel validation subagents that re-read the
cited code and migrations to weed out hallucinations and exaggerations.

The validation pass invalidated **10** of the original BLOCKER/HIGH
findings (mostly because PRIMARY KEYs already index their leading columns,
which the discovery agents missed) and downgraded another **9** as
overstated. What's below is the post-validation set.

> **Excluded by user direction:** the sync-merge `json_extract` rewrite
> in `sync_protocol/operations.rs` (originally M1) is **not** in this
> file. The merge layer is being replaced wholesale by CRDT (PEND-09);
> spending engineering on it now is wasted work. Anything else that
> touches `sync_protocol/operations.rs::merge_diverged_blocks` falls
> under the same exclusion — leave it alone, PEND-09 will delete it.

## TL;DR

| Bundle | Cost | Risk | Impact | Status |
| --- | --- | --- | --- | --- |
| **A — Index hygiene migration** (drop 4 redundant indexes + add 1 covering index) | trivial-S (~1 h) | low | medium-high | ready |
| **B — Retire `json_extract` on op-log local hot paths** (`crud.rs`, `pagination/history.rs`) | trivial (~30 min) | low | medium | ready |
| **C — Materializer `PurgeBlock` CTE materialization** | S (2-3 h) | low | low-medium | ready |
| **D — `rebuild_fts_index_impl` chunking** | S (1-2 h) | low | low | ready |
| **E — `update_fts_for_block` map reuse** | S (1-2 h) | low | low-medium | ready |
| **F — `list_page_links_inner` shared space-CTE** | S (~30 min) | low | low | ready |
| **G — `usePageBlockStore` normalised `blocksById`** (frontend) | S-M (3-5 h) | medium | medium | ready |
| **H — `add_attachment` async stat** | trivial (~15 min) | low | low | ready |
| LOW findings (L1-L10) | — | — | — | tracked, mostly **accept** (rationale per item) |

A + B together is essentially "one migration + ~10 lines of Rust" and
captures ~80 % of the realisable win. Everything else is incremental.

---

## High-priority bundle

### A — Index hygiene migration

One migration, no Rust changes. Drops 4 verified-redundant indexes and
adds one covering index that benefits every space-filtered list query.

**Drops (write-amplification + storage waste, zero query benefit):**

1. `idx_block_props_key_num` from `migrations/0004_backlink_query_indexes.sql:6` —
   literally identical to `idx_block_properties_key_value_num` from
   `migrations/0022_block_properties_key_value_num_index.sql:4-6`
   (same columns `(key, value_num)`, same partial predicate
   `WHERE value_num IS NOT NULL`). Keep the newer, better-named one.
2. `idx_blocks_parent` from `migrations/0001_initial.sql:115` —
   strict prefix of `idx_blocks_parent_covering`
   (`migrations/0024_normalize_position_covering_index.sql:11`). Any
   query that uses the old one can use the covering one. `blocks` is
   the most-written table in the system, so the duplicate write is
   real.
3. `idx_page_aliases_page` from `migrations/0015_page_aliases.sql:11-12` —
   redundant with `PRIMARY KEY (page_id, alias)` which already indexes
   `page_id` as the leading column.
4. `idx_agenda_date` from `migrations/0001_initial.sql:121` —
   redundant with `PRIMARY KEY (date, block_id)` which already indexes
   `date` as the leading column.

**Adds (covering index for the space filter):**

The space-filter subquery appears in **~16 paginated list queries**
(`pagination/{hierarchy,agenda,links,properties,trash,undated,tags,history}.rs`,
`backlink/{query,grouped}.rs`, `fts/search.rs`,
`commands/{agenda,blocks/queries}.rs`, `tag_query/query.rs`):

```sql
COALESCE(b.page_id, b.id) IN (
  SELECT bp.block_id FROM block_properties bp
  WHERE bp.key = 'space' AND bp.value_ref = ?N
)
```

Today's index `idx_block_properties_space ON block_properties(value_ref)
WHERE key = 'space'` (migration 0035) does **not** include `block_id` in
its leaves, so SQLite must do a row lookup per match. Adding
`block_id` as a trailing column makes it a covering index and the
subquery becomes index-only.

```sql
CREATE INDEX idx_block_properties_space_covering
  ON block_properties(value_ref, block_id)
  WHERE key = 'space';
DROP INDEX idx_block_properties_space;
```

**Plan:**

1. New migration `00xx_index_hygiene.sql` doing all five operations
   atomically.
2. Run `cargo sqlx prepare` and commit the regenerated `.sqlx/` cache
   (none of the stored queries change shape, but the planner choices
   may have, so the cache should be regenerated to be safe).
3. **Verification:** for at least one query in each of
   `pagination/hierarchy.rs` and `commands/agenda.rs`, run
   `EXPLAIN QUERY PLAN` against a populated dev DB before and after,
   and paste both into the commit body. We want to see the
   sub-query line change from `SEARCH bp USING INDEX
   idx_block_properties_space (value_ref=?)` (with an implicit row
   fetch) to `SEARCH bp USING COVERING INDEX
   idx_block_properties_space_covering (value_ref=?)` afterwards.
4. **Important: this needs PEND-12 awareness.** PEND-12 is about
   codegenning the space-filter SQL fragment. The covering index
   added here is purely a schema change and doesn't conflict — but
   if PEND-12 ships first, the `EXPLAIN QUERY PLAN` verification
   above should be done against the post-PEND-12 generated SQL.
   Document that link.

**Cost:** trivial-S (~1 h including the EXPLAIN diff).
**Risk:** low. SQLite never breaks on extra/dropped indexes; the
covering index is strictly additive.
**Impact:** medium-high. Touches every paginated list query the user
sees, plus removes 4 sources of per-write index maintenance.

### B — Retire `json_extract` on op-log local hot paths

Migration `0030_op_log_block_id_column.sql` added a native `block_id`
column to `op_log` plus an `idx_op_log_block_id` index, with the
explicit goal of retiring `json_extract(payload, '$.block_id')` lookups.
Two local-only call sites still use the old form; rewrite them.

#### B.1 — `commands/blocks/crud.rs:63-69` (`find_prev_edit_in_tx`)

Called on **every** `edit_block` and on every draft flush. Today:

```sql
SELECT device_id, seq FROM op_log
WHERE json_extract(payload, '$.block_id') = ?
  AND op_type IN ('edit_block', 'create_block')
ORDER BY created_at DESC LIMIT 1
```

Rewrite to:

```sql
SELECT device_id, seq FROM op_log
WHERE block_id = ?
  AND op_type IN ('edit_block', 'create_block')
ORDER BY seq DESC, device_id DESC LIMIT 1
```

Two changes: `block_id = ?` (uses `idx_op_log_block_id`) and the order
flips from `created_at DESC` to `(seq DESC, device_id DESC)` which is
the op-log's natural primary-key order and avoids needing
`idx_op_log_created` for this single-row lookup. Functionally
equivalent — within a single device the most-recent edit is the
highest seq; across devices the comparator is well-defined.

#### B.2 — `pagination/history.rs:50-53` (`list_block_history`)

Today:

```sql
WHERE payload LIKE '%"block_id":"' || ?1 || '"%'
  AND json_extract(payload, '$.block_id') = ?1
```

The `LIKE` is unindexed (full table scan); the `json_extract` predicate
is the only one with index support today. After the rewrite both clauses
collapse to:

```sql
WHERE block_id = ?1
```

**Plan for B.1 + B.2:**

1. Make the two changes.
2. Re-run `cargo sqlx prepare` and commit the `.sqlx/` cache.
3. The existing `block_history_*` integration tests cover both call
   sites; run them. Add one new test that exercises the path on a
   block with ≥2 edit ops to confirm the ordering rewrite in B.1.

**Cost:** trivial (~30 min). **Risk:** low. **Impact:** medium for
B.1 (per-edit hot path), low for B.2 (history view, user-driven).

### C — Materializer `PurgeBlock` runs the recursive descendants CTE 15 times

`src-tauri/src/materializer/handlers.rs:285-408`. Fifteen consecutive
`concat!(crate::descendants_cte_purge!(), "DELETE FROM …")` statements
inside one `BEGIN IMMEDIATE`, each re-evaluating the recursive CTE
end-to-end against the same subtree.

Originally flagged BLOCKER, downgraded to MEDIUM by the validator
because `PurgeBlock` is rare. Still worth fixing because every
re-walk extends the writer-lock window.

**Plan:**

1. At the top of the `PurgeBlock` arm, materialise the descendant set
   into a temp table:

   ```sql
   CREATE TEMP TABLE _purge_descendants AS
   WITH RECURSIVE
     descendants(id, depth) AS (
       SELECT ?1, 0
       UNION ALL
       SELECT b.id, d.depth + 1 FROM blocks b
       JOIN descendants d ON b.parent_id = d.id
       WHERE d.depth < 100
     )
   SELECT id FROM descendants;
   ```

2. Each of the 15 `DELETE` statements becomes
   `DELETE FROM <table> WHERE block_id IN (SELECT id FROM
   _purge_descendants)` (or the analogous shape for tables that key
   off `tag_id` / `target_id` / etc).
3. Drop the temp table at the end (or rely on connection scope —
   SQLx pools connections so explicit `DROP TABLE` is safer).

**Verify:** existing materializer purge tests stay green; add one
test on a 1k-descendant subtree to confirm the lock-hold time drops.

**Cost:** S (2-3 h). **Risk:** low (the descendant set semantics are
unchanged; only the materialisation point moves). **Impact:** low for
small purges, medium for purges of large pages.

---

## Medium-priority bundle

### D — `rebuild_fts_index_impl` holds one transaction for the whole rebuild

`src-tauri/src/fts/index.rs:297-330`. `DELETE FROM fts_blocks` then
`SELECT id, content FROM blocks WHERE …` then per-row
`INSERT INTO fts_blocks(…)`, all inside one `BEGIN…COMMIT`.

Validator argued this is cold-path (boot if FTS empty, post-snapshot
restore). Still worth chunking because (a) the chunked alternative
already exists (`reindex_fts_references`, `FTS_REINDEX_CHUNK = 1000`)
so the change is essentially "use it"; (b) on a 100k-block vault the
single-transaction path holds the writer lock for several seconds,
which is bad for boot UX and worse on Android.

**Plan:**

1. Replace the single-transaction loop with `FTS_REINDEX_CHUNK`-sized
   batches, each with its own `BEGIN…COMMIT`.
2. Use the existing `strip_for_fts_with_maps` (load the maps once
   before the chunk loop, exactly as `reindex_fts_references` does).
3. The function's return value (`u64` row count) stays accurate by
   accumulation across chunks.

**Cost:** S (1-2 h). **Risk:** low. **Impact:** noticeable on
first-boot of a large vault and on Android.

### E — `update_fts_for_block` does 2 queries per block

`src-tauri/src/fts/strip.rs:75-105`. The single-block FTS update path
calls `strip_for_fts`, which issues one query for tag titles and one
for page titles. The batched variant `strip_for_fts_with_maps` (used
by D, full rebuild, and `reindex_fts_references`) takes pre-loaded
maps as input and avoids both queries.

`update_fts_for_block` runs as part of every materializer batch that
edits content. Today each block in the batch makes 2 round-trips.

**Plan:**

1. Move the map load (`load_ref_maps`) out of `strip_for_fts` and
   into the materializer batch loop, once per batch.
2. Pass the maps into `update_fts_for_block`, which calls
   `strip_for_fts_with_maps`.
3. Document on the API: "single-block update path expects pre-loaded
   maps; one-off callers can use the convenience wrapper that loads
   maps internally". Keep the wrapper for tests/uncommon callers.

**Cost:** S (1-2 h). **Risk:** low (no semantic change; just call-site
restructuring). **Impact:** low-medium — not visible per-edit but adds
up over a sync ingress of thousands of ops.

### F — `list_page_links_inner` duplicates the space-filter subquery

`src-tauri/src/commands/pages.rs:566-573`. Two structurally identical
subqueries against `block_properties` for source and target. SQLite
will not CSE them across the boolean.

**Plan:** rewrite using a CTE:

```sql
WITH space_members AS (
  SELECT block_id FROM block_properties
  WHERE key = 'space' AND value_ref = ?1
)
… AND (?1 IS NULL OR (
  COALESCE(sb.parent_id, bl.source_id) IN (SELECT block_id FROM space_members)
  AND bl.target_id IN (SELECT block_id FROM space_members)
))
```

After bundle A lands the underlying lookup is index-only via the
covering index, so the gain here is "subquery materialised once
instead of twice", not a planner-level win.

**Cost:** S (~30 min). **Risk:** low. **Impact:** low (graph view
rebuild, not per-page-load).

### G — `usePageBlockStore` lacks a normalised `blocksById`

`src/components/EditableBlock.tsx:116-120`:

```typescript
const prioritySelector = useCallback(
  (s: PageBlockState) => s.blocks.find((b) => b.id === blockId)?.priority ?? null,
  [blockId],
)
const currentPriority = usePageBlockStore(prioritySelector)
```

Every block in the page subscribes to the same store; on any change
the selector runs `O(N)` to find that one block. With N rendered
blocks each doing this, you get `O(N²)` selector-execution per store
mutation. Zustand re-renders only on value-change, but the selector
itself runs unconditionally — so a 500-block page recomputes 500×500
finds on every keystroke that touches the store.

This pattern is repeated for at least: priority, todo state,
scheduled date, due date, content, parent_id, position. The fix is
one-shot and benefits all of them.

**Plan:**

1. Add `blocksById: Map<string, FlatBlock>` to `PageBlockState`,
   maintained in lock-step with `blocks: FlatBlock[]` by every
   reducer that mutates the array (`setBlocks`, `addBlocks`,
   `removeBlocks`, `applyEdit`, …).
2. Replace per-block selectors that scan `blocks` with `Map` lookups:
   `(s) => s.blocksById.get(blockId)?.priority ?? null`.
3. Don't expose `blocksById` to existing callers that need ordering
   — they keep using `blocks`. Both stay in sync.
4. Add a small store-level invariant test that every `blocks` entry
   has a `blocksById` entry and vice versa, and that they reference
   the same object identity.

**Cost:** S-M (3-5 h, mostly call-site sweep). **Risk:** medium —
every reducer that mutates the array must update both halves; one
miss and you get stale or missing per-block data. The invariant test
catches it but you need to be thorough.
**Impact:** medium on small pages, large on big pages. Removes the
single biggest selector-execution-time line item in React Profiler
on the page view.

### H — `add_attachment_inner` does a synchronous `std::fs::metadata` inside `BEGIN IMMEDIATE`

`src-tauri/src/commands/attachments.rs:114-129`. The stat call is
fast on local disk but holds the writer lock pointlessly. Use
`tokio::fs::metadata` instead. The TOCTOU window between stat and
insert is irrelevant — sync GC reconciles missing attachments
anyway and the threat model already accepts this kind of race
(AGENTS.md §Threat Model).

**Cost:** trivial (~15 min). **Risk:** low. **Impact:** low (only
matters on slow / contended storage e.g. Android eMMC, USB-mounted
vaults).

---

## LOW findings — tracked, mostly **accept**

User asked specifically for the LOW findings to be tracked. Most are
genuinely "accept-as-is" because the validator demonstrated either
that the perceived cost is unobservable, or that the current shape
is required by an adjacent constraint. Each is logged here so future
sessions don't re-flag them and so we have a record of the decision.

| ID | Where | Recommended action |
| --- | --- | --- |
| **L1** | `commands/blocks/crud.rs:1156-1281` — `purge_all_deleted_inner` repeats `(SELECT id FROM blocks WHERE deleted_at IS NOT NULL)` 13×. | **Accept.** Bulk admin op, indexed subquery, folding into a CTE is cosmetic. If touched anyway, fold into a temp table like bundle C. |
| **L2** | `backlink/query.rs:266-275` — `resolve_root_pages` builds dynamic `IN (?,?,…)` with no `json_each` fallback. | **Accept.** Callers cap inputs at `SMALL_IN_LIMIT = 500` (`backlink/mod.rs:27`), well under SQLite's 999-param ceiling. If we ever grow the cap, mirror the `SMALL_IN_LIMIT` fallback used by `fetch_block_rows_by_ids` (lines 315-342). |
| **L3** | `tag_inheritance/rebuild.rs:20-37` — `rebuild_all` runs the full recursive CTE in one transaction. | **Accept.** Documented design: only fires at startup or after snapshot restore; the atomic single-statement shape is *better* than per-row materialisation. Comments at lines 55-67 (variant `rebuild_all_split`) already explain this. |
| **L4** | `commands/properties.rs:809-812` — `delete_property_def` uses `COUNT(*)` instead of `EXISTS`. | **Accept.** The error message reports the count to the user; `COUNT` is needed for that. Indexed via `(key, …)` so cost is minimal. |
| **L5** | `commands/pages.rs:57-62` — `set_page_aliases_inner` uses `SELECT COUNT(*) > 0`. | **Accept.** WHERE is `id = ?` — at most 1 row scanned regardless. Cosmetic style preference only. |
| **L6** | `commands/blocks/crud.rs:67` — `find_prev_edit_in_tx` orders by `created_at DESC`. | **Closed by B.1.** The rewrite to `(seq DESC, device_id DESC)` lands here for free. |
| **L7** | `src/stores/resolve.ts:68-73` — `evictOldest` uses `Array.from(cache.keys()).slice(...)`. | **Accept.** Original "BLOCKER" rating was wrong: the early-return guard means O(N) work only fires when cache > `MAX_CACHE_SIZE = 10000`, which is rare. In-place iteration would be fractionally faster but requires a manual loop break — cost not worth the readability hit. |
| **L8** | `src/components/BlockListRenderer.tsx:177` — `selectedBlockIds.includes(...)` per row. | **Accept for now**, revisit when bundle G lands. At realistic sizes (≤ a few hundred selected) the cost is microseconds. The natural fix lives in the same store-normalisation work as G — when we add `blocksById`, also normalise selection to a `Set<string>` and the `.includes` becomes `.has`. |
| **L9** | `src/editor/markdown-serialize.ts:269-281` — `result += …` in a loop. | **Accept.** V8's cons-string optimisation makes the textbook O(N²) concern unobservable on real block sizes. Re-flag only if the React Profiler shows the serializer near the top. |
| **L10** | `src/lib/logger.ts:100-126` — `rateLimitMap` only sweeps when size > 1000. | **Accept.** Distinct `(module, message)` pairs in this app are in the tens. The "memory leak in long-running sessions" framing was overstated. |

If any of L7-L10 surface in a production trace later, log them under
REVIEW-LATER with the trace evidence; we'll re-evaluate at that
point.

## Findings the validation pass refuted (not in this plan)

For the record, so we don't re-discover them: the validation pass
established that the following originally-flagged items are **wrong**.
Don't act on them.

* FTS multi-tag `COUNT(DISTINCT bt.tag_id)` "has no index" — the PK
  `block_tags(block_id, tag_id)` covers the lookup.
* `delete_property_def` orphan-warning JOIN "has no index on
  `block_properties.block_id`" — PK `block_properties(block_id, key)`
  covers it; migration 0004 adds a redundant `(key, block_id)` too.
* Backlink `PropertyIsEmpty` filter "ignores the candidate set" —
  `backlink/filters.rs:251-287` does push candidates into SQL via
  `json_each`.
* Agenda template-filter `NOT EXISTS` on `(block_id, key)` "is
  unindexed" — same PK as above covers it.
* Compaction `SELECT COUNT(*) FROM op_log WHERE created_at < ?` "does
  a full scan" — `idx_op_log_created` from migration 0001 covers it.
* `BlockListRenderer` `siblingAriaProps` `useMemo` "is ineffective" —
  recomputing when `visibleItems` changes is the **correct**
  behaviour, not a bug.
* `set_property_in_tx` "does N+1 prop-def lookups" — it does 1 + 1
  per call. N callers issuing N calls is N, not N+1.
* `get_settings_batch` "is probably not batched" — it is, single
  `SELECT … WHERE key IN (?,?,?)`.
* `undo_page_op_inner` recursive CTE "missing `is_conflict = 0` and
  `depth < 100`" — both are present (`history.rs:481-485`).
* Resolve store `preload` "accumulates pages before insert" — that's
  the correct cursor-pagination shape.
* Markdown serializer "per-character `out += …` is O(N²)" — V8
  cons-strings flatten it; not observable.

## Sequencing notes

* **A is independent** of everything else and is the highest
  ROI-per-hour change in the file. Do it first or alongside
  whatever else.
* **B depends on nothing** but should land near A so the
  EXPLAIN-after evidence in A's commit message reflects post-B
  shapes too (the affected queries don't overlap, but the op-log
  table will look more consistent).
* **C, D, E, F, H** are independent and can be picked off in any
  order or skipped entirely.
* **G** is the biggest single piece in the file but is also the
  one you only do if React Profiler shows the per-block selectors
  hot. If the profiler is fine, defer it. It is a precondition for
  acting on L8 cleanly, so they are bundled if you do touch it.
* **None of the bundles** (A-H) conflict with PEND-09 (CRDT
  migration) or PEND-10 (iroh transport). They all touch local
  query / index / materializer paths that survive both
  transitions.
* **Bundle A is friendly to PEND-12** — the covering index added
  here doesn't depend on PEND-12 codegen. PEND-12 doesn't change
  the SQL semantics, just where the string lives.

## Recommended order

1. **A — Index hygiene migration** (~1 h, immediate user-visible win)
2. **B — Op-log `json_extract` rewrites** (~30 min, edit hot path)
3. **F — `list_page_links_inner` shared CTE** (~30 min, trivial diff)
4. **H — `add_attachment` async stat** (~15 min, trivial diff)
5. **D — `rebuild_fts_index_impl` chunking** (1-2 h)
6. **E — `update_fts_for_block` map reuse** (1-2 h)
7. **C — `PurgeBlock` CTE materialisation** (2-3 h)
8. **G — `usePageBlockStore` `blocksById`** — only if profiler
   shows it; otherwise leave for later.

Steps 1-4 alone: **~2-2.5 h** of work, captures most of the
realisable benefit.
