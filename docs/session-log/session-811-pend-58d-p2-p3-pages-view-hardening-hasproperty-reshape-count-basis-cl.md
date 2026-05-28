## Session 811 — PEND-58d P2+P3: Pages-view hardening (HasProperty reshape, count-basis, clear-all, validation, +20 fixes) (2026-05-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-22 |
| **Subagents** | 7 build (backend-core · tauri-mock · PageBrowser+Header · popover+filter-row · RowRenderer-test · HasProperty-backend · HasProperty-frontend) + orchestrator-direct (D27 docs, i18n pre-add, docs/PAGES.md). Deep multi-perspective review deferred to its own user-requested phase. |
| **Items closed** | PEND-58d P2 (D5–D15) + P3 (D16–D27), except D23a (deferred). All backend/frontend unit + tauri-mock tests (T-B2/B3/B4/B7, T-F1–F4, T-M1/M2). |
| **Items modified** | PEND-58d (only the comprehensive e2e suite + D23a remain) |
| **Tests added** | +~45 frontend / +~18 backend |
| **Files touched** | 24 |

**Summary:** Shipped every P2/P3 finding of the whole-feature review across SQL, backend Rust, frontend React, and docs — 22 items in two waves of parallel subagents. **Backend:** `RecentlyModified` perf gate + ceiling doc (D5); `total_count` gated to the first page, FE retains it (D6); `LastEdited` NULL symmetry via a common epoch sentinel (D7) + date validation (`InvalidDateFilter:`, D15); `Orphan` outbound now joins the target and excludes deleted/same-page edges (D19); `WhereClause.unsupported` became a boolean field (D18); module doc fix (D16); `Space` kept + documented as a harmless no-op (D17). **HasProperty overhaul (D8 + D26):** the IPC type was reshaped from `{op, value: Option}` to a nested `predicate: PropertyPredicate` (`Exists | NotExists | Eq{value} | Ne{value}`) so invalid states are unrepresentable; all predicate × `Text`/`Ref` combos now compile (incl. the previously-rejected `value_ref` / `Ne` cases); bindings regenerated; the popover, summary, and tauri-mock migrated to the new shape. **Frontend:** load-more wrapped in `role="row"`/`gridcell` (D9); optimistic-create reloads under active chips (D10); count-chip basis fixed with a `countMatching` branch (D11); clear-all control (D12); header `flex-wrap` (D13); empty-value Apply disabled (D14); count decremented on delete (D20); HasProperty editor `autoFocus`+Enter (D21); chip dedupe (D22); `aria-activedescendant` guarded to rendered rows (D23b); D24 added the path-`exclude` toggle, property op selector (is/is-not/exists/doesn't-exist), and per-facet chip tooltips with distinct Orphan vs No-inbound copy; popover focus model + dead/redundant i18n cleanup (D25). **Docs:** AGENTS.md + `docs/architecture/filters.md` reconciled to the current Pages-only reality (D27); `docs/PAGES.md` documents the new controls. **tauri-mock** now genuinely filters PathGlob/HasProperty/LastEdited and returns a real `total_count` (T-M1), unblocking behavioural e2e.

- **Parallelization.** Wave 1 ran 5 subagents on disjoint files (one Rust-backend, three frontend by component-ownership, one tauri-mock) — Rust and TS compile independently, and the frontend split avoided shared-file conflicts; the `onClearAll` prop contract was specified to both sides and converged on tsc. i18n keys were pre-added orchestrator-side. Wave 2 sequenced the HasProperty IPC reshape (backend → bindings regen → frontend consumers) because it crosses the wire boundary.
- **Measured, not assumed.** D5's ceiling note is a `//` (not `///`) comment — a doc comment would have drifted `src/lib/bindings.ts` (specta emits doc comments) and failed the bindings-parity test.

**REVIEW-LATER impact:**
- **Top-level open count:** PEND-58d P2+P3 resolved; only the comprehensive e2e suite + the deferred D23a remain (kept listed in `pending/README.md`).
- **Previously resolved:** 1258+ → 1259+ across 810 → 811 sessions.

**Files touched (this session):**
- backend: `src-tauri/src/filters/primitive.rs`, `src-tauri/src/filters/mod.rs`, `src-tauri/src/commands/pages.rs`, `src-tauri/src/commands/tests/list_pages_with_metadata_tests.rs`
- frontend: `src/components/PageBrowser.tsx`, `PageBrowser/PageBrowserHeader.tsx`, `PageBrowser/AddFilterPopover.tsx`, `PageBrowser/PageBrowserFilterRow.tsx`, `src/lib/tauri-mock/handlers.ts`, `src/lib/tauri-mock/seed.ts`, `src/lib/i18n/pages.ts`, `src/lib/bindings.ts` (specta regen), + tests (`__tests__/PageBrowser.test.tsx`, `PageBrowser/__tests__/{PageBrowserHeader,AddFilterPopover,PageBrowserFilterRow,PageBrowserRowRenderer}.test.tsx`, `src/lib/__tests__/tauri-mock.test.ts`)
- e2e: `e2e/pages-filter.spec.ts` (stale fixme removed)
- docs/meta: `AGENTS.md`, `docs/architecture/filters.md`, `docs/PAGES.md`, `pending/PEND-58d-pages-view-hardening.md`, `pending/README.md`

**Verification:**
- `cd src-tauri && cargo nextest run` — 3908 passed, 5 skipped.
- `npx vitest run` — 10497 passed; `npx tsc --noEmit -p tsconfig.app.json` — clean.
- `prek run --all-files` — all hooks pass.

**Process notes:** The comprehensive e2e suite (Session 812) and the user-requested deep multi-perspective review + adversarial verification follow this commit.

**Commit plan:** committed onto `pend-58-phase2-pages-primitives` (PR #48), same-PR convention. Not pushed.
