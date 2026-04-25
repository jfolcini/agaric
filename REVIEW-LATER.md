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

69 open items.

Previously resolved: 396+ items across 149 sessions.

| ID | Section | Title | Cost |
|----|---------|-------|------|
| FEAT-3 | FEAT | Spaces — Phases 1 + 2 shipped (model + bootstrap + switcher + list/search scoping + create-in-space + Move + link picker); Phases 3–6 remaining (per-space tabs + recent, agenda/graph/backlinks scoping, per-space journal, polish) | L |
| FEAT-4 | FEAT | Agent access: expose notes to external agents via an MCP server — parent / umbrella | L |
| FEAT-4i | FEAT | MCP v3 — Mobile (HTTPS/LAN via mTLS reuse from `sync_cert.rs`, agent-pairing flow) — DEFERRED pending v2 | L |
| FEAT-4k | FEAT | MCP activity feed shows the bare tool name as the entry summary; per-tool privacy-safe summaries pending (`TODO(FEAT-4h-followup)` in `src-tauri/src/mcp/server.rs`) | S |
| FEAT-5 | FEAT | Google Calendar daily-agenda digest push (Agaric → dedicated GCal calendar) — parent / umbrella | L |
| FEAT-5g | FEAT | GCal: Android OAuth + background connector (DEFERRED — design sketch only) | L |
| PERF-19 | PERF | Backlink pagination cursor uses linear scan for non-Created sorts (2 sites) | S |
| PERF-20 | PERF | Backlink filter resolver has no concurrency cap on `try_join_all` | S |
| PERF-23 | PERF | `read_attachment_file` buffers whole file before chunked send | S |
| BUG-1 | BUG | Markdown serializer/parser round-trip splits code blocks whose content contains a line starting with three backticks | M |
| MAINT-92 | MAINT | `suggestion-renderer` outside-click handler doesn't verify editor identity before dispatching to `view` | S |
| MAINT-93 | MAINT | `ConflictList` has a truly silent `.catch(() => {})` (only such instance found in `src/`) | S |
| MAINT-94 | MAINT | `MONTH_SHORT` array duplicated verbatim in `agenda-sort.ts` and `date-utils.ts`; also not routed through `t()` | S |
| MAINT-95 | MAINT | `recent-pages.ts` casts parsed localStorage to typed array without per-element shape validation | S |
| MAINT-96 | MAINT | Decompose `AgentAccessSettingsTab.tsx` (910 lines) and extract inline `AddFilterRow` from `BacklinkFilterBuilder.tsx` (lines 234–553) | M |
| MAINT-97 | MAINT | Test convention docs drifted from reality — file counts, Playwright timeout, missing snapshot directories, "21 spec files" claim | S |
| MAINT-98 | MAINT | E2E helpers: extract inlined `blurEditors` / `reopenPage` to `e2e/helpers.ts` and document portal-scoped helpers in `src/__tests__/AGENTS.md` | S |
| MAINT-99 | MAINT | No automated enforcement for several documented test rules (axe-audit per component test, IPC-error-path coverage, test file naming convention) | M |
| MAINT-100 | MAINT | MD documentation drift sweep across UX.md / FEATURE-MAP.md / README.md / COMPARISON.md / AGENTS.md (~10 small drift items batched) | S |
| MAINT-101 | MAINT | `tag-colors.ts` is localStorage-only despite header comment claiming property-sync persistence | M |
| MAINT-102 | MAINT | `ResultCard.highlightText` prop accepted but never consumed (drift with FEATURE-MAP.md highlighting claim) | S |
| MAINT-103 | MAINT | `BlockPropertyEditor` inline editor uses absolute positioning without portal — should follow the `suggestion-renderer` pattern | M |
| MAINT-104 | MAINT | Hardcoded English error in `BacklinkFilterBuilder` property-key validation (bypasses `t()`) | S |
| MAINT-105 | MAINT | Misc small consistency cleanups (selector-list comment, `e.repeat` guards, warned-ref noise, sidebar mode comment, undo-group window revisit) | S |
| TEST-1 | TEST | Frontend test coverage gaps in 6 specific files surfaced by review (filter-pill, switch, textarea, useEditorBlur portal scan, page-blocks loadSubtree cap, main.tsx error handlers) | S |
| TEST-2 | TEST | ~30 wrapper functions in `src/lib/tauri.ts` lack individual tests beyond the shallow cross-cutting test (only command-name verified, not `null` defaults / arg shape) | M |
| TEST-3 | TEST | Browser/E2E `tauri-mock` `revert.ts` only handles 5 of 13 reversible op types — undo/redo for property/tag/state ops is a silent no-op in mock; can't be E2E-tested | M |
| TEST-4 | TEST | 25 of 26 Playwright specs lack a console-error listener — backend / mock errors leak silently in every E2E suite except `smoke.spec.ts` | M |
| TEST-5 | TEST | `property-picker.test.ts` (6 tests) and `checkbox-input-rule.test.ts` (17 tests) exercise extension config + regex only, not editor integration | M |
| TEST-6 | TEST | Weak-assertion sweep: `toBeTruthy()` for element existence, `toBeGreaterThan(0)` for known-count arrays, `toHaveBeenCalled()` without `…With(...)` (verified in 5 files) | S |
| TEST-7 | TEST | Real-timer `setTimeout` sleeps in 4 test files (RescheduleDropZone, recent-pages, useSyncEvents, helpers.ts dragBlock 50/150 ms) — flake risk under CI load | S |
| TEST-8 | TEST | `page-blocks.test.ts` lacks `splitBlock()` error-rollback test; existing `remove()` error test only checks `toHaveLength(1)`, not block-content preservation | S |
| TEST-9 | TEST | Hardcoded English assertions in `AttachmentList.test.tsx` and `SearchPanel.test.tsx` instead of `t('key')` per the i18n-in-tests rule | S |
| TEST-10 | TEST | `useBlockResolve.test.ts` uses sticky `mockResolvedValue` 50× and never `mockResolvedValueOnce` — call-ordering bugs go undetected | S |
| TEST-11 | TEST | 7 E2E specs use CSS-class selectors (23 instances total) instead of `data-testid` per the documented selector convention | M |
| TEST-12 | TEST | `e2e/settings.spec.ts` theme-options test only checks 3 of 7 shipped themes | S |
| TEST-13 | TEST | `TabBar` dropdown Esc-to-close behaviour not explicitly tested | S |
| UX-257 | UX | Breadcrumb bar (zoom + page header) doesn't read as a breadcrumb, is oversized, and styling is inconsistent across the two surfaces | M |
| UX-258 | UX | DailyView / DaySection don't scroll to `selectedBlockId` on mount when navigating into a date-titled page (`TODO(UX-242)` in `src/stores/navigation.ts`) | S |
| UX-259 | UX | `ConfirmDialog` `autoFocus` lands on the destructive action button — Enter on a destructive confirm is a footgun | S |
| UX-260 | UX | Discoverability sweep for keyboard shortcuts and gestures (sidebar swipe, journal nav, undo tiers, Shift+Click range, properties drawer shortcut, Ctrl+F, KeyboardShortcuts→Settings link) | M |
| UX-261 | UX | `PageTreeItem` delete button is `opacity-0` until hover — invisible to keyboard users on `:focus-visible` | S |
| UX-262 | UX | `TabBar` close button is a `<button>` nested inside a `role="menuitemradio"` div — nested-interactive a11y violation | S |
| UX-263 | UX | Pairing flow polish (countdown SR announcements, ordinal labels, address/rename validation, mid-pair close guard, countdown pause while typing) | M |
| UX-264 | UX | Sync error UX (no retry action on failure toast, no online/offline transition feedback, no batch progress, camera-permission denial leaves user stuck on QR mode) | M |
| UX-265 | UX | Conflict UI improvements (Keep/Discard label clarity, sort/filter for large conflict sets, type-badge tooltips, missing-original-block fallback, large-diff handling) | M |
| UX-266 | UX | Sync status visibility — sidebar-footer indicator missing when StatusPanel collapsed; "discovering" state visually identical to "pairing"; deleted-current-space silently switches without notification | S |
| UX-267 | UX | Unpair confirmation dialog doesn't explain that ops are retained locally — users fear data loss | S |
| UX-268 | UX | Touch-target / mobile sizing fixes across Agenda + Search (DuePanelFilters toggle missing min-h + aria-label, AgendaSortGroup buttons missing min-w, SourcePageFilter button responsiveness, BacklinkFilterBuilder add-filter row mobile layout) | S |
| UX-269 | UX | `SearchPanel` consolidation — switch custom load-more to shared `LoadMoreButton`, fix aria-live placement, debounce visual feedback, CJK notice placement, alias-overlay positioning, results-count announcement | M |
| UX-270 | UX | `GraphView` a11y + filter persistence — bare `overflow-y-auto` → `ScrollArea`, redundant aria-label on labelled checkboxes, `role="img"` on interactive SVG, filter state reset on every navigation | M |
| UX-271 | UX | Backlinks linked-vs-unlinked distinction missing in `BacklinkGroupRenderer`; `LinkedReferences` lacks active-filter count badge; tag-search popover scroll handling unclear | S |
| UX-272 | UX | Properties drawer / picker polish (no-pages empty-state styling, AND/OR/NOT mode affordance, definitions-loading state, date-input debounce, choice options count + reorder, disabled "Add option" when empty, type badge for "Create new", ref-save spinner) | M |
| UX-273 | UX | Inline link UX — `LinkPreviewTooltip` only fires on hover (no keyboard activation); suggestion popups don't handle viewport edges on mobile | M |
| UX-274 | UX | Agenda views — `DateChipEditor` parse error not shown on input itself; `QueryResult` error has no retry; `RescheduleDropZone` has no keyboard alternative; per-group collapse not persisted; empty-filter validation silent; `DuePanel` projected entries skipped by keyboard nav; `QueryBuilderModal` accepts unknown property keys | M |
| UX-275 | UX | History view UX gaps — Restore-to-here wording, non-reversible icon a11y, missing inline filter clear, DiffDisplay hunk navigation, descendant-count badge wrap, batch keyboard shortcuts, restore-action missing undo toast, checkbox row-click ambiguity, generic error banner, no batch-restore confirmation | M |
| UX-276 | UX | Settings — active tab resets on navigation; no URL-based deep-link to specific settings sections | S |
| UX-277 | UX | `BugReportDialog` polish — uses native `<input type="checkbox">` instead of design-system `Checkbox`, no success toast after submit, no log-content preview before submit | S |
| UX-278 | UX | `WelcomeModal` — sample page content hardcoded English; feature list uses `<div>` instead of `<ul>/<li>` semantics | S |
| UX-279 | UX | `FeatureErrorBoundary` (section-level errors) lacks "Report bug" affordance — only the global `ErrorBoundary` has it | M |
| UX-280 | UX | Attachments / Image / PDF polish — `PdfViewerDialog` lacks keyboard page-nav shortcuts; `ImageResizeToolbar` buttons lack `aria-pressed` | S |
| UX-281 | UX | Suggestion list & roving editor polish — category headers use plain `<div>` (need `role="heading"`); markdown serializer warns on unknown inline nodes but strips them silently to user; gutter-button tooltips invisible on touch | S |
| UX-282 | UX | `src/lib/announcer.ts` exists with `announce.*` i18n keys but is invoked from very few places — paid-for accessibility utility is largely unused | M |
| UX-283 | UX | Templates / Data settings polish — `TemplatesView` lacks empty state when search yields no results; `DataSettingsTab` import has no per-file progress indicator | S |
| UX-284 | UX | `RecentPagesStrip` and `SpaceSwitcher` discoverability — focus marker on chips relies only on ring; "Manage spaces" disabled tooltip may not trigger on touch | S |
| PUB-2 | PUB | Git author email across all history is corporate (`javier.folcini@avature.net`) | S |
| PUB-3 | PUB | Employer IP clearance before public release | S |
| PUB-5 | PUB | Tauri updater endpoint points to a GitHub org/repo that does not yet exist | S |
| PUB-7 | PUB | Missing `SECURITY.md` — private-disclosure contact pending publish target | S |

