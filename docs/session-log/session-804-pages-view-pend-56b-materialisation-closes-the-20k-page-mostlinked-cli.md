## Session 804 — Pages view: PEND-56b materialisation (closes the 20k-page MostLinked cliff, 335 ms → 34 ms) (2026-05-21)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-21 |
| **Subagents** | 3 build (parallel where independent, sequential where dependent) |
| **Items closed** | PEND-56b (materialisation follow-up to PEND-56). PEND-56's "Phase 1 perf cliff" risk is now retired. |
| **Items modified** | — |
| **Tests added** | +7 backend (1 schema-guard migration test + 4 materializer-parity tests + 2 EXPLAIN-QUERY-PLAN assertions + 1 `#[ignore]`d 20k-page perf bench) |
| **Files touched** | 6 (1 new migration, 4 modified .rs, 1 modified SESSION-LOG) |

**Summary:** Materialised `pages_cache.inbound_link_count` + `pages_cache.child_block_count` so the `most-linked` / `most-content` sort paths no longer pay the 335 ms / 20k-page COUNT(DISTINCT) cliff. The materializer maintains both columns byte-identically to the canonical SELECT in `commands/pages.rs:1666-1675` on every block-lifecycle op (CreateBlock / EditBlock / DeleteBlock / RestoreBlock / PurgeBlock), with a 4-test parity assertion exercising the full lifecycle. The IPC's SELECT now LEFT JOINs `pages_cache` and reads the cached columns directly; bench drops from **335 ms → 34 ms (10× win)** at 20k pages, well under PEND-56b's 50 ms acceptance criterion.

- **Migration 0069** — `ALTER TABLE pages_cache ADD COLUMN inbound_link_count / child_block_count INTEGER NOT NULL DEFAULT 0`, backfilled with the IPC's exact SELECT shape (not via `page_link_cache`, to absorb any drift). Header documents the no-index decision: at ≤20k pages, the quick-sort-into-top-K plan is sub-50 ms; a secondary index on `inbound_link_count DESC` would add maintenance cost on every link change without paying for itself.
- **Materializer maintenance** (`src-tauri/src/materializer/handlers.rs`) — added `recompute_pages_cache_counts_for_pages`, `maintain_pages_cache_counts_after_op`, `refresh_inbound_counts_after_reindex`, plus small parsing/resolution helpers. The chosen approach is **recompute-on-touch** (run the canonical SELECT for affected pages on each op) over delta-math — trades a small per-op cost for total correctness, and the parity test catches any drift. Touch sites: `apply_op_tx` post-projection + the `MaterializeTask::ReindexBlockLinks` arm (where the existing per-block link diff already happens).
- **SortKeyset extraction + IPC refactor** (`src-tauri/src/commands/pages.rs`) — refactored `list_pages_with_metadata_inner` from a 263-line 5-arm match into an 83-line `keyset.apply(...)` + 4-line bind loop (-68 % LOC at the touch site). The new `SortKeyset` enum covers four shapes (`StringAsc`, `StringDescNullCoalesced` for the `LAST_MOD_NULL_SENTINEL` path, `I64Desc`, `IdOnly`) — descriptor co-located in `pages.rs` (no new module). `EXPLAIN QUERY PLAN` for `most-linked` confirms the plan now uses `SEARCH pc USING INDEX sqlite_autoindex_pages_cache_1` — no `block_links` scan, no `CORRELATED SCALAR SUBQUERY`.
- **Parity contract** — `pages_cache_count_parity` test module: 4 tests, mixed 10-page fixture, asserts `materialised == computed` after every materializer op. Reduced from PEND-56b's proposed 1000-page fixture (the parity contract is op-agnostic so fixture size affects CI cost only, not coverage).
- **Bench** — `most_linked_perf_gate_20k_pages` (`#[ignore]`d): 20k seeded pages, 3× warmup, median of 5 samples → **34 ms** (samples: 34, 34, 34, 34, 35 ms).

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-56b retired (file removed from `pending/` in this commit). PEND-56's deferred risk on the most-linked path is closed. PEND-58's `orphan:` / `has-no-inbound-links:` facets — which would have hit the same cliff — now inherit the materialised counts for free.
- **Previously resolved:** 1255+ → 1256+ across 803 → 804 sessions.

**Files touched (this session):**
- `src-tauri/migrations/0069_pages_cache_link_and_content_counts.sql` (new, +50)
- `src-tauri/src/op_log.rs` (+95; schema-guard test for the new columns + canonical-SELECT parity assertion on a 6-block / 5-link / 2-page fixture)
- `src-tauri/src/materializer/handlers.rs` (+710 / −15; helper module + recompute-on-touch wiring at the 5 touch sites)
- `src-tauri/src/materializer/tests.rs` (+520; `pages_cache_count_parity` test module, 4 tests, 10-page fixture)
- `src-tauri/src/commands/pages.rs` (+245 / −180; `SortKeyset` enum + `keyset_for` + `impl::apply` + `SqlBind` + LEFT JOIN `pages_cache`; 263-line IPC body → 83 lines)
- `src-tauri/src/commands/tests/list_pages_with_metadata_tests.rs` (+200; existing helpers seed `pages_cache`; 2 new EXPLAIN QUERY PLAN tests + 1 `#[ignore]`d 20k-page perf bench)
- `src-tauri/src/mcp/tools_ro.rs` (drive-by: clippy `doc_lazy_continuation` warning fix for a `+ cache-init + metrics tasks` comment line that markdown was reading as a list bullet)
- `pending/PEND-56b-pages-materialization-followup.md` (removed in this commit — the plan is shipped)

**Verification:**
- `cd src-tauri && cargo nextest run` — 3868 tests pass, 3 `#[ignore]`d (the perf bench + 2 pre-existing).
- `cd src-tauri && cargo nextest run pages_cache_count_parity` — 4/4 pass.
- `cd src-tauri && cargo sqlx prepare --workspace -- --tests` — succeeded; 3 new query JSONs landed under `src-tauri/.sqlx/`.
- `prek run --all-files` — 48 hooks pass, 0 failed.

**Process notes:** parallel-cycle execution per `PROMPT.md` — Wave 1 (migration + materializer hooks) launched concurrently with the build subagents coordinating on column names + types via the prompt contract (both prompts named the same `inbound_link_count` / `child_block_count` shape so the merge was conflict-free). Wave 2 (SortKeyset extraction + IPC refactor) ran sequentially after both Wave 1 agents finished, since the IPC depends on the materialised columns existing. The orchestrator handled the cross-cutting cleanup (clippy `doc_lazy_continuation` in `tools_ro.rs` — pre-existing warning surfaced by the current Rust toolchain's stricter lints; one-line wording fix to avoid the leading `+` markdown bullet).

**Lessons learned (for future sessions):**
- When the materializer maintains a derived column, **recompute-on-touch** beats delta-math for first-cut correctness. The per-op cost is bounded by the affected-page count (typically 1-5), and the parity test catches any drift the delta math would silently introduce. PEND-58's grooming facets should adopt the same pattern.
- Pre-existing clippy warnings can surface unexpectedly when a sub-component change pulls the lint into a wider scope. The `doc_lazy_continuation` lint reads `+ word` at line-start as a markdown bullet — avoid putting `+` (or `-` / `*` followed by a space) as the first non-`///` character in doc comments.

**Commit plan:** single commit on topic branch `pend-56b-pages-materialization`; PR against `main`. Stacks logically on top of Cycle 1's branch (PR #46, merged as Session 803 below) but doesn't depend on it — touches different files.
