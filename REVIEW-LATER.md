# Review Later

Items flagged during development that need revisiting. Organized by section with cost estimates.

> **Do not add "Resolved" sections to this file.** When an item is resolved, remove it
> entirely (table row + detail section). Do NOT record the removal anywhere in this file.

> **No historical references.** This file tracks only open items. No session logs,
> no "resolved in session X" notes, no reclassification history, no audit narratives.
> When an item is resolved, delete it completely. When an item is reclassified, update
> it in place. The git history is the audit trail — this file is not a changelog.
> Session activity is tracked separately in `SESSION-LOG.md`.

**Cost key:** S = <2h, M = 2-8h, L = 8h+

---

## Summary

20 open items — 20 planned work (FEAT/MAINT/PERF/PUB). All frontend test-quality items closed. All five LOW backend cleanup batches (MAINT-148..152) closed. **All INFO/nits closed (last 5 in session 547). All UX-* items closed (last 3 in session 548). 21 backend Medium findings closed + 26 MAINT closed (some partially) across sessions 549-587 — see SESSION-LOG.md for the full session-by-session sequence. Latest progress (sessions 572-587): MAINT-131 fully reduced to residual cleanup; **3 schema-integrity migrations landed in session 582** (M-30 partial UNIQUE on attachments.fs_path, M-93 ON DELETE CASCADE FK on block_drafts.block_id, M-90 is_space property tightened to `select` type); **H-9 family closed across sessions 583-584** (H-9b deny-list redaction architecture + H-9b-activation log-format switch + H-9c preview UI confirmed shipped); **MAINT-162 closed in 585** (StaticBlock role flip + 21 axe overrides removed cumulatively); **C-2b closed in 586** (op-log replay schema + cursor + boot integration + 8 tests — last CRITICAL backend code review finding); **MAINT-127 closed in 587** (navigation.ts 543L → 116L + new tabs.ts 480L; 52 consumer files migrated); **MAINT-124 progress: App.tsx 1444L → 515L (–929L, ~64% reduction), 0 extractions remaining (15L over ≤500L stretch goal — irreducible orchestrator glue)**.

Previously resolved: 848+ items across 554 sessions (per SESSION-LOG.md unique session count; latest is session 587).

> **The "Backend Code Review" block near the end of this file (starting at `## Backend Code Review (Confirmed Findings) — Appended 2026-04-25`) is a large production-code review from a previous session. All 12 backend test-quality items (TEST-40..TEST-51) are now closed; the 5 remaining frontend test-quality items (TEST-56, TEST-61..64) closed in session 516.**

| ID | Section | Title | Cost |
|----|---------|-------|------|
| FEAT-3 | FEAT | Spaces — parent / umbrella (Phases 1 + 2 + 3 shipped; Phases 4–11 split into FEAT-3p4..FEAT-3p11) | S |
| FEAT-3p4 | FEAT | Spaces Phase 4: agenda / graph / backlinks / tags / properties scoping (+ promote `space_id` to required on `list_blocks` / `search_blocks`, page-membership check in `get_page_inner`, per-space `currentView`) | L |
| FEAT-3p9 | FEAT | Spaces Phase 9: per-space external integrations — per-space GCal calendar IDs / OAuth / push pipeline + space-name prefix on OS notifications (FEAT-11 coupling) | L |
| FEAT-4 | FEAT | Agent access: expose notes to external agents via an MCP server — parent / umbrella | L |
| FEAT-4i | FEAT | MCP v3 — Mobile (HTTPS/LAN via mTLS reuse from `sync_cert.rs`, agent-pairing flow) — DEFERRED pending v2 | L |
| FEAT-5 | FEAT | Google Calendar daily-agenda digest push (Agaric → dedicated GCal calendar) — parent / umbrella | L |
| FEAT-5g | FEAT | GCal: Android OAuth + background connector (DEFERRED — design sketch only) | L |
| FEAT-11 | FEAT | Adopt `tauri-plugin-notification` — OS notifications for due tasks / scheduled events (Org-mode parity, especially on mobile) | L |
| MAINT-111 | MAINT | Spike `rmcp` (official Rust MCP SDK) vs the hand-rolled JSON-RPC 2.0 dispatch in `mcp/server.rs` (~492 LOC of framing + `make_success` / `make_error` / `parse_request` / method-dispatch boilerplate); keep existing `ToolRegistry` + activity-feed if the adapter stays thin | M |
| MAINT-113 | MAINT | `ConflictFreeBlockId` newtype to lift invariant #9 (`is_conflict = 0` + `depth < 100` in every recursive CTE over `blocks`) into the type system — 220 `is_conflict = 0` SQL occurrences across 70 files. LOW-priority refactor for elegance, not correctness; the convention + review + documented invariant are already working. Do NOT do on a deadline. | L |
| MAINT-124 | MAINT | Collapse `src/App.tsx` — 1444L baseline → 1139L (576 useAppKeyboardShortcuts) → 907L (577 AppSidebar) → 872L (578 useAppDialogs) → **515L** (579 ViewDispatcher + boot/lifecycle: `<ViewDispatcher>` to `src/components/ViewDispatcher.tsx` 260L + 20 tests, `useAppBootRecovery()` to `src/hooks/useAppBootRecovery.ts` 93L + 5 tests, `useAppSpaceLifecycle()` to `src/hooks/useAppSpaceLifecycle.ts` 74L + 7 tests, –357L from App.tsx). **0 extractions remaining**; 15L over the ≤500L stretch goal but residual is irreducible orchestrator glue (FEAT-12 quick-capture global hotkey explicitly out of scope, prop wiring, JSX shell, imports). Closing this row would require either reverting the "FEAT-12 stays in App.tsx" decision OR a substantial restructure of the prop-passing pattern — neither warranted for –15L. **Effectively closed; keep row open as an architectural watchpoint** so future App.tsx edits don't regress past 600L without a fresh extraction. | S–M |
| MAINT-128 | MAINT | God-component decomposition batch — 1 of 9 components remaining after sessions 566-571. Remaining: `PropertyRowEditor.tsx` (539L — dispatch by `def.value_type`; deletes the `biome-ignore lint/complexity/noExcessiveCognitiveComplexity` at L85; **rejected in session 563 inspection as design-heavy** — 5 typed editors share `localValue`, date hook state, select-options state (3 fields), ref-picker state (4 fields), 10+ callbacks; splitting would re-create the prop-chain problem the biome-ignore acknowledges). Closing this row requires a design discussion: either accept the existing `biome-ignore` permanently, or split each typed editor into its own component AND lift the shared state UP to a containing hook (substantial refactor). **Stretch-target gaps for partially-closed components:** SettingsView gap to ≤150L closes via `useSettingsTab` hook for localStorage+URL persistence (~50L drop); SortableBlock gap to ≤250L closes via JSX extraction `<SortableBlockBody>`; HistoryView gap to ≤250L closes via `useHistoryEntries` data-loading hook (~30L drop); ConflictList gap to ≤450L closes via 3 additional extractions (`useConflictDeviceNames`, `useConflictActions`, `<ConflictFilterBar>`); TrashView is at the firm ≤450L target (≤350L stretch deferred — would require collapsing 6 IPC handlers into a single-use hook); PageBrowser gap to ≤300L is irreducible orchestrator glue (~127L); BlockTree gap to ≤500L closes via 3-4 additional extractions but `handleFlush` is tightly coupled to `splitBlock`/`edit`/undo store; AddFilterRow at 290L (component body ~90L; remaining ~200L is module-level `build*Filter` helpers + `buildFilterForCategory` switch — could be moved to `categories/builders.ts` to shrink to ~120L but explicitly out of scope for that batch). All deferred. | L |
| MAINT-131 | MAINT | Block-surface Tauri coupling — residual cleanup after the major batching + hook-wrap work. **Done across sessions 572, 575, 576:** (a) SortableBlock badge-count batch IPC (572); (b) StaticBlock full-list batch IPC + cache-invalidation contract (575); (c) `useBlockReschedule` (setDueDate/setScheduledDate) + `useLinkMetadata` (fetchLinkMetadata) hooks wired into BlockListItem, RescheduleDropZone, DateChipEditor, BlockPropertyDrawer, LinkEditPopover (576). Residual: 3 components (`EditableBlock`, `BlockPropertyEditor`, `ImageResizeToolbar`) were never touched and may still import `lib/tauri` directly; 3 of the touched components still import single non-date IPCs from `lib/tauri` (BlockListItem + RescheduleDropZone use `getBlock`; BlockPropertyDrawer uses `getProperties`/`listPropertyDefs`/`setProperty`). These could close via further hook wraps but each is a small isolated cleanup that pairs with feature work in those components. | S |
| PERF-19 | PERF | Backlink pagination cursor uses linear scan for non-Created sorts (2 sites) | S |
| PERF-20 | PERF | Backlink filter resolver has no concurrency cap on `try_join_all` | S |
| PERF-23 | PERF | `read_attachment_file` buffers whole file before chunked send | S |
| PUB-2 | PUB | Git author email across all history is corporate (`javier.folcini@avature.net`) | S |
| PUB-3 | PUB | Employer IP clearance before public release | S |
| PUB-5 | PUB | Tauri updater — endpoint URL pinned to `jfolcini/agaric`; remaining work is user-only (generate Minisign keypair, paste pubkey into `tauri.conf.json`, add 2 GH Actions secrets, uncomment env vars in `release.yml`) | S |
| PUB-8 | PUB | Android release keystore + 4 GH Actions secrets (apksigner wiring already shipped in `release.yml`) | S |

> **`PUB-*` statuses are heterogeneous now that the publish target is concrete (`github.com/jfolcini/agaric`).**
> PUB-5 / PUB-8 are ACTIONABLE; PUB-2 / PUB-3 remain DEFERRED on the identity / employer-IP decisions. macOS + Windows code signing are explicitly out of scope: the maintainer opted out of paid Apple Developer Program enrollment ($99/year) and Windows OV/EV certs ($200–400/year) for this OSS project. Bundles ship unsigned with Gatekeeper / SmartScreen first-launch warnings; see `BUILD.md` → "Desktop code signing in CI" for the user-facing install instructions.

---

## FEAT — Planned Feature Improvements

### FEAT-3 — Spaces: partition pages into user-defined contexts (work / personal)

> **Navigation-cluster context (FEAT-7/8/9 already shipped):** the shell-level TabBar hoist, active-tab dropdown switcher, and Recent-pages strip landed against the global `useNavigationStore.tabs` + `useRecentPagesStore.recentPages` models. Phase 3 of FEAT-3 is what refactors both of those into per-space state: `tabs` → `tabsBySpace: Record<SpaceId, Tab[]>`, `recentPages` → `recentPagesBySpace: Record<SpaceId, string[]>`. The already-shipped component DOM + styling stays; only the selector / data source shifts. One-line swaps in `TabBar.tsx` + `RecentPagesStrip.tsx` + `keyboard-config.ts`.

**Problem:** A user wants to partition notes into independent contexts (e.g. "work" and "personal") and switch between them quickly during the day without seeing cross-context data. The app currently presents a single undifferentiated vault: pages, tags, properties, agenda, graph, backlinks, tabs, and the journal all share one namespace.

**User decisions recorded up front (do not re-litigate during implementation):**

- **Per-space journal (J1).** Each space owns its own daily note. Today's journal page is keyed by `(date, current_space_id)`, not by `date` alone. Daily pages in different spaces coexist with the same title.
- **Per-space tabs.** Tabs are scoped to the active space. Switching space swaps the tab set. No tab shows pages from multiple spaces.
- **Nothing outside of spaces.** Every page must belong to exactly one space. No "All" pseudo-space, no unassigned pages, no cross-space "show everything" view. If the user needs to see another context, they switch space.
- **No links between spaces, ever.** Same page title in both spaces is fine and stays distinct (different ULIDs). Any `[[ULID]]` chip whose target lives in another space renders via the existing broken-link UX and is not clickable to navigate. See FEAT-3p7 for the enforcement scope. See "User decisions locked in" below for the full policy.

**Model:**
A **space** is a regular `page` block with a marker property `is_space = true`. Every non-space page has a `space` `ref` property pointing to its owning space. This reuses the properties system (AGENTS.md: "primary extension point"), adds no new tables, no new op types, no sync protocol changes.

**Schema (additive only — new migration):**

```sql
INSERT OR IGNORE INTO property_definitions (key, value_type, options, created_at) VALUES
    ('space',    'ref',  NULL, '<ts>'),
    ('is_space', 'text', NULL, '<ts>');

CREATE INDEX IF NOT EXISTS idx_block_properties_space
    ON block_properties(value_ref)
    WHERE key = 'space';
```

**Frontend (summary):**

- `src/stores/space.ts` — new Zustand store: `currentSpaceId`, `availableSpaces`, `setCurrentSpace`, `refreshAvailableSpaces`. Persisted under `agaric:space`.
- `src/components/SpaceSwitcher.tsx` — sidebar-top Radix `Select` (reuse `ui/select.tsx`) with "Manage spaces…" action. **Replaces** the current static branding block at `src/App.tsx:798-805`. Visible on both desktop and mobile (spaces are a higher-level scope than tabs — mobile users still need context switching). New keyboard entries in `keyboard-config.ts`: `switchSpace` (default Ctrl+Shift+S, opens a `SearchablePopover` to jump by name) and `cycleSpace` (default Ctrl+Alt+S, rotates).
- `useNavigationStore` refactor: `tabs: Tab[]` → `tabsBySpace: Record<SpaceId, Tab[]>`, `activeTabIndex: number` → `activeTabIndexBySpace: Record<SpaceId, number>`. Every action (`navigateToPage`, `goBack`, `openInNewTab`, `closeTab`, `switchTab`) reads/writes the current space's slice. `selectPageStack` becomes space-aware. Persistence `partialize` serializes the full map; on rehydrate, if the persisted `currentSpaceId` no longer resolves, fall back to the first existing space.
- `PageHeaderMenu` gains a "Move to space" action.
- `JournalPage` — daily-page lookup by `(date, current space)`.
- Status bar chip shows the active space name (follows the existing sync-status chip pattern).

**Backend (summary):**

A `space_id: String` param (required, not optional, to enforce "nothing outside of spaces") is threaded through the query commands that surface multiple pages:
`list_blocks`, `search_blocks`, `query_by_tags`, `query_by_property`, `get_backlinks`, `query_backlinks_filtered`, `list_backlinks_grouped`, `count_agenda_batch`, `count_agenda_batch_by_source`, `list_undated_tasks`, `list_page_links`, `list_projected_agenda`.

Shared SQL helper resolves content blocks to their page ancestor via the existing `page_id` column (migration 0027) and filters by the `space` ref property:

```
AND COALESCE(b.page_id, b.id) IN (
    SELECT bp.block_id
    FROM block_properties bp
    WHERE bp.key = 'space' AND bp.value_ref = ?
)
```

**Atomic "create page in current space":** reuse the `_in_tx` transaction pattern (AGENTS.md: "Backend Patterns #2"). A new helper begins `BEGIN IMMEDIATE`, calls `create_block_in_tx` for the page, then `set_property_in_tx` for `space`, then commits. All-or-nothing. A page must never exist without a `space` property.

