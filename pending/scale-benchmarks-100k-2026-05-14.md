# Scale benchmarks — 100K pages, sub-200ms interactive budget — 2026-05-14

> **Status:** **draft plan.** Audits existing Criterion coverage in
> `src-tauri/benches/` against the product goal "scale to 100K pages with
> sub-200ms response on any interactive command" and proposes the missing
> benches, latency-assertion gates, and fixes for the two commands already
> known to bust the budget at 100K.

## Verdict on the 200ms target

**Reasonable as an *interactive*-command SLO; not reasonable as a blanket
"any command" rule.** ARCHITECTURE.md §25 (`Scalability Characteristics`,
lines 2374–2393) is the source of truth — it bench-measures 11 commands at
100K and already calls out two as **Problem**:

| Command                  | 100K latency | Verdict in §25                    |
| ------------------------ | ------------ | --------------------------------- |
| `list_page_links`        | **~1.3 s**   | Problem — superlinear (3 JOINs)   |
| `list_projected_agenda`  | **~620 ms**  | Problem — O(n×m) in-memory        |
| `count_backlinks_batch`  | ~62 ms       | Concerning at scale               |
| `create_block`           | 36 ms        | Marginal — per-keypress budget    |
| `compact_op_log`         | 393 ms       | Acceptable — **maintenance only** |

Three tiers fall out of that table:

- **Interactive (≤200 ms p95 @ 100K)** — every user-facing read/edit
  command. `get_block`, `list_blocks`, `count_agenda_batch`,
  `batch_resolve`, `export_page_markdown`, `count_backlinks_batch`,
  `create_block` already meet this. `list_page_links` and
  `list_projected_agenda` do **not**.
- **Maintenance (no UI gate)** — `compact_op_log`, FTS rebuild, import,
  snapshot. Streamed via progress channel; 200 ms is not the right SLO.
- **Bulk write (≤500 ms p95)** — multi-block paste, undo of large groups,
  revert of long history. No bench coverage today; budget needs to be
  *picked* before it can be asserted.

## What we have today (23 bench files, ~24K LOC of bench code)

**100K scale already exercised** in `commands_bench.rs`,
`pagination_bench.rs`, `cache_bench.rs`, `fts_bench.rs`, `op_log_bench.rs`,
`compaction_bench.rs`, `move_reorder_bench.rs`, `backlink_query_bench.rs`,
`tag_query_bench.rs`, `property_bench.rs`, `property_def_bench.rs`.

**Lower-scale only** in `graph_bench.rs` (max 10K — exactly where the
1.3 s/100K Problem lives), `agenda_bench.rs` (low N for `list_projected_agenda`),
`draft_bench.rs`, `attachment_bench.rs`, `import_bench.rs`,
`export_bench.rs`, `snapshot_bench.rs`, `soft_delete_bench.rs`,
`undo_redo.rs`, `alias_bench.rs`, `hash_bench.rs`.

**Critical gap:** **no bench in the tree asserts a wall-clock threshold.**
Every bench prints Criterion timings; none of them fail CI when a
regression pushes `list_blocks` from 12 ms to 250 ms. The "sub-200 ms"
target is a goal stated in product-level discussions and `ARCHITECTURE.md`
prose, but it is not codified anywhere the toolchain can enforce.

## What's missing / needs updating

### A. Latency-assertion gate (new file)

`src-tauri/benches/interactive_slo.rs` — a *separate* Criterion target that
re-runs the existing 100K-scale measurements for the **interactive tier**
and `panic!`s if any sample's mean exceeds the per-command budget. Wired
into `cargo bench --bench interactive_slo` and run once in CI (release
profile, single-thread, fixed seed). Budgets seeded from §25 numbers,
rounded up:

| Command                         | Budget @ 100K                             |
| ------------------------------- | ----------------------------------------- |
| `get_block` / `get_properties`  | 1 ms                                      |
| `list_blocks` (paginated)       | 30 ms                                     |
| `batch_resolve`                 | 5 ms                                      |
| `count_agenda_batch`            | 30 ms                                     |
| `count_backlinks_batch`         | 100 ms                                    |
| `export_page_markdown` (2K)     | 10 ms                                     |
| `create_block`                  | 60 ms                                     |
| `list_page_links`               | 200 ms (aspirational — currently failing) |
| `list_projected_agenda`         | 200 ms (aspirational — currently failing) |

Failures here block CI and surface in PR review without needing a human
to eyeball Criterion HTML reports.

### B. Three new bench files for uncovered hot paths

1. **`history_bench.rs`** — `list_page_history_inner`, `revert_ops_inner`,
   `undo_page_op_inner`, `redo_page_op_inner`. Scale `[1K, 10K, 100K]`
   ops on a single page. Budget: **<200 ms** for a 50-op revert at 100K
   total ops. Today these are tested only indirectly through `undo_redo.rs`'s
   `compute_reverse` (op-log primitive, not the Tauri command).
2. **`graph_bench_100k.rs`** (or extend existing `graph_bench.rs`) — extend
   `list_page_links` sweep from `[100, 1K, 10K]` to include **100K**.
   Today the bench *stops* at 10K, so the 1.3 s/100K number in §25 came
   from one-off measurements that nothing prevents from regressing.
