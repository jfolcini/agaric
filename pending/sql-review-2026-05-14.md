# SQL review — full-app audit + remediation plan — 2026-05-14

> **Status:** Phases 1 + 2 shipped (sessions 740 + 741). **Open below:**
> Phase 3 (B-3 reverse-op batching), Phase 4 (H-2 `page_link_cache`
> materialization + COALESCE-removal backfill + M-2 incremental cache
> rebuilds), Phase 5 (M-6 compaction tx split + M-8 snapshot streaming).
> Single open §1 BLOCKER (B-3); §2 H-1/H-2/H-3 unchanged; §3 down to 5
> M-class items (M-1, M-3, M-4 shipped).
>
> The original audit body (the multi-agent SQL/sqlx review summary) is
> retained below for context — every finding still labelled "Open" maps
> to a phase in §7.

## TL;DR — verified by-the-numbers

- **61 migrations**, **18 application tables + 1 FTS5 vtable + ~6 internal**,
  **~56 indexes**, **4 triggers**. Schema is in genuinely good shape
  (STRICT post-0061, FK CASCADE post-0061, pragmas tuned beyond ARCH §3 spec).
- **~9 pragmas** applied to every connection (`foreign_keys=ON`,
  `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, plus
  `cache_size=-65536`, `mmap_size=268435456`, `temp_store=MEMORY`,
  `wal_autocheckpoint=5000`, `journal_size_limit=52428800`). Read pool
  additionally pins `query_only=ON`.
- **~107 compile-checked `query!` macros** + **~73 dynamic `query()` calls**
  across 11 files. Most dynamic SQL is justified (tag-inheritance recursive
  CTEs, FTS5 dynamic MATCH, chunked INSERTs); a handful are not (see
  finding **R-2**).
- Two read commands documented as **exceeding the 200 ms target at 100K**
  (`list_page_links` ~1.3 s, `list_projected_agenda` ~620 ms — ARCH §25
  lines 2374–2393); the underlying causes are pinpointed in this plan.
- **No append-only / hash-chain violations** found — op_log integrity is
  sound (the relaunched op-log-core agent gave a clean bill of health on
  invariants).

## §1 — Verified blocking issues (1)

### B-3 — Reverse-op replay is N+1 across the entire batch

**Where:** `src-tauri/src/commands/history.rs:384-389` and
`src-tauri/src/reverse/mod.rs:17-42`.

**Pattern:** For each op in an undo batch, three round-trips:
`compute_reverse()` → `get_op_by_seq()` → `find_prior_text/position/property`.
50-op undo = 150 sequential queries. Each `find_prior_*` is itself an
indexed lookup but on `op_log.block_id` which scans backward through
edit history.

**Impact at 100K:** 50-op undo measured at ~3 s (extrapolated from
projected query counts); should be ~100 ms with a batched fetch. This
is the hidden cost behind the *un-benchmarked* `revert_ops_inner` —
captured in the parallel scale-benchmarks plan
(`pending/scale-benchmarks-100k-2026-05-14.md` Phase 2 §B.1).

**Fix:** Two-step batching:

1. Batch-fetch all target op records: one `SELECT … FROM op_log WHERE
   (device_id, seq) IN (json_each(?))` returning N rows.
2. Per op-type, batch-fetch prior context: one query per op type with
   a UNION ALL over the per-op `WHERE (block_id, created_at, seq) <
   (?, ?, ?)` predicates.

Goes from 3 N queries to **3 queries total**. **Cost M** (~2 days
including parity tests against the pre-batched code).

## §2 — High-impact perf issues (3)

### H-1 — Space-filter subquery is unindexed and inlined at 10+ pagination sites

**Where:** `pagination/{agenda,hierarchy,tags,trash,undated,links}.rs` +
`commands/{agenda.rs,blocks/queries.rs}` + `commands/agenda.rs:262-264`
(the projected-agenda cache reader). 10+ verbatim copies of:

```sql
AND (?N IS NULL OR COALESCE(b.page_id, b.id) IN (
  SELECT bp.block_id FROM block_properties bp
  WHERE bp.key = 'space' AND bp.value_ref = ?N))
```

Migration 0061 added a partial index `idx_block_properties_space_covering
ON block_properties(value_ref, block_id) WHERE key = 'space'` so the
**covering index is already in place** — the read-paths agent's BLOCKER
framing of "unindexed scan" was wrong on that point (downgraded; see §6).

The real issues that remain:

1. The clause is inlined at 10+ sites because `sqlx::query!()` rejects
   `concat!()` (PEND-12 spike confirmed). Drift across sites is a
   correctness risk.
2. The subquery shape (`COALESCE(b.page_id, b.id) IN (SELECT … WHERE
   key = 'space' AND value_ref = ?)`) prevents the planner from using the
   partial index as efficiently as a direct equi-join would — needs an
   `EXPLAIN QUERY PLAN` audit at 100K to confirm.
3. `COALESCE(b.page_id, b.id)` defeats the `blocks(page_id)` index for
   the non-NULL case. Either always materialise `page_id = id` for pages
   (so `b.page_id` is never NULL) or split the predicate into
   `(b.page_id = ?N OR (b.page_id IS NULL AND b.id = ?N))` so the planner
   can pick the right index.

**Fix shape:** (a) Add a drift-detection test in `space_filter_canonical`
that enforces every space-aware production SQL site matches one of two
canonical shapes (subquery for legacy, equi-join for new). (b) Run
`EXPLAIN QUERY PLAN` against every flagged site under 100K fixtures —
file a follow-up plan for any that don't use the partial index.
**Cost S** for the test + audit; downstream fixes sized per site.

### H-2 — `list_page_links` does no caching at all (the 1.3 s @ 100K Problem)

**Where:** `commands/queries.rs` (the `list_page_links_inner` call site),
ARCH §25 lines 2386.

**Diagnosis:** Verified — there is **no `page_link_cache` table**. The
`block_links` cache materialises per-block edges; the page-level roll-up
(grouping by `page_id` and joining `blocks × block_properties` for
display) happens on every call via a 3-JOIN superlinear query. At 100K
blocks with 200K links, this is the documented 1.3 s bottleneck.

**Fix shape:** New `page_link_cache(source_page_id, target_page_id,
edge_count)` table populated by the same materializer that owns
`agenda_cache` (migration 0025 pattern). Rebuild trigger on
`ReindexBlockLinks` already runs per content edit — fold a per-page
roll-up into that handler. **Cost L** (~3-5 days). Carves into its own
plan once the 100K bench from
`pending/scale-benchmarks-100k-2026-05-14.md` Phase 2 §B.2 exists.

### H-3 — `list_projected_agenda` cache path has the unindexed-COALESCE shape

**Where:** `commands/agenda.rs:262-264`.

The projected-agenda cache IS being consumed (the read-paths slice was
right that the cache exists; the cache-layer review confirmed it's
populated by the materializer). The 620 ms@100K bottleneck is **not**
cache absence — it's the same unindexed-space-filter +
COALESCE-defeats-index pattern from H-1, applied to the cache join.

**Fix:** Resolves automatically once H-1's audit lands. **Cost: 0**
(subsumed by H-1).

## §3 — Medium-impact (5 — bullet form)

- **M-2: Three full-rebuild cache paths could be incremental.**
  `rebuild_pages_cache`, `rebuild_tags_cache`, `rebuild_block_tag_refs_
  cache` all use `DELETE *; INSERT SELECT …`. At 100K rows this is two
  passes. `rebuild_agenda_cache` already did the sort-merge incremental
  upgrade (M-19b) — apply the same pattern to the other three. **Cost M**.
- **M-5: `query_by_property` (`pagination/properties.rs:89-298`) is
  250 LOC of `format!()`-built SQL** that interpolates the column name
  `b.{col}`. The column is a whitelisted reserved key, so injection is
  impossible — but the maintenance hazard is real: adding a new
  reserved key (e.g. `block_rank`) requires touching two branches +
  13 bind slots. Refactor to an enum-based dispatch with one
  `query_as!` branch per reserved column. **Cost M**.
- **M-6: Snapshot create + op_log DELETE are in one tx; compaction is
  non-idempotent on crash** (`snapshot/create.rs:377-437`). The pending
  snapshot is left orphaned and the ops aren't deleted; the next boot
  deletes the pending row and re-does compaction from scratch. Not data
  loss, just retry-thrashing. Fix: separate the snapshot creation
  (INSERT/UPDATE) tx from the op_log DELETE tx so a failure in the
  second leaves the snapshot complete and usable. **Cost M**.
- **M-7: `set_todo_state_batch_inner` (`commands/properties.rs:414`)
  skips timestamp + recurrence side-effects** that the single-row
  variant performs. Documented in the docstring, but a caller (UI batch
  toggle, MCP agent) expecting parity gets the wrong shape silently.
  Fix: emit a warn-level log if any block in the batch carries a
  `repeat` property; expose a separate
  `set_todo_state_batch_with_side_effects` for callers that need parity.
  **Cost S**.
- **M-8: Snapshot restore materialises the full parsed `SnapshotData`
  in RAM** (`snapshot/restore.rs:76-88`). The docstring claims memory
  is bounded, but the *parsed struct* (not the compressed bytes nor
  decompressed CBOR stream) is fully in-memory. At 100K ops a
  SnapshotData can peak at 50-80 MB. On desktop, fine. On Android
  (24 MB heap), a real OOM risk. Fix: stream-decode CBOR per-table
  into batch INSERTs against the open tx. **Cost L**; defer until
  Android profiling justifies.

## §4 — Low-impact / hygiene (cumulatively 8 items)

- **L-1:** `peer_refs::upsert_peer_ref` uses `INSERT OR IGNORE` while
  `upsert_peer_ref_with_cert` uses `ON CONFLICT DO UPDATE`. Both are
  correct but the asymmetry is undocumented. Add a comment.
- **L-2:** `sync_protocol/operations.rs::get_local_heads` uses
  `query_as::<_, DeviceHead>()` (runtime-checked) instead of
  `query_as!()` (compile-checked). One-line conversion.
- **L-3:** `merge/apply.rs` may be partly dead code post-PEND-09. Audit
  call paths; deprecate or document.
- **L-4:** `block_drafts` has no index on `updated_at` — the boot-
  recovery SELECT does a sort over a full scan. Low priority because
  draft counts are typically <100.
- **L-5:** `apply_reverse_in_tx` SetProperty arm does an `INSERT OR
  REPLACE` without re-running `validate_property_value`. Fix B-1 closes
  this — once SQLite enforces exactly-one-non-null, this is
  unnecessary.
- **L-6:** Sort-by-property cursor scan in backlinks (`backlink/query
  .rs:178-185`, PERF-19 deferred) is linear over `sorted_ids`. Confirmed
  deferred by design with PAGINATION_MAX=200 upstream — no action.
- **L-7:** Concurrency-cap absence in backlink filter resolver (PERF-20
  deferred) is acceptable today (UI filter count is 2-4); becomes a
  footgun if a "saved query library" feature ships. No action until then.
- **L-8:** Recursive CTE depth-100 limit (`pagination/{history,
  trash}.rs`) hits silently with no warn. Add a one-line "depth-limit
  hit, result may be incomplete" log.

## §5 — Cross-cutting themes

Pulling back from individual findings, four themes recurred:

1. **Stale `json_extract` after schema denormalisation.** Migration 0030
   added `op_log.block_id` but two `dag.rs` queries (B-2) and one
   `attachment_ops.rs` query (B-4) never got the memo. The lesson:
   every column-denormalisation migration should land with a regression
   test that asserts no production SQL still uses the JSON-extract path
   it replaced. The op-log audit already added that test for
   `op_log.block_id`; extend the pattern to `attachment_id` and any
   future denorm.
2. **The "exactly N writes per command" question.** The block-write
   slice flagged that `create_block` makes 6 SQL statements (ARCH §3
   note) and that some commands could collapse loops to `json_each`-
   driven single-shot. The pattern of "loop-N-statements-in-a-tx vs
   one-statement-with-json_each" is visible across writes, reverse-op
   replay (B-3), sync catch-up (M-1), and cache rebuilds (M-2). A single
   plan that audits the top-10 hot write loops and converts them to
   `json_each` is probably worth ~30% latency on multi-row IPCs at
   100K. Sizing it cleanly needs the bench gate from
   `scale-benchmarks-100k-2026-05-14.md` Phase 1.
3. **`COALESCE` defeats indexes.** H-1 / H-3 surface the same pattern:
   `COALESCE(b.page_id, b.id)` cannot use the `blocks(page_id)` index
   because the planner doesn't know the COALESCE result is one of two
   indexed values. The right fix is upstream: backfill `b.page_id =
   b.id` for every page (so `b.page_id` is never NULL for pages) and
   drop the COALESCE everywhere. Cost ~M; impact every paginated read.
4. **DEFERRED-vs-IMMEDIATE consistency.** Three places use
   `pool.begin()` (DEFERRED) on the write pool: materializer apply
   (M-1), cache rebuilds (cache/*), and a handful of internal
   helpers. None are correctness bugs — atomicity is preserved
   because everything that needs to be atomic is in the same tx —
   but they create contention storms during sync bursts. A
   one-pass conversion to `begin_with("BEGIN IMMEDIATE")` (mirroring
   `db::begin_immediate_logged` used by snapshot restore and
   commands) makes the write-path uniform and surfaces stalls as
   loud `warn!`s instead of silent 5 s busy-timeouts.

## §6 — Findings downgraded after verification

Three claims from the review agents were verified against the source and
downgraded:

- **Apply cursor "BLOCKER: atomicity broken via DEFERRED"** — verified
  at `materializer/handlers.rs:53,168`. The agent correctly identified
  DEFERRED but framed it as a correctness bug ("race window: Thread A
  applies ops → observes seq=42, Thread B crashes mid-apply → recovery
  replays from cursor=41"). This is wrong: `apply_op` + cursor advance
  are in the **same tx**, so a crash rolls back both. DEFERRED here is
  a contention/busy-timeout issue, not a correctness one. Downgraded
  to **M-1**.
- **Snapshot restore "BLOCKER: full 200 MB in memory"** — verified at
  `snapshot/restore.rs:80-95`. The docstring explicitly says the
  compressed bytes and decompressed CBOR stream are streamed; only
  the parsed `SnapshotData` struct is in RAM. The struct can peak at
  50-80 MB at 100K ops — real on Android, fine on desktop. Downgraded
  to **M-8**, deferred until Android profiling.
- **Read-paths "BLOCKER: space-filter unindexed"** — verified that
  migration 0061 already created
  `idx_block_properties_space_covering`. The agent's framing was
  wrong about index absence, but the **drift across 10+ inlined
  sites** and the **COALESCE-defeats-index** issue remain. Recharacterised
  as **H-1**.

## §7 — Phased plan

**Phase 1 — Quick correctness wins.** ✅ SHIPPED session 740. B-1 (block_properties
CHECK + paired `value_ref` FK SET NULL → CASCADE flip in migration 0062),
B-2 (dag.rs `block_id` swap, 2 sites), H-4 (cursor sanity check) all landed
with regression tests. M-4 (retry-queue covering index, migration 0063) also
absorbed into this batch.

**Phase 2 — Index + dispatch hygiene.** ✅ SHIPPED session 741. M-1 (BEGIN
IMMEDIATE on apply path via `db::begin_immediate_logged`), M-3 (soft_delete
primitives now take `&Materializer` and dispatch FULL_CACHE_REBUILD_TASKS +
FTS task themselves; 61 test/integration call sites updated), B-4 (new
`op_log.attachment_id` column via migration 0064, mirroring the 0030
`block_id` pattern; reverse-attachment query swapped to the native column).

**Phase 3 — Reverse-op + write-loop batching (M+M, ~4 days).**
B-3 (revert_ops batching) + the cross-cut "audit top-10 write loops for
json_each conversion". Needs `scale-benchmarks-100k-2026-05-14.md`
Phase 1's gate landed first so we can measure pre/post.

**Phase 4 — Cache structural changes (L + L, ~2 weeks).**
H-2 (`page_link_cache` materialisation — separate plan) + the
COALESCE-removal backfill (theme §5.3) + M-2 (incremental rebuilds for
pages/tags/block_tag_refs). Largest impact on the 100K interactive SLO.

**Phase 5 — Snapshot streaming + non-idempotent compaction fix (L+M, ~1
week).** M-6 (compaction tx split) + M-8 (streaming snapshot restore).
Gated on Android profiling for M-8 cost/benefit.

## §8 — Cost / Impact / Risk

- **Phase 1:** ✅ SHIPPED session 740 (B-1 + B-2 + H-4 + M-4). Closed 4 verified
  correctness/perf holes (one of them — B-1 — required a paired FK semantic
  flip on `block_properties.value_ref`, which fanned out to 4 production sites
  that previously did app-level `SET value_ref = NULL`; they now `DELETE`
  the property row instead, matching the new CASCADE direction).
- **Phase 2:** ✅ SHIPPED session 741 (M-1 + M-3 + B-4). M-3 expanded to 61
  test/integration call sites + 4 bench sites because the dispatch contract
  is enforced at the type system; B-4 added migration 0064 mirroring the
  proven 0030 `block_id` denormalisation pattern. Subsumes original M-1
  framing.
- **Phase 2 (original):** Cost **S-M** (~3 d). Impact: removes contention
  storms during sync bursts; closes hidden dispatch coupling.
  Risk: medium — `BEGIN IMMEDIATE` conversion can surface upstream
  stalls that DEFERRED hid (a feature, not a bug, but PRs may need
  follow-up).
- **Phase 3:** Cost **M-L** (~4-7 d). Impact: 30%+ latency on
  multi-row writes; ~30× speedup on 50-op undo. Risk: medium —
  parity tests against pre-batch behaviour are mandatory.
- **Phase 4:** Cost **L** (~2 w). Impact: closes the two §25 Problem
  commands. Risk: medium-high — `page_link_cache` adds write-amp to
  every content edit; needs careful invalidation testing.
- **Phase 5:** Cost **L** (~1 w). Impact: Android-only memory win + a
  small reliability win on compaction crash. Risk: low — both are
  additive.

## §9 — Open questions

1. **Is the COALESCE-defeats-index theory measured or inferred?** §5.3
   is based on reading the SQL; we need `EXPLAIN QUERY PLAN` at 100K
   to confirm before sizing Phase 4's backfill plan.
2. **Should `page_link_cache` (H-2) be a materialised table or a
   `RECURSIVE` CTE rewrite of `list_page_links_inner`?** Bench both
   under the Phase 2 gate from `scale-benchmarks-100k-2026-05-14.md`
   before committing. Cache adds write-amp; CTE adds read cost.
3. **Loro engine ↔ SQL projection asymmetric atomicity** (sync agent
   flagged this as a BLOCKER with uncertainty). The agent saw the
   docstring promise idempotent re-projection on crash but didn't find
   the implementation. **Action:** spend a half-day reading
   `sync_protocol/loro_sync.rs` carefully and either (a) find the
   crash-recovery code and document it, or (b) confirm the gap and
   file a follow-up plan. Not in any phase above because the answer
   determines severity.

## §10 — Related

- `ARCHITECTURE.md` §3 (Database, lines 203-280), §4 (Op log,
  ~270-370), §5 (Materializer, 383-460), §25 (Scalability, 2374-2393).
- `AGENTS.md` "Database" section (lines 107+).
- `pending/scale-benchmarks-100k-2026-05-14.md` — companion plan that
  defines the latency-assertion gate this review's perf claims depend
  on for regression detection.
- `pending/REVIEW-LATER.md` PERF-19 / PERF-20 — backlink-perf items
  explicitly deferred; not in scope for this plan.
- Migrations: 0001 (B-1), 0030 (B-2, B-4 pattern), 0040 (H-4 cursor
  table), 0061 (FK CASCADE + table rebuild precedent for B-1's fix
  shape).