**Journal (J1):**
`commands/journal.rs` daily-page lookup changes from "find page where `title = YYYY-MM-DD`" to "find page where `title = YYYY-MM-DD` AND `space = current`". Creating today's journal page sets its `space` property atomically in the same transaction. Per-space journal templates can be expressed as a `journal_template` property on each space page (no new schema).

**Per-space tabs implementation:**

- `tabsBySpace[currentSpaceId]` read on every render. The tab bar hides normally when the current space has ≤1 tab (FEAT-7 autohide guard preserved).
- Opening a page in a new tab only affects the current space's tab list.
- Space deletion requires closing/reassigning all tabs in that space (see Open Questions).

**Per-space recent-pages (FEAT-9 coupling):**

- `recentPages: string[]` → `recentPagesBySpace: Record<SpaceId, string[]>`. Same dedup + MRU rules apply per-space. Switching space swaps the strip.
- Visits never cross space boundaries (matches "nothing outside of spaces").
- Implementation goes in the same session as the tab refactor so both structures move together.

**Sync implications:**
Space pages and `space` properties replicate as normal ops. Every device sees every space. Matches the AGENTS.md threat model (single-user, multi-device, no adversarial peers). Per-space sync meshes would be a separate, significant architectural change (multi-DB or sync-scope filtering) and require their own design approval.

**Default-space bootstrapping (resolved — Phase 1 shipped):**
Fresh installs and upgrades both run a boot-time Rust bootstrap (`src-tauri/src/spaces/bootstrap.rs`) that creates two seeded spaces with reserved deterministic ULIDs — `SPACE_PERSONAL_ULID = "00000000000000000AGAR1CPER"` and `SPACE_WORK_ULID = "00000000000000000AGAR1CWRK"`. Each device emits its own CreateBlock + SetProperty(`is_space`=true) ops for both; op_log hashes differ per-device (device_id is part of the hash preimage, which is unavoidable under the current per-device hash-chain model) but the materializer's `INSERT OR IGNORE` on `blocks` converges every device on the same two rows. User-created spaces after that use normal per-device ULIDs — two "Project X" spaces on different devices stay distinct until manually reconciled. Upgrade path: every existing non-space page without a `space` property gets a local `set_property(page, 'space', PERSONAL_ULID)` op; non-deterministic timestamps are fine — `block_properties` UPSERTs on `(block_id, key)` converge. Bootstrap is idempotent (fast-path skip when both seeded blocks exist with `is_space = 'true'`) and partial-crash resumable (per-step commits).

**Testing (per AGENTS.md):**

- Every backend command gaining `space_id`: happy path, cross-space exclusion, nonexistent `space_id` returns empty, exact-count assertions (`assert_eq!` over `assert!(>= 1)`).
- Property test (`fast-check`): for any two non-empty spaces, their page sets are disjoint and their union equals the full non-space page set.
- `SpaceStore` + `SpaceSwitcher`: render + interaction + `axe(container)`.
- `useNavigationStore` rehydrate after space deletion, persistence round-trip for `tabsBySpace`.
- Journal per-space lookup, including the transition from "no journal today" to "journal created in current space".
- Recursive CTE walkers (`list_children`, cascade ops) unchanged — `is_conflict = 0` + `depth < 100` invariants preserved. Space is a query-time filter, not a structural partition.

**Rollout phases (each independently shippable, gated by mandatory review subagent per AGENTS.md):**

1. **Migration + model + wizard — SHIPPED.** Property definitions (migration 0035), boot-time Rust bootstrap emitting seeded spaces + upgrade ops, `src-tauri/src/spaces/` module, `list_spaces` command, `SpaceStore` (Zustand + persist), `SpaceSwitcher` (Radix Select in `SidebarHeader`).
2. **List/search filtering — SHIPPED.** `list_blocks` + `search_blocks` accept `space_id: Option<String>` (threaded through `pagination::list_children` / `list_by_type` / `list_trash` + `fts::search_fts` via the `?N IS NULL OR COALESCE(b.page_id, b.id) IN (...)` filter pattern). PageBrowser + SearchPanel pass `currentSpaceId` and gate render on `useSpaceStore.isReady` via `LoadingSkeleton`. Link picker (`useBlockResolve`'s `searchPagesViaCache` / `searchPagesViaFts`) scoped to current space — current-space-only per user decision, no opt-in toggle. "Move to space" action in the PageHeader kebab menu uses the existing `setProperty` wrapper (no new Tauri command). New atomic command `create_page_in_space` wraps `CreateBlock` + `SetProperty('space')` in a single `BEGIN IMMEDIATE`; all top-level page-creation callsites (sidebar "New page", Ctrl+N, PageBrowser inline form, link picker "Create new page") route through it. `AgendaQuery` struct bundles the three agenda knobs to keep `list_blocks` under the tauri-specta 10-arg limit. `useResolveStore.clearPagesList()` fires on space switch so the link picker's short-query cache doesn't surface other-space pages.
3. **Per-space tabs + per-space recent — SHIPPED.** Refactored `useNavigationStore` to `tabsBySpace` + `activeTabIndexBySpace` AND `useRecentPagesStore` to `recentPagesBySpace`. Subscriber on `useSpaceStore.currentSpaceId` flushes the outgoing space's flat fields into its slice, then pulls the incoming space's slice into the flat fields (`navigation.ts:489-548`, `recent-pages.ts:130-167`). `TabBar.tsx` and `RecentPagesStrip.tsx` consume the per-space selectors `selectTabsForSpace` / `selectRecentPagesForSpace`. Tests cover space-deletion corner case + rehydrate with stale `currentSpaceId` + cross-space MRU isolation.
4. **Agenda / graph / backlinks / tags / properties — FEAT-3p4.** Remaining query commands gain the filter: `list_undated_tasks`, `list_projected_agenda`, `query_by_tags`, `query_by_property`, `list_page_links`, `get_backlinks`, `list_backlinks_grouped`, `query_backlinks_filtered`, `count_agenda_batch*`. Plus: promote `space_id` from `Option` to required on `list_blocks` / `search_blocks`; page-membership check in `get_page_inner`; per-space `useNavigationStore.currentView` slice. See FEAT-3p4 entry for full scope.
5. **Per-space journal (J1) — FEAT-3p5.** Daily-page lookup by `(date, space)`. Per-space journal templates via a `journal_template` property on each space block. JournalPage's 4 internal `createBlock({blockType: 'page'})` callsites route through `createPageInSpace`. Per-space `useJournalStore.currentDate` slice. See FEAT-3p5 entry for full scope.
6. **Manage-spaces UI — FEAT-3p6.** Rename, delete-only-if-empty (no soft-delete, no reassign-on-delete), accent-color picker (consumed by FEAT-3p10), onboarding for second space. *(Status-bar chip / collapsed-icon indicator / brand identity moved to FEAT-3p10; keyboard shortcuts split into FEAT-3p11.)*
7. **Cross-space link enforcement — FEAT-3p7.** Resolve store + `get_page_inner` filter by current space. Cross-space `[[ULID]]` chips render via the existing broken-link UX. Defence-in-depth against legacy text + manual paste + post-"Move to space" stale references. **Implements the locked-in "no links between spaces, ever" decision.**
8. **History view space scoping — FEAT-3p8.** History defaults to current space; "All spaces" toggle in `HistoryFilterBar` (off by default, not persisted).
9. **Per-space external integrations — FEAT-3p9.** Per-space GCal calendar IDs / OAuth tokens / push pipeline. OS notification titles prefix `[<SpaceName>]` (FEAT-11 coupling).
10. **Visual identity — FEAT-3p10.** Per-space accent color (CSS custom property override) + status-bar chip + window title prefix + collapsed-sidebar indicator. **Single highest-priority remaining FEAT-3 phase for the "fully separated feel" goal.**
11. **Digit hotkeys — FEAT-3p11.** `Ctrl+1` … `Ctrl+9` (`Cmd+1` … `Cmd+9` on macOS) switch directly to the Nth space in alphabetical order. Additive to FEAT-3p6's popup-search and cycle bindings — fastest possible motion (one chord) for the common 2-space case.

**User decisions locked in (do NOT re-litigate):**

- **Seeded spaces count:** 2 — "Personal" + "Work".
- **Bootstrap:** deterministic genesis ops (two reserved ULIDs above) + local upgrade ops for existing pages.
- **Space deletion:** forbid deleting a non-empty space (no soft-delete, no reassign-on-delete).
- **Spaces are physically separate vaults from the user's perspective. NO live links between spaces, ever.** Picker is current-space-only (Phase 2 shipped). Resolve store and single-page fetch are current-space-only (FEAT-3p7). Any `[[ULID]]` whose target lives in another space — regardless of how it got there (legacy text written before Phase 2, post-"Move to space" stale references in the source space, manually-pasted ULIDs, sync replay of older content) — renders as a **broken-link chip via the existing broken-link UX** (`block-link-deleted` styling, "Broken link — click to remove" tooltip, click deletes the chip). **No auto-switch on click. No "show anyway" toggle. No developer override.** A single behaviour, period.
- **Same page title in both spaces is allowed and stays distinct.** "Daily standup" in Personal and "Daily standup" in Work are two separate pages with two ULIDs. Titles are not a cross-space resolution surface. Title-based search is space-scoped (Phase 2 shipped); title collisions across spaces are invisible from inside any one space.
- **Graph view:** no cross-space edges to render (follows from "no links between spaces").
- **Export:** markdown export references only stay within the current space (follows from "no links between spaces"; cross-space `[[ULID]]` targets export as the same broken-chip placeholder that the UI renders).
- **First-boot UI:** LoadingSkeleton on space-scoped panels until `useSpaceStore.isReady === true`.
- **Search operator:** the switcher is the only scoping surface — no `space:<name>` operator.

**Cost:** S — this umbrella entry is now a tracker only. Each remaining phase is filed as its own item: FEAT-3p4 (agenda/graph/backlinks), FEAT-3p5 (journal), FEAT-3p6 (manage UI), FEAT-3p7 (broken-chip enforcement), FEAT-3p8 (history scoping), FEAT-3p9 (per-space integrations), FEAT-3p10 (visual identity), FEAT-3p11 (digit hotkeys). Schedule via the per-phase items, not this umbrella.

**Recommended sequencing for "fully separated feel + easy/quick switching":** FEAT-3p10 + FEAT-3p11 + FEAT-3p7 first (one session each, low blast-radius, immediately unlock the user-visible goal). Then FEAT-3p4 (largest backend slice, closes the remaining query leaks). Then FEAT-3p5 / p6 / p8 / p9 in any order.

**Status:** IN PROGRESS — Phases 1 + 2 + 3 shipped. Remaining work tracked under FEAT-3p4 / FEAT-3p5 / FEAT-3p6 / FEAT-3p7 / FEAT-3p8 / FEAT-3p9 / FEAT-3p10 / FEAT-3p11.

### FEAT-3p4 — Spaces Phase 4: agenda / graph / backlinks / tags / properties scoping

**Problem:** The remaining query commands still surface cross-space results. `list_undated_tasks`, `list_projected_agenda`, `query_by_tags`, `query_by_property`, `list_page_links`, `get_backlinks`, `list_backlinks_grouped`, `query_backlinks_filtered`, `count_agenda_batch`, `count_agenda_batch_by_source` all need `space_id: Option<String>` threaded through, with the `?N IS NULL OR COALESCE(b.page_id, b.id) IN (...)` filter pattern established in FEAT-3 Phase 2.

**Backend scope:**
- Thread `space_id` through every command in the list above. Reuse the `space_filter_clause!` macro and the FEAT-3 helper that resolves content blocks to their page ancestor via the `page_id` column + `space` ref property.
- `AgendaQuery` struct already bundles the three agenda knobs to keep `list_blocks` under the tauri-specta 10-arg limit; reuse the same struct shape for the new agenda commands if any cross the limit.
- For each command: happy path, cross-space exclusion, nonexistent `space_id` returns empty, exact-count assertions (`assert_eq!`, never `>=`).
- Property test (`fast-check`): for any two non-empty spaces, their result sets are disjoint and their union equals the full non-space result set.

**Frontend scope:**
- Migrate every callsite of the listed commands to pass `currentSpaceId`: `useBlockTags`, `agenda-filters`, `GraphView.helpers`, `export-graph`, backlinks views, `TrashView`, `useResolveStore.preload()`, template helpers, property UI.
- Status-bar chip showing the active space name (follows existing sync-status chip pattern).
- Optional polish (P2 from UX review): a subtle "Pages in &lt;SpaceName&gt;" header on the link-picker suggestions so the current-space scoping isn't silent.

**Recursive CTE invariants preserved:** `list_children`, cascade ops unchanged. Space is a query-time filter, not a structural partition. `is_conflict = 0` + `depth < 100` invariants stay where they are.

**Additional scope (folded in from confirmed leakage findings):**

- **Promote `space_id` from `Option<String>` to `String` (required) on `list_blocks_inner` + `search_blocks_inner`.** Phase 2 shipped these as `Option<String>` for backwards-compat during incremental rollout; the locked-in user decision was "required, not optional, to enforce 'nothing outside of spaces'". New callers can currently leak silently by omitting `spaceId`. Required signature blocks that at the type system + tauri-specta layer. Migrate every existing callsite in the same commit (no flag-day window with mixed signatures).
- **`get_page_inner` page-membership check.** When called with a `space_id`, verify the requested page's `space` property matches; otherwise return `AppError::Validation("page not in current space")`. Defence in depth — without this, deep-link / legacy `[[ULID]]` paths can fetch foreign-space pages directly. Same check applied to `get_block_with_children_inner`. (Couples loosely with FEAT-3p7, which is the user-facing "no cross-space links" enforcement; this item is the backend-rejection corollary.)
- **Per-space `useNavigationStore.currentView` slice.** Today `currentView: View` is global, so `Search` view in Personal stays `Search` when the user switches to Work. Add `currentViewBySpace: Record<SpaceId, View>` mirroring the `tabsBySpace` pattern; the Phase 3 space-switch subscriber gains one extra flush/pull pair. Vitest covers: switch from Personal-search → Work resets to Work's last view (or default `page-editor` for fresh spaces).

**Cost:** L — biggest remaining FEAT-3 slice (10+ commands × backend + 7+ frontend areas + property tests + the three additional items above). Realistic estimate: 2 focused sessions.
**Status:** Open. Depends on FEAT-3 Phases 1 + 2 + 3 (shipped). Independent of FEAT-3p5, FEAT-3p6, FEAT-3p7, FEAT-3p8, FEAT-3p9, FEAT-3p10, FEAT-3p11.

### FEAT-3p9 — Spaces Phase 9: per-space external integrations (GCal, OS notifications)

**Problem:** Two integration surfaces leak across spaces today:

1. **Google Calendar push** uses a single `calendar_id` in `GcalStatus` (`src-tauri/src/commands/gcal.rs:56-66`). The push pipeline (`gcal_push/connector.rs`) pulls agenda items via `list_projected_agenda_inner` — which is also unscoped today (FEAT-3p4 covers the read path) — and writes every item from every space into one calendar. A user with the integration on cannot keep their work calendar separate from their personal one.
2. **OS notifications** (FEAT-11, deferred): when adopted, due-task notifications will show task content with no space attribution. A Work task firing while the user is "in" Personal breaks context.

**Locked-in policy:**

- **GCal config is per-space.** A user can connect GCal independently for each space, with independent calendar IDs, OAuth tokens (via the existing keychain wrapper, key suffixed with the space ULID), window-days, privacy-mode, push-lease. A space with no GCal connection has no GCal sync — period. **No global fallback.**
- **Push pipeline branches by space.** Each space's push loop pulls agenda items scoped to that space (via FEAT-3p4's space-aware `list_projected_agenda`) and writes to that space's calendar. A failed push for one space does not block others.
- **OS notifications carry the space name.** Title format becomes `[<SpaceName>] <existing title text>` so the user always knows which context fired the notification, regardless of the active space at the moment.