> **All remaining `PUB-*` items are DEFERRED until the publish target + timing is locked in.**
> See the PUB section below for per-item details and the section preamble for
> how agents should treat each status.

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

**Cost:** L — 4 remaining phases (3–6), each a focused session with a mandatory review subagent per AGENTS.md. Phase 4 (agenda/graph/backlinks/tags/properties scoping) is the largest single slice remaining.

**Status:** IN PROGRESS — Phases 1 + 2 shipped. Phases 3–6 remaining, schedulable in any order consistent with the DAG (Phase 3 is per-space tabs/recent; Phase 4 is agenda/graph/backlinks; Phase 5 is journal; Phase 6 is polish + management UI + the two Phase 1 UX follow-ups above).

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

### FEAT-4k — MCP activity feed shows the bare tool name as the entry summary; per-tool privacy-safe summaries pending

**Problem:** `src-tauri/src/mcp/server.rs:470` carries a `TODO(FEAT-4h-followup)` marker inside `handle_tools_call`'s activity-emission block. For the FEAT-4h v2 MVP, every entry rendered in the in-app activity feed (Settings → Agent Access) is summarised by the tool name only — `append_block`, `set_property`, `delete_block`, etc. — so a user looking at the feed cannot tell *what* an agent did, only *which kind of thing* it did. The FEAT-4h slice 3 design called for privacy-safe per-tool summaries (counts, block-ID prefixes, page-name hashes — never block content), but the per-tool helpers that extract those values from each tool's structured return shape were intentionally left out to keep the slice tight, and slice 4 closed FEAT-4h without picking them up.

**Why it matters:** Without per-tool summaries the activity feed is a thin audit log — useful enough to drive the per-entry / per-session Undo affordances that already shipped, but not informative enough on its own. A user reviewing what an agent did over the last hour sees ten `append_block` rows and has no way to scan-read the differences. With privacy-safe summaries (e.g. `append_block — added 2 blocks under <ULID-prefix>`, `set_property — set space=<ULID-prefix> on 3 pages`) the feed becomes a legitimate review surface.

**Scope:** add a small per-tool helper next to each tool definition in `src-tauri/src/mcp/tools_ro.rs` and `src-tauri/src/mcp/tools_rw.rs` that, given the tool's structured return value, produces a one-line privacy-safe summary string. The dispatcher in `handle_tools_call` reads that summary instead of `name.clone()`. No protocol change, no new IPC, no new tables, no new ops.

**Privacy invariants (do not break):**

- Never include block content. Counts, ULIDs (or ULID prefixes), tool name, and structural facts only.
- Never include resolved chip text, attachment file names, or property values that are themselves user content (e.g. the literal value of a `text` property).
- Property *keys* are fine (they are schema, not content); property *values* are content unless they are typed `ref` (in which case the ULID is OK), `number`, or `date`.
- Error summaries already clip to 200 chars via `err.to_string().chars().take(200).collect::<String>()` — keep that clip; do not loosen it.

**Acceptance:**

- Every RO tool (`list_blocks`, `search_blocks`, `get_block`, `list_properties`, `get_backlinks`, `list_recent`, `get_property_definitions`, `agenda`, `query_by_property`) and every RW tool (`append_block`, `update_block`, `delete_block`, `restore_block`, `set_property`, `delete_property`) has its own summariser.
- The dispatcher swaps `name.clone()` for the per-tool summary on success; error path is unchanged.
- The Settings → Agent Access activity feed renders the new summary in place of the bare tool name.
- The `TODO(FEAT-4h-followup)` comment is removed.
- Existing tests covering activity emission updated to assert the new summary shape; one new per-tool summariser unit test per tool. Privacy invariants have a guard test (snapshot any string that would expose content fails the test).

**Verification:** `cargo nextest run`, `npx vitest run`, `prek run --all-files`. No e2e impact.

**Cost:** S — additive helper per tool + one dispatch swap + targeted tests. No invariant impact, no new abstractions.

**Status:** Open — explicit follow-up filed by FEAT-4h slice 3 (session 463); FEAT-4h slice 4 closed without picking up this polish slice.

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

### MAINT-92 — `suggestion-renderer` outside-click handler doesn't verify editor identity before dispatching

**Problem:** `src/editor/suggestion-renderer.ts:139-164` registers a capture-phase `pointerdown` listener that, on outside-click, dispatches a meta-update to `editorRef.view`. The handler captures `editorRef` (the editor at registration time) and only null-checks it before dispatch. Agaric uses a roving-editor pattern where TipTap instances swap as focus moves between blocks; if a renderer leaks past its owning instance for any reason (e.g. a popup dismissal that races with focus moving), the dispatch lands on a stale view. The surrounding `try` block catches and logs (`logger.warn` on line 150), so this is defense-in-depth rather than a live bug — but the guard is incomplete.

**Fix:** before `editorRef.view.dispatch(tr)`, also verify that `editorRef === props.editor` (or check `editorRef.view.isDestroyed === false`). One added condition; no behavioural change in the common case. Reference for the desired pattern: AGENTS.md "Floating UI lifecycle logging" (`src/editor/suggestion-renderer.ts` is itself the canonical example, so this is closing a small gap in its own pattern).

