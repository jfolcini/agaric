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

45 open items.

Previously resolved: 422+ items across 149 sessions.

| ID | Section | Title | Cost |
|----|---------|-------|------|
| FEAT-3 | FEAT | Spaces — parent / umbrella (Phases 1 + 2 shipped; Phases 3–6 split into FEAT-3p3..FEAT-3p6) | S |
| FEAT-3p3 | FEAT | Spaces Phase 3: per-space tabs + per-space recent pages (`tabsBySpace` + `recentPagesBySpace` refactor) | M |
| FEAT-3p4 | FEAT | Spaces Phase 4: agenda / graph / backlinks / tags / properties scoping (largest remaining slice) | L |
| FEAT-3p5 | FEAT | Spaces Phase 5: per-space journal (J1) + per-space journal templates | M |
| FEAT-3p6 | FEAT | Spaces Phase 6: polish (keyboard shortcuts, space management UI, brand identity, collapsed-icon indicator) | M |
| FEAT-4 | FEAT | Agent access: expose notes to external agents via an MCP server — parent / umbrella | L |
| FEAT-4i | FEAT | MCP v3 — Mobile (HTTPS/LAN via mTLS reuse from `sync_cert.rs`, agent-pairing flow) — DEFERRED pending v2 | L |
| FEAT-5 | FEAT | Google Calendar daily-agenda digest push (Agaric → dedicated GCal calendar) — parent / umbrella | L |
| FEAT-5g | FEAT | GCal: Android OAuth + background connector (DEFERRED — design sketch only) | L |
| FEAT-10 | FEAT | Adopt `tauri-plugin-deep-link` — Android OAuth callback (unblocks FEAT-5g), `agaric://` URLs, OS-level settings deep-link (composes with UX-276) | M |
| FEAT-11 | FEAT | Adopt `tauri-plugin-notification` — OS notifications for due tasks / scheduled events (Org-mode parity, especially on mobile) | L |
| FEAT-12 | FEAT | Adopt `tauri-plugin-global-shortcut` — desktop-wide quick-capture hotkey into today's journal | M |
| FEAT-13 | FEAT | Adopt `tauri-plugin-autostart` — launch on login so sync daemon, agenda, and notifier are warm at boot (desktop only) | S |
| PERF-19 | PERF | Backlink pagination cursor uses linear scan for non-Created sorts (2 sites) | S |
| PERF-20 | PERF | Backlink filter resolver has no concurrency cap on `try_join_all` | S |
| PERF-23 | PERF | `read_attachment_file` buffers whole file before chunked send | S |
| BUG-1 | BUG | Markdown serializer/parser round-trip splits code blocks whose content contains a line starting with three backticks | M |
| MAINT-96 | MAINT | Decompose `AgentAccessSettingsTab.tsx` (910 lines) and extract inline `AddFilterRow` from `BacklinkFilterBuilder.tsx` (lines 234–553) | M |
| MAINT-99 | MAINT | No automated enforcement for several documented test rules (axe-audit per component test, IPC-error-path coverage, test file naming convention) | M |
| MAINT-101 | MAINT | `tag-colors.ts` is localStorage-only despite header comment claiming property-sync persistence | M |
| MAINT-103 | MAINT | `BlockPropertyEditor` inline editor uses absolute positioning without portal — should follow the `suggestion-renderer` pattern | M |
| MAINT-106 | MAINT | Adopt `tauri-plugin-single-instance` — guard against two SQLite pools racing on the same DB when the user double-launches | S |
| MAINT-107 | MAINT | Replace `navigator.clipboard.writeText` (5 call-sites) with `tauri-plugin-clipboard-manager` for cross-platform reliability | S |
| MAINT-108 | MAINT | Adopt `tauri-plugin-window-state` — remember window size / position / monitor / maximized state across launches | S |
| MAINT-109 | MAINT | Adopt `tauri-plugin-os` — refactor `collect_bug_report_metadata` to use the plugin's platform/version/arch/locale/hostname API | S |
| TEST-2 | TEST | ~30 wrapper functions in `src/lib/tauri.ts` lack individual tests beyond the shallow cross-cutting test (only command-name verified, not `null` defaults / arg shape) | M |
| TEST-3 | TEST | Browser/E2E `tauri-mock` `revert.ts` only handles 5 of 13 reversible op types — undo/redo for property/tag/state ops is a silent no-op in mock; can't be E2E-tested | M |
| TEST-4 | TEST | 25 of 26 Playwright specs lack a console-error listener — backend / mock errors leak silently in every E2E suite except `smoke.spec.ts` | M |
| TEST-5 | TEST | `property-picker.test.ts` (6 tests) and `checkbox-input-rule.test.ts` (17 tests) exercise extension config + regex only, not editor integration | M |
| TEST-6 | TEST | `LinkEditPopover.test.tsx` weak-assertion sub-batch — 36 `toHaveBeenCalled()` sites need tightening to `toHaveBeenCalledWith(...)` (other 7 sub-files closed in session 479) | M |
| TEST-11 | TEST | 7 E2E specs use CSS-class selectors (23 instances total) instead of `data-testid` per the documented selector convention | M |
| UX-257 | UX | Breadcrumb bar (zoom + page header) doesn't read as a breadcrumb, is oversized, and styling is inconsistent across the two surfaces | M |
| UX-260 | UX | Discoverability sweep for keyboard shortcuts and gestures (sidebar swipe, journal nav, undo tiers, Shift+Click range, properties drawer shortcut, Ctrl+F, KeyboardShortcuts→Settings link) | M |
| UX-263 | UX | Pairing flow polish (countdown SR announcements, ordinal labels, address/rename validation, mid-pair close guard, countdown pause while typing) | M |
| UX-264 | UX | Sync error UX (no retry action on failure toast, no online/offline transition feedback, no batch progress, camera-permission denial leaves user stuck on QR mode) | M |
| UX-265 | UX | Conflict UI improvements (Keep/Discard label clarity, sort/filter for large conflict sets, type-badge tooltips, missing-original-block fallback, large-diff handling) | M |
| UX-269 | UX | `SearchPanel` consolidation — switch custom load-more to shared `LoadMoreButton`, fix aria-live placement, debounce visual feedback, CJK notice placement, alias-overlay positioning, results-count announcement | M |
| UX-270 | UX | `GraphView` a11y + filter persistence — bare `overflow-y-auto` → `ScrollArea`, redundant aria-label on labelled checkboxes, `role="img"` on interactive SVG, filter state reset on every navigation | M |
| UX-272 | UX | Properties drawer / picker polish (no-pages empty-state styling, AND/OR/NOT mode affordance, definitions-loading state, date-input debounce, choice options count + reorder, disabled "Add option" when empty, type badge for "Create new", ref-save spinner) | M |
| UX-273 | UX | Inline link UX — `LinkPreviewTooltip` only fires on hover (no keyboard activation); suggestion popups don't handle viewport edges on mobile | M |
| UX-274 | UX | Agenda views — `DateChipEditor` parse error not shown on input itself; `QueryResult` error has no retry; `RescheduleDropZone` has no keyboard alternative; per-group collapse not persisted; empty-filter validation silent; `DuePanel` projected entries skipped by keyboard nav; `QueryBuilderModal` accepts unknown property keys | M |
| UX-275 | UX | History view UX gaps — Restore-to-here wording, non-reversible icon a11y, missing inline filter clear, DiffDisplay hunk navigation, descendant-count badge wrap, batch keyboard shortcuts, restore-action missing undo toast, checkbox row-click ambiguity, generic error banner, no batch-restore confirmation | M |
| UX-277 | UX | `BugReportDialog` log-content preview before submit (Checkbox primitive swap + success toast shipped; log preview pending — may be superseded by H-9c) | M |
| UX-281 | UX | Gutter-button tooltips invisible on touch — gutter is fixed at 68px, three buttons already inflate to 44×44 on `pointer:coarse` so inline labels would overflow; needs a different affordance (long-press → toast, or wider gutter / drawer on touch) | S |
| UX-282 | UX | `src/lib/announcer.ts` exists with `announce.*` i18n keys but is invoked from very few places — paid-for accessibility utility is largely unused | M |
| PUB-2 | PUB | Git author email across all history is corporate (`javier.folcini@avature.net`) | S |
| PUB-3 | PUB | Employer IP clearance before public release | S |
| PUB-5 | PUB | Tauri updater — wire endpoint URL + Minisign keypair (publish target is now jfolcini/agaric) | S |
| PUB-7 | PUB | Missing `SECURITY.md` — private-disclosure contact pending publish target | S |
| PUB-8 | PUB | Android release keystore + 4 GH Actions secrets (apksigner wiring already shipped in `release.yml`) | S |
| PUB-9 | PUB | Windows code signing — apply for SignPath Foundation OSS sponsorship, then provision 2 GH Actions secrets (signtool wiring already shipped) | M |

> **`PUB-*` statuses are heterogeneous now that the publish target is concrete (`github.com/jfolcini/agaric`).**
> PUB-5 / PUB-8 are ACTIONABLE; PUB-9 is BLOCKED on SignPath Foundation approval; PUB-2 / PUB-3 / PUB-7 remain DEFERRED on the identity / employer-IP / disclosure-contact decisions. See each item's detail section below for the per-item status line and concrete next steps.

---

## FEAT — Planned Feature Improvements

### FEAT-3 — Spaces: partition pages into user-defined contexts (work / personal)

> **Navigation-cluster context (FEAT-7/8/9 already shipped):** the shell-level TabBar hoist, active-tab dropdown switcher, and Recent-pages strip landed against the global `useNavigationStore.tabs` + `useRecentPagesStore.recentPages` models. Phase 3 of FEAT-3 is what refactors both of those into per-space state: `tabs` → `tabsBySpace: Record<SpaceId, Tab[]>`, `recentPages` → `recentPagesBySpace: Record<SpaceId, string[]>`. The already-shipped component DOM + styling stays; only the selector / data source shifts. One-line swaps in `TabBar.tsx` + `RecentPagesStrip.tsx` + `keyboard-config.ts`.

**Problem:** A user wants to partition notes into independent contexts (e.g. "work" and "personal") and switch between them quickly during the day without seeing cross-context data. The app currently presents a single undifferentiated vault: pages, tags, properties, agenda, graph, backlinks, tabs, and the journal all share one namespace.

**User decisions recorded up front (do not re-litigate during implementation):**

- **Per-space journal (J1).** Each space owns its own daily note. Today's journal page is keyed by `(date, current_space_id)`, not by `date` alone. Daily pages in different spaces coexist with the same title.
- **Per-space tabs.** Tabs are scoped to the active space. Switching space swaps the tab set. No tab shows pages from multiple spaces.
- **Nothing outside of spaces.** Every page must belong to exactly one space. No "All" pseudo-space, no unassigned pages, no cross-space "show everything" view. If the user needs to see another context, they switch space.

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
3. **Per-space tabs + per-space recent.** Refactor `useNavigationStore` to `tabsBySpace` AND `recentPagesBySpace` in the same session (see Navigation-cluster preamble). Tests for space-deletion corner case, rehydrate with stale `currentSpaceId`.
4. **Agenda / graph / backlinks / tags / properties.** Remaining query commands gain the filter: `list_undated_tasks`, `list_projected_agenda`, `query_by_tags`, `query_by_property`, `list_page_links`, `get_backlinks`, `list_backlinks_grouped`, `query_backlinks_filtered`, `count_agenda_batch*`. Migrate corresponding frontend callsites (`useBlockTags`, `agenda-filters`, `GraphView.helpers`, `export-graph`, backlinks views, `TrashView`, `useResolveStore.preload()`, template helpers, property UI). Status-bar chip showing the active space name (follows existing sync-status chip pattern). Also the optional Phase 3 polish: a subtle "Pages in \<SpaceName\>" header on the link-picker suggestions so the current-space scoping isn't silent (UX reviewer P2-2).
5. **Per-space journal (J1).** Daily-page lookup by `(date, space)`. Per-space journal templates via a `journal_template` property on each space block. JournalPage's 4 internal `createBlock({blockType: 'page'})` callsites route through `createPageInSpace`.
6. **Polish.** Keyboard shortcuts (`switchSpace` / `cycleSpace`), space management UI (rename, delete-only-if-empty per user decision — no soft-delete and no reassign-on-delete flow; the delete button is disabled until the space is empty), optional space icon/color, onboarding for second space. Two Phase 1 UX follow-ups land here as well: (a) restore brand identity in the sidebar (tooltip, persistent footer chip, or similar — window title + favicon currently carry the identity alone); (b) add a collapsed-icon-sidebar space indicator (e.g. 32px circle with the first letter of the space name + tooltip) so users can see and switch spaces without expanding the sidebar.

**User decisions locked in (do NOT re-litigate):**

- **Seeded spaces count:** 2 — "Personal" + "Work".
- **Bootstrap:** deterministic genesis ops (two reserved ULIDs above) + local upgrade ops for existing pages.
- **Space deletion:** forbid deleting a non-empty space (no soft-delete, no reassign-on-delete).
- **Cross-space links:** forbidden at author time (picker is current-space-only, no opt-in). Existing `[[ULID]]` targets in another space render as broken-link chips (the existing broken-link UX).
- **Graph view:** no cross-space edges to render (follows from the previous decision).
- **Export:** markdown export references only stay within the current space (follows from the previous decision).
- **First-boot UI:** LoadingSkeleton on space-scoped panels until `useSpaceStore.isReady === true`.
- **Search operator:** the switcher is the only scoping surface — no `space:<name>` operator.

**Cost:** S — this umbrella entry is now a tracker only. Each remaining phase is filed as its own item: FEAT-3p3 (tabs/recent), FEAT-3p4 (agenda/graph/backlinks), FEAT-3p5 (journal), FEAT-3p6 (polish). Schedule via the per-phase items, not this umbrella.

**Status:** IN PROGRESS — Phases 1 + 2 shipped. Remaining work tracked under FEAT-3p3 / FEAT-3p4 / FEAT-3p5 / FEAT-3p6.

### FEAT-3p3 — Spaces Phase 3: per-space tabs + per-space recent pages

**Problem:** `useNavigationStore.tabs` and `useRecentPagesStore.recentPages` are still global. Switching space does not swap the tab set or the recent strip, so cross-space context bleeds through the navigation surface (visible in TabBar + RecentPagesStrip + the sidebar tab dropdown).

**Scope (one focused session — both refactors must land together):**

- `useNavigationStore`: `tabs: Tab[]` → `tabsBySpace: Record<SpaceId, Tab[]>`, `activeTabIndex: number` → `activeTabIndexBySpace: Record<SpaceId, number>`. Every action (`navigateToPage`, `goBack`, `openInNewTab`, `closeTab`, `switchTab`, `selectPageStack`) reads/writes the current space's slice. Persistence `partialize` serializes the full map; on rehydrate, if the persisted `currentSpaceId` no longer resolves, fall back to the first existing space.
- `useRecentPagesStore`: `recentPages: string[]` → `recentPagesBySpace: Record<SpaceId, string[]>`. Same dedup + MRU rules per-space. Switching space swaps the strip. Visits never cross space boundaries.
- One-line swaps in `TabBar.tsx`, `RecentPagesStrip.tsx`, the active-tab dropdown switcher, and `keyboard-config.ts` (selectors / data sources only — DOM and styling stay).
- FEAT-7 autohide guard preserved: tab bar hides when the current space has ≤1 tab.
- Space deletion requires closing/reassigning all tabs in that space (Phase 6 closes the loop on the deletion UI; this phase ensures the data-shape supports it).

**Testing (per AGENTS.md):**
- Persistence round-trip for `tabsBySpace` and `recentPagesBySpace`.
- Rehydrate with a stale `currentSpaceId` — falls back cleanly.
- Per-space dedup invariants (property test): `recentPagesBySpace[s]` is dedup'd per-space; entries never duplicate the page in another space's list.
- Cross-space tab-open never affects another space's tab list.

**Cost:** M — single focused session.
**Status:** Open. Schedulable any time after FEAT-3 Phases 1 + 2 (already shipped).

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

**Cost:** L — biggest remaining FEAT-3 slice (10+ commands × backend + 7+ frontend areas + property tests). Realistic estimate: 1–2 focused sessions.
**Status:** Open. Depends on FEAT-3 Phases 1 + 2 (shipped). Independent of FEAT-3p3, FEAT-3p5, FEAT-3p6.

### FEAT-3p5 — Spaces Phase 5: per-space journal (J1) + per-space journal templates

**Problem:** `commands/journal.rs::resolve_or_create_journal_page` still finds journal pages by `title = YYYY-MM-DD` only. With multiple spaces, two devices in different spaces both create a "today's journal" page that collides on title and (if hash-equal) on materialized state. Per the locked-in J1 decision: each space owns its own daily note.

**Scope:**
- `commands/journal.rs::resolve_or_create_journal_page` daily-page lookup changes from "find page where `title = YYYY-MM-DD`" to "find page where `title = YYYY-MM-DD` AND `space = current`".
- Atomic-creation path: when creating today's journal page, set its `space` property in the same `BEGIN IMMEDIATE` transaction. Routes through `create_page_in_space` (this phase formalizes the route; H-3 from the backend review tracks the bypass cleanup).
- Per-space journal templates via a `journal_template` property on each space block. No new schema — properties extension point.
- Frontend: `JournalPage`'s 4 internal `createBlock({blockType: 'page'})` callsites route through `createPageInSpace`. (H-3a/H-3b cover the broader bypass cleanup; this phase covers the specific journal callsites.)

**Testing:**
- Journal per-space lookup, including the transition from "no journal today" to "journal created in current space".
- Two spaces with the same date both have their own daily note; switching space swaps which one shows.
- Journal template fetched per-space.

**Cost:** M — single focused session.
**Status:** Open. Depends on FEAT-3 Phases 1 + 2 (shipped). Couples loosely with H-3a / H-3b (backend `create_block` IPC enforcement) — recommend landing H-3a first, then this.

### FEAT-3p6 — Spaces Phase 6: polish (keyboard shortcuts, management UI, brand identity, collapsed-icon indicator)

**Problem:** The locked-in Phase 6 polish items have not landed: keyboard shortcuts to switch / cycle spaces, the space management UI (rename, delete-only-if-empty), and the two Phase 1 UX follow-ups about brand identity and collapsed-sidebar discoverability.

**Scope:**
- Keyboard shortcuts in `keyboard-config.ts`: `switchSpace` (default Ctrl+Shift+S, opens a `SearchablePopover` to jump by name) and `cycleSpace` (default Ctrl+Alt+S, rotates through spaces).
- Space management UI: rename, delete (delete button DISABLED until the space is empty — no soft-delete, no reassign-on-delete flow per user decision), optional space icon/color, onboarding for second space.
- Brand identity restoration in the sidebar (tooltip, persistent footer chip, or similar — window title + favicon currently carry the identity alone).
- Collapsed-icon-sidebar space indicator (e.g. 32px circle with the first letter of the space name + tooltip) so users can see and switch spaces without expanding the sidebar.

**Testing:**
- Shortcut handler registered and callable; cycle wraps.
- Delete button disabled state: hover tooltip explains why; switches to enabled when the space is empty; confirmation dialog on enable+click.
- Rename round-trips through the property write.
- a11y: every new control has `aria-label`, focus-visible ring, touch-target compliance per AGENTS.md frontend guidelines.

**Cost:** M — single focused session.
**Status:** Open. Depends on FEAT-3 Phases 1 + 2 (shipped). Independent of FEAT-3p3 / FEAT-3p4 / FEAT-3p5 — schedulable any time.

### FEAT-4 — Agent access: expose notes to external agents via an MCP server

**Problem:** External agents (Claude Desktop, Claude Code, Cursor, Devin, Continue, etc.) cannot read from or write to the user's notes. The user wants to let agents interact with their vault in a controlled way — starting with desktop, potentially extending to mobile later — without handing over the database file or bypassing the op-log / CQRS invariants.

Out of scope for this item: cloud-hosted inference, remote agents, multi-user authorization, any non-local transport (see "Mobile" below for the deferred story).

**User decisions recorded up front (do not re-litigate during implementation):**

- **Two sockets, not one.** Read-only access and read-write access live on **separate** Unix-domain sockets (named pipes on Windows) with independent toggles. No runtime scope negotiation, no per-tool allowlist in v1. User points their agent at whichever socket they want to grant.
- **Read-only first.** v1 ships the RO socket + 8 read tools only. Write tools are deferred to v2 so the user can live with read-only agents before granting mutation. The architecture must leave the RW slot obviously open so v2 is purely additive.
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

### FEAT-10 — Adopt `tauri-plugin-deep-link` (Android OAuth + `agaric://` URLs + settings deep-link)

**Problem:** Three otherwise-unrelated needs all converge on OS-level URL routing:

1. **Android OAuth (FEAT-5g blocker).** REVIEW-LATER FEAT-5g lists `tauri-plugin-oauth`'s loopback HTTP listener as the open Android question — Android sandboxes inbound TCP listeners. The Custom-Tabs + PKCE + App-Link flow that every other Android app uses needs an OS deep-link callback (`agaric://oauth/callback`) that only `tauri-plugin-deep-link` provides cleanly.
2. **External agent / automation surface.** FEAT-4 (MCP) and the agenda views would benefit from `agaric://block/<ULID>` and `agaric://page/<ULID>` URIs callable from outside the app — terminal scripts, OS notifications, Spotlight/Files context-menu items.
3. **Settings deep-link (UX-276).** UX-276 is currently scoped to in-app `?settings=keyboard` query params via `useNavigationStore`. Once the OS scheme is registered, `agaric://settings/keyboard` extends the same deep-link path to OS-level shortcuts and shared support links.

**Fix:** Register the `agaric` scheme via `tauri-plugin-deep-link`. Backend: capture inbound deep-links in `lib.rs` setup, dispatch to a small router (`src-tauri/src/deeplink/mod.rs`) that maps schemes to existing commands (`get_block`, navigate-to-page, set-settings-tab). Frontend: a `useDeepLinkRouter` hook that listens on the `deep-link://new-url` event and feeds the navigation / settings stores. Coupled stack (AGENTS.md §"Coupled Dependency Updates") — bump in lockstep with the rest of the Tauri plugin set.

**Cost:** M.
**Risk:** M — adds an OS-level entry point; needs careful scheme-registration tests on each platform (Linux .desktop, macOS Info.plist, Windows registry, Android intent filter).
**Impact:** L on Android (unblocks FEAT-5g), M on desktop (UX-276 + automation surface).

### FEAT-11 — Adopt `tauri-plugin-notification` (OS notifications for due tasks / scheduled events)

**Problem:** The app has agenda + due dates + scheduled dates + repeat properties + projected agenda + the Google Calendar push connector (FEAT-5), but zero OS-level notification path. A user with "buy groceries — DUE 09:00" cannot be notified by the OS unless the GCal push has already fired and their calendar app shows it. Org-mode / Logseq users expect "10 minutes before scheduled" and "due now" to surface as native notifications.

**Fix:** Adopt `@tauri-apps/plugin-notification` + `tauri-plugin-notification`. New backend module `src-tauri/src/notifier/mod.rs` schedules notifications based on `due_date` + `scheduled_date` + property events from the materializer (analogous to `gcal_push::DirtyEvent`). Reuses the existing `agenda_view` queries to find blocks within the next-24h window on boot and on every materialize commit. Frontend: a Settings tab toggle + per-property filter. Mobile permissions: request `POST_NOTIFICATIONS` on Android 13+ via the plugin's permission API. Coupled stack — bump with the rest of the Tauri plugins.

**Cost:** L — design (which events fire? how to dedupe? snooze semantics?), backend scheduler (~6 files), one Settings sub-tab, mobile permission flow, ~25 tests.
**Risk:** M — wrong-time notifications and notification spam are both real failure modes; needs careful dedupe and "do not re-fire on materialize replay" guard.
**Impact:** L — closes a recognised feature gap with Org-mode / Logseq parity; especially valuable on mobile where the user is unlikely to have the app foregrounded when a task is due.

### FEAT-12 — Adopt `tauri-plugin-global-shortcut` (quick capture)

**Problem:** "Press a global hotkey from anywhere → drop a line into the inbox / today's journal" is a canonical feature for Org-mode and Logseq users. Currently the app has no global capture path: the user must focus the window, navigate to the journal, click a block, and type. This is the friction that drives "I gave up on note-taking" stories.

**Fix:** Adopt `@tauri-apps/plugin-global-shortcut` + `tauri-plugin-global-shortcut`. A new "Quick capture" Settings sub-tab with a single shortcut binding (default Ctrl+Alt+N on Linux/Windows, Cmd+Option+N on macOS, configurable). The shortcut focuses the window if hidden, opens a small modal `<QuickCaptureDialog />` (reuse `ui/dialog.tsx`), captures one block of input + optional tags, dispatches `create_block` against today's journal page, and closes. Desktop only (Android / iOS have no global-shortcut concept). Coupled stack — bump with the rest of the Tauri plugins.

**Cost:** M.
**Risk:** M — global shortcuts collide with OS shortcuts on a per-OS basis; the binding UI must surface conflicts gracefully.
**Impact:** M — new user-facing capability; the kind of feature returning Org-mode users immediately ask for.

### FEAT-13 — Adopt `tauri-plugin-autostart` (launch on login)

**Problem:** The sync daemon, agenda, and (post-FEAT-11) notifier all benefit from being live whenever the user is logged in, not just when they remember to launch the app. Currently the app must be manually started after every reboot, which means missed notifications, stale agenda, and a sync-window gap between login and first launch.

**Fix:** Adopt `tauri-plugin-autostart` + `@tauri-apps/plugin-autostart`. Settings → General gains a "Launch on login" toggle. Desktop only — Android handles this via foreground service / WorkManager (covered under FEAT-5g for the GCal connector). Coupled stack — bump with the rest of the Tauri plugins.

**Cost:** S.
**Risk:** S — plugin handles per-OS plumbing (XDG autostart `.desktop`, macOS `LaunchAgents`, Windows registry).
**Impact:** M — quality-of-life; only fully meaningful once FEAT-11 (notifications) ships.

---

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

## BUG — Correctness items surfaced during review

### BUG-1 — Markdown round-trip splits code blocks whose content contains a line starting with three backticks

**Problem:** The Markdown serializer always emits the literal three-backtick fence and the parser closes on the first line that starts with three backticks:

- Serializer: `src/editor/markdown-serializer.ts:309-313` — `serializeCodeBlock` returns `` `\`\`\`${lang}\n${code}\n\`\`\`` `` regardless of what's in `code`.
- Parser: `src/editor/markdown-serializer.ts:610-622` — `parseCodeBlock` does `if (!line.startsWith('```')) return null` for the opening fence and `while (j < lines.length && !lines[j]?.startsWith('```'))` for the closing fence.

If a user pastes (or types) a code block whose content contains a line beginning with three backticks (e.g. a Markdown snippet about Markdown, a shell `cat <<EOF` heredoc, an LLM transcript), the round-trip via Markdown export → import will close the code block at that internal line. The remainder of the original code becomes plain Markdown.

**Why it matters:** The TipTap document state is unaffected, so this only bites on Markdown export/re-import (and any future "Markdown copy/paste through clipboard" path). It is uncommon but not exotic — anyone who keeps notes about CommonMark, agentic prompts, or shell heredocs can trip it. The property test suite (`markdown-serializer.property.test.ts`) does not generate triple-backtick content inside code blocks, so the case is not currently covered.

**Fix (CommonMark-standard):** dynamic fence length. Count the longest run of backticks in `code`; emit a fence whose length is `max(3, longest_run + 1)`. Update the parser to record the opening fence length and only close on a line whose run of backticks is `>=` that length, with no other non-whitespace content. Existing single-backtick inline code is unaffected (different production).

**Test plan:**
- Add property-test arbitraries that include `'\n```\n'`, `'\n````\n'`, and `'~~~~'` substrings in `arbCodeBlock`.
- Add example tests for the three real-world patterns: Markdown about Markdown, heredoc body, and an LLM transcript with embedded code fences.
- Verify no regressions in the existing structural-equality and round-trip property tests.

**Cost:** M
**Risk:** M — parser-grammar change; must verify all shipped Markdown export/import paths and the property tests still hold under the wider arbitrary.
**Impact:** M — prevents silent data loss on round-trip in the (rare) cases where it triggers.

---

## MAINT — Tooling / dev-experience maintenance / code quality

### MAINT-96 — Decompose `AgentAccessSettingsTab.tsx` (910 lines) and extract inline `AddFilterRow` from `BacklinkFilterBuilder.tsx`

**Problem:** AGENTS.md "Component decomposition" treats files >500 lines as candidates for extraction. A repo-wide line-count audit produced 12 frontend files over the threshold; most are acceptable as-is (cohesive primitives like `ui/sidebar.tsx` at 1042, or files already heavily decomposed via hooks like `BlockTree.tsx` at 868 and `JournalPage.tsx` at 646). Two specific cases are worth picking up because the extraction is mechanical and the maintenance cost of *not* doing them is real:

1. **`src/components/AgentAccessSettingsTab.tsx` (910 lines).** Mixes RO/RW toggle logic, the activity feed renderer, per-entry undo buttons, per-session bulk revert, and device-info fetching in one file. Suggested split:
   - `src/components/agent-access/McpStatusSection.tsx` — RO/RW toggle + status indicator.
   - `src/components/agent-access/ActivityFeed.tsx` — feed renderer + per-entry undo.
   - `src/components/agent-access/SessionRevertControls.tsx` — bulk revert UX.
   - `src/hooks/useMcpActivityFeed.ts` — `listen()` subscription, page state, fetch on mount.
   Re-export the top-level component from the existing path for backward compatibility.

2. **`src/components/BacklinkFilterBuilder.tsx` (757 lines), specifically the inline `AddFilterRow` sub-component at lines 234–553** — that's a self-contained 320-line sub-component defined inline. Extract to `src/components/backlink-filter/AddFilterRow.tsx` with no other behavioural change. The remaining ~440 lines of `BacklinkFilterBuilder.tsx` would then be at the threshold — acceptable.

**Out of scope (deliberately):** `BlockTree.tsx`, `JournalPage.tsx`, `RichContentRenderer.tsx`, `PageBrowser.tsx`, `ConflictList.tsx`, `SearchPanel.tsx`, `PageHeader.tsx`, `ui/sidebar.tsx`, `markdown-serializer.ts`, `GoogleCalendarSettingsTab.tsx`. These are >500 lines but are already well-structured. Decomposing them is taste, not a maintenance win.

**Cost:** M (each of the two sites — independent and parallelisable).
**Risk:** M — both files have substantial test surfaces (component tests + axe). After extraction, full vitest run + axe pass required.
**Impact:** S–M — pure maintainability; no functional change, no UX change.

### MAINT-99 — No automated enforcement for several documented test rules

**Problem:** Several rules in the test-convention docs have no automated enforcement and rely on manual review. Each one is easy to add as a `prek` hook; together they make the documented conventions binding instead of aspirational.

| Rule | Doc | Currently enforced by | Gap |
|------|-----|------------------------|-----|
| Every `src/components/__tests__/*.test.tsx` includes at least one `axe(...)` call | `src/__tests__/AGENTS.md:227` | Manual review | Easy: grep-based `prek` hook |
| Every component that calls `invoke` has at least one error-path test (mocked rejection) | `AGENTS.md:198` | Manual review | Tractable: scan test files using `vi.mocked(invoke)` for at least one `mockRejectedValueOnce` |
| Test file naming: `.test.ts` / `.test.tsx` for Vitest, `.spec.ts` for Playwright | `src/__tests__/AGENTS.md:81` | Manual review | Easy: `find` + assertions |
| Snapshot tests must redact ULIDs / timestamps / hashes / cursors | `src-tauri/tests/AGENTS.md:284-313` | Manual review | Tractable: parse `.snap` files for raw 26-char Crockford / 64-char hex / ISO-8601 patterns |
| Test-file count tables in AGENTS.md docs match reality (see MAINT-97) | — | Nothing | Easy: tiny grep + comparator |

**Fix:** Add one `prek` hook per rule under the existing `[[repos]]` section in `prek.toml`. Pattern lives next to `no-hsl-rgb-var-wrap` and `tauri-mock-parity` (both already grep-based). Each hook runs only on the relevant `types_or` to keep CI fast. Start with the easy three (axe-presence, file-naming, count-tables); the IPC-error-path and snapshot-redaction hooks need careful pattern design and can land in a follow-up.

**Cost:** M (~1 day for the three easy hooks; ~half day each for the harder two).
**Risk:** S — purely additive lint hooks. May surface a small number of pre-existing violations that need cleanup before the hook turns green; expect 1–2 hours of fix-up per hook on first activation.
**Impact:** M — closes the gap between documented and actual conventions; reduces reviewer-time spent catching the same anti-patterns over and over.

### MAINT-101 — `src/lib/tag-colors.ts` is localStorage-only despite header comment claiming property-sync persistence

**Problem:** `src/lib/tag-colors.ts:1-58` has a header comment that claims tag colours "Also persist to block properties via `setProperty()` for cross-device sync"; the implementation is localStorage-only. Tag colours are device-local and never reach the op log, so two devices can show the same tag in different colours forever.

**Decision required:** either honour the comment (wire colours through a `tag_color` property on the tag's page block, fall back to localStorage as a cache — purely additive, uses the existing properties extension point per AGENTS.md "Architectural Stability") or honour the code (drop the property-sync claim from the comment, document tag colours as device-local). The current state is a contract bug: code and comment disagree.

**Cost:** M (sync option) / S (doc-only option).
**Risk:** S.
**Impact:** M (sync option) — multi-device users see the same palette / S (doc-only).

### MAINT-103 — `BlockPropertyEditor` inline editor uses absolute positioning without portal

**Problem:** `src/components/BlockPropertyEditor.tsx:40-44` renders the inline edit popup with a plain `<div className="absolute z-50 ...">`. If the surrounding row is inside a scroll container with `overflow: hidden`, the popup gets clipped. Every other floating UI in the editor (suggestion popups, `BlockContextMenu`, `BlockDatePicker`) goes through `createPortal()` + `@floating-ui/dom` per AGENTS.md "Floating UI lifecycle logging".

**Fix:** convert to the portal pattern used by `src/editor/suggestion-renderer.ts`: `createPortal(<div data-editor-portal>...)` with `computePosition` from `@floating-ui/dom`, log lifecycle (warn on stale/null state, fallback positioning, `.catch` on positioning), and ensure the portal selector is recognised by `EDITOR_PORTAL_SELECTORS` in `src/hooks/useEditorBlur.ts` (the `[data-editor-portal]` entry already covers this).

**Cost:** M.
**Risk:** M — touches editor blur lifecycle; needs careful tests.
**Impact:** S — closes a small clipping risk and aligns with the documented floating-UI pattern.

### MAINT-106 — Adopt `tauri-plugin-single-instance` (prevent two SQLite pools racing on the same DB)

**Problem:** AGENTS.md "Database" specifies one WAL pool of 2 writers + 4 readers against `~/.local/share/com.agaric.app/notes.db`. There is currently no guard against the user launching the app twice — a second instance opens its own pool against the same file. Even with WAL the result is real risk: two materializer queues racing on hot pages, two sync daemons advertising the same device on mDNS, two op-log writers each stamping their own hash chain. AGENTS.md "Threat Model" is explicit that the focus is *data integrity*, not adversarial peers — a second instance is exactly the accidental-corruption scenario that justifies defensive plumbing.

**Fix:** Add `tauri-plugin-single-instance` and register it in `lib.rs`. The plugin's callback receives the second-launch's argv and CWD — use it to focus the existing window and (post-FEAT-10) replay any deep-link argument the second launch carried. Desktop only — Android already enforces single-instance via the OS task model. Coupled stack — bump with the rest of the Tauri plugins.

**Cost:** S.
**Risk:** S — plugin is a thin wrapper; the only real surface is the focus-on-relaunch callback.
**Impact:** M — closes a class of accidental-corruption bugs that is invisible until it bites; lowest-cost defensive add available.

### MAINT-107 — Replace `navigator.clipboard.writeText` with `tauri-plugin-clipboard-manager`

**Problem:** Five user-facing copy paths use `navigator.clipboard.writeText` directly:

- `src/components/PageHeader.tsx:238, 254` (export page markdown)
- `src/components/BugReportDialog.tsx:158, 162`
- `src/components/AgentAccessSettingsTab.tsx:494`
- `src/components/BlockContextMenu.tsx:324`
- `src/components/DeviceManagement.tsx:221`

The browser API works in WebKitGTK / WebView2 / Android WebView most of the time, but it is gated on secure-context + user-gesture in ways that vary per WebView, fails silently outside `https://` contexts on some Linux distros, and is the documented source of "copy didn't work" bug reports across other Tauri apps. The Tauri plugin gives a deterministic same-API one-liner that goes through the OS clipboard.

**Fix:** Add `@tauri-apps/plugin-clipboard-manager` + `tauri-plugin-clipboard-manager`, expose a tiny wrapper `src/lib/clipboard.ts` (mirroring `src/lib/open-url.ts` and `src/lib/relaunch-app.ts`), replace the 5 call-sites. Add a vitest mock in the test setup (parity with the existing `@tauri-apps/plugin-shell` mock). Coupled stack — bump with the rest of the Tauri plugins.

**Cost:** S.
**Risk:** S — five mechanical site replacements + one new wrapper + one new mock.
**Impact:** M — closes the recurring "copy didn't work on Linux Wayland / Android WebView" failure mode that is silent today.

### MAINT-108 — Adopt `tauri-plugin-window-state` (remember window size / position across launches)

**Problem:** The app has no window-state persistence. Every launch opens at the OS-default size and position — multi-monitor users in particular re-arrange the window every session. AGENTS.md §"Frontend Development Guidelines" mandates "responsive, accessible, modern, and intuitive" — this is a low-cost adherence gap. The plugin handles size, position, monitor, maximized, and fullscreen automatically.

**Fix:** Add `tauri-plugin-window-state` + `@tauri-apps/plugin-window-state` and register the plugin in `lib.rs`. Two-line plugin call; no other code change. Coupled stack — bump with the rest of the Tauri plugins.

**Cost:** S.
**Risk:** S.
**Impact:** M — quality-of-life; affects every user every launch.

### MAINT-109 — Adopt `tauri-plugin-os` (refactor `collect_bug_report_metadata` and friends)

**Problem:** `src-tauri/src/commands/bug_report.rs` collects platform / version / locale / arch / hostname / app data dir by hand. Multiple small per-platform branches creep in over time (BUG-34, BUG-40 already shifted log-dir / `RUST_LOG` resolution). `tauri-plugin-os` centralises all of these behind a documented cross-platform API.

**Fix:** Add `tauri-plugin-os` + `@tauri-apps/plugin-os`. Refactor `collect_bug_report_metadata` to call the plugin's `platform()`, `version()`, `arch()`, `locale()`, `hostname()` instead of hand-rolled branches. Frontend gains a pre-fill path so `BugReportDialog` shows "macOS 14.5 / aarch64 / en-US" before submit (composes well with UX-277 / H-9c log-content preview). Coupled stack — bump with the rest of the Tauri plugins.

**Cost:** S.
**Risk:** S — purely a refactor of existing metadata collection; same fields, same shape.
**Impact:** S — reduces hand-rolled per-platform code; small but real maintenance win as new OS versions ship.

### TEST-2 — ~30 wrapper functions in `src/lib/tauri.ts` lack individual tests beyond the shallow cross-cutting test

**Problem:** `src/lib/tauri.ts` exports ~84 wrapper functions around Tauri `invoke()`. The cross-cutting test in `src/lib/__tests__/tauri.test.ts:1927-2049` calls 47 of them and verifies only the snake_case command name — not the argument shape, not the `?? null` defaulting that the wrappers exist for in the first place (Tauri 2 requires `null` for Rust `Option<T>`, not `undefined`; this is a documented Pitfall, `src/__tests__/AGENTS.md:539`). The remaining ~30 wrappers have no test at all in this file (verified absent from the imports at lines 14-74): `listPageLinks`, `importMarkdown`, `listProjectedAgenda`, `saveDraft`, `flushDraft`, `deleteDraft`, `setPeerAddress`, `fetchLinkMetadata`, `getLinkMetadata`, `collectBugReportMetadata`, `readLogsForReport`, `getLogDir`, `getCompactionStatus`, `compactOpLog`, `restorePageToOp`, `listSpaces`, `createPageInSpace`, `listDrafts`, `restoreAllDeleted`, `purgeAllDeleted`, plus several others.

**Why it matters:** The wrappers are where the `null`-vs-`undefined` defaulting happens. A regression there silently corrupts every IPC call to that command — backend deserializes the wrong field as `Some(undefined)` (which JSON-serializes to absent), which Rust then sees as `None`, producing wrong results without any error. Caught only by integration / E2E tests if at all.

**Fix:** Use the existing `createBlock` test (`src/lib/__tests__/tauri.test.ts:86-139`) as the template. One `describe` per wrapper with three `it`s: (i) command name matches snake_case; (ii) all args present with sample values produce the exact `invoke` call argument shape via `toHaveBeenCalledWith({ ... })`; (iii) optional / nullable args default to `null` (not `undefined`) when the caller passes `undefined`. Pattern is mechanical — can be partially scaffolded by reading the wrapper signatures and emitting boilerplate.

**Cost:** M (~1–2 days for ~30 wrappers, mostly mechanical).
**Risk:** S — additive tests; no production-code change.
**Impact:** M — closes a real correctness gap on every IPC boundary that's currently unverified.

### TEST-3 — Browser/E2E `tauri-mock` `revert.ts` only handles 5 of 13 reversible op types

**Problem:** `src/lib/tauri-mock/revert.ts:30-45` switches on `op_type` and only handles `create_block`, `delete_block`, `edit_block`, `move_block`, `restore_block`. The `default:` case is a silent no-op (`return`). The other reversible op types — `set_property`, `delete_property`, `add_tag`, `remove_tag`, `set_todo_state`, `set_priority`, `set_due_date`, `set_scheduled_date` — fall through and produce no state change in the mock.

**Why it matters:** This is both a *mock feature gap* and a downstream *test gap*: any E2E test that exercises undo/redo for property/tag/state changes runs against a mock that silently does nothing. The flow appears to "work" (no error, history bumps as expected) but the user-visible state in the mock doesn't actually revert. Real users of the desktop/Android build hit the real backend and see the correct revert; preview/E2E users do not. The header comment at `revert.ts:9-12` explicitly states "Keep behaviour identical to the real backend's reverse logic" — that's currently violated.

**Fix:**

1. Extend the switch in `revert.ts` to handle the 8 missing op types. Each case mutates the mock's `block_properties` / `block_tags` map back to the prior state recorded in the op payload (the payload already carries the `from_*` fields the real backend uses).
2. Extend `src/lib/tauri-mock/__tests__/revert.test.ts` (currently 11 tests covering the 5 implemented types) with one happy-path test per added op type, plus the existing "no-op for unknown" test should still pass for genuinely unknown ops only.
3. After landing, audit `e2e/undo-redo-blocks.spec.ts` for opportunities to add property/tag undo/redo flows that were previously impossible to test.

**Cost:** M (~1 day — 8 cases each ~30 min, plus tests).
**Risk:** S — adding cases to an existing switch; default branch unchanged.
**Impact:** M — restores parity between mock and real backend on a documented contract; unlocks new E2E coverage for property/tag undo flows.

### TEST-4 — 25 of 26 Playwright specs lack a console-error listener

**Problem:** `grep "page.on('console" e2e/*.spec.ts` returns one match: `e2e/smoke.spec.ts:31`. The other 25 specs run without any check that the page emitted a console error. Backend errors that reach the browser console (mock failures returning unexpected shapes, IPC handler crashes, React error-boundary fall-throughs, unhandled promise rejections, dev-time warnings escaping to prod) currently pass the suite silently for every feature except smoke.

**Why it matters:** This is the cheapest way to catch a class of regressions that doesn't surface as a failed assertion — code throws, the UI degrades silently, the test still clicks the next button. The smoke test already proves the pattern works (it filters favicon noise and asserts `expect(realErrors).toEqual([])`).

**Fix:**

1. Add an `expectNoConsoleErrors(page)` helper to `e2e/helpers.ts` that registers `page.on('console', ...)` with the same favicon filter as `smoke.spec.ts`, returns a function the test can call in `afterEach` to assert the captured-error array is empty. Register the listener BEFORE `page.goto()` so pre-load errors are captured.
2. Wire the helper into the existing `test.beforeEach` block in `e2e/helpers.ts` (lines 30-50, the mock-reset hook) so every spec gets it for free.
3. Run the suite once; expect 1–2 days of triage to fix or whitelist legitimate warnings that surface. Whitelisting should be the exception, not the rule.

**Cost:** M (~1 day implementation + ~1–2 days triage on first activation).
**Risk:** M — turning the listener on may surface real warnings that need triage. Some may be noisy dev-only logs that need filtering or fixing in production code.
**Impact:** M — catches a real class of regressions that currently leaks through every E2E suite.

### TEST-5 — `property-picker.test.ts` and `checkbox-input-rule.test.ts` test extension config only, not editor integration

**Problem:** Two of the 10 custom TipTap extensions have test files that exercise only the static configuration shape of the extension, not its behaviour against an actual editor:

- `src/editor/__tests__/property-picker.test.ts` — 6 tests; all check `Extension.create({...})` returns an object with the expected name / default options / options-merging behaviour. No test drives a TipTap editor through the picker's suggestion command, no test inserts a property reference into a doc.
- `src/editor/__tests__/checkbox-input-rule.test.ts` — 17 tests across 3 describe blocks. The first 6 tests configuration; the next 8 test the regex patterns in isolation; the last 3 spy on the input-rule handler signature. None drive an actual ProseMirror transaction through `[ ] ` or `[x] ` to verify a checkbox node materialises in the resulting doc.

Compare with `src/editor/__tests__/at-tag-picker.test.ts` (~452 lines) and `src/editor/__tests__/block-link-picker.test.ts` (~600+ lines), which both drive actual editor instances and assert on the resulting transactions / nodes.

**Why it matters:** These extensions are exactly where the `EDITOR_PORTAL_SELECTORS` discipline (Pitfall 23, `src/__tests__/AGENTS.md:583`), capture-phase keydown handling (Pitfall 19), and `flushSync` ordering (Pitfall 16) bugs land. Configuration-only tests catch zero of those.

**Fix:** Add an integration test file (or expand the existing one) for each extension following the `at-tag-picker` template: instantiate a minimal `Editor` with the extension under test, drive it through a suggestion-trigger sequence, assert the resulting JSON doc has the expected node / mark inserted at the correct position. ~10–15 new tests per extension.

**Cost:** M (~1 day for both extensions).
**Risk:** S — additive tests.
**Impact:** M — closes coverage on hot-path picker code where flushSync / portal / capture-phase regressions actually occur.

### TEST-6 — `LinkEditPopover.test.tsx` weak-assertion sub-batch

**Problem:** `src/components/__tests__/LinkEditPopover.test.tsx` has ~36 `expect(mock).toHaveBeenCalled()` assertions without `…With(...)`. Quality-standards rule from `src/__tests__/AGENTS.md:529`: *"Use `toHaveBeenCalledWith` with exact args, not just `toHaveBeenCalled`."* The other 7 TEST-6 sub-files (SearchPanel, ConflictList, JournalPage, PageBrowser, suggestion-renderer, keyboard-config, MonthlyDayCell) were closed in session 479 — 54 sites tightened. LinkEditPopover was deferred as the largest sub-batch (M-cost).

**Fix:** Replace each `toHaveBeenCalled()` with `toHaveBeenCalledWith(expectedArgs)` using the most specific matcher possible. If args are sometimes Symbol/closure (cannot be asserted), use `toHaveBeenCalledTimes(N)` instead — at minimum tighten the arity.

**Cost:** M (~1–2 days).
**Risk:** S — pure tightening of assertions; tests still pass when behavior is correct.
**Impact:** M — catches off-by-one / wrong-arg regressions on the link-edit popover, a heavily user-touched surface.

### TEST-11 — 7 E2E specs use CSS-class selectors (23 instances) instead of `data-testid`

**Problem:** Selector convention from `src/__tests__/AGENTS.md:404`: *"Use `data-testid` selectors (not CSS classes) for targeting elements."* Verified violations (`grep -n "page.locator('\." e2e/*.spec.ts` returns 23 hits across 7 specs):

| File | Lines | Selector |
|------|-------|----------|
| `e2e/inner-links.spec.ts` | 79, 376 | `.block-tree`, `.linked-references` |
| `e2e/batch-operations.spec.ts` | 65, 96, 129 | `.batch-toolbar` |
| `e2e/attachments.spec.ts` | 62, 82, 92, 117, 146 | `.attachment-badge` |
| `e2e/sync-ui.spec.ts` | 111, 112 | `.device-no-peers` |
| `e2e/agenda-advanced.spec.ts` | 245, 519, 533, 537, 557, 561, 588 | `.due-panel-priority`, `.agenda-results-item`, `.agenda-group-header` |

**Fix:** For each violation, add the matching `data-testid` to the corresponding component (one-line edit per component) and update the spec selector to `page.locator('[data-testid="..."]')` or, better, `page.getByTestId('...')`. CSS classes used purely for styling stay; the `data-testid` is what tests bind to. After landing, optionally extend MAINT-99's lint hooks with a check for `page.locator('\\.` patterns in `e2e/`.

**Cost:** M (~1 day across 7 specs + ~7 component edits).
**Risk:** S — additive `data-testid` attributes; existing CSS classes preserved for styling.
**Impact:** M — CSS refactors are a recurring source of test breakage; switching to `data-testid` decouples test stability from style changes.

### UX-257 — Breadcrumb bar doesn't read as a breadcrumb, is oversized, and styling is inconsistent across the two surfaces

**Problem:** Two breadcrumb-like surfaces exist in the app; neither reads as "the standard breadcrumb pattern" at a glance, and they don't match each other.

1. **Block-zoom breadcrumb** (`src/components/BlockZoomBar.tsx`) — the bar rendered at the top of the page area when a block is zoomed. Structure: `[Home icon] › [crumb] › [crumb] › [current]` with `ChevronRight` separators. The chevron separator is correct, but each crumb currently:
   - Calls `renderRichContent(item.content, ...)` inside the `<button>`, so any resolved tags, block refs, or external-link chips embedded in the block's title are drawn **at full size** — identical scale to the main editor's chips. A crumb for a block titled "Read [[Handbook]] #urgent" renders two full coloured pills inside the breadcrumb button.
   - Uses `text-sm` + `py-1.5` padding, which combined with embedded chips produces a bar that is visually taller and heavier than its role (passive "you are here" wayfinding) justifies.
   - Caps each crumb at `max-w-[200px]`, but the bar itself has no compact height budget — it grows with content. The outer `ScrollArea` wrapper hides horizontal overflow but the scrollbar track still steals vertical space.
2. **Page-title namespace breadcrumb** (`src/components/PageHeader.tsx:503-530`) — rendered under the page title for pages whose title contains `/` (namespaced pages). Structure: `[ancestor] / [ancestor] / [current]`. Uses **slash** separators (not chevrons), `text-xs`, and `touch-target` on every crumb button, which imposes a 44px minimum hit-height on touch devices. Visually disjoint from the zoom bar a few px above it.

Net result: one bar uses `›` chevrons + full-sized rich chips at `text-sm`; the other uses `/` slashes + plain text at `text-xs` with 44px touch targets. Users don't recognise either as a breadcrumb on first glance and the two don't look like they belong to the same product.

**Why it matters:** Breadcrumbs are a passive wayfinding surface — their job is "you are at A › B › C" with minimal chrome. Both current implementations draw too much attention (via inline chips or slash-divider inconsistency), and neither matches the density of the rest of the app's nav chrome (tab bar, status chip, filter-pill row). It is also an accessibility / touch-ergonomics mismatch: the page-header namespace crumb forces 44px rows while the zoom bar does not.

**Design direction (consolidate, compact, consistent):**

1. **Single design-system primitive.** Add `src/components/ui/breadcrumb.tsx` at the `ui/` layer (per AGENTS.md "Component hierarchy" — UI primitives live here). Export `Breadcrumb`, `BreadcrumbItem`, `BreadcrumbSeparator`, `BreadcrumbHome`. Follow the same CVA + `cn()` patterns as `Button` / `Badge`. Both `BlockZoomBar` and `PageHeader`'s namespace breadcrumb consume this primitive. Slash separators in `PageHeader` go away — chevrons everywhere. One glyph, one type scale, one hit-area rule.
2. **Plain text inside crumbs — no inline chips.** Do not render `renderRichContent` inside a breadcrumb item. Resolve the block's title to a plain string (via `resolveBlockTitle` from `useRichContentCallbacks`, or a lightweight mark-stripper) and render that. Inline `#tag` / `[[ref]]` chips belong in content, not in nav chrome. This removes the "giant coloured pills inside the nav bar" problem at its root and is the single biggest visual win.
3. **Tight vertical budget.** Breadcrumb bar is a single line at ~24–28px tall (`h-7` max). Typography: `text-xs` + `py-1` + `gap-1`. No `touch-target` on individual crumbs — the 44px hit area (AGENTS.md mandatory pattern on touch) comes from the chevron+label combined tap region via `[@media(pointer:coarse)]` padding on the primitive itself, not by stretching every visible crumb to 44px. This matches the density of the tab bar, sync-status chip, and filter-pill row elsewhere in the app.
4. **Glyph consistency.** `ChevronRight` at `h-3 w-3 text-muted-foreground/50` (already the `BlockZoomBar` value) becomes the canonical breadcrumb separator. `Home` at `h-3.5 w-3.5` for the root. No emoji, no `>>`, no `/`. The user asks the bar to *read* as a breadcrumb — that means one chevron per level, not a rendered string separator.
5. **Truncation / overflow strategy.** Per-crumb `max-w-[160px] truncate` for intermediate crumbs; the final crumb (`aria-current="location"`) gets more room (`max-w-[320px]`) because it's the anchor the user is scanning for. On narrow viewports, collapse middle crumbs into a `…` overflow popover (Radix `Popover` — reuse `ui/popover.tsx`, never build a custom dropdown per AGENTS.md) rather than allowing the bar to scroll horizontally. The current `ScrollArea` wrapping the whole bar can be removed once overflow is handled by the ellipsis affordance.
6. **Active-step treatment.** Final crumb: `text-foreground font-medium`, `aria-current="location"`, not clickable (already the `BlockZoomBar` pattern — preserve it). Intermediate crumbs: `text-muted-foreground hover:text-foreground transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50` — mirrors `Button` focus pattern from the design system.
7. **Tokens, not raw colours.** Use `--muted-foreground` and `--foreground` semantic tokens from `src/index.css`. No hardcoded Tailwind colour classes (AGENTS.md anti-pattern).

**A11y invariants to preserve:**

- `role="toolbar"` + arrow-key / Home / End navigation on the container (UX-215 — already implemented in `BlockZoomBar`). Move into the primitive so both callers benefit.
- `aria-current="location"` on the last crumb.
- `aria-label` from i18n keys (`blockZoom.breadcrumbs`, `pageHeader.breadcrumbLabel`) — no hardcoded English.
- `axe(container)` test on the primitive and on both callers.

**Files touched (expected):**

- **New:** `src/components/ui/breadcrumb.tsx` + `src/components/ui/__tests__/breadcrumb.test.tsx` (render + keyboard nav + truncation + overflow popover + a11y).
- **Refactor:** `src/components/BlockZoomBar.tsx` → consume the primitive; drop the inline `renderRichContent` call (replace with plain-string title resolution); thin the component down to a data adapter.
- **Refactor:** `src/components/PageHeader.tsx` (lines 503-530) → consume the primitive; replace `/` separators with the primitive's chevron; drop `touch-target` on individual crumbs (primitive handles the 44px hit via `pointer:coarse` padding).
- **Tests:** update `BlockZoomBar.test.tsx` + `PageHeader.test.tsx` to assert the new DOM (no nested chip elements inside `button[data-zoom-crumb]`, chevron separators for namespaced titles).
- **No** backend changes. **No** new i18n keys beyond what already exists. **No** new stores or IPC commands.

**Cost:** M — single focused refactor session. Two callers, one new primitive, one coordinated test pass. No protocol, schema, store, or sync-protocol changes; stays firmly inside AGENTS.md "Architectural Stability" guardrails.

### UX-260 — Discoverability sweep for keyboard shortcuts, gestures, and customization

**Problem:** Several real, working features are effectively invisible to users who don't read code or doc files:

1. **Sidebar swipe-to-open on mobile.** `src/components/ui/sidebar.tsx:31-32` defines `SWIPE_EDGE_ZONE = 20` and `SWIPE_MIN_DISTANCE = 50`. The gesture works but the rail has no visual hint at the left edge — first-time mobile users won't discover it.
2. **Journal date-navigation shortcuts.** `src/App.tsx:184-200` ships `Alt+Left/Right` (prev/next day) and `Alt+T` (today). The prev/next/today buttons in `JournalPage` have no tooltip showing the binding.
3. **Two-tier undo/redo.** `src/hooks/useUndoShortcuts.ts:1-105` distinguishes editor-undo (ProseMirror) from page-undo (op log); the user has no UI signal which tier `Ctrl+Z` will hit.
4. **Shift+Click range select** (UX-140) implemented in `src/hooks/useListMultiSelect.ts:76-102`, used by HistoryView, TrashView, ConflictList. No tooltip, no toolbar hint anywhere except `HistorySelectionToolbar:63-65`.
5. **Properties drawer keyboard binding.** `src/editor/use-block-keyboard.ts:186-193` recognises a configurable `openPropertiesDrawer` shortcut, but the binding is not in the `KeyboardShortcuts` panel and no UI button surfaces it.
6. **Ctrl+F → SearchPanel.** Documented in UX.md but not in the `SearchPanel.tsx` header comment, which makes the dispatch chain hard to trace.
7. **`KeyboardShortcuts` sheet doesn't link to Settings → Keyboard.** Users see the shortcuts but can't discover that they're customisable (`src/components/KeyboardShortcuts.tsx:94-235`).

**Fix outline (single sweep):**

- Mobile sidebar: render a 2-3 px gradient indicator at `left-0 inset-y-0 w-[3px] bg-foreground/10` on `pointer:coarse` only.
- Journal nav buttons: add `Tooltip` showing the chord (use `t()` keys; no hardcoded English).
- Page-header undo button: tooltip clarifies which tier fires depending on whether the editor is currently focused.
- Shift+Click hint: add `t('list.rangeSelectHint')` to `BatchActionToolbar` (right-aligned), reusing the `HistorySelectionToolbar` pattern across the other callers.
- Properties drawer shortcut: add to `KeyboardShortcuts` panel + tooltip on the gutter property button (UX.md keyboard-shortcuts table — see MAINT-100).
- `SearchPanel.tsx:1-10` header: one-line comment "Opened via Ctrl+F (see App.tsx global handler)".
- `KeyboardShortcuts.tsx`: add a footer button `t('keyboard.customizeButton')` that navigates to Settings → Keyboard.

**Cost:** M — many small surfaces but each fix is XS.
**Risk:** S — additive UI, no behaviour change.
**Impact:** L — flips a large amount of latent capability into discoverable capability.

### UX-263 — Pairing flow polish

**Problem:** Several small but real issues across the pairing UI:

- `src/components/PairingEntryForm.tsx:93` — passphrase inputs have aria-label and a placeholder ordinal ("1st/2nd/3rd/4th") but no visible label; on narrow screens or for users with cognitive load, position context can be lost.
- `src/components/PairingQrDisplay.tsx:57-73` — SR countdown announces only at 60-second intervals + 30 s, then goes silent. For a 5-minute session, screen-reader users get no warning in the final 30 s. Announce at 60/30/10/5 s or every 10 s in the final minute.
- `src/components/PeerListItem.tsx:49-62` — device address input accepts any string; only an error toast on failure. Add a regex check (`^[a-zA-Z0-9.-]+:\d+$`) with inline error and a "Format: host:port" hint; disable Save until valid.
- `src/components/DeviceManagement.tsx:151-166` — device rename has no client-side validation or character limit. Add a 50-char cap, allow alphanumerics + space/hyphen/underscore, show a counter.
- `src/components/PairingDialog.tsx:310-326` — Esc / outside-click closes the dialog mid-pairing without confirmation, discarding entered words / scanner state. Block the close when `pairLoading === true` or scanner is active, or surface a "Pairing in progress — close anyway?" confirm.
- `src/components/PairingDialog.tsx:137-153` — countdown keeps ticking while user types passphrase; pause on focus of any input, resume on blur or 5 s of inactivity.

**Cost:** M — bundle of XS/S items.
**Risk:** S — defensive UI tweaks.
**Impact:** M — first-impression polish on the only flow most users see twice.

### UX-264 — Sync error UX

**Problem:** Sync error feedback is consistently weak:

- `src/hooks/useSyncTrigger.ts:42-50, 110-115` — failure toasts show `t('sync.failedForDevice', { deviceId: peerId.slice(0, 12) })` with no retry action and no error category. UX.md "Toast Action Patterns" mandates a retry action for retryable failures.
- `src/hooks/useSyncTrigger.ts:152-159` — when transitioning from offline → online, `syncAll()` is triggered but no toast / banner confirms the transition. On mobile, network transitions are frequent and the StatusPanel is often not visible.
- `src/components/ConflictList.tsx:362-400` — batch keep/discard processes conflicts sequentially with no per-item progress. For 50+ conflicts (realistic after a re-pair), users see only a spinner.
- `src/components/QrScanner.tsx:34-77` — camera-permission denial is shown inside the scanner component but the parent `PairingEntryForm` does not auto-switch to manual entry. User has to click "Type Passphrase" themselves.

**Fix outline:** add retry actions to failure toasts (see UX.md pattern); show a toast "Back online — syncing…" on the offline→online transition; add progress text "Resolving 3 of 50…" during conflict batch ops; auto-switch to manual mode on camera-permission denial with a `t('pairing.cameraDeniedFallback')` toast.

**Cost:** M.
**Risk:** M — toast retry needs backend error categorisation; auto-fallback needs careful focus-management.
**Impact:** L — significantly improves user trust in sync.

### UX-265 — Conflict UI improvements

**Problem:** Several issues in the conflict-resolution surface:

- `src/components/ConflictListItem.tsx:147-171` — "Keep" (outline) / "Discard" (destructive) buttons rely on visual hierarchy alone to communicate which is safer. Add tooltip / aria descriptions ("Keep: use the incoming version" / "Discard: delete the conflict copy"). Consider swapping order so the safer action sits on the right.
- `src/components/ConflictList.tsx:414-442` — no sort / filter on the conflict list. After a re-pair, users may face dozens of conflicts and have no way to prioritise by type, source device, or timestamp. Add a filter bar with conflict-type + source-device + date-range dimensions.
- `src/components/ConflictListItem.tsx:108-117` — conflict-type badge has aria-label but no visible tooltip. Wrap in a `Tooltip` showing the existing `conflict.type${type}` i18n description.
- `src/components/ConflictTypeRenderer.tsx:224-240` — Property and Move conflicts fall through to `TextConflictView` when the original block is missing. The fallback shows "(original not available)" which is confusing for typed conflicts. Show a warning banner ("Original block not found — showing conflict content only") and disable the Keep action.
- `src/components/DiffDisplay.tsx:24-53` — diffs render all spans inline with no special handling for very large diffs (10 KB+ blocks edited on two devices). The container has `max-h-40` upstream but the SVG render still touches every span. Add a "Show full diff" / "Collapse" toggle for diffs above a threshold (e.g., >500 spans).

**Cost:** M.
**Risk:** S — additive.
**Impact:** M — improves usability of an inherently stressful flow.

### UX-269 — `SearchPanel` consolidation

**Problem:** SearchPanel hand-rolls several primitives the design system already provides:

- `src/components/SearchPanel.tsx:577-587` — custom "Load more" button instead of the shared `LoadMoreButton`; missing `aria-busy={searchLoading}`.
- `src/components/SearchPanel.tsx:504-575` — `aria-live="polite"` wraps the interactive `role="listbox"`, so SR users may hear the entire region re-announced on result changes. Move `aria-live` to a separate status `<div>` above the list.
- `src/components/SearchPanel.tsx:193-217, 384` — spinner shows when `typing` OR `searchLoading`; users don't know if they're waiting on debounce or fetch. Show distinct labels.
- `src/components/SearchPanel.tsx:470-475` — CJK limitation notice appears below the min-char hint and above results; users searching with CJK input often don't see it. Move closer to the input or fold into the empty state.
- `src/components/SearchPanel.tsx:509-523` — alias-match overlay label is positioned absolutely and may overlap content on narrow viewports. Move into the `ResultCard` as a subtitle or below the card.
- `src/components/SearchPanel.tsx:570-574` — results count is rendered visually but not announced. Wrap in `aria-live="polite"` (separate region from the listbox).

**Fix:** rewire to use `<LoadMoreButton hasMore={hasMore} loading={searchLoading} onLoadMore={loadMore} />` and refactor the live-region structure.

**Cost:** M.
**Risk:** S — design-system migration.
**Impact:** M — consistency + a11y.

### UX-270 — `GraphView` a11y + filter persistence

**Problem:**

- `src/components/GraphFilterBar.tsx:196` — uses bare `overflow-y-auto` instead of `ScrollArea` for the tag list; AGENTS.md mandates `ScrollArea` for all scrollable containers (`SourcePageFilter.tsx:140` is the correct pattern).
- `src/components/GraphFilterBar.tsx:191-213` — checkbox has `aria-label={tag.name}` *and* a `<label>` element wrapping the input with the same text. Remove the redundant `aria-label`.
- `src/components/GraphView.tsx:207-212` — SVG has `role="img"` while the inner nodes are interactive (`role="button"`, Enter/Space handlers via `useGraphSimulation.ts`). Either drop the wrapper role or use `role="application"`.
- `src/components/GraphFilterBar.tsx:309-431` — filters reset on every navigation; unlike SearchPanel and BacklinkFilterBuilder, GraphFilterBar has no localStorage persistence. Persist under `agaric:graph-filters`.
- `src/hooks/useGraphSimulation.ts:136-176` — keyboard nav (`tabindex=0`, `role="button"`, Enter/Space handler) is implemented but undocumented in the file; add a JSDoc comment block explaining the pattern (mirrors AGENTS.md "Floating UI lifecycle logging" doc-as-you-go expectation).

**Cost:** M — bundle.
**Risk:** S.
**Impact:** M — a11y + persistence parity with the rest of the app.

### UX-272 — Properties drawer / picker polish

**Problem:** Eight small UX gaps in the properties UI. Bundled because each is XS:

- `src/components/PropertyRowEditor.tsx:265-268` — ref-picker no-pages state is a plain styled `<div>` with muted text; use `EmptyState` (with an icon) and offer "Create new page" when search has content.
- `src/components/TagFilterPanel.tsx:290-344` — AND/OR/NOT mode toggle distinguishes only via `Button` variant (`default` vs `outline`); add tooltips ("AND: blocks must have ALL selected tags" etc.) and consider an icon (∩ / ∪ / ¬).
- `src/components/BlockPropertyDrawer.tsx:75-96` — drawer shows generic "Loading…" while fetching properties + definitions. Use `LoadingSkeleton`; disable "Add property" with a tooltip until definitions arrive.
- `src/hooks/useDateInput.ts:53-67` — `parseDate()` runs on every keystroke (no debounce). Debounce 300 ms; only set `datePreview` when parsing succeeds.
- `src/components/PropertyRowEditor.tsx:135-180` — choice options editor lacks a count badge ("3 options") and drag-to-reorder; add both.
- `src/components/PropertyRowEditor.tsx:150-155` — "Add option" button is not `disabled` when input is empty; current guard returns silently. Disable the button.
- `src/components/AddPropertyPopover.tsx:144-154` — "Create new" button doesn't surface the default type ('text'). Show a small "(text)" hint or surface the type selector inline.
- `src/components/PropertyRowEditor.tsx:205-225` — selecting a ref page closes the popover immediately with no spinner / success toast; add a brief loading indicator.

**Cost:** M — bundle of XS items.
**Risk:** S.
**Impact:** M — properties is the documented "primary extension point"; polish here pays off everywhere.

### UX-273 — Inline link UX: keyboard preview + popup viewport handling

**Problem:**

- `src/components/LinkPreviewTooltip.tsx:1-118` — tooltip only fires on `mouseover`/`mouseout`; not accessible to keyboard-only users. Extend `useLinkPreview` to detect focus on external links and show on focus; add a keyboard shortcut to preview the focused link; ensure Esc dismisses.
- `src/editor/suggestion-renderer.ts:53-56` — `computePosition` middleware uses `padding: 8` for `flip()` and `shift()`. On mobile narrow viewports the popup can still clip near the bottom. Increase padding to 16 on `pointer:coarse` and add `size()` middleware to cap popup height at 60vh on mobile.

**Cost:** M.
**Risk:** M — link preview spans hover + focus state machines.
**Impact:** M — closes a real keyboard-a11y gap and a real mobile clipping issue.

### UX-274 — Agenda views: error retry, parse feedback, persistence, keyboard nav

**Problem:** Seven small UX gaps in agenda + queries:

- `src/components/DateChipEditor.tsx:105-116` — when parse fails, error message is in helper text only; the input itself has no `aria-invalid` or `border-destructive`. Add both.
- `src/components/QueryResult.tsx:201` — `{error && <div className="...">{error}</div>}` has no retry button. Add one that calls `fetchResults()`.
- `src/components/journal/RescheduleDropZone.tsx:29-102` — drag-only interface with a `biome-ignore` acknowledging no keyboard alternative. Document the keyboard reschedule path (DateChipEditor) in the component's JSDoc; consider a context-menu reschedule on right-click of agenda items.
- `src/components/journal/UnfinishedTasks.tsx:161` — per-group collapse state lives in React state only; parent section collapse persists to localStorage. Add per-group persistence under e.g. `unfinishedTasks.groupCollapsed`.
- `src/components/AgendaFilterBuilder.tsx:140-145` — clicking "Apply" with no values silently does nothing; the button is disabled but disabled state isn't visually obvious. Either make disabled prominent (`opacity-50 cursor-not-allowed`) or show a brief toast.
- `src/components/DuePanel.tsx:331-380` — projected entries (`<li>` with `onClick` + `onKeyDown`) are not part of the `useListKeyboardNavigation` flat-items array. Keyboard users can't arrow-navigate to them.
- `src/components/QueryBuilderModal.tsx:96-116` — accepts arbitrary property keys without checking against `listPropertyDefinitions()`. Add autocomplete or pre-save validation.

**Cost:** M.
**Risk:** S.
**Impact:** M.

### UX-275 — History view UX gaps

**Problem:** Eleven small issues in the history surface (`HistoryView`, `HistoryListItem`, `HistoryFilterBar`, `HistoryPanel`, `BatchActionToolbar`, `TrashView`, `DiffDisplay`):

- `src/components/HistoryView.tsx:386-402` — "Restore to here" confirmation description doesn't make the scope explicit ("All operations after this point will be reverted. This action itself can be undone.").
- `src/components/HistoryListItem.tsx:289-304` — non-reversible-op lock icon has aria-label `Non-reversible` but doesn't explain why (purge cannot be undone). Expand the label; consider increasing icon size on touch.
- `src/components/HistoryFilterBar.tsx:49-82` — no inline ✕ to clear an active op-type filter; users have to open the dropdown and pick "All". Add an active-filter affordance.
- `src/components/DiffDisplay.tsx:16-54` — no keyboard navigation between hunks; large diffs render as one paragraph. Add prev/next change buttons; wrap in `<div role="region" aria-label="...">`.
- `src/components/TrashView.tsx:543-551` — descendant-count badge can wrap on narrow viewports; verify the i18n key `trash.itemsInBatch` exists; consider a more prominent badge variant.
- `src/components/TrashView.tsx:438-459` — batch toolbar buttons (Restore / Purge) lack keyboard shortcuts and a hint matching `HistorySelectionToolbar:63-65`.
- `src/components/HistoryPanel.tsx:83-103` — restore success toast has no "Undo" action; UX.md "Toast Action Patterns" mandates one for reversible actions. Capture previous content before the restore so undo can revert.
- `src/components/HistoryListItem.tsx:243-254` — checkbox + row-click both toggle selection on touch; users may accidentally select by tapping the row. Add visible focus-ring on the checkbox; clarify ownership (clickable row OR clickable checkbox, not both).
- `src/components/TrashView.tsx:390-405` — filter input has search icon on left but no inline ✕; add one when `filterText.length > 0`.
- `src/components/HistoryListItem.tsx:265-287` — "Restore to here" is icon-only via `Button size="sm"`; tooltip is the only label. On touch (no hover), the meaning is hidden. Add a text label or move to a long-press / context menu.
- `src/components/HistoryView.tsx:311-322` — error banner has retry but generic message. Pass more context (network / server / unknown) into the error state and `logger.error` the full error.
- `src/components/TrashView.tsx:268-289` — batch *restore* has no confirmation while batch *purge* does; inconsistent. Add confirmation when `selected.size > 5` (or always).

**Cost:** M.
**Risk:** S.
**Impact:** M.

### UX-277 — `BugReportDialog` log-content preview before submit

**Problem:** `src/components/BugReportDialog.tsx` lists filenames + sizes for attached logs but offers no preview of contents. Users cannot verify what data they're submitting before the report leaves the device. Add a per-entry "Preview" button that shows the first 500 chars in a modal.

**Note:** May be superseded by **H-9c** (`bug_report_preview()` Tauri command + dialog rendering of the redacted bundle). When H-9c lands, drop this UX-277 entry.

**Cost:** M.
**Risk:** S.
**Impact:** M — improves transparency before submit.

### UX-281 — Gutter-button tooltips invisible on touch

**Problem:** `src/components/SortableBlock.tsx:39` fixes the gutter at `w-[68px]` and `src/components/BlockGutterControls.tsx:104-112` packs three icon-only buttons (drag, history, delete) into it relying on hover tooltips for labels. On `pointer:coarse`, each button inflates to ≥44×44 (touch-target utility), so the three buttons already exceed 132 px of horizontal space and overflow the 68 px lane — there is no room left for inline text labels. On touch the result is a row of unlabelled icons with no discoverable affordance.

**History:** Sub-fixes for the suggestion-list `<h3>` headers and the markdown-serializer unknown-node toast were closed in session 478 (UX-281 sub-fixes 1 and 2). This sub-fix was deferred because `pointer:coarse` inline labels would compound the overflow without addressing the root constraint.

**Fix:** needs a different affordance, not inline labels. Options to evaluate:

- Long-press on `pointer:coarse` → show a small `toast` describing the action (works on a fixed gutter, but adds latency and a toast layer to a high-frequency interaction).
- Expand the gutter on `pointer:coarse` to ~120-140 px and add inline icon+label rows (cleaner UX; needs `SortableBlock` width audit and may shift block content over).
- Move the secondary actions (history, delete) into an overflow `Sheet` on touch and keep only drag in the gutter (smallest visual change, preserves existing layout).

**Cost:** S.
**Risk:** S — touch-only path.
**Impact:** S — improves discoverability for touch users; desktop unaffected.

### UX-282 — `src/lib/announcer.ts` is largely unused

**Problem:** `src/lib/announcer.ts` exposes `announce(message)` for SR-only announcements, and `src/lib/i18n.ts` defines a full `announce.*` keyspace (e.g. `announce.blockDeleted`, `announce.taskState`, `announce.navigatedToPrevious`). The keys are wired in some App-level handlers (`src/App.tsx:184-200` journal nav) but most user actions — toast successes, batch ops, drag-reschedule, conflict resolution — only show visual toasts and never call `announce()`. The accessibility infrastructure is paid for but not used.

**Fix:** audit every action that emits a toast or updates state visibly, and call `announce(t('announce.<key>'))` in parallel. Group by feature area: undo/redo, batch ops, conflict resolution, sync events, agenda reschedule, page rename / move / delete. Add a regression test (component or e2e) per cluster: spy on `announce()` and assert it's called with the expected i18n key.

**Cost:** M — broad sweep.
**Risk:** S — additive.
**Impact:** L — completes a documented a11y commitment that is currently fictional in most flows.

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

### PUB-5 — Tauri updater endpoint + Minisign keypair not yet wired

**Problem:** `src-tauri/tauri.conf.json:30` still points at a placeholder URL:
```json
"updater": {
  "endpoints": [
    "https://github.com/agaric-app/org-mode-for-the-rest-of-us/releases/latest/download/latest.json"
  ],
  "pubkey": ""
}
```
On a tagged release today the updater would 404 (the `agaric-app/org-mode-for-the-rest-of-us` repo doesn't exist) and signing is unconfigured (`pubkey` empty, `TAURI_SIGNING_PRIVATE_KEY` block in `.github/workflows/release.yml:93-95` commented out).

**Update — publish target is now concrete:** the public repo lives at `github.com/jfolcini/agaric`. The endpoint URL just needs to match. The PUB-2 identity decision (corporate-email-in-history) can still move under that path independently — the updater URL only needs to track wherever the release repo is at any given time. Per-platform code signing (PUB-8 Android, PUB-9 Windows) is orthogonal: those sign the OS-installable bundles for Gatekeeper / SmartScreen / Play Protect, while this signs the auto-update payload chain.

**Concrete remaining work:**
1. **Pick the endpoint URL.** Default: `https://github.com/jfolcini/agaric/releases/latest/download/latest.json`. If PUB-2 ever moves the repo under an org, the URL moves too.
2. **Generate the Minisign keypair** (`cargo tauri signer generate -w ~/.tauri/agaric.key`). Back up the private key offline — losing it means future updaters can't verify against the deployed pubkey, breaking the auto-update chain for installed users.
3. **Paste the public key** into `tauri.conf.json` `updater.pubkey`.
4. **Add two GH Actions secrets** at `Settings → Secrets and variables → Actions`:
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of the generated `.key` file
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the passphrase used at generation time
5. **Uncomment** the two `TAURI_SIGNING_PRIVATE_KEY*` env lines in `release.yml:93-95` (just under the `# PUB-5: Uncomment …` comment).
6. **Tag a release** to verify: tauri-action will produce `*.sig` files alongside each bundle (`.dmg.sig`, `.AppImage.sig`, `.msi.sig`, etc.), which the in-app updater fetches and verifies against the embedded pubkey.

**Alternative (skip the updater):** if you don't want auto-update at all, remove the `updater` block from `tauri.conf.json` and the `tauri-plugin-updater` dependency from `src-tauri/Cargo.toml`. Users would update by manually downloading new releases.

**Cost:** S (~30 min once the keypair + URL are decided).
**Status:** ACTIONABLE — publish target resolved; remaining work is mechanical (keypair generation + URL edit + 2 secrets + 2 uncommented lines).

### PUB-7 — Missing `SECURITY.md` — private-disclosure contact pending publish target

**Problem:** `SECURITY.md` is the standard GitHub-recognised private-disclosure file. The repo does not ship one yet. For a local-first single-user app with no adversarial-peer threat model (see AGENTS.md), the file is mostly a courtesy affordance — it documents the reporting channel and the scope of "things worth reporting" so surface-level finders don't waste time filing issues against the sync protocol's peer authentication (which is deliberately non-adversarial).

**Blocker:** no private-disclosure contact is locked in yet. Options considered in a prior batch (personal email / GitHub Security Advisories only / placeholder pointing at Security tab) were all deferred until the publish target is concrete (PUB-5). The Code of Conduct already ships (Contributor Covenant 2.1) with a deferred contact line that forward-references `SECURITY.md`.

**Implementation (when PUB-5 unblocks):**
- `SECURITY.md` — private contact (personal email, Matrix handle, or GitHub Security Advisory-only policy), a one-paragraph restatement of the local-first threat model from AGENTS.md so reporters don't file "sync peer DoS" reports, and a line about what the project does and does not accept (no bug bounty, local-only, etc.).
- Once `SECURITY.md` lands, update the `CODE_OF_CONDUCT.md` Enforcement section so its pointer line resolves cleanly (it currently reads "Contact details will be published in `SECURITY.md` before the first public release.").

**Cost:** S — ~30 min once the contact is picked.
**Decision:** Defer alongside PUB-5 — revisit when the publish target + timing is concrete.
**Status:** DEFERRED — revisit with PUB-5.

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

### PUB-9 — Windows code signing — apply for SignPath OSS sponsorship + provision 2 secrets

**Problem:** `release.yml`'s `Sign Windows bundles` step already contains the full signtool pipeline (decode .pfx, find highest-version signtool.exe in the Windows SDK, `signtool sign /fd SHA256 /t timestamp.digicert.com`, `signtool verify /pa`, `gh release upload --clobber`), gated on a `WINDOWS_CERTIFICATE_BASE64` secret. Without the cert + secrets the .msi / .exe ship unsigned and Windows SmartScreen shows "Windows protected your PC" on every install for the first ~3000 users until reputation builds (or never, for low-volume distributions).

**Decision: pursue SignPath Foundation OSS sponsorship** (free signing-as-a-service for qualifying open-source projects) rather than a paid OV/EV cert (~USD 200–400/year, EV requires hardware tokens that don't work in CI without extra plumbing).

**Concrete remaining work:**
1. **Apply** for the SignPath Foundation OSS sponsorship (search "SignPath Foundation" — the landing page URL has shifted historically and link checkers flag it as a network error in some configurations). Submit project repo URL + license + brief description. Approval typically takes 1–4 weeks.
2. **Once approved:** SignPath provides an organization-scoped API token. The simplest integration uses SignPath's GitHub Action (`signpath/github-action-submit-signing-request`), which would replace our current self-hosted signtool step. Two ways to integrate:
   - **Replace** the existing `Sign Windows bundles` step with the SignPath action — they sign in their cloud, return the signed artifact, we upload it. Cleanest, but couples to SignPath's service.
   - **Keep** the current signtool step + populate `WINDOWS_CERTIFICATE_BASE64` from a SignPath-issued cert. Less common — most SignPath users use the action — but possible for ad-hoc certs.
3. **Provision the relevant secrets** (depends on the integration path chosen above).
4. **Tag a release** to verify SmartScreen no longer warns: install the signed .msi on a clean Windows 10/11 VM, observe the "Verified publisher" line in the UAC prompt.

If SignPath denies the application (e.g., dual-licensed code, ambiguous OSS status, etc.), the fallback is a paid Sectigo/DigiCert OV cert — see `BUILD.md` → "Windows code signing" for the procurement path.

**Cost:** M — actual setup is ~30 min, but the SignPath approval cycle is the bottleneck (1–4 weeks of waiting).
**Status:** BLOCKED on SignPath Foundation approval.

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
| Net findings in this report | 333 |
| **Critical** | **3** |
| **High** | **17** |
| **Medium** | **62** |
| **Low** | **126** |
| **Info / nits** | **125** |

### Top-5 highest-priority items (Impact ÷ Cost)

1. **C-2** — Materializer drops permanent ApplyOp failures after 1 in-memory retry; op_log diverges from materialized state with no boot-time replay (<ref_file file="/home/javier/dev/org-mode-for-the-rest-of-us/src-tauri/src/materializer/consumer.rs" />).
2. **C-1** — `gcal_push::connector::run_task_loop` is a non-functional stub never wired up; the entire FEAT-5e push pipeline is dead code (<ref_file file="/home/javier/dev/org-mode-for-the-rest-of-us/src-tauri/src/gcal_push/connector.rs" />).
3. **C-3** — `delete_attachment` never unlinks the file on disk + the `DeleteAttachment` payload drops `fs_path`, so files become unrecoverable after compaction (<ref_file file="/home/javier/dev/org-mode-for-the-rest-of-us/src-tauri/src/commands/attachments.rs" />).
4. **H-1** — Pairing passphrase is never cryptographically verified; `confirm_pairing_inner` accepts any string (<ref_file file="/home/javier/dev/org-mode-for-the-rest-of-us/src-tauri/src/commands/sync_cmds.rs" />).
5. **H-2** — `mcp_set_enabled(false)` does not close the accept loop; new connections accepted until app restart (<ref_file file="/home/javier/dev/org-mode-for-the-rest-of-us/src-tauri/src/commands/mcp.rs" />).

### Findings by Domain × Severity

| Domain | Crit | High | Med | Low | Info |
|---|---|---|---|---|---|
| Core data layer | 0 | 1 | 6 | 9 | 11 |
| Materializer | 1 | 2 | 6 | 8 | 4 |
| Cache + Pagination | 0 | 1 | 6 | 12 | 6 |
| Commands (CRUD) | 0 | 2 | 8 | 10 | 13 |
| Commands (System) | 1 | 2 | 13 | 13 | 6 |
| Sync stack | 0 | 4 | 17 | 25 | 5 |
| Search & Links | 0 | 4 | 4 | 16 | 19 |
| Lifecycle / Snapshots | 0 | 0 | 18 | 16 | 8 |
| MCP | 0 | 1 | 6 | 12 | 8 |
| GCal / Spaces / Drafts | 1 | 0 | 9 | 11 | 9 |

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

### Quick wins (Cost = S, Impact ≥ Medium, Risk ≤ Medium)

| ID | Title | Why |
|---|---|---|
| **C-3** | Unlink attachment file on `delete_attachment` | One-line fix; unrecoverable file leak |
| **H-1** | Validate pairing passphrase against `pairing_state` slot | Pairing security; passphrase machinery is currently dead |
| **H-2** | Make `mcp_set_enabled(false)` close the listener | Toggle works as-advertised |
| **H-3** | Fix `create_page_in_space` bypass in journal/templates/`create_block` | "Nothing outside of spaces" invariant |
| **H-7** | Add `is_conflict = 0` + `depth < 100` to `move_block_inner` cycle CTE | One-line SQL change; data integrity |
| **M-3** | `set_page_aliases_inner` wrap in BEGIN IMMEDIATE | One-line atomicity fix |
| **M-4** | `journal::resolve_or_create_journal_page` wrap in BEGIN IMMEDIATE | TOCTOU dup-page fix |
| **M-7** | `set_priority_inner` honor user-extended priority options (1..10 not 1..3) | One-line; matches ARCHITECTURE.md §20 (UX-201b) |
| **M-23** | `MAX_BLOCK_DEPTH` enforced in `create_block_in_tx`, not just `move_block` | One-line guard, prevents bypass |
| **M-32** | `start_sync_inner` move `record_success` to AFTER actual sync | One-line fix; backoff pre-wipe bug |

---

## CRITICAL findings (3)

### C-1 — `gcal_push::connector::run_task_loop` is a non-functional stub never invoked from production
- **Domain:** GCal
- **Location:** `src-tauri/src/gcal_push/connector.rs` (run_task_loop / run_cycle); see also `src-tauri/src/lib.rs` boot-spawn calls
- **What:** The production task-loop never calls `run_cycle`. The whole FEAT-5e push pipeline ships as dead code; tests pass because they exercise `run_cycle` directly.
- **Why it matters:** Users who connect GCal see "connected" but no events ever reach the calendar. Silent feature breakage.
- **Cost:** S–M
- **Risk:** Low (re-wiring an already-tested cycle into the spawned loop)
- **Impact:** High (the only thing FEAT-5 ships)
- **Recommendation:** Wire the existing tested `run_cycle` into the spawned task loop with the documented poll/backoff cadence; add a smoke test that exercises the spawn path.
- **Pass-1 source:** 10-gcal-spaces-misc / F1

### C-2 — Foreground `ApplyOp` / `BatchApplyOps` permanent failures lose state with no retry (parent — split into C-2a, C-2b)
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/consumer.rs:177-179`; `src-tauri/src/materializer/retry_queue.rs:59-72`; `src-tauri/src/recovery/boot.rs:43-126`
- **What:** After a single 100ms in-memory retry, `ApplyOp`/`BatchApplyOps` failures only bump `fg_errors` and the task is dropped. `RetryKind::from_task` excludes both task types, so the persistent retry queue is bypassed. There is no boot-time op-log replay path — `recover_at_boot` only handles drafts and pending snapshots.
- **Why it matters:** Op log is durable but materialized core tables silently diverge from it. Data correctness depends entirely on every apply succeeding within ~100ms; a transient FK violation, lock contention, or disk hiccup leaves the user with phantom blocks. There is no automatic remediation.
- **Cost:** L (combined) — split into C-2a (S, defense-in-depth detection) + C-2b (M-L, the actual replay path). C-2a should land first; C-2b can be scheduled separately when the user is ready for the larger change.
- **Pass-1 source:** 02-materializer / F1 (verdict: CONFIRMED at Critical)

### C-2a — Detect & log materializer divergence (no semantic change)
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/consumer.rs:177-179`; `src-tauri/src/materializer/metrics.rs`
- **What:** When the foreground retry exhausts (`Ok(Err(_)) | Err(_)` after the 100ms attempt), log the failed task with `op_log` seq + device_id + payload type at warn level, increment a new `fg_apply_dropped` metric, and emit a Tauri event so the StatusInfo banner can surface "N ops failed to materialize" to the user. Does NOT change retry semantics — purely observability.
- **Why it matters:** Until C-2b lands, divergence is invisible. C-2a makes it visible to the user and to the integration test harness so future regressions don't go unnoticed.
- **Cost:** S
- **Risk:** Low (additive logging + metric)
- **Impact:** Medium (visibility, blocks C-2b reviewer being unable to verify "before/after" without it)
- **Recommendation:** Land C-2a first as a defense-in-depth slice. Once we're confident in the divergence rate observed in the wild, decide whether to schedule C-2b.
- **Status:** Open. No dependencies.

### C-2b — Boot-time op-log replay path for unmaterialized ops
- **Domain:** Materializer / Recovery
- **Location:** `src-tauri/src/recovery/boot.rs:43-126`; `src-tauri/src/materializer/coordinator.rs`
- **What:** On boot, identify ops whose materialized state is missing or stale (e.g., compare `op_log` max-seq vs each derived table's high-water mark) and re-enqueue them through the materializer foreground queue. Idempotent: every existing op handler is already idempotent or trivially convertible (the materializer ALREADY uses `INSERT OR IGNORE` / UPSERT on the convergence path).
- **Why it matters:** This is the actual fix for C-2. With it, op log truly is the source of truth: even after a crash mid-apply or a transient FK contention drop, the next boot reconciles automatically.
- **Cost:** M–L
- **Risk:** Medium (idempotency must be verified end-to-end across every op handler; replay needs progress markers so a partial replay survives a second crash)
- **Impact:** High (closes the last automatic-divergence gap in CQRS)
- **Recommendation:** Build on the existing `recover_at_boot` infrastructure. Each derived table tracks a "materialized through seq N" cursor; the replay walks `op_log WHERE seq > cursor`. Add an integration test that injects ApplyOp failure mid-batch, restarts the pool, and asserts state convergence post-replay.
- **Status:** Open. Depends on C-2a (need divergence visibility before changing retry semantics).

### C-3 — `delete_attachment` leaks the on-disk file forever; non-reversible op drops `fs_path` (parent — split into C-3a, C-3b, C-3c)
- **Domain:** Commands / Attachments
- **Location:** `src-tauri/src/commands/attachments.rs:138-179` (`delete_attachment_inner`); `src-tauri/src/materializer/handlers.rs:508-514`
- **What:** `delete_attachment_inner` runs an op-log append + `DELETE FROM attachments` inside one IMMEDIATE tx but never calls `remove_file`. The materializer handler is also pure SQL. The `DeleteAttachment` op payload drops `fs_path`; combined with the op being non-reversible and the materializer's `cleanup_orphaned_attachments` being an explicit no-op, the file is unrecoverable + untrackable after compaction.
- **Why it matters:** Permanent storage leak and impossible to garbage-collect even with a full vault scan because the op log no longer remembers the path.
- **Cost:** M (combined) — split into C-3a (S, payload extension), C-3b (S, fs unlink), C-3c (S–M, GC pass). C-3a + C-3b should land in the same session; C-3c can be a separate slice.
- **Pass-1 source:** 05-commands-system / F1

### C-3a — Extend `DeleteAttachment` payload to carry `fs_path`
- **Domain:** Commands / Op log schema
- **Location:** `src-tauri/src/op.rs` (`DeleteAttachmentPayload`); `src-tauri/src/commands/attachments.rs::delete_attachment_inner`
- **What:** Add `fs_path: String` to the `DeleteAttachment` op payload. Serialize/deserialize forward-compatibly (skip on missing during deserialization for backwards compat with existing op-log entries written before this change).
- **Why it matters:** Without `fs_path` in the payload, no GC pass can correlate op-log delete events with on-disk files. This is the prerequisite for C-3b and C-3c.
- **Cost:** S
- **Risk:** Low — extending an existing op payload (additive field, default on missing). Per AGENTS.md "Architectural Stability": op-payload extension is allowed within the existing op-type and DOES NOT require user approval.
- **Impact:** Medium (unblocks C-3b + C-3c)
- **Recommendation:** Add the field, regenerate `.sqlx/` cache, run `cargo sqlx prepare`, snapshot test the new payload shape. Update `commands/attachments.rs::delete_attachment_inner` to populate the field from the just-fetched attachment row.
- **Status:** Open. No dependencies.

### C-3b — Call `fs::remove_file` inside `delete_attachment_inner`
- **Domain:** Commands / Attachments
- **Location:** `src-tauri/src/commands/attachments.rs::delete_attachment_inner`
- **What:** After the DB delete inside the existing IMMEDIATE tx, call `tokio::fs::remove_file(fs_path)`. If the file is already missing (e.g. user deleted it manually), log at info level and continue — do not fail the command. If the remove fails for another reason (e.g. permission denied), log at warn level and continue — the op-log entry is still authoritative; C-3c will GC the orphan.
- **Why it matters:** Closes the immediate leak for new deletes. Existing leaked files (pre-this-change) are recovered by C-3c.
- **Cost:** S
- **Risk:** Low — `remove_file` failures are non-fatal and logged; no FK or schema impact.
- **Impact:** High — closes the leak going forward.
- **Recommendation:** Land in the same session as C-3a. Add a Rust test that verifies the file is removed on success and that a missing-file scenario logs but does not error.
- **Status:** Open. Depends on C-3a (needs `fs_path` in the payload to be reliable across compaction).

### C-3c — Implement `cleanup_orphaned_attachments` (FS ↔ DB reconciliation)
- **Domain:** Materializer / Lifecycle
- **Location:** `src-tauri/src/materializer/handlers.rs::cleanup_orphaned_attachments`
- **What:** Replace the no-op TODO with a real GC pass: scan the attachments directory, list every file, query `attachments.fs_path` for matches, and remove files that are not referenced. Schedule the pass at boot and after compaction. Bound the scan with a directory-listing chunk size so vaults with many files do not block.
- **Why it matters:** Recovers files leaked before C-3a/C-3b shipped; provides ongoing defense-in-depth for any future code path that drops `fs_path` from a payload.
- **Cost:** S–M
- **Risk:** Medium — accidental deletion of a still-referenced file would be data loss. Test exhaustively.
- **Impact:** Medium — recovers space; defense in depth for future bugs.
- **Recommendation:** Add an exhaustive test set (file referenced + not referenced + referenced by an op that compacted out + referenced by the upcoming compaction). Consider a "dry-run" mode that logs what would be deleted before enabling actual deletion in production.
- **Status:** Open. Depends on C-3a + C-3b having shipped (so the ongoing path is correct before retroactive GC runs).

---

## HIGH findings (17)

### H-1 — Pairing passphrase is never cryptographically verified
- **Domain:** Sync / Commands
- **Location:** `src-tauri/src/commands/sync_cmds.rs::confirm_pairing_inner`; `src-tauri/src/pairing.rs::verify_device_exchange` (dead code); ARCHITECTURE.md §18 line ~1737 says "Validate passphrase"
- **What:** `confirm_pairing_inner` does not validate the supplied passphrase against the active `pairing_state` slot. Any string succeeds. The entire `PairingMessage` + `verify_device_exchange` machinery is dead code.
- **Why it matters:** Even within the single-user threat model, pairing-time MITM detection is the one place where adversarial input matters because the user has typed the passphrase from a trusted out-of-band channel. A bug here defeats the only check that confirms "this peer is the device that scanned my QR".
- **Cost:** S
- **Risk:** Medium (must keep pairing UX intact while fixing)
- **Impact:** High
- **Recommendation:** Wire `confirm_pairing_inner` to `pairing.rs::verify_device_exchange` against the active `pairing_state` slot; add a test that asserts a wrong passphrase fails.
- **Pass-1 source:** 06-sync / F1; 05-commands-system / F16 (downgraded to Medium by Pass 2 commands-system but kept High by sync reviewer; we keep High).

### H-2 — `mcp_set_enabled(false)` does not stop the accept loop
- **Domain:** MCP / Commands
- **Location:** `src-tauri/src/commands/mcp.rs::mcp_set_enabled`; `src-tauri/src/mcp/server.rs` accept loop
- **What:** `notify_waiters()` is one-shot and edge-triggered. New connections after the disable register a fresh waiter and proceed normally; the listener stays open until app restart.
- **Why it matters:** Toggle does not actually disable the surface. Users who flip the switch off still expose MCP RW tools to local clients.
- **Cost:** S
- **Risk:** Low
- **Impact:** High (user trust in toggle)
- **Recommendation:** Replace one-shot `Notify` with an `AtomicBool` checked in the accept loop AND drop the listener bind on disable. Add an integration test asserting that a connection attempt after `set_enabled(false)` fails.
- **Pass-1 source:** 09-mcp / F2; 05-commands-system / F21

### H-3 — `create_page_in_space` bypassed by 3+ callsites; "nothing outside of spaces" invariant violated daily (parent — split into H-3a, H-3b, H-3c)
- **Domain:** Spaces / Commands
- **Location:** `src/components/JournalPage.tsx:170` (frontend); `src/components/TemplatesView.tsx:77` (frontend); `src-tauri/src/commands/journal.rs::resolve_or_create_journal_page`; `src-tauri/src/commands/blocks/crud.rs::create_block` (accepts `block_type='page'` with no space enforcement)
- **What:** Bootstrap migrates only existing-at-first-boot pages. New daily journal pages, template pages, and direct `create_block` IPC calls produce pages with no `space` property. FEAT-3 Phase 1 documentation claims atomicity via `create_page_in_space` but the IPC backend doesn't enforce it.
- **Why it matters:** Cross-space leak. Every new journal page after install is invisible to space-scoped queries. The "Personal/Work" partition silently degrades over time.
- **Cost:** M (combined) — split into H-3a (S–M, backend enforcement), H-3b (S, frontend callsites), H-3c (S, property test). Recommend H-3a → H-3b → H-3c in one session.
- **Pass-1 source:** 10-gcal-spaces-misc / F4, F5, F26; cross-references 04-commands-crud / F5

### H-3a — Backend `create_block` IPC: enforce space property atomicity for `block_type='page'`
- **Domain:** Spaces / Commands
- **Location:** `src-tauri/src/commands/blocks/crud.rs::create_block_in_tx`
- **What:** Choose ONE of two enforcement options and implement it: (a) reject `block_type='page'` from `create_block_in_tx` and return an error pointing the caller at `create_page_in_space`; (b) accept `block_type='page'` with a required `space_id` parameter and set the `space` property atomically inside the existing tx when the type is `page`. Option (b) is more defensive (callers can't forget to migrate) but changes the IPC contract for callers that don't yet pass `space_id`. Recommend option (b) with `space_id: Option<String>` defaulting to current-space if None — which keeps the IPC contract additive.
- **Why it matters:** This is the structural fix. Without backend enforcement, every new feature added by future sessions that calls `create_block({blockType: 'page'})` re-introduces the bug.
- **Cost:** S–M
- **Risk:** Medium — IPC contract change for `create_block`. Existing frontend callsites must continue to work; H-3b migrates them. Coordinate frontend-backend in a single session if option (b) is chosen with a new required arg.
- **Impact:** High
- **Recommendation:** Implement option (b) with `space_id: Option<String>`. Inside the tx: when `block_type == "page"` and `space_id` is None, fall back to the current default space (the resolver already exists in `commands/spaces.rs`). When non-None, set the `space` property in the same tx. Add tests: page creation with explicit space, page creation with None (defaults), non-page creation ignores `space_id`.
- **Status:** Open. Should land before H-3b. Couples loosely with FEAT-3p5 (per-space journal) — ideally land H-3a first, then FEAT-3p5 builds on it.

### H-3b — Frontend journal/templates/`createBlock` callsites switch to `create_page_in_space` / `createPageInSpace`
- **Domain:** Frontend / Spaces
- **Location:** `src/components/JournalPage.tsx:170`; `src/components/TemplatesView.tsx:77`; any other callsites flagged by grep `createBlock\(\{[^)]*blockType:\s*['"]page`
- **What:** Replace direct `createBlock({blockType: 'page'})` calls with `createPageInSpace(currentSpaceId, …)`. Update JournalPage's 4 internal page-creation callsites (also referenced in FEAT-3p5). Add a Biome lint or test guard preventing future regressions if feasible (e.g., a vitest unit test that greps the source for the forbidden pattern).
- **Why it matters:** Closes the frontend half of H-3. With H-3a's backend enforcement, this is belt-and-suspenders, but the explicit calls also clarify intent for readers.
- **Cost:** S
- **Risk:** Low — purely additive on the frontend (uses an already-existing wrapper).
- **Impact:** High (combined with H-3a) — together they close the bypass.
- **Recommendation:** Land in the same session as H-3a. Update component tests where they assert on `createBlock` mock calls.
- **Status:** Open. Depends on H-3a (backend must accept the new shape first).

### H-3c — Property test: every page block has a non-null `space` property
- **Domain:** Tests / Spaces
- **Location:** `src-tauri/src/commands/spaces.rs` tests; `src-tauri/src/integration_tests.rs` (or a new spaces-invariant test file)
- **What:** Add a property test (`fast-check` / `proptest`) that, after any sequence of valid command operations, asserts: for every block where `block_type = 'page' AND id NOT IN (seeded_space_ulids)`, the `space` property is non-null. Run on a few thousand random op sequences.
- **Why it matters:** Catches future regressions from any new op-handler or command path that creates page blocks. Makes "nothing outside of spaces" a machine-checkable invariant.
- **Cost:** S
- **Risk:** Low (test-only).
- **Impact:** Medium — guards the structural invariant going forward.
- **Recommendation:** Use the existing fast-check / proptest harness. Generator: random sequences of CreateBlock + SetProperty + DeleteBlock for varying block types and content. Assert the invariant after each materialization step.
- **Status:** Open. Depends on H-3a + H-3b (the invariant must already hold before the property test will pass).

### H-4 — `set_todo_state_inner` runs the state change, timestamp writes, and recurrence sibling creation across separate transactions
- **Domain:** Commands / Recurrence
- **Location:** `src-tauri/src/commands/properties.rs::set_todo_state_inner`; cross-ref `recurrence::handle_recurrence`
- **What:** State change → property writes (`created_at` / `completed_at`) → recurrence-sibling creation are all separate ops with no enclosing `BEGIN IMMEDIATE`.
- **Why it matters:** A crash mid-sequence on a recurring task can leave a `done` state with no completed-at timestamp and no next-occurrence sibling. The user is silently "stuck" on a task whose recurrence never advances.
- **Cost:** M
- **Risk:** Medium (recurrence handler signature change)
- **Impact:** High
- **Recommendation:** Wrap the entire state transition + property writes + recurrence sibling creation in a single `BEGIN IMMEDIATE` via a new `set_todo_state_in_tx`. The recurrence handler already uses `_in_tx` variants — exposes them.
- **Pass-1 source:** 04-commands-crud / F2

### H-5 — Parallel block_id groups can violate parent→child FK ordering during BatchApplyOps
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/consumer.rs` (JoinSet group dispatch)
- **What:** The foreground consumer parallelizes independent block_id groups via JoinSet, but a CreateBlock cascade (parent then immediate child) split across two groups can apply child before parent. SQLite FK error on apply.
- **Why it matters:** Producible during normal sync replay (parent op + child op in a single batch). Currently masked because production retries within 100ms.
- **Cost:** M
- **Risk:** Medium (group-key needs to encode lineage, not just block_id)
- **Impact:** High
- **Recommendation:** Group by root-of-op (use `parent_id` chain, fall back to block_id when no parent_id) so cascading parent/child stays serialized. Pass 2 noted that the pass-1 reviewer's "PRAGMA defer_foreign_keys" suggestion does NOT fix this because each `apply_op` opens its own tx; need a new grouping key.
- **Pass-1 source:** 02-materializer / F2

### H-6 — `BatchApplyOps` grouping uses only the first record's block_id
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/dedup.rs`
- **What:** A `BatchApplyOps` containing N ops over different block_ids is grouped solely by `records[0].block_id`. Other records' block_ids are not represented in the dispatch key.
- **Why it matters:** Two batches whose first records collide but whose remaining records target different blocks can serialize in unintended ways; conversely, two batches whose first records differ but whose remaining records collide can run in parallel and step on each other.
- **Cost:** M
- **Risk:** Medium
- **Impact:** High
- **Recommendation:** Either split BatchApplyOps into per-block-id sub-batches at dispatch time, or compute a multi-key grouping (HashSet of all block_ids; serialize batches whose key sets overlap). Pass 2 confirmed the pass-1 "return None" remediation does NOT serialize because the None bucket still races with other groups via JoinSet.
- **Pass-1 source:** 02-materializer / F3

### H-7 — `move_block_inner` cycle-detection CTE missing `is_conflict = 0` and `depth < 100`
- **Domain:** Commands / CRUD
- **Location:** `src-tauri/src/commands/blocks/move_ops.rs::move_block_inner`
- **What:** The recursive cycle-detection CTE has neither the conflict filter nor the depth bound, contradicting AGENTS.md invariant #9.
- **Why it matters:** Conflict copies leak into the cycle check (false positives blocking a legitimate move); a corrupted parent_id chain runs unbounded recursion.
- **Cost:** S (one SQL line)
- **Risk:** Low
- **Impact:** High (data correctness + DoS-against-self)
- **Recommendation:** Add `AND is_conflict = 0 AND depth < 100` to the recursive member.
- **Pass-1 source:** 04-commands-crud / F1

### H-8 — `list_agenda_range` cursor encodes `b.due_date`/`b.scheduled_date`, not `ac.date`
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/pagination/agenda.rs::list_agenda_range`
- **What:** The cursor encodes block-column dates instead of the `agenda_cache.date` actually used for sort. When an agenda entry's date comes from a property or tag source, the cursor doesn't match what the next page filters on.
- **Why it matters:** Duplicates and skips in agenda pagination — user sees double-counted or missing items at page boundaries. Hard-to-reproduce because it depends on which date source was authoritative for that row.
- **Cost:** S
- **Risk:** Low (cursor change is backward-incompatible; add a version byte)
- **Impact:** High
- **Recommendation:** Encode `ac.date` in the cursor; bump cursor version field.
- **Pass-1 source:** 03-cache-pagination / F1

### H-9 — Bug-report redaction allow-list misses GCal email, peer device IDs, and any other PII (parent — split into H-9a, H-9b, H-9c)
- **Domain:** Commands / System
- **Location:** `src-tauri/src/commands/bug_report.rs`
- **What:** Redaction only scrubs `$HOME` + local `device_id`. GCal account email (in error logs), peer device IDs (in sync error context), any property value with PII pass through verbatim into the ZIP destined for GitHub.
- **Why it matters:** Bug reports cross the trust boundary the feature exists to police — the GitHub repo is public.
- **Cost:** L (combined) — split into H-9a (S, targeted scrubs — covers the user-visible regression today), H-9b (M, generic redaction architecture), H-9c (M, preview UI). H-9a is the immediate priority; H-9b + H-9c can be scheduled separately.
- **Pass-1 source:** 05-commands-system / F5

### H-9a — Bug-report: add specific scrubs for GCal email, peer device IDs, and email regex
- **Domain:** Commands / System
- **Location:** `src-tauri/src/commands/bug_report.rs::redact_log` (and similar redact helpers)
- **What:** Extend the existing `$HOME` + `device_id` allow-list with three additional scrubs: (1) GCal account email (`oauth_account_email` from the keyring or in-memory state at redact time), (2) every known peer device ID (from `peer_refs` table at redact time), (3) a generic `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}` email regex as a catch-all. Existing tests for redaction continue to pass; add three new ones.
- **Why it matters:** Closes the immediate user-facing leak today. Cheap, low-risk, doesn't require redesign.
- **Cost:** S
- **Risk:** Low
- **Impact:** High (closes the most likely PII leak vectors)
- **Recommendation:** Land first. The list of "known peer device IDs" comes from a single `SELECT device_id FROM peer_refs` at redact time — no architecture change.
- **Status:** Open. No dependencies.

### H-9b — Bug-report: replace allow-list with deny-list-of-tokens architecture
- **Domain:** Commands / System
- **Location:** `src-tauri/src/commands/bug_report.rs`
- **What:** Refactor the redact pipeline from "scrub these specific values" to "include only these specific token classes" (e.g. ULIDs, op_log seqs, error type names, file:line refs, well-known tracing field keys). Anything outside the safe-token set is replaced with `[REDACTED]`. Conservative-by-default: a property value that doesn't fit a known type gets redacted.
- **Why it matters:** Makes the redaction posture future-proof — every new field added to a log line is redacted by default rather than leaked by default.
- **Cost:** M
- **Risk:** Medium (false positives can make logs hard to read; need careful tuning of the safe-token set)
- **Impact:** High
- **Recommendation:** Build on top of H-9a. Use the existing `tracing` JSON output as the input format; the safe-token set lives in a single constant array in `bug_report.rs`. Add a property test that no value outside the safe set survives the pipeline.
- **Status:** Open. Should land after H-9a (which covers the immediate regression).

### H-9c — Bug-report: "are you sure" UI showing the redacted preview before submit
- **Domain:** Frontend / Commands
- **Location:** `src/components/BugReportDialog.tsx`; `src-tauri/src/commands/bug_report.rs` (preview command)
- **What:** Before the report ZIP is finalized for upload (or download to disk), show the user the redacted contents in a scrollable diff-style preview with a "Submit" button gated on the user's confirmation. Also expose a checkbox "I have reviewed the redacted output" required to enable Submit.
- **Why it matters:** Defense-in-depth. Even with H-9a + H-9b, the user is the last line of defense for "did this leak my company email, my client name, my password I accidentally typed into a note?". The preview surfaces what's actually being sent.
- **Cost:** M
- **Risk:** Low (additive UI, no data path change)
- **Impact:** High (user trust in the bug-report feature)
- **Recommendation:** Tauri command `bug_report_preview()` returns the same redacted bundle as the existing submit, but does not upload. The dialog renders it via the existing `ScrollArea` + diff viewer primitives. Cross-references UX-277 (`BugReportDialog` polish — adding "no log-content preview before submit" was already filed there at S cost; this finding promotes it to H-9c with a richer scope).
- **Status:** Open. Independent of H-9a / H-9b. May supersede the "no log-content preview" item in UX-277 — when H-9c lands, drop the preview bullet from UX-277.

### H-10 — `Created { Desc }` cursor pagination silently empty past page 1
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/query.rs::eval_backlink_query`
- **What:** Uses `binary_search_by` on a descending slice — returns `Err(0)` for any cursor target greater than first element, producing empty page.
- **Why it matters:** Backlink browsing in Created-Desc mode loses everything past the first page. User-visible.
- **Cost:** S
- **Risk:** Low
- **Impact:** High
- **Recommendation:** Use `partition_point` or invert the comparator to handle descending slices; add a regression test.
- **Pass-1 source:** 07-search-links / F3

### H-11 — Backlink grouped query: `total_count` / `filtered_count` drift for orphan source blocks
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/query.rs::eval_backlink_query_grouped`
- **What:** Self-reference filtering happens after the IN-clause fetch; `total_count` set from pre-filter length so it reports more results than the user actually sees, and orphan source blocks (no resolvable page) inflate the count further.
- **Why it matters:** UI badge shows "23 backlinks" but only 19 render. AGENTS.md "Backend Patterns" #4 explicitly mandates post-filter count.
- **Cost:** S
- **Risk:** Low
- **Impact:** High
- **Recommendation:** Compute `total_count` after self-reference + orphan filtering.
- **Pass-1 source:** 07-search-links / F4

### H-12 — `flush_draft` bypasses `MAX_CONTENT_LENGTH` and never validates target block exists (parent — split into H-12a, H-12b)
- **Domain:** Drafts / Commands
- **Location:** `src-tauri/src/commands/drafts.rs::flush_draft_inner`
- **What:** Two issues conflate: oversized content and orphan target. `flush_draft` doesn't check the 256 KB cap and doesn't verify the target block_id exists; combined with the missing FK on `block_drafts.block_id` (see M-93), a stale draft can flush an `edit_block` op pointing nowhere.
- **Why it matters:** A single user action lets oversized or orphan ops enter the append-only log. Op log is supposed to be the source of truth — invalid entries persist forever.
- **Cost:** M (combined) — split into H-12a (S, validate target) + H-12b (S, enforce size cap). Land both in one session.
- **Pass-1 source:** 10-gcal-spaces-misc / F6, F7

### H-12a — `flush_draft_inner`: validate target block exists before op-log append
- **Domain:** Drafts / Commands
- **Location:** `src-tauri/src/commands/drafts.rs::flush_draft_inner`
- **What:** Before constructing and appending the `EditBlock` op, verify the target block_id is present in `blocks` AND `deleted_at IS NULL`. If absent, drop the draft (with a warn log + tracing event) instead of writing the orphan op. Run inside the existing tx so the check and the append are atomic.
- **Why it matters:** Closes the orphan-op leak vector: stale drafts (e.g., user deleted the block on another device, then this device's connector flushed an old draft) no longer pollute the op log.
- **Cost:** S
- **Risk:** Low — strictly defensive; refusing to flush an orphan is the correct behavior.
- **Impact:** High
- **Recommendation:** Use `query_scalar!` for the existence check inside the same `BEGIN IMMEDIATE` tx. Drop the draft row if the target is missing — same UX as a successful flush that produces no observable change.
- **Status:** Open. Independent of H-12b.

### H-12b — `flush_draft_inner`: enforce `MAX_CONTENT_LENGTH` (256 KB)
- **Domain:** Drafts / Commands
- **Location:** `src-tauri/src/commands/drafts.rs::flush_draft_inner`
- **What:** Before constructing the `EditBlock` op, check that the draft content's UTF-8 byte length does not exceed `MAX_CONTENT_LENGTH` (the same constant the regular edit path enforces). If exceeded, return an error to the user and KEEP the draft (so the user can edit it down) — DO NOT silently truncate.
- **Why it matters:** Closes the oversized-op leak vector. Op log integrity preserved.
- **Cost:** S
- **Risk:** Low
- **Impact:** High
- **Recommendation:** Reuse the existing `MAX_CONTENT_LENGTH` constant. The same UX as the regular edit path: a clear error, the draft survives, the user can decide how to shrink it. Add a test asserting that a 257 KB draft errors out and stays unflushed.
- **Status:** Open. Independent of H-12a.

### H-13 — `Op-log immutability has zero database-level enforcement
- **Domain:** Core
- **Location:** `src-tauri/src/op_log.rs:1199-1247` (test that documents the lack of enforcement)
- **What:** Bare UPDATE/DELETE against `op_log` succeed; only the materializer convention prevents mutation. The existing test `op_log_update_not_blocked_by_schema` documents this explicitly.
- **Why it matters:** AGENTS.md invariant #1 ("Op log is strictly append-only — never mutate, never delete (except compaction)") is enforced by convention only. A future bug or third-party tool can violate it without the DB protesting.
- **Cost:** M
- **Risk:** Medium (compaction needs a way through)
- **Impact:** High (this is invariant #1)
- **Recommendation:** Add `BEFORE UPDATE`/`BEFORE DELETE` triggers on `op_log` that allow only the compaction path (e.g., gated by a session-scoped `PRAGMA application_id` or a transaction-attached audit row). Document the bypass.
- **Pass-1 source:** 01-core-data / F2

### H-14 — `apply_remote_ops` silently drops fork ops via `INSERT OR IGNORE`
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_protocol/operations.rs::apply_remote_ops`
- **What:** When a peer sends an op with the same `(device_id, seq)` but a different hash (a fork), `INSERT OR IGNORE` accepts the first one wins; the divergent op is silently dropped with no log, metric, or surfaced fork detection.
- **Why it matters:** Forks are the canary for a serious bug (clock skew, device-id collision, replay loop). Silent dropping makes them invisible to the user and to the test suite.
- **Cost:** S–M
- **Risk:** Low
- **Impact:** High (data integrity observability)
- **Recommendation:** Detect `(device_id, seq)` collision before INSERT; on hash mismatch, log + emit a sync warning event + persist a fork record for diagnostics.
- **Pass-1 source:** 06-sync / F4

### H-15 — `fetch_link_metadata` uses the WritePool for a mostly-read operation
- **Domain:** Commands / Link metadata
- **Location:** `src-tauri/src/commands/link_metadata.rs::fetch_link_metadata`
- **What:** Inverse of the split-pool pattern: a network-bound, read-heavy command holds the WritePool while doing HTTP. Blocks all writes.
- **Why it matters:** Page render that triggers metadata fetch can stall every other write in the app for the duration of the HTTP request.
- **Cost:** S
- **Risk:** Low
- **Impact:** High (UX latency)
- **Recommendation:** Take the read pool for the read-existing path; only acquire the writer for the final upsert.
- **Pass-1 source:** 05-commands-system / F27

### H-16 — `Clock::today()` returns UTC, not local
- **Domain:** GCal / Recurrence
- **Location:** `src-tauri/src/gcal_push/clock.rs::today`; second site in `clamp_to_window`
- **What:** Window filtering and dirty-set clamping use UTC date; user-visible "today" silently shifts ±1 day across time zones.
- **Why it matters:** Agenda-day push to GCal goes to the wrong calendar day for users near 00:00 local. Recurrence checks against "today" misfire.
- **Cost:** S
- **Risk:** Low
- **Impact:** High
- **Recommendation:** Use `chrono::Local::now().date_naive()`; thread a `TimeZone` reference if Android needs explicit zone handling.
- **Pass-1 source:** 10-gcal-spaces-misc / F3, F22

### H-17 — `recurrence::handle_recurrence` reads counters BEFORE `BEGIN IMMEDIATE` (TOCTOU)
- **Domain:** Recurrence
- **Location:** `src-tauri/src/recurrence/handle.rs::handle_recurrence`
- **What:** Reads `repeat-count` and `repeat-seq` outside the write transaction; concurrent state transitions race the increment.
- **Why it matters:** Two clicks of "done" on a recurring task can both create a sibling (duplicate next-occurrence) or skip the increment.
- **Cost:** S
- **Risk:** Low
- **Impact:** High
- **Recommendation:** Move the counter reads inside the `BEGIN IMMEDIATE` block.
- **Pass-1 source:** 08-lifecycle-snapshots / F19

---

## MEDIUM findings (96 — expanded)

> Each entry is now a fully-detailed block (Domain / Location / What / Why / Cost / Risk / Impact / Recommendation / Pass-1 source / Status) ready to be picked up.

### Core data layer

### M-1 — `attachment_id` typed as `String` bypasses ULID uppercase normalization
- **Domain:** Core
- **Location:** `src-tauri/src/op.rs:189-203`
- **What:** `AddAttachmentPayload.attachment_id` and `DeleteAttachmentPayload.attachment_id` are declared as `String` rather than the existing `AttachmentId` alias for `BlockId` (defined at `ulid.rs:32`). Because `OpPayload::normalize_block_ids` is now a documented no-op that relies on `BlockId`'s auto-uppercase contract on construction/deserialization, raw `String` fields skip that contract and feed un-normalized bytes into `serialize_inner_payload` → `compute_op_hash`.
- **Why it matters:** AGENTS.md invariant #8 makes ULID uppercase normalization a blake3 hash-determinism prerequisite for cross-device sync. If a frontend bug ever stamps a lowercase `attachment_id` on one device, the same logical op produces two different hashes across devices and the chain silently fails to converge — a single-user multi-device sync correctness bug, not adversarial.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Replace the two `attachment_id: String` fields with `attachment_id: AttachmentId` (the existing alias of `BlockId`). The serde wire shape stays a transparent string. Add a regression test mirroring `normalized_and_unnormalized_ulid_produce_same_hash` in `op_log.rs`.
- **Pass-1 source:** 01/F1
- **Status:** Open

### M-2 — `AppError::{Database, Io, Json, Migration}` Serialize forwards raw inner messages to the frontend
- **Domain:** Core
- **Location:** `src-tauri/src/error.rs:91-162` (the `#[error("…: {0}")]` strings + `serialize_field("message", &self.to_string())` at line 159); contradicted by `ARCHITECTURE.md:1259-1263`
- **What:** The four `#[from]` variants format with the inner error's `Display`, and the manual `Serialize` impl writes that full string into the `message` IPC field. ARCHITECTURE.md §15 documents the opposite contract: *"Database, IO, and JSON errors are replaced with generic 'internal error' messages before reaching the frontend. Original errors are logged server-side for debugging."*
- **Why it matters:** Doc/code drift on a contract the documentation describes as security-relevant. Even within the single-user threat model, sqlx error formats include SQL fragments, constraint names, and absolute on-disk paths (homedir / app data dir) that surface in dialogs, error toasts, and bug-report attachments — operationally noisy and confusing for users.
- **Cost:** M
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Pick one and align: (a) implement the documented sanitization in the `Serialize` impl by emitting `"internal error: <kind>"` for `Database`/`Io`/`Json`/`Migration` while the original keeps going to `tracing::error!`; or (b) update `ARCHITECTURE.md:1259-1263` to match what the code actually does. Either path is fine — pick one.
- **Pass-1 source:** 01/F3
- **Status:** Open

### M-3 — AGENTS.md says `AppError` has 11 variants; code has 12 (`Gcal`)
- **Domain:** Core
- **Location:** `AGENTS.md:174` vs `src-tauri/src/error.rs:91-131`
- **What:** AGENTS.md states `AppError` has 11 variants and lists them by name, but the implementation also defines `AppError::Gcal(#[from] GcalErrorKind)` at `error.rs:129-130`. The `Serialize` impl at `error.rs:142-155` correctly emits the `"gcal"` `kind` string, which is also missing from the AGENTS.md description.
- **Why it matters:** AGENTS.md is the norms-of-record for review agents and contributors; an off-by-one that omits a real variant teaches every future reviewer the wrong invariant and obscures a documented frontend `kind` discriminator.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Update AGENTS.md:174 to say "12 variants" and append `Gcal`. While there, list the `kind` strings (`"database" | "migration" | … | "gcal"`) since the doc claims the frontend matches on `kind`. **Requires explicit user approval per AGENTS.md self-rule (no AGENTS.md edits without approval).**
- **Pass-1 source:** 01/F4
- **Status:** Open

### M-4 — `find_lca` has no max-iteration cap despite ARCHITECTURE.md claiming 10,000
- **Domain:** Core
- **Location:** `src-tauri/src/dag.rs:186-292` vs `ARCHITECTURE.md:360` (and the cross-reference at `ARCHITECTURE.md:1853-1854`)
- **What:** ARCHITECTURE.md §4 says of the LCA chain walk: *"Cycle detection: max 10,000 iterations."* The actual implementation uses a `HashSet`-based cycle break only (`dag.rs:218-236` / `267-288`); there is no numeric step counter. A grep across the crate confirms no `MAX_ITER`-style constant is wired into `find_lca`.
- **Why it matters:** A bug or schema corruption that produces an extremely long acyclic chain (>10⁴ entries) makes `find_lca` issue an unbounded number of `get_op_by_seq` SELECTs, each one a separate pool acquire on the write pool. The HashSet only terminates on a repeated `(device_id, seq)` — there is no fail-fast for "chain is pathologically long".
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Either add `const LCA_MAX_STEPS: usize = 10_000;` and increment a counter on each iteration of both walks, returning `AppError::InvalidOperation("LCA walk exceeded 10000 steps")` on overflow; or update `ARCHITECTURE.md:360` to describe the actual HashSet-only mechanism. The code already has a `# Compaction limitation` doc-comment — extend it.
- **Pass-1 source:** 01/F5
- **Status:** Open

### M-5 — `dag::insert_remote_op` does not verify `parent_seqs` references resolve
- **Domain:** Core
- **Location:** `src-tauri/src/dag.rs:48-89`
- **What:** The function verifies the blake3 hash matches the stored payload+metadata, then `INSERT OR IGNORE`s the op. It does not parse `record.parent_seqs` and check that each `(device_id, seq)` entry already exists in `op_log`. A buggy peer or a corrupted stream can therefore land a row whose parent pointer dangles.
- **Why it matters:** The single-user threat model rules out hardening against malicious peers, but data-integrity is the explicit defensive priority. A dangling parent silently breaks later DAG walks (`find_lca`, history reconstruction) with `NotFound` errors that surface as inscrutable sync failures. One extra SELECT per remote op turns "silent bad chain" into "fail-fast on insert".
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** After hash verification, parse `record.parent_seqs` (if not null) and run a single `SELECT COUNT(*) FROM op_log WHERE (device_id, seq) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))` against the parent list; reject with `AppError::InvalidOperation("parent_seqs references missing op")` if the count differs from the array length. The orchestrator can still queue and retry — the on-disk row never lands before its parent.
- **Pass-1 source:** 01/F11
- **Status:** Open

### M-6 — `cleanup_orphaned_attachments` is a no-op TODO that ships in production
- **Domain:** Core
- **Location:** `src-tauri/src/materializer/handlers.rs:520-524` (handler), `:571` (dispatch wiring)
- **What:** The handler returns `Ok(())` after a single `tracing::debug!` and an explicit `let _ = pool;`. The `MaterializeTask::CleanupOrphanedAttachments` variant is wired through dispatch and tested as if it works. With `delete_block`/purge already operational and attachment file transfer running through the sync daemon, attachment files in the on-disk store are never reclaimed.
- **Why it matters:** On a long-lived install, deleted/purged blocks free DB rows but the underlying attachment files accumulate indefinitely, silently filling the user's disk. There is no GC path elsewhere for orphaned attachment files.
- **Cost:** M
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Implement the handler against the existing `attachments` table: enumerate the attachments root directory, `SELECT id, fs_path FROM attachments WHERE deleted_at IS NULL`, and unlink files with no live DB row. At minimum, escalate the placeholder log from `debug!` to `warn!` so the deferred-work signal is visible. Implementation stays within existing schema + task type.
- **Pass-1 source:** 02/F12
- **Status:** Open

### Materializer

### M-7 — Background backpressure silently drops cache-rebuild fan-outs
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/coordinator.rs:479-498`, `src-tauri/src/materializer/dispatch.rs:91-96`
- **What:** `try_enqueue_background` returns `Ok(())` and emits a `tracing::warn!` whenever the bounded background channel is full (`mpsc::error::TrySendError::Full(_)`). Every dispatch arm and `enqueue_full_cache_rebuild` (the 7-task fan-out for `delete_block` / `restore_block` / `purge_block`) uses this helper, so a single full queue can swallow `RebuildTagsCache`, `RebuildAgendaCache`, `RebuildPageIds`, etc., without persistence. `RetryKind::from_task` (`retry_queue.rs:59-72`) explicitly excludes these global rebuilds, so there is no sweeper that revives them.
- **Why it matters:** AGENTS.md Backend Architecture (L176) documents "silent drop on backpressure" as the policy for individual ops, but the consequence on the fan-out path is wider than the policy implies: a dropped `RebuildAgendaCache` after the only delete that triggered it leaves the agenda permanently stale until an unrelated op happens to re-fire that specific rebuild. For a single-user device this manifests as "tag list / agenda is missing entries until I edit something else."
- **Cost:** M (2-8h)
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** For the `enqueue_full_cache_rebuild` path specifically, switch from `try_enqueue_background` to `enqueue_background().await` so the caller blocks until queue space is available, **or** persist a "global rebuild needed" sentinel (e.g. a flag table) so a sweeper can re-fire dropped global rebuilds. Either way, document the chosen eventual-consistency window explicitly in `ARCHITECTURE.md §5`.
- **Pass-1 source:** 02/F4
- **Status:** Open

### M-8 — `try_enqueue_background` Full-arm doesn't increment any drop counter
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/coordinator.rs:490-493`, `src-tauri/src/materializer/metrics.rs:18-22`
- **What:** The `TrySendError::Full(_)` arm only emits a `tracing::warn!` and returns `Ok(())`; it does not bump `bg_dropped` (or any other metric). `bg_dropped` is wired only on the retry-exhaustion path in `consumer.rs:294-310`, so under sustained background pressure the queue can shed thousands of cache-rebuild tasks while `StatusInfo.bg_dropped` (commands/system.rs) reports 0.
- **Why it matters:** `StatusInfo` (MAINT-24) exists precisely so the user / dev can see materializer health. Without a counter for backpressure drops, a stale tag list or agenda has no observable signal short of grepping log files; combined with M-7 this is the difference between a known-stale cache and an invisible one.
- **Cost:** S (<2h)
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Add a dedicated `bg_dropped_backpressure: AtomicU64` to `QueueMetrics` (or split the existing `bg_dropped` into `_retry_exhausted` and `_backpressure`), bump it in the `TrySendError::Full` arm, and surface it as a new field in `StatusInfo`.
- **Pass-1 source:** 02/F5
- **Status:** Open

### M-9 — Doc drift: backoff timings 50/100ms in docs vs 150/300ms in code
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/consumer.rs:225-228`, `ARCHITECTURE.md:399`
- **What:** `run_background` uses `const INITIAL_BACKOFF_MS: u64 = 150` with `1 << (attempt - 1)`, producing a 150 ms / 300 ms schedule across `MAX_RETRIES = 2`. `ARCHITECTURE.md §5` still says "Background: up to 2 retries with exponential backoff (50ms, 100ms)." A code comment at `consumer.rs:226-227` already notes "Increased from 50ms to reduce retry churn on transient WAL lock contention." The adaptive FTS-optimize threshold (`max(500, block_count / 10_000)` at `dispatch.rs:200`) is also not documented.
- **Why it matters:** Contributors reading the architecture doc will write tests, performance budgets, or sync timeout reasoning against the wrong values. The Android sync catch-up path is exactly where transient WAL contention shows up, so the timing matters for triage.
- **Cost:** S (<2h)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Update `ARCHITECTURE.md` to read "150 ms initial, doubled per attempt (150 ms, 300 ms)" and document the adaptive FTS-optimize threshold formula; add a `// docs: ARCHITECTURE.md §5` cross-link comment next to `INITIAL_BACKOFF_MS` so future bumps stay in sync.
- **Pass-1 source:** 02/F6
- **Status:** Open

### M-10 — `BatchApplyOps` retry clones the entire `Vec<OpRecord>` even on first-attempt success
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/consumer.rs:154`, `src-tauri/src/materializer/consumer.rs:232`, `src-tauri/src/materializer/consumer.rs:250`
- **What:** `process_single_foreground_task` does `let retry_task = task.clone();` *before* the first attempt, and `run_background` does `let task_clone = task.clone();` at line 232 plus another `task.clone()` per retry at line 250. `MaterializeTask::BatchApplyOps(Vec<OpRecord>)` can carry a multi-thousand-op chunk during sync catch-up, so the clone is paid even when the first attempt succeeds (the common case).
- **Why it matters:** Mobile (Android) RAM is constrained; on the bg path the task can be cloned up to 3× the batch size resident concurrently. The duplicate buffer is dead weight when the first attempt succeeds.
- **Cost:** S (<2h)
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Defer the clone to the retry arm only — pass the task by value into the first spawned attempt and only `clone()` when transitioning to retry. Alternatively switch the variant to `Arc<Vec<OpRecord>>` (or wrap the whole `MaterializeTask` in `Arc`) so all clones are cheap refcount bumps.
- **Pass-1 source:** 02/F7
- **Status:** Open

### M-11 — `dispatch_background_or_warn` swallows serde errors with no seq / device_id context
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/dispatch.rs:62-70`, with parse sites at `dispatch.rs:111`, `:138`, `:216`, `:225`, `:234`
- **What:** `enqueue_background_tasks` calls `serde_json::from_str::<CreateBlockHint>(&record.payload)?` (and the `BlockIdHint` variants) and propagates parse errors. `dispatch_background_or_warn` then logs only `op_type` and `error`, with no `seq` or `device_id`. The dedup-side parse at `dedup.rs:71-78` already does the right thing — it logs `op_type`, `seq`, `device_id`, and `error`.
- **Why it matters:** When a future-version peer (or a corrupt local payload) parses cleanly inside `apply_op_tx` but trips up the lightweight `*Hint` quick-parse here, the cache rebuild is skipped and the only diagnostic lacks the identifying fields needed to find the offending row in `op_log`. Triage on the user's own device becomes guesswork.
- **Cost:** S (<2h)
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Extend the `tracing::warn!` at `dispatch.rs:64-68` to include `seq = record.seq, device_id = %record.device_id`, mirroring the dedup-side helper at `dedup.rs:71-78`.
- **Pass-1 source:** 02/F8
- **Status:** Open

### M-12 — In-flight tokio tasks not cancelled at shutdown
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/coordinator.rs:319-327`, `src-tauri/src/materializer/coordinator.rs:525-537`
- **What:** `Materializer::shutdown` flips `shutdown_flag` and drops the channel senders, breaking the consumer `recv` loops on next iteration. But `Self::spawn_task` (used for the metrics-snapshot task, the block-count refresh, and per-task spawned futures) returns no `JoinHandle`. Long-running per-task futures inside `process_single_foreground_task` / `run_background` (e.g. an FTS rebuild taking many seconds) keep running with no `select!` against the shutdown flag and no `JoinHandle::abort()`.
- **Why it matters:** During a sequenced shutdown (sync stop → materializer flush → DB close), the writer pool can be torn down while a background rebuild is still mid-transaction, producing a writer-pool error in the logs and a slow / hung app exit. The risk surfaces on app-close after heavy editing.
- **Cost:** M (2-8h)
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Track a `tokio::task::JoinSet` (or hold the `JoinHandle`s) on the `Materializer` struct, and in `shutdown()` call `abort_all()` after a short grace period; alternatively pass a `tokio::sync::Notify` shutdown signal into the long-running handlers and `select!` against it. The retry-queue sweeper (`retry_queue.rs:261`) already has the same fire-and-forget pattern and would benefit from the same treatment.
- **Pass-1 source:** 02/F9
- **Status:** Open

### M-13 — `metrics_snapshot_task` resets `*_high_water` every 5 min, breaking `StatusInfo` semantics
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/coordinator.rs:313-315`
- **What:** After dumping the metrics snapshot to `tracing::debug!`, the task resets `m.fg_high_water` and `m.bg_high_water` to 0. `StatusInfo.fg_high_water` / `StatusInfo.bg_high_water` (commands/system.rs `status_with_scheduler`) read these atomics directly and surface them as the "high-water mark." A `get_status` consumer polling once per minute will see saw-tooth values that reset every 5 minutes — neither "since boot" nor a clearly-bounded sliding window. Neither the `QueueMetrics` field comments nor the `StatusInfo` doc-comments mention this reset.
- **Why it matters:** The UI status panel can show 0 for the high-water mark immediately after a 5-minute boundary even when the queue just hit 200/256 thirty seconds before. Users / devs cannot trust the metric to investigate backpressure complaints.
- **Cost:** S (<2h)
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Either drop the reset and let the high-water atomics be all-time maxima (the 5-min log line then shows the running max, which is fine), **or** publish two separate fields (`*_high_water_since_boot` and `*_high_water_5min_window`) and document each. Whichever direction, update the doc-comments on the `QueueMetrics` and `StatusInfo` fields to match.
- **Pass-1 source:** 02/F13
- **Status:** Open

### Cache + Pagination

### M-14 — `reindex_block_links` does not filter `is_conflict = 0`; conflict copies leak into `list_backlinks`
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/cache/block_links.rs:21-26` and `src-tauri/src/cache/block_links.rs:106-111` (split variant); read by `src-tauri/src/pagination/links.rs:22-37`
- **What:** Both `reindex_block_links` content reads use `WHERE id = ? AND deleted_at IS NULL` only — no `is_conflict = 0` predicate — so `[[ULID]]`/`((ULID))` tokens from conflict-copy source blocks are inserted into `block_links`. `list_backlinks` then joins to `blocks` filtering only `b.deleted_at IS NULL`, so conflict copies surface to the UI as legitimate backlinks. This is inconsistent with `cache/block_tag_refs.rs:47` and `:127`, which already filter `is_conflict = 0` on the source block.
- **Why it matters:** The Backlinks panel doubles up entries for any conflicted block until the user resolves the conflict — visible UX confusion (not adversarial), and a stale-cache foot-gun on vaults that have ever held conflicts.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Add `AND is_conflict = 0` to both `reindex_block_links` content reads; optionally mirror `AND b.is_conflict = 0` into `list_backlinks` for defense-in-depth (see L-20). Add a regression test that creates a conflict-copy source containing `[[ULID]]` and asserts it does not appear in `list_backlinks`.
- **Pass-1 source:** 03/F2
- **Status:** Open

### M-15 — `rebuild_all_caches` rebuilds agenda before `page_id`, corrupting the template-page filter
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/cache/mod.rs:112-119`; mirrored in `src-tauri/src/snapshot/restore.rs:262-283`
- **What:** Both `rebuild_agenda_cache` and `rebuild_projected_agenda_cache` consult `b.page_id` to apply the FEAT-5a template-page exclusion (`NOT EXISTS (... tp.block_id = b.page_id AND tp.key = 'template')`), but `rebuild_all_caches` runs them before `rebuild_page_ids`. The snapshot-restore enqueue array uses the same order (positions 3 and 4 vs. 6 for `RebuildPageIds`); the background consumer runs the tasks sequentially.
- **Why it matters:** After a snapshot restore on a vault that uses templates, the agenda silently includes or excludes template-page blocks until something else triggers another rebuild — eventual consistency, not data loss, but visible to the user.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Move `rebuild_page_ids` to first in `rebuild_all_caches`, and move `("RebuildPageIds", MaterializeTask::RebuildPageIds)` to the front of the `rebuild_tasks` array in `snapshot/restore.rs`. Add a regression test that restores a snapshot containing a template-tagged page and asserts the agenda excludes its blocks immediately after restore.
- **Pass-1 source:** 03/F3
- **Status:** Open

### M-16 — `trash_descendant_counts` joins on `deleted_at` only — over-counts when batches collide
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/pagination/trash.rs:120-134` (REVIEW-LATER.md mis-cites this as `cache/trash.rs`; the file is `pagination/trash.rs`).
- **What:** The descendant-count query joins `blocks d` to `blocks rb` purely on `d.deleted_at = rb.deleted_at AND d.is_conflict = 0`, with no ancestry constraint. Two unrelated roots that happen to be soft-deleted at the same `deleted_at` (timestamp collisions are possible — `cascade_soft_delete` writes `now_rfc3339()`, tests use `FIXED_DELETED_AT = "2025-01-15T00:00:00+00:00"`, and bulk operations can share a millisecond) each see the other batch's blocks counted as their descendants. The doc-comment promises ancestry but the SQL does not enforce it.
- **Why it matters:** The Trash UI's "+N more" badge under each root shows inflated counts whenever timestamps collide. None of the current tests exercise two unrelated roots with the same `deleted_at`.
- **Cost:** M
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Restrict the `d`/`rb` join to actual descendants — either a recursive CTE rooted at each `rb.id` (filter `is_conflict = 0`, bound `depth < 100` per invariant #9), or an ancestry subquery using `parent_id`. Add a test creating two unrelated trees soft-deleted at the same `deleted_at` and asserting each reports only its own descendants.
- **Pass-1 source:** 03/F4
- **Status:** Open

### M-17 — Four `*_split` cache rebuilds ignore the `read_pool` and run reads on the writer
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/cache/tags.rs:95-99`, `src-tauri/src/cache/pages.rs:66-71`, `src-tauri/src/cache/projected_agenda.rs:244-249`, `src-tauri/src/cache/page_id.rs:64-68`
- **What:** Per AGENTS.md invariant #7, background rebuilds should read from the reader pool and only acquire a writer for the final INSERT/DELETE transaction. Four of the eight `*_split` variants accept a `_read_pool: &SqlitePool` parameter, ignore it, and delegate to the single-pool implementation against `write_pool`. The doc-comments justify it as "background, stale-OK", but `rebuild_projected_agenda_cache` in particular performs substantial Rust-side computation (up to 365 projections per repeating block) while holding a writer — the exact scenario the split-pool pattern was introduced to avoid.
- **Why it matters:** Hot-path writes (op apply) wait on writer-pool capacity; cache rebuilds that hold writers longer than necessary increase tail latency. The `_unused` parameter also makes it harder for future maintainers to reason about which rebuilds follow the documented pattern.
- **Cost:** M (projected_agenda + page_ids); S (tags + pages, where the work is one `INSERT … SELECT`)
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** For `projected_agenda` and `page_ids`, materialize the input on `read_pool` (page_ids: read all `(id, parent_id, block_type, is_conflict)` rows then UPDATE on writer; projected_agenda: read repeating-block + property rows on reader, compute, then chunked INSERT on writer). For tags/pages, either pre-fetch on the reader and chunked-INSERT on the writer, or rename them `*_no_split` to make the contract explicit. Update the AGENTS.md "Split read/write pool pattern" note to enumerate the exempt rebuilds.
- **Pass-1 source:** 03/F5
- **Status:** Open

### M-18 — Per-row INSERT/UPDATE/DELETE loops in agenda diff and projected-agenda rebuild
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/cache/agenda.rs:160-186` (single-pool) and `:342-368` (split); `src-tauri/src/cache/projected_agenda.rs:223-232`
- **What:** Both incremental agenda rebuilds and the projected-agenda rebuild apply changes one row at a time inside the transaction — separate prepared statements per delete, per update, and per insert in agenda diff; per-entry `INSERT OR IGNORE … VALUES (?,?,?)` after a single `DELETE FROM projected_agenda_cache` for projected agenda. This violates Backend Pattern #6 (multi-row chunked INSERT bounded by `MAX_SQL_PARAMS`); `cache/block_tag_refs.rs:258-272` already implements the chunked pattern correctly in the same module.
- **Why it matters:** For a 365-day projection × thousands of repeating blocks, the projected-agenda rebuild is dominated by per-row round-trips; same for large agenda diffs after bulk imports. With ~10K rows the difference is roughly 10K vs. ~20 round-trips inside the transaction.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Adopt the `MAX_SQL_PARAMS / N`-chunked multi-row INSERT pattern from `cache/block_tag_refs.rs` for `projected_agenda` (3 columns → chunk 333) and the agenda-diff inserts. For agenda-diff deletes, replace the per-row loop with a single `DELETE FROM agenda_cache WHERE (date, block_id) IN (SELECT value->>'$[0]', value->>'$[1]' FROM json_each(?))` driven by the `to_delete` set.
- **Pass-1 source:** 03/F6
- **Status:** Open

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

### M-20 — `set_priority_inner` hardcodes `1|2|3` and ignores user-extended `priority` options
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/properties.rs:227-253`
- **What:** `set_priority_inner` rejects any `level` outside `1|2|3` via `matches!(l.as_str(), "1" | "2" | "3")`, never reading the `priority` row from `property_definitions`. ARCHITECTURE.md §20 (UX-201b) says priority levels are user-configurable through that definition's `options` JSON, but the typed command refuses anything beyond the hardcoded set, so `update_property_def_options` for `priority` only takes effect when callers route through generic `set_property`.
- **Why it matters:** Either the docs are wrong or the typed command silently breaks the contract — users who rename levels (e.g. `A/B/C`) cannot use the priority command at all. The downstream options check inside `set_property_in_tx` is unreachable because the hardcoded validator rejects first.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Drop the hardcoded `1|2|3` guard and rely on the options validation already wired into `set_property_in_tx` (mirroring how `todo_state` works); add a regression test where the user has extended the priority options and a non-default value succeeds.
- **Pass-1 source:** 04/F3
- **Status:** Open

### M-21 — `set_page_aliases_inner` is not wrapped in a transaction (DELETE then loop INSERT)
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/pages.rs:33-76`
- **What:** The function deletes every alias for `page_id` against the bare pool, then loops issuing per-row `INSERT OR IGNORE`. There is no `BEGIN IMMEDIATE` wrapper, so a panic, pool-acquire failure, or partial loop error leaves the page with strictly fewer aliases than before, and concurrent calls for the same page can interleave their delete/insert phases.
- **Why it matters:** AGENTS.md "Backend Patterns" #2 calls out atomic multi-op sequences; aliases live outside the op log (see I-CommandsCRUD-4) so this DELETE+INSERT is the only enforcement of "replace the full set" semantics.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Wrap the DELETE plus the alias-insert loop (and the existence check) in a single `pool.begin_with("BEGIN IMMEDIATE")` transaction, or replace the loop with one chunked multi-row INSERT respecting `MAX_SQL_PARAMS`.
- **Pass-1 source:** 04/F4
- **Status:** Open

### M-22 — `resolve_or_create_journal_page` TOCTOU duplicates journal pages for the same date
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/journal.rs:84-121`
- **What:** The helper runs a `SELECT ... WHERE block_type = 'page' AND content = ?` against the bare pool and, on miss, calls `create_block_inner` which begins its own tx. Two concurrent callers (UI + MCP `journal_for_date` + boot's `today_journal`) for the same date can both observe "no page" and both create one, since there is no UNIQUE on `(block_type='page', content)` in the schema.
- **Why it matters:** Duplicate journal pages produce two parallel daily streams, break backlink resolution to that date, and confuse downstream MCP/agenda consumers; the bug is silent and persistent.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Move the existence check inside a `BEGIN IMMEDIATE` tx and call a `create_block_in_tx` variant on miss, so the second caller serialises behind the first and finds the just-created page on its inside-tx re-check.
- **Pass-1 source:** 04/F5
- **Status:** Open

### M-23 — `flush_draft_inner` reads `prev_edit` outside the flush transaction
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/drafts.rs:18-45`
- **What:** The command looks up the draft and queries `op_log` for the most recent `edit_block`/`create_block` op against the bare pool, then passes that `prev_edit` into `draft::flush_draft`, which only then opens its atomic transaction. A foreground `edit_block` (or sync replay) firing between the read and the flush leaves the draft carrying a stale `prev_edit`, undermining conflict detection.
- **Why it matters:** `prev_edit` is the foundation of the conflict model (see `recovery::find_prev_edit`); the equivalent lookup in `edit_block_inner` correctly runs inside its tx (`crud.rs:249-258`), so the drafts path is the asymmetry.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Push the `prev_edit` query inside `draft::flush_draft` (which already owns the tx) or expose a `flush_draft_in_tx` so the command layer can open one `BEGIN IMMEDIATE` and thread `&mut tx` through both reads and writes.
- **Pass-1 source:** 04/F6
- **Status:** Open

### M-24 — `count_agenda_batch_inner` builds dynamic SQL at runtime, bypassing `sqlx::query!`
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/agenda.rs:25-61`
- **What:** The function builds a `?1, ?2, ...` placeholder list via `format!` and dispatches through plain `sqlx::query_as` (no `!`). The sibling `count_agenda_batch_by_source_inner` (lines 72-102) already uses the `IN (SELECT value FROM json_each(?1))` pattern with `query_as!`, proving the schema supports the compile-time route.
- **Why it matters:** AGENTS.md key invariant #6 mandates `query!`/`query_as!`/`query_scalar!` everywhere; the dynamic path silently drifts when the underlying schema changes and pays a `format!` per call.
- **Cost:** S (refactor is local)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Refactor to a single `sqlx::query_as!` over `IN (SELECT value FROM json_each(?1))` using the JSON-array pattern already in the same file.
- **Pass-1 source:** 04/F8
- **Status:** Open

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

### M-26 — `delete_property_def_inner` orphans `block_properties` rows for the deleted key
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/properties.rs:520-537`
- **What:** Deleting a property definition leaves every `block_properties` row whose `key` matches in place. Since `def_meta` is then `None` in `set_property_in_tx` (`crud.rs:1144-1149`), subsequent writes silently skip the type/options validation block — i.e. deleting a definition relaxes validation on every prior row using that key.
- **Why it matters:** Properties are the documented primary extension point (AGENTS.md "Architectural Stability"); the doc-comment promises "Returns error if the key doesn't exist" but the code "deletes the registry row and orphans the data". Recreating the same key with a different `value_type` later mismatches existing data.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Inside a single tx, `SELECT EXISTS(...)` for `block_properties` rows on this key and reject the delete unless the caller passes a `force` flag (or cascade-clears those rows). Add tests for both directions.
- **Pass-1 source:** 04/F12
- **Status:** Open

### M-27 — `export_page_markdown_inner` full-table-scans every tag and page on each export
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/pages.rs:181-200` (resolver), context `pages.rs:161-340`
- **What:** To resolve `#[ULID]` and `[[ULID]]` tokens, the function loads `(id, content)` for every non-deleted `tag` and `page` block in the vault, builds two `HashMap`s, then exports only direct children (`list_children` with `limit=1000`, no pagination — descendants beyond the cap are silently truncated).
- **Why it matters:** AGENTS.md "Backend Patterns" #3 says batch by `json_each`, not full scans; with the documented 100K-block target this loads tens of thousands of rows per export. The undocumented direct-children-only truncation is a separate correctness issue.
- **Cost:** M
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** (1) Cursor-paginate `list_children` until exhausted into a buffer; (2) regex-extract ULIDs from the buffer; (3) issue one `SELECT id, content FROM blocks WHERE id IN (SELECT value FROM json_each(?))` for the union of tag+page references; (4) decide and document whether the export covers descendants and flag the truncation if it does not.
- **Pass-1 source:** 04/F14
- **Status:** Open

### Commands (System)

### M-28 — `attachments.deleted_at` is dead code; soft-delete schema vs hard-delete handler
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/attachments.rs:189-204` (read filter), `src-tauri/src/commands/attachments.rs:138-179` (hard delete), `src-tauri/migrations/0001_initial.sql:43-52` (schema)
- **What:** `attachments.deleted_at` is declared in migration 0001 and `list_attachments_inner` filters with `WHERE block_id = ? AND deleted_at IS NULL`, but neither `delete_attachment_inner` (line 168) nor the materializer's `DeleteAttachment` handler (`materializer/handlers.rs:510`) ever writes to `deleted_at` — both issue `DELETE FROM attachments`. The filter therefore evaluates to `TRUE` for every surviving row.
- **Why it matters:** New readers reasonably assume soft-delete semantics and may write code that depends on it; the column is also why `list_attachments` cannot be a simple compile-time-checked `query_as!` against the canonical schema fields.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either (a) drop the `deleted_at` column in a new migration and remove the filter, or (b) flip `delete_attachment` to soft-delete (`UPDATE attachments SET deleted_at = ?`) — option (b) requires a new op-type or payload extension and per AGENTS.md "Architectural Stability" needs explicit user approval.
- **Pass-1 source:** 05/F2
- **Status:** Open

### M-29 — `add_attachment_inner` does not verify the file exists on disk
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/attachments.rs:32-127`
- **What:** The command validates the lexical shape of `fs_path` (BUG-35) and that the parent block exists, but never calls `app_data_dir.join(&fs_path).is_file()` (or `metadata()`) before inserting the row. The frontend writes the bytes via `@tauri-apps/plugin-fs` *before* invoking `add_attachment`; if that write fails silently or races, the DB row is committed with `size_bytes` declared but no file behind it.
- **Why it matters:** Subsequent `read_attachment_file` will fail and the sync layer will report the blob as `MissingAttachment` (`sync_files.rs:152-160`). Single-user threat model, but a TOCTOU-safe `metadata()` check inside the IMMEDIATE tx (after the parent-block existence check) costs only one syscall.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Thread `app_data_dir` into `add_attachment_inner` (mirror of `bug_report.rs` / `mcp.rs` plumbing), then add `let _ = std::fs::metadata(app_data_dir.join(&fs_path))?;` inside the IMMEDIATE tx; optionally also assert `metadata.len() == size_bytes`.
- **Pass-1 source:** 05/F3
- **Status:** Open

### M-30 — No uniqueness on `attachments.fs_path`; duplicate adds collide silently
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/attachments.rs:99-111`, `src-tauri/migrations/0001_initial.sql:43-52`
- **What:** Two `add_attachment` calls with the same `fs_path` (different `attachment_id`, even different `block_id`) succeed and produce two rows pointing at the same file. Once F1 (`delete_attachment` actually unlinks the file) lands, deleting one row would clobber the other's content.
- **Why it matters:** Pre-condition for any future "actually unlink the file on delete" fix to be correct. The frontend's ULID-in-path convention makes collisions unlikely in normal flow, but no schema guard enforces it.
- **Cost:** S
- **Risk:** Medium — if two devices independently chose identical fs_paths during sync import, a `UNIQUE` migration could fail on existing user DBs; needs a data-shape audit. Per AGENTS.md "Architectural Stability" the migration itself needs user approval.
- **Impact:** Low
- **Recommendation:** Add `CREATE UNIQUE INDEX idx_attachments_fs_path ON attachments(fs_path)` in a new migration, and add a `tests/data_shape` assertion that all existing rows are unique; if collisions show up in real DBs, namespace fs_path under `attachment_id` during import.
- **Pass-1 source:** 05/F4
- **Status:** Open

### M-31 — `recent_errors_from_log_dir` reads the entire log file with no size cap
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/bug_report.rs:90-117` (helper), `src-tauri/src/commands/bug_report.rs:112-117` (the unbounded `fs::read_to_string`)
- **What:** `recent_errors_from_log_dir` calls `fs::read_to_string(path)` on the live `agaric.log`, then walks every line via `extract_recent_errors`. Both the read and the line-by-line scan happen on the IPC thread before the bug-report dialog returns. Contrast `read_capped_file` (line 175) which seeks to the tail at `MAX_FILE_BYTES = 2 MB` — `recent_errors_from_log_dir` does not share that cap.
- **Why it matters:** A chatty session (FE error storm, retry loops) can produce tens of MB of log; opening the bug-report dialog stalls the IPC thread for hundreds of milliseconds at exactly the moment the user is trying to file a bug.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Reuse `read_capped_file(today_path)` inside `recent_errors_from_log_dir`, then run `extract_recent_errors` on the resulting `String`; add a regression test that builds a >2 MB log file and asserts `collect_bug_report_metadata_inner` completes in <50 ms.
- **Pass-1 source:** 05/F6
- **Status:** Open

### M-32 — `start_sync_inner` records success before any sync has happened
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/sync_cmds.rs:167-197` (function), `src-tauri/src/commands/sync_cmds.rs:188` (offending `record_success`)
- **What:** The wrapper checks backoff via `scheduler.may_retry`, acquires `_guard` (immediately dropped on return), calls `scheduler.notify_change()`, and then calls `scheduler.record_success(&peer_id)` *before* the daemon has attempted (let alone succeeded at) a real sync. Step 4 wipes per-peer backoff state pre-emptively, so if the daemon then fails (peer offline, cert mismatch) no backoff applies on the next click.
- **Why it matters:** Defeats the backoff invariant documented in ARCHITECTURE.md §18:1565 ("`record_failure(id)` Doubles backoff: 1s → 2s → 4s → … → 60s max"). Single-user threat model, but hammering a misconfigured peer wastes battery, network, and daemon-task time.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Drop the `record_success` call from `start_sync_inner` — the daemon's own success path already calls `scheduler.record_success(peer_id)` on real success. The wrapper should only *trigger* a sync, not pre-credit it.
- **Pass-1 source:** 05/F17 (downgraded High→Medium per REVIEW-LATER; cross-ref 06/F41)
- **Status:** Open

### M-33 — `start_sync_inner`'s peer lock guard is dropped before the daemon syncs
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/sync_cmds.rs:179-186`
- **What:** `_guard = scheduler.try_lock_peer(&peer_id)` falls out of scope when `start_sync_inner` returns (microseconds later). The daemon's own `try_sync_with_peer` flow re-acquires the same lock, so the wrapper's exclusion is purely cosmetic — two back-to-back `start_sync` calls both succeed past `try_lock_peer` and both call `notify_change`. The "Sync already in progress for this peer" error path is therefore unreachable in practice.
- **Why it matters:** The error message implies an exclusion that isn't there. If a wrapper call interleaves with a daemon sync exactly on the lock acquisition, the wrapper wins the guard and the daemon's guard fails — the sync silently doesn't run, and tests asserting backoff/lock semantics may pass for the wrong reason.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either (a) remove the `try_lock_peer` call from this wrapper entirely and let the daemon own the lock, or (b) keep it but rename `_guard` and add a comment that the wrapper is a health-check only, not real exclusion.
- **Pass-1 source:** 05/F18 (cross-ref 06/F42)
- **Status:** Open

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

### M-35 — `set_peer_address_inner` rejects hostnames despite "host:port" wording
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/sync_cmds.rs:60-77` (function), `src-tauri/src/commands/sync_cmds.rs:65-68` (validator)
- **What:** Validation is `address.parse::<std::net::SocketAddr>()`, which accepts only `IPv4:port` or `[IPv6]:port`. The error string says "Expected host:port" and the docstring says "host:port socket address", but `myphone.local:12345` (a perfectly valid mDNS host) is rejected.
- **Why it matters:** The set-peer-address feature is the manual fallback for when mDNS auto-discovery is unavailable — but an mDNS host string is exactly the format users will reach for. Threat model is fine with hostnames; resolution is the daemon's job.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Accept arbitrary `host:port` (split on the last `:`, validate the port is a `u16`, leave the host opaque) — or rename the parameter to `ip_address`, update the doc, and update the FE field label. The former matches user expectation.
- **Pass-1 source:** 05/F20
- **Status:** Open

### M-36 — `disconnect_gcal_inner` aborts on a transient keyring failure when `delete_calendar=true`
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/gcal.rs:162-222` (function), `src-tauri/src/commands/gcal.rs:172-176` (offending `?` on `token_store.load`)
- **What:** When `delete_calendar=true`, the first awaited line is `token_store.load().await?`. If the keyring is unavailable (`KeyringBackendError::PlatformUnavailable` from `gcal_push/keyring_store.rs:300-302`), the function returns `AppError::Validation("keyring.unavailable")` and the local cleanup (calendar_id reset, event-map wipe, account_email clear, `PushDisabled` emit) never runs. The docstring (lines 169-176) explicitly promises this is a soft failure.
- **Why it matters:** A user trying to disconnect *because* the keyring is misbehaving is exactly the user who needs the local cleanup to succeed; instead they end up stuck in a "connected but broken" state. The doc and the implementation disagree.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Replace `token_store.load().await?` with a match-and-log pattern that downgrades the error to `tracing::warn!` and continues with `None`, so local cleanup always runs. Add a regression test using a `MockTokenStore` configured to fail `load` with `keyring.unavailable`.
- **Pass-1 source:** 05/F12
- **Status:** Open

### M-37 — `disconnect_gcal_inner` is not transactional across its three writes
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/gcal.rs:200-217`
- **What:** The function performs four side effects that should succeed-or-fail together: (1) clear `CalendarId` setting (line 202), (2) `DELETE FROM gcal_agenda_event_map` (line 203), (3) `token_store.clear()` (line 210), (4) clear `OauthAccountEmail` setting (line 217). None share a transaction; a failure between any two leaves a half-disconnected state (e.g. tokens gone but `account_email` still populated).
- **Why it matters:** The Settings tab can show "Connected as alice@example.com — keyring missing tokens", which is confusing. Recovery requires the user to click disconnect again and hope the second attempt succeeds atomically.
- **Cost:** M
- **Risk:** Medium — the three DB writes can be wrapped in a single `BEGIN IMMEDIATE`, but the keyring `clear()` cannot live inside a SQLite tx; ordering matters (do keyring clear first, so a DB failure leaves "tokens gone, settings still populated" — recoverable on next disconnect).
- **Impact:** Medium
- **Recommendation:** Reorder to (a) keyring clear (soft-fail per M-36), (b) one `BEGIN IMMEDIATE` wrapping the two `set_setting` calls + the `DELETE FROM gcal_agenda_event_map`, (c) emit `PushDisabled` after commit.
- **Pass-1 source:** 05/F13
- **Status:** Open

### M-38 — `compact_op_log_cmd_inner` accepts `retention_days = 0`
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/compaction.rs:95-101`, `src-tauri/src/commands/compaction.rs:100` (cutoff calc)
- **What:** `retention_days: u64` is fed directly to `chrono::Duration::days(retention_days.cast_signed())`. With `0`, the cutoff is `now()`, every op satisfies `created_at < cutoff`, and `compact_op_log` purges the entire op log down to the snapshot frontier. There is no minimum-retention guard at the IPC boundary.
- **Why it matters:** The op log is the source of truth for undo/redo and page history (AGENTS.md invariant 1: "append-only … except compaction"). The frontend is documented as responsible for confirming with the user (line 158), but a Settings-tab bug or buggy IPC payload supplying `0` gives the user no second chance.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Reject `retention_days < MIN_RETENTION_DAYS` (e.g. 7) with `AppError::Validation("retention_days.too_small")`; optionally also clamp upward via `retention_days.clamp(MIN, MAX)` for symmetry with `set_gcal_window_days_inner`.
- **Pass-1 source:** 05/F11
- **Status:** Open

### M-39 — `log_frontend` has no input-size bounds
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/logging.rs:10-36`
- **What:** `log_frontend` accepts five `String` / `Option<String>` arguments with no length limit. The doc note covers throughput ("rate limiting is on the JS side") but the *width* of a single message is unbounded — a `logger.error` call with a stringified TipTap document in the `data` field can be hundreds of MB. The formatter materializes the structured event and the appender writes it synchronously before the IPC ack.
- **Why it matters:** A single FE bug logging a giant blob blocks the IPC thread for seconds, corrupts the rolling-log daily file, and could fill disk in one shot. AGENTS.md says "backend must not block on logging"; large-payload blocking *is* the threat to that invariant.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Define `MAX_FRONTEND_LOG_FIELD_BYTES` (e.g. 64 KB) and truncate each `String`/`Option<String>` field at entry with a `…[truncated N bytes]` marker (mirroring `bug_report.rs:213-224`). Apply unconditionally — the FE rate-limiter is not in this trust scope.
- **Pass-1 source:** 05/F24
- **Status:** Open

### M-40 — `log_frontend` has no `inner_*` helper and no tests
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/logging.rs:10-36` (`log_frontend`), `src-tauri/src/commands/logging.rs:44-54` (`get_log_dir`)
- **What:** AGENTS.md "Backend Patterns" requires every Tauri command to have an `inner_*` function taking testable primitives; `log_frontend` and `get_log_dir` are written entirely as `#[tauri::command]` bodies with no extracted helper, and there is no `#[cfg(test)] mod tests` for either.
- **Why it matters:** The level-dispatch logic (including the unknown-level fallback to `info` at line 31-33) cannot be unit-tested, and the truncation guard added by M-39 will be untestable as-is. `get_log_dir` similarly cannot be exercised without spinning up Tauri.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Extract `log_frontend_inner(level: &str, module: &str, message: &str, …)` that performs only the dispatch (no Tauri state) and `get_log_dir_inner(app_data_dir: &Path) -> String`, and add unit tests for each level + the unknown-level fallback. Pattern matches `mcp.rs` and `bug_report.rs`.
- **Pass-1 source:** 05/F25
- **Status:** Open

### L-42 — `compact_op_log_cmd_inner` reports a stale `ops_deleted` count
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/compaction.rs:95-153`, `src-tauri/src/commands/compaction.rs:151` (`ops_deleted: eligible_in_tx`)
- **What:** The wrapper acquires `BEGIN IMMEDIATE`, counts eligible ops as `eligible_in_tx`, **commits the tx**, then calls `snapshot::compact_op_log` which does the actual deletion. The reported `CompactionResult.ops_deleted` is `eligible_in_tx` — *not* the count actually deleted by `compact_op_log`. Between releasing the tx and the inner write phase, more ops can be appended (their `created_at` may still be `< cutoff` if the wall clock advanced), and the snapshot-frontier guard inside `compact_op_log` may also skip some.
- **Why it matters:** Display inaccuracy — the UI shows a wrong count. For an observability surface that is the user's only feedback that compaction did anything, accuracy still matters.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Surface the real `deleted_count` from `snapshot::compact_op_log` (it already accumulates the value internally at `snapshot/create.rs:270-281` and discards it in a log line). Change its return to `Result<Option<(String, u64)>, AppError>` and propagate.
- **Pass-1 source:** 05/F9 (downgraded High→Medium)
- **Status:** Open

### Sync stack

### M-41 — Hash chain identity excludes `prev_hash`; chain is positional, not Merkle
- **Domain:** Sync
- **Location:** `src-tauri/src/hash.rs:33-90` (`compute_op_hash`); `src-tauri/src/sync_protocol/operations.rs:103-115` (`verify_op_record` loop)
- **What:** `compute_op_hash` hashes `device_id | seq | parent_seqs_canonical | op_type | payload`, where `parent_seqs_canonical` is a JSON list of `(parent_device_id, parent_seq)` *positions* — not parent hashes. `verify_op_record` recomputes the same five inputs, so the chain protects ordering only, not parent content.
- **Why it matters:** ARCHITECTURE.md §"Hash chain" documents this as intentional, but the code/doc framing in places implies a Merkle-like chain. Within the single-user model an accidentally-rewritten parent (stale-backup restore, FS snapshot rollback) cannot be detected from a child's hash alone — the cheap mitigation is the duplicate-hash check on the same composite PK (see H-14 / `INSERT OR IGNORE` follow-up), not changing the wire format.
- **Cost:** S (doc-only) | L (real fix needs migration of all persisted ops; needs user approval per Architectural Stability)
- **Risk:** Low (doc fix) | High (migration)
- **Impact:** Medium (clarity / matches ARCHITECTURE.md exactly)
- **Recommendation:** Tighten ARCHITECTURE.md §"Hash chain" and the `compute_op_hash` rustdoc to spell out "positions, not parent hashes" verbatim, and rely on the H-14 duplicate-PK detection lever for the integrity payoff. Do NOT change the hash format without explicit user approval.
- **Pass-1 source:** 06/F3
- **Status:** Open

### M-42 — Inconsistent error handling in `apply_remote_ops`
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_protocol/operations.rs:100-126`
- **What:** The upfront `verify_op_record` loop uses `?` so any single hash mismatch rejects the entire batch. A few lines later, inside the per-op loop at line 117-126, an unparseable `payload` JSON triggers `continue` and silently skips that op while the rest of the batch inserts. The header comment at line 100-101 ("Reject the entire batch on the first mismatch") contradicts the per-op JSON branch.
- **Why it matters:** A buggy peer build emitting one malformed payload (e.g., a serializer regression for a single op type) leaks partial state into the local op log indefinitely without surfacing an error; materialization will silently disagree with the op log. This is exactly the "buggy prior version" robustness goal AGENTS.md cites.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Move JSON-validity checking into the same upfront verification loop as `verify_op_record`, and treat unparseable payloads identically — reject the whole batch with a descriptive `AppError::InvalidOperation`. Update the inline comment to reflect a single all-or-nothing contract.
- **Pass-1 source:** 06/F5
- **Status:** Open

### M-43 — Property LWW idempotency guard reads latest local op, not materialized property value
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_protocol/operations.rs:339-374` (within `merge_diverged_blocks`)
- **What:** The "skip if local already has the winning value" early-exit parses `op_a.payload` (the latest local `set_property` op for `(block_id, key)`, selected via `ROW_NUMBER() OVER (PARTITION BY ... ORDER BY o.seq DESC)` at lines 289-293) and compares to `resolution.winner_value`. It does not consult `block_properties` — i.e., the materialized state. After the user re-edits the property locally between syncs, `op_a` is the *newer* op and the comparison is decoupled from whether the LWW resolution has actually been applied.
- **Why it matters:** Re-edits on the local device after a remote sync can either (a) cause spurious "already integrated" early-exits — LWW would have flipped the value but we skip, or (b) cause the LWW op to be re-emitted on every subsequent sync (extra ops in the log forever). Both are subtle convergence regressions for the user's own re-edit workflow.
- **Cost:** M
- **Risk:** Medium (touches merge correctness invariant — needs careful test coverage)
- **Impact:** Medium
- **Recommendation:** Compare `resolution.winner_value` against the materialized value in `block_properties` (the actual LWW state), mirroring the existing `has_merge_for_heads`-style helper used for `edit_block`. Pair the patch with M-44 since both share the failure mode.
- **Pass-1 source:** 06/F6
- **Status:** Open

### M-44 — Same idempotency-guard problem for move LWW
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_protocol/operations.rs:455-465`
- **What:** Identical pattern as M-43 for `move_block`: `local_move` is parsed from `op_a.payload` (latest local `move_block` op) and compared to `winner_move`. The materialized state in `blocks.parent_id` / `blocks.position` is not consulted.
- **Why it matters:** Same convergence bug as M-43 in the move dimension. Tends to manifest as repeated re-issuance of the same LWW move on each sync round if the user has subsequently re-arranged the block locally.
- **Cost:** S (fix together with M-43 in one patch)
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Compare `winner_move` against `blocks.parent_id` + `blocks.position` rather than the latest-op payload. Land in the same commit as M-43.
- **Pass-1 source:** 06/F7
- **Status:** Open

### M-45 — `SyncDaemon::shutdown` AtomicBool is set but never read
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_daemon/mod.rs:82-87, 378-382`; `src-tauri/src/sync_daemon/orchestrator.rs:172-279, 265-268`
- **What:** `SyncDaemon` carries `shutdown: Arc<AtomicBool>`. `shutdown()` writes `true` via `Ordering::Release` and calls `shutdown_notify.notify_one()`. The `daemon_loop` `select!` and the dormant-waiter only watch `shutdown_notify.notified()`; project-wide grep finds no `shutdown.load(...)` reader. The atomic flag is dead weight.
- **Why it matters:** Maintainability — readers of the struct expect both the bool and the Notify to participate in shutdown. A future select! branch that reads the bool but not the Notify (or vice versa) would introduce ordering bugs that are easy to miss in review.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low (clarity)
- **Recommendation:** Either remove the AtomicBool entirely, or read `shutdown.load(Acquire)` at the top of every `daemon_loop` iteration and inside `try_sync_with_peer` so a long-running session can early-exit. The simpler win is to delete it.
- **Pass-1 source:** 06/F8
- **Status:** Open

### M-46 — `try_sync_with_peer` drops the cancel flag after each peer; cancellation only stops the current peer
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_daemon/orchestrator.rs:196-218 (Branch B), 244-260 (Branch C), 383-389 (CancelGuard)`
- **What:** `CancelGuard::drop` unconditionally `self.0.store(false, Ordering::Release)` after each `try_sync_with_peer` call. In Branch B/C, peers are processed sequentially in a `for peer_ref in &refs` loop with no inter-iteration cancel check. If the user calls `cancel_active_sync` mid-session, peer 1 aborts, the guard clears the flag, and peer 2 starts a fresh session as if no cancellation happened.
- **Why it matters:** "Cancel sync" intuitively means "stop this round", not "stop the current peer and continue". The user reading the toast will be confused when subsequent peers' Progress events appear after they pressed Cancel — UX correctness, not security.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium (UX)
- **Recommendation:** Have the daemon loop also check the cancel flag *between* peer iterations (or have `try_sync_with_peer` return a `Cancelled` variant that short-circuits the outer loop). Alternatively, scope the `CancelGuard` to a sync *round* rather than a single session.
- **Pass-1 source:** 06/F9
- **Status:** Open

### M-47 — File transfer phase ignores cancel flag entirely
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_daemon/orchestrator.rs:601-624`; `src-tauri/src/sync_files.rs:233-547` (`run_file_transfer_initiator`/`_responder`); cancel check in `run_sync_session:523-527`
- **What:** Once `orch.is_complete()`, control falls into `run_file_transfer_initiator(conn, pool, &app_data_dir)` which takes no `cancel` parameter. The internal `request_and_receive_files` / `receive_request_and_send_files` loops likewise do not consult any cancel signal. Only the orchestrator's message-exchange `while !orch.is_terminal()` loop checks `cancel.load(Acquire)`.
- **Why it matters:** A multi-gigabyte attachment transfer cannot be interrupted by `cancel_active_sync` — the UI says "cancelling" while the file phase continues for minutes. Same UX-correctness family as M-46, with bigger time scales.
- **Cost:** M
- **Risk:** Medium (touches the protocol's "files keep flowing until TransferComplete" assumption)
- **Impact:** Medium
- **Recommendation:** Thread the cancel `&AtomicBool` through `run_file_transfer_initiator` / `_responder` and check it between each `recv_binary` / `send_binary`. On cancellation, send a clean `FileTransferComplete` to flush the protocol cleanly; do not introduce a new wire message.
- **Pass-1 source:** 06/F10
- **Status:** Open

### M-48 — `find_missing_attachments` only checks file presence, not size or hash
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_files.rs:142-160`
- **What:** Liveness is decided by `full_path.exists()` alone. A truncated copy (interrupted last download, partial filesystem write, antivirus quarantine that left a 0-byte stub, etc.) is treated as present and never re-requested. The DB row already carries `attachments.size_bytes` and the wire `FileOffer` carries `blake3_hash`, but neither is consulted.
- **Why it matters:** Squarely "preventing accidental corruption" per AGENTS.md — a truncated file from a prior interrupted sync is treated as present forever. Cheapest cure costs no protocol changes.
- **Cost:** S (size-only) | M (add `attachments.blake3_hash` column for content verification)
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Cheap path: also reject as "missing" when `tokio::fs::metadata(&full_path).await?.len() != attachments.size_bytes`. Better path: add `attachments.blake3_hash` (already inline on the wire `FileOffer`) and verify on read; surface a user-visible repair on mismatch.
- **Pass-1 source:** 06/F13
- **Status:** Open

### M-49 — `find_missing_attachments` performs blocking sync I/O inside an async fn
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_files.rs:142-160`
- **What:** `Path::exists()` syscalls `stat(2)` synchronously. The function is `async fn` and is awaited from `daemon_loop`'s tokio task; with thousands of attachments and a cold filesystem cache, this can stall the runtime.
- **Why it matters:** On Android with cold FS caches, a few hundred attachments noticeably extends the sync handshake. Not a correctness issue, but a real-world latency regression on the most constrained target.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Replace `full_path.exists()` with `tokio::fs::metadata(&full_path).await.is_ok()`, or batch the loop into a single `tokio::task::spawn_blocking`. If M-48 is implemented in the same patch, prefer `tokio::fs::metadata` so the size check piggybacks on a single async syscall.
- **Pass-1 source:** 06/F14
- **Status:** Open

### M-50 — `request_and_receive_files` ACKs `FileReceived` even after hash mismatch / write failure
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_files.rs:382-415` (receiver); `:304-319` (sender stats)
- **What:** On `actual_hash != blake3_hash` (line 393-394) and on `write_attachment_file` failure (line 405-407), the receiver still sends `SyncMessage::FileReceived { attachment_id }`. The sender increments `files_sent` / `bytes_sent` purely on receiving the ack, so its stats are decoupled from actual receiver outcome.
- **Why it matters:** Stats divergence — users debugging "why is sync always re-transferring this file" must know the ack is decoupled from success. Local state correctly stays "missing" so the next sync re-requests, but the sender's event stream lies about success. Observability concern only.
- **Cost:** S (event-only) | M (wire change)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Minimum: emit a `SyncEvent::Error` containing the failed `attachment_id` and increment a new `stats.skipped_hash_mismatch` counter end-to-end so the sender sees the discrepancy. A wire change (`success: bool` on `FileReceived`, or splitting into `FileReceived` vs `FileFailed`) is cleaner but **needs user approval per AGENTS.md "Architectural Stability"** before adding fields/messages.
- **Pass-1 source:** 06/F15
- **Status:** Open

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

### M-52 — `request_and_receive_files` does not cross-check `FileOffer.size_bytes` against `attachments.size_bytes`
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_files.rs:363-415`
- **What:** Only `get_attachment_fs_path` is queried for the requested attachment ID (line 369). The DB already stores the expected `attachments.size_bytes` for each row, but the receiver does not compare the offer's declared size against the stored size before allocating / accepting the binary stream.
- **Why it matters:** Cheap belt-and-braces sanity check that catches a buggy sender (`len() as u64` regression, accidental u32 truncation) before allocation. **Note:** unlike the unbounded-`size_bytes`-from-peer concerns marked OUT-OF-SCOPE in Pass-2, this is a sanity check on a row we already authoritatively own — not a DoS guard against peer payloads.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Look up `attachments.size_bytes` for the attachment row alongside `fs_path`; if the offer's `size_bytes` disagrees, log + skip and continue. Surface a `SyncEvent::Error` with both sizes so the user can investigate.
- **Pass-1 source:** 06/F17
- **Status:** Open

### M-53 — `SyncServer` accept loop swallows errors silently with no backoff
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_net/websocket.rs:182-261`
- **What:** Inside the `tokio::select!` over `listener.accept()`, the error arm is `Err(_e) => { /* Transient accept error – keep listening. */ }` — no log, no `sleep`. A persistent accept failure (FD exhaustion, sysctl limit, address-family weirdness) will spin a tight loop on the runtime.
- **Why it matters:** Robustness / observability for the app's own bugs, not for adversarial peers. Silent runaway CPU consumption when something genuinely goes wrong with the listener should at minimum be visible in the logs.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Log at `warn!` with the error and `tokio::time::sleep(Duration::from_millis(50)).await` before continuing the loop. This is observability, not a DoS guard.
- **Pass-1 source:** 06/F18
- **Status:** Open

### M-54 — `sync_cert.rs::get_or_create_sync_cert` is not atomic across `.pem` and `.hash`
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_cert.rs:71-113` (write path); `:116-150` (`read_existing_cert` recovery gap)
- **What:** Sequence is: `create_new` `.pem` → write data → `sync_all` → `create_new` `.hash` → write hash → `sync_all`. The error arm of the second `create_new` (line 94-98) cleans up `.pem`, but a process crash / power loss between the two `sync_all`s leaves `.pem` intact and `.hash` absent. `read_existing_cert` (line 137) then errors with "hash file missing or unreadable" with **no recovery path** — sync will not start until the user manually deletes `.pem`.
- **Why it matters:** Power loss / OOM-kill mid-write is exactly the accidental-corruption failure mode AGENTS.md asks us to defend against. "Transaction atomicity" is named in the threat model as a defensive-effort target.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Best fix: drop the `.hash` file entirely (it's deterministically derivable from `.pem` — see L-Sync-related cleanup), removing the multi-file invariant. Failing that: write to `.pem.tmp` + `.hash.tmp` then `rename` both before declaring success, or have `read_existing_cert` recover by deleting an orphaned `.pem` and re-running `get_or_create_sync_cert`.
- **Pass-1 source:** 06/F20
- **Status:** Open

### M-55 — `sync_cert.rs` does not fsync the parent directory after creating files
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_cert.rs:62-65, 76-100`
- **What:** `pem_file.sync_all()` and `hash_file.sync_all()` flush each file's data + metadata, but POSIX guarantees the directory entry only after `fsync(parent_dir_fd)`. Depending on filesystem (ext4 default vs `data=ordered`, etc.) the `.pem` and `.hash` files may be invisible after a power loss despite their data being on stable storage.
- **Why it matters:** Same recovery story as M-54 — app launches, files invisible, regenerates a new cert with a new hash, all peers have to re-pin via TOFU. Annoying but bounded.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** After both files are written, open the parent directory and call `fsync(parent_dir_fd)` once. On Windows, the `FlushFileBuffers` equivalent is unnecessary because directory entries are journaled differently — guard with `#[cfg(unix)]`.
- **Pass-1 source:** 06/F21
- **Status:** Open

### M-56 — `connect_to_peer` does not bind TLS handshake to the expected device's CN
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_net/connection.rs:33-66`; `src-tauri/src/sync_net/tls.rs:181-233` (`PinningCertVerifier`); orchestrator-side check at `src-tauri/src/sync_protocol/orchestrator.rs:207-222`
- **What:** `PinningCertVerifier::verify_server_cert` checks that CN starts with `agaric-` (line 217) and the optional `expected_hash` (line 200), but does not verify CN matches `expected_remote_id`. The device-id check is deferred to the orchestrator's HeadExchange path; at TLS-handshake time on first connect (no stored hash yet), any `agaric-*` cert is accepted.
- **Why it matters:** Not an attacker concern under our threat model — but a robustness one. A misconfigured network where two of the user's own devices both respond on the same address (NAT loopback weirdness, port reuse) will TLS-succeed against whichever cert arrived first; the inconsistency is caught later at HeadExchange. Detecting it at handshake fails fast and yields a clearer error.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Plumb the expected `peer_id` into `connect_to_peer`, hand it to `PinningCertVerifier`, and reject certs whose `agaric-{device_id}` CN does not match when present. Keep first-connect-without-hash behaviour intact (TOFU) but always assert the CN device-id once known.
- **Pass-1 source:** 06/F35
- **Status:** Open

### M-57 — `connect_to_peer` blocks rustls handshake on a `std::sync::Mutex`
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_net/connection.rs:33-66`; verifier writes at `src-tauri/src/sync_net/tls.rs:195-197`
- **What:** `Arc<std::sync::Mutex<Option<String>>>` is shared between the caller and `PinningCertVerifier`. The verifier writes the observed cert hash inside `verify_server_cert`; the caller reads it after the handshake. The pattern works but is fragile — a panic inside verification poisons the mutex, and the caller's `lock()` then returns `Err`, mapped to `sync_err`.
- **Why it matters:** Maintainability — capturing a single value via a poisonable mutex during a sync RPC is dirty. Any future rustls change to call the verifier on a different thread amplifies the fragility. Not a runtime hazard today.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Replace with `Arc<OnceLock<String>>` (set inside the verifier, read after handshake) or an `Arc<AtomicCell<Option<String>>>`-style primitive. Avoids poisoning entirely and makes the single-write-single-read intent obvious.
- **Pass-1 source:** 06/F36
- **Status:** Open

### M-58 — `try_offer_snapshot_catchup` always offers the latest snapshot, regardless of whether it covers the remote's frontier
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_daemon/snapshot_transfer.rs:119-195`
- **What:** When the remote signals `ResetRequired`, the function calls `get_latest_snapshot(pool)` and offers it without comparing the snapshot's `up_to_seqs` against the remote's heads (which the orchestrator already has on the session). If the snapshot happens to be ahead of the remote (typical case) this is fine; if compaction policy ever changes and retention windows drift, this becomes a hard-to-diagnose silent failure.
- **Why it matters:** Defensive-coding gap — the invariant "the offered snapshot covers the remote's frontier" is implicit, never asserted. Catching the violation cheaply now is much easier than chasing a future regression.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Before offering, read the remote heads from the orchestrator session and assert the snapshot's `up_to_seqs` covers them; if it doesn't, send `Error` instead of `SnapshotOffer` so the receiver fails loudly.
- **Pass-1 source:** 06/F38
- **Status:** Open

### Search & Links

### M-59 — Tag-query CTE oracle missing `depth < 100` bound
- **Domain:** Search & Links
- **Location:** `src-tauri/src/tag_query/resolve.rs:179-235` (`#[cfg(test)] resolve_expr_cte`)
- **What:** The recursive-CTE oracle `tagged_tree` walks descendants via `b.parent_id = tt.id` with no `depth` column and no `depth < 100` predicate. The production rebuild path (`tag_inheritance::rebuild_all`, `tag_inheritance.rs:435-453`) does bound depth, so oracle and prod disagree on the universe of inheritable blocks they will visit on a corrupted DB.
- **Why it matters:** AGENTS.md invariant #9 requires every recursive CTE over `blocks` to bound `depth < 100`. Without it the oracle can spin forever on a parent-cycle and silently agrees with a buggy prod path past depth 100, defeating the CTE-oracle parity guarantee in `resolve/tests.rs:438-484` and `:870-1008`.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Add a `depth INTEGER` column and `WHERE … AND depth < 100` to both recursive members of `tagged_tree`. Match the depth bound used by `tag_inheritance::rebuild_all`.
- **Pass-1 source:** 07/F1
- **Status:** Open

### M-60 — Backlink `resolve_root_pages_cte` oracle missing depth bound and `is_conflict = 0`
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/query.rs:259-301` (`#[cfg(test)] resolve_root_pages_cte`)
- **What:** The CTE oracle for `resolve_root_pages` walks ancestors via `parent_id` with neither a `depth < 100` bound nor an `is_conflict = 0` filter on the recursive member. The production version at `query.rs:213-249` filters `p.is_conflict = 0` (line 229) and even comments "Defensive consistency with the recursive-CTE oracle" — the oracle itself omits the filter. The final projection (`WHERE b.parent_id IS NULL AND b.block_type = 'page'`) also lacks `b.is_conflict = 0`.
- **Why it matters:** This is the linchpin oracle for AGENTS.md "Performance Conventions / CTE oracle pattern" exercised by `backlink/tests.rs:2584-2638`. If the optimized path regresses near a conflict ancestor or a 100+ deep chain, the oracle will silently agree with the buggy result; on a corrupted DB the oracle could infinite-loop while the production query terminates.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Add a `depth` column with `WHERE … AND depth < 100` to the recursive member, add `b.is_conflict = 0` alongside the existing `b.parent_id IS NOT NULL`, and add `b.is_conflict = 0` to the final projection so prod and oracle compare like-for-like.
- **Pass-1 source:** 07/F2
- **Status:** Open

### M-61 — `strip_for_fts` (async) doesn't filter `is_conflict = 0` for tag/page references
- **Domain:** Search & Links
- **Location:** `src-tauri/src/fts/strip.rs:77-81, 105-108` (cf. `:185-208` `load_ref_maps`)
- **What:** The async `strip_for_fts` looks up tag content (lines 77-81) and page content (lines 105-108) with only `block_type = '…' AND deleted_at IS NULL`. The companion sync helper `load_ref_maps` (lines 188-208), used by full rebuild, additionally filters `is_conflict = 0`. Single-block updates therefore embed conflict-copy tag/page content in `fts_blocks` while a subsequent full rebuild produces different stripped text.
- **Why it matters:** Drift between `update_fts_for_block` / `update_fts_for_block_split` and `rebuild_fts_index` / `rebuild_fts_index_split`. After a `RemoveConflict` op resolution, the per-block reindex path leaves stale conflict-tag content in `fts_blocks` until the next full rebuild — observable as inconsistent search hits across the two paths.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add `AND is_conflict = 0` to both lookup queries in `strip_for_fts` so the async path matches `load_ref_maps`. Add a regression test covering a single-block reindex after a conflict resolution.
- **Pass-1 source:** 07/F5
- **Status:** Open

### M-62 — `eval_unlinked_references` truncates without `ORDER BY` — non-deterministic cursor
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/grouped.rs:343-360` (FTS query) and `:551-562` (cursor encode), `:451-462` (skip_while)
- **What:** The FTS5 candidate query uses `LIMIT 10001` with no `ORDER BY`. Once `truncated = true` (`grouped.rs:362`), SQLite is free to return a different 10 001 rows on the next request. The cursor at `:551-562` encodes `last.0` (page_id); the follow-up request rebuilds `group_list` from a different truncation set, and `skip_while(|(pid, …)| pid != after_id)` (`:453-462`) consumes everything when the cursor's page_id is missing — pagination terminates early or loops indefinitely.
- **Why it matters:** Truncation is the only path that materializes phantom non-determinism into user-visible state. For popular pages (single-letter aliases, "todo"-shaped titles) the 10 000 cap is reachable; cursor pagination then shows blocks that flicker in/out across requests.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Add a deterministic `ORDER BY fb.block_id` to the FTS query so the truncation boundary is stable across requests; alternatively encode the truncation boundary inside the cursor and reapply on follow-ups. Cross-link with I-Search-13 (downstream cursor encoding).
- **Pass-1 source:** 07/F8
- **Status:** Open

### Lifecycle / Snapshots / Merge / Recurrence

### M-63 — Reverse `find_prior_text` / `find_prior_position` ignore indexed `block_id` column
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/reverse/block_ops.rs:91-101, 124-134`
- **What:** Both helpers filter by `json_extract(payload, '$.block_id') = ?1` instead of using the dedicated `block_id` column added by `migrations/0030_op_log_block_id_column.sql` and indexed by `idx_op_log_block_id`. PERF-26 migrated draft recovery (`recovery/draft_recovery.rs:84-94`) to the indexed column but the reverse-op generator was missed; the column is populated unconditionally by `append_local_op_in_tx` and `dag::insert_remote_op`.
- **Why it matters:** Every undo of an `edit_block` or `move_block` triggers a full-table JSON scan, so undo latency degrades linearly with op count.
- **Cost:** S
- **Risk:** Low
- **Impact:** High
- **Recommendation:** Replace `json_extract(payload, '$.block_id') = ?1` with `block_id = ?1`, uppercasing the bound parameter in Rust to match the indexed column convention (mirrors `recovery/draft_recovery.rs:84`).
- **Pass-1 source:** 08/F1
- **Status:** Open

### M-64 — `reverse_set_property` / `reverse_delete_property` use `json_extract` for both block_id and key
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/reverse/property_ops.rs:80-94`
- **What:** Same JSON-extract-on-`block_id` pattern as M-63, plus a second `json_extract(payload, '$.key') = ?2` predicate. No covering index exists for `(block_id, key)` on `op_log`, so every undo of a property edit performs a JSON-extract pass.
- **Why it matters:** Property-edit-heavy workloads (agenda planning, repeating tasks emit multiple `set_property` ops per occurrence) have undo latency that scales O(n_ops).
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Switch the block_id predicate to `block_id = ?1` so the index participates; leave the key filter as `json_extract` over the now-block-scoped slice. A future `block_property_key` extracted-column migration would close the gap fully but requires user approval (new column).
- **Pass-1 source:** 08/F2
- **Status:** Open

### M-65 — ARCHITECTURE.md says draft recovery uses `>=` but code uses `>`
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/recovery/draft_recovery.rs:86-92`; doc `ARCHITECTURE.md:1168`
- **What:** The doc states the recovery query uses `created_at >= draft.updated_at`; the code uses strict `created_at > ?`. The strict comparator is intentional per the comment block at `recovery/tests.rs:13-15` (lex-monotonic `Z`-suffix invariant).
- **Why it matters:** Boundary case where a flushed op shares `updated_at` to the millisecond would be classified "unflushed" and produce a synthetic edit_block — a no-op semantically but adds an op_log row, a `prev_edit` DAG entry, and history-view noise.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Update `ARCHITECTURE.md` line 1168 to read `>` so it matches the deliberate code semantics; do not change the code.
- **Pass-1 source:** 08/F5
- **Status:** Open

### M-66 — `apply_snapshot` drops `block_drafts` without surfacing potentially unflushed work
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/snapshot/restore.rs:90-92`
- **What:** RESET wipes `block_drafts` inside the same `BEGIN IMMEDIATE` that clears `op_log` and core tables. Any draft saved after the snapshot was taken is silently lost: there is no log line, no count returned, no test asserting the drop.
- **Why it matters:** RESET is invoked by FEAT-6 snapshot-driven catch-up; on a peer with mid-edit drafts the user's typing is silently discarded with no warning to the materializer or sync UI.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Read `COUNT(*) FROM block_drafts` before the DELETE and emit `tracing::warn!` with the count and block_ids; consider extending the existing `SnapshotData` return so callers can surface "N drafts dropped" in the sync UI.
- **Pass-1 source:** 08/F6
- **Status:** Open

### M-67 — `apply_snapshot` cache-rebuild tasks use `try_enqueue_background` (silent drop)
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/snapshot/restore.rs:284-292`
- **What:** After committing the wipe+restore tx, the function enqueues 8 cache-rebuild tasks (FTS, agenda, projected agenda, tag inheritance, page IDs, tags, pages, block-tag refs) via `try_enqueue_background`, which silently drops with a `warn!` if the queue is saturated. There is no boot-time recheck that would re-enqueue dropped work.
- **Why it matters:** If the warn fires and no further op happens, FTS / agenda_cache / pages_cache / tags_cache stay empty indefinitely; the user sees an empty agenda/search/tag list with no actionable signal. Cross-references M-7 (`Materializer::try_enqueue_background` semantics).
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Use the awaiting `enqueue_background` variant for these post-RESET tasks (the apply path is exactly when stale caches matter), or persist a "needs rebuild" marker (new table — requires user approval per Architectural Stability) and gate startup on it.
- **Pass-1 source:** 08/F7
- **Status:** Open

### M-68 — `cleanup_old_snapshots` deletes ALL rows when `keep=0`
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/snapshot/create.rs:325-329` (standalone `cleanup_old_snapshots`); inlined version inside `compact_op_log` at `snapshot/create.rs:285-293`
- **What:** The DELETE uses `id NOT IN (SELECT id FROM log_snapshots WHERE status = 'complete' ORDER BY id DESC LIMIT ?1)`. SQLite evaluates `x NOT IN (empty subquery)` as TRUE, so `keep=0` deletes every row, including completes. The unit test `cleanup_old_snapshots_with_zero_keep_deletes_all` (snapshot/tests.rs ~line 1998) pins this.
- **Why it matters:** Production callers all pass `keep=3`, so the destructive path is gated today, but the public API is dangerous if reused with a user-controlled `keep` value.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Add an explicit `if keep == 0 { return Ok(0); }` guard at the top of `cleanup_old_snapshots`, and document the destructive `keep=0` semantics on the function. Verify no command surface lets a user set `keep=0`.
- **Pass-1 source:** 08/F9
- **Status:** Open

### M-69 — `create_snapshot` is NOT atomic between INSERT(pending) and UPDATE(complete)
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/snapshot/create.rs:142-159`
- **What:** Standalone `create_snapshot` issues two `pool.execute()` calls outside any transaction; `compact_op_log` (lines 246-264) wraps both in `BEGIN IMMEDIATE`. A failure between the two leaves a `'pending'` row that boot recovery deletes on next startup, even though the row carries valid compressed data and a real `up_to_hash`.
- **Why it matters:** Production snapshot writes always go through `compact_op_log` (the standalone function is only called from tests today), so the durability gap is theoretical, but the divergence is an inconsistency trap for future callers (e.g., a manual "Export Snapshot" command).
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Fold the INSERT-pending and UPDATE-complete into a single `BEGIN IMMEDIATE` to match `compact_op_log`; alternatively, document explicitly that pending→complete is a *safety* protocol, not a durability protocol.
- **Pass-1 source:** 08/F10
- **Status:** Open

### M-70 — `apply_snapshot` does not anchor the post-snapshot hash chain
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/snapshot/restore.rs:89, 254`
- **What:** RESET does `DELETE FROM op_log` and commits without persisting the snapshot's `up_to_hash` anywhere as the post-restore anchor. The FEAT-6 sync orchestrator at `sync_daemon/snapshot_transfer.rs:326-352` does call `peer_refs::update_on_sync` immediately after, so the happy path is covered — but the contract is caller-enforced and there is no test asserting the next local op's `prev_hash` matches the snapshot's `up_to_hash`.
- **Why it matters:** A future caller of `apply_snapshot` outside the FEAT-6 orchestrator that forgets to anchor would silently break later cross-device hash-chain validation.
- **Cost:** M
- **Risk:** Medium
- **Impact:** High
- **Recommendation:** Audit every caller of `apply_snapshot` and add a regression test that asserts the next `append_local_op` after `apply_snapshot` produces a hash consistent with `up_to_hash`. Consider reshaping the return type (e.g., a `RestoreAnchor` newtype the caller must consume) so the anchor cannot be silently dropped.
- **Pass-1 source:** 08/F11
- **Status:** Open

### M-71 — `compute_reverse(restore_block)` translates back to bare delete_block
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/reverse/block_ops.rs:78-83`
- **What:** Reverse-of-restore is `DeleteBlockPayload { block_id }`; the original `RestoreBlockPayload`'s `deleted_at_ref` is discarded. A subsequent `cascade_soft_delete` mints a fresh `deleted_at` timestamp, breaking the original cascade-group identity. Undo→redo→undo→redo is therefore asymmetric on the timestamp group used by the Trash UI.
- **Why it matters:** Trash view groups by `deleted_at` string (ARCHITECTURE.md §2 "Cascade delete and Trash"); inverse-op generation should preserve groupability if it can. The user-visible effect is timestamp groups in Trash being lost across undo cycles.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Either accept the asymmetry and document it in the reverse-op module docs and the Trash UI spec, or carry the original `deleted_at_ref` through a new payload field — the latter requires user approval per Architectural Stability (op-payload extension). Pinning the current behaviour with a regression test is the minimum.
- **Pass-1 source:** 08/F12
- **Status:** Open

### M-72 — `merge_text` no-LCA fallback walks ONE side only
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/merge/detect.rs:43-95`
- **What:** When `find_lca` returns `None`, the function walks back from `op_ours` through `prev_edit` until it hits a `create_block` and uses that block's content as the ancestor for the three-way merge. It never validates `op_theirs` traces to the same `create_block`. If both heads share a block_id but trace to different create ops (compaction-induced chain truncation, or corrupted `prev_edit`), one side's root is used as ancestor for both and the merge is biased.
- **Why it matters:** Defensive concern: in Agaric's model each block has exactly one `create_block`, so the divergent-roots scenario requires real chain corruption. Test `merge_missing_lca_falls_back_to_create_content` (line 2561) only exercises the common-root case.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Low
- **Recommendation:** Walk both sides to their roots; require they match (return Err so the caller drops to "create conflict copy") or prefer the older (smaller-ULID) create_block content as the canonical ancestor. Add a regression test for the divergent-roots case using a hand-built op_log fixture.
- **Pass-1 source:** 08/F13
- **Status:** Open

### M-73 — `merge_block` orchestrator does not call `resolve_property_conflict`
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/merge/apply.rs:21-25`
- **What:** The TODO comment is honest: text merge is wired in, but property LWW (`merge/resolve.rs::resolve_property_conflict`) is only invoked from `sync_protocol/operations.rs:341` inside `merge_diverged_blocks`. `merge_block` itself silently no-ops on property conflicts that surface from any other call site.
- **Why it matters:** A future caller of `merge_block` will assume the function is a complete three-way merge and silently drop property conflicts. If the sync orchestrator is renamed or refactored, the property path is easy to forget.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Cheapest honest fix is to rename `merge_block` → `merge_block_text_only` so the next reader does not assume otherwise. Alternative: take a `resolve_property_conflicts: bool` flag and delegate to property resolution explicitly when set.
- **Pass-1 source:** 08/F14
- **Status:** Open

### M-74 — `create_conflict_copy` does not copy `block_links`
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/merge/resolve.rs:91-128`
- **What:** Block tags (lines 110-117) and properties (lines 119-128) are copied to the conflict block, but `block_links` (forward + backlinks) are not. The conflict copy starts with no graph context until the materializer's periodic re-index picks up the new content via the `#[ULID]`/`[[ULID]]` tokens.
- **Why it matters:** UX: when the user clicks the conflict copy in Status View, no references / backlinks display until the next reindex cycle, making it hard to compare against the original.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** After `tx.commit()`, enqueue `MaterializeTask::ReindexBlockLinks { block_id: new_block_id }` (mirrors the synthetic-edit handling in `recovery/cache_refresh.rs:44-48`). No new tables or op types required.
- **Pass-1 source:** 08/F15
- **Status:** Open

### M-75 — `create_conflict_copy` copies tags from soft-deleted rows too
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/merge/resolve.rs:110-117`
- **What:** `INSERT INTO block_tags (block_id, tag_id) SELECT ?1, tag_id FROM block_tags WHERE block_id = ?2` does not join `blocks` to filter soft-deleted tag blocks. The conflict copy ends up referencing a tag whose tag-block is `deleted_at IS NOT NULL`; FK is satisfied but `tags_cache` rebuild filters the deleted tag out, so the conflict copy is "tagged but invisibly tagged".
- **Why it matters:** Minor UX inconsistency between the conflict copy's logical state and what shows in the tags panel.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Rewrite the SELECT to `JOIN blocks b ON b.id = block_tags.tag_id WHERE block_tags.block_id = ?2 AND b.deleted_at IS NULL`.
- **Pass-1 source:** 08/F16
- **Status:** Open

### M-76 — `create_conflict_copy` does not validate the parent block is still alive
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/merge/resolve.rs:28-46`
- **What:** `parent_id` is read from the original row and propagated to the new conflict block without checking `blocks.deleted_at IS NULL` on the parent. `recovery/draft_recovery.rs:46-64` performs the symmetric F08 guard for synthetic edit_block recovery; merge resolution does not.
- **Why it matters:** A merge that creates a conflict copy whose parent has been concurrently soft-deleted produces an orphan-under-tombstone block. FK passes (parent row exists with `deleted_at` set), but `cascade_soft_delete` won't reach the new copy unless the user later re-deletes the parent — phantom blocks in the trash hierarchy.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Refuse to create the conflict copy when the parent is soft-deleted (`Err(AppError::*)` so the caller can fall back); add a regression test mirroring the F08 fixture in `recovery/tests.rs`.
- **Pass-1 source:** 08/F17
- **Status:** Open

### M-77 — `recurrence::handle_recurrence` swallows property-set errors silently
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/recurrence/compute.rs:182-194, 218-229, 245-258, 280-290, 304-315, 332-340`
- **What:** Six `match set_property_in_tx(…) { Ok((_, op)) => op_records.push(op), Err(e) => tracing::warn!(…) }` blocks log the error and continue with the same `tx`. SQLite typically marks the tx aborted on error, so subsequent statements on that `tx` will fail; even on tolerated errors the user sees a partially populated sibling (e.g., `todo_state` set but `due_date` missing).
- **Why it matters:** Silent partial-success in the recurrence path is a high-impact bug — the user sees a "next occurrence" with broken metadata in the agenda and assumes it is intentional, with only a `tracing::warn` for diagnostics.
- **Cost:** S
- **Risk:** Low
- **Impact:** High
- **Recommendation:** Replace each silent-warn block with `?` (let the error propagate, the IMMEDIATE tx rolls back). Add a regression test that injects a `set_property` failure and asserts no recurrence sibling rows remain.
- **Pass-1 source:** 08/F20
- **Status:** Open

### M-78 — Recurrence sibling `position = original_position + 1` can collide with siblings
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/recurrence/compute.rs:122-128`
- **What:** New sibling's position is `Some(p + 1)` for any `original.position == Some(p)` that isn't the `NULL_POSITION_SENTINEL`. If a sibling already occupies `p+1`, two siblings now share a position. `merge/resolve.rs:51-73` already solved the equivalent problem in `create_conflict_copy` via `MAX(position) + 1` (BUG-24); the recurrence path was not updated.
- **Why it matters:** Position-based ordering becomes non-deterministic on collision; the agenda view shows the colliding tasks in arbitrary order with unspecified tie-breaks.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Port the BUG-24 helper from `merge/resolve.rs:51-73` — scan `MAX(position)` over `parent_id = ?` AND `deleted_at IS NULL` AND `position != NULL_POSITION_SENTINEL` and use `max + 1`.
- **Pass-1 source:** 08/F22
- **Status:** Open

### M-79 — `recurrence::parser::shift_date` accepts negative intervals (`-1d`)
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/recurrence/parser.rs:50-72`
- **What:** `let n: i64 = num_str.parse().ok()?;` followed by `base + chrono::Duration::days(n)` accepts negative N (because `num_unit.split_at(num_unit.len() - 1)` yields `("-1", "d")` for `"-1d"`), producing a date in the past.
- **Why it matters:** Org-mode recurrence semantics never go backwards. A typo or paste can permanently set a recurring task to "next occurrence in 1985"; recovery requires editing the property by hand.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add `if n <= 0 { return None; }` immediately after the parse; add a unit test for `"-1d"`, `"0w"`, `"-2m"` rejecting at parse time.
- **Pass-1 source:** 08/F23
- **Status:** Open

### M-80 — Recurrence parser does not support `+Ny` (years)
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/recurrence/parser.rs:51-72`
- **What:** The `match unit` arm has only `"d"`, `"w"`, `"m"`, then `_ => return None`. Org-mode recognises `+1y` (yearly); annual reviews / birthdays / etc. cannot be expressed without it.
- **Why it matters:** Feature gap. Users with org-mode habits will paste `+1y` from existing notes and recurrence silently does nothing (the function returns `None`, the caller skips recurrence with no visible signal).
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add a `"y" => …` arm that shifts by `n*12` months (reuse the month branch's leap-day handling). Add table-driven tests covering Feb-29 → Feb-28 / leap-day edge cases.
- **Pass-1 source:** 08/F24
- **Status:** Open

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

### M-82 — `journal_for_date` writes through the read pool with `query_only = ON`
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/tools_ro.rs:550-564` (handler), `src-tauri/src/mcp/tools_ro.rs:257` (dispatch), `src-tauri/src/lib.rs:568,696` (production wiring), `src-tauri/src/db.rs:145-150` (`query_only = ON`), `src-tauri/src/commands/journal.rs:62-121` and `src-tauri/src/commands/blocks/crud.rs:184` (write path).
- **What:** `ReadOnlyTools::new` is wired with `pools.read.clone()` in `lib.rs`, and `handle_journal_for_date` forwards that pool to `journal_for_date_inner` → `create_block_inner`, which opens `BEGIN IMMEDIATE` and INSERTs into `op_log` + `blocks`. Because the read pool sets `PRAGMA query_only = ON`, the very first agent call to `journal_for_date` for a missing date fails with `SQLITE_READONLY`, surfaced to the agent as JSON-RPC `-32603`. The matching unit test passes only because it uses `init_pool` (single combined pool) instead of `init_pools`.
- **Why it matters:** This is the only RO tool with a write side-effect, so it is also the only RO tool that is broken end-to-end in production. Even in the local-only deployment model, the first time the user enables MCP and asks Claude/Cursor for "today's journal" they will get a hard error every subsequent day they have no pre-existing page — i.e., immediately on first real use.
- **Cost:** S
- **Risk:** Low
- **Impact:** High
- **Recommendation:** Either expose `Materializer::write_pool()` and use it inside `handle_journal_for_date`, or add a writer-pool field to `ReadOnlyTools` populated from `pools.write.clone()` in `lib.rs`. Add an integration test that constructs `ReadOnlyTools` via `init_pools().read` and asserts `journal_for_date` succeeds for a fresh date.
- **Pass-1 source:** 09/F1
- **Status:** Open

### M-83 — Windows RW server's accept loop hard-codes `MCP_RO_PIPE_PATH`
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/server.rs:680-700` (`serve_pipe`, in particular line 685), `src-tauri/src/mcp/mod.rs:152` (`MCP_RO_PIPE_PATH`), `src-tauri/src/mcp/mod.rs:194-197` (`MCP_RW_PIPE_PATH`, never used inside `serve_pipe`).
- **What:** After accepting the first client on a Windows named pipe, `serve_pipe` recreates the next server instance with `ServerOptions::new().create(pipe_path)`, where `pipe_path` is hard-coded to `super::MCP_RO_PIPE_PATH`. The same `serve_pipe` is invoked from both RO and RW spawn paths, so once the RW server accepts its first connection it begins creating subsequent server instances on the **RO** pipe namespace instead of `MCP_RW_PIPE_PATH`.
- **Why it matters:** Windows operators running RO + RW concurrently (FEAT-4h slice 2) collide on the second RW connection — at best it competes with the RO server, at worst the RW socket silently stops accepting. The bug is invisible in the existing test suite because all integration tests are gated `#[cfg(unix)]`.
- **Cost:** S
- **Risk:** Low
- **Impact:** High (Windows-only; zero on Linux/macOS)
- **Recommendation:** Thread the bound pipe path through `serve` / `serve_pipe` from `bind_socket` (e.g. capture it on the `SocketKind::Pipe` variant or pass as a sibling argument) instead of recovering it from a constant. Add a Windows-gated test that re-creates the pipe instance after the first hand-off.
- **Pass-1 source:** 09/F3
- **Status:** Open

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

### M-87 — `force_resync()` semantics inverted: clears dirty instead of dispatching
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/connector.rs:342-352, 901-904`
- **What:** `GcalConnectorHandle::force_resync` documents "Request an immediate full-window resync. … the current cycle is flushed even when no `DirtyEvent`s are pending", but the matching arm in `run_task_loop` responds to `force_sweep.notified()` with `dirty.clear()` and a log line — the opposite of force-resync. Hitting "Resync now" in Settings drops every queued date instead of dispatching them.
- **Why it matters:** Compounds C-1 (the connector loop is a stub). Once `run_cycle` is wired in, this branch will silently drop user-requested resyncs unless it is replaced with `fill_full_window` priming followed by an immediate flush.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Replace `dirty.clear()` with `dirty.clear(); fill_full_window(&mut dirty, clock.today(), MAX_WINDOW_DAYS);` (or equivalent) and either fall through to a flush or set a `force_flush_pending` flag the next loop iteration consumes; cover with a test that calls `force_resync` and asserts the next cycle pushes the full window.
- **Pass-1 source:** 10/F2
- **Status:** Open

### M-88 — PKCE verifier cache grows unbounded
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/oauth.rs:227-373` (insert at 362-367, drain in `exchange_code`)
- **What:** `OAuthClient::pkce_cache: Mutex<HashMap<String, PkceCodeVerifier>>` is populated on every `begin_authorize` and only drained when `exchange_code(state)` removes the matching entry. Cancelled flows (user opens browser, closes the tab) leave verifiers in the map indefinitely with no TTL, no upper bound, no eviction.
- **Why it matters:** gcal_push is internet-facing per AGENTS.md, so retaining stale OAuth secrets in process memory is a real concern. Each verifier corresponds to a once-valid CSRF state replayable up to ~10 minutes; unbounded growth across sessions also pulls the cache into bug-report bundles via the `Debug` impl that already logs `pkce_cache_entries`.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Replace the `HashMap` with a TTL-aware structure (store `(PkceCodeVerifier, Instant)`, sweep entries older than 10 min on every `begin_authorize` / `exchange_code`) and cap absolute size at ~16 entries with LRU eviction. Add a unit test that calls `begin_authorize` 100× and asserts the cache stays bounded.
- **Pass-1 source:** 10/F8
- **Status:** Open

### M-89 — `recover_calendar_gone` is two unrelated writes, not a transaction
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/connector.rs:727-741`
- **What:** Recovery from a 404 on the Agaric Agenda calendar performs two separate writes against the writer pool — `DELETE FROM gcal_agenda_event_map`, then `models::set_setting(..., CalendarId, "")` — outside any transaction. A crash between them leaves the event map empty but `calendar_id` still pointing at the gone calendar.
- **Why it matters:** The next cycle then patches against a stale calendar ID with no map rows, hits 404 → re-enters recovery → finally clears `calendar_id` → next cycle re-creates. Two cycles of noisy 404s and a brief inconsistent state where the connector cannot make progress.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Wrap both writes in one `BEGIN IMMEDIATE` tx (`DELETE FROM gcal_agenda_event_map`; `UPDATE gcal_settings SET value='', updated_at=? WHERE key='calendar_id'`; commit). Add a test that injects a `CalendarGone` mid-cycle and asserts post-state `(map_empty=true, calendar_id="")` after one cycle.
- **Pass-1 source:** 10/F10
- **Status:** Open

### M-90 — `is_space` typed as `text`; equality probed on the literal string `"true"`
- **Domain:** GCal / Spaces / Drafts
- **Location:** `migrations/0035_spaces.sql:6-7`; `src-tauri/src/spaces/bootstrap.rs:101, 169-179`; `src-tauri/src/commands/spaces.rs:48-56`
- **What:** The `is_space` property is registered with `value_type = 'text'` and every is-space probe filters by `value_text = 'true'` (literal lowercase). `property_definitions` does not declare `options = '["true"]'`, so `set_property_in_tx`'s options-membership guard does not enforce the value. Any peer / future UI that writes `"True"`, `"yes"`, `"1"` — or uses `value_num` / `value_ref` — silently disappears from `list_spaces`.
- **Why it matters:** A type-safe boolean flag this central to FEAT-3 deserves stricter modelling. Today the convergence invariant only holds because bootstrap is the *only* writer of `is_space`; that is fragile to extend (a future "rename space" or "promote page to space" affordance would have to remember the convention).
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either (a) change the `is_space` property type from `text` to `select` with `options = '["true", "false"]'` so `set_property_in_tx`'s options-membership guard kicks in (the current `text` type bypasses that guard — `commands/blocks/crud.rs:1190` only enforces options when `expected_type == "select"`), **or** (b) pivot the test to check non-empty truthy `value_text` in the queries. Prefer (a) for type safety. Add a test that `set_property` with `value_text='True'` is rejected once the type is changed.
- **Pass-1 source:** 10/F12
- **Status:** Open

### M-91 — `create_page_in_space_inner` does not require parent and child to share the same space
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/commands/spaces.rs:100-167` (parent path); test gap at `src-tauri/src/commands/spaces.rs:680-723`
- **What:** When `parent_id` is supplied, the helper validates only that `space_id` resolves to a live `is_space='true'` block; it never checks the parent's `space` property matches. A frontend that resolves `parent_id` from one space's tree but submits `space_id` for another succeeds and lands an op pair where the new page belongs to space X but its parent belongs to space Y.
- **Why it matters:** REVIEW-LATER.md FEAT-3 pins "Nothing outside of spaces. … No cross-space 'show everything' view." Cross-space parents undermine the "page sets are disjoint and their union is total" invariant — recursive CTE walkers that follow `parent_id` will then traverse across space boundaries.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Inside the `create_page_in_space_inner` tx, when `parent_id` is `Some`, fetch the parent's `space` ref-property and reject with `AppError::Validation` if it differs from `space_id`. Add a regression test `(parent in Personal, space_id=Work)` asserting the create fails and no ops are appended.
- **Pass-1 source:** 10/F13
- **Status:** Open

### M-92 — `bootstrap_spaces`'s `pages_without_space` migration does N round-trips for N pages
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/spaces/bootstrap.rs:59-73`
- **What:** First-boot migration loops over every legacy unscoped page and calls `set_property_in_tx` once per page. Each call does ~4 SQL round-trips (property-defs lookup, block existence probe, op_log append, `INSERT OR REPLACE INTO block_properties`). For a 5000-page vault this is ~20k queries inside one transaction held for the whole bootstrap.
- **Why it matters:** `bootstrap_spaces` is awaited synchronously from `lib.rs` setup and is documented as boot-fatal; a long single transaction risks WAL pressure, lock contention with the materializer, and a noticeable startup stall before the UI renders. It also blows up the partial-crash-resumability surface that bootstrap.rs's docstring promises.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Cache the `property_definitions` row once outside the loop, batch the `block_properties` upsert (chunked `INSERT OR REPLACE … VALUES (?), (?), …` per ~500 ids), and stream op_log appends in chunks of ~1000 with intermediate commits so a partial crash leaves a partial migration that the fast-path probe re-detects. No new tables / op types — stays inside Architectural Stability bounds.
- **Pass-1 source:** 10/F14
- **Status:** Open

### M-93 — `block_drafts` table has no FK to `blocks`
- **Domain:** GCal / Spaces / Drafts
- **Location:** `migrations/0001_initial.sql:67-71`; `src-tauri/src/draft.rs`; `ARCHITECTURE.md §12 Crash Recovery`
- **What:** `CREATE TABLE block_drafts (block_id TEXT PRIMARY KEY NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL)` declares no foreign key to `blocks(id)` — even though AGENTS.md sets `PRAGMA foreign_keys = ON` globally. The crash-recovery walk emits synthetic `EditBlock` ops for surviving drafts, so a draft whose block was hard-deleted produces a no-op edit for a missing target.
- **Why it matters:** Combined with H-12 (flush_draft does not validate the target block exists) this is the channel through which orphan ops enter the append-only log on every boot. The op log is supposed to be source-of-truth and append-only; orphan edits inflate compaction and complicate forensics.
- **Cost:** S (migration) — but **Risk Medium** because it changes drop semantics
- **Risk:** Medium
- **Impact:** Low
- **Recommendation:** Add a migration `block_id REFERENCES blocks(id) ON DELETE CASCADE`. **Requires user approval** under AGENTS.md §"Architectural Stability" (new schema constraint on a shipped table). Pair with H-12's existence check so flush also short-circuits on missing/soft-deleted blocks. Document the cascade interaction with soft-deletes (drafts survive soft-delete, are wiped on hard-delete/purge).
- **Pass-1 source:** 10/F18
- **Status:** Open

### M-94 — JWT `id_token` signature is not verified before extracting the email claim
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/oauth.rs:619-647`
- **What:** `extract_email_from_id_token` base64-decodes the JWT payload and reads `email` without verifying the RS256 signature against Google's JWKS. The doc explicitly accepts this on the grounds that the token came over TLS direct from Google's token endpoint and the email is "display-only".
- **Why it matters:** Per the user's threat-model carve-out, gcal_push is internet-facing — so OAuth token handling is in scope. The email is persisted to `gcal_settings.oauth_account_email` and shown in Settings; an unverified claim could mislead the user about which Google account is connected. In practice spoofing requires compromising the TLS channel (no realistic attacker today), but the posture is fragile if the token ever flows through a non-direct channel (proxy, Android browser handoff, FEAT-5g).
- **Cost:** M (JWKS fetch + cache + RSA verify; e.g. `jsonwebtoken` crate)
- **Risk:** Medium
- **Impact:** Low
- **Recommendation:** Either (a) implement full JWKS-based verification (cache JWKS, verify RS256, accept on `iss == https://accounts.google.com`, fail closed) **or** (b) keep the current behaviour and tighten the docstring + tracing to mark the email as `unverified_email` everywhere it surfaces. Option (a) is the right answer once FEAT-5g (Android) lands; (b) is acceptable while desktop-only.
- **Pass-1 source:** 10/F19
- **Status:** Open

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

### L-125 — `InstantBucket::take()` holds the bucket mutex during sleep
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/api.rs:743-787`
- **What:** Every `GcalApi` method does `self.bucket.lock().await.take().await`; the outer lock guard is held for the entire `take()` call, which itself sleeps. The implementation comment at line 745 claims "`take` drops the lock across its internal sleep" — the comment at line 782 admits "we are already inside the caller's `.lock().await` guard so the next request will queue on it."
- **Why it matters:** Functionally still rate-limits, but the documented and actual behaviours disagree. Concurrent requests fully serialise even when the bucket has free slots; the next reviewer who reads the optimistic comment will mis-design any concurrency improvement.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Compute `sleep_for` while holding the lock, drop the guard explicitly, sleep, re-acquire, push — or update the docstring to match the actual lock-during-sleep behaviour. Prefer the impl fix (matches the intended ~10 QPS concurrent-callers semantics).
- **Pass-1 source:** 10/F11
- **Status:** Open

### L-133 — `space` ref-property invariant relies on bootstrap migration but never re-runs
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/spaces/bootstrap.rs:39-86, 92-110`
- **What:** `is_bootstrap_complete` returns `true` as soon as both seed-space blocks exist with `is_space='true'`, after which `pages_without_space` never runs again. Pages that land in DB without a `space` property after bootstrap (cf. H-3 / H-4 / H-5 — JournalPage / TemplatesView creating unscoped pages, plus any peer-synced legacy CreateBlock op) stay unscoped forever — invisible to space-scoped list queries.
- **Why it matters:** Combined with the H-3/H-4 leak, this is the mechanism by which the FEAT-3 invariant decays: every new daily-journal page enters DB unscoped and never gets a `space` property. The bootstrap test (`bootstrap_skips_pages_that_already_have_space_property`) only pins that bootstrap is conservative — there is no follow-up sweep.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Fix H-3/H-4 first (frontend stops creating unscoped pages). Then either (a) extend the bootstrap fast-path to also assert `pages_without_space()` is empty (surfaces drift loudly with a boot-fatal error) or (b) add a periodic background sweep that assigns orphans to the user's "current" space (or Personal as fallback). Prefer (a) — option (b) obscures bugs.
- **Pass-1 source:** 10/F26
- **Status:** Open

## LOW findings (129 — expanded)

> Each entry is a fully-detailed block (Domain / Location / What / Why / Cost / Risk / Impact / Recommendation / Pass-1 source / Status).

### Core

### L-1 — `extract_block_id_from_payload` silently swallows malformed JSON
- **Domain:** Core
- **Location:** `src-tauri/src/op_log.rs:240-243`
- **What:** The helper returns `Option<String>` and uses `.ok()?` on `serde_json::from_str`. On a malformed payload it returns `None`, which `dag::insert_remote_op` (and any future caller) feeds straight into `INSERT … block_id = ?`, landing a row with `block_id IS NULL` instead of surfacing the parse error. AGENTS.md "Anti-patterns" forbids this kind of silent swallowing.
- **Why it matters:** The hash is verified before this helper runs in `insert_remote_op`, so today the input is guaranteed valid bytes — but the indexed `block_id` column (PERF-26 in the source comment) backs query plans, so a future caller without a hash check would silently lose the index entry on corruption, producing "queries miss this op" bugs that are very hard to attribute.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Change the signature to `Result<Option<String>, serde_json::Error>` and propagate to the caller via `?`; `dag::insert_remote_op` already returns `AppError`, which has `From<serde_json::Error>`. Add a unit test pinning that malformed JSON propagates rather than silently producing `None`.
- **Pass-1 source:** 01/F6
- **Status:** Open

### L-2 — Boot path swallows DB count errors via `unwrap_or(0)`
- **Domain:** Core
- **Location:** `src-tauri/src/lib.rs:440-444, 447-453, 468-472, 474-480`
- **What:** Four `SELECT COUNT(*)` queries at boot (`fts_blocks`, two `blocks` counts, `block_tag_refs`) feed their result through `tauri::async_runtime::block_on(...).unwrap_or(0)`. A DB error is silently coerced to "table is empty", optionally scheduling a rebuild, with no `tracing::warn!` of the error itself. The neighbouring `link_metadata::cleanup_stale` block does log on `Err`, so the inconsistency is visible.
- **Why it matters:** A DB-level outage at boot (locked file, schema mismatch) gets papered over rather than reported. Bug reports would show "FTS rebuild scheduled for no reason" with no breadcrumb explaining why.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Introduce a small helper `fn log_or_zero(r: Result<i64, sqlx::Error>, ctx: &str) -> i64` that emits `tracing::warn!(error = %e, ctx, "boot count query failed; treating as 0")` and returns `0`. Replace each `.unwrap_or(0)` with `log_or_zero(...)`; mirrors the style used at `lib.rs:412-423`.
- **Pass-1 source:** 01/F7
- **Status:** Open

### L-3 — `BlockId::from_trusted` uses Unicode `to_uppercase()`; `Deserialize` uses `to_ascii_uppercase()`
- **Domain:** Core
- **Location:** `src-tauri/src/ulid.rs:18-29` vs `src-tauri/src/ulid.rs:63-65`
- **What:** Three normalization paths disagree on which case-folding helper they use. `Deserialize::deserialize` calls `s.to_ascii_uppercase()`, `from_trusted(&str)` calls `s.to_uppercase()` (Unicode-aware), and `from_string` routes through `ulid::Ulid::from_str` (always-ASCII canonical form). For ASCII inputs (the only valid case) all three behave identically; for non-ASCII they diverge — `from_trusted("ß")` → `"SS"` while round-tripping the same bytes through serde yields `"ß"`.
- **Why it matters:** AGENTS.md invariant #8 makes ULID uppercase normalization a hash-determinism prerequisite. Today the Crockford alphabet keeps inputs inside ASCII so the bug is theoretical, but the asymmetry is a footgun: any future reuse of `BlockId` for non-ULID identifiers (attachment filenames, sync handshake keys) could split the chain across devices.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Change `from_trusted` (`ulid.rs:63-65`) to use `s.to_ascii_uppercase()`, matching the `Deserialize` path. Add a property test asserting `BlockId::from_trusted(s).as_str() == BlockId::deserialize(serde_json::Value::String(s.clone())).as_str()` for arbitrary `String`.
- **Pass-1 source:** 01/F8
- **Status:** Open

### L-4 — `compute_op_hash` null-byte invariant is `debug_assert!` only
- **Domain:** Core
- **Location:** `src-tauri/src/hash.rs:35-90` (the four `debug_assert!` calls at 44-60)
- **What:** The function uses `\0` as a between-field separator and uses `debug_assert!` on `device_id`, `parent_seqs`, `op_type`, and `payload` to enforce the invariant. In `--release` builds those assertions vanish; an input containing a raw `\0` would silently produce an ambiguous preimage (e.g. `device_id = "A\0B"`, `seq = 1` could collide with `device_id = "A"` plus a payload that begins with `B`). The hash.rs module-level docstring describes this format as the "wire format contract".
- **Why it matters:** The hash chain is the basis of the cross-device identity contract. `debug_assert!` is appropriate for "should never happen during local development", but the contract is invoked during sync between user devices in release builds. The cost of a real `assert!` is four `memchr`-style scans per hash — negligible compared to blake3 itself.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Convert the four `debug_assert!` calls in `hash.rs:44-60` into `assert!` so they fire in release. Optionally add a release-build test exercising `payload_with_embedded_null_bytes_is_distinct` outside `#[cfg(not(debug_assertions))]`.
- **Pass-1 source:** 01/F9
- **Status:** Open

### L-5 — `append_local_op_in_tx` requires `BEGIN IMMEDIATE` but enforces nothing
- **Domain:** Core
- **Location:** `src-tauri/src/op_log.rs:76-191` (function), `op_log.rs:209-216` (the only place that gets the lock right)
- **What:** `append_local_op_in_tx` reads `MAX(seq)` then `INSERT`s. Its function-level doc says callers commit the tx, but does not say the tx must be opened with `BEGIN IMMEDIATE`. Every direct caller currently does pair it with `pool.begin_with("BEGIN IMMEDIATE")`, but there is no compile-time or runtime guard. The neighbouring `append_local_op_at` shows the right pattern with an explicit comment about avoiding `SQLITE_BUSY_SNAPSHOT`.
- **Why it matters:** A future caller that forgets `BEGIN IMMEDIATE` (the sqlx default `pool.begin()` is `BEGIN DEFERRED`) only hits `SQLITE_BUSY_SNAPSHOT` under contention with a concurrent writer — exactly the class of bug that doesn't reliably show up in tests on a single TempDir, and exactly the class the existing comment says the eager lock prevents.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Document the requirement at the top of `append_local_op_in_tx` and add a debug-only sanity check, e.g. by introducing a `pub struct ImmediateTx<'a>` newtype that the helper accepts and that is only constructed by `db::begin_immediate_logged`. Cheaper: a doc-comment + targeted test that opens a `BEGIN DEFERRED` tx and asserts the function returns the expected sqlite-busy classification under contention.
- **Pass-1 source:** 01/F10
- **Status:** Open

### L-6 — `validate_set_property` accepts empty strings in `value_text` / `value_date` / `value_ref`
- **Domain:** Core
- **Location:** `src-tauri/src/op.rs:365-414` (specifically the field-count check at 394-401, no per-string `trim().is_empty()` guard)
- **What:** The validator enforces "exactly one of `value_text/num/date/ref` set" and finite-ness for `value_num`, but does not check that the chosen string field is non-empty after trimming. `value_text = Some("")`, `value_date = Some("")`, or `value_ref = Some("")` all pass and land in the op log. `value_date` is later parsed by agenda code as ISO 8601 — an empty string makes that parse fail downstream.
- **Why it matters:** Defensive validation at the command layer should be authoritative. The frontend already enforces non-empty values, but op-log entries can also originate from MCP tools (`mcp/tools_rw.rs`) and import paths, so a backend-side guard prevents a category of "set property to empty, then everything that touches that property breaks" downstream bugs.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** In `validate_set_property`, reject `Some(s)` where `s.trim().is_empty()` for `value_text`, `value_date`, and `value_ref`, with a clear `AppError::Validation(format!("…{} must not be empty", field_name))`. Add three failing-input unit tests next to the existing `validate_set_property_*` cases.
- **Pass-1 source:** 01/F12
- **Status:** Open

### L-7 — Slow-acquire helpers are wired up in only 2 modules
- **Domain:** Core
- **Location:** `src-tauri/src/db.rs:6-67` (helpers + threshold constant); production call sites limited to `commands/blocks/crud.rs` and `commands/compaction.rs`
- **What:** `db::acquire_logged` and `db::begin_immediate_logged` ship with a 100 ms warn threshold and dedicated tests. A grep shows them used in two production modules only; the rest of the codebase still goes through bare `pool.acquire()` / `pool.begin_with("BEGIN IMMEDIATE")`. The file's own doc says *"Migrate call sites gradually — wrap this around `pool.acquire()` only on hot paths…"* but the migration has stalled.
- **Why it matters:** The 5 s `busy_timeout` makes silent freezes the user-visible symptom of write-lock starvation. Without `acquire_logged` we have no breadcrumb to tell a freeze from a hang. This is operational visibility, not correctness.
- **Cost:** M
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Sweep through `materializer/`, `sync_protocol/`, `snapshot/`, and `cache/` in a follow-up and replace `pool.acquire()` / `pool.begin_with("BEGIN IMMEDIATE")` with `db::acquire_logged(&pool, "<module>_<reason>")` / `db::begin_immediate_logged(...)`. No-op behaviour change; pure observability win.
- **Pass-1 source:** 01/F13
- **Status:** Open

### L-8 — Legacy `init_pool` skips `PRAGMA optimize`
- **Domain:** Core
- **Location:** `src-tauri/src/db.rs:163-177` (legacy) vs `src-tauri/src/db.rs:126-156` (production `init_pools`, optimize at 143)
- **What:** `init_pools` runs `PRAGMA optimize` after migrations; the legacy `init_pool` (kept for tests that don't need pool separation, per its doc-comment) does not. Tests across at least 14 modules use `init_pool` for fixtures, so the production query-planner state is never exercised by the unit tests.
- **Why it matters:** Low-risk drift; `init_pool`'s only stated purpose is "backward compatibility in tests that don't need pool separation", so there is no reason for the optimisation pragma to differ. PRAGMA optimize is "safe, idempotent, runs in <100ms" per the surrounding comment.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Copy the `sqlx::query("PRAGMA optimize").execute(&pool).await?;` invocation into `init_pool` immediately after `sqlx::migrate!("./migrations").run(&pool).await?;`. No test changes needed; it's idempotent.
- **Pass-1 source:** 01/F14
- **Status:** Open

### L-9 — `import.rs` YAML frontmatter terminator is `\n---` only — CRLF files keep their frontmatter as content
- **Domain:** Core
- **Location:** `src-tauri/src/import.rs:46-58`
- **What:** The parser strips frontmatter by looking for `\n---` after a leading `---` prefix. `find("\n---")` does not match `\r\n---`. A markdown file that originated on Windows (or was saved by a cross-platform editor that writes CRLF) keeps its frontmatter intact in the imported blocks. The existing test `parse_yaml_frontmatter_unclosed_treated_as_content` documents the unclosed case but there is no CRLF-positive test.
- **Why it matters:** Import is a documented user-facing feature (Logseq/Markdown). Frontmatter stripping that works on macOS/Linux but leaks YAML as content blocks on Windows imports is silently broken UX.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Normalize line endings up front in `parse_logseq_markdown`: `let normalized = content.replace("\r\n", "\n").replace('\t', "  ");`. Add a regression test with a CRLF fixture that matches `parse_yaml_frontmatter_stripped`.
- **Pass-1 source:** 01/F15
- **Status:** Open

### Materializer

### L-10 — Foreground barrier wraps a synchronous `notify_one()` in `tokio::spawn`
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/consumer.rs:142-152`, `src-tauri/src/materializer/handlers.rs:74-77`
- **What:** For `MaterializeTask::Barrier`, `process_single_foreground_task` clones the pool / metrics / gcal handle and spawns a sub-task whose body just calls `handle_foreground_task`, which in turn calls `notify.notify_one()`. The `run_background` path (consumer.rs:217-223) handles barriers inline — no spawn, no clone. The fg spawn-around-spawn pattern is a leftover from the panic-isolation pattern used for real handlers and is unnecessary for a barrier.
- **Why it matters:** Every `flush_foreground()` call (and there are several per command in tests + production) pays a `tokio::task::spawn` + `await` round-trip plus the pool/metrics/gcal Arc clones, for nothing. Cumulative cost on a busy device is not large but is pure waste.
- **Cost:** S (<2h)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Inline the barrier path in `process_single_foreground_task` (mirror the bg-side handling at `consumer.rs:217-223`): match `Barrier(notify)` first, call `notify.notify_one()`, bump `fg_processed`, return.
- **Pass-1 source:** 02/F14
- **Status:** Open

### L-11 — `record_failure` does SELECT-then-INSERT instead of one UPSERT
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/retry_queue.rs:101-128`
- **What:** `record_failure` first runs `SELECT attempts FROM materializer_retry_queue WHERE block_id = ? AND task_type = ?`, computes `new_attempts = prior.unwrap_or(0) + 1`, then UPSERTs the row. The same effect is reachable in one round-trip via `ON CONFLICT(block_id, task_type) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error, next_attempt_at = ?`. Two concurrent failure inserts for the same `(block_id, task_type)` can both observe `prior = None`, both compute `attempts = 1`, and both INSERT — the second triggers ON CONFLICT and overwrites with the same `excluded.attempts = 1`, losing one increment.
- **Why it matters:** The bg consumer is largely single-threaded, so the race is rare in practice, but the off-by-one shifts the backoff schedule by one step and the extra round-trip is unnecessary on the hot retry path.
- **Cost:** S (<2h)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Replace the SELECT + INSERT with a single `INSERT … VALUES (1, …) ON CONFLICT(block_id, task_type) DO UPDATE SET attempts = materializer_retry_queue.attempts + 1, last_error = excluded.last_error, next_attempt_at = ?`. Compute `next_attempt_at` from the post-update `attempts` via `RETURNING attempts` if SQLite version permits, otherwise accept a one-step delay.
- **Pass-1 source:** 02/F15
- **Status:** Open

### L-12 — `fg_full_waits` increment via TOCTOU read of `tx.capacity()`
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/coordinator.rs:452-454`
- **What:** `enqueue_foreground` checks `if tx.capacity() == 0 { fg_full_waits.fetch_add(1, …); }` *before* `tx.send(task).await`. `capacity()` is a snapshot — it can be 1 at the check and 0 by the time `send` actually awaits, OR 0 at the check but 1 by the time send completes immediately. The metric over- or under-counts the actual wait events.
- **Why it matters:** `fg_full_waits` is the documented backpressure indicator (MAINT-24). Treating it as a precise count when sizing capacity will mis-fire either direction; this is a classic TOCTOU on a shared mpsc.
- **Cost:** S (<2h)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either (a) `tx.try_send()` first; on `Full`, bump `fg_full_waits`, then `tx.send().await`; or (b) measure the duration of the `await` itself and only bump when it exceeds (e.g.) 1 ms. (a) is cleaner and avoids time-based heuristics.
- **Pass-1 source:** 02/F17
- **Status:** Open

### L-13 — `dedup` parses the same payload JSON multiple times per drain
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/dedup.rs:62-101`, `src-tauri/src/materializer/handlers.rs:140-518` (apply_op_tx)
- **What:** `extract_block_id` deserialises `record.payload` into `BlockIdHint` once per `ApplyOp` (in `group_tasks_by_block_id`), and then `apply_op_tx` deserialises the same payload again into the typed `CreateBlockPayload` / `BlockIdHint` / etc. For a 1000-op batch drain this is ≈2000 JSON parses where ≈1000 would suffice.
- **Why it matters:** JSON parsing is one of the heavier per-op costs. Doubling it on the drain hot path matters under sync floods (Android catch-up), where the materializer is already the bottleneck.
- **Cost:** M (2-8h)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either (a) cache the parsed `block_id` as a sidecar field on `OpRecord` populated at op-log-append time, or (b) carry a typed `OpPayload` enum through the materializer (already partly exists in `op::*Payload`) so payloads are parsed exactly once per op. (a) is the smaller change.
- **Pass-1 source:** 02/F18
- **Status:** Open

### L-14 — `handle_foreground_task` silently drops unexpected variants
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/handlers.rs:78-82`, `src-tauri/src/materializer/handlers.rs:584-605` (bg counterpart)
- **What:** The catch-all `_ =>` arm logs a `tracing::warn!` and returns `Ok(())`. Any future task variant accidentally enqueued to the foreground queue (e.g. a `RebuildTagsCache` from a misrouted dispatch) is never retried, never persisted, and counts as a successful `fg_processed` increment. The bg-side has the same pattern for `ApplyOp` / `BatchApplyOps` / unknown variants.
- **Why it matters:** A regression that routes a global cache rebuild to the foreground queue would silently swallow every such task without any test failure or observable signal. This is exactly the kind of bug the test suite cannot catch with happy-path assertions alone.
- **Cost:** S (<2h)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Promote the warn to an `error` log and either return `AppError::Validation("unexpected …")` so it counts toward `fg_errors` / `bg_errors`, or add `debug_assert!(false, "…")` so test runs catch it while production keeps the resilient `Ok(())` return.
- **Pass-1 source:** 02/F19
- **Status:** Open

### L-15 — Tests cover happy paths well; several risk areas are uncovered
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/tests.rs` (4025 LOC)
- **What:** The suite is broad on dispatch routing, dedup behaviour, batch atomicity, and the FEAT-5h GCal hook, but several risk areas are thin or missing: (1) no test for permanent failure of an `ApplyOp` (related to the C-2 / F1 retry-exhaustion concern); (2) no test for FK-ordering hazards under parallel groups with `CreateBlock(parent)` racing `CreateBlock(child)`; (3) `try_enqueue_background_drops_when_full` enqueues only 2000 tasks, less than the combined `FOREGROUND_CAPACITY (256) + BACKGROUND_CAPACITY (1024)` cap, so it does not actually exercise the Full-arm; (4) no test for the 5-minute `*_high_water` reset (M-13); (5) `dispatch_bg_empty_block_id` uses `#[should_panic]` against a `debug_assert!`, so release-mode behaviour of the empty-block_id branch is untested.
- **Why it matters:** The most common bug categories in async queue code (drop-on-full, retry exhaustion, ordering hazards) are exactly the ones with the thinnest test coverage; M-7 / M-8 in particular would have been caught by a Full-arm test.
- **Cost:** M (2-8h)
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Add (a) a permanent-failure test that asserts a doubly-failed `ApplyOp` leaves `op_log` populated and core tables empty (documenting current behaviour and providing a regression seat for the eventual fix); (b) a `flavor = "multi_thread"` test for `CreateBlock(parent)` and `CreateBlock(child)` arriving in the same batch; (c) a Full-queue test that fills past `BACKGROUND_CAPACITY` and asserts `bg_dropped` (or the new backpressure counter from M-8) increments; (d) a release-mode test for the empty-block_id dispatch branch.
- **Pass-1 source:** 02/F20
- **Status:** Open

### L-16 — Foreground retry: ordering of error log vs. retry attempt
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/consumer.rs:162-180`
- **What:** On the first failure of a foreground task, the consumer calls `log_consumer_result("fg", &result)` (logging at `error` level) and *then* sleeps 100 ms and retries. If the retry succeeds, the original error log line is never followed by a "retry succeeded" message, leaving the operator-facing log saying only "error processing materializer task." From the user's view the op succeeded.
- **Why it matters:** Log-noise hygiene; spurious error counts in operator dashboards or in `recent_errors_from_log_dir` (commands/system.rs) built on log-line matching. For a single-user device this also pollutes the bug-report log capture with non-actionable errors.
- **Cost:** S (<2h)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Demote the first-attempt failure log to `debug` level and only emit at `error` if the retry also fails. Alternatively keep the first log but follow a successful retry with `tracing::info!("fg-retry succeeded")` so log scrapers can correlate the pair.
- **Pass-1 source:** 02/F21
- **Status:** Open

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

### Cache + Pagination

### L-18 — `Cursor` is opaque base64 JSON with no version field
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/pagination/mod.rs:151-162` (Cursor struct) and `:185-202` (codec)
- **What:** The `Cursor` struct uses `#[serde(default)]` on every optional field but has no `version: u8` tag. Any future change to ordering keys or stored cursor fields (e.g., `list_trash` switching sort key, `list_block_history` reversing direction, a new key added to a query) will silently decode old cursors as if they were valid for the new schema and produce wrong/duplicate/missing pages — there is no way to detect that a cursor predates the schema change.
- **Why it matters:** Today's behaviour is fine, but the absence of a version tag is a footgun for the next maintainer changing any list-query ordering. Single-user threat model: this is a maintainability/correctness landmine, not a security issue.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add `version: u8` (default `1`) to `Cursor`. On decode, reject unknown versions with `AppError::Validation` so clients re-paginate from page 1. Alternatively prefix the base64 payload with a one-byte version tag before encoding.
- **Pass-1 source:** 03/F8
- **Status:** Open

### L-19 — `rebuild_all_caches` is called only from tests; production goes via the materializer
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/cache/mod.rs:112-119`
- **What:** A repository-wide grep shows `rebuild_all_caches` only appears in `cache/mod.rs` (definition) and `cache/tests.rs` (one test). Production paths (snapshot restore, materializer) enqueue individual `MaterializeTask::Rebuild*` variants instead. The doc-comment ("Calls [`rebuild_block_tag_refs_cache`], …") makes it sound production-relevant.
- **Why it matters:** Implies a public API surface that isn't actually used; combined with M-15 it is also subtly buggy (ordering), so leaving it around invites a future maintainer to wire it into production and inherit the bug.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either gate it `#[cfg(test)]` and inline at the test callsite, or fix M-15 and document this function as the canonical sequence so the snapshot-restore enqueue array can mirror it.
- **Pass-1 source:** 03/F10
- **Status:** Open

### L-20 — `list_agenda` / `list_agenda_range` / `list_backlinks` do not filter `is_conflict = 0` on `b`
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/pagination/agenda.rs:31-37` and `:86-93`; `src-tauri/src/pagination/links.rs:28-32`
- **What:** All three queries `JOIN blocks b ON b.id = …` and only filter `b.deleted_at IS NULL`. The cache-side rebuilds exclude `is_conflict = 1` blocks, so under normal operation conflict rows do not reach these queries — but there is a TOCTOU window: when ops mark a block as a conflict via `set_conflict`/`mark_as_conflict` and enqueue the cache rebuild, the cache row remains until the background consumer runs. Other list queries (`list_children`, `list_by_type`, `list_by_tag`, `query_by_property`, `list_undated_tasks`) all add `is_conflict = 0` defensively.
- **Why it matters:** Conflict copies could briefly appear in agenda or backlinks views during the rebuild window. Single-user threat model: minor UI flicker, not data corruption.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add `AND b.is_conflict = 0` to the WHERE in `list_agenda`, `list_agenda_range`, and `list_backlinks` for consistency with the other list queries. Add a regression test that flips a block to `is_conflict = 1` without rebuilding the cache and asserts it does not appear in agenda/backlinks listings.
- **Pass-1 source:** 03/F11
- **Status:** Open

### L-21 — `list_block_history` cursor uses `c.seq.unwrap_or(0)` — relies on op_log seq ≥ 1
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/pagination/history.rs:28-32` (cursor unpack) and `:40-43` (keyset predicate)
- **What:** When `page.after` is `None` the keyset comparison is short-circuited via `cursor_flag = None`, but the unwrap default is `cursor_seq = 0`. If a real op_log row had `seq = 0`, the predicate `seq < 0 OR (seq = 0 AND device_id < "")` would treat it as already-seen. In practice op_log seqs auto-increment per device starting at 1, so this is fine — but the assumption is undocumented.
- **Why it matters:** A future change introducing seq 0 (e.g., a per-device introduction sentinel op) would break pagination silently.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Document the seq ≥ 1 assumption in the function header, or — preferred — leave `cursor_seq` as `Option<i64>` and bind it directly so the `?2 IS NULL` short-circuit handles the no-cursor case without needing a sentinel. (`list_block_history` already uses `cursor_flag` for the short-circuit; it just additionally passes `cursor_seq.unwrap_or(0)`.)
- **Pass-1 source:** 03/F12
- **Status:** Open

### L-22 — `list_page_history` `__all__` branch uses dynamic `query_as::<_, _>` (no compile-time SQL check)
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/pagination/history.rs:97-115`
- **What:** The "global history" branch (`page_id == "__all__"`) uses `sqlx::query_as::<_, HistoryEntry>(…)` with `.bind()` instead of the `query_as!` macro, bypassing compile-time SQL validation. The page-scoped branch (`:130-156`) uses `query_as!` correctly. The SQL is short and parameter-only — there is no obvious dynamic-SQL reason; AGENTS.md invariant #6 mandates compile-time queries.
- **Why it matters:** Schema drift between this query and `op_log`'s columns is only caught at runtime, not at `cargo check`/`cargo sqlx prepare`.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Convert to `sqlx::query_as!`. The `(?N IS NULL OR …)` style parameters are supported by the macro. If a genuinely dynamic codepath is needed in the future, add an inline rationale comment.
- **Pass-1 source:** 03/F13
- **Status:** Open

### L-23 — `query_by_property` accepts both `value_text` and `value_date` with silent precedence
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/pagination/properties.rs:18-105` (esp. `:67-70` and `:90-91`)
- **What:** The function takes `value_text: Option<&str>` and `value_date: Option<&str>` independently. For reserved-key columns (`due_date`, `scheduled_date`) the body picks `value_date.or(value_text)` — silently dropping `value_text` if `value_date` is set. For non-reserved keys the SQL is `(?2 IS NULL OR bp.value_text {sql_op} ?2) AND (?3 IS NULL OR bp.value_date {sql_op} ?3)`, intersecting both filters when both are provided. Two different precedence rules in one function depending on which branch is taken; the doc-comment says nothing about it.
- **Why it matters:** A caller passing both due to UI confusion gets surprisingly different results for `due_date` (uses date, ignores text) vs. `effort` (intersects). Easy to ship a bug downstream.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Reject conflicting inputs at the boundary (return `AppError::Validation` if both are set), or pick a single precedence rule and apply it uniformly across both branches. Document either way.
- **Pass-1 source:** 03/F14
- **Status:** Open

### L-24 — `cache/block_links.rs` per-target DELETE/INSERT loop — N round-trips per reindex
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/cache/block_links.rs:59-83` (single-pool) and `:147-168` (split)
- **What:** For each removed target a `DELETE FROM block_links WHERE source_id = ? AND target_id = ?` is executed; for each added target a separate `INSERT OR IGNORE … SELECT … WHERE EXISTS …`. Reindexing a block with N changed links costs 2N round-trips inside the transaction. `block_tag_refs.rs:81-109` follows the same pattern but per-block N is typically small there.
- **Why it matters:** Bulk imports / paste of large markdown can produce blocks with dozens of links; reindexing sits on the materializer hot path.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Use `DELETE FROM block_links WHERE source_id = ? AND target_id IN (SELECT value FROM json_each(?))` and a chunked multi-row INSERT for additions (matching the snapshot-import path). Same approach as M-18.
- **Pass-1 source:** 03/F15
- **Status:** Open

### L-25 — `rebuild_agenda_cache_split_impl` releases the read snapshot before writing
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/cache/agenda.rs:230-340` (esp. `drop(read_tx)` at `:306`)
- **What:** The function reads desired-state and current-cache rows from `read_pool` inside one read transaction, drops the tx, then begins a write tx on `write_pool` and applies the diff. Between drop and begin another writer can mutate `agenda_cache` or `blocks`, so the diff applied may be stale relative to the live state at write time. The single-pool variant (`rebuild_agenda_cache_impl`) holds one tx across read+write and avoids this. The behaviour is consistent with documented stale-while-revalidate semantics, but no test exercises a write-during-rebuild race.
- **Why it matters:** In rare contention scenarios the rebuild can churn the cache (insert+delete the same row that another writer just touched). Eventually consistent — not a correctness bug per AGENTS.md, but worth a comment for the next maintainer.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Low
- **Recommendation:** Either add a code comment in the function explaining the TOCTOU window (and that the next rebuild fixes it), or — heavier — re-read inside the write tx and skip conflicting writes. The comment is cheaper and matches the stated "background, stale-OK" semantics.
- **Pass-1 source:** 03/F16
- **Status:** Open

### L-26 — `cache/projected_agenda.rs` uses `chrono::Local::now()` (machine-timezone dependent)
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/cache/projected_agenda.rs:51` (`today = chrono::Local::now().date_naive()`); also referenced at `:152` (`current >= today`) and `:167-168` (`current >= today && current <= horizon`)
- **What:** `today` is derived from the device's local timezone. The 365-day horizon and `current >= today` comparisons use that local-time anchor. `agenda_cache` and `projected_agenda_cache` store `YYYY-MM-DD` strings without timezone. On a multi-device user with devices in different timezones, the same vault rebuilt on each device produces slightly different `projected_agenda_cache` contents around the day boundary. Sync replays op_log ops, but `projected_agenda_cache` is rebuilt locally per device, so the divergence is per-device and self-correcting on the next rebuild past the time skew.
- **Why it matters:** Around midnight the projected agenda flickers depending on which device the user is viewing. Probably acceptable for the single-user threat model, but undocumented and tests using `Local::now()` are flaky around midnight.
- **Cost:** S
- **Risk:** Medium (changing semantics)
- **Impact:** Low
- **Recommendation:** Either document the per-device local-time semantics in the function header, or normalize to UTC consistently. Add a unit test that pins `now()` via clock injection or a fake clock so day-boundary tests are deterministic.
- **Pass-1 source:** 03/F17
- **Status:** Open

### L-27 — Agenda desired-state SQL duplicated between single-pool and split rebuilds
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/cache/agenda.rs:58-109` (single-pool impl) vs. `:235-286` (split impl)
- **What:** The 51-line UNION-ALL desired-state query is duplicated verbatim in `rebuild_agenda_cache_impl` and `rebuild_agenda_cache_split_impl`. Any change to the template-page filter, source semantics, or new column source must touch both. There is no test asserting both impls produce identical output for the same input.
- **Why it matters:** Silent divergence between the two implementations is the kind of bug that escapes review; this review only caught it because both files were read sequentially.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Extract the SQL into `const DESIRED_AGENDA_SQL: &str = "…"` and bind from both, or introduce a `#[cfg(test)]` oracle that runs `rebuild_agenda_cache(&pool)` and `rebuild_agenda_cache_split(&pool, &pool)` on identical fixtures and asserts `agenda_cache` row-set equality.
- **Pass-1 source:** 03/F19
- **Status:** Open

### L-28 — Missing CTE oracle for `rebuild_page_ids` recursive walk
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/cache/page_id.rs:34-60`; tests live in `src-tauri/src/cache/tests.rs` but no oracle for this path
- **What:** AGENTS.md "Performance Conventions" Pattern #8 prescribes a `#[cfg(test)]` oracle preserving the old implementation when optimizing a query; `pagination/tests.rs:2945-3094` already has a good oracle for `list_children`'s `IFNULL → sentinel` optimisation. `rebuild_page_ids` is a recursive CTE walking ancestors and lacks an equivalent — a future refactor (e.g., to a materialised parent-pointer table) would risk silently changing semantics with no regression net.
- **Why it matters:** The next maintainer optimising this rebuild lacks a regression net; conflict-aware ancestor walking is exactly the area invariant #9 calls out as fragile.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add a `#[cfg(test)]` oracle that walks ancestors in Rust (HashMap of `id → parent_id`, climb until a `page` ancestor or `is_conflict = 1` boundary) and assert it matches the SQL CTE result on a synthetic vault containing conflict copies, deep nesting, and multiple roots.
- **Pass-1 source:** 03/F20
- **Status:** Open

### L-29 — `query_by_property` reserved-vs-non-reserved-key precedence is undocumented
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/pagination/properties.rs:43-105` (the two branches at `:43-77` and `:78-105`); doc-comment at `:7-17`
- **What:** Beyond the silent value_text/value_date precedence (L-23), the function's reserved-key branch routes to a column read on `blocks` (4 columns: `todo_state`, `priority`, `due_date`, `scheduled_date`) while the non-reserved branch routes to `block_properties`. Callers cannot tell from the signature which keys are routed where; the column list is hardcoded (`unreachable!` at `:50` for any other reserved key) and tied to `op::is_reserved_property_key`. The doc-comment does not mention the routing or the reserved-key column set.
- **Why it matters:** A future reviewer trying to add a fifth reserved column (e.g., `effort`) has to discover the routing by reading `is_reserved_property_key`. Adding a key without updating the `match col { … _ => unreachable!() }` arm is a runtime panic.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Document the routing in the function header (which keys are columns, which use `block_properties`, where the source of truth is). Replace `unreachable!()` with an explicit `AppError::Validation` so a missed update is a clean error rather than a panic. Cross-reference `op::is_reserved_property_key` from the doc-comment.
- **Pass-1 source:** 03/F14 (synthesised in pass-2 summary)
- **Status:** Open

### Commands CRUD

### L-30 — `import_markdown_inner` swallows per-block errors inside one transaction without savepoints
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/pages.rs:243-349`
- **What:** A single `BEGIN IMMEDIATE` covers the entire import; per-block `create_block_in_tx` and per-property `set_property_in_tx` failures are caught into a `warnings` vec and the loop continues. SQLite does not roll back individual statements within a tx, so the eventual `tx.commit()` may either succeed in an inconsistent partial state or fail wholesale and lose all imported rows.
- **Why it matters:** The advertised "log warnings, keep going" contract cannot be honoured atomically without savepoints; today's behaviour is undefined under any per-row error.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Either (a) wrap each per-block / per-property attempt in `tx.savepoint("blk_N")` with `release` on success and `rollback_to` on error, or (b) abort the whole import on the first error and surface warnings as a partial-failure diagnostic. Add a test that injects a validation error mid-file and asserts an all-or-nothing outcome.
- **Pass-1 source:** 04/F7
- **Status:** Open

### L-31 — `restore_page_to_op_inner` reads `ops_after` outside the write transaction it eventually opens
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/history.rs:316-403`
- **What:** The list of ops to revert is computed against the bare pool; only the downstream `revert_ops_inner` opens `BEGIN IMMEDIATE`. New ops landing between the two points (sync replay, edits elsewhere) miss the snapshot and are not reverted.
- **Why it matters:** The function's contract — "revert everything after the target op" — is technically violated. Threat model is single-user so the practical window is small, but the snapshot semantics are surprising.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either lift the read into the same `BEGIN IMMEDIATE` tx as the revert, or document the snapshot-at-read-time semantics explicitly.
- **Pass-1 source:** 04/F11
- **Status:** Open

### L-32 — `update_property_def_options_inner` does not validate existing rows against the new options set
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/properties.rs:474-515`
- **What:** Narrowing a select-type definition's options leaves dangling `block_properties.value_text` values that are no longer in the allowed list. Subsequent `set_property_in_tx` writes will reject those values, but reads through `get_properties` continue to surface them.
- **Why it matters:** Local UX inconsistency — the user can read a value they can no longer write — though sync replay behaves identically on both ends so it is not a corruption vector.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either reject the narrowing call when dependent rows fall outside the new set, or emit a count of orphans for the caller to act on. Strict rejection matches typical schema-evolution systems.
- **Pass-1 source:** 04/F13
- **Status:** Open

### L-33 — Tauri-emit error in property-mutating commands is silently dropped via `let _ = app.emit(...)`
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/properties.rs:630-636`, `:658-664`, `:702-708`, `:731-737`, `:760-766`
- **What:** Each command wrapper emits `EVENT_PROPERTY_CHANGED` via `let _ = app.emit(...)`, swallowing any Emitter error. AGENTS.md anti-patterns ban silent `.catch(() => {})` on the frontend; the same logic applies to backend IPC emits — failure here means the frontend store is stale until the next refresh.
- **Why it matters:** Diagnosing "I changed X but the UI didn't update" is hard with no log trace; a single `tracing::warn!` makes it visible at near-zero cost.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Replace each `let _ = app.emit(...)` with `if let Err(e) = app.emit(...) { tracing::warn!(error = %e, event = ..., "..."); }`. Apply consistently to all five sites (and the new `set_priority` site once L-38 is fixed).
- **Pass-1 source:** 04/F15
- **Status:** Open

### L-34 — `add_tag_inner` allows a block to tag itself
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/tags.rs:34-121`
- **What:** Aside from confirming `tag_id` is a `tag`-typed block, the function does not reject `block_id == tag_id` (a tag tagging itself), which the downstream `tag_inheritance::propagate_tag_to_descendants` walk could then re-enter if the tag also appears in its own ancestry.
- **Why it matters:** Edge case, low impact, but worth a one-line guard for defence-in-depth against pathological inputs (MCP tool, sync replay, scripted import).
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add `if block_id == tag_id { return Err(AppError::InvalidOperation("a block cannot tag itself".into())); }` near the top of `add_tag_inner` and cover it with a one-liner test.
- **Pass-1 source:** 04/F19
- **Status:** Open

### L-35 — `dispatch_background_for_page_create` re-reads ops from the op_log instead of threading them through
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/spaces.rs:215-249` (and `create_page_in_space_inner` upstream)
- **What:** `create_page_in_space_inner` discards the `OpRecord`s returned by `create_block_in_tx` and `set_property_in_tx` (`let (block, _page_op_record) = ...`); the wrapper then re-reads the freshly-committed ops to dispatch them to the materializer. The records were already in hand and were thrown away.
- **Why it matters:** Performance is fine; the extra round-trip is small. But the pattern is inconsistent with `import_markdown_inner` (`pages.rs:259-271`) which collects records into a `Vec` and dispatches after commit.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Change `create_page_in_space_inner`'s return type to `Result<(BlockId, Vec<OpRecord>), AppError>`, drop `dispatch_background_for_page_create`, and dispatch records directly from the wrapper.
- **Pass-1 source:** 04/F25
- **Status:** Open

### L-36 — `purge_all_deleted_inner` synchronously deletes attachment files on the command thread
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/blocks/crud.rs:976-1063`
- **What:** After committing the purge transaction, the loop calls `std::fs::remove_file` for each purged attachment serially on the command's await thread. The DB transaction is already released, but the IPC reply is held until every file is gone.
- **Why it matters:** Empty Trash on a vault with many large attachments stalls the UI even though the FS work is best-effort by design (errors are logged and not propagated).
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Move the file-deletion loop into `tokio::task::spawn_blocking` (or a background materializer task) so the IPC returns as soon as the rows are purged; keep the existing per-file warning logs.
- **Pass-1 source:** 04/F28
- **Status:** Open

### L-37 — `MAX_BLOCK_DEPTH` enforced in `move_block_inner` but not in `create_block_in_tx`
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/blocks/crud.rs:37-172` (create), vs `src-tauri/src/commands/blocks/move_ops.rs:140-144` (enforcement)
- **What:** `move_block_inner` rejects moves that push the subtree past `MAX_BLOCK_DEPTH = 20`, but `create_block_in_tx` performs only a `SELECT ... WHERE id = ?` parent existence check — no depth count. A user can therefore reach depth >20 by repeatedly creating blocks under the deepest leaf. ARCHITECTURE.md §20 documents the limit as 20 for `create_block`, so the contract is not enforced.
- **Why it matters:** `depth < 100` on recursive CTEs catches catastrophic cases, but `MAX_BLOCK_DEPTH` is the user-visible limit; the asymmetry is a real loophole that lets the tree drift past the intended bound through the create path.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** After resolving `parent_id` in `create_block_in_tx`, count parent depth via the same `path` recursive CTE used in `move_block_inner` (already filters `is_conflict = 0` and bounds at `depth < 100`) and reject when `parent_depth + 1 > MAX_BLOCK_DEPTH`. Add a regression test creating 21 nested blocks and asserting the 21st errors.
- **Pass-1 source:** 04/F30
- **Status:** Open

### L-38 — `set_priority` Tauri wrapper does not emit `EVENT_PROPERTY_CHANGED`
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/properties.rs:668-682`
- **What:** All other property-mutating Tauri commands (`set_property`, `set_todo_state`, `set_due_date`, `set_scheduled_date`, `delete_property`) emit `EVENT_PROPERTY_CHANGED` after the inner call succeeds. `set_priority` does not even take an `app: tauri::AppHandle` parameter, so the frontend property-change listener never fires for priority changes.
- **Why it matters:** User-visible inconsistency — priority updates leave the UI stale until something else forces a refetch. Almost certainly a copy-paste oversight when the event mechanism was added.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Add `app: tauri::AppHandle` to the `set_priority` wrapper and emit `EVENT_PROPERTY_CHANGED` with `changed_keys: vec!["priority".into()]`, mirroring `set_todo_state` / `set_due_date` exactly. Consider doing this together with L-33 so the new emit uses the logged-on-error pattern.
- **Pass-1 source:** 04/F32
- **Status:** Open

### L-39 — `compute_edit_diff_inner` propagates `serde_json::from_str` errors via `?` (opaque message)
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/history.rs:662-694`
- **What:** The function fetches an op row, checks `op_type == "edit_block"`, and `serde_json::from_str::<EditBlockPayload>`s the payload. A corrupt row whose payload doesn't match the type collapses through `sanitize_internal_error` to a generic "internal error", losing `(device_id, seq)` and the parser message.
- **Why it matters:** Diagnostic. The op log is supposed to be append-only and immutable, so this is mostly defensive — but on a corruption-recovery path, knowing which row failed to parse is essential.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Replace `?` with `.map_err(|e| AppError::InvalidOperation(format!("op ({device_id}, {seq}) payload not parseable as EditBlockPayload: {e}")))` so the underlying row is identified before sanitisation.
- **Pass-1 source:** 04/F34
- **Status:** Open

### Commands System

### L-40 — `extract_recent_errors` substring match `" ERROR " || " WARN "` is fragile
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/bug_report.rs:70-82` (function), `src-tauri/src/commands/bug_report.rs:72-76` (substring check)
- **What:** Level detection is `line.contains(" ERROR ") || line.contains(" WARN ")`. This produces false positives on INFO/DEBUG lines whose body happens to contain those substrings (e.g. an info log printing a serialized error message, or block content with the word "WARN"). It also becomes brittle if the tracing-appender format ever stops emitting exactly `" LEVEL "` (e.g. a switch to a JSON layer).
- **Why it matters:** The bug-report dialog's "recent errors" preview is either noisy with false positives today or, if the format changes, silently empty.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Pin level detection to the actual tracing format used in `lib.rs:347-349`. Either parse the prefix (`YYYY-MM-DD ... LEVEL [target]`) or install a custom `tracing_subscriber::fmt::format::Layer` that emits a fixed field (`level=ERROR`, `level=WARN`) the bug-report path can match unambiguously.
- **Pass-1 source:** 05/F7
- **Status:** Open

### L-41 — `home_dir_string()` only checks `$HOME`, silently no-ops on Windows
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/bug_report.rs:248-250`
- **What:** Home-path redaction hinges on `std::env::var("HOME").ok()`. Windows does not export `HOME` by default — `USERPROFILE` is the canonical variable. On Windows the function returns `None`, the redaction silently passes through `None`, and the user's full `C:\Users\<name>\…` paths land in the exported log ZIP destined for GitHub.
- **Why it matters:** Cross-platform privacy regression on the user-export path. The user's Windows username is exposed in every path-bearing log line — this is a real cross-trust-boundary leak (the bug-report ZIP is designed to be uploaded to a public GitHub issue).
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium (closes a leak on Windows; no effect elsewhere)
- **Recommendation:** Replace the body with `dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).filter(|s| !s.is_empty())` (`dirs` is already a transitive dep via Tauri), or `cfg(windows)` to fall back to `USERPROFILE`. Add a Windows-gated unit test.
- **Pass-1 source:** 05/F8
- **Status:** Open

### L-43 — Compaction wrapper tx is misleading; the comment is factually wrong
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/compaction.rs:118-145`
- **What:** The block comment claims: *"Wrap in BEGIN IMMEDIATE for atomicity (the existing compact_op_log lacks explicit transaction wrapping — see REVIEW-LATER)."* This was true historically but `snapshot::compact_op_log` (`snapshot/create.rs:243-295`) now wraps its own write phase in `BEGIN IMMEDIATE`. The wrapper's tx therefore adds nothing for atomicity — it is used purely as a TOCTOU recount, then committed and discarded. That recount is precisely the `eligible_in_tx` value driving L-42's stale reporting.
- **Why it matters:** Future maintainers read the comment and assume the wrapper is providing atomicity; they will not realize the inner function already owns its own write tx and that the wrapper's tx is decorative.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Combine with L-42: drop the wrapper tx entirely, propagate the real `deleted_count` from `compact_op_log`, leave only the `begin_immediate_logged` slow-acquire telemetry warning, and rewrite the comment to describe what the wrapper actually does.
- **Pass-1 source:** 05/F10 (downgraded Medium→Low)
- **Status:** Open

### L-44 — `get_gcal_status_inner` lets keyring transient errors break the Settings tab
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/gcal.rs:106-141`, `src-tauri/src/commands/gcal.rs:111` (offending `?`)
- **What:** `connected = token_store.load().await?.is_some()` propagates a keyring error to the caller, which surfaces as a toast and an empty Settings tab. The natural mapping for a user-visible status query is "if the keyring is unavailable, show `connected = false` and let the user re-auth" — not "fail the whole status read".
- **Why it matters:** The user opens Settings → Google Calendar to *fix* a connectivity issue and is shown nothing.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Match on the load result and degrade `connected` to `false` (with a `tracing::warn!`) on `KeyringBackendError::PlatformUnavailable`. Optionally include a `keyring_unavailable: bool` in `GcalStatus` so the FE can render a banner.
- **Pass-1 source:** 05/F14
- **Status:** Open

### L-45 — `GcalStatus.enabled` and `GcalStatus.connected` are duplicate fields
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/gcal.rs:130-132`, `src-tauri/src/commands/gcal.rs:111` (single source value)
- **What:** Both fields are populated from the same expression: `connected = token_store.load().await?.is_some()`, then `GcalStatus { enabled: connected, connected, … }`. Two type-level fields for the same concept invite drift — a future refactor could update one and forget the other.
- **Why it matters:** Pure tech-debt cleanup; small but real risk of FE/BE divergence on a future change.
- **Cost:** S
- **Risk:** Low (FE bindings regen, possibly small UI change)
- **Impact:** Low
- **Recommendation:** Drop `enabled` from `GcalStatus` if the FE consumes `connected`, or vice versa; verify which the FE actually reads and remove the unused one.
- **Pass-1 source:** 05/F15
- **Status:** Open

### L-46 — MCP toggle is racy: marker write + `is_running()` + `spawn` are non-atomic
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/mcp.rs:212-244` (`mcp_set_enabled` wrapper), `src-tauri/src/commands/mcp.rs:336-399` (RW twin), `src-tauri/src/commands/mcp.rs:106-155` (inner)
- **What:** The wrapper sequence is: (1) `mcp_set_enabled_inner` writes/removes the marker, (2) reads `lc.is_running()`, (3) `spawn_mcp_ro_task`. Between (2) and (3) a concurrent disable can remove the marker; the spawn proceeds anyway (the inner re-checks the marker, so this is benign). More problematic: if the previous serve loop is mid-shutdown, its `task_running.store(false)` happens *after* `serve()` returns but the listener may still hold the socket file. A new spawn in the gap hits "already bound" and logs a warn, leaving `task_running` accurate but the intended re-spawn never happens.
- **Why it matters:** Under rapid toggling (UI bug, double-click, power-user flicking the switch), the user can land in an "enabled but not bound" stall that survives until restart. The MCP surface is the user's own data exposed to local agents — within the threat model this is correctness, not security.
- **Cost:** S
- **Risk:** Low — needs a real lifecycle state machine or a `tokio::sync::Mutex` held by the command for its duration.
- **Impact:** Low (rare path; symptom is "Settings says on, server isn't bound" until restart)
- **Recommendation:** Track `LifecycleState` as an enum (`Stopped | Starting | Running | Stopping`) in `McpLifecycle`, set by the spawn function. `mcp_set_enabled(true)` waits for `Stopped` before calling `spawn`. Alternatively, serialize all enable/disable calls through a `tokio::sync::Mutex` held by the command for its full duration. Lower priority pending H-2 fix; the residual race window is benign once the listener actually drops on disable.
- **Pass-1 source:** 05/F22 (downgraded Medium→Low)
- **Status:** Open

### L-47 — MCP RO and RW marker logic is duplicated; helpers exist to consolidate
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/mcp.rs:106-155` (RO `mcp_set_enabled_inner`) vs `src-tauri/src/commands/mcp.rs:294-334` (RW twin); also `get_mcp_status_inner` / `get_mcp_rw_status_inner`, `mcp_disconnect_all_inner` / `mcp_rw_disconnect_all_inner`, and the path-resolver pair
- **What:** The two `*_set_enabled_inner` functions are byte-identical except for the marker constant (`MCP_RO_ENABLED_MARKER` vs `MCP_RW_ENABLED_MARKER`) and log strings. The same is true for the status, disconnect, and path-resolver pairs. Any future change (e.g. closing the listener for the F21 fix) must remember to apply both.
- **Why it matters:** The RW surface is the more dangerous one (write tools); any RO/RW divergence carries asymmetric blast radius.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Parameterize once: `mcp_set_enabled_inner(path, lifecycle, marker_const, log_target, enabled)`, with thin RO/RW wrappers passing the marker; same for `get_*_status_inner` and `*_disconnect_all_inner`. Existing `rw_and_ro_markers_are_independent` test already proves parity.
- **Pass-1 source:** 05/F23
- **Status:** Open

### L-48 — Sanitization drift: ARCHITECTURE.md §15 mandates it; five command files skip it
- **Domain:** Commands (System)
- **Location:** ARCHITECTURE.md:1259-1263 (invariant) vs `src-tauri/src/commands/{bug_report,gcal,link_metadata,logging,mcp}.rs`. Helper at `src-tauri/src/commands/mod.rs:756-769`.
- **What:** §15 mandates: *"Database, IO, and JSON errors are replaced with generic 'internal error' messages before reaching the frontend."* The implementation is `sanitize_internal_error` in `commands/mod.rs:756-769`. 16 command files use it; these five skip it: `bug_report.rs` (e.g. lines 139-148, 314-328 — paths leak in `AppError::Io`), `gcal.rs` (every wrapper at lines 270-328), `link_metadata.rs` (lines 50-68), `logging.rs` (both wrappers), `mcp.rs` (every wrapper at lines 170-244, 336-399).
- **Why it matters:** Within the threat model this is not "exfiltration to attacker" — the helper's own docstring says it is UX-only. But it is still a stated-invariant violation: the doc claims the helper is "applied to every Tauri command wrapper" and the implementation is partial. Toasts surface raw `sqlx::Error` strings and OS paths inconsistently across the app.
- **Cost:** S — mechanical addition of `.map_err(sanitize_internal_error)` to ~12 wrappers.
- **Risk:** Low — a few tests that match raw error messages may need updates.
- **Impact:** Low (UX consistency)
- **Recommendation:** Add `.map_err(sanitize_internal_error)` to every Tauri command wrapper in the five files. Optionally add a CI golden-test (e.g. `cargo expand` + regex) asserting every `__cmd__*` calls the sanitizer.
- **Pass-1 source:** 05/F26 (downgraded High→Low — UX consistency, not security)
- **Status:** Open

### L-49 — `set_gcal_window_days_inner` has unreachable fallback noise
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/gcal.rs:231-244`
- **What:** The clamp `i64::from(n).clamp(MIN, MAX)` always produces a value in `[7, 90]`, which always fits in `i32`. The `try_from` therefore cannot fail and the `.unwrap_or_else(... DEFAULT_WINDOW_DAYS)` branch is dead. The comment at lines 237-240 admits this. Extra code, extra cognitive load.
- **Why it matters:** Pure cleanup — readers must reason about a fallback that cannot be reached.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Replace with `let clamped: i32 = i64::from(n).clamp(MIN_WINDOW_DAYS, MAX_WINDOW_DAYS).try_into().expect("clamped to [7,90] always fits i32");`.
- **Pass-1 source:** 05/F28
- **Status:** Open

### L-50 — `update_peer_name` and `set_peer_address` Tauri wrappers lack `cfg(not(tarpaulin_include))`
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/sync_cmds.rs:243-253` (`update_peer_name`), `src-tauri/src/commands/sync_cmds.rs:256-266` (`set_peer_address`)
- **What:** Every other Tauri wrapper in this file (and most other command files) carries `#[cfg(not(tarpaulin_include))]` to keep state-resolving boilerplate out of coverage measurements. These two are missing the attribute, so they show up at 0% coverage as a false negative.
- **Why it matters:** Coverage hygiene. AGENTS.md notes Tarpaulin runs only on coverage-gap work, but inconsistent annotations make those reports noisy when it does run.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add `#[cfg(not(tarpaulin_include))]` to both wrappers, immediately above `#[tauri::command]`.
- **Pass-1 source:** 05/F29
- **Status:** Open

### L-51 — `mcp_disconnect_all` doc says it returns "the connection count" but signature returns `()`
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/mcp.rs:191-205`
- **What:** Lines 192-196 of the doc-comment promise *"Returns the connection count observed immediately after firing the signal."* The signature is `Result<(), AppError>` and the body is `Ok(())`. There is no count surfaced.
- **Why it matters:** Doc drift; maintainers reading the comment will believe the count is exposed and may try to wire UI to it.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either (a) actually return `lifecycle.connection_count() as u32`, regenerate bindings, and let the Settings tab show "kicked N agents", or (b) update the doc to match `Ok(())`. Option (a) is more useful but requires a binding regen.
- **Pass-1 source:** 05/F30
- **Status:** Open

### L-52 — `read_logs_for_report_inner` skips silently on per-file errors
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/bug_report.rs:268-287`
- **What:** Three `let Some(...) else { continue; }` / `let Ok(...) else { continue; }` patterns silently drop entries: invalid UTF-8 names (line 273-275), entries that are not files (line 280-282), and files whose `read_capped_file` fails (line 283-285). The function returns `Ok(out)` with whatever survived; no signal that anything was filtered.
- **Why it matters:** A bug report missing relevant log files is worse than a noisy one. A permission-denied read is exactly the situation the bug report should *include*.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add `tracing::warn!` at each silent-drop site (with anonymized name), and optionally synthesize a `LogFileEntry` named `[skipped] <reason>` so the user sees in the preview that something was excluded.
- **Pass-1 source:** 05/F31
- **Status:** Open

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

### L-54 — `redact_log` preserves cap on bytes but does not bound total file output
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/commands/bug_report.rs:229-242` (per-line cap), `src-tauri/src/commands/bug_report.rs:292-309` (no bundle cap)
- **What:** Per-line redaction is bounded by `MAX_LINE_BYTES = 8 KB` and per-file read is capped at `MAX_FILE_BYTES = 2 MB`, so net per-file output is ~2 MB plus markers. But the total ZIP size is `len(included files) * 2 MB`, i.e. up to ~16 MB for an 8-day window. There is no global cap on the exported bundle.
- **Why it matters:** A user with weeks of high-volume logs gets a ZIP they may not be able to attach to a GitHub issue (10 MB default upload limit). The fail-mode is graceful (FE writes the ZIP locally), but worth bounding on the export path.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add `MAX_BUNDLE_BYTES` (~10 MB) enforced inside the `for (path, contents) in entries` loop in `read_logs_for_report_inner`; when exceeded, drop the oldest files first and synthesize a `[skipped older logs]` entry.
- **Pass-1 source:** 05/F34
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

### L-56 — `peer_locks` HashMap grows unboundedly
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_scheduler.rs:83-102` (`try_lock_peer`)
- **What:** `or_insert_with(|| Arc::new(Mutex::new(())))` runs on every `try_lock_peer` call; entries are never removed (project-wide grep: `peer_locks` is only ever written here).
- **Why it matters:** At realistic single-user single-digit paired-peer count this is dust. Maintainability red flag in a long-lived background service — bounded growth is the right invariant for an unbounded uptime.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Periodically GC entries whose `Arc::strong_count == 1` (no outstanding guard) and that aren't in `peer_refs`. Hourly purge timer is sufficient — no need for a full eviction strategy.
- **Pass-1 source:** 06/F23
- **Status:** Open

### L-57 — `record_failure`'s deterministic doubling vs jittered `next_retry_at`
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_scheduler.rs:122-139`
- **What:** `state.backoff = base` stores the deterministic doubled base; `next_retry_at = now + base * jitter` where `jitter ∈ [0.9, 1.1]`. Behaviour is correct in spirit and the inline comment names the intent, but the doc string ("Doubles backoff: 1s → 2s → ... → 60s max") describes the wall-clock view, not the state view.
- **Why it matters:** Documentation drift only. Pass-2 explicitly downgraded this from a behaviour bug to a docstring tightening.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Tighten the doc string to "approximately doubles, with ±10% jitter applied to the wall-clock retry time; the underlying base is doubled deterministically". Accept current behaviour.
- **Pass-1 source:** 06/F24
- **Status:** Open

### L-58 — First `record_failure` jumps directly to ~2 s (sequence 2,4,8,…)
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_scheduler.rs:127-138`
- **What:** Fresh `BackoffState` is inserted with `backoff: MIN_BACKOFF /* = 1s */`, then immediately doubled to 2 s before `next_retry_at` is set. The internal test `backoff_doubles_on_consecutive_failures` (line 309-319) asserts `state.backoff == 8s` after 3 failures, confirming the 2,4,8 sequence — not the 1,2,4 sequence the constants imply.
- **Why it matters:** Documentation drift — readers of `MIN_BACKOFF = 1s` and `record_failure_blocks_immediate_retry` reasonably infer a 1 s first retry.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either (a) initialise `backoff: MIN_BACKOFF / 2` so the first doubling yields 1 s, or (b) update `MIN_BACKOFF` and the doc/comments to declare the actual sequence (2,4,8,16,32,60). Either is fine; pick the one that aligns with telemetry expectations.
- **Pass-1 source:** 06/F25
- **Status:** Open

### L-59 — `pairing_qr_payload` has no version field
- **Domain:** Sync
- **Location:** `src-tauri/src/pairing.rs:120-133`
- **What:** The QR JSON shape is exactly `{passphrase, host, port}`. Adding a new field later (e.g., a TOFU-baked-in cert hash) cannot be distinguished from a stale QR by the joiner.
- **Why it matters:** Forward-compat. Old QRs will silently degrade rather than reject cleanly.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add `"v": 1` to the JSON payload now, before any future field additions. Joiner validates the version explicitly and fails fast on unknown versions. Wire-format addition; bundle with any other QR-shape changes that need user approval.
- **Pass-1 source:** 06/F27
- **Status:** Open

### L-60 — `build_salt` concatenates IDs without a delimiter
- **Domain:** Sync
- **Location:** `src-tauri/src/pairing.rs:189-196`
- **What:** `salt.extend_from_slice(ids[0].as_bytes()); salt.extend_from_slice(ids[1].as_bytes());` — no separator between the two IDs. ULIDs are fixed-length 26 chars so no ambiguity today, but the invariant is implicit.
- **Why it matters:** Fragile invariant — any future change to device-ID format (variable-length labels) would silently collide on `("AB","CD")` vs `("ABC","D")`.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Insert a single-byte separator that cannot appear in a Crockford ULID, e.g. `\x00`, between the two IDs. Document the format in a comment.
- **Pass-1 source:** 06/F28
- **Status:** Open

### L-61 — `daemon_loop` Branch B processes peers sequentially
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_daemon/orchestrator.rs:196-218`
- **What:** `for peer_ref in &refs { ... try_sync_with_peer(...).await; }` — each peer's sync is awaited before the next is tried. A peer at the far end of a flaky WiFi link can hold up the entire round up to its protocol timeout (30 s recv + 120 s handle_message bounds it).
- **Why it matters:** With 3+ paired devices a single misbehaving peer delays every other peer's catch-up of fresh local edits. At single-user 2-3-device scale the impact is bounded, but it's a real UX regression on multi-laptop setups.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** `tokio::spawn` each `try_sync_with_peer` call and await a `JoinSet`. The per-peer mutex (`try_lock_peer`) already prevents two simultaneous sessions to the same peer.
- **Pass-1 source:** 06/F29
- **Status:** Open

### L-62 — `try_sync_with_peer` always uses `peer.addresses.first()`
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_daemon/discovery.rs:125-129` (`format_peer_address`)
- **What:** `peer.addresses.first()` is consumed for the first address only. mDNS may list IPv6 link-local before IPv4 (or vice versa) depending on the responder's announcement; if the local network only routes one family, connect fails and the peer goes into backoff despite a working address sitting in `addresses[1..]`.
- **Why it matters:** Spurious 60 s+ backoffs on dual-stacked LANs. Common on home networks with router-IPv6 enabled.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Iterate `peer.addresses` in order (IPv4 first, then IPv6 link-local; or any deterministic policy) and report the combined error if all fail.
- **Pass-1 source:** 06/F30
- **Status:** Open

### L-63 — mDNS `ServiceRemoved` events are ignored
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_net/websocket.rs:124-142` (`parse_service_event`); stale eviction at `src-tauri/src/sync_daemon/orchestrator.rs:233-234`
- **What:** `parse_service_event` matches only `ServiceResolved`; all other variants return `None`. When mDNS announces removal of a peer, the `discovered` HashMap retains the entry until the 5-minute stale-eviction sweep.
- **Why it matters:** A peer that came online, paired, then went offline still appears in `discovered` for up to 5 minutes — `try_sync_with_peer` keeps trying its now-stale address.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add a `ServiceRemoved` arm to `parse_service_event` that returns the device_id to remove; thread the removal through `process_discovery_event` and drop the entry from `discovered`.
- **Pass-1 source:** 06/F31
- **Status:** Open

### L-64 — `RECV_TIMEOUT` 30 s vs `handle_message` 120 s mismatch
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_net/connection.rs:199` (`RECV_TIMEOUT = 30s`); outer budget at `src-tauri/src/sync_daemon/orchestrator.rs:530` and `src-tauri/src/sync_daemon/server.rs:221`
- **What:** `RECV_TIMEOUT = 30s` wraps a single `ws.next()` future via `recv_message:224-237`. The outer `tokio::time::timeout(Duration::from_secs(120), orch.handle_message(incoming))` has a 120 s budget. A 10 MB op-batch on a 1 Mbps link takes ~80 s of wall-clock — well past the inner 30 s recv timeout, so the outer slack never gets to exercise.
- **Why it matters:** Large initial sync over slow LAN (congested WiFi) fails spuriously even though the protocol budget is 120 s.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either raise `RECV_TIMEOUT` to align with the 120 s outer budget, or replace it with an idle-timer that resets between WebSocket *frames* rather than between messages.
- **Pass-1 source:** 06/F32
- **Status:** Open

### L-65 — mDNS `enable_addr_auto()` announces on every interface
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_net/websocket.rs:43-66` (`announce`)
- **What:** `service_info = …enable_addr_auto();` lets `mdns-sd` enumerate every routable interface for announcements. On a multi-homed device (laptop docked at home + tethered to phone hotspot + on a guest WiFi) the announcement leaks the device IP to networks the user might not intend.
- **Why it matters:** Not an "adversary" issue — but the user may not want their phone advertising on every coffee shop's network. UX/privacy choice, not hardening.
- **Cost:** M (interface filtering policy is OS-specific)
- **Risk:** Medium
- **Impact:** Low
- **Recommendation:** Defer to user approval — this is a UX choice. Possible directions: (a) restrict to `IFF_PRIVATE`-flagged interfaces, (b) expose a setting "announce on this network only", (c) accept current behaviour and document it. Do not change without user input.
- **Pass-1 source:** 06/F37
- **Status:** Open

### L-66 — `try_receive_snapshot_catchup` skips `peer_refs` bookkeeping when `remote_device_id.is_empty()`
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_daemon/snapshot_transfer.rs:340-353`
- **What:** The peer-refs upsert is gated on `if !remote_device_id.is_empty()`. Empty values arrive when the orchestrator could not infer the remote ID from `HeadExchange` (e.g., responder had only our heads in the list). The snapshot is still applied to the DB, but no peer ref is created — the next sync treats the peer as fully unknown again. Contrast with the SyncComplete fallback at `sync_protocol/orchestrator.rs:368-397` that backfills from `expected_remote_id`.
- **Why it matters:** Subtle inconsistency between "applied snapshot" and "remembered the sync" — same accidental-divergence family the threat model targets.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Mirror the SyncComplete fallback: if `remote_device_id` is empty, use the orchestrator's `expected_remote_id` (passed in by the caller); if neither is available, return `Err` so the caller records a failure instead of silently completing.
- **Pass-1 source:** 06/F39
- **Status:** Open

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

### L-68 — `apply_remote_ops` enqueues a single `BatchApplyOps` task regardless of size
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_protocol/operations.rs:152-160`
- **What:** The whole batch is enqueued as one `MaterializeTask::BatchApplyOps(to_materialize)` regardless of size. The materializer's 256-task foreground cap is never the bottleneck here, but the single-task design means independent sub-groups by `block_id` cannot be parallelised across the materializer's `JoinSet`.
- **Why it matters:** Bulk sync apply is serialised on a single materializer worker; doesn't blow up but doesn't scale to 5,000-op initial syncs either.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Group `to_materialize` by `block_id` before enqueuing so the materializer's `JoinSet` parallelises independent groups. Be mindful of cross-group ordering invariants for parent-id moves.
- **Pass-1 source:** 06/F43
- **Status:** Open

### L-69 — `compute_ops_to_send` does not deterministically order ops across devices
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_protocol/operations.rs:33-56`; head ordering at `:17-23`
- **What:** Outer loop iterates `local_heads`, which `get_local_heads` returns `ORDER BY device_id` (lexicographic). Within a device, ops are seq-ordered. So device-A's ops always precede device-B's lexicographically — meaning a device-A op that references a block created by device-B may arrive *before* device-B's create-op if A's device_id sorts first.
- **Why it matters:** The op log has no FK; the materialiser handles `INSERT OR IGNORE` / row-not-found gracefully, and most ops are commutative / idempotent. Still, order-tolerance is implicit, not documented; certain op pairings (move-before-create) leave temporarily inconsistent materialised state until the create arrives.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Low (most ops are order-resilient)
- **Recommendation:** Either sort the combined op list by `created_at` before sending (caveat: clock-skew between devices), or document explicitly that the op log is order-tolerant and the materialiser must absorb out-of-order arrivals. The latter is closer to current behaviour.
- **Pass-1 source:** 06/F44
- **Status:** Open

### L-70 — `pending_ops_to_send` kept alive for the entire session
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_protocol/orchestrator.rs:24-25, 245, 398-402`
- **What:** Initiator buffers every outgoing `OpRecord` in `pending_ops_to_send` *and* in `pending_op_transfers` (as `OpTransfer`s). Only `pending_ops_to_send.last()` is read at session end for the `last_sent_hash`. With a 5,000-op initial sync this doubles peak memory.
- **Why it matters:** Memory pressure on bulk first-time sync — same family as M-51 / L-67 but on the op-log side.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Replace `pending_ops_to_send: Vec<OpRecord>` with `last_sent_hash: Option<String>` (capture the hash from the last batch as it streams). The full `Vec<OpTransfer>` is still needed in `pending_op_transfers` for retry/ack purposes, but the duplicate buffer can go.
- **Pass-1 source:** 06/F45
- **Status:** Open

### L-71 — `SyncOrchestrator` (responder) does not enforce `expected_remote_id`
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_daemon/server.rs:83-84` (orchestrator construction); cert CN check at `:149-200`; `peer_refs::get_peer_ref` lookup at `:109-120`; orchestrator-internal mismatch path at `src-tauri/src/sync_protocol/orchestrator.rs:207-222`
- **What:** Initiator wires `with_expected_remote_id(peer_id)`; responder calls `SyncOrchestrator::new(...).with_event_sink(...)` only. The responder's two gates are the cert CN check + the `peer_refs::get_peer_ref` "is this peer paired" lookup; the orchestrator's internal `expected_remote_id` mismatch path therefore never fires on the responder side.
- **Why it matters:** Defense-in-depth for "the responder's orchestrator inferred a different device_id than the cert claims" — currently a silent disagreement. Not adversarial; software-bug consistency.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Pass the cert CN through into the responder-side `SyncOrchestrator::with_expected_remote_id(...)` so the head-exchange parser asserts consistency between what the cert says and what HeadExchange identifies.
- **Pass-1 source:** 06/F46
- **Status:** Open

### L-72 — Test gap: no chaos / partial-transfer recovery test for `sync_files`
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_files.rs:581-1908` (test module)
- **What:** Coverage today: happy path (in-mem and TLS), hash mismatch, large-file chunking, empty transfer. Missing: a test that injects a connection drop *between* binary frames mid-file, asserting (a) the receiver returns `Err`, (b) no half-written file is visible on disk, (c) the attachment row still appears in `find_missing_attachments` so the next sync re-tries.
- **Why it matters:** The recovery path is the most interesting one for accidental corruption (single-user, not adversarial), and it is currently untested. Pairs naturally with M-48.
- **Cost:** M
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Add `mid_transfer_disconnection_does_not_leave_partial_file` using `test_connection_pair` with a manually closed `client_conn` after the first chunk; assert the post-failure invariants above.
- **Pass-1 source:** 06/F47
- **Status:** Open

### L-73 — Test gap: no fork-detection test (same `device_id+seq`, different hash)
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_protocol/tests.rs`; `src-tauri/src/sync_integration_tests.rs`; `src-tauri/src/dag.rs`
- **What:** Project-wide grep for `fork`, `same_seq`, `divergent_hash` returns zero hits. The closest test (`sync_integration_tests.rs:260` "Both sides should now detect divergent edit heads") is testing edit-chain divergence on the *same* seq — different scenario. Today `apply_remote_ops` silently drops fork ops via `INSERT OR IGNORE` (the H-tier follow-up); a test would either lock in current behaviour or motivate the H-14 fix.
- **Why it matters:** Fork-by-accident (DB rollback, restored backup) is a likely real-world failure mode for the threat model and the system's response is documented nowhere.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium (lights the path for the H-14 lever)
- **Recommendation:** Add `apply_remote_ops_silently_drops_fork_op_with_same_pk` that inserts `(DEV_A, 1)` first, then applies a *different* op also `(DEV_A, 1)` and asserts (a) only one row in `op_log`, (b) `result.duplicates == 1`, (c) — once the H-14 fix lands — a surfaced fork indication.
- **Pass-1 source:** 06/F48
- **Status:** Open

### L-74 — Test gap: snapshot transfer cancellation / interruption
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_daemon/snapshot_transfer.rs` (test module, e.g. line 705 area)
- **What:** Tests cover oversized offer, corrupted bytes, peer Error, unexpected message, no-snapshot. Missing: (a) connection drop mid-binary-frame during snapshot receive, and (b) user cancellation during snapshot apply. With L-67 in mind, the latter would catch whether `apply_snapshot`'s tx rollback actually leaves the DB in a consistent state when interrupted.
- **Why it matters:** Snapshot apply is the most destructive sync path (wipes and rebuilds core tables); failure modes deserve explicit tests.
- **Cost:** M
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Add a test that drops the test connection mid-binary-frame during snapshot receive and asserts (a) `try_receive_snapshot_catchup` returns `Err`, (b) DB rolls back to its pre-snapshot state (no half-applied rows).
- **Pass-1 source:** 06/F50
- **Status:** Open

### L-75 — Test gap: dormant-waiter race
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_daemon/mod.rs:228-298` (dormant waiter); `src-tauri/src/sync_daemon/tests.rs:2789-3000`
- **What:** `dormant_daemon_wakes_on_pair_notification` and `peers_appeared_*` exist, but none exercise the specific interleaving where `notify_change` fires *between* `scheduler.notified()` consumption and the next `select!` iteration, racing with an immediate shutdown.
- **Why it matters:** Pair-then-immediate-shutdown timing bugs would be invisible until they bite a user mid-pair.
- **Cost:** M
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add a test that races `confirm_pairing` with an immediate daemon `shutdown()` and asserts the daemon either (a) processed the pair before shutdown, or (b) cleanly exited with the pair preserved in `peer_refs`.
- **Pass-1 source:** 06/F51
- **Status:** Open

### L-76 — `peer_tuples` Vec built from `synced_at` strings every 30 s
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_daemon/orchestrator.rs:237-241`
- **What:** Every 30 s tick of Branch C, the daemon does `let peer_tuples: Vec<(String, Option<String>)> = refs.iter().map(|p| (p.peer_id.clone(), p.synced_at.clone())).collect();` — a full clone of every paired peer's ID and timestamp.
- **Why it matters:** At realistic single-user 2-10 paired peers this is a no-op. Note for completeness; not a real concern at this scale.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Pass `&[PeerRef]` directly into `peers_due_for_resync` instead of cloning into tuples. Cosmetic; deprioritise unless the 30 s tick is being touched anyway.
- **Pass-1 source:** 06/F52
- **Status:** Open

### Search & Links

### L-81 — `eval_unlinked_references` page-title query lacks `is_conflict = 0`
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/grouped.rs:284-294`
- **What:** Resolution of the target page's title filters `block_type = 'page' AND deleted_at IS NULL` only. If a caller passes a conflict-copy page id, the function returns its title and runs the unlinked-references search against a conflict copy. Sister query `resolve_root_pages` (`query.rs:226-230`) does filter `p.is_conflict = 0`.
- **Why it matters:** Defense-in-depth and contract consistency. Probably not reachable from the UI today, but the SQL contract should align across the two backlink helpers so future callers don't re-introduce the gap.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add `AND is_conflict = 0` to the title fetch.
- **Pass-1 source:** 07/F10
- **Status:** Open

### L-82 — `eval_backlink_query_grouped` IN-clause unbounded — SQLite variable-limit risk
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/grouped.rs:170-189`
- **What:** After paginating to `actual_groups`, the function flattens all blocks across those groups into `all_ids_vec` and binds them as positional placeholders in `id IN ({placeholders})`. There is no cap on blocks-per-group and no `json_each()` fallback. Modern SQLite (3.32+, sqlx-bundled) raised `SQLITE_MAX_VARIABLE_NUMBER` to 32 766, so the failure threshold is high but reachable on a mega-source page.
- **Why it matters:** Sister helpers in `sort.rs:81-107` and `:154-180` already implement the `≤500 → IN / >500 → json_each` pattern. The grouped fetch silently diverges, so a query that succeeds via the sort path can fail via the grouped path on the same dataset.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Mirror the `fetch_text_props_for_ids` pattern: switch to `json_each(?)` binding once `all_ids_vec.len() > 500`. Apply the same change to the `eval_unlinked_references` batch fetch.
- **Pass-1 source:** 07/F11
- **Status:** Open

### L-83 — `eval_backlink_query` IN-clause unbounded — same risk on a smaller scale
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/query.rs:155-168`
- **What:** Same placeholders pattern as L-82, but `actual_ids` is bounded by the user's page limit (typically 50). Realistic page sizes don't hit the SQLite variable limit; the code path is structurally identical and should converge on the same fallback policy used elsewhere in the same crate.
- **Why it matters:** Maintainability — every IN-list build site in the backlink module should look the same so future contributors can't accidentally remove the cap on the wrong helper.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Adopt the shared `≤500 → IN / >500 → json_each` helper from `sort.rs`.
- **Pass-1 source:** 07/F12
- **Status:** Open

### L-84 — `BacklinkFilter::SourcePage` IN-clauses unbounded for `included` / `excluded`
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/filters.rs:425-490`
- **What:** Both `included` (line 427) and `excluded` (lines 443, 465) placeholder lists are built directly from caller-supplied vectors, with no length cap and no `json_each()` fallback. UI typically supplies a handful of selections, but a saved-query payload could push past SQLite's variable limit.
- **Why it matters:** A request that round-trips through saved-query state can fail at filter evaluation while smaller live queries succeed — confusing failure mode.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either cap the size at request-deserialization time, or fall back to `json_each(?)` for `> 500` ids — same policy as L-82/L-83.
- **Pass-1 source:** 07/F13
- **Status:** Open

### L-85 — `tag_query::resolve_expr` And/Or sequential while `BacklinkFilter::And/Or` are concurrent
- **Domain:** Search & Links
- **Location:** `src-tauri/src/tag_query/resolve.rs:118-138`
- **What:** Tag-query boolean evaluation walks each child sequentially (`for e in iter { let set = resolve_expr(...).await?; … }`). Sister code in `backlink/filters.rs:495-523` resolves siblings concurrently via `try_join_all`, with the explicit comment "turning N serial DB round-trips into N concurrent ones". Two equivalent abstractions diverge on the same optimization.
- **Why it matters:** Tag-query commands sit on the user's input-latency path (saved-query expansion, agent search). For composite queries with 5–10 OR-ed prefixes the difference is 5–10× wall-clock RTT.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Replace the for-await loops in `And`/`Or` with `try_join_all(exprs.iter().map(|e| resolve_expr(pool, e, include_inherited)))`, mirroring `BacklinkFilter`. Verify the existing intersection/union semantics still hold once results return out of order.
- **Pass-1 source:** 07/F14
- **Status:** Open

### L-86 — `update_last_address` silently succeeds when peer doesn't exist
- **Domain:** Search & Links
- **Location:** `src-tauri/src/peer_refs.rs:196-207`
- **What:** `update_last_address` returns `Ok(())` regardless of whether the row exists. Sibling helpers `update_on_sync` (`:131-133`), `increment_reset_count` (`:151-153`), `delete_peer_ref` (`:165-167`), and `update_device_name` (`:186-188`) all check `rows_affected == 0` and return `AppError::NotFound`.
- **Why it matters:** If the peer was just deleted (race with `delete_peer_ref`), the address update silently no-ops and the caller assumes the cache is up to date. Inconsistent contract across sibling helpers makes call-site error handling unreliable.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Match the sibling helpers — return `AppError::NotFound(format!("peer_refs ({peer_id})"))` when `rows_affected() == 0`. Alternatively document explicitly that this is a fire-and-forget update.
- **Pass-1 source:** 07/F17
- **Status:** Open

### L-87 — `update_last_address` uses raw `sqlx::query` instead of `query!` macro
- **Domain:** Search & Links
- **Location:** `src-tauri/src/peer_refs.rs:201-205`
- **What:** Every other write helper in the file uses compile-time-checked `sqlx::query!`. `update_last_address` is the lone outlier using runtime `sqlx::query`, bypassing the `.sqlx/` cache.
- **Why it matters:** Violates AGENTS.md invariant #6 ("sqlx compile-time queries"). Schema drift on `peer_refs.last_address` would surface at runtime instead of at compile time.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Switch to `sqlx::query!(...)` and re-run `cargo sqlx prepare` to refresh `.sqlx/`.
- **Pass-1 source:** 07/F18
- **Status:** Open

### L-88 — Doc comment says "INSERT OR REPLACE"; code uses `ON CONFLICT … DO UPDATE`
- **Domain:** Search & Links
- **Location:** `src-tauri/src/peer_refs.rs:88, 95-97`
- **What:** The doc comment on `upsert_peer_ref_with_cert` says "Uses `INSERT OR REPLACE` so an existing peer's cert_hash is updated", but the SQL is `INSERT … ON CONFLICT(peer_id) DO UPDATE SET cert_hash = excluded.cert_hash`. The two constructs differ: `INSERT OR REPLACE` would rewrite ALL columns (zeroing `last_hash`, `synced_at`, `reset_count`, etc.); `ON CONFLICT … DO UPDATE` only touches `cert_hash`. The actual code is correct (as proved by `tests.rs:522-561` `upsert_with_cert_preserves_existing_sync_state`); the doc is wrong.
- **Why it matters:** Future contributors reading the doc comment may "fix" the SQL to match it and silently zero peer sync state during pairing.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Replace "INSERT OR REPLACE" with "ON CONFLICT(peer_id) DO UPDATE" in the doc comment, and explicitly state that `last_hash`/`synced_at`/`reset_count` are preserved across re-pairing.
- **Pass-1 source:** 07/F19
- **Status:** Open

### L-89 — `update_device_name` error string format inconsistent
- **Domain:** Search & Links
- **Location:** `src-tauri/src/peer_refs.rs:187` vs `:132, 152, 166`
- **What:** `update_device_name` returns `format!("peer_ref {peer_id}")` while `update_on_sync`, `increment_reset_count`, and `delete_peer_ref` all return `format!("peer_refs ({peer_id})")` — singular vs plural, no parentheses vs parentheses.
- **Why it matters:** Consumers that match on the error string format will diverge across helpers; tests asserting one form pass for one helper but not another.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Change `update_device_name`'s error format to `format!("peer_refs ({peer_id})")` to match siblings.
- **Pass-1 source:** 07/F20
- **Status:** Open

### L-90 — `read_body_limited` reads entire response into memory before truncating
- **Domain:** Search & Links
- **Location:** `src-tauri/src/link_metadata/mod.rs:115-126`
- **What:** `response.bytes().await?` materializes the entire body into a `Bytes` buffer regardless of `MAX_BODY_SIZE` (512 KB). The size check only runs after allocation, so a misbehaving server returning a 1 GB body OOMs the process.
- **Why it matters:** Threat model excludes malicious actors, but accidental misuse (mis-typed URL pointing at a video CDN, server-side bug returning unbounded HTML) is realistic. A single accidental fetch can crash the app.
- **Cost:** M
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Use `response.chunk()` in a loop, accumulating until `MAX_BODY_SIZE` is reached, then drop the connection. Optionally inspect `Content-Length` up front to short-circuit obviously oversized responses (the header is untrusted but a useful heuristic).
- **Pass-1 source:** 07/F21
- **Status:** Open

### L-91 — `truncate_str` truncates by bytes despite `max_chars` parameter name
- **Domain:** Search & Links
- **Location:** `src-tauri/src/link_metadata/html_parser.rs:367-378`
- **What:** Parameter is `max_chars: usize`, but the comparison `s.len() <= max_chars` operates on bytes and the `is_char_boundary` walk-back is consistent with byte indexing. CJK input (3 bytes/char in UTF-8) gets ~`max_chars / 3` characters in the output.
- **Why it matters:** A CJK page title with `parse_title`'s 500-char target gets capped at ~166 visible characters — three times more aggressive than the doc claims.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either rename the parameter to `max_bytes` and update the doc, or do char-count truncation with `s.char_indices().nth(max_chars).map(|(i, _)| &s[..i]).unwrap_or(s)`.
- **Pass-1 source:** 07/F22
- **Status:** Open

### L-92 — Tag-rename FTS reindex: unbounded `unique_ids` inside one big tx
- **Domain:** Search & Links
- **Location:** `src-tauri/src/fts/index.rs:159-242` (`reindex_fts_references`)
- **What:** Step 4 builds `unique_ids` as the union of `tag_refs` + `link_refs` + `inline_tag_refs` with no upper bound, then opens a single transaction (lines 204-240) and INSERTs each row inside that one tx. There is no chunking and no fresh-tx-per-batch policy.
- **Why it matters:** Renaming a popular tag (e.g. `#todo` referenced from 50 000+ blocks) holds a single writer transaction for the entire batch, blocking all other writers for many seconds. Partial failure rolls back the entire batch — awkward for an eventually-consistent cache.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Low/Medium
- **Recommendation:** Chunk the reindex into batches of ~1 000 ids with a fresh tx per chunk; or enqueue per-block `update_fts_for_block` materializer tasks instead of inlining the work, leveraging the materializer's dedup.
- **Pass-1 source:** 07/F23
- **Status:** Open

### L-93 — `rebuild_all_split` does N inserts in single tx with no chunking
- **Domain:** Search & Links
- **Location:** `src-tauri/src/tag_inheritance.rs:464-505`
- **What:** The split-pool variant reads the full inheritance set (lines 469-485), opens a tx on `write_pool`, deletes all rows, and INSERTs each tuple individually inside that tx. The unified `rebuild_all` (`:435-453`) uses a single recursive-CTE INSERT … SELECT — much faster — but the split variant cannot replicate that because the tuple set is materialized in Rust memory.
- **Why it matters:** The split-pool pattern was introduced to reduce writer-lock hold time (AGENTS.md "Performance Conventions / Split read/write pool pattern"). For large vaults the current split variant arguably holds the writer longer than the unified variant — defeating the point.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** (a) Chunk the INSERTs into batches of ~500 with multi-row `INSERT … VALUES (?,?,?), (?,?,?), …` and a fresh tx per chunk; or (b) write the read-side tuple set into a temp table on `write_pool` first, then `INSERT INTO block_tag_inherited SELECT … FROM temp` in a single statement.
- **Pass-1 source:** 07/F24
- **Status:** Open

### L-94 — `rebuild_all_split` race window: incremental updates between read and write are wiped
- **Domain:** Search & Links
- **Location:** `src-tauri/src/tag_inheritance.rs:464-505`
- **What:** The read phase runs against `read_pool` outside any transaction; the write phase opens a separate tx on `write_pool`, runs `DELETE FROM block_tag_inherited`, then re-INSERTs the snapshot read earlier. If a concurrent `apply_op_tag_inheritance` runs an incremental update between the read and the DELETE (e.g. an `AddTag` propagating to descendants), the DELETE wipes those rows and the INSERT re-establishes the older snapshot — silently swallowing the incremental update.
- **Why it matters:** The materializer dedups `RebuildTagInheritanceCache`, so a missed `AddTag` propagation sits until the next explicit op triggers another rebuild. Users see incorrect inherited-tag membership and there is no follow-up corrector. Unlike `update_fts_for_block_split` (which has a documented "next materializer task corrects it" comment), the rebuild has no equivalent self-healing.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** (a) Run the rebuild on a single pool inside a `BEGIN IMMEDIATE` so concurrent writers serialize behind it; or (b) read inside `BEGIN DEFERRED` on `write_pool` to obtain a snapshot consistent with the eventual DELETE; or (c) compute the new tuple set into a temp table first and DELETE+`INSERT INTO … SELECT` in the same write tx.
- **Pass-1 source:** 07/F25
- **Status:** Open

### L-95 — `eval_backlink_query` doesn't filter self-references; `total_count` includes self-link
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/query.rs:52-58`
- **What:** The base set query is `SELECT bl.source_id FROM block_links bl … WHERE bl.target_id = ?1` with no `bl.source_id != ?1` filter. A block linking to itself surfaces as its own backlink and inflates `total_count`. Sister helper `eval_unlinked_references` at `grouped.rs:418-421` explicitly excludes self-references with comment "Exclude self-references". The two paths diverge silently.
- **Why it matters:** Inconsistent semantics across two backlink entry points. Whatever the policy is (include self-links or not), it should be stated and applied uniformly so UIs render consistent counts.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either add `bl.source_id != ?1` to `eval_backlink_query` and adjust tests, or document the asymmetry explicitly in the function-level doc comments and contrast with `eval_unlinked_references`.
- **Pass-1 source:** 07/F34
- **Status:** Open

### L-96 — `extract_origin` / `extract_domain` strip neither URL credentials nor fragments
- **Domain:** Search & Links
- **Location:** `src-tauri/src/link_metadata/html_parser.rs:286-322`
- **What:** Neither helper strips `user:pwd@` from URL authority. `extract_origin("https://user:pwd@host/page")` returns `https://user:pwd@host`, and the favicon-URL fallback at `parse_favicon` (line 39) becomes `https://user:pwd@host/favicon.ico` — stored in `link_metadata.favicon_url` and rendered to the user. Likewise `detect_auth_required`'s `original_domain != final_domain` comparison can run on `user:pwd@host.com` strings.
- **Why it matters:** Threat model is single-user (credentials are the user's own), but surfacing them in cached favicon URLs ages those credentials across the local DB and any logs that include the URL.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Strip the userinfo segment in both helpers — after `://`, split on the rightmost `@` if present and discard the prefix. Add a quick unit test for `https://user:pwd@host/`.
- **Pass-1 source:** 07/F30
- **Status:** Open

### Lifecycle

### L-97 — `reverse_delete_attachment` uses `json_extract` on `attachment_id` with no covering index
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/reverse/attachment_ops.rs:22-32`
- **What:** The lookup walks every `add_attachment` op via `json_extract(payload, '$.attachment_id') = ?1` with no supporting index. `AddAttachmentPayload` does carry a `block_id` (and the indexed column IS populated for it), but the query keys on attachment_id, not block_id.
- **Why it matters:** Less common than text/property undo, but every undo of an attachment delete becomes O(n_ops). No regression test covers the at-scale path.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Short-term: keep the `op_type = 'add_attachment'` filter (already present). Long-term: extract `attachment_id` into its own indexed column on `op_log` via a new migration — requires user approval per Architectural Stability (new column).
- **Pass-1 source:** 08/F3
- **Status:** Open

### L-98 — Reverse ops compare timestamps lexicographically
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/reverse/block_ops.rs:95, 128`; `property_ops.rs:85`; `attachment_ops.rs:26`
- **What:** All "find prior op" queries order by `created_at DESC, seq DESC` and select with `created_at < ?2 OR (created_at = ?2 AND seq < ?3)`. Production timestamps come from `crate::now_rfc3339()` (`lib.rs:49-51`, always `Z`-suffix milliseconds), so the lex compare is monotonic in practice; Pass-2 marked the original High-severity claim OVERSTATED.
- **Why it matters:** The lex-monotonic invariant on `op_log.created_at` is undocumented. A future ingest path that introduced `+00:00` suffixes would silently break ordering with the wrong "prior text" replayed into the block.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Document the lex-monotonic invariant on `op_log.created_at` (in `migrations/0001_initial.sql` schema comment AND in `now_rfc3339()`'s docstring), and add a debug assertion at op-log write paths that the timestamp ends in `Z`.
- **Pass-1 source:** 08/F4
- **Status:** Open

### L-99 — Recurrence `repeat-seq` increments only when `repeat-count` is set
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/recurrence/compute.rs:261-316`
- **What:** `if let Some(count) = repeat_count { … set repeat-seq … }` gates the seq counter on `repeat-count` being set. A user who sets `repeat-seq` alone (e.g., to track total occurrences without bounding) gets a frozen counter. Pass-2 downgraded this from Medium because `repeat-seq` is generally treated as system-managed output, not a user-set bound.
- **Why it matters:** Surprising semantics; the property-system docs do not specify the gating.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Document the gating semantics in the `repeat-seq` property-definition help text. Optionally always bump `repeat-seq` when any of the three repeat properties is set.
- **Pass-1 source:** 08/F21
- **Status:** Open

### L-100 — Recurrence reference-date check uses lexicographic comparison
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/recurrence/compute.rs:65-72`
- **What:** `if ref_date > until_str.as_str()` is correct only when both strings are exactly `YYYY-MM-DD`. The SELECT reads `value_date` (the typed date column), but `set_property` allows type-loose writes — a `repeat-until` set to `"2025-12-31T23:59:59Z"` would compare against `T` > `-` lex order and the recurrence would never stop.
- **Why it matters:** Reasonable user input could produce an infinite recurrence chain; the `shift_date` 10000-iter cap guards only the `++` mode.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Validate ISO-8601 date shape (`^\d{4}-\d{2}-\d{2}$`) on `repeat-until` before comparison; emit `tracing::warn!` on malformed input and skip recurrence rather than silently looping forever.
- **Pass-1 source:** 08/F25
- **Status:** Open

### L-101 — `cascade_soft_delete` uses zero `tracing` — no observability into cascades
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/soft_delete/trash.rs:38-65`
- **What:** The function emits no tracing events. `compact_op_log` (in `snapshot/create.rs`) is fully instrumented; cascade delete — which can soft-delete thousands of blocks via a recursive CTE in one tx — is opaque.
- **Why it matters:** When a user reports "I lost a tree of blocks", the only diagnostic is the row count returned, with no log line capturing the seed block_id, cascade size, or timestamp.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add `#[tracing::instrument(skip(pool), err)]` and emit `tracing::info!(block_id, count, "cascade soft-delete")` after `tx.commit()`.
- **Pass-1 source:** 08/F26
- **Status:** Open

### L-102 — `restore_block` does not bound `deleted_at_ref` — wrong-token call is a silent no-op
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/soft_delete/restore.rs:17-43`
- **What:** When called with a `deleted_at_ref` that doesn't match any row, the function returns `Ok(0)` (test `restore_block_with_wrong_deleted_at_ref` line ~386 pins this). No log line, no `Err(NotFound)`, no diagnostic.
- **Why it matters:** Undo of a delete becomes a no-op without diagnostic. If compaction has trimmed the original delete op, the stored `deleted_at` may have come from a different cascade and the undo silently fails.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** When `result.rows_affected() == 0`, emit `tracing::warn!` with block_id and ref. Optionally promote to `Err(AppError::NotFound)` so the undo engine can report failure.
- **Pass-1 source:** 08/F28
- **Status:** Open

### L-103 — `recover_at_boot` runs against the live pool with no mutex / lock
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/recovery/boot.rs:43-54, 86-104`; contract docs at `recovery/mod.rs:5-8`
- **What:** Module docs state recovery "MUST be called exactly once at application start-up, before any user operations are allowed" and "is not safe to run concurrently with normal user operations". The function relies on the caller for that contract; nothing in the code enforces it. There is no boot-state flag, no global mutex, no marker row.
- **Why it matters:** No present caller breaks the contract (`grep -r recover_at_boot` returns only the boot path and tests), but a future Tauri command "force re-run recovery" or a sloppy refactor could corrupt state by interleaving synthetic edit_block ops with real ops.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add a once-only `RECOVERY_DONE: AtomicBool` (or a typed `RecoveryGuard` constructor token) that panics or returns early on the second call; add a regression test asserting the panic.
- **Pass-1 source:** 08/F29
- **Status:** Open

### L-104 — Boot recovery batch query has no upper bound on draft count
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/recovery/boot.rs:73-84`
- **What:** Builds `IN (?, ?, ?, …)` placeholders one per draft. The codebase's chosen ceiling is `MAX_SQL_PARAMS = 999` (`snapshot/restore.rs:10`); if a device crashed during a multi-thousand-block paste, `block_drafts` could exceed 999 rows and this query fails with "too many SQL variables", surfaced as a generic SQLx error at boot.
- **Why it matters:** Boot fails on the unhappy day with no log breadcrumb specific to the cause.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Chunk the IN clause into batches of `MAX_SQL_PARAMS - 1` (mirroring `apply_snapshot`'s pattern), accumulating the `existing_block_ids` HashSet across chunks.
- **Pass-1 source:** 08/F30
- **Status:** Open

### L-105 — `apply_snapshot` keeps every restored row in memory at once
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/snapshot/create.rs:16-73` (`collect_tables`); `src-tauri/src/snapshot/restore.rs:30-294` (decode + chunked insert)
- **What:** `collect_tables` does `fetch_all` per table, accumulating every row of every core table into `SnapshotData.tables`; encode/decode keeps the whole structure in memory. For a 1M-block vault on Android (24 MB release APK heap budget), OOM during apply is a real failure mode.
- **Why it matters:** RESET is one-shot, so impact is bounded — but Android heap pressure is a known failure mode and there is no creation-time warning or guard.
- **Cost:** L
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Document the memory ceiling now: warn at `create_snapshot` time when op_log byte size or row count exceeds a configurable threshold. Plan a streaming snapshot format (length-prefixed table chunks) only if/when the user hits the wall — that change is non-trivial and reshapes `SnapshotData`.
- **Pass-1 source:** 08/F31
- **Status:** Open

### L-106 — `up_to_hash` is computed by wall-clock ordering, not hash chain
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/snapshot/create.rs:100-106`
- **What:** "Latest hash" is `SELECT hash FROM op_log ORDER BY created_at DESC, device_id DESC, seq DESC LIMIT 1`. Two devices' clocks can disagree by seconds; the "latest" hash thus depends on whichever device's wall clock ran ahead. Pass-2 noted that `up_to_hash` is treated as opaque by peers and the *real* anchor is `up_to_seqs` (vector clock equivalent), so practical impact is low.
- **Why it matters:** Sync anchoring on a wall-clock-derived hash is brittle: clock skew between peers can produce a different anchor depending on which side's snapshot is exchanged, causing sporadic re-anchor warnings.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Low
- **Recommendation:** Either (a) make `up_to_hash` a deterministic hash of the snapshot bytes themselves (anchor identifies *this* snapshot, not "the latest op"); (b) document explicitly that `up_to_hash` is opaque and the real causal anchor is `up_to_seqs`. Discuss with user before changing the wire shape.
- **Pass-1 source:** 08/F33
- **Status:** Open

### L-107 — Soft-delete `restore_block` IMMEDIATE tx is overkill for a single UPDATE
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/soft_delete/restore.rs:17-43`
- **What:** A single recursive-CTE UPDATE wrapped in `BEGIN IMMEDIATE` … `tx.commit()`. Pass-2 noted the recursive CTE traverses live `blocks` so the IMMEDIATE serializes against concurrent `cascade_soft_delete` writers — that is the documented intent, not overkill.
- **Why it matters:** Mostly a docs nit: the wrap looks heavyweight to a casual reader who might "simplify" it to an auto-tx update and break the serialization guarantee.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add a short comment on the `pool.begin_with("BEGIN IMMEDIATE")` call explaining the IMMEDIATE is intentional to serialize against concurrent cascade-soft-delete writers, citing the recursive-CTE traversal.
- **Pass-1 source:** 08/F34
- **Status:** Open

### L-108 — Test gap: no oracle test that conflict copies survive their source's compaction
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/snapshot/tests.rs` (file-level gap)
- **What:** None of the ~50 snapshot/compaction tests exercise the interaction between conflict copies and compaction. After compaction, the original's pre-conflict ops are purged; the conflict copy still references the original via `conflict_source`. A subsequent RESET via `apply_snapshot` may not include the source if it was never re-edited.
- **Why it matters:** Lifecycle correctness gap; a bug discovered at use time would be opaque since the relevant state is reachable only via a specific compaction/restore sequence.
- **Cost:** M
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Add a regression test: create block A, conflict-copy A → A', purge oldest ops via `compact_op_log`, snapshot, RESET, assert both A and A' present and `conflict_source` points correctly.
- **Pass-1 source:** 08/F35
- **Status:** Open

### L-109 — Test gap: no test asserting compaction preserves snapshot atomicity on injected error
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/snapshot/tests.rs` (file-level gap)
- **What:** Every compaction test is a happy-path. There is no test injecting a failure between the INSERT-pending and DELETE-FROM-op_log statements (e.g., a SQLite trigger that ABORTs the DELETE) that asserts the entire compaction rolls back — both the snapshot insert AND the op deletion.
- **Why it matters:** The whole point of `BEGIN IMMEDIATE` around compaction is atomicity; without a test, a refactor that splits the tx (as `create_snapshot` already does — see M-69) could silently break atomicity.
- **Cost:** M
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Add a test using a SQLite trigger that ABORTs on DELETE-from-op_log during compaction; assert the snapshot row is rolled back and op_log is intact. Mirror the `recover_at_boot_records_errors_when_draft_processing_fails` pattern in `recovery/tests.rs`.
- **Pass-1 source:** 08/F37
- **Status:** Open

### L-110 — Test gap: recurrence has no test for DST transitions
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/recurrence/tests.rs` (file-level gap); `src-tauri/src/recurrence/parser.rs:104` (`Local::now`)
- **What:** `parser::shift_date` consults `chrono::Local::now()` for `.+` and `++` modes (timezone-sensitive). No test exercises a DST-shift day where the local clock skips an hour; tests use fixed UTC-ish dates only.
- **Why it matters:** A user in a DST timezone could observe a recurrence that lands on the wrong day-of-week on the spring transition, since `date_naive()` at midnight could be the day before/after.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add a table-driven test with known DST dates (e.g., 2024-03-31 in Europe/London) using `chrono_tz` or a mocked `Local::now()`. Better still: switch the parser to `chrono::Utc::now().date_naive()` to remove the timezone dependency entirely (improves cross-device determinism).
- **Pass-1 source:** 08/F38
- **Status:** Open

### L-111 — Test gap: no test for `apply_snapshot` rolling back if a chunk fails mid-loop
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/snapshot/restore.rs:103-251`
- **What:** Six chunked INSERT loops can fail (UNIQUE-violation on a duplicate id, invalid attachment fs_path, etc.). The traversal-fs_path test (line ~2587) confirms whole-tx rollback on a single bad row, but no test asserts the same for a chunk failure halfway through (e.g., a duplicate `(block_id, key)` in `block_properties` chunk 2 of 5).
- **Why it matters:** The INSERT chunks are sequential statements in the same tx, so SQLite *should* roll back all of them, but a future refactor that splits the loop into multiple transactions would silently break atomicity.
- **Cost:** M
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Add a test that injects a malformed row in chunk-2 of `block_properties` and asserts no chunk-1 rows remain after the failure. Mirror the existing `attachments` validation test pattern.
- **Pass-1 source:** 08/F39
- **Status:** Open

### L-112 — `merge_text` does not log line/character offset of detected conflicts
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/merge/detect.rs:109-122`
- **What:** On `Err(_conflict_text)` the diffy error is dropped and a generic `MergeResult::Conflict { ours, theirs, ancestor }` is returned. The conflict text from diffy contains `<<<<<<< / >>>>>>>` markers with positional info that would be useful for telemetry and "why did this conflict?" debugging.
- **Why it matters:** No visibility into the *kind* of conflict (single-line vs overlapping-line) for future telemetry and bug-report triage.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Include `_conflict_text.len()` and a short blake3 digest of the conflict-marker payload in the `tracing::info!("text merge completed")` line so regression tests can pin the kind of conflict observed.
- **Pass-1 source:** 08/F40
- **Status:** Open

### MCP

### L-113 — In-flight tool calls dropped mid-tool-call on `disconnect_all`
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/server.rs:725-740` (`run_connection`'s `tokio::select!`); `src-tauri/src/commands/blocks/crud.rs:184-189` (RW inner pattern); `src-tauri/src/materializer/dispatch.rs:62-70` (`dispatch_background_or_warn`).
- **What:** When `disconnect_signal.notified()` fires inside `run_connection`, the in-flight `handle_connection` future is dropped at the next `.await`. Pass 2 confirmed the original Pass-1 worry ("commit succeeds but materializer never sees the op") is not reachable — `dispatch_background_or_warn` is synchronous and runs before the next suspension point — but the agent still receives no JSON-RPC reply and no activity-feed entry is emitted for that call.
- **Why it matters:** Local-only: a user hitting the kill switch mid-write sees the agent disconnect cleanly, but loses the per-call audit entry and any in-flight tool's response. Cancellation safety is preserved at the DB layer; UX is mildly degraded.
- **Cost:** M
- **Risk:** Medium (must not regress the "immediate disconnect" UX promised by the Settings toggle)
- **Impact:** Low
- **Recommendation:** On the shutdown branch, log at `info`, then wrap the in-flight future in `tokio::time::timeout(Duration::from_secs(2), fut)` so the current `tools/call` has a chance to return its reply and emit its activity entry before the stream is dropped. Document the trade-off in `mcp_disconnect_all`.
- **Pass-1 source:** 09/F6
- **Status:** Open

### L-114 — `LAST_APPEND` retains only the last op_ref — multi-op tools would lose Undo capture
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/last_append.rs:17` (`Cell<Option<OpRef>>`), `src-tauri/src/mcp/last_append.rs:24-26` (`record_append`), `src-tauri/src/mcp/last_append.rs:67-91` (test pinning "second overwrites first"); consumer `src-tauri/src/mcp/server.rs:454-462`.
- **What:** `LAST_APPEND` is a `Cell<Option<OpRef>>` set by `record_append`; each call overwrites the previous value. The dispatch layer takes the cell at the end of a tool call. Today every RW tool emits exactly one op, but a future multi-op tool (e.g. `move_subtree`, `bulk_set_property`) would silently capture only the last op_ref, partial-Undo-able.
- **Why it matters:** Forward-looking maintenance hazard. No bug today, but the contract is implicit and the test pins the wrong invariant for the multi-op future.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low (today); Medium (when RW grows)
- **Recommendation:** Change the type to `Cell<Vec<OpRef>>` (or `RefCell<Vec<OpRef>>`) and append on each `record_append`. Either widen `ActivityEntry.op_ref` to a `Vec` or keep `op_ref` as the first and add `additional_op_refs: Vec<OpRef>`. Update the test to assert "all appends are retained, in order".
- **Pass-1 source:** 09/F7
- **Status:** Open

### L-115 — `list_property_defs` snapshot row count (19) hard-coded; brittle vs. seeded property migrations
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/tools_ro.rs:1078-1099` (test `list_property_defs_happy_path`); `src-tauri/src/mcp/snapshots/agaric_lib__mcp__tools_ro__tests__tool_response_list_property_defs.snap` (19 entries).
- **What:** The test asserts `arr.len() == 19` against the seeded property definitions, and the insta snapshot pins the exact 19 keys. Every future migration that adds or removes a seeded property def must update both files in lockstep, with no automated guard against accidental drift.
- **Why it matters:** Maintenance burden: a contributor adding a single property def will get a confusing test failure that points at "MCP" rather than at "seeded property defs". Pass 2 confirmed this is the only snapshot whose row count is asserted.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Replace the `assert_eq!(arr.len(), 19, ...)` with "expected key set is a subset of the response", and let the insta snapshot remain the wire-shape oracle. Optionally add a meta-test that cross-checks the snapshot's keys against a live query of `property_definitions` to catch drift in either direction.
- **Pass-1 source:** 09/F8
- **Status:** Open

### L-116 — `wrap_tool_result_error` is dead code; FEAT-4h shipped but the helper is unwired
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/server.rs:382-390` (helper, `#[allow(dead_code)]`); only call site is the test at `src-tauri/src/mcp/server.rs:1537-1552`; production dispatch maps every `AppError` via `app_error_to_jsonrpc` (`src-tauri/src/mcp/server.rs:501-512`).
- **What:** `wrap_tool_result_error` exists with a comment promising "FEAT-4h RW tools will use this helper", but FEAT-4h has shipped (REVIEW-LATER.md line 262) and every RW tool still uses JSON-RPC error codes via `app_error_to_jsonrpc`. The helper is reachable only from a `#[cfg(test)]` shape test.
- **Why it matters:** Documentation and code drift; future contributors will spend time hunting "what is this for?" and conclude (correctly) that it is vestigial. The MCP `isError: true` envelope is real and meaningful in the spec — but Agaric chose JSON-RPC errors instead, deliberately.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Delete the helper and its shape test, and add a one-line comment near `app_error_to_jsonrpc` explaining the deliberate JSON-RPC-only design. Alternatively, wire it in for one specific class of agent-induced domain failures — but no current AppError variants fit, so deletion is cleaner.
- **Pass-1 source:** 09/F9
- **Status:** Open

### L-117 — `task_running` flag is one-shot; never resets while serve loop runs
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/mod.rs:434-450` (RO spawn), `src-tauri/src/mcp/mod.rs:521-537` (RW spawn); consumer `src-tauri/src/commands/mcp.rs:232`.
- **What:** `lc.task_running.store(true)` runs after `bind_socket` succeeds; `store(false)` runs only after `server::serve` returns. Because the accept loop is an unconditional `loop { listener.accept().await? }` (no shutdown branch — see L-120), `serve` never returns in steady state and `task_running` is monotonic-true. `is_running()` therefore reports true even after the user has flipped the toggle off.
- **Why it matters:** Diagnostic / observability: `is_running` is misleading after a disable cycle. Combined with L-120, the disable toggle does not actually stop the listener until process restart, so this is consistent ("yes the loop is alive") but masks the root issue.
- **Cost:** S — automatically resolved by adding a shutdown signal that lets `serve` return.
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Fix together with the accept-loop shutdown work — H-2 is the canonical fix for `mcp_set_enabled(false)` not stopping the accept loop, and L-120 covers the disconnect-signal documentation. Once `serve` actually returns on disable, the existing `store(false)` line at `mod.rs:447-450` fires correctly.
- **Pass-1 source:** 09/F10
- **Status:** Open

### L-118 — TOCTOU race on rapid `mcp_set_enabled` toggling
- **Domain:** MCP
- **Location:** `src-tauri/src/commands/mcp.rs:212-244` (`mcp_set_enabled`, in particular the `lc.is_running()` read at line 232); `src-tauri/src/mcp/mod.rs:275-296` (`bind_socket` already-bound probe).
- **What:** `mcp_set_enabled(true)` reads `lc.is_running()` without a lock and conditionally calls `spawn_mcp_ro_task`. A second concurrent `mcp_set_enabled(true)` may also see `task_running == false` (because the first spawn has not yet reached `bind_socket`) and double-spawn. The second `bind_socket` then detects the live socket via the `UnixStream::connect` probe and returns `AppError::InvalidOperation("already bound")`, logged at warn.
- **Why it matters:** Pure cosmetic: the worst observable artifact is a single warn line. Local-only deployment makes accidental rapid toggles vanishingly rare.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Leave as-is per Pass 2's "leave-as-is" finding; the warn log is sufficient diagnostic. If a clean fix is desired, add a `spawning: AtomicBool` on `McpLifecycle` and gate the spawn with `compare_exchange`.
- **Pass-1 source:** 09/F11
- **Status:** Open

### L-119 — Schema `minimum`/`maximum` advisory; server silently `clamp`s out-of-range `limit`
- **Domain:** MCP
- **Location:** Schemas at `src-tauri/src/mcp/tools_ro.rs:280-289, 305-310, 328-340, 374-381, 393-400, 428-436`; clamp sites at `src-tauri/src/mcp/tools_ro.rs:468, 475, 484-487, 522, 530`; constants `LIST_RESULT_CAP = 100`, `SEARCH_RESULT_CAP = 50`, `AGENDA_RESULT_CAP = 500`.
- **What:** Every list-style tool advertises `"limit": { "minimum": 1, "maximum": LIST_RESULT_CAP }` in its JSON-Schema, then the handler does `.clamp(1, LIST_RESULT_CAP)` — so an agent sending `{"limit": 999}` does not get `-32602 invalid params`, it gets a silent truncation to 100. Inconsistent with the strict `serde(deny_unknown_fields)` posture used elsewhere.
- **Why it matters:** An MCP client with a JSON-Schema validator (Claude Desktop, Cursor) catches this client-side, so the leak is invisible there. Clients without schema validation get silent truncation. No security impact in the local-only model — purely an interop nit.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Pick one stance: (a) replace `.clamp(...)` with explicit `if !(1..=cap).contains(&l) { return Err(AppError::Validation(...)) }` to surface a `-32602`, or (b) drop the schema bounds and document "limits are silently capped server-side at N". Option (a) is more agent-friendly and matches `deny_unknown_fields`.
- **Pass-1 source:** 09/F12
- **Status:** Open

### L-120 — `disconnect_signal` is edge-triggered; doc could be clearer
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/mod.rs:81-86` (`disconnect_all` doc); consumer `src-tauri/src/mcp/server.rs:725-740` (`run_connection`'s `select!`).
- **What:** `disconnect_all` calls `Notify::notify_waiters`, which only wakes tasks already inside `notified().await`. A connection that arrives milliseconds after `disconnect_all` registers a fresh waiter (no permit) and runs as if nothing happened. The current docstring says "wakes every in-flight connection" but does not call out the "must already be in `notified()`" requirement.
- **Why it matters:** Subtle Tokio semantics; a future contributor reading "kill switch" will assume this also pre-empts later connections, which it does not. (Combined with the accept-loop fix, the shutdown signal will also prevent new accepts — but the doc should be explicit.)
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Update the doc on `McpLifecycle::disconnect_all` to read: "Wakes only the connections present at the call time; later-arriving connections are unaffected (each registers a fresh `notified()` waiter on entry to `run_connection`). Pair with a `shutdown_signal` on the accept loop to cover both."
- **Pass-1 source:** 09/F14
- **Status:** Open

### L-122 — `set_property` exactly-one-value validation duplicated at MCP boundary
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/tools_rw.rs:362-402` (handler check); backing `src-tauri/src/commands/properties.rs::set_property_inner` (independently enforces the same rule, per the comment at `tools_rw.rs:369-372`).
- **What:** `handle_set_property` counts `value_text` / `value_num` / `value_date` / `value_ref` and rejects `!= 1` with `AppError::Validation`, duplicating the inner's validation purely so the error message includes the tool name. Two sources of truth for one rule.
- **Why it matters:** Maintenance hazard. If the inner's rule ever changes (e.g. a future "clear by passing zero values" path), the MCP layer must update in lockstep or silently diverge.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Drop the MCP-side check; instead, add a `caller_context: &str` (or `tool_name: Option<&str>`) parameter to `set_property_inner` that gets included in the `AppError::Validation` message. Keep one source of truth.
- **Pass-1 source:** 09/F16
- **Status:** Open

### L-123 — `parse_args` error message includes raw `serde_json::Error` text
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/tools_ro.rs:171-174` (`parse_args`); `src-tauri/src/mcp/tools_rw.rs:111-114` (RW symmetry).
- **What:** `parse_args` formats failures as `tool '{tool}': invalid arguments — {e}` with `{e}` being the verbatim `serde_json::Error::Display`, including line/column hints into the wire JSON. For a human reading the activity feed, the line/column refers to MCP-internal framing rather than the user's prompt.
- **Why it matters:** Mild error-UX issue: agents that parse the message structurally are fine, but humans debugging via the activity feed get confusing line/column hints. Local-only, no security relevance.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** For `serde_json::Error::classify() == Category::Data`, emit a structured message like `tool 'append_block': missing required field 'parent_id'` (using `Error::line()` / `Error::column()` only on `tracing::debug!`). Keep verbose serde output on the debug log, surface a concise message to the agent.
- **Pass-1 source:** 09/F17
- **Status:** Open

### L-124 — No MCP-level concurrent-write stress test
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/tools_ro.rs:1348-1425` (RO-only stress fixture `concurrent_clients_exact_success_count`); RW handlers at `src-tauri/src/mcp/tools_rw.rs:331-444`; backing pattern `src-tauri/src/commands/blocks/crud.rs:184` (`pool.begin_with("BEGIN IMMEDIATE")`).
- **What:** The RW handlers are 1:1 with `*_inner` calls, each opening its own `BEGIN IMMEDIATE` transaction. That contract is exercised at the inner-test level but not at the MCP boundary — there is no MCP-level stress test that interleaves `append_block` / `delete_block` / `add_tag` across multiple concurrent agent connections (and ideally a frontend-side concurrent writer).
- **Why it matters:** Today the inners enforce write-pool serialization correctly, so this is a coverage gap rather than a defect. A future refactor that bypassed the inner — or added an MCP-side cache that subverted `BEGIN IMMEDIATE` — would slip through.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Adapt the existing RO `concurrent_clients_exact_success_count` test into an RW variant: 4 agent connections × N (append_block + delete_block + add_tag) interleaved, plus one frontend-side writer, asserting exact final block count and zero FK violations.
- **Pass-1 source:** 09/F18
- **Status:** Open

### M-84 — `journal_for_date` is exposed on the RO server but writes to op_log
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/tools_ro.rs:182-208` (module doc), `src-tauri/src/mcp/tools_ro.rs:212-224` (9-tool list), `src-tauri/src/mcp/tools_ro.rs:245-263` (ACTOR scope), `src-tauri/src/mcp/tools_ro.rs:550-564` (handler); REVIEW-LATER.md FEAT-4 line 199 (lists `journal_for_date` as RO).
- **What:** `ReadOnlyTools` carries a `device_id` and a writer-capable `Materializer` solely so `journal_for_date` can call `create_block_inner` for missing dates. The resulting op lands in `op_log` with `origin = "agent:<name>"`. The user toggling on the **read-only** marker therefore implicitly grants "agent can append a `create_block` for a journal page", and the user-facing copy in Settings does not surface this.
- **Why it matters:** Even in the local-only model, the Settings tab labels this as a read-only surface; an agent calling `journal_for_date` for an unseen date adds an entry to the recent-activity feed that the user did not consent to in mental-model terms. Pass 2 downgraded the severity (no security impact), but the wording drift is real.
- **Cost:** S (docs/UI label) — L (split tool requires user approval per AGENTS.md "Architectural Stability")
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Update the Settings tooltip and the FEAT-4 doc to say "RO tools may create a journal page on first read-of-the-day"; do not split the tool without explicit user approval since changing the MCP tool surface is a public API change.
- **Pass-1 source:** 09/F4
- **Status:** Open

### M-86 — Server pinned to MCP `"2024-11-05"` but emits `structuredContent` (a 2025-06-18 feature)
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/server.rs:42` (`MCP_PROTOCOL_VERSION`), `src-tauri/src/mcp/server.rs:247-256` (initialize response), `src-tauri/src/mcp/server.rs:217-218` (handshake comment); `wrap_tool_result_success` envelope (used by every successful tool call).
- **What:** `MCP_PROTOCOL_VERSION = "2024-11-05"` is the only string the server returns from `initialize`, but `wrap_tool_result_success` includes `structuredContent`, a field that the MCP spec only added in `2025-06-18`. The server is therefore declaring an older protocol version while emitting fields specific to a newer one.
- **Why it matters:** A pedantic / strict client (or a future Claude Desktop release that validates against `2024-11-05`) could reject responses because `structuredContent` is unexpected for the declared version. Today every client we care about accepts extra fields, but the doc/code drift is real and will trip any future negotiation logic.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Bump `MCP_PROTOCOL_VERSION` to `"2025-06-18"`, update the snapshot at `server.rs:818` and `server.rs:1819`, and verify our two reference clients (Claude Desktop, Cursor) negotiate cleanly. Optionally echo the client's requested version when it parses, with `serverInfo.version` as the authoritative version field.
- **Pass-1 source:** 09/F26
- **Status:** Open

### GCal / Spaces / Drafts

### L-126 — `bootstrap_spaces` uses `BlockId::from_trusted` for hand-typed ULID constants
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/spaces/bootstrap.rs:131-138`
- **What:** The CreateBlock payload uses `BlockId::from_trusted(SPACE_PERSONAL_ULID)` rather than `BlockId::from_string(...)`. `from_trusted` is documented as "already known to be a valid ULID from a prior `BlockId::new()` call" — but these are hand-typed string constants. A typo (banned Crockford char `I/L/O/U`) would not be caught at runtime, only by the `seeded_ulids_parse_as_valid_ulids` test (`spaces/tests.rs:106-120`).
- **Why it matters:** Wrong-tool-for-the-job; not a bug today but loses a runtime safety net on a constant whose validity is load-bearing for FEAT-3.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Switch to `BlockId::from_string(SPACE_PERSONAL_ULID).expect("seeded ULID validates")`, or wrap the constants in a `LazyLock<BlockId>` constructed via `from_string` once at first use.
- **Pass-1 source:** 10/F15
- **Status:** Open

### L-127 — `gcal_push/mod.rs` re-exports every internal module as fully `pub`
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/mod.rs:9-16`
- **What:** All eight submodules (`api`, `connector`, `digest`, `dirty_producer`, `keyring_store`, `lease`, `models`, `oauth`) are declared `pub mod`. Only a small subset is needed by `lib.rs` / `commands/gcal.rs` — `lease`, `models`, `dirty_producer`, `digest::digest_for_date`, etc. are crate-internal callers.
- **Why it matters:** Wide `pub` API surface that future refactors must preserve; specta also generates type bindings for everything `pub`-reachable when `Type` derives bubble up.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Downgrade each submodule to `pub(crate) mod` and re-export only the symbols `lib.rs` and `commands/gcal.rs` need (`spawn_connector`, `GcalApiAdapter`, `GcalClient`, `ConnectorTask`, `GcalConnectorHandle`, `KeyringTokenStore`, `NoopEventEmitter`, `TauriGcalEventEmitter`, `TokenStore`, `GcalEventEmitter`, `oauth::Token`, `digest::Event`, `api::GcalApi`).
- **Pass-1 source:** 10/F16
- **Status:** Open

### L-128 — `digest::truncate_with_overflow_suffix` is O(N²) on the linear scan path
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/digest.rs:281-305`
- **What:** Greedy truncation loops `kept` from `total-1` down to 0; each iteration `lines[..kept].join("\n").chars().count()` rebuilds the prefix. `n = AGENDA_FETCH_LIMIT = 500`; the doc explicitly waves this off as "binary search would be marginally faster but N is at most a few hundred in practice; linear keeps the logic obviously correct."
- **Why it matters:** Connector dispatches one digest per dirty date per cycle; even a 30-day full window is 30 digests. Currently not a real performance hazard.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Keep linear *iff* the upper bound stays ~500. If `AGENDA_FETCH_LIMIT` ever rises, switch to a precomputed cumulative-length table (O(N)) + binary search (O(log N)). Add a micro-benchmark when/if that lands.
- **Pass-1 source:** 10/F17
- **Status:** Open

### L-129 — `classify_refresh_error` formats upstream `Display` directly into validation message
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/oauth.rs:667-683`
- **What:** `AppError::Validation(format!("oauth.refresh_failed: {err}"))` interpolates the full `oauth2::RequestTokenError` `Display`. `reqwest::Error`'s `Display` does not include request bodies today; Google's documented refresh error responses (`invalid_grant`, etc.) carry only an `error_description` text. But the formatted string ends up in tracing spans and bug-report bundles.
- **Why it matters:** Defence-in-depth around OAuth refresh tokens, called out as in-scope per the user's gcal threat-model carve-out. If a future `oauth2` upgrade ever changes the error formatter to include the request, the refresh token would leak into logs.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Downcast `err` against the closed set of `BasicErrorResponseType` and stringify only the variant name (or the documented Google `error` field), or wrap the formatted message with an assertion that no substring of the SecretString refresh token appears. Prefer the closed-set approach.
- **Pass-1 source:** 10/F20
- **Status:** Open

### L-130 — `serde_json::from_str` error in `KeyringTokenStore::load` may include token chars
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/keyring_store.rs:444-454`
- **What:** `let blob: TokenBlob = serde_json::from_str(&json)?;` propagates `serde_json::Error`, whose `Display` shows position + a short context window of the input — depending on where parsing fails, a partial chunk of the access or refresh token bytes could surface. The `?` becomes `AppError::Json` which tracing renders.
- **Why it matters:** Same defence-in-depth motivation as L-129. The keyring round-trip is the only realistic mismatch path (a corrupt keyring entry that mis-parses), but logging that error at `error!` would expose secret bytes.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Replace `?` with an explicit map: `serde_json::from_str(&json).map_err(|_| AppError::Validation("keyring.malformed_blob".into()))?`. Drop the original error so secret bytes never reach tracing. Add a regression test that injects a malformed JSON blob containing token-shaped data and asserts the error message is the literal `keyring.malformed_blob`.
- **Pass-1 source:** 10/F21
- **Status:** Open

### L-131 — `delete_calendar` API path does not URL-encode `calendar_id`
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/api.rs:283, 315, 355-358, 393-396, 442-445`
- **What:** Every per-calendar URL is built via `format!("{}/calendars/{}/events", self.base_url, calendar_id)` with no percent-encoding. Google calendar IDs follow `<random>@group.calendar.google.com` — ASCII-safe by spec — but a corrupted or maliciously-tampered `gcal_settings.calendar_id` containing `/` or `?` would change the request shape.
- **Why it matters:** AGENTS.md threat model states no adversarial peers, and `gcal_settings.calendar_id` is essentially trusted (only `create_dedicated_calendar` writes it). However, the local DB is a file on disk that any process with file access can edit, so defence-in-depth is appropriate.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Wrap `calendar_id` and `event_id` in `urlencoding::encode(...)` before the format, or use `reqwest::Url::parse` + `path_segments_mut().push(...)` to push segments with encoding. Add a unit test where `calendar_id` contains `/` and assert the resulting URL is escaped.
- **Pass-1 source:** 10/F24
- **Status:** Open

### L-132 — `claim_lease` does 4 round-trips, could be 2
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/lease.rs:140-218`
- **What:** Inside one `BEGIN IMMEDIATE` tx, `claim_lease` does 2 single-key SELECTs (`push_lease_device_id`, `push_lease_expires_at`) and then 2 single-key UPDATEs. Could be one batched SELECT (`WHERE key IN (...)`) and one batched UPDATE (`SET value = CASE key WHEN ... END WHERE key IN (...)`).
- **Why it matters:** Lease cycle runs at `LEASE_RENEW_INTERVAL_SECS = 60s` once C-1 is fixed. Per-cycle cost is negligible; flagged for completeness.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Defer until profiling shows it matters. If the connector ever drops to a sub-second cycle, batch the reads and writes.
- **Pass-1 source:** 10/F25
- **Status:** Open

### L-134 — `dispatch_background_for_page_create` is best-effort and silent on failure
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/commands/spaces.rs:215-249`
- **What:** After `create_page_in_space_inner` commits, the wrapper re-fetches both ops to dispatch them to the materializer. If the re-fetch fails it logs `tracing::warn!` and returns; the wrapper itself returns `Ok(id)` regardless — the IPC succeeds but background caches (tag-inheritance, FTS, pages_cache, projected agenda) are not refreshed for that create. The other create paths (e.g. `create_block_inner` line 188) directly dispatch from the in-tx-returned op record without a re-fetch.
- **Why it matters:** Stable race window — the user-facing IPC says "page created" but the new page doesn't appear in search / isn't queryable by tag until the next op flows. Eventually consistent, but the whole point of `create_page_in_space` is atomicity.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Refactor `create_page_in_space_inner` to return both `OpRecord`s (mirroring `create_block_in_tx`'s shape) so the wrapper can dispatch directly without the re-fetch step. Removes the silent fallback and aligns with the other create paths.
- **Pass-1 source:** 10/F27
- **Status:** Open

### L-135 — Drafts module has no garbage-collection path beyond crash recovery
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/draft.rs:34-114`; `ARCHITECTURE.md §12 Crash Recovery`
- **What:** Drafts are inserted on autosave, deleted on `flush_draft` (blur). If the editor unmounts without a flush event firing (mobile backgrounding, hard kill, crash), the draft survives indefinitely until next boot — when crash recovery emits synthetic edit_block ops for surviving drafts and wipes them all. Within a session there is no upper bound; combined with M-93 (no FK), drafts for hard-deleted blocks survive purges and produce noise on next boot.
- **Why it matters:** AGENTS.md lists `block_drafts` as the only mutable scratch space; mutable scratch needs eviction policy. Today the only policy is "boot wipes it all", which is fine for crash recovery but weak for long-running session hygiene.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** (1) Add a periodic in-app sweep — every N minutes, delete `block_drafts` rows whose `block_id` no longer maps to a live block (covers M-93's gap until the FK lands). (2) Tighten the boot recovery path (`recovery::recover_drafts`) to skip drafts whose `block_id` does not correspond to a live block, instead of emitting a synthetic op for a missing target. Neither requires a new table / op type.
- **Pass-1 source:** 10/F30
- **Status:** Open

## INFO / nits (79 — expanded)

> Each entry is a fully-detailed block (Domain / Location / What / Why / Cost / Risk / Impact / Recommendation / Pass-1 source / Status).

### Core

### I-Core-1 — `OpType` is `#[non_exhaustive]` but every match in-crate is exhaustive
- **Domain:** Core
- **Location:** `src-tauri/src/op.rs:24-45`
- **What:** `OpType` is annotated `#[non_exhaustive]` so "downstream match arms outside this crate" don't break when a variant is added. The crate is workspace-internal; every consuming `match` (in `op.rs`, `dag.rs`, `op_log.rs`, `reverse.rs`, etc.) is intra-crate and exhaustive. The attribute prevents the compiler from flagging missed arms when the next variant lands. ARCHITECTURE.md §4 cites *"12 op types with exhaustive `match` — no catch-all arms"* as a deliberate invariant — `#[non_exhaustive]` weakens that to social enforcement.
- **Why it matters:** When a 13th op type is added (e.g. for compaction tombstones) the compiler will not flag every site that needs a new arm. Pure maintainability.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Drop `#[non_exhaustive]` from `OpType`. Update the doc-comment at `op.rs:24-28` to state the in-crate exhaustive-match invariant explicitly.
- **Pass-1 source:** 01/F16
- **Status:** Open

### I-Core-2 — `find_lca` issues N+1 SELECTs — one round-trip per chain step
- **Domain:** Core
- **Location:** `src-tauri/src/dag.rs:186-292` (the `get_op_by_seq` calls at 207, 225, 256, 277)
- **What:** Each `prev_edit` follow calls `get_op_by_seq(pool, ...)`, which is a fresh pool acquire + SELECT. For an N-step edit chain that is N round-trips per side (2N total when both chains are walked). The chain-walk Vec is bounded only by cycle detection (see M-4).
- **Why it matters:** At the documented "personal note-taking" scale this is fine, and ARCHITECTURE.md says "trivially fast for realistic workloads." But the same primitive backs three-way merge on the sync hot path; a thousand-edit block produces hundreds of round-trips on every merge attempt.
- **Cost:** M
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Optimisation, not correctness. Express the chain walk as a recursive CTE keyed on `parent_seqs` and `block_id` returning the visited set in DB order. Keep the existing Rust walk as a `#[cfg(test)]` oracle (per the AGENTS.md CTE-oracle pattern).
- **Pass-1 source:** 01/F17
- **Status:** Open

### I-Core-3 — `get_or_create_device_id` writes are non-atomic
- **Domain:** Core
- **Location:** `src-tauri/src/device.rs:69-90`
- **What:** The new-file branch opens with `create_new(true)` (TOCTOU-safe), then `write_all` and `sync_all`. If the process is killed between successful `create_new` and successful `write_all`, the file exists but contains fewer than 36 bytes — and on the next boot `Uuid::parse_str` rejects it with `AppError::InvalidOperation: Corrupt device ID file`. There is no automatic recovery.
- **Why it matters:** Tiny window, tiny audience, but the consequence is "app cannot boot until the user manually deletes the device-id file". Pure startup hardening.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Write to a tempfile in the same directory via `tempfile::NamedTempFile::new_in(parent)` (or `OpenOptions::create_new(true)` on a `.tmp` sibling), `sync_all`, then `persist`/`rename`. POSIX guarantees atomic rename within a filesystem; the final file is either whole or absent. Maintain TOCTOU safety on the temp file.
- **Pass-1 source:** 01/F18
- **Status:** Open

### I-Core-4 — `cleanup_old_log_files` only matches `agaric.log.YYYY-MM-DD` exactly
- **Domain:** Core
- **Location:** `src-tauri/src/lib.rs:909-937` (matcher at 924-927) and tests at `lib.rs:1196-1209` (`ignores_non_matching_filenames`)
- **What:** tracing-appender's daily rolling can produce `agaric.log.YYYY-MM-DD.<unique-suffix>` under some configurations, and the live file before any rollover is `agaric.log` (no date). The cleanup function only matches names of the form `agaric.log.` + exactly 10 chars + valid date. Any other variant accumulates forever; the test `ignores_non_matching_filenames` explicitly preserves `agaric.log` and other shapes.
- **Why it matters:** Not a correctness bug today (the appender configured at `lib.rs:347` produces canonical date format), but the test pins the lenient behaviour, so any future change to the appender silently disables retention. AGENTS.md doesn't specify retention policy — info-level note.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either widen the matcher to include the optional rolling suffix (`agaric.log.YYYY-MM-DD(\.\w+)?`) or add a test that exercises the actual appender output and asserts cleanup picks it up. Today's `agaric.log` (the live file) should remain excluded.
- **Pass-1 source:** 01/F19
- **Status:** Open

### I-Core-5 — ARCHITECTURE.md §4 calls the per-block edit chain a "DAG"; structurally it's a tree
- **Domain:** Core
- **Location:** `ARCHITECTURE.md:331-333` vs `src-tauri/src/op.rs:120-126` (the `EditBlockPayload.prev_edit: Option<(String, i64)>` definition)
- **What:** ARCHITECTURE.md §4 says: *"`edit_block.prev_edit`: … Forms a per-block edit chain (DAG) embedded in the global op log, used for LCA computation during three-way merge."* `prev_edit` is `Option<(String, i64)>` — a single optional parent. With one parent per node, the per-block edit graph is a tree (technically a forest), not a DAG. Multi-parent merges live on the merge-op path via `parent_seqs`, which is a different (global) structure.
- **Why it matters:** Documentation/cosmetic only. "DAG" implies multi-parent merges that the per-block code does not implement; readers looking for them will be confused. Two doc lines.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Documentation-only fix. Edit `ARCHITECTURE.md:331-333` to say "linear chain" or "per-block edit tree" for the per-block structure, and reserve "DAG" for the global op log multi-parent merges.
- **Pass-1 source:** 01/F20
- **Status:** Open

### I-Core-6 — `build_log_directives` test gap on namespace-prefix collisions
- **Domain:** Core
- **Location:** `src-tauri/src/lib.rs:84-105` (impl) and tests at `lib.rs:1271-1276` (`unrelated_user_directive_preserves_all_defaults`) / `lib.rs:1346-1352` (`has_directive_for_target_negative_cases`)
- **What:** `has_directive_for_target("agaric_extras=trace", "agaric")` correctly returns false because the prefix check uses `"agaric::"`, but the only positive-coverage test (`unrelated_user_directive_preserves_all_defaults`) exercises `sqlx=trace`. There is no test asserting that `build_log_directives("agaric_extras=trace", DEFAULTS)` keeps the `agaric=info` default.
- **Why it matters:** The fallback `EnvFilter::new("agaric=info,frontend=info")` on parse error is a safety net; the test gap is the kind that lets a regression silently land. Pure test coverage.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Documentation/test-only. Add a positive test asserting both `!has_directive_for_target("agaric_extras=trace", "agaric")` and that `build_log_directives("agaric_extras=trace", DEFAULTS)` still contains `agaric=info`.
- **Pass-1 source:** 01/F21
- **Status:** Open

### I-Core-7 — Command list duplicated between `run()` and `specta_tests::specta_builder`
- **Domain:** Core
- **Location:** `src-tauri/src/lib.rs:183-303` (production `collect_commands!` in `run()`) and `src-tauri/src/lib.rs:947-1068` (`specta_tests::specta_builder`)
- **What:** The same ~80-command list is hand-written in two places. Adding a new command requires touching both. The `ts_bindings_up_to_date` test only catches drift after `regenerate_ts_bindings` has been run and the diff committed; adding a command in `run()` but not `specta_builder` produces a runtime-but-not-bindings command silently, and vice versa.
- **Why it matters:** Long-running maintenance trap. The two ~80-line literal blocks are structural debt with no current correctness impact (the lists agree as of this review).
- **Cost:** M
- **Risk:** Medium
- **Impact:** Low
- **Recommendation:** Factor the command list into a single `macro_rules! agaric_commands` (because `tauri_specta::collect_commands!` is itself a macro that needs the token tree at expansion time). Reference the wrapper macro from both call sites. **Requires user approval per AGENTS.md Architectural Stability — adding a macro that generates the command list is a structural change.**
- **Pass-1 source:** 01/F22
- **Status:** Open

### I-Core-8 — Op-log read helpers take generic `SqlitePool` (no read/write-pool typing)
- **Domain:** Core
- **Location:** `src-tauri/src/op_log.rs:252-298` (`get_op_by_seq`, `get_latest_seq`, `get_ops_since`)
- **What:** ARCHITECTURE.md §3 promotes `WritePool` / `ReadPool` newtypes (`db.rs:90-98`) to prevent accidental writes on the read pool. The op-log read helpers still take a bare `&SqlitePool`, so callers can pass either. A grep shows `get_op_by_seq` is invoked with the write pool inside `dag::find_lca`'s chain walk — correct, but it contends with writers on the hot merge path.
- **Why it matters:** Defeats the split-pool architecture for a strict-read path. Pure typing/defence-in-depth nit.
- **Cost:** M
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either change the helper signatures to `pool: &ReadPool` (and update non-read callers explicitly) or add `_reading` variants that accept `&ReadPool`. At minimum, change `dag::find_lca` to thread a `&ReadPool` through to `get_op_by_seq`.
- **Pass-1 source:** 01/F23
- **Status:** Open

### I-Core-9 — `has_merge_for_heads` substring match on `parent_seqs` is correct only by coincidence
- **Domain:** Core
- **Location:** `src-tauri/src/dag.rs:350-371`
- **What:** The function searches for `their_head` JSON-encoded as a 2-tuple inside the `parent_seqs` column via SQL `instr(parent_seqs, ?)`. This works because the JSON serialisation always closes the tuple with `]` (so `["device-A",1]` does not match the prefix of `["device-A",10]`) and because `device_id` is a UUID with no JSON-special chars. The doc-comment does not articulate either invariant.
- **Why it matters:** A future migration that stores a different identifier shape in `parent_seqs` (peer-id rename, alphabetic device names) would silently introduce false positives. Documentation/cosmetic, defence in depth.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Documentation/cosmetic only — extend the function-level doc to spell out the invariants ("seq is integer; device_id is UUID with no JSON-special chars"). Optional hardening: replace the `instr(parent_seqs, ?)` with `EXISTS (SELECT 1 FROM json_each(parent_seqs) WHERE value = ?)`, eliminating the substring assumption.
- **Pass-1 source:** 01/F24
- **Status:** Open

### I-Core-10 — `import.rs` `:: ` property delimiter matches mid-line `key:: value`
- **Domain:** Core
- **Location:** `src-tauri/src/import.rs:86-105`
- **What:** The parser checks `trimmed.starts_with("- ")` first (good), but the `else` branch tests `trimmed.contains(":: ")`. A non-list line containing the literal `:: ` substring (e.g. a trailing free-form line) is misclassified as a property and fed into `split_once(":: ")`, producing arbitrary key/value pairs. The current `parse_properties` test only exercises the canonical case.
- **Why it matters:** Imports from arbitrary user notes (especially URL-laden Logseq pages) can produce silently corrupted property assignments on the imported blocks.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Tighten the discriminator: only treat the line as a property if `trimmed.split_once(":: ")` returns `(key, _)` AND `key` matches the same alphabet that `validate_set_property` uses (`^[A-Za-z0-9_-]+$`, 1–64 chars). Otherwise fall through to the content-block branch. Add a regression test fixture with a URL-bearing line.
- **Pass-1 source:** 01/F25
- **Status:** Open

### I-Core-11 — `parent_seqs` JSON built via hand-written `format!` instead of `serde_json::to_string`
- **Domain:** Core
- **Location:** `src-tauri/src/op_log.rs:121-131` (Phase-1 single-parent path) vs `src-tauri/src/dag.rs:108-112` (merge-op path that uses `serde_json::to_string(&sorted_parents)`)
- **What:** Instead of `serde_json::to_string(&vec![(device_id.to_string(), prev_seq)])`, the code does `Some(format!(r#"[["{}",{}]]"#, device_id, prev_seq))`. This skips JSON escaping and assumes `device_id` contains no JSON-special characters. Today device_ids are UUIDs (`/^[0-9a-f-]+$/`) so no escaping is needed; the comment justifies it as "to avoid Vec allocation + sort overhead". Two diverging serialisation paths exist for the same column.
- **Why it matters:** Defence in depth and consistency. The hash-input contract is silently coupled to "device_id is JSON-safe" — a property that holds today but is not enforced anywhere in the type system.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Replace the `format!` with `serde_json::to_string(&[(device_id.to_string(), prev_seq)])?` so both single- and multi-parent paths share the exact same serialisation. The cost is one Vec + one heap String — negligible against the surrounding SQL. Add a regression test asserting byte equality with a frozen device_id fixture.
- **Pass-1 source:** 01/F26
- **Status:** Open

### Materializer

### I-Materializer-1 — `sweep_once` uses a single pool for both reads and writes
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/retry_queue.rs:205-245`, called from `lib.rs:544-548` via `spawn_sweeper()` and the sweeper loop at `retry_queue.rs:261-278`
- **What:** `sweep_once(pool: &SqlitePool, mat: &Materializer)` takes a single pool argument. Both `fetch_due` (a SELECT) and `clear_entry` (a DELETE) run against it. There is no parameter to pass the `reader_pool` for the SELECT and the writer pool for the DELETE — a divergence from the `cache::*_split` pattern used throughout the cache layer.
- **Why it matters:** Per AGENTS.md "Background tasks use split read/write pools — reads from reader pool, writes only for the final transaction" (split-pool invariant). This sweeper is a background task and runs SELECTs on the writer pool, regressing the latency invariant the split-pool design protects.
- **Cost:** S (<2h)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add a `read_pool: &SqlitePool` parameter to `sweep_once` and `spawn_sweeper`, route `fetch_due` to it, and keep `clear_entry` on the writer pool — mirroring the existing `cache::*_split` helpers. **Needs user approval per AGENTS.md Architectural Stability** — adding the `read_pool` parameter is an API-shape change to a public helper.
- **Pass-1 source:** 02/F16
- **Status:** Open

### I-Materializer-2 — `pending_count` is fully `pub` despite module being `pub mod retry_queue`
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/retry_queue.rs:141-146`, `src-tauri/src/materializer/mod.rs:7`
- **What:** `pub async fn pending_count` is reachable as `crate::materializer::retry_queue::pending_count` (the module is `pub mod retry_queue;` in `mod.rs:7`). Other helpers in the same module (`record_failure`, `fetch_due`, `clear_entry`, `task_from_row`, `RetryKind`) are `pub(crate)`. Only `pending_count`, `sweep_once`, and `spawn_sweeper` are fully `pub`.
- **Why it matters:** API stability surface — unnecessarily wider than the module's other helpers. Not a security or correctness issue, but inconsistent with the rest of the module's visibility hygiene.
- **Cost:** S (<2h)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Tighten `pending_count` to `pub(crate)` to match `record_failure` / `fetch_due` / `clear_entry`. Audit `sweep_once` / `spawn_sweeper` similarly — leave them `pub` only if a concrete crate-external caller exists.
- **Pass-1 source:** 02/F22
- **Status:** Open

### I-Materializer-3 — `MaterializeTask::Clone` clones `String`s on the bg-side hot path
- **Domain:** Materializer
- **Location:** `src-tauri/src/materializer/mod.rs:22-57`, `src-tauri/src/materializer/consumer.rs:232`, `src-tauri/src/materializer/consumer.rs:250`
- **What:** `MaterializeTask` derives `Clone`. The `Barrier(Arc<Notify>)` variant is cheap (refcount bump), but the per-block variants own a `String block_id` and `ApplyOp(OpRecord)` / `BatchApplyOps(Vec<OpRecord>)` own owned `String` payloads. The bg consumer clones the task once before the first attempt (`consumer.rs:232`) and again on each retry (`consumer.rs:250`) — for `ApplyOp` this is two `OpRecord`-sized String allocations per retry. Overlaps with M-10 (which targets the `BatchApplyOps` case specifically).
- **Why it matters:** Per-op allocations accumulate under sustained load (sync catch-up, batch replays). Not severe, but the same Arc-wrapping fix that closes M-10 also collapses these clones to refcount bumps.
- **Cost:** S (<2h)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Wrap the variants' owned data in `Arc` (e.g. `ApplyOp(Arc<OpRecord>)`, `BatchApplyOps(Arc<Vec<OpRecord>>)`, `block_id: Arc<str>`) so all clones are cheap. Touches every dispatch site but is largely mechanical and pairs naturally with the M-10 fix.
- **Pass-1 source:** 02/F23
- **Status:** Open

### Cache

### I-Cache-1 — `Cursor` doc undocuments `list_page_history`'s composite cursor overload
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/pagination/mod.rs:140-150` (Cursor doc); used by `src-tauri/src/pagination/history.rs:71-165`
- **What:** The Cursor doc-comment enumerates per-field uses up to "`seq` — set by `list_block_history` (keyset on `seq, device_id`)". `list_page_history` also uses `seq`, plus reuses `deleted_at` as a stash for `created_at`, plus uses `id` as a stash for `device_id` — three overloads simultaneously. The doc never mentions the composite usage; the next maintainer extending this would likely add a new field rather than recognise the overload pattern.
- **Why it matters:** Future cursor-bearing queries (op-log filtering, block-history-by-author) risk adding redundant fields instead of reusing the overload pattern.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Extend the `Cursor` doc block to enumerate `list_page_history` explicitly: "stores `created_at` in `deleted_at`, `seq` in `seq`, and `device_id` in `id`". Better yet, rename `deleted_at` to `secondary_str` or move to a typed enum.
- **Pass-1 source:** 03/F9
- **Status:** Open

### I-Cache-2 — `pagination/mod.rs` doc claims cursor opacity but `Cursor` is `pub`
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/pagination/mod.rs:14-16` (doc) and `:151-162` (`pub struct Cursor`)
- **What:** The module-level doc says "the API surface remains small and the cursor remains opaque to callers anyway". But `Cursor` is `pub` and re-exported, used in tests and indirectly by `commands/blocks/queries.rs` via `PageRequest::new`. Anyone with the type can construct a `Cursor` with arbitrary field combinations, encode it, and pass it to any list query — defeating the opacity claim. The intended boundary is "callers exchange opaque base64 strings" but the type is more permissive.
- **Why it matters:** A caller could construct a malformed cursor in Rust (e.g., `deleted_at = Some(...)` for a `list_children` cursor) and call `list_trash` with it; the type system doesn't prevent that.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Make `Cursor` `pub(crate)` (or `pub(super)`) and only expose the encoded `String` form via `PageRequest`. Replace test usages of `Cursor::encode()` with helpers that build a cursor for a specific list query.
- **Pass-1 source:** 03/F18
- **Status:** Open

### I-Cache-3 — `MAX_SQL_PARAMS` constant duplicated locally in `block_tag_refs.rs`
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/cache/block_tag_refs.rs:18-22`
- **What:** `MAX_SQL_PARAMS = 999` and `REBUILD_CHUNK = MAX_SQL_PARAMS / 2` are defined locally. The same bulk-INSERT pattern in `apply_snapshot` (per AGENTS.md backend pattern #6) carries its own copy. SQLite's parameter limit changed to 32766 by default in 3.32, so the constants in different modules will eventually drift. The comment "block_tag_refs has 2 columns per row" is correct today; if a column is added, the chunk-size math here needs to be updated alongside the new column wiring.
- **Why it matters:** Low-risk drift, but a single source of truth would prevent it.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Promote `MAX_SQL_PARAMS` to a crate-level constant in `db/mod.rs` (or similar shared module) and let each call site compute `chunk = MAX_SQL_PARAMS / N_COLS`. Add a `debug_assert!(chunk * N_COLS <= MAX_SQL_PARAMS)`.
- **Pass-1 source:** 03/F21
- **Status:** Open

### I-Cache-4 — `total_count` deliberately omitted; documented and consistent
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/pagination/mod.rs:8-11` (doc) and `:171-179` (`PageResponse`)
- **What:** AGENTS.md Backend Pattern #4 ("`total_count` uses post-filter count") only applies when a query post-filters; the pagination module deliberately omits `total_count` — clients detect end-of-results via `has_more = false`. Verified: none of the eight paginated functions return a count. ARCHITECTURE.md confirms the convention.
- **Why it matters:** Confirms invariant #4 has nothing to enforce within this module — flagged for completeness so a future reviewer can see scope adherence at a glance.
- **Cost:** —
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** No action — informational only.
- **Pass-1 source:** 03/F22
- **Status:** Open

### I-Cache-5 — `extract_date_for_cursor` is a nested fn inside `list_agenda_range`
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/pagination/agenda.rs:109-119` (definition) and `:124` (callsite)
- **What:** `extract_date_for_cursor` is defined as a nested function (not a closure) inside `list_agenda_range` and called once. The surrounding file uses inline closures for cursor builders, so this is stylistically odd. Worth noting only because the nested fn obscured the underlying H-1 bug ("cursor encodes wrong date for property/tag-source rows") during initial reading.
- **Why it matters:** Style nit; flagged because the indirection contributed to the H-1 misread.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** After fixing H-1 (select `ac.date` directly into the row type), this nested fn becomes unnecessary and can be removed.
- **Pass-1 source:** 03/F23
- **Status:** Open

### I-Cache-6 — `space_filter_clause!` SQL inlined at four sites without an oracle
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/pagination/mod.rs:54-84` (FEAT-3 Phase 2 comment block); referenced from `src-tauri/src/pagination/hierarchy.rs` and `src-tauri/src/pagination/trash.rs`; macro itself in `crate::space_filter_clause!`
- **What:** Several comments reference `crate::space_filter_clause!` as the canonical source, with the contract that any change to the SQL fragment must be mirrored across `list_children`, `list_by_type`, `list_trash`, and `fts::search_fts`. The macro is out of scope for this review (lives at crate root). The doc honestly notes "`sqlx::query_as!` requires a string literal and does not accept `concat!()`, so the fragment is inlined at each compile-time-checked callsite." With the SQL inlined at four sites, drift is a real maintenance risk.
- **Why it matters:** When FEAT-3 Phase 4 expands the filter to agenda/tag/backlink paths (per the REVIEW-LATER FEAT-3 note in `commands/blocks/queries.rs`), each new callsite has to copy the SQL exactly.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Out of scope here (touches `crate::space_filter_clause!`), but worth flagging to the next reviewer touching `fts.rs` or the agenda paths. An SQL-level oracle test asserting each callsite matches a single `const FRAGMENT: &str = "…"` would help.
- **Pass-1 source:** 03/F24
- **Status:** Open

### I-Cache-7 — Two projected-agenda tests use weak `count > 0` assertions
- **Domain:** Cache + Pagination
- **Location:** `src-tauri/src/cache/tests.rs:2166-2169` and `:2324-2327`
- **What:** Two tests assert `count > 0` rather than the exact expected count. The number of weekly projections from a date 3 days ago over the 365-day horizon is computable and deterministic (~53). A `>` assertion catches "completely broken" but misses "off-by-one" or "horizon truncation" regressions.
- **Why it matters:** Weak assertions miss regressions like "horizon shrunk to 30 days" or "first occurrence elided".
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Replace with exact-count assertions. The tests already pin `today` from `chrono::Local::now()` and compute `due` relative to it, so the expected count is derivable. (Combine with L-26's clock-injection recommendation for stable midnight behaviour.)
- **Pass-1 source:** 03/F25
- **Status:** Open

### Commands CRUD

### I-CommandsCRUD-1 — `undo_page_op_inner` uses `LIMIT 1 OFFSET ?2` to fetch the Nth recent op
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/history.rs:410-465`
- **What:** AGENTS.md invariant #3 says no offset pagination; this query uses `OFFSET ?2` where `?2 = undo_depth`, validated to `[0, 1000]`. It is not a list endpoint — it fetches a single row N steps back — but the literal SQL is offset-based.
- **Why it matters:** Performance is fine (cap of 1000, indexed `(created_at DESC, seq DESC)` order). It is mainly a documentation gap: the codebase's pattern matrix has no carve-out for "fetch Nth row" semantics.
- **Cost:** S
- **Risk:** Medium
- **Impact:** Low
- **Recommendation:** Document the rationale inline and add a one-line carve-out in AGENTS.md "Backend Patterns" so reviewers don't flag this. No code change unless the 1000 cap is later raised.
- **Pass-1 source:** 04/F10
- **Status:** Open

### I-CommandsCRUD-2 — ULID `block_id` parameters are not normalised at the SQL boundary
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/blocks/crud.rs:217-223,275-279,345-347,436-438`, `blocks/move_ops.rs:59-64`, `tags.rs:54-59`, `pages.rs:39-44`, etc.
- **What:** AGENTS.md invariant #8 mandates ULID uppercase normalisation. `BlockId::from_trusted` (`ulid.rs:63`) normalises on construction, so op-log payloads stay canonical, but every command in this scope passes the raw `block_id: String` arg to `sqlx::query!("... WHERE id = ?", block_id)`. SQLite text comparison is byte-exact, so a lowercase input would silently fail the existence check.
- **Why it matters:** Defence in depth. Frontend convention is uppercase today, but a future MCP tool, sync replay, or scripted import emitting lowercase would surface confusing `NotFound` errors with no log trace.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either normalise `block_id` once at the top of each `inner_*` function (`let block_id = block_id.to_ascii_uppercase();`), or change typed signatures to `BlockId` (which already normalises) — the latter eliminates the class.
- **Pass-1 source:** 04/F16
- **Status:** Open

### I-CommandsCRUD-3 — Doc/code drift between `AGENTS.md` (CQRS invariant) and `commands/mod.rs` module-doc
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/mod.rs:1-9` vs `AGENTS.md:35-46` (key invariant #2)
- **What:** AGENTS.md invariant #2 says "commands write ops → materializer writes derived state". `commands/mod.rs`'s module-doc says the opposite: every command writes both the op record and the materialised mutation in a single IMMEDIATE transaction; the materializer only rebuilds derived caches. Reading the code, the module doc is correct.
- **Why it matters:** Reviewers using AGENTS.md as the source of truth would (correctly, per the literal text) flag every command as a CQRS violation. The invariant should reflect the hybrid model the codebase actually implements.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Rephrase invariant #2 as "commands write both the op log and primary state atomically; materializer rebuilds derived caches". Otherwise file a `MAINT-*` item tracking the doc-drift. **Requires user approval per AGENTS.md self-rule.**
- **Pass-1 source:** 04/F17
- **Status:** Open

### I-CommandsCRUD-4 — `page_aliases` is mutated outside the op log and not replicated by sync
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/pages.rs:33-90`
- **What:** `set_page_aliases_inner` and `get_page_aliases_inner` work directly against the `page_aliases` table without writing any `OpPayload`. There is no `SetPageAliases` op type (verified by grep on `src-tauri/src/op.rs`). Aliases are included in snapshots, so they will reach a peer eventually, but day-to-day op replay does not propagate them.
- **Why it matters:** AGENTS.md "Architectural Stability" reverses this: a feature needing a new op type should be discussed first. The inverse — per-page metadata maintained outside the op log — is a deliberate-but-undocumented design choice that confuses new maintainers.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Document the design choice in `pages.rs` and `ARCHITECTURE.md §20`. If full op-log integration is intended later, file a `MAINT-*` item; do not add an op type without approval per Architectural Stability.
- **Pass-1 source:** 04/F18
- **Status:** Open

### I-CommandsCRUD-5 — `list_blocks_inner` silently drops `space_id` on the agenda and tag filter paths
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/blocks/queries.rs:46-69` (filter dispatch), context lines `:76-79`
- **What:** The `filter_count` array does not include `space_id`. A caller passing `space_id = Some(...)` plus, say, `agenda_date = Some(...)` yields `filter_count = 1`, the agenda path runs, and the doc-comment notes the agenda/tag paths remain space-unscoped in Phase 2 — meaning `space_id` is silently ignored without an error.
- **Why it matters:** Frontend callers expect `space_id` to scope the result; for these two paths it doesn't, and there is neither a warning nor a `Validation` error. Documented as a Phase-4 follow-up but the silent drop is surprising in the meantime.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Reject `space_id != None` on the agenda and tag paths with `AppError::Validation("space_id is not supported on this filter (FEAT-3 Phase 4)")`, or plumb `space_id` through `list_agenda` / `list_by_tag`. The validation route is the cheap-and-honest option.
- **Pass-1 source:** 04/F20
- **Status:** Open

### I-CommandsCRUD-6 — `validate_date_format` accepts impossible dates (e.g. Feb 30) at the SQL boundary
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/mod.rs:331-388` and consumer `src-tauri/src/commands/agenda.rs:125-128`
- **What:** The validator's docstring says "It does NOT reject dates like Feb 30; the DB/agenda query handles that gracefully." However, `list_projected_agenda_inner` re-parses with `chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")` which rejects impossible combinations with a different error ("invalid start_date"). The same input fails differently depending on which command consumes it.
- **Why it matters:** Inconsistent failure shape; agenda batch endpoints accept Feb 30 silently and produce empty results, wasting a query and confusing callers.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either upgrade `validate_date_format` to call `chrono::NaiveDate::parse_from_str` once and reject impossible combinations, or remove the redundant secondary parse and rely on the structural check. Pick one and make every command consistent.
- **Pass-1 source:** 04/F21
- **Status:** Open

### I-CommandsCRUD-7 — `list_property_keys` / `list_property_defs` / `list_tags` return unbounded `Vec` with no cursor
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/properties.rs:19-21,459-469`, `src-tauri/src/commands/tags.rs:243-262`
- **What:** AGENTS.md invariant #3 mandates cursor pagination on every list query. These three commands return raw `Vec<String>` / `Vec<PropertyDefinition>` / `Vec<TagCacheRow>` with at most a `limit` parameter (no cursor, no `next_cursor`). Result sets are tiny in practice (dozens of property keys, hundreds of tags), but the invariant is unconditional.
- **Why it matters:** Either the invariant should explicitly carve out small-cardinality lookup tables, or these queries should adopt cursors. Today's drift is in the doc, not the data.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add a sentence to AGENTS.md "Backend Patterns" exempting named small-cardinality lookups, or migrate them to cursor pagination. The latter is mechanical given the existing `PageResponse` helpers.
- **Pass-1 source:** 04/F22
- **Status:** Open

### I-CommandsCRUD-8 — Two ISO-date validators (`validate_date_format` and `is_valid_iso_date`) coexist and partly overlap
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/mod.rs:331-388` (`validate_date_format`) vs `src-tauri/src/commands/properties.rs:322-339` (`is_valid_iso_date`)
- **What:** Both functions structurally validate `YYYY-MM-DD` with month 01-12 and day 01-31. `validate_date_format` returns `Result<(), AppError>` with descriptive messages; `is_valid_iso_date` returns `bool`. They are kept in sync by hand and `is_valid_iso_date` is re-exported via `pub(crate)` through `mod.rs:300`.
- **Why it matters:** Drift between these helpers will produce asymmetric validation depending on which command runs. Easy to consolidate.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Implement `is_valid_iso_date(s)` as `validate_date_format(s).is_ok()` (or vice-versa) so there is one source of truth.
- **Pass-1 source:** 04/F23
- **Status:** Open

### I-CommandsCRUD-9 — `restore_all_deleted_inner` / `purge_all_deleted_inner` infer roots via shared `deleted_at` timestamp (collision under load)
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/blocks/crud.rs:766-849` (restore), `:864-1073` (purge)
- **What:** Root inference uses `b.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM blocks p WHERE p.id = b.parent_id AND p.deleted_at = b.deleted_at)`. Two roots deleted at the same RFC3339 millisecond in distinct cascade events would be treated as one root. `now_rfc3339()` produces millisecond precision and isn't strictly monotonic across pool connections.
- **Why it matters:** A missing op record means a peer device replaying the op log will not know one of the subtrees was restored/purged, leaving divergent state. Likelihood is low but non-zero under load.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Track roots explicitly via the cascade path — either record the originating block-id in op_log payloads or add a side table — so bulk operations replay exactly the ops performed. Alternatively, accept the heuristic and document the collision-window as a known limitation.
- **Pass-1 source:** 04/F24
- **Status:** Open

### I-CommandsCRUD-10 — `apply_reverse_in_tx` asymmetric `rows_affected` behaviour across op types
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/history.rs:32-212`
- **What:** Reverses for `AddTag`, `SetProperty`, `DeleteBlock`, `RestoreBlock` are treated as idempotent (no `rows_affected` check), while reverses for `EditBlock`, `MoveBlock`, `DeleteProperty`, `DeleteAttachment`, `AddAttachment` error on zero rows. The doc-comment explains the rationale (cascade vs user-visible live block) but the asymmetry breaks `revert_ops_inner` batches: an early `NotFound` rolls back the whole tx.
- **Why it matters:** Subtle. Today's undo flow may produce user-visible "no-op-able" failures when one property in a batch is already absent (because the user manually cleared it after the original op).
- **Cost:** S
- **Risk:** Medium
- **Impact:** Medium
- **Recommendation:** Audit the asymmetry deliberately — either treat `DeleteProperty` / `DeleteAttachment` / `EditBlock` / `MoveBlock` reverses as idempotent (matching the AddTag/SetProperty side), or treat all as strict. Pick one, document it, and adjust the apply path.
- **Pass-1 source:** 04/F26
- **Status:** Open

### I-CommandsCRUD-11 — `usize::try_from(cnt).unwrap_or(0)` for SQL `COUNT(*)` is the wrong fallback
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/queries.rs:228-232`, `src-tauri/src/commands/agenda.rs:56-60,93-99`
- **What:** A non-negative `i64` from `COUNT(*)` cannot fail to convert to `usize` on 64-bit targets, but the code uses `unwrap_or(0)` as a fallback. If the conversion ever did fail (impossible today), silently returning 0 would hide the defect.
- **Why it matters:** Minor, but inconsistent with the codebase's "no silent failures" stance and the materializer's anti-swallow rule.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Replace with `.expect("COUNT(*) is non-negative")` (the panic case is unreachable) or propagate `AppError::InvalidOperation` with the offending value. Pick whichever matches the per-file convention.
- **Pass-1 source:** 04/F29
- **Status:** Open

### I-CommandsCRUD-12 — `get_page_inner` hardcodes `NULL_POSITION_SENTINEL = i64::MAX`
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/pages.rs:478-487`
- **What:** The inline-constant doc-comment justifies the hardcode as: "`pagination::NULL_POSITION_SENTINEL` is `pub(crate)` so we hard-code its value here rather than widening visibility. `i64::MAX` is reserved for this sentinel throughout the codebase." This duplicates a value across module boundaries; if the sentinel is ever changed in `pagination`, this site silently diverges.
- **Why it matters:** Single-line drift hazard. Trivial to fix.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Re-export `pagination::NULL_POSITION_SENTINEL` through the module's public surface (it already participates in on-the-wire keysets), or add a `#[cfg(test)]` assertion that the hard-coded value matches the source of truth.
- **Pass-1 source:** 04/F31
- **Status:** Open

### I-CommandsCRUD-13 — Missing test coverage for the `is_conflict = 0` filter on the `move_block_inner` cycle CTE
- **Domain:** Commands (CRUD)
- **Location:** `src-tauri/src/commands/tests/block_cmd_tests.rs` (no test asserts conflict-aware cycle detection); paired with `move_ops.rs:87-100`
- **What:** A grep over `block_cmd_tests.rs` for "conflict" tests involving the move path returns nothing that exercises a conflict-copy ancestor. AGENTS.md "Backend Patterns" #1 explicitly lists conflict filtering on recursive CTEs as the most-caught review issue, and the cycle CTE in `move_block_inner` is the canonical site for this regression class.
- **Why it matters:** Regressions are likely without a test; the missing CTE filter (tracked elsewhere as a cross-domain Pass-2 high) is exactly the kind of bug this codebase tries to catch.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Add a regression test alongside any cycle-CTE filter fix: build a chain `A -> B -> C` where `B` has a conflict copy `B'` whose `parent_id` is altered to point at `C`; attempt `move_block(A, new_parent=C)` and assert the cycle is correctly detected without spuriously matching `B'`.
- **Pass-1 source:** 04/F33
- **Status:** Open

### Commands System

### I-CommandsSystem-1 — PERF-23 verification: `read_attachment_file` still buffers the whole file
- **Domain:** Commands (System)
- **Location:** `src-tauri/src/sync_files.rs:182-195` (cross-ref; the command-side relies on this for sync transfer initiation and `read_attachment_file_cmd`)
- **What:** Per the review-brief PERF-23 item, `read_attachment_file` calls `std::fs::read(&full_path)` which loads the entire attachment into a `Vec<u8>` before the blake3 hash and chunked send. REVIEW-LATER.md:578-586 already records this as a deliberate non-fix ("Decision: Defer"). Confirmed unchanged in this pass.
- **Why it matters:** Holds steady — listed only to close the review-brief checklist item; no regression observed.
- **Cost:** S/M (sketch already in REVIEW-LATER)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Leave as-is per the existing REVIEW-LATER decision; revisit only if attachment-size profile changes.
- **Pass-1 source:** 05/F33
- **Status:** Open

### Sync

### I-Sync-1 — `SyncMessage::SnapshotAccept` / `SnapshotReject` arriving on the orchestrator path are silently `Ok(None)`
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_protocol/orchestrator.rs:448-454`
- **What:** `SnapshotOffer` correctly returns `Err(InvalidOperation("…must be handled by snapshot_transfer…"))` with a comment saying "must never be reached". The very next arm `SnapshotAccept | SnapshotReject => Ok(None)` swallows silently — yet by the same protocol invariant these messages also belong to `snapshot_transfer`, not to the orchestrator state machine.
- **Why it matters:** A regression that leaks Snapshot-control messages into the orchestrator path will silently no-op instead of surfacing — the same invariant violation, treated inconsistently.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Mirror the `SnapshotOffer` treatment for `SnapshotAccept` and `SnapshotReject` — `Err(InvalidOperation("must be handled by snapshot_transfer"))`.
- **Pass-1 source:** 06/F33
- **Status:** Open

### I-Sync-2 — `expected text/binary message, got {:?}` formats multi-MB binary payloads
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_net/connection.rs:117, 141`
- **What:** Both `recv_json` and `recv_binary` produce error strings via `format!("expected … got {:?}", other)` where `other: tungstenite::Message`. The `Debug` impl for `Message::Binary(Vec<u8>)` renders the entire byte buffer.
- **Why it matters:** A 5 MB binary frame received in a place expecting JSON formats ~5 MB of text into the error string. Log explosion on protocol mismatch — observability/footprint nit.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Log the discriminant only: `format!("expected text message, got {:?}", std::mem::discriminant(&other))`. Or build a small helper that prints `Binary({N} bytes)` instead of the full payload.
- **Pass-1 source:** 06/F34
- **Status:** Open

### I-Sync-3 — `is_complete` only checks `Complete`, not the broader terminal set
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_protocol/orchestrator.rs:471-483`
- **What:** `is_complete()` returns true only for `SyncState::Complete`; `is_terminal()` returns true for `Complete | Failed(_) | ResetRequired`. Callers must remember which one to use — `run_sync_session` uses both at different points (`while !orch.is_terminal()` for main loop control; `if orch.is_complete()` to gate file transfer).
- **Why it matters:** Maintainability — confusing API surface. The file-transfer gate is correctly on `is_complete()` (so `ResetRequired` skips it in favour of snapshot transfer), but no test asserts that a sync ending in `Failed(_)` skips file transfer.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Rename `is_complete` to `is_succeeded` (or `is_complete_success`) and add a rustdoc that contrasts it with `is_terminal`. Add a test that `Failed(_)` skips file transfer.
- **Pass-1 source:** 06/F53
- **Status:** Open

### I-Sync-4 — `OpTransfer` and `OpRecord` are structurally identical
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_protocol/types.rs:18-58`; cross-ref `src-tauri/src/op_log.rs:13`
- **What:** Both structs carry the same fields (`device_id`, `seq`, `parent_seqs`, `hash`, `op_type`, `payload`, `created_at`); `From<OpRecord> for OpTransfer` and the reverse are pure pass-through. `OpRecord` derives `Serialize`/`Deserialize` too, so the wire-vs-DB split is purely conventional.
- **Why it matters:** Minor maintenance burden — every new field lands twice. No runtime cost.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either keep them as a deliberate boundary (no change, document why) or collapse into a single `pub type OpTransfer = OpRecord;`. Pick one and write the choice down.
- **Pass-1 source:** 06/F54
- **Status:** Open

### I-Sync-5 — `MdnsService::shutdown` consumes `self`
- **Domain:** Sync
- **Location:** `src-tauri/src/sync_net/websocket.rs:103-109`; caller at `src-tauri/src/sync_daemon/orchestrator.rs:284-288`
- **What:** `pub fn shutdown(self) -> Result<(), AppError>` takes ownership; on `Err` the caller has already consumed the daemon and can only log.
- **Why it matters:** Negligible. Shutdown failure is rare and the consumed-self signature actually matches "this is a one-shot operation".
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Accept as-is. If revisited later, an `&mut self` signature with an internal `idempotent: bool` flag would be slightly more conservative, but not worth the churn today.
- **Pass-1 source:** 06/F55
- **Status:** Open

### Search & Links

### I-Search-1 — Stale doc comment in `search_fts` claims `unicode61` tokenizer; actually `trigram`
- **Domain:** Search & Links
- **Location:** `src-tauri/src/fts/search.rs:190-197`
- **What:** The "Known limitation: CJK tokenization" doc block says "The FTS5 table uses the default `unicode61` tokenizer". Migration `0006_fts5_trigram.sql:13` switched to `tokenize = 'trigram case_sensitive 0'` precisely to fix CJK substring search. The comment is actively misleading.
- **Why it matters:** Future contributors reading the doc may plan a tokenizer migration that already happened, and may misdescribe FTS behaviour in support replies.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Replace the comment with a description of the trigram tokenizer (3-char minimum substring, ~3× index size, case-insensitive per `case_sensitive 0`). Match ARCHITECTURE.md §9.
- **Pass-1 source:** 07/F6
- **Status:** Open

### I-Search-2 — `sanitize_fts_query` does not drop tokens shorter than 3 characters
- **Domain:** Search & Links
- **Location:** `src-tauri/src/fts/search.rs:113-146`
- **What:** ARCHITECTURE.md line 1049 states "Tokens shorter than 3 characters are dropped (trigram minimum)", but `sanitize_fts_query` does no length filtering — every non-operator token is wrapped in quotes and AND-joined. With the trigram tokenizer such sub-3-char tokens match nothing, so a query like `"a hi b world"` reduces to an unsatisfiable phrase set and returns zero hits even when "hi" / "world" are popular.
- **Why it matters:** UX: queries containing common short tokens ("the", "a", "of") silently return zero hits. Backlink test fixtures already work around this trap by using only ≥3-char terms (`tests.rs:1855`, `:3752`, `:3788`, `:3841`) — confirming the symptom is real.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium (search UX)
- **Recommendation:** Implement the documented behaviour: drop sub-trigram tokens before joining. Whitelist the 2-char operator `OR` (and 3-char `AND`/`NOT`) so they keep their operator semantics. Alternatively amend the doc to state actual semantics.
- **Pass-1 source:** 07/F7
- **Status:** Open

### I-Search-3 — Magic literal `LIMIT 10001` not derived from `FTS_ROW_CAP`
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/grouped.rs:344, 355`
- **What:** `const FTS_ROW_CAP: usize = 10_000;` is defined just above the SQL string, but the SQL embeds the +1 sentinel as inline literal `10001`. Bumping the constant alone leaves the SQL out of sync.
- **Why it matters:** Trivial maintainability footgun — easy to miss in review and silently breaks truncation detection.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Use `format!("… LIMIT {}", FTS_ROW_CAP + 1)` or bind `(FTS_ROW_CAP + 1) as i64`.
- **Pass-1 source:** 07/F9
- **Status:** Open

### I-Search-4 — `remove_inherited_tag` ancestor-walk consistency note (informational)
- **Domain:** Search & Links
- **Location:** `src-tauri/src/tag_inheritance.rs:140-145, 173-179, 285-292, 369-384`
- **What:** Ancestor recursive members in `remove_inherited_tag` and `recompute_subtree_inheritance` already bound `a.depth < 100`; the leaf join filters `b.is_conflict = 0` at projection. Reviewer's only observation is that the `is_conflict = 0` filter is omitted on the recursive ancestor walks themselves (intentional per the docstring at lines 369-384 — filtering on the walk would *under*-walk past a conflict ancestor).
- **Why it matters:** No bug. Worth a one-line comment on the ancestor-walk CTEs to record the intentional asymmetry, but the invariant is structurally satisfied today.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add a comment to each ancestor-walk CTE pointing at `remove_subtree_inherited`'s docstring explaining why `is_conflict = 0` is applied at projection rather than on the recursive member. No code change required.
- **Pass-1 source:** 07/F26
- **Status:** Open

### I-Search-5 — Tag-query oracle parity tests don't cover depth-100+ trees or conflict ancestors
- **Domain:** Search & Links
- **Location:** `src-tauri/src/tag_query/resolve/tests.rs:438-484, 870-1008`
- **What:** `materialized_matches_cte_oracle` builds a 3-level tree (PAGE_O → CHILD_O1/O2 → GRAND_O1); `oracle_validates_complex_boolean_expressions` exercises boolean combinators on similarly small fixtures. Neither test exercises the `depth < 100` boundary or a conflict ancestor in the parent chain. Combined with M-59 (oracle missing depth bound), the parity tests pass only in the safe regime where neither implementation hits its mutually exclusive failure modes.
- **Why it matters:** Test gap masks the asymmetry M-59 introduces. Adding a 105-level chain and a conflict-ancestor case would catch M-59 and any future regression.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add `materialized_matches_cte_oracle_at_depth_boundary` (build a 105-level chain, assert both helpers terminate consistently), and `materialized_skips_conflict_ancestor` (insert one conflict-copy ancestor and assert it doesn't propagate inheritance).
- **Pass-1 source:** 07/F27
- **Status:** Open

### I-Search-6 — No FTS sync test for "rename a tag, then immediately purge it before the materializer runs"
- **Domain:** Search & Links
- **Location:** `src-tauri/src/fts/tests.rs` (`reindex_fts_references` coverage)
- **What:** Existing tests cover the happy path (`reindex_fts_references_batches_correctly`), tag_refs variant, no-refs noop, batch-50-blocks, and the inline-only variant. None covers the order: (1) rename tag T, (2) `reindex_fts_references` enqueued, (3) T deleted/purged before reindex runs. Expected: `load_ref_maps` returns no entry for T, `strip_for_fts_with_maps` substitutes empty for T's references, fts_blocks for source blocks ends without T's old name.
- **Why it matters:** Documents the race-survivable contract of the reindex pipeline. Without the test, a future change to `load_ref_maps` could strand stale tag content in `fts_blocks`.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add a regression test that (1) inserts tag T, (2) inserts content block B referencing `#[T]`, (3) builds FTS, (4) deletes T, (5) runs `reindex_fts_references(pool, T)`, and asserts B's stripped content no longer mentions T's old name.
- **Pass-1 source:** 07/F28
- **Status:** Open

### I-Search-7 — `eval_unlinked_references` short-token "dead arm" in OR query
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/grouped.rs:296-340`
- **What:** When the page title sanitizes to a non-empty but trigram-unindexable token (e.g., 2-char `"AB"` → quoted `"AB"`) and an alias is valid, the combined OR-arm builder emits `("AB") OR ("Project" "Alpha")`. The `"AB"` arm contributes nothing under trigram FTS5 (no positions for ≤2 chars) and the OR collapses to the alias arm — net result is correct but the intermediate query has a dead arm. Tied to I-Search-2.
- **Why it matters:** Symptom of the broader documented-vs-actual sub-trigram filter gap (I-Search-2). Net result is correct today, but the dead arm is a smell that disappears once short-token filtering is added.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Resolved by I-Search-2 — once short-token filtering lands in `sanitize_fts_query`, this branch is correct by construction.
- **Pass-1 source:** 07/F29
- **Status:** Open

### I-Search-8 — `extract_meta_refresh_url` does not strip surrounding quotes from extracted URL
- **Domain:** Search & Links
- **Location:** `src-tauri/src/link_metadata/html_parser.rs:255-284` (line 276 in particular)
- **What:** The pattern matches `content="0;url=https://…"` and slices `content[url_pos + 4..].trim()` directly. If the URL is itself quoted (`content="0;url='https://…'"`), the leading `'` is preserved; downstream `extract_domain('https://…)` fails to parse, and `detect_auth_required`'s domain comparison degrades to a string-empty match — silent false negative for auth detection.
- **Why it matters:** Rare in practice but the failure mode is silent. Single-line fix.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Strip leading and trailing `'` and `"` from the extracted URL after `trim()`.
- **Pass-1 source:** 07/F31
- **Status:** Open

### I-Search-9 — `BacklinkFilter::BlockType` loads all blocks of type into memory
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/filters.rs:399-420`
- **What:** The filter loads every active block of the given type into memory as `FxHashSet<String>` then intersects with the base set. For `block_type = 'content'` on a 100k-block vault that's ~30 MB of `String` allocations to discard most of. The comment at lines 400-411 acknowledges the issue; the candidate-aware variant `resolve_filter_with_candidates` (lines 112-119) was added later for `PropertyIsEmpty` and now exists, making the "invasive signature change" no longer applicable.
- **Why it matters:** Pure allocation waste on every backlink query that includes a `BlockType` filter.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low/Medium
- **Recommendation:** Add a candidates-scoped path: `WHERE block_type = ?1 AND id IN (SELECT value FROM json_each(?2))` mirroring `PropertyIsEmpty`. Wire it from the top-level intersection point in `eval_backlink_query` / `eval_backlink_query_grouped` so the base-set ids serve as candidates.
- **Pass-1 source:** 07/F32
- **Status:** Open

### I-Search-10 — `tags_cache` JOIN in `BacklinkFilter::HasTagPrefix` doesn't filter conflict tag rows on the tag side
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/filters.rs:324-338`
- **What:** The query joins `tags_cache → block_tags → blocks` and filters `b.deleted_at IS NULL AND b.is_conflict = 0` on the *associating* block, not on the *tag* block. Conflict-copy tag blocks could surface via `tags_cache` if cache rebuild rules ever included them. Sister filter `HasTag` is unaffected because the tag id is fully specified by the caller.
- **Why it matters:** Defense-in-depth. Today `cache::rebuild_tags_cache` excludes conflict tag blocks, so the result is correct in practice; the SQL contract just doesn't make that dependency explicit.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either add a defensive `JOIN blocks t ON t.id = tc.tag_id WHERE t.is_conflict = 0`, or leave a comment pointing at the cache rebuild that guarantees this invariant.
- **Pass-1 source:** 07/F33
- **Status:** Open

### I-Search-11 — `Cursor` constructor verbosity at every encode site
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/query.rs:182-191`; `src-tauri/src/backlink/grouped.rs:226-236`, `:553-563`; `src-tauri/src/tag_query/query.rs:65-75`; `src-tauri/src/fts/search.rs:392-403`
- **What:** Five call sites construct the full `Cursor` struct inline with most fields set to `None` (`position`, `deleted_at`, `seq`, `rank`). Adding a new variant cursor field requires touching every site. (Verified via `rg "^\s*Cursor \{$" src-tauri/src` returning exactly five matches; aligned with the I-Search-19 enumeration.)
- **Why it matters:** Pure maintainability — error-prone fan-out. A `Cursor::for_id(id)` (and similar `for_id_rank`, `for_id_position`) constructor centralizes the boilerplate.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add `Cursor::for_id(id: String) -> Self` (and complementary builders) and replace the five inline constructions.
- **Pass-1 source:** 07/F35
- **Status:** Open

### I-Search-12 — `eval_backlink_query_grouped` group ordering ignores user `BacklinkSort`
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/grouped.rs:114-123, 162-167, 435-449`
- **What:** Groups are sorted alphabetically by `page_title` regardless of the user-supplied `BacklinkSort`. The user's sort applies only to within-group block ordering (lines 162-167). With `BacklinkSort::Created { Desc }` the user expects "newest source page first" across groups, but groups stay alphabetical.
- **Why it matters:** UX inconsistency — the flat backlink view honours the user's choice; the grouped view honours it only within groups. Users can't tell why their preference is partially ignored.
- **Cost:** M
- **Risk:** Medium
- **Impact:** Low/Medium
- **Recommendation:** Either (a) sort groups by the same criterion (using the latest member block's value as the group's sort key), or (b) document this asymmetry explicitly in the function docstring and in the UI's group view.
- **Pass-1 source:** 07/F36
- **Status:** Open

### I-Search-13 — `eval_unlinked_references` cursor uses `last.0` (page_id) — non-deterministic per M-62
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/grouped.rs:551-562` (encode), `:451-462` (skip_while)
- **What:** Cross-reference for M-62. The cursor encodes `last.0` (page_id of the last group on this page); the next request uses `skip_while(|(pid, _, _)| pid.as_str() != after_id)` on a freshly-built `group_list`. If the truncation set differs (M-62), the cursor's page_id may be missing in the new list and `skip_while` consumes everything → empty page.
- **Why it matters:** Resolves automatically once M-62 stabilizes the truncation boundary.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Addressed by M-62. No standalone fix needed; track here so reviewers don't apply two parallel fixes.
- **Pass-1 source:** 07/F37
- **Status:** Open

### I-Search-14 — `tag_query::eval_tag_query` final SELECT lacks defensive `is_conflict = 0` filter
- **Domain:** Search & Links
- **Location:** `src-tauri/src/tag_query/query.rs:52-58`
- **What:** The function fetches `BlockRow`s from `SELECT … FROM blocks WHERE id IN ({placeholders})` without a defensive `is_conflict = 0` or `deleted_at IS NULL` filter. It relies on `resolve_expr` to filter at the leaves; `TagExpr::Not` (`resolve.rs:139-161`) re-includes the universe with the filter applied, so the invariant is upheld today.
- **Why it matters:** No current bug, but a future change to the resolver could leak conflict copies through the final SELECT. Defense-in-depth at near-zero cost.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add `AND deleted_at IS NULL AND is_conflict = 0` to the final SELECT in `eval_tag_query`.
- **Pass-1 source:** 07/F38
- **Status:** Open

### I-Search-15 — `BacklinkSort::Created { Desc }` non-paginated path correct; bug isolated to `eval_backlink_query` cursor
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/sort.rs:18-26` (correct) vs `src-tauri/src/backlink/query.rs:111-119` (broken cursor)
- **What:** Cross-reference confirming that `sort_ids` handles `Desc` correctly via `b.cmp(a)`. The binary-search-on-desc bug (tracked separately as a High finding upstream of this expansion) is isolated to the cursor lookup in `eval_backlink_query`. `eval_backlink_query_grouped` and `eval_unlinked_references` use `skip_while` on group `pid`, not binary search on block id, so they don't share the bug.
- **Why it matters:** Scoping note for the upstream High finding — fixing the binary-search bug does not require touching the grouped helpers.
- **Cost:** S (confirmation only)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** No standalone action. Reference when scoping the fix for the upstream High finding so the change set stays minimal.
- **Pass-1 source:** 07/F39
- **Status:** Open

### I-Search-16 — `parse_title` HTML-entity decoding mishandles chained entity escapes
- **Domain:** Search & Links
- **Location:** `src-tauri/src/link_metadata/html_parser.rs:354-365`
- **What:** `decode_html_entities` is a chain of `.replace("&amp;", "&").replace("&lt;", "<").…` calls. Pass-1's worked example (`&amp;amp;`) does NOT exhibit the bug — `str::replace` rescans the result and finds no further `&amp;`. The bug is real for inputs like `&amp;lt;`: `.replace("&amp;", "&")` produces `&lt;`, then the next `.replace("&lt;", "<")` produces `<`. The user wrote `&amp;lt;` to encode the literal text `&lt;` and gets `<`.
- **Why it matters:** Page titles or descriptions with double-encoded entities (rare but real on poorly-encoded sites) come out wrong.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Reorder the replacements so `&amp;` is decoded LAST (so `&lt;`, `&gt;`, `&quot;`, `&nbsp;` are unwrapped first); or replace with a single-pass parser, or pull in a tiny `htmlentity` crate. Note Pass-2 caveat: any test added must use `&amp;lt;` (not the originally-cited `&amp;amp;`).
- **Pass-1 source:** 07/F42
- **Status:** Open

### I-Search-17 — `ms_to_ulid_prefix.unwrap()` lacks SAFETY comment
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/filters.rs:78-86`
- **What:** Line 85 calls `String::from_utf8(chars.to_vec()).unwrap()`. The bytes are sourced from `CROCKFORD_ENCODE` (line 74) — an ASCII-only constant — so the unwrap is genuinely panic-free. There is no comment justifying the unwrap.
- **Why it matters:** Future readers may flag this as a panic-risk and either replace it with error-propagating code (defensible but noisy) or leave it confused. A one-line SAFETY comment clarifies forever.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add `// SAFETY: chars are a subset of CROCKFORD_ENCODE which is ASCII; cannot fail UTF-8 validation.` immediately above the unwrap (or switch to `String::from_utf8_lossy(...).into_owned()` which is functionally identical here).
- **Pass-1 source:** 07/F43
- **Status:** Open

### I-Search-18 — Tests for `eval_backlink_query` with `Created { Desc }` + cursor are missing
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/tests.rs` — gap; closest tests at `:1003-1022` (`sort_created_desc`, single page) and `:1133-1162` (`pagination_cursor_works`, default Asc sort)
- **What:** No test combines `Created { Desc }` with cursor pagination past page 1. The two existing Desc tests assert single-page full-result correctness; `pagination_cursor_works` doesn't pass a sort and falls back to `Created { Asc }`. This is the gap that hides the upstream High `binary_search_by`-on-desc bug from CI.
- **Why it matters:** A single test would catch the entire bug class. Adding it both validates a future fix and prevents regression.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium (prevents regression of the High-severity fix)
- **Recommendation:** Add `pagination_cursor_works_for_created_desc` mirroring `pagination_cursor_works` but with `Some(BacklinkSort::Created { dir: SortDir::Desc })`. Add the analogous `pagination_cursor_works_for_property_text_desc` for `sort.rs`.
- **Pass-1 source:** 07/F44
- **Status:** Open

### I-Search-19 — `Cursor` rank/position/deleted_at/seq fields are part of encoded payload — schema-leak in cursor format
- **Domain:** Search & Links
- **Location:** `src-tauri/src/backlink/query.rs:182-191`, `src-tauri/src/fts/search.rs:392-403` and other encode sites
- **What:** The `Cursor` struct (defined in `pagination::cursor` outside this scope) bundles fields for multiple use cases (rank, position, seq, deleted_at, id). Different callers fill different subsets and emit them all in the encoded payload. There is no documented version field, so a future schema change likely invalidates persisted cursors.
- **Why it matters:** Tight coupling between every caller in this scope and the cursor schema; adding a new sort dimension is a cross-cutting change.
- **Cost:** S (defer)
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Defer to the pagination/cursor file review; flagged here to record the coupling. If a versioning fix lands, every Search & Links encode site will need updating.
- **Pass-1 source:** 07/F45
- **Status:** Open

### Lifecycle

### I-Lifecycle-1 — `merge_text` chain-walk uses both an iteration cap AND a visited-set
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/merge/detect.rs:51-67`
- **What:** The loop tracks `iterations` against `MAX_CHAIN_WALK_ITERATIONS = 1000` and also a `HashSet` of visited `(device_id, seq)` keys. Cycles are detected by the visited set in O(N); the iteration counter only fires on linearly-long-but-acyclic chains, which for a single block's edit chain cannot exceed the number of edits. Defensive belt-and-suspenders, not a bug.
- **Why it matters:** Future maintainer wonders which guard is "the real one" and may remove one. Documented in `chain_walk_detects_cycle` (line 1877) and `max_chain_walk_iterations_is_bounded` (line 2010).
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add a one-line comment explaining the iteration cap is a belt-and-suspenders guard for the corruption case where the visited set somehow misbehaves (memory corruption, OOM panic). Or remove the cap and rely on the visited set.
- **Pass-1 source:** 08/F18
- **Status:** Open

### I-Lifecycle-2 — `create_snapshot` rejects empty op_log with `AppError::Snapshot`
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/snapshot/create.rs:79-90`
- **What:** When `op_log` is empty, snapshot creation errors out with `AppError::Snapshot("cannot create snapshot: op_log is empty")`. That makes sense for compaction (nothing to compact), but a user calling "Create Snapshot" via a manual command on a fresh device gets an opaque error rather than an empty snapshot. Test `create_snapshot_empty_op_log` (line ~879) pins the current behaviour.
- **Why it matters:** Edge case that breaks "manual snapshot before first sync" UX.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Allow snapshot creation with an empty frontier (`up_to_seqs = {}`, `up_to_hash` = a deterministic empty marker like `""`); update the pinning test to assert the new behaviour.
- **Pass-1 source:** 08/F32
- **Status:** Open

### I-Lifecycle-3 — Test gap: no oracle parity for `compute_reverse(create_block)` and similar
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/reverse/tests.rs:25-37` and similar variant-only tests at lines 254-403
- **What:** `reverse_create_block_produces_delete_block` only checks the returned payload variant (`assert!(matches!(reverse, OpPayload::DeleteBlock(_) if p.block_id == "BLK1"))`). It does not check that applying the reverse op + the original op leaves the database in the original (empty) state. Same gap for `reverse_add_tag`, `reverse_remove_tag`, `reverse_add_attachment`.
- **Why it matters:** A reverse op that emits the wrong payload variant is caught; a reverse op that emits the right variant with the wrong field values is not.
- **Cost:** M
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Mirror the structure of `undo_chain_edit_round_trip` (line ~512) for every reversible op type: apply the original op → snapshot a "before" hash of the affected DB rows → apply the reverse → assert "before" matches.
- **Pass-1 source:** 08/F36
- **Status:** Open

### I-Lifecycle-4 — `MergeOutcome::ConflictCopy.original_kept_ours` is dead in the field
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/merge/types.rs:33-38`; `src-tauri/src/merge/apply.rs:84-87`
- **What:** The struct field is hardcoded to `true` at the only construction site in the codebase (`apply.rs:84`). There is no path that constructs `original_kept_ours: false`; the variant is vestigial.
- **Why it matters:** Future readers will spend time figuring out when the false branch fires. It never does.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either remove the field (caller is the only construction site, change is mechanical), or add a comment + future test stub for the symmetric "kept theirs" branch (which is not currently a possible outcome).
- **Pass-1 source:** 08/F41
- **Status:** Open

### I-Lifecycle-5 — `recovery::cache_refresh` always rebuilds tags+pages even for non-tag/page edits
- **Domain:** Lifecycle
- **Location:** `src-tauri/src/recovery/cache_refresh.rs:55-65`
- **What:** Every recovered draft batch triggers `RebuildTagsCache + RebuildPagesCache` (full O(N) rebuilds) — not per-block, but unconditional whenever `recovered_block_ids` is non-empty. The early-return at line 34 handles the empty case. Both calls are already outside the per-draft loop, but they always fire regardless of whether any recovered draft touched a tag/page block.
- **Why it matters:** Boot latency. Materializer dedup is supposed to collapse repeated calls, but unconditionally enqueueing both rebuilds wastes cycles on edits that touched neither tag nor page blocks.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Gate the two rebuild calls on a single query that detects whether any recovered draft block_id is a tag or page block (e.g., `SELECT 1 FROM blocks WHERE id IN (…) AND block_type IN ('tag', 'page') LIMIT 1`).
- **Pass-1 source:** 08/F42
- **Status:** Open

### MCP

### I-MCP-1 — `serve_pipe` shutdown bug (Windows-symmetric to the unix accept loop)
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/server.rs:670-701` (`serve_pipe`, in particular the unbounded `loop { server.connect().await?; ... }` body at lines 687-700).
- **What:** Symmetric to the `serve_unix` accept loop: `serve_pipe` is `loop { server.connect().await?; ... server = ServerOptions::new().create(pipe_path)?; }` with no `select!` on a shutdown signal. Returns only on a `connect`-time I/O error — never on graceful disable.
- **Why it matters:** Same root cause as the accept-loop disable bug; Windows-only manifestation. The "kill switch" toggle on Windows is just as ineffective until process restart as it is on unix.
- **Cost:** S — handled by the same shutdown-signal fix that addresses the unix accept loop.
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** When wiring the accept-loop shutdown signal, `select!` on it in `serve_pipe` too; on shutdown drop the current `NamedPipeServer` and return `Ok(())`.
- **Pass-1 source:** 09/F19
- **Status:** Open

### I-MCP-2 — `serve_pipe`'s second-instance `.create(pipe_path)` has no race guard
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/server.rs:691-693`; initial bind guard at `src-tauri/src/mcp/mod.rs:333-336` (`first_pipe_instance(true)`).
- **What:** After handing off the current pipe connection, `serve_pipe` re-creates the next server instance with `ServerOptions::new().create(pipe_path)?`. The `first_pipe_instance(true)` guard applies only on the initial bind; subsequent re-creates inherit the default `first_pipe_instance(false)` and trust that the original bind retains namespace ownership. If a second Agaric process raced on the same pipe, the re-creation would not fail loudly.
- **Why it matters:** A corner of a corner — the first-bind guard already detects double-launches, so the only way to hit this is for the first instance to die between accepts, which is itself unusual. Pure documentation gap.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Pass `first_pipe_instance(false)` explicitly on the re-create (it is the default, but explicit is better) and add a comment documenting "the initial bind serves as the per-process lock; subsequent `.create` calls inherit the namespace ownership".
- **Pass-1 source:** 09/F20
- **Status:** Open

### I-MCP-3 — Unknown notifications swallowed at `debug` level
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/server.rs:532-546` (`handle_notification`, fallback branch).
- **What:** `handle_notification` matches `notifications/initialized` and otherwise emits `tracing::debug!(target: "mcp", method = other, "ignoring unknown notification")`. Per JSON-RPC 2.0 notifications correctly receive no response, but logging at `debug` (not `info`/`warn`) means a misconfigured agent sending real MCP-spec notifications (`notifications/cancelled`, `notifications/progress`) is invisible without re-enabling the `mcp` log target.
- **Why it matters:** If FEAT-4 ever adopts MCP-spec cancellation/progress notifications and forgets to extend the match, debugging "the agent says it cancelled but the tool kept running" requires a log-level change.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Bump to `tracing::info!` (or `warn!`) for the unknown-notification branch, including the method name. Cheap diagnostic improvement; no behavioral change.
- **Pass-1 source:** 09/F21
- **Status:** Open

### I-MCP-4 — ARCHITECTURE.md does not mention MCP at all
- **Domain:** MCP
- **Location:** `/home/javier/dev/org-mode-for-the-rest-of-us/ARCHITECTURE.md` (zero matches for `MCP|mcp|FEAT-4`); cross-ref `AGENTS.md` documentation map and §"Threat Model".
- **What:** ARCHITECTURE.md is the ~1870-line deep-dive covering data model, op log, materializer, editor, sync, and search per AGENTS.md's documentation map. MCP shipped (FEAT-4a..h), but ARCHITECTURE.md has no section for it; the only architectural overview lives in REVIEW-LATER.md (a backlog file, not a stable reference) and inline doc comments.
- **Why it matters:** New contributors / reviewers expect every shipped backend module to live in the architecture doc. Today MCP is a documentation orphan.
- **Cost:** M (~100 LOC of prose)
- **Risk:** Low
- **Impact:** Medium (closes a real documentation gap that will cost future contributors hours)
- **Recommendation:** Add an "MCP server" section to ARCHITECTURE.md covering: transport (UDS / named-pipe), JSON-RPC framing, `ToolRegistry` trait + RO/RW impls, `ActorContext` task-local plumbing, activity ring + event emission, lifecycle (marker file, disconnect signal), and the threat-model carve-out (single-user local, no auth tokens, no malicious-agent budget). Cross-link from AGENTS.md §"Threat Model".
- **Pass-1 source:** 09/F22
- **Status:** Open

### I-MCP-5 — REVIEW-LATER.md FEAT-4 says "8 read tools" then "9" two paragraphs apart
- **Domain:** MCP
- **Location:** `REVIEW-LATER.md:302` ("v1 ships the RO socket + 8 read tools only"); `REVIEW-LATER.md:388` ("9 read tools"); `REVIEW-LATER.md:417` ("9 read tools"); shipped `src-tauri/src/mcp/tools_ro.rs:212-224` lists 9.
- **What:** REVIEW-LATER.md is internally inconsistent — line 302 says "8 read tools", lines 388 and 417 say "9". `ReadOnlyTools::list_tools()` ships 9.
- **Why it matters:** Cosmetic; affects no runtime behaviour. Confusing for anyone reading the FEAT-4 spec for a refresher.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Fix REVIEW-LATER.md line 302 to read "9 read tools".
- **Pass-1 source:** 09/F23
- **Status:** Open

### I-MCP-6 — `tool_response_get_agenda.snap` pins an empty agenda — does not exercise the populated wire shape
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/snapshots/agaric_lib__mcp__tools_ro__tests__tool_response_get_agenda.snap` (5 LOC, body is `[]`); test `src-tauri/src/mcp/tools_ro.rs:1755-1766`.
- **What:** `snapshot_get_agenda_response_shape` runs against an empty DB and snapshots `[]`. The wire-shape contract for a populated agenda (a `ProjectedAgendaEntry` with `block_id`, `date`, `repeat_kind`, `priority`, …) is therefore unpinned. A future refactor that renamed a field on `ProjectedAgendaEntry` would not break this snapshot. By contrast, `tool_response_search.snap` and `tool_response_list_pages.snap` include at least one entry.
- **Why it matters:** Snapshots are supposed to lock the wire contract; an empty snapshot locks only the array shape. Field rename slips through silently.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Seed one block with a `due_date` inside the test's date range, redact `block_id` / `date` via insta filters, and pin a single populated entry. Keeps the wire shape under test without making the snapshot date-dependent.
- **Pass-1 source:** 09/F24
- **Status:** Open

### I-MCP-7 — `ConnectionState` has no `Send + Sync` compile-time assertion
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/server.rs:96-103` (`ConnectionState`); existing `Send` future test at `src-tauri/src/mcp/registry.rs:236-246` (`placeholder_registry_call_tool_future_is_send`).
- **What:** Dispatch requires `ConnectionState` to be `Send` because it lives in the per-connection task spawned by `serve_unix` / `serve_pipe`. There is a `Send` test for the registry future, but no compile-time assertion on the struct itself; an accidental `Rc` or `RefCell` field would surface only at the spawn site.
- **Why it matters:** Defensive plumbing; today every field is `Send + Sync`. Adding the compile-time assertion is three lines and pins the contract at the struct definition.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add `fn assert_send_sync<T: Send + Sync>() {} #[test] fn connection_state_is_send_sync() { assert_send_sync::<ConnectionState>(); }` next to the struct.
- **Pass-1 source:** 09/F25
- **Status:** Open

### I-MCP-8 — `ActivityResult::Err` 200-char clip lacks a multi-byte UTF-8 boundary test
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/server.rs:478-484` (`let short: String = err.to_string().chars().take(200).collect();`); existing length-only assertion at `src-tauri/src/mcp/server.rs:2072-2076`.
- **What:** The clip uses `chars().take(200)` so multi-byte characters (emoji, CJK) are preserved correctly, but no test feeds a >200-char emoji-heavy error string to assert the panic-free / non-truncating-mid-codepoint path. Any regression to `String::from_utf8_unchecked` or `&str[..200]` would slip past the existing length test.
- **Why it matters:** Defensive — current implementation is correct; the test gap means a future "optimization" could regress it.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add one fixture / property test feeding `"💥".repeat(500).into()` (or similar mixed-script payload) and assert the result is exactly 200 `chars().count()` and round-trips cleanly through `serde_json`.
- **Pass-1 source:** 09/F27
- **Status:** Open

### I-MCP-9 — `agaric-mcp` stub-binary integration test is `#[ignore]` and not exercised in CI
- **Domain:** MCP
- **Location:** `src-tauri/src/mcp/mod.rs:719-786` (the test, including the `#[ignore]` gate at line 723 and the manual `cargo build --bin agaric-mcp` requirement).
- **What:** The end-to-end smoke test that drives the `agaric-mcp` stub binary against a local UDS is `#[ignore]`, requires a manual `cargo build --bin agaric-mcp`, and is not part of the default CI matrix. In-process dispatch is well-covered, but the actual binary path users invoke (stdio↔UDS bridge, `$AGARIC_MCP_SOCKET` env var, argv handling) is not regression-protected.
- **Why it matters:** Every agent config (Claude Desktop, Cursor) launches the stub binary, not the in-process server. A regression in argv parsing or env-var lookup slips past CI silently.
- **Cost:** M (add a `cargo build --bin agaric-mcp` step + run the ignored test in CI)
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Add `cargo build --bin agaric-mcp` as a CI step before nextest, and either remove the `#[ignore]` tag or replace it with a `#[cfg(feature = "ci-smoke")]` gate that CI enables. Keep the manual-run path documented for local dev.
- **Pass-1 source:** 09/F29
- **Status:** Open

### L-121 — ULID arguments not normalized to uppercase at the MCP boundary
- **Domain:** MCP
- **Location:** Typed args at `src-tauri/src/mcp/tools_ro.rs:104, 128, 134, 152, 161` and `src-tauri/src/mcp/tools_rw.rs:60, 69, 76, 91-92, 104`; backing query `src-tauri/src/commands/blocks/queries.rs:115` (`WHERE id = ?`, case-sensitive).
- **What:** AGENTS.md invariant #8 says ULIDs are uppercase Crockford base32 for blake3-hash determinism. The MCP tools accept `block_id` / `parent_id` / `tag_id` / `value_ref` / `page_id` as plain `String` and forward them verbatim to the `*_inner` helpers; SQLite's default `=` is case-sensitive, so a lowercase ULID returns `NotFound`.
- **Why it matters:** Today every Agaric tool returns uppercase ULIDs, so a round-trip "from-our-output, into-our-input" never trips this. Latent: an agent that copies a ULID from a third-party log or manipulates case would mysteriously hit `NotFound`.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Add a `normalize_ulid_arg` helper in `tools_ro.rs` / `tools_rw.rs` that uppercases ULID-shaped strings (length 26, base32 charset). Apply to every `*_id` field in the typed-arg structs, and document "IDs are case-insensitive at the MCP boundary; the server uppercases" in the tool descriptions.
- **Pass-1 source:** 09/F15
- **Status:** Open

### GCal / Spaces

### I-GCalSpaces-1 — `BlockId::from_trusted` uses Unicode `to_uppercase()`, divergent from `Deserialize`
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/ulid.rs:18-29` (Deserialize: `s.to_ascii_uppercase()`); `src-tauri/src/ulid.rs:63-65` (`from_trusted`: `s.to_uppercase()`)
- **What:** Two normalisation paths with different semantics — `Deserialize` uses ASCII-only `to_ascii_uppercase()`, `from_trusted` uses Unicode-aware `to_uppercase()` (where `"ß".to_uppercase() == "SS"`, `"ı".to_uppercase() == "I"`). ULIDs are Crockford base32 ASCII by spec so any well-formed ULID round-trips identically; non-ASCII inputs diverge.
- **Why it matters:** AGENTS.md invariant 8 pins "ULID uppercase normalization — Crockford base32 for blake3 hash determinism." Two normalisers means two ways to break determinism. Cross-referenced as L-3 in the Core domain — listed here for completeness because the spaces / gcal modules use `BlockId::from_trusted` heavily.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Change `from_trusted` to `Self(s.to_ascii_uppercase())` to match `Deserialize`. Add a regression test that pins `BlockId::from_trusted("ß").as_str() == "ß"` (i.e. ASCII-only path leaves non-ASCII unchanged) and that both paths round-trip the same set of inputs.
- **Pass-1 source:** 10/F9 (cross-ref L-3)
- **Status:** Open

### I-GCalSpaces-2 — `clock.today()` UTC bug compounds with `clamp_to_window` filter (second site)
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/dirty_producer.rs:423-429` (`clamp_to_window`)
- **What:** `clamp_to_window(dates, today)` is called from each `compute_for_*` helper with the caller-supplied `today`. Per the Clock-UTC-vs-Local High-severity finding (Pass-1 F3), production callers will get `today` from `Clock::today()` which currently returns UTC date. East-of-UTC users at 03:00 local have a UTC date one day behind their local date; events for "tomorrow local" become `today + 1` UTC; the clamp window still includes them but the connector pushes for the UTC window — agenda for "today local" is one day off until midnight UTC.
- **Why it matters:** Same root cause as the F3 High finding; pinning here so the next reviewer sees both sites and the materializer hook gets the right local date.
- **Cost:** S
- **Risk:** Low
- **Impact:** Medium
- **Recommendation:** Once the F3 fix lands (`Clock::today` switches to `chrono::Local::now().date_naive()`), confirm the materializer hook calls `compute_dirty_event(record, prior, chrono::Local::now().date_naive())` (or whatever the unified source-of-truth helper becomes) and not `Utc::now().date_naive()` directly.
- **Pass-1 source:** 10/F22
- **Status:** Open

### I-GCalSpaces-3 — `bootstrap_spaces` does not validate `device_id` shape
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/spaces/bootstrap.rs:39, 117-122`
- **What:** `device_id: &str` is passed straight through to `op_log::append_local_op_in_tx`. The op_log is keyed by `(device_id, seq)` — a malformed or empty `device_id` corrupts the chain. There is no shape check (length, character set). All other op-emission paths share the same property; this is just the first new caller after the spaces feature shipped.
- **Why it matters:** Defensive coding around the op-log primary key. Bootstrap is boot-fatal so a corrupt `device_id` is obvious immediately; no active bug.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** No-op unless a single shared `device_id` validator emerges. If one does (e.g. matching `^[0-9A-Z]{26}$` for ULID-shaped ids, or whatever spec is canonical), call it from `bootstrap_spaces` and from the other op-emission entry points.
- **Pass-1 source:** 10/F28
- **Status:** Open

### I-GCalSpaces-4 — `fill_full_window` doc-clarity gap on the `parse_window_days` clamp
- **Domain:** GCal / Spaces / Drafts
- **Location:** `src-tauri/src/gcal_push/connector.rs:801-807` (`fill_full_window`); clamp at `src-tauri/src/gcal_push/connector.rs:404-408` (`parse_window_days`); test at `src-tauri/src/gcal_push/connector.rs:1815-1820`.
- **What:** `for i in 0..window_days.max(0)` — if `window_days` is 0 or negative, the loop body never runs and `dirty` stays empty. The only current caller (`parse_window_days`) clamps inputs to `[MIN_WINDOW_DAYS, MAX_WINDOW_DAYS] = [7, 90]` for valid integers and returns `DEFAULT_WINDOW_DAYS = 30` on empty/garbage, so today the `<= 0` branch is unreachable in production. The doc on `fill_full_window` does not call out this caller-side invariant; a future caller that constructs the value through a different path could pass 0 and silently disable push.
- **Why it matters:** Doc-clarity gap, not a live bug. The caller-of-record (`parse_window_days`) closes the path; the function-level docstring should make the clamp dependency explicit so a future caller does not silently bypass it.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Document the caller-side invariant on `fill_full_window` ("callers must pass `window_days >= MIN_WINDOW_DAYS`; `parse_window_days` is the canonical sanitizer"). Optionally add `debug_assert!(window_days >= MIN_WINDOW_DAYS)` as a defensive guard against future-caller drift — note this is *not* a fix for an existing trigger.
- **Pass-1 source:** 10/F29
- **Status:** Open

### I-GCalSpaces-DocNits — Aggregate placeholder for "doc nits" not enumerated in Pass-1
- **Domain:** GCal / Spaces / Drafts
- **Location:** Various — `src-tauri/src/gcal_push/`, `src-tauri/src/spaces/`, `src-tauri/src/draft.rs`, `src-tauri/src/ulid.rs`
- **What:** REVIEW-LATER.md's Info section header reads "GCal / Spaces (9)" but only F9, F28, F29 are explicitly named alongside an unspecified "doc nits" tail. Pass-1 source `10-gcal-spaces-misc.md` does not enumerate further actionable doc nits — its closing notes (lines 863-868) are observational rather than concrete (FEAT-5g deferred is correct; OAuth security posture is sound; ULID test suite is high-quality; `lease.rs` is clean; `digest.rs` is well-tested; `dirty_producer.rs` is well-scoped).
- **Why it matters:** Tracker hygiene. The "(9)" count in REVIEW-LATER.md may be aspirational or sourced from a Pass-2 reorg note that did not reach Pass-1; without explicit Pass-1 backing, fabricating distinct entries would create unverifiable citations. This placeholder keeps the count honest and signals to the next reviewer that the Pass-1 review for this domain is essentially exhausted at the explicit findings.
- **Cost:** S
- **Risk:** Low
- **Impact:** Low
- **Recommendation:** Either downgrade the REVIEW-LATER.md header to "(4)" to match the explicit Info findings (`I-GCalSpaces-1..4`), or, if a Pass-2 author identifies further small doc nits, expand them into discrete `I-GCalSpaces-N` entries with concrete file:line citations and retire this placeholder.
- **Pass-1 source:** 10/closing-notes (no specific F#)
- **Status:** Open

---

## Closing notes

- The Pass-1 reviewers were unusually accurate: across 348 findings, only 2 outright hallucinations and 5 out-of-scope claims. Severity inflation was the dominant correction (49 downgrades).
- The `sanitize_internal_error` doc/code drift in particular is a recurring pattern: ARCHITECTURE.md §15 over-claims; five command files actually skip the helper. Pass 2 was right to downgrade this from "Security/High" to "Docs/Low" — the helper's own docstring says it's UX-only.
- The most consequential pattern is the **ApplyOp permanent-failure black hole** (C-2). Fixing it likely doesn't require new schema — a boot-time replay path against `op_log` would close the loop within the existing CQRS model — but it's the single most impactful change available.
- **GCal connector dead code (C-1)** is fixable in a single afternoon if the `run_cycle` is genuinely correct (Pass 2 confirmed it is, per its tests). The fix is wiring, not redesign.
- Fixing **C-3 (attachment file leak)**, **H-1 (pairing passphrase)**, **H-2 (MCP toggle)**, and **H-3 (create_page_in_space bypass)** together would close the four most user-visible behavioral defects in the codebase. None require architectural change beyond one carrying `fs_path` in `DeleteAttachment` (op log payload extension, allowed under Architectural Stability).