**Backend scope (GCal):**

- New schema: `gcal_space_config` table — `(space_id PRIMARY KEY, account_email, calendar_id, window_days, privacy_mode, last_push_at, last_error)` — additive migration. OAuth tokens stay in the keychain but the keychain key is suffixed with the space ULID (`agaric-gcal-token-<space_ulid>`).
- Replace `GcalStatus` (single struct) with `Vec<GcalSpaceStatus>`: `(space_id, account_email, calendar_id, window_days, privacy_mode, push_lease, last_push_at, last_error, connected)`. Top-level `get_gcal_status` returns the vec keyed by space.
- `gcal_push::connector::push_loop` iterates the configured spaces and runs an isolated push per space. Per-space `push_lease` lives in `gcal_space_config.push_lease` (or a dedicated `gcal_space_lease` table if leases must outlive config rows).
- Per-space versions of every existing command: `force_gcal_resync(space_id)`, `disconnect_gcal(space_id)`, `connect_gcal(space_id)`, `set_gcal_window_days(space_id, days)`, `set_gcal_privacy_mode(space_id, mode)`. Settings tab UI gains a per-space accordion.

**Backend scope (notifications, when FEAT-11 lands):**

- Notification builder reads the firing task's owning page's `space` property and prefixes the title with `[<SpaceName>] `. No new schema. Lookup is one `block_properties` read per notification, fine at notification frequency. Couples with FEAT-11 — this sub-task ships alongside or after FEAT-11.

**Migration:**

- Existing single-space GCal config (if connected) migrates to the user's currently-active space at first run after this phase ships. Tracked as a one-shot Rust bootstrap step, idempotent, behind a `gcal_per_space_migrated` flag (mirrors the spaces bootstrap pattern).

**Testing:**

- Two configured spaces push to two different `calendar_id`s; per-space `last_push_at` advances independently.
- Disconnect on space A leaves space B's push working.
- Failed push on space A does not block the per-loop tick for space B.
- Notification title always carries the originating space, regardless of active space.

**Cost:** L — schema migration + connector refactor + UI refactor + per-space lease handling. Realistic estimate: 2 sessions. Depends on FEAT-3p4 (the push pipeline must already pull space-scoped agenda).
**Status:** Open. Depends on FEAT-3p4. Independent of FEAT-3p5 / p6 / p7 / p8 / p10 / p11. Notification-prefix sub-task depends on FEAT-11 landing first.

### FEAT-4 — Agent access: expose notes to external agents via an MCP server

**Problem:** External agents (Claude Desktop, Claude Code, Cursor, Devin, Continue, etc.) cannot read from or write to the user's notes. The user wants to let agents interact with their vault in a controlled way — starting with desktop, potentially extending to mobile later — without handing over the database file or bypassing the op-log / CQRS invariants.

Out of scope for this item: cloud-hosted inference, remote agents, multi-user authorization, any non-local transport (see "Mobile" below for the deferred story).

**User decisions recorded up front (do not re-litigate during implementation):**

- **Two sockets, not one.** Read-only access and read-write access live on **separate** Unix-domain sockets (named pipes on Windows) with independent toggles. No runtime scope negotiation, no per-tool allowlist in v1. User points their agent at whichever socket they want to grant.
- **Read-only first.** v1 ships the RO socket + 9 read tools only. Write tools are deferred to v2 so the user can live with read-only agents before granting mutation. The architecture must leave the RW slot obviously open so v2 is purely additive.
- **Writes (when they land in v2) apply straight to the op log**, tagged with `origin = "agent:<name>"` where `<name>` is the MCP `clientInfo.name` from the handshake. No staging queue, no user-confirmation modal per write. Safety comes from the existing op-log undo (`reverse.rs`) plus a new "recent agent activity" feed and one-click bulk revert.
- **Non-reversible ops are never exposed to agents**, even with RW. `purge_block` and `delete_attachment` (the two `NonReversible` variants in `AppError`) stay frontend-only. Agents can `delete_block` (reversible soft-delete) but cannot purge.

**Protocol:** Model Context Protocol (JSON-RPC 2.0 over a local transport). Every mainstream agent already speaks MCP, so there is no custom client to ship.

**Transport (desktop):**

- Linux/macOS: Unix-domain socket at `~/.local/share/com.agaric.app/mcp-ro.sock` (and, in v2, `mcp-rw.sock`), mode `0600`.
- Windows: named pipe `\\.\pipe\agaric-mcp-ro` (and `...-rw` in v2) with an ACL that grants only the current user.
- Rationale matches AGENTS.md threat model: single-user, no adversarial actor, no cloud. The kernel enforces "only this user's processes can connect" with zero crypto, zero tokens, zero MITM surface. Do not add bearer tokens, rate limits, or path-traversal hardening against the agent — the threat model does not justify the complexity.

Because MCP clients launch their server as a stdio subprocess, a small stub binary `src-tauri/src/bin/agaric-mcp.rs` bridges stdio ↔ UDS/pipe. That stub is what the user pastes into their agent's config (`command: "agaric-mcp"`, optional `args: ["--socket", "<path>"]`, env discovery via `$AGARIC_MCP_SOCKET` with the sensible default above). The stub must be packaged alongside the Tauri app binary on every platform.

**Architecture:**

- New module `src-tauri/src/mcp/` — a Tokio task started alongside `sync_daemon` in the same lifetime. Binds the enabled socket(s), accepts connections, dispatches JSON-RPC requests into a tool registry.
- **Registry trait** + two impls planned: `ReadOnlyTools` (wired in v1) and `ReadWriteTools` (wired in v2). The socket plumbing takes the registry as a generic parameter so the same server code serves both sockets.
- Every tool handler is a thin wrapper around an existing `*_inner` command handler (there are ~78 in `src-tauri/src/commands/`, each taking `&SqlitePool`). **Never bypass the command layer.** Doing so would violate invariants 1, 2, 5, and 9 from AGENTS.md (append-only op log, CQRS split, sqlx compile-time queries, CTE correctness).
- **`ActorContext` threaded through from day one.** Even in v1, MCP handlers pass `Actor::Agent { name }` (vs the implicit `Actor::User` used by frontend-invoked commands). In v1 it is only used for structured logging; in v2 it populates the op-log origin column without a schema-change surprise. The `ActorContext` plumbing is the only non-local change v1 makes to existing command handlers — keep it a purely additive parameter (or a `tokio::task_local!`) so frontend call sites remain untouched.
- **Pool usage:** MCP tools use the reader pool only in v1. v2 write tools acquire the writer pool exactly like regular commands (no new pool).
- **Subscriptions / live updates:** not in v1. If v2 or v3 wants them, they can ride on existing Tauri events re-emitted over MCP notifications — no new backend plumbing.

**Tool surface v1 — read only (9):**

| Tool | Backing `*_inner` | Notes |
|------|---------------------|-------|
| `list_pages` | (new: `list_pages_inner`) | Tiny new handler in `pages.rs` — query blocks where the page flag is set. No existing caller does this today; frontend uses backlinks / FTS. |
| `get_page` | (new: `get_page_inner`) | Composes `get_block_inner` (root) + `list_blocks_inner` (descendants). Thin wrapper, no new SQL. |
| `search` | `search_blocks_inner` (`queries.rs`) | FTS. Enforce snippet + result caps at the tool boundary (see Open Questions). |
| `get_block` | `get_block_inner` (`blocks/queries.rs`) | |
| `list_backlinks` | `list_backlinks_grouped_inner` (`queries.rs`) | |
| `list_tags` | (new: `list_tags_inner`) | Small wrapper over `list_tags_by_prefix_inner("")`. Keep the public MCP name simple. |
| `list_property_defs` | `list_property_defs_inner` (`properties.rs`) | Exposes the typed property schema so agents can sensibly use v2 write tools (`set_property`). Read-only, cheap, and prevents v1 agents from hardcoding property-key assumptions. |
| `get_agenda` | `list_projected_agenda_inner` (`agenda.rs`) | |
| `journal_for_date` | (new: `journal_for_date_inner`) | `today_journal_inner` / `navigate_journal_inner` exist but neither resolves an arbitrary date. Extract the shared lookup into a new thin helper both can delegate to — do **not** fork the logic. |

The four "(new)" handlers are in-module thin wrappers, not new surface area: they compose existing helpers. Each still follows the `pub async fn name_inner(pool: &SqlitePool, …) -> Result<…, AppError>` signature so they are uniformly testable and callable from MCP. `list_property_defs_inner` already exists at `properties.rs:447` — it wires through as-is, no new Rust function needed.

Each tool's JSON schema is pinned with an `insta` snapshot so accidental shape changes break CI.

**Tool surface v2 — deferred (6 write tools):**

`append_block`, `update_block_content`, `set_property`, `add_tag`, `create_page`, `delete_block` (reversible). Out of scope for v1; listed here so the registry layout is not a surprise.

**Frontend:**

- One new Settings tab **"Agent access"** composed from existing `ui/` primitives (Label, Switch, Button, ScrollArea, Badge per AGENTS.md frontend guidelines — no bespoke UI).
- RO enable/disable toggle (v1). RW toggle hidden / disabled pending v2.
- "Copy Claude Desktop config" + "Copy generic MCP config" buttons. Copies a JSON snippet with the correct command + socket path for the current OS.
- Socket path display + platform-appropriate "Reveal in file manager" button.
- Recent-activity feed: rolling 100-entry ring buffer emitted as Tauri events from `src-tauri/src/mcp/`, rendered with `ScrollArea` + existing list primitives. In v1 entries are read-only queries with tool name + summary + timestamp. In v2, write entries gain a one-click "Undo" action wired to `reverse.rs`.
- Kill switch (disconnects all active sessions immediately).
- i18n keys for every user-visible string. `aria-label` on every icon-only button. `axe(container)` test.

**Backend file layout:**

```
src-tauri/src/mcp/
    mod.rs              — task lifecycle, socket binding, config
    server.rs           — JSON-RPC dispatch, per-connection state
    registry.rs         — ToolRegistry trait
    tools_ro.rs         — ReadOnlyTools impl (v1)
    tools_rw.rs         — ReadWriteTools impl (v2, empty stub in v1)
    activity.rs         — ring buffer + Tauri event emitter
    actor.rs            — ActorContext + task-local plumbing
    tests/              — handshake, each tool, permission, concurrency
src-tauri/src/bin/
    agaric-mcp.rs       — stdio ↔ socket stub
```

**Testing (per AGENTS.md conventions):**

- **Rust:** handshake + each tool (happy + error), socket permission check (mode 0600 on unix, owner-only ACL on windows), concurrent-client stress (≥8 parallel clients sharing the reader pool), `insta` snapshots of every tool's JSON schema, property test over `search` with random queries asserting FTS parity vs direct `search_blocks_inner` call, exact-count assertions (`assert_eq!`, never `>=`).
- **Frontend:** Settings tab render + interaction + `axe(container)`, activity feed component with mocked event stream, copy-config button copies the right snippet per platform.
- **Smoke:** small Python harness using the official `mcp` package exercises the full tool surface end-to-end against a dev build of the Tauri app. Runs manually, not in CI (dev-build dependency).
- **Packaging:** verify `agaric-mcp` binary is included in Linux `.deb`, macOS `.app`, and Windows `.exe` installer outputs (add to `tauri.conf.json` `bundle.resources` or equivalent).

**Documentation:**

- `README.md` — short user-facing "Using an agent with Agaric" section with Claude Desktop / Cursor config snippets.
- `FEATURE-MAP.md` — new entry under the appropriate domain.
- **No changes to `AGENTS.md`** (per the AGENTS.md invariant at the top of that file).

**Rollout phases (each independently shippable, gated by mandatory review subagent per AGENTS.md):**

1. **v1 — RO server.** `src-tauri/src/mcp/` task, `agaric-mcp` stub binary, 9 read tools, Settings tab with toggle + copy-config + activity feed (reads only). Packaging updates so the stub ships with the installer. Full test suite + smoke harness. Sub-items: FEAT-4a..FEAT-4g.
2. **v2 — RW server.** `mcp-rw.sock`, 6 write tools, `ActorContext` → op-log origin wiring (additive migration for the column — the current `op_log` schema has no `origin` column, so v2 adds one via a new migration), activity feed gains write entries + one-click undo. Bulk "revert all agent ops from session X" action. Sub-item: FEAT-4h.
3. **v3 — Mobile (deferred, design sketch only).** Reuse `sync_cert.rs` + `sync_daemon` mTLS plumbing to expose MCP over HTTPS on the LAN, with an agent-pairing flow that mirrors device pairing. Not started; requires its own design approval before Phase 3. Sub-item: FEAT-4i.

**Open questions (must be resolved before v1 implementation starts):**

