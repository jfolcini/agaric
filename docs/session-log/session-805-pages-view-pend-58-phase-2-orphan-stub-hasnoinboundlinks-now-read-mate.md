## Session 805 — Pages view: PEND-58 Phase 2 — Orphan/Stub/HasNoInboundLinks now read materialised pages_cache columns (2026-05-21)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-21 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | PEND-58 Phase 2 (Pages-only filter primitives refactor) |
| **Items modified** | — |
| **Tests added** | +6 backend (2 SQL-shape snapshots + 4 EXPLAIN QUERY PLAN assertions) |
| **Files touched** | 1 (src-tauri/src/filters/primitive.rs only) |

**Summary:** Refactored the three Pages-only `FilterPrimitive` variants (`Orphan`, `Stub`, `HasNoInboundLinks`) so their `PagesProjection::compile_*` outputs read from `pages_cache.{inbound_link_count, child_block_count}` (materialised in PEND-56b) instead of the raw `block_links` / `COUNT(*)` correlated subqueries that hit the same 20k-page latency cliff PEND-56b closed. Also corrected `Stub`'s threshold from a placeholder `< 3` to the spec-correct `= 0` (PEND-58 vocabulary: "Page whose only block is its own title row (zero non-title descendants)"). The IPC wiring of `Vec<FilterPrimitive>` belongs to Phase 3 — this cycle is backend primitives + tests only.

- **Refactored compile fragments:**
  - `Orphan` → `COALESCE(pc.inbound_link_count, 0) = 0 AND NOT EXISTS (SELECT 1 FROM block_links WHERE source_id = b.id)`. Inbound side index-served; outbound side still scans `block_links` (no materialised `outbound_link_count` yet — filed as a follow-up if measurement shows it dominating).
  - `Stub` → `COALESCE(pc.child_block_count, 0) = 0`.
  - `HasNoInboundLinks` → `COALESCE(pc.inbound_link_count, 0) = 0`.
- **Composition contract** documented in a code comment above the three fns: the caller must splice into a SELECT that already `LEFT JOIN pages_cache pc ON pc.page_id = b.id` (canonical example: `commands::pages::list_pages_with_metadata_inner`). The `COALESCE(_, 0)` defends against the materializer-guaranteed-not-to-happen "no `pages_cache` row" case.
- **Inbound-semantic alignment** (raised by the tech reviewer as NEEDS_DISCUSSION) — `pc.inbound_link_count` counts "edges targeting the page OR any non-deleted descendant", broader than the Phase-1 placeholder's `target_id = b.id`. This is the same definition the metadata IPC + `MostLinked` sort + `<DensityRow>`'s `↗` badge already use. Aligning the filter makes Pages internally consistent — a user clicking `orphan:` after seeing "0 ↗" on a row always agrees with the surfaced count. Doc comments now document this explicitly on `compile_orphan` + `compile_has_no_inbound_links`.
- **`LastEditedSpec` review** — confirmed the existing `Rolling(u32)` / `OlderThan(u32)` / `Range { start, end }` variants already cover PEND-58's full bucket vocabulary (`today` / `this-week` / `this-month` / `older` / `>=YYYY-MM-DD`). Added a chip-token → variant mapping table to the enum's doc comment. No new variant needed.
- **EXPLAIN QUERY PLAN tests** — `pages_only_primitives_use_indexed_paths` (4 sub-cases): each Pages-only primitive's composed query plan contains `pages_cache` (any row reading it) and lacks the pre-PEND-56b `block_links` scan for the inbound side. `Orphan` retains a `block_links` scan for the outbound `source_id` half — intentional, documented.

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-58 Phase 2 closed. Phase 3 (Pages frontend chip-row + IPC integration of `Vec<FilterPrimitive>`) remains.
- **Previously resolved:** 1256+ → 1256+ across 804 → 805 sessions (PEND-58 still has Phase 3-6 open).

**Files touched (this session):**
- `src-tauri/src/filters/primitive.rs` (+337 / −16; refactored compile fragments + composition-contract doc comment + 6 new tests).

**Verification:**
- `cd src-tauri && cargo nextest run --test-threads=4 filters` — 47/47 pass.
- `cd src-tauri && cargo nextest run` — 3874 / 3874 pass (3868 baseline + 6 new), 3 `#[ignore]`d.
- `cd src-tauri && cargo clippy --all-targets -- -D warnings` — clean.
- `prek run --all-files` — 48 hooks pass, 0 failed.

**Process notes:** small single-file backend cycle — one build subagent + one review subagent (no parallel build splits since the work was bounded to one file). Reviewer caught the inbound-semantic divergence and recommended documenting the alignment rather than reverting; orchestrator applied the doc-comment fix and shipped.

**Lessons learned (for future sessions):**
- When a refactor changes a SQL fragment that other surfaces also expose to users (`inbound_link_count` here surfaces in the `↗` badge, the `MostLinked` sort, AND filters), align the semantic across all of them in one PR rather than leaving the filter on the narrow definition. Tech-review's "this is a behavior change" flag is the right signal to either align or revert — never ship a silent divergence.

**Commit plan:** single commit on topic branch `pend-58-phase2-pages-primitives`; PR against `main`.