3. **`agenda_expansion_bench.rs`** — exercise `list_projected_agenda_inner`
   with **`[100, 1K, 10K]` repeating rules** (the m in O(n×m), which the
   current `agenda_bench.rs` does not parametrize). Without this we cannot
   verify any fix for the §25 Problem case.

### C. Fix the two documented Problem commands

`list_page_links` and `list_projected_agenda` are the *only* documented
violations of the 200 ms interactive budget. Neither has a mitigation
plan in `REVIEW-LATER.md` (PERF-19/20 there are about *backlinks*, not
graph/agenda). The fixes are out of scope for this plan but the new
benches in §B unblock the work:

- `list_page_links` — the 3-JOIN superlinearity is rooted in
  `block_links` × `blocks` × `block_properties`. Probable fix is a
  materialized `page_link_cache` table populated by the same materializer
  that owns `agenda_cache` (migration 0025 pattern). Estimate L; carve into
  its own plan once the 100K bench exists.
- `list_projected_agenda` — current implementation expands repeating rules
  in Rust. Probable fix is to push the date-range generation into SQL with
  a recursive CTE bounded by viewport date range. Estimate M-L; carve into
  its own plan.

### D. Documentation drift

`ARCHITECTURE.md` §25 (lines 2374–2393) is the canonical scalability table
but cites no commit hash for when each number was measured. Add a
`Measured: <session N>` column so future readers know which numbers are
stale. Trivial; bundle with whichever bench-add commit lands first.

## Phases

1. **Phase 1 — Gate (S, ~half day).** Land `interactive_slo.rs` with the
   commands already covered at 100K (all green except the two Problem
   commands, which are explicitly marked `#[ignore]` with a TODO referencing
   their mitigation plans). Wire into CI bench target — keep the run under
   2 min by reusing fixtures and `sample_size(10)` for the gate target.
2. **Phase 2 — Cover the gaps (M, ~1.5 days).** Add `history_bench.rs`,
   extend `graph_bench.rs` to 100K, add `agenda_expansion_bench.rs`. No new
   product code; pure bench harness. Each new bench gets a row in
   `interactive_slo.rs` so it cannot regress silently.
3. **Phase 3 — Fix the two Problem commands (separate plans).** Spawn
   `list-page-links-materialize-2026-NN.md` and
   `agenda-projection-sql-pushdown-2026-NN.md` once §B benches exist. Each
   removes its own `#[ignore]` line in `interactive_slo.rs` as it lands.

## Cost / Impact / Risk

- **Phase 1 (gate):** Cost **S** (0.5 d). Impact: any future PR that
  regresses a covered interactive command fails CI instead of shipping.
  Risk: low — benches run in release profile on a CI runner whose noise
  floor is ~15%, so budgets are set with comfortable headroom; flake
  risk mitigated by `sample_size(10)` and median-of-3.
- **Phase 2 (new benches):** Cost **M** (1.5 d). Impact: closes the only
  three remaining gaps for "every interactive command has a 100K-scale
  measurement". Risk: low — additive, no product changes.
- **Phase 3 (Problem-command fixes):** Cost **L** total, split across two
  follow-up plans. Impact: removes the only two documented violations of
  the 200 ms budget. Risk: medium — `list_page_links` materialization
  touches the same hot path as `block_links` writes, so write-amp needs
  careful measurement; `list_projected_agenda` SQL pushdown reshapes a
  recursive-CTE return shape.

## Open questions

1. **CI cost.** Running 100K-scale benches on every PR may push CI from
   ~8 min to ~12 min. Acceptable, or run `interactive_slo` only on
   `main` + `release/*` branches? — pending decision.
2. **Bulk-write tier budget.** ≤500 ms p95 is a guess; the only data
   point is `compact_op_log` at 393 ms (which is maintenance, not
   bulk-write). Need to pick something defensible — current proposal:
   measure paste-50-blocks and revert-50-ops first, then set the budget
   at `2 × measured` to leave headroom.
3. **Materialized `page_link_cache` vs. query rewrite.** Phase 3 assumes
   materialization; a recursive-CTE rewrite of the 3 JOIN query might
   close the gap without a new cache table. Bench both before committing.

## Related

- `ARCHITECTURE.md` §25 lines 2374–2393 — scalability table (source of
  the two Problem commands and the existing 100K numbers).
- `pending/design-system-perf-review-2026-05-09.md` — frontend-side
  perf review; orthogonal to this plan (this one is backend-only).
- `pending/REVIEW-LATER.md` PERF-19 / PERF-20 — backlink-perf items
  explicitly deferred; **not** the same as the §25 Problem commands.
- `src-tauri/benches/graph_bench.rs:90–122` — `list_page_links` bench
  capped at 10K (the file Phase 2 extends).
- `src-tauri/benches/agenda_bench.rs:199–248` — `list_projected_agenda`
  bench without repeating-rule parametrization.
- Migration `0025_projected_agenda_cache.sql` — pattern for the
  Phase 3 `page_link_cache` proposal.