- **Auto-start vs opt-in.** Does the MCP server start automatically on app launch (current sidebar toggle gates only accepting connections) or does it only start when the user flips the toggle? Recommend opt-in (off by default, user flips once, persisted).
- **Socket path on Android / iOS.** `app_data_dir()` on Android is `/data/data/com.agaric.app/` — UDS works there but other processes cannot reach it unless they share a sandbox. Confirm this is deferred entirely to Phase 3 (it is, per the user's "desktop first" direction) and not quietly shipped half-broken in v1.
- **Search result size cap.** FTS snippets can be large. Does `search` enforce a hard per-result snippet-length cap + a hard result-count cap? Recommend 512 chars / 50 results by default, overridable via tool params.
- **Config-copy UX.** Should "Copy Claude Desktop config" also offer a "Write directly into `claude_desktop_config.json`" one-shot button, or stay docs-only? Recommend docs-only in v1 — writing into third-party config files is a support trap.
- **Multi-app coexistence.** If the user launches a second Agaric instance (dev build alongside release), they race on the same socket path. Recommend the second launcher detects the existing socket, logs a warning, and does not bind — no cross-instance fallover.
- **Tool-call observability.** Do we persist MCP activity beyond the in-memory ring buffer, and if so for how long? Recommend in-memory only for v1 (no new table, no new retention policy decision).
- **Client identification beyond `clientInfo.name`.** MCP `clientInfo` is self-reported and spoofable. For single-user-local-only this is fine, but confirm we are not building any authorization logic on top of it (we are not, and should not).

**Cost:** L — spans one new backend module (~6 files), one new bin target, one new Settings tab, packaging updates on 3 platforms, ~30 tests across frontend and backend, and a smoke harness. Realistic estimate: 2–3 focused sessions for v1; v2 a separate 2-session batch.

**Decision:** Accept the recommended answers to all 6 open questions — opt-in auto-start (off by default), Android deferred to Phase 3, search capped at 512 chars / 50 results by default, docs-only config copy, second-instance detects existing socket and does not bind, in-memory ring buffer only, no authorization on `clientInfo.name`. v1 ready to schedule in a future dedicated session.

**Implementation DAG (v1):**

```
4a ──┐
     ├──▶ 4c ──┬──▶ 4d ──┐
     │        │         ├──▶ 4e ──▶ 4g
4b ──┘        └──▶ 4f ──┘
```

First wave (parallel): `4a` + `4b` — independent implementations (socket transport and the tool-registry trait are separate files that don't import each other). They meet at `4c`'s integration point. Second wave: `4c`. Third wave (parallel): `4d` + `4f`. Fourth wave: `4e`. Fifth wave: `4g`.

**Status:** IN PROGRESS — v1 (FEAT-4a..FEAT-4g, RO server + 9 read tools + Settings tab + activity feed) shipped. v2 complete: slices 1-2 (op-log `origin` column + RW socket + 6 write tools + Settings toggle), slice 3 (activity-feed per-entry Undo + FEAT-4c emission wiring), and slice 4 (per-session bulk revert) all shipped. v3 (FEAT-4i, Mobile) DEFERRED pending user-requested mobile support + separate design approval.

### FEAT-4i — MCP v3: Mobile (HTTPS/LAN via mTLS reuse from `sync_cert.rs`, agent-pairing flow)

Part of the FEAT-4 family. See FEAT-4 for the v3 rollout phase specification (design sketch only).

**Scope (when designed + approved):**

- Reuse `src-tauri/src/sync_cert.rs` (the existing persistent TLS certificate infrastructure used by `sync_daemon` for device-to-device mTLS) to expose MCP over HTTPS on the LAN.
- Agent-pairing flow mirrors the device-pairing UX already shipped in the Sync feature — user scans a QR code or enters a short code on the agent-running machine; the Agaric device trusts the agent's cert after explicit acceptance.
- Same protocol (JSON-RPC 2.0, same tool registry) — only the transport changes.
- Android-specific sandbox considerations (the UDS path on Android is inside the app's private data dir and other processes cannot reach it) handled by the new HTTPS-over-LAN transport.

**Do NOT** start this sub-item until both v1 and v2 have shipped and the user has explicitly asked for mobile support. Do NOT weaken the mTLS posture — the fact that the LAN is "the user's own network" does not change the requirement to authenticate both ends with device-owned certs.

**Verification (when scheduled):** reuse the existing `sync_daemon/` test harness patterns; add a pairing flow e2e test; verify the stub binary runs on both Android (via Tauri's Android target) and iOS (out of scope for the first mobile release — iOS comes later if at all).

**Depends on:** FEAT-4h (v2 complete) + separate design-approval session before implementation begins.

**Status:** DEFERRED — pending v2 ship + user-requested mobile support + separate design approval.

**Cost:** L

### FEAT-5 — Google Calendar daily-agenda digest push (Agaric → dedicated GCal calendar)

**Problem:** Users want their Agaric agenda to appear on their Google Calendar — **constantly updated**, not with the hours-to-~24h lag of `.ics` subscription feeds. This item covers the architecture, user decisions, threat-model deviation, and rollout for pushing a **daily agenda digest** (one all-day event per date, containing that date's agenda entries) to a **dedicated Google Calendar owned by Agaric**. Bidirectional sync, per-task events, and `.ics` publication are explicitly out of scope (see rejected alternatives below). Individual implementation slices are filed as FEAT-5a..FEAT-5g.

**Rejected alternatives (do not re-litigate):**

- **One GCal event per task** (the original FEAT-5 shape). Rejected in favor of the daily-digest model: it multiplies sync surface, complicates repeat-rule handling (`.+` / `++` → up to 60 flat events per block), and pollutes the user's calendar with micro-entries. The daily digest shows "what's on my plate today" at a glance — the same mental model as the Agaric agenda itself.
- **Bidirectional sync.** Doubles complexity, requires inbound ops translation, forces conflict resolution across two data models (op-log hash chain vs GCal last-write-wins). One-way push covers the stated need ("see my agenda on my calendar") at a fraction of the cost.
- **`.ics` subscription feed (pull).** Google Calendar controls subscription refresh cadence (hours to ~24h, no webhook, no forceable poll). Pull also requires a publicly reachable URL. Fails the "constantly updated" requirement.
- **Google Tasks API.** Users want the agenda on their *calendar*, not in the Tasks pane.
- **CalDAV self-hosted.** Google Calendar does not consume CalDAV as a client.
- **Writing into the user's primary calendar.** Rejected: pollutes an existing calendar the user may share with others. Agaric creates and owns its own dedicated calendar, so the user can hide / share / color-code it independently, and disconnect cleanup is a single `calendars.delete` API call.

**User decisions (recorded up front, do not re-litigate):**

- **Push-only, one direction.** Agaric is always authoritative. GCal is a dumb mirror. Edits made inside GCal are silently overwritten on the next push — stated in the Settings UI so users are not surprised.
- **Daily digest, not per-task events.** One all-day event per calendar date. Event description lists that date's agenda entries as plain text.
- **Dedicated Agaric-owned calendar**, created on first connect (via `calendars.insert`), named "Agaric Agenda". The user never picks an existing calendar — Agaric owns the whole surface. The calendar ID is persisted in `gcal_settings.calendar_id`.
- **Threat-model deviation accepted for this feature only.** Off by default, opt-in per device, gated by a Settings toggle, isolated to the `src-tauri/src/gcal_push/` module. `AGENTS.md` §"Threat Model" is **not** edited — scoped, labeled deviation, not a policy change. All other threat-model assumptions (single-user, no adversarial peers, local-only device sync) remain in force.
- **One active pusher at a time.** Push-lease in `gcal_settings` — other devices stay idle until the active device releases or expires the lease. Prevents two devices each creating their own "Agaric Agenda" calendar on first connect, and prevents concurrent digest overwrites after that.
- **All-day events only.** Each digest event is a single all-day event on its date. No timed events, no timezone handling.
- **Push is driven from the materializer's downstream tap, not from inside command handlers.** Preserves `AGENTS.md` invariant 2 (CQRS split) — the op log stays append-only, and the GCal push reacts to already-materialized state via the `block:properties-changed` Tauri event bus + the `agenda_cache` / `projected_agenda_cache` tables.
- **New `gcal_agenda_event_map` and `gcal_settings` tables approved** (per `AGENTS.md` §"Architectural Stability"). Both are pure derived-state / configuration tables — no new op types, no new materializer queue, no new sync-protocol message, no new Zustand store.
- **New background Tokio task approved** (mirrors the `sync_daemon` lifecycle; **not** a new materializer queue).

**Architecture overview:**

New module `src-tauri/src/gcal_push/` — peer to `sync_daemon/`, launched on the same lifecycle. Module layout pinned so sub-items do not overlap:

```
src-tauri/src/gcal_push/
    mod.rs              — task lifecycle, configuration, Actor::GCalPush context (FEAT-5e)
    oauth.rs            — OAuth PKCE flow + token refresh (FEAT-5b)
    keyring_store.rs    — keychain-backed token storage with typed fallback (FEAT-5b)
    api.rs              — reqwest client + error taxonomy + calendar lifecycle (FEAT-5c)
    digest.rs           — pure (date, entries) → Event JSON (FEAT-5d)
    connector.rs        — event subscriber + per-date reconcile sweep (FEAT-5e)
    lease.rs            — push-lease acquisition / renewal (FEAT-5e)
    models.rs           — sqlx row structs for gcal_agenda_event_map + gcal_settings (FEAT-5a)
    tests/              — per-file tests, shared fixtures
src-tauri/src/commands/
    gcal.rs             — thin Tauri command wrappers consumed by FEAT-5f
```

The connector reads from the reader pool for its diff-and-push loop; it never writes to the op log. It writes to `gcal_agenda_event_map` / `gcal_settings` via a writer connection solely for its own derived state.

**Data source — what "an agenda entry" is:**

The connector does **not** write its own filter logic. It consumes `list_projected_agenda_inner(start_date, end_date, limit=500)` (already implemented in `src-tauri/src/commands/agenda.rs`), which returns `Vec<ProjectedAgendaEntry { block, projected_date, source }`:

- Already excludes `deleted_at IS NOT NULL` (via `agenda_cache` JOIN).
- Already excludes `is_conflict = 1` (agenda cache is populated only for the canonical block).
- Already excludes DONE / CANCELLED repeat occurrences that fall after the `repeat-until` / `repeat-count` end condition.
- Already includes projected future occurrences of repeating blocks within the window — so there is no repeat-expansion logic at the push layer.
- Template-page filtering: `agenda_cache` only rows from blocks whose root page is not marked `template` (if the current query does not already filter this, FEAT-5a adds the `NOT EXISTS (SELECT 1 FROM block_properties WHERE block_id = page_root_id AND key = 'template')` clause — verify during implementation and add if missing).

This means FEAT-5d and FEAT-5e are genuinely simple: they accept the projected entries as-is and format them.

**Data model (defined in FEAT-5a):**

- `gcal_agenda_event_map(date TEXT PRIMARY KEY, gcal_event_id TEXT NOT NULL, last_pushed_hash TEXT NOT NULL, last_pushed_at TEXT NOT NULL)` — **keyed by date, not by block**. At most `window_days` rows in steady state (default 30). Simple, dense, small.
- `gcal_settings(key PRIMARY KEY, value, updated_at)` — KV for `calendar_id` (the Agaric-owned calendar), `privacy_mode` (`full` / `minimal`), `window_days` (default `30`), `push_lease_device_id`, `push_lease_expires_at`, `oauth_account_email` (display only — token is in keychain). OAuth tokens live in the OS keychain, **not** in this table.
- FK to `blocks(id)` is **not** required (the map is date-keyed, and block deletion's effect is picked up by the next agenda query → hash changes → digest re-pushed).

**Event content (FEAT-5d), two privacy modes:**

- `full` (default):
  - Summary: `Agaric Agenda — <Weekday> <Mon DD>`, e.g. `Agaric Agenda — Tue Apr 22`.
  - Description: one line per entry, grouped by source (`DUE`, `SCHEDULED`, `PROPERTY`) with a blank-line separator. Each line: `[  ] <PageTitle> › <block content (first 80 chars)>` with state markers — `[ ]` TODO, `[/]` DOING, `[✓]` DONE, `[✗]` CANCELLED, `[~]` no todo state. Tags appended: `  #tag1 #tag2`. Description capped at 4096 chars (GCal limit is 8192; we leave headroom). If the date has no entries, the event is **deleted** rather than left with an empty description.
- `minimal`: summary = `Agaric Agenda — <date> (N entries)`. Description = empty. For users who share their "Agaric Agenda" calendar publicly.

**Sync cycle (FEAT-5e):**

1. Listener: every `block:properties-changed` event is classified. If its `changed_keys` intersects `{due_date, scheduled_date, todo_state, repeat, repeat-until, repeat-count, priority, title_or_content}`, compute the set of dates potentially affected: for a property change on a block, that is `{old_value, new_value} ∩ [today, today + window_days]`. Mark those dates dirty in an in-memory set.
2. Debounce: dirty-set is flushed 500 ms after the last addition, or immediately if the flush timer is already running and >1 s has elapsed.
3. For each dirty date:
   - Query `list_projected_agenda_inner(date, date, 500)`.
   - Compute `hash = blake3(canonicalized_entries_json)`.
   - Compare against `gcal_agenda_event_map.last_pushed_hash`.
   - If changed:
     - If entries is empty AND a map row exists → `delete_event`, delete map row.
     - If entries is empty AND no map row → skip.
     - If entries is non-empty AND no map row → `insert_event`, insert map row.
     - If entries is non-empty AND map row exists → `patch_event`, update map row's hash + timestamp.
4. 15-minute reconcile ticker: for every date in `[today, today + window_days]`, run step 3 unconditionally. Safety net for missed events, crash recovery, and window-boundary rollover at midnight.

**Rate limiting:**

- Coalesce `block:properties-changed` events within the 500 ms debounce window — prevents thrashing on drag-drop or bulk retitle.
- Google Calendar API quota: 500 queries / 100 s / user. Connector holds a token-bucket rate limiter (10 qps sustained, 25-burst). In practice the per-date model is well under quota — worst case at 30-day window × reconcile is 30 queries, already below burst.
- `429 Too Many Requests` → honor `Retry-After` verbatim.
- `5xx` → exponential backoff (reuse `SyncScheduler` shape from `sync_daemon/`, ceiling 5 minutes).
- `401 Unauthorized` → token revoked; disable the push toggle, clear the keychain entry, emit Tauri event `gcal:reauth_required`. Do NOT retry.
- `403 Forbidden` (insufficient scope / billing / calendar deleted out from under us) → log, disable, emit `gcal:push_disabled`. Do NOT retry.
- `404 Not Found` on the dedicated calendar → user deleted "Agaric Agenda" manually in GCal; next connect re-creates it. Clear all map rows.
- `404 Not Found` on a specific event → treat as "user deleted it"; clear the map row for that date, let the next push re-create.
- `400` / `409` → log as `AppError::Gcal::InvalidRequest`; do NOT retry.

**Queue durability:** in-memory only. The 15-minute reconcile sweep is the durability safety net — on restart, it re-hashes every date in the window and pushes any drift. A crash mid-push delays at most one date's update by ≤15 minutes.

**Midnight rollover:** the reconcile ticker is anchored to wall-clock; when local midnight passes, the new day's date enters the window and the old tail date leaves. Past-date events stay in GCal as historical records (no back-delete at window exit).

**Multi-device push-lease (FEAT-5e):**

- `gcal_settings.push_lease_device_id` = device currently authoritative. Renewed every 60 s, 180 s expiry.
- On startup: check lease; if expired or absent, CAS-claim via a single-row UPDATE guarded by `WHERE value IS NULL OR updated_at < ?`. If CAS fails, stay idle and re-check every 60 s.
- The lease is especially important **before** first connect: it prevents two devices each calling `calendars.insert` and creating two "Agaric Agenda" calendars on the same Google account.

**Disconnect cleanup (FEAT-5f):** On "Disconnect Google Calendar", open a modal with two choices: *"Keep the Agaric Agenda calendar"* (default — clears tokens + map rows only; the calendar + events remain in GCal) or *"Delete the Agaric Agenda calendar"* (one `calendars.delete` call — everything gone in one shot, because Agaric owns the whole calendar). Never silently mass-delete.

**Testing bar (per `AGENTS.md` §Testing Conventions + `PROMPT.md` §3):**

Each sub-item's verification is stated in its own entry. Global invariants:

- Happy-path + error-path tests for every exported Rust function / exported component.
- Exact-count assertions (`assert_eq!`, never `>=`).
- No silent `.catch(() => {})`; errors go through `logger.warn` / `logger.error` or `AppError`.
- `axe(container)` a11y audit on FEAT-5f.
- Property tests on FEAT-5d's pure digest function.
- IPC-rejection fallback tests on every `invoke` call in FEAT-5f.

**Open questions — recommended answers accepted as defaults unless the pre-implementation session overrides:**

- Window size → **30 days forward** (matches the projected-agenda default horizon). User-configurable in Settings, range `[7, 90]`.
- Debounce window → **500 ms**.
- Reconcile interval → **15 minutes**.
- Description character cap → **4096 chars**. If a single date has enough entries to exceed this (rare), truncate with `… and N more in Agaric` as the last line.
- Privacy default → `full` (user flips to `minimal` if they share the calendar publicly).
- Disconnect default action → "Keep the Agaric Agenda calendar".
- On `keyring` unavailable (Linux headless) → log warning, disable push, surface Settings error. Do **NOT** fall back to plaintext file storage.
- OAuth scope → `https://www.googleapis.com/auth/calendar` (required for `calendars.insert` to create our dedicated calendar; the narrower `calendar.events` is not sufficient). Confirm during FEAT-5b.
- Client ID → public desktop-OAuth client baked into the binary (standard for desktop OAuth; not a secret).
- Calendar name → `Agaric Agenda` (literal). Color hint: GCal palette index 5 (green) by default; user can re-color in GCal UI, we do not re-assert.

**Dependencies and coupled-stack note:**

New runtime crates:

- `oauth2` — PKCE flow helper. Match its TLS backend to the rest of the repo (`rustls`, not `native-tls`) via feature flags.
- `keyring` — cross-platform OS keychain (Secret Service / macOS Keychain / Windows Credential Manager). Pick the minimum per-platform backend features; avoid pulling the pure-Rust fallback.
- `tauri-plugin-oauth` — Tauri-side OAuth callback handler. Per `AGENTS.md` §"Coupled Dependency Updates", any Tauri plugin must move with the rest of the Tauri stack in one commit.
- `secrecy` — wrapper type (`Secret<String>`) for OAuth access + refresh tokens. Auto-redacts in `Debug`; forces explicit `.expose_secret()` to read. Cheap insurance against accidental token leakage through `tracing::instrument` spans, `AppError` chains, or `logger.warn` serialization. ~tiny crate, zero ongoing maintenance.

New dev-dep:

- `wiremock` — HTTP mock server for FEAT-5b / 5c / 5e tests. No existing alternative in the repo's dev-deps.

**Explicitly rejected dependencies (do not re-propose in later sessions without a strong new reason):**

- `google-calendar3` / `google-apis-rs` — auto-generated Google Calendar client. Pulls tens of thousands of lines of generated code for the 6 endpoints we use; couples us to `yup-oauth2`'s OAuth model which fights `tauri-plugin-oauth` for ownership of the loopback callback. The hand-rolled `api.rs` in FEAT-5c is ~200 readable lines — that is the right size.
- `yup-oauth2` — de-facto Rust Google OAuth client. Wants to own the full flow including its own local HTTP listener, which conflicts with `tauri-plugin-oauth`. `oauth2` crate + `tauri-plugin-oauth` is the clean split.
- `reqwest-middleware` + `reqwest-retry` — our retry is **per-error-class** (`401` → reauth event, `403` → push-disabled, `404` → drop map row, `429` → `Retry-After`, `5xx` → backoff), not generic transient-failure retry. Middleware libraries do not model class-specific action well, and we are already reusing `SyncScheduler` from `sync_daemon/`.
- `governor` / `leaky-bucket` — token-bucket rate limiter. We have exactly one fixed rate limit (10 qps / 25-burst); a `VecDeque<Instant>` in ~30 lines is more readable than a dep. Skip unless a second rate limiter lands elsewhere.
- `tower` / `tower-http` — not used elsewhere in the repo; introducing a middleware paradigm for one module is outsized.
- `mockall` — repo pattern is manual trait-based test doubles. Consistent with `AGENTS.md` "follow existing patterns".
- `chrono-tz` — v1 is all-day events only. Only relevant to the (unplanned) v3 timed-events phase.

**Feature-flag alignment (not a new dep, but in scope for FEAT-5c):**

Current `Cargo.toml`:

```toml
reqwest = "0.13.2"
```

Uses default features (`native-tls` backend). The rest of the repo is rustls-everywhere (`rustls`, `tokio-rustls`, `tokio-tungstenite` with `rustls-tls-native-roots`, sqlx on rustls). FEAT-5c aligns to:

```toml
reqwest = { version = "0.13.2", default-features = false, features = ["rustls-tls-native-roots", "json", "http2"] }
```

Consistent with MAINT-87's past pruning of unused sqlx backends (single TLS stack at link time, smaller binary).

**Already in `Cargo.toml` — reuse, do not duplicate:**

| Need | Existing crate |
|---|---|
| Error enum derives + `From` impls | `thiserror 2.0.18` (runtime) |
| Property tests | `proptest 1.11.0` (dev) |
| JSON snapshot tests (with redactions for timestamps / event IDs) | `insta 1.47.0` with `yaml` + `redactions` (dev) |
| Digest content hash | `blake3 1.8.3` (runtime) |
| Date + RFC 3339 wire format | `chrono 0.4.44` with `serde` (runtime) |
| `#[instrument(skip(token), err)]` pattern | `tracing 0.1.44` with `attributes` (runtime) |
| Multi-threaded materializer-style harnesses | `tokio` dev-deps already include `rt-multi-thread` + `test-util` |
| Temp DB fixtures | `tempfile 3.27.0` (dev) |

**Rollout phases:**

1. **v1 — Desktop daily-digest push.** FEAT-5a → FEAT-5b → {FEAT-5c, FEAT-5f} → FEAT-5e (with FEAT-5d landing independently).
2. **v2 — Android support.** FEAT-5g (requires its own design approval before work starts).
3. **v3 — Per-task events / timed agenda.** Explicitly NOT planned. The daily-digest model is the answer to "how the agenda shows up in GCal", and per-task mirroring was considered and rejected.

**Implementation DAG (v1):**

```
5a ──┐
     ├──▶ 5b ──┬──▶ 5c ──┐
     │        └──▶ 5f    ├──▶ 5e
5d ──┴───────────────────┘
```

First wave (parallel): `5a` + `5d`. Second wave: `5b`. Third wave (parallel): `5c` + `5f`. Fourth wave: `5e`.

**Cost:** L — spans one new backend module (~8 files), one new Settings tab, 4 new runtime crate deps + 1 new dev-dep, one migration, ~30 tests (Rust + frontend). Realistic estimate: **1–2 focused sessions** for v1 (a schema + digest + settings-UI session, then OAuth + API + connector). The daily-digest model is roughly 30–40 % less code than the rejected per-task shape.

**Status:** IN PROGRESS — v1 (FEAT-5a..FEAT-5i, desktop daily-digest push: schema + OAuth + API client + digest + settings tab + connector + DirtyEvent materializer hook + local-command DirtyEvent producer) landing incrementally. v2 (FEAT-5g, Android) DEFERRED pending separate design approval. v3 (per-task / timed events) explicitly NOT planned.

### FEAT-5g — GCal: Android OAuth + background connector (DEFERRED — design sketch only)

Part of the FEAT-5 family. **Not scheduled.** Blocked on explicit design-review approval before any code lands.

**Why this is filed and not done:**

- `tauri-plugin-oauth` on Android needs investigation — its current implementation targets loopback HTTP listeners, which Android sandboxes.
- `keyring` has no Android support; token storage would need to switch to Android Keystore via a JNI bridge or a Tauri-side secure-storage plugin.
- The `gcal_push::connector` task lifecycle on Android needs to survive Doze / battery-saver — either WorkManager periodic task (≥15 min min interval, may miss pushes) or an Android foreground service with a persistent notification (always-on, user-visible).
- Rate limits + offline durability on mobile are different shapes than desktop — though the daily-digest model makes this easier (at most ~30 ops per full resync, well under quota).

**Design questions to resolve before scheduling:**

- Loopback OAuth vs. Custom Tabs + PKCE + App Link callback — which does `tauri-plugin-oauth` support on Android today?
- Keystore-backed token store — existing Tauri secure-storage plugin, or custom JNI?
- Connector scheduling — foreground service (user-visible, always-on) or WorkManager periodic (may skip pushes under Doze)? For the daily-digest model, WorkManager's ≥15 min cadence is actually acceptable and matches the desktop reconcile interval — event-driven updates are a bonus, not a requirement.
- Re-auth UX when the user clears app data — acceptable, or do we need to export-and-reimport tokens?

**Cost:** L — 2–3 sessions minimum after design approval.

**Status:** DEFERRED. Do NOT start without an explicit design-review session that resolves the four questions above.

### FEAT-11 — Adopt `tauri-plugin-notification` (OS notifications for due tasks / scheduled events)

**Problem:** The app has agenda + due dates + scheduled dates + repeat properties + projected agenda + the Google Calendar push connector (FEAT-5), but zero OS-level notification path. A user with "buy groceries — DUE 09:00" cannot be notified by the OS unless the GCal push has already fired and their calendar app shows it. Org-mode / Logseq users expect "10 minutes before scheduled" and "due now" to surface as native notifications.

**Fix:** Adopt `@tauri-apps/plugin-notification` + `tauri-plugin-notification`. New backend module `src-tauri/src/notifier/mod.rs` schedules notifications based on `due_date` + `scheduled_date` + property events from the materializer (analogous to `gcal_push::DirtyEvent`). Reuses the existing `agenda_view` queries to find blocks within the next-24h window on boot and on every materialize commit. Frontend: a Settings tab toggle + per-property filter. Mobile permissions: request `POST_NOTIFICATIONS` on Android 13+ via the plugin's permission API. Coupled stack — bump with the rest of the Tauri plugins.

**Cost:** L — design (which events fire? how to dedupe? snooze semantics?), backend scheduler (~6 files), one Settings sub-tab, mobile permission flow, ~25 tests.
**Risk:** M — wrong-time notifications and notification spam are both real failure modes; needs careful dedupe and "do not re-fire on materialize replay" guard.
**Impact:** L — closes a recognised feature gap with Org-mode / Logseq parity; especially valuable on mobile where the user is unlikely to have the app foregrounded when a task is due.

## MAINT — Maintenance / cleanup

### MAINT-111 — MCP server hand-rolls JSON-RPC 2.0 framing; evaluate `rmcp` (official Rust MCP SDK)

**What:** `src-tauri/src/mcp/server.rs` (~492 LOC) implements line-delimited JSON-RPC 2.0 over the Unix-domain socket / Windows named pipe by hand:

- `make_success(id, result)` / `make_error(id, code, message)` response builders (lines ~127–145).
- `parse_request(line)` — manual shape validation (object? `method` field? `id` field?) with its own `ParsedRequest` / `IncomingRequest` / `IncomingNotification` enums (lines ~167–209).
- Method dispatch — `handle_initialize`, `tools/list`, `tools/call`, `notifications/initialized`, hard-coded JSON-RPC error codes (`JSONRPC_PARSE_ERROR` … `JSONRPC_RESOURCE_NOT_FOUND`).
- No `jsonrpc-core` / `jsonrpsee` / `rmcp` crate in `Cargo.toml`; everything is `serde_json::Value` + `json!` macros.

**Alternative:** `rmcp` (https://crates.io/crates/rmcp) is the official Rust Model Context Protocol SDK published by the `modelcontextprotocol` organisation. It supports **both** client and server roles over stdio (matching the MCP spec's subprocess framing that `agaric-mcp` forwards verbatim), provides typed tool / prompt / resource registration, automatic JSON-RPC 2.0 framing, and error-code mapping. `jsonrpsee` is an alternative for generic JSON-RPC but is HTTP/WS-oriented — `rmcp` is the more direct fit.

**Why this is only a "spike", not an immediate replace:**

- The `mcp/` module is ~2.4k LOC total and already has its own actor (`actor.rs`, 323 LOC), registry (`registry.rs`, 873 LOC), activity ring (`activity.rs`, 823 LOC), and last-append tracker (`last_append.rs`, 135 LOC). `rmcp`'s macro-driven tool model needs to coexist with the existing `ToolRegistry` trait and the FEAT-4d activity-feed plumbing.
- `agaric-mcp` ships as a separate binary; the migration affects the external stdio surface.
- `rmcp` is still pre-1.0 and evolving.

**Suggested spike:** wire one read-only tool (e.g. `search_blocks`) through `rmcp`'s server API while keeping the rest on the hand-rolled path. Measure:

1. How much of `server.rs` collapses (dispatch, framing, error mapping).
2. Whether `rmcp`'s tool-registration model can be adapted over the existing `ToolRegistry` trait without losing the activity-feed emission point.
3. Spec-conformance delta — does `rmcp` handle protocol-version negotiation, `tools/listChanged` notifications, or other MCP features that `server.rs` currently stubs?

If the adapter is clean, estimate a ~300–500 LOC reduction in `server.rs` with better forward-compatibility with MCP spec revisions. If `rmcp` wants to own the registry, abandon — the current code is well-tested and not a maintenance burden.

**Cost:** M (2–8h for the spike; full migration would be L if pursued).
**Risk:** M — external binary surface, coexistence with existing actor + activity-feed patterns.
**Impact:** M (conditional on spike outcome) — reduces framing boilerplate and tracks the MCP spec upstream rather than reimplementing it.

### MAINT-113 — `ConflictFreeBlockId` newtype to lift invariant #9 into the type system

**What:** AGENTS.md "Key Architectural Invariants" #9 reads:

> Recursive CTEs over `blocks` must filter `is_conflict = 0` in the recursive member, and bound `depth < 100` to prevent runaway recursion on corrupted data. Conflict copies leak into results otherwise.

This invariant is currently enforced by code review + grep + one-line comments. It is baked into **220 `is_conflict = 0` SQL occurrences across 70 source files** (plus 3 more in `migrations/`). Every new query touching `blocks` must remember to add it.

**Alternative design:** Split the `BlockId` primitive into two types:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct BlockId(String);        // raw — may refer to a conflict copy or deleted block

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct ActiveBlockId(String);  // materialised AND is_conflict = 0 AND deleted_at IS NULL
```

Query helpers that return "active" blocks (`list_children`, `get_descendants`, `list_page_links`, every recursive CTE wrapped behind a Rust fn) return `Vec<ActiveBlockId>`. Query helpers that accept only active input take `&ActiveBlockId`. Conversion `BlockId → ActiveBlockId` goes through a single checked gate (`verify_active(&BlockId) -> Result<ActiveBlockId>`) that runs the `is_conflict = 0 AND deleted_at IS NULL` predicate exactly once. Recursive CTEs hidden behind these helpers keep their `AND is_conflict = 0` in SQL — the newtype just prevents callers from accidentally feeding a raw `BlockId` into a path that assumes active.

**Why this is a LOW-priority refactor:**

- The invariant is already documented (AGENTS.md #9), already tested (the `block_tag_inherited` materialised cache has an oracle CTE that verifies the filter is honoured), and already flagged by review (session logs show "missing `is_conflict = 0`" is caught before merge).
- No shipped HIGH/CRITICAL bug traces back to a missed filter in the last ~50 sessions. The tension is correctness-by-convention vs. correctness-by-types, not correctness vs. incorrectness.
- Scope is genuinely large — 220 SQL sites are the *floor* (each one lives in a function with a Rust signature); the real work is touching **every** producer/consumer of `BlockId` and deciding whether it returns raw or active. Honest estimate: 70 files, hundreds of function signature changes, a `specta`-bindings ripple to the frontend (extra TS type), and a round of test fixture updates.
- The serde wire format must stay `String` (both directions) so sync + IPC aren't affected — handled with `#[serde(transparent)]`.

**Do not take this on a deadline.** Land only as opportunistic cleanup — e.g., when a specific module is already being rewritten for another reason, convert its signatures over and leave the rest of the codebase on `BlockId` for another session. The existing `is_conflict = 0` + `depth < 100` convention is **not broken**; it is **not elegant**.

**Cost:** L (8h+ at minimum; realistically 2–4 sessions if done wholesale).
**Risk:** M — pervasive API change. Sync / MCP / specta bindings must round-trip identically. Mixing raw and active block IDs in a single data structure (e.g., `BlockTreeNode` with both active children and "recently-deleted" preview siblings) needs explicit policy.
**Impact:** M (if shipped) — eliminates an entire class of "forgot to filter conflicts" bugs at compile time. Invariant #9 in AGENTS.md could reference the type instead of a prose rule.

**Decision:** Defer indefinitely. Revisit only if a future `is_conflict = 0` miss ships a user-visible regression. Keep in REVIEW-LATER as a filed design note so it is not reinvented from scratch next time.

### MAINT-114 — Consolidation audit of `.github/workflows/`

**What:** Four workflow files today:

| File | Trigger | Jobs |
|---|---|---|
| `.github/workflows/_validate.yml` (135 LOC) | `workflow_call` | prek-equivalent (lint + fmt + clippy + nextest + vitest + playwright + sqlx offline check + MCP smoke) |
| `.github/workflows/ci.yml` (288 LOC) | push (non-tag) + PR | calls `_validate.yml` → desktop build matrix (ubuntu / windows / macos) + android aarch64/x86_64 build |
| `.github/workflows/release.yml` (~450 LOC) | push `v*` tag | calls `_validate.yml` → verify-version → desktop build matrix + sign + android APK + draft GitHub Release |
| `.github/workflows/release-tag.yml` (78 LOC) | `workflow_dispatch` only (`-f version=…`) | runs `scripts/bump-version.sh --commit --tag --push`; the tag push then re-triggers `release.yml` |

The initial one-line recommendation was "4 → 2 (validate + release)". On inspection that is too aggressive. `ci.yml` and `release.yml` have genuinely different reasons to exist (per-push non-tag build vs. per-tag signed-release pipeline), and `release-tag.yml` is a thin entry-point wrapper around `bump-version.sh` that exists so the maintainer does not have to type the bump + tag + push dance manually.

**Realistic consolidation wins (ranked by ROI):**

1. **Fold `release-tag.yml` into `release.yml` as a `workflow_dispatch` job** — 4 → 3. The bump-version step would sit above the build matrix, gated by `if: github.event_name == 'workflow_dispatch'`; the build matrix remains tag-triggered. Saves one file, removes the "tag push re-triggers a different workflow" indirection. Mild downside: `release.yml` grows by 78 LOC, and a dispatched version bump run that fails before the tag push no longer leaves a small, focused log (failure appears inside the big Release file). Probably worth it, but not huge.
2. **Keep `_validate.yml` as reusable** — already optimal. Called by both ci.yml and release.yml, avoids duplicating 135 LOC of setup. Leave alone.
3. **Do NOT merge `ci.yml` into `release.yml`** — the build matrix would have to be double-gated (`if: github.event_name == 'push' && !startsWith(github.ref, 'refs/tags/')` etc.), artifact upload names would conflict between "per-push smoke bundle" and "signed release bundle", and the signed-release path needs secrets that per-push builds must not have access to. The current split is a principled least-privilege boundary; collapsing it would require narrower secret scoping per step, which is more complex than the current file split.

**Proposed outcome:** Attempt 4 → 3. Only commit if the merged `release.yml` is not longer than `ci.yml` + `release.yml` + `release-tag.yml` combined, AND the `workflow_dispatch` path is at least as discoverable in the GitHub Actions UI as the standalone "Release Tag" entry. Otherwise abandon — a tidy file split is worth more than a tidy file count.

**Cost:** S–M (spike ~2h; full migration including docs-drift checks ~4h).
**Risk:** Low-to-medium — release pipeline is load-bearing. Test the merged workflow by dispatching against a throwaway tag (`0.0.0-test-consolidation`) on a fork or a draft release.
**Impact:** S — one fewer file to navigate, slight simplification of the "how do I cut a release?" mental model. Not pressure relief.

### MAINT-124 — Collapse `src/App.tsx` (1436L) god component

**What:** `App.tsx` is the largest component in the tree at 1436L. It hosts:

- **20+ `useEffect`s** for independent concerns: global shortcut handlers × 5 (journal / global / space / tab / close-overlays), sync events, deep-link routing, draft recovery, priority-level loading, focus management, scroll restoration, view transitions, theme, online status.
- **10+ event listeners** registered/deregistered across effects.
- **5 dialog/modal open states** (`bugReportOpen`, `quickCaptureOpen`, `showNoPeersDialog`, `shortcutsOpen`, `bugReportPrefill`).
- **4 different async patterns in one file** (`void (async () => ...)()` IIFE, `.then().catch()`, `.then/.catch` inside callback, `async/await + try/catch`).
- **236-line inline sidebar tree** at L1159-1394 (`SidebarProvider` + `Sidebar` + header / menu / footer + `SidebarInset` + `TabBar` + `RecentPagesStrip` + `ScrollArea` + `ViewRouter`).
- **3 silent `.catch(() => {})`** at L935-939 (`w.unminimize().catch(() => {})`, `w.show().catch(() => {})`, `w.setFocus().catch(() => {})`). The outer `try/catch` at L931-942 does NOT rescue these — each inner `.catch` resolves the rejected promise to `undefined` so `await` succeeds. Direct AGENTS.md §Anti-patterns violation.

**Fix:**

1. Extract `useAppKeyboardShortcuts()` in `src/hooks/` — consolidate the 5 shortcut-handler effects into a single one. 5 effects → 1.
2. Extract `useAppDialogs()` — owns the 5 open states + their handlers.
3. Extract `<ViewDispatcher>` — the view-router switch that dispatches on `currentView`.
4. Extract `<AppShell>` — the sidebar tree and main content wrapper.
5. Fix the silent `.catch(() => {})` triplet by adding `logger.debug('App', 'best-effort window focus failed', { step }, err)` to each.
6. Standardize on `async/await + try/catch` for async patterns.

Target App.tsx ≤500 lines: boot gate, dialog mounts, the 4 extracted pieces, and composition.

**Cost:** L.
**Risk:** Medium — the file is load-bearing. Migrate incrementally, one extraction per commit, running the existing App.test suite and e2e shortcut tests between each.
**Impact:** L — biggest single-file cognitive-load reduction in the codebase.

### MAINT-128 — God-component decomposition batch

**What:** Nine components have grown well past the sibling-components + hook layer's "keep under 500L" norm, with concrete sub-pieces already visible in the code. All line counts validator-verified.

| Component | LOC | Concrete extraction target |
|---|---|---|
| `src/components/PageBrowser.tsx` | 961 | `PageBrowserRowRenderer` (3 row kinds already exist as fns); `PageBrowserHeader` (form + search + sort dropdown); `usePageBrowserGrouping` hook (`buildSinglePageBranch`, `buildMultiPageBranch`, `sortTopLevelUnits`); `usePageBrowserSort` hook (localStorage pref + sort callback). Target ≤300. |
| `src/components/BlockTree.tsx` | 899 | `useBlockLinkResolve` (cache + batch resolve at L336 + L401); `useBlockPropertiesBatch` (L424); `useBlockNavigateToLink` (60-line `handleNavigate` L539-597); hoist the 4 `*Ref` indirections (`handleBeforeCollapseRef` etc. L240-243) with their hooks. Target ≤500. Violates own "thin orchestrator" docstring. |
| `src/components/TrashView.tsx` | 788 | `useTrashFilter`, `useTrashMultiSelect` hooks; row renderer to sibling; 4 inlined `ConfirmDialog`s can move to siblings. Target ≤350. |
| `src/components/ConflictList.tsx` | 737 | Extract `useConflictFilters`, `useConflictSelection`; split 3 inline `ConfirmDialog`s to siblings. **Same commit removes the direct DOM-mutation anti-pattern at L287-300** where `item.setAttribute('role','option')` is called from a `useEffect` (React may overwrite on re-render; the comment at L287-289 admits the workaround). Target ≤350. |
| `src/components/SettingsView.tsx` | 620 | 9 tab panels currently rendered inline from one switch (L532-614). Extract to `src/components/settings/{General,Properties,Appearance,Keyboard,Data,Sync,Agent,GoogleCalendar,Help}Tab.tsx`. Lift `AutostartRow` (L188-298, 110L) + `QuickCaptureRow` (L299-441, 142L) to siblings. Add `useSettingsTab()` hook for localStorage+URL persistence. Target SettingsView.tsx ≤150. |
| `src/components/HistoryView.tsx` | 528 | `useHistorySelection` (wraps `useListMultiSelect` with HistoryView semantics); `useHistoryKeyboardNav`; `HistoryListView` presentational; `HistoryRevertDialog` + `HistoryRestoreDialog` siblings. Target ≤250. |
| `src/components/PropertyRowEditor.tsx` | 539 | **Explicit `biome-ignore lint/complexity/noExcessiveCognitiveComplexity` at L85** with a rationale that is invalidated by dispatching by `def.value_type` (text/number/date/ref/select → 5 parallel JSX subtrees). Split into 5 typed row editors + a dispatcher. The `biome-ignore` goes away. |
| `src/components/SortableBlock.tsx` | 469 | `useAttachmentCount` (L150-165); `usePropertyDefForEdit` (L220-265); `useBlockContextMenu` (context-menu + edit state L138-147); touch-long-press + swipe-to-delete remain. Target ≤250. |
| `src/components/backlink-filter/AddFilterRow.tsx` | 556 | **2.5× its parent `BacklinkFilterBuilder`** (218L). 14 state slots at L194-213 + 10 per-category JSX blocks. Extract one file per filter category; state slots move with their category. |

**Cost:** L (stagger per file — do NOT land in one PR).
**Risk:** Medium per file — most have test suites; run the matching test file between each commit.
**Impact:** L — the 9 most expensive maintainability hotspots in the component tree become composable.

### MAINT-131 — Block-surface Tauri coupling

**What:** Both per-block IPC halves (SortableBlock badge counts AND StaticBlock full attachment lists) are now batched at the BlockTree level. The remaining work is wrapping a handful of remaining per-IPC calls in hooks to drop direct `lib/tauri` imports from 5 presentational components.

**Done across sessions 572 and 575:**

1. **Session 572:** Backend `get_batch_attachment_counts(block_ids: Vec<String>) -> HashMap<String, u32>` + frontend `useBatchAttachmentCounts` provider mounted at `BlockTree`. `SortableBlock` reads its count from `batchCounts?.get(blockId) ?? 0` instead of firing `useAttachmentCount(blockId)` per row. `useAttachmentCount.ts` deleted (no remaining consumers).
2. **Session 575:** Backend `list_attachments_batch(block_ids: Vec<String>) -> HashMap<String, Vec<AttachmentRow>>` (same `json_each()` pattern; empty input returns empty map; missing block IDs absent from result). Frontend `useBatchAttachments` provider with `{ get, loading, invalidate }` API mounted at `BlockTree` alongside `BatchAttachmentCountsProvider`. `StaticBlock` reads `attachments` from `useBatchAttachments()?.get(blockId) ?? []` instead of `useBlockAttachments(blockId)`. **Cache invalidation contract:** `useBlockAttachments.handleAddAttachment` and `handleDeleteAttachment` now call `useBatchAttachments()?.invalidate(blockId)` after their respective IPC succeeds — bumps an `invalidationToken` counter that re-runs the batch fetch. Outside-provider safety: `useBatchAttachments()` returns `null`, so the `?.invalidate(...)` is a no-op for AttachmentList drawer mounted standalone. The `_blockId` arg to `invalidate` is currently unused (reserved for a future surgical-update API). 15 new tests across 3 layers (5 Rust + 8 frontend hook + 2 tauri-mock).

**Remaining work:**

3. **Open:** Wrap remaining per-IPC calls in hooks. Add `useBlockReschedule` around `setDueDate`/`setScheduledDate` — used by `BlockListItem.tsx`, `RescheduleDropZone.tsx`, `DateChipEditor.tsx`, `BlockPropertyDrawer.tsx`. Add `useLinkMetadata` around `fetchLinkMetadata` — used by `LinkEditPopover.tsx`. After these hooks land, the 5 components become pure JSX + hooks with no direct `lib/tauri` imports. (Other previously-listed presentational components — `EditableBlock`, `BlockPropertyEditor`, `ImageResizeToolbar` — may still import `lib/tauri` for other IPCs; check after the reschedule/link-metadata hooks land.)

**Cost:** S — both batch IPCs shipped; remaining work is 2 small wrapper hooks + 5 component refactors (~1 PR).
**Risk:** Low — additive hook wrappers, no functional change.
**Impact:** S — enables isolated rendering (Storybook, unit tests w/o full mocks) for the 5 components above.

## PERF — Performance items

### PERF-19 — Backlink pagination cursor uses linear scan for non-Created sorts (2 sites)

**Problem:** Two backlink pagination paths locate the cursor position with a linear scan when results are sorted by something other than block creation (e.g., due_date, priority, property value):
- `src-tauri/src/backlink/query.rs:112-128` — uses `.position(|s| s.as_str() == after_id)` on `sorted_ids`
- `src-tauri/src/backlink/grouped.rs:125-136` — uses `.skip_while(|(pid, _, _)| pid.as_str() != after_id)` on `group_list`

For `Created` sort, both already use binary search on lexicographic ULID order (correct, O(log n)). The linear-scan fallback is used because property sorts reorder by value, so binary search on ID is invalid — but the fallback is O(n) in the filtered result set.

**Why it matters:** N here is the already-filtered result set (per page), typically ≤50 items. At that size the linear scan is ~50 string comparisons — cheaper than building a HashMap would be. This is documented as a LOW-severity finding and would only matter if page size is ever raised well into the thousands. Listed here so it doesn't get reinvented as a "fix" later when someone sees the loop without context.

**Fix (if ever needed):** maintain a `HashMap<&str, usize>` during the sort step for O(1) cursor lookup. Only worth doing if page size grows past ~500.

**Decision:** Defer — keep tracked in REVIEW-LATER as a deliberate non-fix. Revisit only if page size grows past ~500 or saved-query features ship.

**Cost:** S

### PERF-20 — Backlink filter resolver has no concurrency cap on `try_join_all`

**Problem:** `src-tauri/src/backlink/query.rs:80-82` fires every top-level filter concurrently via `try_join_all(filter_list.iter().map(|f| resolve_filter(pool, f, 0)))`. The read pool has 4 connections; if a user ever ends up with a filter expression holding 20+ OR-ed top-level filters, they all enqueue at once.

**Why it's LOW:** sqlx's `SqlitePool` queues gracefully when all connections are busy — it doesn't fail, it just waits. Realistic filter counts from the UI (`BacklinkFilterBuilder`) are 2–4. No known path to generate 20+ concurrent filters from normal usage. Flagging here in case a future "saved query library" or automation feature ever produces pathological inputs.

**Fix (optional, if saved-query features ship):**
```rust
let semaphore = Arc::new(tokio::sync::Semaphore::new(4));
let futures = filter_list.iter().map(|f| {
    let sem = semaphore.clone();
    async move {
        let _permit = sem.acquire().await.ok()?;
        resolve_filter(pool, f, 0).await
    }
});
let results = try_join_all(futures).await?;
```

Or a simpler cap: reject filter lists longer than some reasonable limit (e.g., 16) at the command boundary.

**Decision:** Defer — keep tracked in REVIEW-LATER as a deliberate non-fix. Revisit only if saved-query / automation features ship that can produce pathological filter counts.

**Cost:** S

### PERF-23 — `read_attachment_file` buffers whole file before chunked send

**Problem:** `src-tauri/src/sync_files.rs:182` (`read_attachment_file`) loads the full attachment into a `Vec<u8>` with `std::fs::read(path)` and hashes the complete buffer, then the caller at `src-tauri/src/sync_files.rs:294-300` iterates through `FILE_CHUNK_SIZE` (5 MB, defined at `sync_files.rs:34`) slices of that in-memory buffer for transmission. Peak memory per attachment is the file size (not N-additive — the loop is sequential).

**Why it's LOW:** For a personal notes app with typical attachments under 10 MB this is fine. Listed so that if the product ever intentionally targets large media (e.g., video notes), the correct fix is obvious.

**Fix (only if large attachments become a supported use case):** stream-hash and stream-chunk. Open a `tokio::fs::File`, wrap it in a `BufReader`, and in one pass:
- `blake3::Hasher::new()` → `update()` per buffer
- Collect chunk-size slices directly into the send queue without retaining the full buffer

This changes the signature of `read_attachment_file` (no longer returns `Vec<u8>` + hash together) and requires threading the streaming semantics through the sender loop. The chunk transport on the wire is already chunked, so no sync-protocol change is needed.

**Decision:** Defer — keep tracked in REVIEW-LATER as a deliberate non-fix. Revisit only if large media (video notes, high-bit-depth images) becomes a supported use case.

**Cost:** S–M

---

### PUB-2 — Git author email across all history is corporate (`javier.folcini@avature.net`)

**Problem:** `git log --format='%ae %an' | sort -u` across all 1,400+ commits returns a single corporate email address. If the project is published under a personal identity (or the user later wants to avoid tying the repo to a specific employer), the history will still expose the corporate address on every commit, including to anyone who clones.

**Options:**
1. **Rewrite history with `git filter-repo`** using a mailmap to replace `javier.folcini@avature.net` with a personal email across all commits. This changes every commit SHA — must be done before any public push or before any collaborator clones.
2. **Add a `.mailmap`** that re-maps the author in views (`git log`/`git shortlog`) without rewriting history. Cosmetic only; the underlying commit objects still carry the corporate email.
3. **Leave as-is.** Accept the provenance signal. Defensible if the project is legitimately personal and the corporate email was simply the active git config at the time.

**If option 1 is chosen:**
- Take a full backup of `.git` before running `git filter-repo`.
- Script: `git filter-repo --mailmap mailmap.txt` with an entry like
  `Your Name <personal@example.com> <javier.folcini@avature.net>`.
- Re-verify signatures if any commits are GPG-signed.
- Do this before the first public push. Rewriting published history is disruptive.

**Cost:** S
**Decision:** Defer the identity/history choice until the publish target (PUB-5) and publish timing are concrete. No `.mailmap` added and no history rewrite performed in this session.
**Status:** DEFERRED — revisit alongside PUB-5 when a publish target and identity are locked in.

### PUB-3 — Employer IP clearance before public release

**Problem:** Most employment agreements in AR/US/EU include IP-assignment clauses that cover work done on company devices, on company time, or in the employer's line of business. The committed corporate email in the git history (see PUB-2) makes provenance visible to anyone who clones. Even for a side project unrelated to the employer's business, publishing substantial software without checking the employment contract carries legal risk that a coding agent cannot assess.

**Options:**
1. **Review the employment contract** (and any IP-assignment addenda signed during onboarding) for clauses covering personal projects. Common concerns: "on company time", "using company equipment", "related to the employer's business", "during the term of employment".
2. **Request written clearance** from the employer (in writing, e.g., email to HR/legal) before publishing. Keep the response filed.
3. **Consult a lawyer** if any clause is ambiguous, especially the "related to employer's business" language. Note-taking / productivity / developer tooling can be a grey area for some employers.
4. **Defer publishing** until clearance is obtained.

**Not an agent task.** No file should be modified based on this item. Agents must never publish, push to remote, or change repo visibility without the user explicitly stating "PUB-3 is cleared".

**Cost:** S (user's time; not an implementation task)
**Decision:** Defer — user-only legal task. Agent does nothing and does not revisit this item during routine sweeps. Will be marked cleared (and the item removed) only when the user explicitly states "PUB-3 is cleared".
**Status:** DEFERRED — user task, not agent-actionable.

### PUB-5 — Tauri updater endpoint URL pinned; keypair + secrets remain user-only

**Status:** the endpoint URL in `src-tauri/tauri.conf.json` now points at `https://github.com/jfolcini/agaric/releases/latest/download/latest.json` (session 488). The remaining work is purely user-side and cannot be agent-actioned:

1. **Generate the Minisign keypair** (`cargo tauri signer generate -w ~/.tauri/agaric.key`). Back up the private key offline — losing it means future updaters can't verify against the deployed pubkey, breaking the auto-update chain for installed users.
2. **Paste the public key** into `tauri.conf.json` `updater.pubkey`.
3. **Add two GH Actions secrets** at `Settings → Secrets and variables → Actions`:
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of the generated `.key` file
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the passphrase used at generation time
4. **Uncomment** the two `TAURI_SIGNING_PRIVATE_KEY*` env lines in `release.yml:93-95` (under the `# PUB-5: Uncomment …` comment). The agent intentionally left these commented because uncommenting before the secrets exist + pubkey is set causes tauri-action to attempt signing with empty inputs.
5. **Tag a release** to verify: tauri-action will produce `*.sig` files alongside each bundle (`.dmg.sig`, `.AppImage.sig`, `.msi.sig`, etc.), which the in-app updater fetches and verifies against the embedded pubkey.

**Alternative (skip the updater):** remove the `updater` block from `tauri.conf.json` and the `tauri-plugin-updater` dependency from `src-tauri/Cargo.toml`. Users would update by manually downloading new releases.

**Cost:** S (~30 min of user work once the keypair is generated).

### PUB-8 — Android release keystore + 4 GH Actions secrets

**Problem:** `release.yml`'s `android-build-and-release` job already contains the full apksigner pipeline (zipalign + apksigner sign + apksigner verify + `gh release upload`), gated on a `ANDROID_KEYSTORE_BASE64` secret. Without the keystore + secrets the job uploads `agaric-<tag>-android-aarch64-unsigned.apk` (works on personal devices, but Play Protect warns and the APK can never be updated by a release-keystore-signed APK without uninstalling and losing data). The local `agaric-release.apk` previously in repo root was debug-keystore-signed and has the same dead-end property.

**Concrete remaining work:**
1. **Generate a release keystore** (one-time, locally):
   ```bash
   keytool -genkeypair -v \
     -keystore ~/agaric-release.jks \
     -alias agaric \
     -keyalg RSA -keysize 4096 -validity 10000 \
     -storetype PKCS12
   ```
   Pick stable CN/OU/O/L/ST/C — these are visible in Android Settings → Apps → Agaric → Advanced → "App signed by".
2. **Back up `agaric-release.jks` offline** (not in the repo, not in the GH secret, not in any cloud-synced folder you might lose). Lose this key and you lose the ability to ship updates that overwrite installed apps — Android refuses signature changes on upgrade. The base64 in the GH secret is *not* a backup; secrets are write-only after creation.
3. **Add 4 GH Actions secrets** at `Settings → Secrets and variables → Actions`:
   - `ANDROID_KEYSTORE_BASE64` ← `base64 -w0 ~/agaric-release.jks`
   - `ANDROID_KEYSTORE_PASSWORD` ← the store password from step 1
   - `ANDROID_KEY_ALIAS` ← `agaric` (or whatever alias you chose)
   - `ANDROID_KEY_PASSWORD` ← the key password from step 1
4. **Tag a release.** Next `git push --tags` produces `agaric-<tag>-android-aarch64.apk` (no `-unsigned` suffix) on the GitHub Release.

Full setup recipe in `BUILD.md` → "Release signing in CI" (under "Android Builds"). If you ever want to ship via Play Store later, this same key becomes the **upload key** under Play App Signing — Google holds the actual app signing key in that flow.

**Cost:** S (~15 min once you've decided what to use as DN).
**Status:** ACTIONABLE — pure operations, no design decision pending.

---

## Backend Code Review (Confirmed Findings) — Appended 2026-04-25

> Output of a deep, two-pass parallel backend code review covering all of
> `src-tauri/src/` (~128k LOC, 192 files). Pass 1: 10 domain reviewers.
> Pass 2: 10 independent validators that cross-checked every finding
> against the actual code. Hallucinations / out-of-scope claims dropped.
> Severities reflect Pass-2 corrections.
>
> All entries below are CONFIRMED issues. Already-tracked items
> (PERF-19, PERF-20, PERF-23) are referenced but not duplicated.
>
> Source artifacts: `/tmp/agaric-review/pass1/` (raw findings),
> `/tmp/agaric-review/pass2/` (validator verdicts),
> `/tmp/agaric-review/FINAL-CONSOLIDATED.md` (full report).

**Scope:** All Rust backend code in `src-tauri/src/` (~128k LOC, 192 files, 35 migrations).
**Method:** 10 parallel domain reviewers (Pass 1) + 10 independent validators (Pass 2) cross-checking every finding against the actual code, with hallucinations / out-of-scope claims dropped and over-stated severities corrected.

> Threat model reminder (AGENTS.md): Agaric is a single-user, multi-device, local-network-only app. Findings recommending hardening against adversarial sync peers were rejected as out-of-scope. Findings about data integrity, accidental corruption, and robustness against the user's own buggy peer software ARE in scope.

---

## Executive Summary

| Metric | Count |
|---|---|
| Raw Pass 1 findings | 348 |
| Dropped (hallucinated / out-of-scope / duplicate / wontfix-intentional) | 12 |
| Severity-downgraded by Pass 2 | 49 |
| Already-tracked in REVIEW-LATER (PERF-19, PERF-20, PERF-23) | 3 |
| Net findings in this report | 317 |
| **Critical** | **1** |
| **High** | **4** |
| **Medium** | **12** |
| **Low** | **124** |
| **Info / nits** | **125** |

### Top-priority items (Impact ÷ Cost)

1. **C-2b** — Boot-time op-log replay path for unmaterialized ops; op_log diverges from materialized state with no automatic remediation (<ref_file file="/home/javier/dev/agaric/src-tauri/src/materializer/consumer.rs" />). C-2a (divergence detection) shipped — divergence is now visible via `fg_apply_dropped` in `StatusInfo`; C-2b remains as the actual replay path. **Schema migration approval required**.

### Findings by Domain × Severity

| Domain | Crit | High | Med | Low | Info |
|---|---|---|---|---|---|
| Core data layer | 0 | 1 | 3 | 9 | 11 |
| Materializer | 1 | 2 | 4 | 8 | 4 |
| Cache + Pagination | 0 | 0 | 3 | 12 | 6 |
| Commands (CRUD) | 0 | 1 | 4 | 9 | 13 |
| Commands (System) | 0 | 2 | 8 | 13 | 6 |
| Sync stack | 0 | 3 | 10 | 25 | 5 |
| Search & Links | 0 | 2 | 4 | 16 | 19 |
| Lifecycle / Snapshots | 0 | 0 | 14 | 16 | 8 |
| MCP | 0 | 0 | 5 | 12 | 8 |
| GCal / Spaces / Drafts | 0 | 0 | 6 | 11 | 9 |

(Numbers approximate; some findings span domains and are listed under the primary one.)

### Already tracked (NOT re-reported)

- **PERF-19** — Backlink pagination cursor uses linear scan for non-Created sorts. Confirmed still applicable.
- **PERF-20** — Backlink filter resolver `try_join_all` has no concurrency cap. Pass 2 confirmed **3 sites, not 2** as REVIEW-LATER.md claims — recommend updating that entry.
- **PERF-23** — `read_attachment_file` buffers whole file before chunked send. Confirmed unchanged.

### Patterns / Themes (cross-cutting systemic issues)

1. **CQRS write path bypassed in several places.** `set_page_aliases_inner` (commands/pages.rs), `page_aliases` mutation, `update_last_address` (peer_refs.rs), and a handful of cache rebuilds write derived state without an op-log append. These create silent divergence between op_log and materialized tables.
2. **Atomicity gaps in multi-op user actions.** `set_todo_state` + recurrence sibling, `set_page_aliases`, `flush_draft` + `prev_edit` read, `disconnect_gcal` (3 writes), `create_snapshot` (INSERT pending then UPDATE complete), `restore_page_to_op` (read outside write tx) — none use a single `BEGIN IMMEDIATE` even though all are "either both happen or neither" scenarios.
3. **Backpressure silent-drops are wider than documented.** `try_enqueue_background` Full-arm doesn't increment `bg_dropped`; `apply_snapshot` cache-rebuild fan-outs use the same path; `enqueue_full_cache_rebuild` partial-success is invisible. Pass 2 downgraded the severity to Medium but the systemic pattern stands.
4. **Recursive CTE invariants (is_conflict = 0 + depth < 100) are inconsistent.** Production paths in `tag_inheritance` and `pagination::children` are correct; `move_block_inner` cycle CTE, `cascade_soft_delete`, the `tag_query` and `backlink::resolve_root_pages` CTE oracles, and `reindex_block_links` all miss one or both predicates.
5. **Split-pool invariant violated in 5+ places.** `*_split` cache variants (tags, pages, projected_agenda, page_ids), `materializer::sweep_once`, `fetch_link_metadata` (uses WritePool for read-heavy work), and a handful of background tasks ignore the read pool entirely.
6. **Doc / code drift across AGENTS.md, ARCHITECTURE.md, and REVIEW-LATER.md.** AppError variants (11 vs 12 with Gcal); `find_lca` 10000-iter cap claim has no implementation; FTS tokenizer doc says unicode61 but code uses trigram; ARCHITECTURE.md §15 says DB/IO/JSON errors are sanitized but 5 command files skip the helper; REVIEW-LATER PERF-20 site count wrong; ARCHITECTURE.md doesn't mention MCP at all.
7. **Sync hash chain identity is non-cryptographic.** Per `compute_op_hash`, the digest covers `device_id|seq|parent_seqs|op_type|payload` but **not** `prev_hash`. Pass 2 downgraded "data integrity" framing — within the single-user threat model the chain is a deterministic fingerprint, not a Merkle commitment. Filed as a documentation gap.
8. **OAuth & filesystem secret hygiene is good but not perfect.** SecretString redaction tested, keychain-only storage; minor leakage paths exist via classify_refresh_error formatting upstream Display, JWT id_token signature unverified, and partial token leakage on serde error. Bug-report redaction allow-list only catches `$HOME` + local `device_id` — leaks GCal email, peer device IDs.

---

## MEDIUM findings (37 — expanded)

> Each entry is now a fully-detailed block (Domain / Location / What / Why / Cost / Risk / Impact / Recommendation / Pass-1 source / Status) ready to be picked up.

### Materializer


### Cache + Pagination

### M-19 — Unbounded `Vec` materialization on full-vault scans
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/cache/agenda.rs:58-112` (`desired_rows`); `src-tauri/src/cache/block_tag_refs.rs:233-238` (`source_rows`); `src-tauri/src/cache/projected_agenda.rs:90,214` (`entries: Vec`)
- **What:** `rebuild_block_tag_refs_cache_impl` reads `(id, content)` for every non-deleted, non-conflict block into a `Vec<>` and runs the regex across the full content per row. The agenda rebuild materializes both desired-state UNION-ALL rows and the entire current cache into two `HashMap`s. The projected-agenda rebuild buffers a `Vec<(String, String, String)>` of every projection (up to 365 days × every repeating block) before flushing. With ~100K blocks averaging ~1KB content, that is ~100MB on the Rust heap plus `cap[1].to_string()` duplicates.
- **Why it matters:** On larger vaults (or Android, where the footprint is tighter) full-vault rebuilds risk OOMs during snapshot import. Today no streaming alternative exists.
- **Cost:** L
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Stream rows for `block_tag_refs` rebuild via `fetch(...)` and run the regex per row, accumulating only `(source_id, tag_id)` tuples. For agenda rebuild, compute the diff by streaming both sides in `(date, block_id)` sorted order and merging — eliminates the two `HashMap` allocations. For projected-agenda, chunk-flush every ~10K projections into the writer instead of accumulating the entire vault first.
- **Pass-1 source:** 03/F7
- **Status:** Open

### Commands (CRUD)

### M-25 — `list_projected_agenda_inner` returns hard-capped `Vec<>` without cursor pagination
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/agenda.rs:111-214`, Tauri wrapper at `src-tauri/src/commands/agenda.rs:467-476`
- **What:** The command (and its wrapper) returns a flat `Vec<ProjectedAgendaEntry>` clamped to `[1, 500]` with no `next_cursor`. AGENTS.md invariant #3 requires cursor-based pagination on every list query, and ARCHITECTURE.md §22 already lists this query as superlinear at 100K agenda entries — at scale the hard cap silently drops items.
- **Why it matters:** Frontend has no signal that more entries exist beyond the cap, so projected agendas truncate without warning. The cap is a workaround, not a contract.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Change the return type to `PageResponse<ProjectedAgendaEntry>` keyed on `(projected_date, block_id)` from `projected_agenda_cache`, and keep the current cap only as a degenerate first-run behaviour for the on-the-fly fallback.
- **Pass-1 source:** 04/F9
- **Status:** Open

### Commands (System)

### M-34 — `start_pairing_inner` builds a QR with `host=0.0.0.0, port=0`
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/sync_cmds.rs:91-109` (function), `src-tauri/src/commands/sync_cmds.rs:97` (QR payload), `src-tauri/src/commands/sync_cmds.rs:107` (`port: 0`)
- **What:** The QR payload is `pairing_qr_payload(&passphrase, "0.0.0.0", 0)` and the returned `PairingInfo.port` is also `0`. ARCHITECTURE.md §18:1446 says the QR JSON is `{"passphrase":"...","host":"...","port":12345}`; the scanning device cannot use the QR to bootstrap a direct connection and must fall back to mDNS for both discovery and address resolution.
- **Why it matters:** Either the QR-as-bootstrap design has been abandoned (in which case the host/port fields should be removed and §18 updated) or it is supposed to work and is broken. Both interpretations need a fix; the current state is doc/code drift.
- **Cost:** M — wiring the live SyncServer port into managed state and through to `start_pairing_inner` is small, but the architectural question (do we need scan-bootstrapped pairing at all, or only passphrase + mDNS?) is a decision point per AGENTS.md "Architectural Stability".
- **Risk:** Medium (touches SyncServer plumbing)
- **Impact:** Medium
- **Recommendation:** Decide intent with the user. If the QR carries a real `host:port`, thread the SyncServer's bound `(local_ip, port)` into the wrapper; if not, drop those fields from `pairing_qr_payload` + `PairingInfo` and update §18. **Requires user approval per AGENTS.md Architectural Stability — wire-format choice between bind-address and rendezvous-string semantics.**
- **Pass-1 source:** 05/F19 (cross-ref 06/F2)
- **Status:** Open



### Sync stack




### M-51 — Both file send and receive buffer the entire file in memory
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_files.rs:182-195` (`read_attachment_file`); `:233-326` (sender); `:436-455` (`receive_binary_data`)
- **What:** `read_attachment_file` does `std::fs::read(&full_path)` into a `Vec<u8>`, then `blake3::hash(&data)`, then chunks on the wire. The receiver accumulates all chunks into a single `Vec<u8>` before calling `write_attachment_file`. A 1 GB attachment requires ~1 GB of RAM on each side simultaneously.
- **Why it matters:** Phones with limited RAM will OOM during a single large attachment transfer (e.g., a screen recording). The same shape applies to snapshot transfer (see L-67). On Android this is a real ceiling.
- **Cost:** L
- **Risk:** Medium-High (rewrite both halves to streaming + streaming blake3)
- **Impact:** High (unblocks large attachments)
- **Recommendation:** Stream: open the source file, read 5 MB at a time into a fixed buffer, feed each chunk into a `blake3::Hasher` and `send_binary` the same chunk. Receiver writes incrementally to a temp file, finalises hash, renames atomically on success (and unlinks the temp file on failure). `blake3::Hasher` already supports incremental updates.
- **Pass-1 source:** 06/F16
- **Status:** Open





### Search & Links

### Lifecycle / Snapshots / Merge / Recurrence


### M-81 — `cascade_soft_delete` ignores conflict copies — orphaned
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/soft_delete/trash.rs:46-55`
- **What:** The recursive CTE filters `b.is_conflict = 0` per invariant #9. A conflict copy whose source is in the cascade subtree is preserved (correct per the invariant), but its `parent_id` points into the now-soft-deleted subtree. After cascade, the conflict copy is reachable by direct lookup but invisible to any descendants walk that filters `deleted_at IS NULL` — orphan blocks floating with no parent context.
- **Why it matters:** Conflict-copy lifecycle has no clear story when the source's subtree is deleted; Trash view excludes conflict copies, so users cannot manually clean them up.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Discuss with user — semantics decision. Options: (a) include conflict copies in the cascade (relaxes invariant #9 for `cascade_soft_delete` only); (b) re-parent conflict copies to the cascade's nearest non-deleted ancestor and log; (c) document the orphan state and add a "review orphans" UI surface. Any of these may need user approval per Architectural Stability.
- **Pass-1 source:** 08/F27
- **Status:** Open

### MCP

### M-85 — `list_tags` / `list_property_defs` / `get_agenda` lack cursor pagination
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/tools_ro.rs:384-401` (list_tags schema), `src-tauri/src/mcp/tools_ro.rs:403-413` (list_property_defs), `src-tauri/src/mcp/tools_ro.rs:415-453, 528-548` (get_agenda); inners `src-tauri/src/commands/tags.rs:257-262`, `src-tauri/src/commands/properties.rs:459-469`, `src-tauri/src/commands/agenda.rs:117-122`.
- **What:** Three list-style RO tools return a flat `Vec<...>` with a server-side cap (100/500) and no `cursor` / `next_cursor` / `has_more` field, in violation of AGENTS.md invariant #6 ("Cursor-based pagination on ALL list queries — no offset pagination"). The other list tools (`list_pages`, `get_page`, `search`, `list_backlinks`) do paginate, so the asymmetry is internal.
- **Why it matters:** A power user with thousands of agenda entries (multi-year repeating tasks) or hundreds of tags hits a silent ceiling; nothing in the response signals truncation. The hard invariant is the invariant, and the MCP layer is the only place it currently leaks.
- **Cost:** M
- **Risk:** Low (extending shared `*_inner` helpers must stay backward-compatible with frontend callers)
- **Impact:** Medium
- **Recommendation:** Either extend the inners to return a `PageResponse<T>` with cursors (modeled on `list_pages_inner`) and surface them in the MCP schema, or — as a backward-compatible interim — add a `truncated: bool` field to the response and document the cap. **Requires user approval per AGENTS.md Architectural Stability — adds cursor pagination to the public MCP tool surface.**
- **Pass-1 source:** 09/F5
- **Status:** Open

### GCal / Spaces / Drafts

### M-95 — `recover_calendar_gone` does not also clear `oauth_account_email`
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/connector.rs:727-741`
- **What:** When the calendar is gone, the connector wipes the event map and resets `calendar_id`, but `oauth_account_email` is left untouched. The Settings UI continues to show "connected as user@example.com" while the connector has just reset to "no calendar yet".
- **Why it matters:** Cosmetic UX consistency — does not affect correctness of the push pipeline. Listed Medium in the M- numbering for parity with M-89's transaction concern, but this is purely a Settings-tab display drift.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either leave as-is (the email is still the right one — only the calendar reset) or, if FEAT-5f explicitly differentiates "connected, no calendar yet" from "calendar recreated since last open", refresh `oauth_account_email` from the most recent token's id_token claim during the recreate path. Lean toward leaving as-is unless FEAT-5f spec calls for the distinction.
- **Pass-1 source:** 10/F23
- **Status:** Open

## LOW findings (7 — expanded)

> Each entry is a fully-detailed block (Domain / Location / What / Why / Cost / Risk / Impact / Recommendation / Pass-1 source / Status).

### Materializer

### L-17 — `dispatch_op` enqueues fg+bg out of order
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/dispatch.rs:98-102`
- **What:** `dispatch_op` calls `enqueue_foreground(ApplyOp(record))` then `enqueue_background_tasks(record, None)`. The two queues have independent consumers — the bg consumer can pull e.g. `RebuildTagsCache` and execute it before the fg consumer has applied the `CreateBlock(tag)` to `blocks`. The cache rebuild then reads pre-op state and `tags_cache` stays stale until the next op happens to re-enqueue the rebuild. Production paths use `dispatch_background_or_warn` *after* the command has committed the op, so this race is mostly limited to test code (and `sync_daemon/snapshot_transfer.rs:451`, which is itself a test helper); it is downgraded from Medium for that reason.
- **Why it matters:** For the test paths (and the snapshot-transfer test helper) it shrinks the window of correctness for the very-first op of its kind. If `dispatch_op` is ever adopted on a production code path it becomes a real correctness hazard ("created a tag, search doesn't find it" until I create another).
- **Cost:** M (2-8h)
- **Risk:** Medium
- **Impact:** Low
- **Recommendation:** Either (a) move the bg fan-out *into* the fg consumer so it runs only after `apply_op_tx` commits — making the consumer the single scheduler of per-op derived work; or (b) thread a `Notify` keyed on `(device_id, seq)` and have the bg side `notified().await` before running the rebuild it spawned. (a) is cleaner.
- **Pass-1 source:** 02/F10
- **Status:** Open

### Commands System

### L-53 — `cancel_pairing` clears pairing slot whether or not a session exists
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/sync_cmds.rs:152-158`
- **What:** `cancel_pairing_inner` sets the slot to `None` unconditionally and returns `Ok(())`; there is no error if no session was active. Combined with the lack of validation in `confirm_pairing_inner` (Pass-1 F16), the entire `pairing_state` slot is effectively write-only — only `start_pairing` writes it; `confirm_pairing` and `cancel_pairing` always overwrite with `None`.
- **Why it matters:** Symptom of broader pairing-state ownership confusion. Once the F16 fix lands (`confirm_pairing` actually validates against the slot), this becomes the natural "no-op if absent" path; until then, the slot has no observable effect.
- **Cost:** N/A (closes alongside the F16 fix tracked elsewhere as a High in REVIEW-LATER)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Bundle into the F16 / confirm_pairing fix; once `confirm_pairing` reads and validates the slot, `cancel_pairing` can keep its current "no-op if empty" semantics with a debug log.
- **Pass-1 source:** 05/F32
- **Status:** Open

### L-55 — `redact_log` newline split-and-rejoin is O(n²) in the worst case
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/bug_report.rs:229-242` (`redact_log`), `src-tauri/src/commands/bug_report.rs:202-226` (`redact_line`)
- **What:** `redact_log` iterates `split_inclusive('\n')`, calls `redact_line` (which does two `String::replace` calls — each a linear scan with allocation: home, then device_id), then pushes back into `out`. For a 2 MB file this is two full-buffer linear scans per line, multiplied by the line count. `MAX_LINE_BYTES` truncation happens *after* the replace, so the replace itself sees the original full-length line.
- **Why it matters:** A bug report on a workstation with thousands of large stack-trace lines could take seconds. Mitigated by the 2 MB file cap.
- **Cost:** M — switch to a single-pass replacer (e.g. `aho_corasick` or a hand-written matcher over the static needles).
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Acceptable as-is until profiling shows it is a bottleneck; lower priority than M-31 / L-41. If/when fixed, a single-pass `replace_n` over both needles avoids allocations.
- **Pass-1 source:** 05/F35
- **Status:** Open

### Sync

### L-67 — Snapshot receiver allocates a single `Vec<u8>` of up to 256 MB
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_daemon/snapshot_transfer.rs:372-405`; cap at `:285-300` (`MAX_SNAPSHOT_SIZE`)
- **What:** `let capacity = usize::try_from(size_bytes).unwrap_or(usize::MAX); let mut data: Vec<u8> = Vec::with_capacity(capacity);` — the cap enforcement at line 285-300 bounds the allocation to 256 MB, but the entire payload is buffered before `apply_snapshot`. Note this is **not** the same shape as the OUT-OF-SCOPE F11/F12 (no unbounded behaviour: the cap exists and works); just a perf concern.
- **Why it matters:** Large initial onboarding via snapshot is a real path; on Android with limited RAM, 256 MB plus the decompression+restore working set can OOM the daemon. Cap is correct, footprint is not.
- **Cost:** M
- **Risk:** Medium (cross-cutting refactor of `apply_snapshot` to take `impl Read`)
- **Impact:** Medium
- **Recommendation:** Stream-decode into a temp file (or a bounded ring buffer) and refactor `apply_snapshot` to accept `impl Read` so `zstd::stream::Decoder + tokio::io::copy` can pipe through. Pair with M-51 since the patterns are siblings.
- **Pass-1 source:** 06/F40
- **Status:** Open

### Search & Links

---

## Closing notes

- The Pass-1 reviewers were unusually accurate: across 348 findings, only 2 outright hallucinations and 5 out-of-scope claims. Severity inflation was the dominant correction (49 downgrades).
- The `sanitize_internal_error` doc/code drift in particular is a recurring pattern: ARCHITECTURE.md §15 over-claims; five command files actually skip the helper. Pass 2 was right to downgrade this from "Security/High" to "Docs/Low" — the helper's own docstring says it's UX-only.
- The most consequential pattern is the **ApplyOp permanent-failure black hole** (C-2). Fixing it likely doesn't require new schema — a boot-time replay path against `op_log` would close the loop within the existing CQRS model — but it's the single most impactful change available.
- **GCal connector dead code (C-1)** is fixable in a single afternoon if the `run_cycle` is genuinely correct (Pass 2 confirmed it is, per its tests). The fix is wiring, not redesign.
- Fixing **C-3 (attachment file leak)**, **H-1 (pairing passphrase)**, **H-2 (MCP toggle)**, and **H-3 (create_page_in_space bypass)** together would close the four most user-visible behavioral defects in the codebase. None require architectural change beyond one carrying `fs_path` in `DeleteAttachment` (op log payload extension, allowed under Architectural Stability).
