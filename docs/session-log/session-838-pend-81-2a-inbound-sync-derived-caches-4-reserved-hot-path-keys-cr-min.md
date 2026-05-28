## Session 838 — PEND-81 §2A: inbound-sync derived caches (#4) + reserved hot-path keys + CR-MINOR sweep (2026-05-25)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-25 |
| **Subagents** | 2 build (snapshot test, filter-forms tests) + 1 review (core sync); the core re-projection + wiring + docstrings + docs were orchestrator-direct |
| **Items closed** | PEND-81 §2A #4 (derived caches rebuild after inbound sync) + reserved hot-path keys (`todo_state`/`priority`/`due_date`/`scheduled_date`); 4 CR-MINOR bullets (spawn_periodic_snapshot test seam, views.md Search refresh, rmcp_spike docstring, filter-forms tests); + Pages-view filter persistence (fix for a pre-push e2e flake surfaced while pushing) |
| **Items modified** | PEND-80 (Phase-1 follow-ups), PEND-81 (§2A progress) |
| **Tests added** | +37 (frontend: 30 filter-forms + 7 pageBrowserFilters store) / +4 (backend: 2 reserved-key projection, 1 inbound-sync fan-out, 1 spawn_periodic_snapshot smoke); 1 existing backend test updated for the new reserved-key sweep |
| **Files touched** | 19 (13 modified + 6 new) |

**Summary:** Closed the two unblocked PEND-81 §2A data-completeness items. **#4 derived
caches:** wired the orchestrator's formerly-`#[expect(dead_code)]` `materializer`
handle — the `ApplyOutcome::Imported` arm of `handle_message` now enqueues a new
`Materializer::enqueue_inbound_sync_rebuilds` (the `FULL_CACHE_REBUILD_TASKS` fan-out —
tags/pages/agenda/projected-agenda/page-ids/block-tag-refs/page-links — plus
`RebuildFtsIndex`) on the background queue, so remote tag/property/content changes no
longer silently diverge in the read-path caches/FTS until the next local mutation.
**Reserved hot-path keys:** `reproject_block_properties_from_engine` now authoritative-
replaces `todo_state`/`priority`/`due_date`/`scheduled_date` onto their dedicated
`blocks` columns (present key → engine value, absent key → NULL), mirroring the local
`project_set_property_to_sql` routing and never touching `deleted_at` (so no soft-delete
resurrection); the fan-out's agenda rebuild closes the agenda-derivation half. No engine
change needed. Also swept the remaining CR-MINOR bullets.

**REVIEW-LATER impact:**
- **Top-level open count:** 31 → 30 (CR-MINOR row + detail section removed — its last 4
  bullets all resolved this session).
- **Previously resolved:** 1342+ → 1348+ across 837 → 838 sessions.

**Files touched (this session):**
- `src-tauri/src/loro/projection.rs` (+159/−… — reserved-key reproject + 2 tests)
- `src-tauri/src/materializer/dispatch.rs` (+42 — `enqueue_inbound_sync_rebuilds`)
- `src-tauri/src/sync_protocol/orchestrator.rs` (+38/−… — wire materializer in `Imported` arm; field doc; drop `#[expect(dead_code)]`)
- `src-tauri/src/materializer/tests.rs` (+47 — fan-out rebuild test)
- `src-tauri/src/sync_protocol/loro_sync.rs` (+41/−… — reviewer updated `apply_remote_does_not_wipe_existing_block_derived_state` for the reserved-key sweep)
- `src-tauri/src/loro/snapshot.rs` (+64 — `spawn_periodic_snapshot_persists_engine_state` smoke test)
- `src-tauri/src/mcp/rmcp_spike.rs` (off-by-default → wired-on docstring)
- `docs/features/views.md` (Search section refresh: inline filter DSL, `+ Filter ▾` builder, toggles, per-space history, mobile)
- `src/components/search/__tests__/{DateFilterForm,IncludeExcludeToggle,PriorityFilterForm,StateFilterForm}.test.tsx` (new, 30 tests)
- `pending/PEND-80-…`, `pending/PEND-81-…`, `pending/REVIEW-LATER.md` (progress + resolved-item removal)

**Verification:**
- `cargo nextest run` (full) — 4005 tests run, 4005 passed, 6 skipped.
- `npx vitest run` (4 new filter-forms files) — 30 passed.
- `prek run --all-files` — all hooks pass (one EOF auto-fix on REVIEW-LATER, re-run clean).

**Process notes:** The orchestrator call-site (`handle_message` → `enqueue_inbound_sync_rebuilds`)
is covered by inspection + the method-level test, not an end-to-end orchestrator test —
the existing sync integration tests call `apply_remote` directly (bypassing `handle_message`),
and a full handle_message LoroSync test would need process-global `loro::shared` state
(order-dependent within a binary). The call site is a 3-line non-fatal log-and-continue
wrapper, so the gap is proportionate. The reserved-key reproject deliberately runs an
unconditional 4-column `UPDATE` per changed block (present→value, absent→NULL): safe
because the engine is never behind SQL for a synced block (`apply_set_property_via_loro`
always writes the engine; the SQL-only fallback fires only for spaceless blocks that never
reach sync).

**Lessons learned (for future sessions):** Launching a review subagent with edit
permission while the orchestrator runs the full `cargo nextest` caused a one-test build
race (the reviewer was mid-edit on the test it was fixing). Sequence them: let
review/edit subagents finish before the orchestrator's full-suite gate, or scope the
reviewer to read-only when a concurrent full run is planned.

**Pages-view filter persistence (push-time follow-up):** the pre-push CI gate
flaked on `e2e/pages-view.spec.ts:623` (the `has:template` chip not surviving a
create→editor→Pages round-trip). Investigation: `PageBrowser` held its compound
filter chips in local `useState`, and `ViewDispatcher`'s `switch` unmounts the
Pages view on navigation, so the chips were destroyed on the round-trip (and the
old `useState` also leaked one space's chips onto another when the view stayed
mounted across a space switch). Fix: lifted the chips into a new per-space,
in-memory `usePageBrowserFiltersStore` (`src/stores/pageBrowserFilters.ts`) so
they survive navigation and stay space-partitioned. Verified: `pages-view` +
`pages-filter` e2e (59 passed), the previously-flaky test now structural-pass;
PageBrowser + filter-row + new store unit suites (181 + 7).

**Commit plan:** two commits on `land-loro-sync-stack` — (1) the PEND-81 §2A sync
batch + CR-MINOR sweep, (2) the Pages-view filter-persistence fix — pushed; MR opened.