**Cost:** S
**Risk:** S — single defensive check; existing tests should pass unchanged.
**Impact:** S — eliminates a vanishingly rare class of cross-instance dispatch.

### MAINT-93 — `ConflictList` has a truly silent `.catch(() => {})` (only such instance found in `src/`)

**Problem:** `src/components/ConflictList.tsx:141-143`:

```tsx
.catch(() => {
  // Not in Tauri context — no-op
})
```

This is the only genuinely-silent `.catch(() => {})` block in the entire frontend (verified across all of `src/` via two independent passes). AGENTS.md "Anti-patterns" explicitly forbids the form: *"Silent `.catch(() => {})` blocks — always use `logger.warn` or `logger.error`. Silent error swallowing masks real bugs."* The intent here (graceful degradation when running outside Tauri, e.g. the Vite dev server without the `tauri-mock` shim active) is reasonable; the form is wrong.

**Fix:**

```tsx
.catch((err: unknown) => {
  logger.warn(
    'ConflictList',
    'sync:complete listener unavailable (likely no Tauri context)',
    undefined,
    err,
  )
})
```

**Cost:** S
**Risk:** S — purely additive; no behavioural change beyond a single warn-level log line in non-Tauri contexts.
**Impact:** S — closes the last anti-pattern hit in the frontend.

### MAINT-94 — `MONTH_SHORT` duplicated verbatim across `agenda-sort.ts` and `date-utils.ts` (and not i18n-routed)

**Problem:** Identical 12-element English-only `MONTH_SHORT` arrays exist at:

- `src/lib/agenda-sort.ts:405-418`
- `src/lib/date-utils.ts:63-76`

Both arrays carry the same comment (`/** Short month names for compact date display. */`) and are consumed by `formatCompactDate` in their respective modules. DRY violation. Separately, these are user-visible labels not running through `i18n.t()`, so they remain English on every locale.

**Fix:**

1. Delete the duplicate from `agenda-sort.ts`. Import from `date-utils.ts` instead.
2. (Optional, larger) Replace the static array with a call through `Intl.DateTimeFormat(locale, { month: 'short' })` so compact dates respect the user's locale. This also closes a small i18n gap consistent with the rest of the app's `t()`-based labels.

**Cost:** S (step 1 alone) / M (steps 1 + 2).
**Risk:** S — pure refactor; existing tests for `formatCompactDate` carry the contract.
**Impact:** S — DRY win; localised date labels if step 2 is taken.

### MAINT-95 — `recent-pages.ts` casts parsed localStorage to typed array without per-element shape validation

**Problem:** `src/lib/recent-pages.ts:18-28`:

```ts
const parsed: unknown = JSON.parse(raw)
if (!Array.isArray(parsed)) return []
return parsed as RecentPage[]
```

The function validates that the parsed value is an array but does not validate that each element has the expected `id` / `title` / `visitedAt` shape. Per AGENTS.md threat model (single-user, no malicious actor) this is benign for input written by the app itself; the residual risk is that any bug elsewhere that writes malformed entries silently corrupts the recent-pages strip until the user clears storage.

**Fix:** filter via a `(item): item is RecentPage =>` type guard before returning. Drop malformed entries; do not throw. Cost is one helper function (~6 lines) plus a unit test that feeds malformed JSON.

**Cost:** S
**Risk:** S — pure tightening; cannot regress good inputs.
**Impact:** S — robustness against in-app bugs writing bad entries.

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

### MAINT-97 — Test convention docs drifted from reality (counts, Playwright timeout, missing snapshot directories)

**Problem:** A pass over the three test-convention docs (`AGENTS.md`, `src/__tests__/AGENTS.md`, `src-tauri/tests/AGENTS.md`) verified each numeric / structural claim against the code. Several have drifted:

| Doc claim | Reality | Source |
|-----------|---------|--------|
| `src/__tests__/AGENTS.md:40` "133 component test files" | 136 (`src/components/__tests__/*.test.tsx`) | Drift |
| `src/__tests__/AGENTS.md:46` "20 editor test files" | 21 (`src/editor/__tests__/`, 20 `.ts` + 1 `.tsx`) | Drift |
| `src/__tests__/AGENTS.md:52` "8 store test files" | 10 (`src/stores/__tests__/`) | Drift |
| `src/__tests__/AGENTS.md:62` "39 lib test files" | 42 (`src/lib/__tests__/`) | Drift |
| `src/__tests__/AGENTS.md:373` "21 spec files" | 26 (`e2e/*.spec.ts`) — root `AGENTS.md:29` already says 26, so this one *contradicts* the root | Drift + internal contradiction |
| `src/__tests__/AGENTS.md:380` "Global expect timeout: 3000ms" | `playwright.config.ts:11` sets `expect: { timeout: 8000 }` | Drift |
| `src-tauri/tests/AGENTS.md:260–270` lists 4 snapshot directories | 6 exist — also `src-tauri/src/mcp/snapshots/` (11 files) and `src-tauri/src/gcal_push/snapshots/` (6 files) | Missing |
| `AGENTS.md:87` "30 migrations" | 35 (`src-tauri/migrations/0001…0035`) | Drift |

**Fix:** Single doc-update commit. Update each line to the verified number; add the two missing snapshot dirs to the `src-tauri/tests/AGENTS.md` list; reconcile the root vs. frontend "26 vs. 21" specs claim. Optional follow-up (in MAINT-99 below): a tiny `prek` hook that grep-counts files vs. the tables and fails if drift > 1.

**Cost:** S (doc-only, ~30 min).
**Risk:** S — pure documentation update; no production code touched.
**Impact:** S — these docs are the source of truth for test conventions; wrong counts undermine trust in the rest of the document for new contributors and review subagents.

### MAINT-98 — E2E helpers: extract inlined `blurEditors` / `reopenPage`, document portal-scoped helpers

**Problem:** Two issues at the E2E test infrastructure layer:

1. **Inlined helpers in spec files.** `e2e/undo-redo-blocks.spec.ts:25-33` defines `reopenPage(page)` (navigate-away-and-back to force a `BlockTree` re-fetch from the mock backend) and `e2e/undo-redo-blocks.spec.ts:39-59` defines `blurEditors(page)` (press Escape to leave `contentEditable` focus so Ctrl+Z hits the page-level handler instead of ProseMirror's in-editor undo). The frontend AGENTS.md `E2E undo/redo helpers` section (`src/__tests__/AGENTS.md:407-412`) describes these by name and explains why they're needed, but they're inlined in a spec file rather than exported from `e2e/helpers.ts`. Other specs that need the same behaviour have no easy way to consume them.

2. **Portal-scoped helpers undocumented.** `e2e/helpers.ts:55-98` defines `activeDialog`, `activeSheet`, `activePopover`, `activeMenu`, `activeSuggestionList`, `activeRoleDialog`, `activeSuggestionPopup` — used heavily across specs (e.g. `properties-system.spec.ts:104,110,178`, `templates.spec.ts:68,156`, `inner-links.spec.ts:167,192,274`) to scope queries to the most-recently-opened Radix portal and avoid stale-DOM collisions in parallel test runs. None of these helpers are documented in `src/__tests__/AGENTS.md` "E2E Testing (Playwright)" section. New contributors will reinvent them and produce flaky tests.

**Fix:**

1. Move `blurEditors` and `reopenPage` out of `e2e/undo-redo-blocks.spec.ts` into `e2e/helpers.ts`; export them; update the spec to import. Add JSDoc describing why each is needed (links to AGENTS.md pitfalls).
2. Add a "Portal-scoped helpers" subsection in `src/__tests__/AGENTS.md` (after the existing E2E "Patterns" block, ~line 402) listing each helper with a one-line example. Reference `TEST-1b` in REVIEW-LATER.md if/when that gets reopened. Mention the `.last()` pick-most-recent rule used internally so reviewers understand the design.

**Cost:** S (~1h, mechanical extraction + doc subsection).
**Risk:** S — pure refactor of test infrastructure; no production code touched. Existing specs continue to work because they only consume.
**Impact:** S–M — closes a discoverability gap that's already costing reviewer-time (verification subagents flagged the missing doc explicitly).

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

### MAINT-100 — MD documentation drift sweep across UX.md / FEATURE-MAP.md / README.md / COMPARISON.md / AGENTS.md

**Problem:** A focused review surfaced ~10 small drift items between the docs and what ships. Bundled because each fix is one or two lines and they're disjoint:

- `UX.md:1175` references `AddPropertySection`; the actual component is `AddPropertyPopover` (`src/components/AddPropertyPopover.tsx`).
- `UX.md` Property Drawer section (lines 1166-1177) doesn't document focus-trap, focus-restoration on close, Tab cycling, or Esc behaviour.
- `UX.md` LinkedReferences paragraph (lines 128-129) has no parallel paragraph for `UnlinkedReferences` filters (UX-168).
- `UX.md` Toast Action Patterns specifies 6s for Undo actions; `useUndoShortcuts.ts:71,93` uses 1500 ms — clarify in the doc that 1500 ms is *operation feedback* (no action button) and 6 s is for toasts that carry an Undo button (different patterns).
- `UX.md` History View Shortcuts (~382-394) is missing PageUp/Down (already implemented in `useListKeyboardNavigation`), Shift+Click range select (UX-140 in `useListMultiSelect.ts:76-102`), and the cursor-based pagination contract (`HistoryView.tsx:70-88`).
- `UX.md` Two-Tier Undo/Redo section (~952-970) doesn't document `UNDO_GROUP_WINDOW_MS = 200` (`src/stores/undo.ts:24`) or `MAX_REDO_STACK = 100` (`src/stores/undo.ts:21`).
- `FEATURE-MAP.md:38` claims "Query term highlighting in result cards (via HighlightMatch)"; `ResultCard.tsx:31-36` accepts `highlightText` but never uses it (see MAINT-102) — fix the doc or the code.
- `FEATURE-MAP.md:117` mentions "circles with truncated labels" for graph nodes; truncation happens at 20 chars in `useGraphSimulation.ts:152` — document the cap.
- `README.md:14` says "no telemetry"; the local `src/lib/logger.ts` IPC bridge writes errors to disk for `BugReportDialog`. Tighten to "no cloud telemetry / no external analytics".
- `COMPARISON.md` carries version-specific claims (e.g. specific Logseq stable version + date) that can go stale; add a "verified as of" header so the staleness is visible.
- `AGENTS.md` "Frontend Development Guidelines" doesn't mention the shared `BatchActionToolbar` primitive — add to the shared-components table.

**Cost:** S — single doc-only sweep.
**Risk:** S — pure docs.
**Impact:** S — keeps docs honest; reduces "documented feature missing" surprises in onboarding.

### MAINT-101 — `src/lib/tag-colors.ts` is localStorage-only despite header comment claiming property-sync persistence

**Problem:** `src/lib/tag-colors.ts:1-58` has a header comment that claims tag colours "Also persist to block properties via `setProperty()` for cross-device sync"; the implementation is localStorage-only. Tag colours are device-local and never reach the op log, so two devices can show the same tag in different colours forever.

**Decision required:** either honour the comment (wire colours through a `tag_color` property on the tag's page block, fall back to localStorage as a cache — purely additive, uses the existing properties extension point per AGENTS.md "Architectural Stability") or honour the code (drop the property-sync claim from the comment, document tag colours as device-local). The current state is a contract bug: code and comment disagree.

**Cost:** M (sync option) / S (doc-only option).
**Risk:** S.
**Impact:** M (sync option) — multi-device users see the same palette / S (doc-only).

### MAINT-102 — `ResultCard.highlightText` prop accepted but never consumed

**Problem:** `src/components/ResultCard.tsx:31-36` declares `highlightText?: string` with a JSDoc that admits it isn't used: "Currently accepted for API compatibility but rich content rendering takes priority over plain-text highlighting." `SearchPanel.tsx:517,554` passes `highlightText={debouncedQuery}` and the value is silently discarded. `FEATURE-MAP.md:38` claims the feature ("Query term highlighting in result cards (via HighlightMatch)") this prop was supposed to enable.

**Fix:** either implement highlight propagation through `renderRichContent` (rich pipeline takes priority — that's why the prop is dead — but a non-rich fallback or post-render highlight pass is feasible) or drop the prop, drop the call sites, and remove the FEATURE-MAP line. The drop path is smaller and more honest; the implement path restores a documented feature.

**Cost:** S (drop) / M (implement).
**Risk:** S.
**Impact:** S.

### MAINT-103 — `BlockPropertyEditor` inline editor uses absolute positioning without portal

**Problem:** `src/components/BlockPropertyEditor.tsx:40-44` renders the inline edit popup with a plain `<div className="absolute z-50 ...">`. If the surrounding row is inside a scroll container with `overflow: hidden`, the popup gets clipped. Every other floating UI in the editor (suggestion popups, `BlockContextMenu`, `BlockDatePicker`) goes through `createPortal()` + `@floating-ui/dom` per AGENTS.md "Floating UI lifecycle logging".

**Fix:** convert to the portal pattern used by `src/editor/suggestion-renderer.ts`: `createPortal(<div data-editor-portal>...)` with `computePosition` from `@floating-ui/dom`, log lifecycle (warn on stale/null state, fallback positioning, `.catch` on positioning), and ensure the portal selector is recognised by `EDITOR_PORTAL_SELECTORS` in `src/hooks/useEditorBlur.ts` (the `[data-editor-portal]` entry already covers this).

**Cost:** M.
**Risk:** M — touches editor blur lifecycle; needs careful tests.
**Impact:** S — closes a small clipping risk and aligns with the documented floating-UI pattern.

### MAINT-104 — Hardcoded English error in `BacklinkFilterBuilder` property-key validation

**Problem:** `src/components/BacklinkFilterBuilder.tsx:140` returns `{ error: \`No blocks have property "${trimmedKey}"\` }` — a raw English string baked into a UI message. Verified to be the only hardcoded user-visible English string surfaced in the review (other "hardcoded" findings turned out to be already-i18n'd).

**Fix:** add an i18n key (e.g. `backlink.propertyNotFound`) with `{{key}}` interpolation in `src/lib/i18n.ts`; route through `t()`.

**Cost:** S.
**Risk:** S — pure i18n.
**Impact:** S — closes an i18n hole on non-English locales.

### MAINT-105 — Misc small consistency cleanups across editor / shell / sync

**Problem:** Five low-risk consistency tweaks bundled into one entry because each is XS:

1. `src/hooks/useEditorBlur.ts:31-40` — `EDITOR_PORTAL_SELECTORS` array has no inline comment linking back to the AGENTS.md "Floating UI lifecycle logging" rule it implements. Add a one-line `// AGENTS.md: keep selectors here in sync when adding new editor-side overlays`.
2. `src/components/ViewHeader.tsx:47-63` — the portal-mount-race warning uses a single boolean `warnedRef`, so a view that renders multiple `<ViewHeader>`s fires the warning multiple times in one paint. Replace with a `Set` keyed by component identity, or rate-limit.
3. `src/App.tsx:646-713` — global keyboard handlers (journal nav, tab cycle, etc.) don't check `e.repeat`, so holding a key fires repeated state writes / SR announcements. Add `if (e.repeat) return` to the navigation handlers.
4. `src/App.tsx:854` — `<Sidebar collapsible="icon">` has no inline comment explaining why "icon" is chosen over "offcanvas". Add a one-liner pointing to UX.md § Mobile Sidebar.
5. `src/stores/undo.ts:24` — `UNDO_GROUP_WINDOW_MS = 200` was set for recurrence ops creating 8-10 ops in a burst. Under any load (slow disk, network) ops can fall outside the 200 ms window and undo gets unwieldy. Re-evaluate at 500 ms; document the chosen value in UX.md (covered by MAINT-100).

**Cost:** S — each is XS, total well under 2h.
**Risk:** S — defensive / cosmetic.
**Impact:** S — small, sustained quality bar.

---

## TEST — Test coverage gaps surfaced during review

### TEST-1 — Six specific files lack dedicated test coverage on real risk-bearing paths

**Problem:** Two independent review passes (one full + one validation) over `src/` agreed on the following specific gaps. Each is small and individually a `S` task; bundled here so a single contributor session can close them.

| File | Missing coverage |
|------|------------------|
| `src/components/ui/filter-pill.tsx` | No dedicated test file. Keyboard handling (Delete/Backspace), `onRemove` invocation, `aria-label` on the remove button, and 44px touch-target sizing on `pointer:coarse` are untested. Currently covered only indirectly via consumers. |
| `src/components/ui/switch.tsx` | No dedicated test. Touch-target sizing and focus-ring consistency are unverified. |
| `src/components/ui/textarea.tsx` | No dedicated test. Touch-target sizing, focus-ring, and `aria-invalid` propagation unverified. |
| `src/main.tsx` | No test for the global `error` / `unhandledrejection` handlers (`logger`-bridge wiring). The file is excluded from coverage, which is correct for the bootstrap, but the handler logic itself is non-trivial and should have a small dedicated test against a simulated `window.dispatchEvent`. |
| `src/hooks/useEditorBlur.ts` | The "Step 4b" portal-scan logic (the `EDITOR_PORTAL_SELECTORS` walk that decides whether a blur is into a known overlay) has no dedicated test. This is a real production hot-path — a regression here causes premature persists / splits while users interact with pickers. |
| `src/stores/page-blocks.ts` | The recursion bound on `loadSubtree()` (`MAX_SUBTREE_BLOCKS` cap) has no test. The cap exists to prevent runaway recursion on corrupted data; unverified caps tend to drift. |

**Fix:** for each file, add a `__tests__/<File>.test.tsx` (or `.test.ts`) with the standard render + interaction + `axe(container)` triplet for primitives, and unit-level tests for the two non-component cases (`useEditorBlur` portal scan, `page-blocks` cap). Follow the patterns documented in `src/__tests__/AGENTS.md`.

**Cost:** S (each file; ~30 min). Bundle suggestion: one PR per logical group (3 ui/ primitives; the two hooks/stores; main.tsx alone).
**Risk:** S — additive tests; no production-code change.
**Impact:** S — closes coverage holes on paths that are demonstrably risk-bearing.

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

### TEST-6 — Weak-assertion sweep: `toBeTruthy` / `toBeGreaterThan(0)` / `toHaveBeenCalled` without `…With(...)`

**Problem:** Five files (verified by independent grep) use weak assertions where stronger ones would catch real regressions. Quality-standards rule from `src/__tests__/AGENTS.md:529`: *"Use `toHaveLength(N)` with exact counts, not `Array.isArray()` or `.length >= 1`. […] `toHaveBeenCalledWith` with exact args, not just `toHaveBeenCalled`."*

| File | Line(s) | Pattern | Verified count |
|------|---------|---------|----------------|
| `src/components/__tests__/SearchPanel.test.tsx` | 1692 | `expect(skeletons.length).toBeGreaterThan(0)` (component renders exactly 2 skeletons) | 1 |
| `src/components/__tests__/ConflictList.test.tsx` | 948, 971, 992, 1009, 1292, 1343, 1418, 1477, 1579, 1628, 1686 | `expect(x).toBeTruthy()` for element-existence checks | 11 |
| `src/components/__tests__/JournalPage.test.tsx` | 2795, 2822, 2849, 2884, 2885, 2886 | `expect(dueDots.length).toBeGreaterThan(0)` | 6 |
| `src/components/__tests__/PageBrowser.test.tsx` | 233, 239, 969, 1623 | `expect(...).toBeTruthy()` for element existence | 4 |
| `src/components/__tests__/LinkEditPopover.test.tsx` | various | `expect(mock).toHaveBeenCalled()` without `…With(...)` | 36 |
| `src/editor/__tests__/suggestion-renderer.test.ts` | 143, 167, 191, 224, 262, 290, 358, 445, 482, 526, 563, 592, 646, 660, 666, 675, 680, 714, 722, 747, 774, 846, 852, 866, 903 | `expect(popup).toBeTruthy()` for DOM element existence | 25 |
| `src/lib/__tests__/keyboard-config.test.ts` | 39-42 | `expect(s.id).toBeTruthy()` in a property-shape loop | 4 |
| `src/components/journal/__tests__/MonthlyDayCell.test.tsx` | 165 | `.not.toBeNull()` instead of `.toBeInstanceOf(HTMLElement)` | 1 |

**Fix:** File-by-file sweep. For element-existence: `toBeInTheDocument()` (RTL) or `toBeInstanceOf(HTMLElement)`. For known-count arrays: `toHaveLength(N)`. For mock invocations: `toHaveBeenCalledWith(expectedArgs)`. The `LinkEditPopover.test.tsx` case is the largest (36 instances) — bundle as its own commit.

**Cost:** S (~half day for the small files) / M (~1–2 days incl. `LinkEditPopover.test.tsx`).
**Risk:** S — pure tightening of assertions; tests still pass when behaviour is correct.
**Impact:** M — catches off-by-one / wrong-arg regressions that currently pass.

### TEST-7 — Real-timer `setTimeout` sleeps in 4 test files

**Problem:** Quality-standards rule from `src/__tests__/AGENTS.md:526`: *"Use `waitFor` / `findBy*` instead of `sleep`. Debounce tests use `vi.useFakeTimers()` + `vi.advanceTimersByTime()`."* These four sites violate it on real timers (verified absence of `vi.useFakeTimers()` for the relevant tests):

| File | Line(s) | Sleep | What it's gating |
|------|---------|-------|------------------|
| `src/components/journal/__tests__/RescheduleDropZone.test.tsx` | 218 | `setTimeout(r, 50)` | A "should NOT have been called" assertion — the sleep gives the negative-path the chance to fail. **Highest flake risk** because there's no signal to wait for. |
| `src/lib/__tests__/recent-pages.test.ts` | 80 | `setTimeout(r, 5)` | Forces a `Date.now()` delta between two `pushRecentPage` calls so the `visitedAt` ordering can be asserted. |
| `src/hooks/__tests__/useSyncEvents.test.ts` | 245, 261, 585, 609, 636, 695 | `setTimeout(r, 10)` (×4) and `setTimeout(r, 50)` (×2) | Wait for async listener setup or IPC response. None are inside `vi.useFakeTimers()` scope. |
| `e2e/helpers.ts` | 192 (350 ms), 200 (50 ms), 204 (150 ms) | `page.waitForTimeout(...)` inside `dragBlock` | The 350 ms is justified by dnd-kit's PointerSensor activation delay and should be kept (with a named `DND_ACTIVATION_DELAY_MS` constant + comment); the 50 / 150 ms are inter-step pauses without a clear deterministic alternative documented. |

**Fix:**

- `RescheduleDropZone`: replace with `await waitFor(() => expect(mockSetDueDate).not.toHaveBeenCalled())` or, better, restructure the test so the negative is asserted synchronously after a single deterministic event.
- `recent-pages`: switch to `vi.useFakeTimers()` + `vi.setSystemTime(...)` between calls. Avoid wall-clock entirely.
- `useSyncEvents`: convert to fake timers + `vi.advanceTimersByTime(...)` or `vi.waitFor(...)` against an observable end state.
- `helpers.ts dragBlock`: extract `DND_ACTIVATION_DELAY_MS = 350` constant with a comment citing dnd-kit's PointerSensor; document the 50/150 ms gates with a similar comment, or replace with `expect.poll(() => …).toBe(...)` if a deterministic signal exists.

**Cost:** S (~half day across all four files).
**Risk:** S — these are flake sources today; fixes can only reduce flake.
**Impact:** M — flake removal is a force multiplier on every CI run.

### TEST-8 — `page-blocks.test.ts`: missing `splitBlock` error rollback test, weak `remove()` error assertion

**Problem:** Two specific gaps in `src/stores/__tests__/page-blocks.test.ts`:

1. **`splitBlock` has no error-path test.** The test suite at lines 459–654 covers happy paths (split at start, middle, end of content; split with marks; split preserving children). It does not cover the case where the composite operation `edit() + createBelow()` fails partway. `splitBlock` first persists the truncated content of the original block via `edit()`, then creates the new block with the remainder via `createBelow()`. If `createBelow()` fails after `edit()` has succeeded, the original block is left truncated *without* the corresponding new block — a silent data-loss scenario.

2. **`remove()` error test is too loose.** Lines 425–434 (`'does not modify state on backend error'`) call `mockRejectedValueOnce` and then assert only `expect(store.getState().blocks).toHaveLength(1)`. The assertion passes whether the rolled-back block is the original or any other block of the right count — content is not verified.

**Fix:**

1. Add `it('rolls back on createBelow failure during splitBlock')`: mock `edit` to resolve, mock `createBelow` to reject, call `splitBlock(...)`, assert the block reverts to its original content (capture `previousContent` before the call, compare after).
2. Strengthen the existing `remove()` error test to `expect(store.getState().blocks[0]).toEqual(originalBlock)` so content is asserted, not just count.

**Cost:** S (~30 min — both fixes are mechanical).
**Risk:** S — additive test + assertion strengthening.
**Impact:** M — closes a real partial-failure scenario (`splitBlock` rollback on backend error) that's currently invisible to the test suite.

### TEST-9 — Hardcoded English assertions in `AttachmentList.test.tsx` and `SearchPanel.test.tsx`

**Problem:** Quality-standards rule from `src/__tests__/AGENTS.md:530`: *"Use `t('key')` calls in test assertions, not hardcoded English strings. This ensures tests don't break when translations change, and validates that i18n keys are wired correctly."* Two specific violations:

- `src/components/__tests__/AttachmentList.test.tsx:126,128` — asserts on `'Delete "to-delete.txt"?'` and `'Click the delete button again to confirm.'` (toast strings).
- `src/components/__tests__/SearchPanel.test.tsx:122, 195, 374, 383` — regex patterns `/No results found/`, `/CJK search is limited/` (visible text).

**Fix:** Look up the relevant `t()` keys from the components under test. Replace each hardcoded string with `t('attachments.confirmDelete', { filename: 'to-delete.txt' })` (or the corresponding key — verify against the component source). For regex matchers, switch to `screen.getByText(t('search.noResults'))`.

**Cost:** S (~30 min).
**Risk:** S — pure tightening; current strings already match the English locale.
**Impact:** S — prevents these tests from breaking on a translation update; validates that the keys are actually wired.

### TEST-10 — `useBlockResolve.test.ts` uses sticky `mockResolvedValue` 50× and never `mockResolvedValueOnce`

**Problem:** Quality-standards rule from `src/__tests__/AGENTS.md:551`: *"`mockResolvedValueOnce` consumes in call order. If a component calls `invoke` multiple times on mount, chain `Once` calls in the right order or use `mockImplementation` with command dispatch."* `src/hooks/__tests__/useBlockResolve.test.ts` has 50 calls to `mockResolvedValue(...)` (verified by grep) and zero calls to `mockResolvedValueOnce(...)`.

**Why it matters:** `useBlockResolve` calls `invoke('get_block', { blockId })` once per resolve target. With sticky mocks, every `invoke` call returns the same value regardless of which block ID was requested — a regression where the hook calls the wrong command, passes the wrong arg, or calls more times than expected goes undetected because every call returns the seeded value.

**Fix:** File-by-file sweep of the 50 sites. For each test:
- If the test exercises a single resolve, change to `mockResolvedValueOnce` so a stray extra call is flagged.
- If the test exercises multiple resolves with different block IDs, change to `mockImplementation((cmd, args) => { … switch on args.blockId … })` so each ID gets its expected response.

**Cost:** S–M (~half day — mostly mechanical, but each test needs context to choose the right pattern).
**Risk:** S — current tests pass with sticky mocks because the hook's behaviour is correct today; the tightening makes future regressions detectable.
**Impact:** M — closes the largest single-file violation of a documented mocking rule in the frontend.

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

### TEST-12 — `e2e/settings.spec.ts` theme-options test only checks 3 of 7 shipped themes

**Problem:** `e2e/settings.spec.ts:33-46` opens the theme combobox and asserts that "Light", "Dark", and "System" options are visible. `SettingsView.tsx:207-215` ships seven themes: those three plus Solarized Light, Solarized Dark, Dracula, and One Dark Pro. The other four are not exercised — a regression that drops or renames any of them would not break this test.

**Fix:** loop through all seven theme labels (use the i18n keys or hardcoded names matching the source) and assert each is visible. Optionally extend to assert that selecting each one applies the correct `data-theme` attribute on `<html>`.

**Cost:** S.
**Risk:** S — additive test.
**Impact:** S — regression coverage for the four un-tested themes.

### TEST-13 — `TabBar` dropdown Esc-to-close behaviour not explicitly tested

**Problem:** `src/components/TabBar.tsx:143-264` uses a Radix Popover for the active-tab dropdown. Radix Popover handles Escape automatically, but this repo has no test that asserts the dropdown actually closes on Escape. If the Popover were ever swapped for a custom implementation, or if a parent listener captured Escape, the close behaviour could regress silently. Pair with UX-262 (the close button currently nested inside `role="menuitemradio"`).

**Fix:** add a small test (component or e2e) that opens the dropdown, presses Escape, asserts the menu is gone and focus returns to the trigger.

**Cost:** S.
**Risk:** S.
**Impact:** S — pinpoint regression catch on a high-traffic surface.

---

## UX — User experience / Design polish

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

### UX-258 — DailyView / DaySection don't scroll to `selectedBlockId` on mount when navigating into a date-titled page

**Problem:** `src/stores/navigation.ts:140-147` carries a `TODO(UX-242)` marker. When the user navigates to a date-titled page (`YYYY-MM-DD`) — via `PageBrowser`, `BlockListItem` breadcrumb, `SearchPanel`, `TagFilterPanel`, `TemplatesView`, a graph node click, or a `PageLink` chip — `navigateToPage(pageId, title, blockId?)` correctly routes into the journal view via `useJournalStore.navigateToDate(parsedDate, 'daily')` *and* persists the target `selectedBlockId` on the navigation store. But `DailyView` / `DaySection` don't currently read that field on mount, so the user lands on the right day but at the top of it, and has to scroll/search to find the specific block they were trying to reach. For ordinary same-page navigation the equivalent scroll-into-view behaviour already exists (see `scrollFocusedBlockIntoView` in `src/hooks/useBlockKeyboardHandlers.ts`, UX-241); only the date-routed branch is missing it.

**Why it matters:** Search results, breadcrumbs, and graph node clicks promise "take me to *that* block." For non-date-titled pages they deliver. For date-titled pages they currently land the user on the day with no scroll-to-block, which silently degrades the navigation contract for a sizeable subset of pages (every journal day, every page named `YYYY-MM-DD`). The parent UX-242 (date-routing on title-match navigation) shipped in session 437, but this final scroll-to-block slice was deliberately deferred and never picked up.

**Scope:** thread `selectedBlockId` from `useNavigationStore` into `DailyView` / `DaySection` and trigger a single `requestAnimationFrame` → `document.querySelector('[data-block-id="${id}"]')?.scrollIntoView({ block: 'nearest' })` after first paint when present, plus restore focus to that block via the existing `useBlockStore.setFocused` so keyboard navigation stays coherent. Mirror the pattern already used by `scrollFocusedBlockIntoView` (UX-241) and the post-drag focus restoration. Clear `selectedBlockId` after the scroll fires (one-shot semantics — the user re-arming a navigation should re-scroll, but a re-render of the same view should not).

**Acceptance:**

- Navigating to a date-titled page with a non-null `selectedBlockId` lands the user with that block in view (`scrollIntoView({ block: 'nearest' })`) and focused.
- Missing-block / null-`selectedBlockId` / non-date page paths unchanged (regression guard tests).
- Scroll fires exactly once per arming — re-renders of the same view with the same `selectedBlockId` do not re-trigger.
- The `TODO(UX-242)` comment in `src/stores/navigation.ts` is removed; the inline note documenting the deferred follow-up goes with it.
- New test cases in `src/components/__tests__/DailyView.test.tsx` (or `DaySection.test.tsx`) cover the happy path + missing-DOM-node + null-id fallthrough + one-shot semantics.

**Files touched (expected):**

- **Edit:** `src/components/DailyView.tsx` and/or `src/components/DaySection.tsx` — read `selectedBlockId` from `useNavigationStore`, add the `useEffect` that schedules `requestAnimationFrame` → `scrollIntoView` + focus, then clears the id.
- **Edit:** `src/stores/navigation.ts` — remove the `TODO(UX-242)` comment block; optional new `consumeSelectedBlockId()` helper if the one-shot clear belongs in the store rather than the component.
- **Tests:** new section/file covering the four cases above.
- **No** backend changes. **No** new IPC commands. **No** new keyboard shortcuts. **No** schema or op-log changes.

**Verification:** `npx vitest run`, `prek run --all-files`. Optionally one e2e probe in an existing journal-navigation spec to assert the scroll fires when clicking a search result whose source block lives in a date-titled page.

**Cost:** S — small wiring change touching DailyView / DaySection + one new test section. No invariant impact, no new abstractions.

**Status:** Open — explicit follow-up filed by UX-242 (session 437); the parent UX-242 (date-routing on title-match navigation) shipped without this final scroll-to-block slice.

### UX-259 — `ConfirmDialog` `autoFocus` lands on the destructive action button

**Problem:** `src/components/ConfirmDialog.tsx:75-86` always sets `autoFocus` on the `<AlertDialogAction>` regardless of variant. For dialogs raised with `actionVariant="destructive"` (purge selected, batch revert, restore-to-here, unpair, compact ops, conflict batch keep/discard) the dialog opens with focus already on the red action button — a reflex Enter confirms the destructive action without ever moving focus.

**Fix:** when `actionVariant === 'destructive'`, focus the Cancel button instead. Drop `autoFocus` on the action; add it to Cancel when destructive. Optionally add a 500 ms grace period before allowing action-button activation so reflex Enter still lands on Cancel.

**Acceptance:** test every destructive caller (`TrashView` purge, `HistoryView` revert + restore-to-here, `ConflictList` batch keep/discard, `UnpairConfirmDialog`, `CompactionCard`) — Enter immediately after the dialog opens must cancel, never confirm. Non-destructive callers retain action-button focus.

**Cost:** S.
**Risk:** M — touches the dialog primitive used by every destructive flow; needs every caller's tests refreshed.
**Impact:** L — directly prevents accidental data destruction across the most dangerous code paths.

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

### UX-261 — `PageTreeItem` delete button is `opacity-0` until hover — invisible to keyboard users

**Problem:** `src/components/PageTreeItem.tsx:58-71` styles the delete button as `opacity-0 group-hover:opacity-100`, with a touch override (`[@media(pointer:coarse)]:opacity-100`) but no `focus-visible` override. Keyboard users tab onto the button, the button is announced via aria-label, but it is invisible — they cannot see what they're about to delete or which row currently owns focus. Violates WCAG 2.1 SC 2.4.7 (Focus Visible).

**Fix:** add `focus-visible:opacity-100` (and ideally `peer-focus-visible:` on the button so the row also shows focus state). Alternatively remove the `opacity-0` rule and accept always-visible delete buttons.

**Cost:** S.
**Risk:** S.
**Impact:** M — fixes a real keyboard-a11y hole on the page tree, one of the highest-traffic surfaces.

### UX-262 — `TabBar` close button nested inside `role="menuitemradio"` — nested-interactive a11y violation

**Problem:** `src/components/TabBar.tsx:245-259` renders an in-dropdown tab close button as a `<button>` inside a `<div role="menuitemradio">`. Nested interactive elements are forbidden by WAI-ARIA — keyboard navigation between menu items doesn't reach the close button, and screen readers may announce the row inconsistently.

**Fix:** restructure to flatten the interactive tree. Preferred (matches the rest of the app's Radix-everywhere stance per AGENTS.md): split into two sibling `MenuItem`s in a row — one activates the tab, one closes it — both reachable by arrow keys. Pair with TEST-13 to assert Esc-closes-dropdown survives the restructure.

**Cost:** S.
**Risk:** M — high-traffic surface; needs a11y + keyboard tests refreshed.
**Impact:** M — closes a clear a11y violation.

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

### UX-266 — Sync status visibility & space-deletion notification

**Problem:**

- `src/components/StatusPanel.tsx:219-295` — sync status is only visible when the StatusPanel card is expanded. When collapsed (the common case), users have no glanceable signal of sync state. The sidebar footer has a "Sync" button but no status indicator.
- `src/stores/sync.ts:11` — `discovering` and `pairing` use the same amber dot (`syncStateDotClasses` in `StatusPanel.tsx:67-82`) and the only differentiator is a text label some users won't read. Either combine into a "Connecting…" state or add per-state icons (checkmark / spinner / X / dash) so the dot carries non-color signal in addition to the existing text.
- `src/stores/space.ts:45-52` — when the current space is deleted on another device, the store silently falls back to the first available space. Users can be confused why they're "in a different space". Add a one-shot toast: "Your active space was deleted on another device. Switched to {{space}}."

**Cost:** S.
**Risk:** S — small additive UI.
**Impact:** M — makes sync state and space changes glanceable.

### UX-267 — Unpair confirmation dialog doesn't explain that ops are retained locally

**Problem:** `src/components/UnpairConfirmDialog.tsx:32-34` confirmation copy says only "You will need to pair again to sync." It doesn't clarify the threat-model-correct behaviour: the operation log is retained locally and on the peer, no notes are deleted, and re-pairing later resumes sync from where it left off. Users routinely fear data loss and back out of legitimate unpairs.

**Fix:** update the i18n string to: "This removes the pairing. Your notes and sync history remain on this device. You can pair again later to resume syncing." Aligns with AGENTS.md threat model (single-user, multi-device).

**Cost:** S — XS, single i18n string.
**Risk:** S.
**Impact:** L — reduces user anxiety and cuts a real "I'll back out instead" friction point.

### UX-268 — Touch-target / mobile sizing fixes across Agenda + Search

**Problem:** A focused review found four real touch-sizing gaps (after filtering out earlier false positives that had already been handled by the `touch-target` utility / Button `size="sm"`):

- `src/components/DuePanelFilters.tsx:74-93` — "Hide before scheduled" toggle uses `text-xs px-1.5 py-0.5` with no `[@media(pointer:coarse)]:min-h-[44px]` and only `title` + `aria-pressed` (no `aria-label`). Add both.
- `src/components/AgendaSortGroupControls.tsx:49-60` — sort/group buttons have `min-h-[44px]` on touch but no `min-w` constraint, producing tall narrow buttons with awkward aspect ratios. Add `[@media(pointer:coarse)]:min-w-[44px]`.
- `src/components/DuePanelFilters.tsx:55-72` — filter pills similarly missing `min-w` on touch.
- `src/components/SourcePageFilter.tsx:119-130` — uses `size="sm"` (h-8 base) plus `min-h-[44px]` on touch; verify the override actually fires (`min-*` doesn't override fixed height when both are set). Likely safer to switch to `size="icon"` or to `h-7 w-7 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11`.
- `src/components/BacklinkFilterBuilder.tsx:336-346` — add-filter row switches to `flex-col` on touch but child inputs still have fixed widths (`w-24`, `w-40`); add `[@media(pointer:coarse)]:w-full` on the children.

**Cost:** S — bundle of XS items.
**Risk:** S — pure CSS.
**Impact:** M — fixes a handful of real one-handed mobile-tap frustrations.

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

### UX-271 — Backlinks linked-vs-unlinked distinction & filter discoverability

**Problem:**

- `src/components/BacklinkGroupRenderer.tsx:1-86` — renders backlink groups with no visible signal of whether each is "Linked" (`[[ref]]`) or "Unlinked" (mention without link). FEATURE-MAP.md:128-129 documents the two as distinct sections; the renderer makes them indistinguishable. Add a badge or icon, fed by a prop from the parent (`LinkedReferences` vs `UnlinkedReferences`).
- `src/components/LinkedReferences.tsx:1-413` — has advanced filters (type, status, priority, contains, property, date, has-tag, tag-prefix) but no count badge on the "Advanced filters" trigger when filters are active. Compare with `AgendaFilterBuilder` which surfaces active count.
- `src/components/BacklinkFilterBuilder.tsx:547-571` — `SearchablePopover` is used for tag selection but no explicit scroll handling for large tag lists; verify the popover internally uses `ScrollArea` (otherwise wrap).

**Cost:** S.
**Risk:** S.
**Impact:** M — clarifies one of the most useful but most-confused surfaces.

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

### UX-276 — Settings: tab persistence + URL deep-link support

**Problem:**

- `src/components/SettingsView.tsx:128` — `activeTab` is `useState<SettingsTab>('general')`; navigating away and back resets to General. The font-size pref already uses localStorage (line 149); follow the same pattern.
- `src/components/SettingsView.tsx:126-178` — no URL-based deep-link to a specific tab. Power users and support flows can't share `…?settings=keyboard` links. Sync `activeTab` with a query param via `useNavigationStore` (or a thin wrapper).

**Cost:** S.
**Risk:** M (deep-link path) — needs coordination with the navigation store.
**Impact:** M.

### UX-277 — `BugReportDialog` polish

**Problem:**

- `src/components/BugReportDialog.tsx:319-332` — uses a native `<input type="checkbox">` instead of the design-system `Checkbox` (`src/components/ui/checkbox.tsx`). Inconsistent focus styling.
- `src/components/BugReportDialog.tsx:170-192` — successful submit closes the dialog and opens the GitHub issue URL but shows no toast. Add `toast.success(t('bugReport.submitted'))`.
- `src/components/BugReportDialog.tsx:283-315` — logs section lists filenames + sizes but offers no preview of contents. Users cannot verify what data they're submitting. Add a per-entry "Preview" button that shows the first 500 chars in a modal.

**Cost:** S — for items 1+2; M if log preview is included.
**Risk:** S.
**Impact:** M — improves transparency and design-system parity.

### UX-278 — `WelcomeModal` i18n + semantic markup

**Problem:**

- `src/components/WelcomeModal.tsx:59-103` — onboarding sample-page content ("Getting Started", "Welcome to Agaric! This is a local-first note-taking app.", "Quick Tips") is hardcoded English. Non-English users see UI chrome localised but onboarding content in English.
- `src/components/WelcomeModal.tsx:158-169` — feature list uses `<div>` per item; should be `<ul role="list">` + `<li>` for proper SR semantics.

**Fix:** lift sample content into i18n keys (or document explicitly in REVIEW-LATER that English samples are an intentional learning-aid choice). Wrap the feature list in `<ul>`.

**Cost:** S.
**Risk:** S.
**Impact:** S.

### UX-279 — `FeatureErrorBoundary` lacks "Report bug" affordance

**Problem:** `src/components/FeatureErrorBoundary.tsx:39-64` (section-level error boundary) only offers "Retry"; the global `ErrorBoundary` offers both "Reload" and "Report bug". For consistency and support workflows, section-level crashes should also surface the bug-report path.

**Fix:** add a "Report bug" button that opens `BugReportDialog` with the error message and stack trace pre-filled. Requires plumbing — either pass `onReportBug` callback through children, use a React context, or dispatch a global event. Match the cost/complexity tier to the value: a global event is the smallest change.

**Cost:** M.
**Risk:** M.
**Impact:** M.

### UX-280 — Attachments / Image / PDF polish

**Problem:**

- `src/components/PdfViewerDialog.tsx:31-250` — Prev/Next buttons but no keyboard shortcuts (Arrow Left/Right, PageUp/PageDown). Add a `useEffect` with the dialog as the focus root.
- `src/components/ImageResizeToolbar.tsx:51-65` — preset buttons change variant based on `currentWidth` but no `aria-pressed`. Add `aria-pressed={currentWidth === preset.value}`.

**Cost:** S.
**Risk:** S.
**Impact:** S.

### UX-281 — Suggestion list & roving editor polish

**Problem:**

- `src/editor/SuggestionList.tsx:188-198` — suggestion category headers are plain `<div>`s with no semantic role. Use `<h3>` or `role="heading" aria-level="3"`. Verify keyboard nav still skips them.
- `src/editor/markdown-serializer.ts:249-250, 407-410` — when an unknown TipTap inline node type appears, the serializer logs a warn and strips the content. The user gets no UI signal that data was dropped (rare but possible after an extension upgrade). Surface a `toast.warning(t('editor.unknownNodeType', { type }))` on the first occurrence per session (rate-limited).
- `src/components/BlockGutterControls.tsx:104-112` — gutter buttons rely on tooltips for labels; on touch (no hover), the label is hidden. Either show inline labels on `pointer:coarse` or move to a long-press affordance.

**Cost:** S.
**Risk:** S.
**Impact:** S.

### UX-282 — `src/lib/announcer.ts` is largely unused

**Problem:** `src/lib/announcer.ts` exposes `announce(message)` for SR-only announcements, and `src/lib/i18n.ts` defines a full `announce.*` keyspace (e.g. `announce.blockDeleted`, `announce.taskState`, `announce.navigatedToPrevious`). The keys are wired in some App-level handlers (`src/App.tsx:184-200` journal nav) but most user actions — toast successes, batch ops, drag-reschedule, conflict resolution — only show visual toasts and never call `announce()`. The accessibility infrastructure is paid for but not used.

**Fix:** audit every action that emits a toast or updates state visibly, and call `announce(t('announce.<key>'))` in parallel. Group by feature area: undo/redo, batch ops, conflict resolution, sync events, agenda reschedule, page rename / move / delete. Add a regression test (component or e2e) per cluster: spy on `announce()` and assert it's called with the expected i18n key.

**Cost:** M — broad sweep.
**Risk:** S — additive.
**Impact:** L — completes a documented a11y commitment that is currently fictional in most flows.

### UX-283 — Templates / Data settings polish

**Problem:**

- `src/components/TemplatesView.tsx:35-245` — when the search filter yields zero matches, the list is silently empty; users may think there are no templates at all. Add an `EmptyState` with `t('templates.noSearchResults')` when `filtered.length === 0 && search.length > 0`.
- `src/components/DataSettingsTab.tsx:28-71` — multi-file imports show only a single spinner; no per-file progress. Render "Importing file 2 of 5: document.md" during the loop.

**Cost:** S.
**Risk:** S.
**Impact:** S.

### UX-284 — `RecentPagesStrip` and `SpaceSwitcher` discoverability

**Problem:**

- `src/components/RecentPagesStrip.tsx:65-80` — supports arrow-key navigation (UX-256) but the focused chip relies entirely on the `Button` ring; consider also a subtle background tint to make the focus location more obvious.
- `src/components/SpaceSwitcher.tsx:79-100` — disabled "Manage spaces…" entry has a tooltip on hover, but tooltips don't fire on touch. Add a small info icon (`Info` from lucide) next to the text so the tooltip target is also visible to mobile users.

**Cost:** S.
**Risk:** S.
**Impact:** S.

---

## PUB — Public-release / pre-publish decisions

> **Every item in this section was gated on explicit user approval.**
> Decisions are now recorded inline under each item. Items marked **DECIDED**
> are ready for implementation in a future publish-prep session. Items marked
> **DEFERRED** remain on hold until the triggering condition (usually a firm
> publish target + timing) is met; agents must not revisit those during
> routine REVIEW-LATER sweeps. No additional user approval is required to
> implement a DECIDED item, but the implementation itself must still follow
> the standard PLAN → BUILD → REVIEW → MERGE → COMMIT → LOG pipeline.

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

### PUB-5 — Tauri updater endpoint points to a GitHub org/repo that does not yet exist

**Problem:** `src-tauri/tauri.conf.json:27-33` has:
```json
"updater": {
  "endpoints": [
    "https://github.com/agaric-app/org-mode-for-the-rest-of-us/releases/latest/download/latest.json"
  ],
  "pubkey": ""
}
```
The `agaric-app` GitHub org does not necessarily exist, the public release repo is not yet created, and `pubkey` is empty (the `TAURI_SIGNING_PRIVATE_KEY` in `.github/workflows/release.yml` is commented out with a TODO). On a tagged release today, the updater URL would 404 and signing would be unconfigured. Before any public release binary is built, this needs to match real infrastructure.

**Options:**
1. **Before publishing:** create the GitHub org/repo, generate Tauri signing keys (`cargo tauri signer generate`), upload the public key to `pubkey`, store the private key in GitHub Secrets as `TAURI_SIGNING_PRIVATE_KEY` (+ password), and uncomment the two lines in `release.yml`.
2. **Disable the updater entirely** for the first public release. Remove the `updater` block from `tauri.conf.json` and the `tauri-plugin-updater` dependency from `src-tauri/Cargo.toml` until the infrastructure is in place.
3. **Change the endpoint** to the actual publish target (e.g., `github.com/<final-org>/<final-repo>/releases/...`) once it is known.

**Cost:** S (per option)
**Decision:** Defer — the publish target is not yet locked in. Revisit together with PUB-2 and PUB-7 when a publish plan is concrete. No changes to `tauri.conf.json`, `Cargo.toml`, or `release.yml` until then.
**Status:** DEFERRED — revisit when the publish target/timing is decided.

### PUB-7 — Missing `SECURITY.md` — private-disclosure contact pending publish target

**Problem:** `SECURITY.md` is the standard GitHub-recognised private-disclosure file. The repo does not ship one yet. For a local-first single-user app with no adversarial-peer threat model (see AGENTS.md), the file is mostly a courtesy affordance — it documents the reporting channel and the scope of "things worth reporting" so surface-level finders don't waste time filing issues against the sync protocol's peer authentication (which is deliberately non-adversarial).

**Blocker:** no private-disclosure contact is locked in yet. Options considered in a prior batch (personal email / GitHub Security Advisories only / placeholder pointing at Security tab) were all deferred until the publish target is concrete (PUB-5). The Code of Conduct already ships (Contributor Covenant 2.1) with a deferred contact line that forward-references `SECURITY.md`.

**Implementation (when PUB-5 unblocks):**
- `SECURITY.md` — private contact (personal email, Matrix handle, or GitHub Security Advisory-only policy), a one-paragraph restatement of the local-first threat model from AGENTS.md so reporters don't file "sync peer DoS" reports, and a line about what the project does and does not accept (no bug bounty, local-only, etc.).
- Once `SECURITY.md` lands, update the `CODE_OF_CONDUCT.md` Enforcement section so its pointer line resolves cleanly (it currently reads "Contact details will be published in `SECURITY.md` before the first public release.").

**Cost:** S — ~30 min once the contact is picked.
**Decision:** Defer alongside PUB-5 — revisit when the publish target + timing is concrete.
**Status:** DEFERRED — revisit with PUB-5.
