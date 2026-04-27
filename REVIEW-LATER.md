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

4 open items.

Previously resolved: 542+ items across 159 sessions.

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

### FEAT-11 — Adopt `tauri-plugin-notification` (OS notifications for due tasks / scheduled events)

**Problem:** The app has agenda + due dates + scheduled dates + repeat properties + projected agenda + the Google Calendar push connector (FEAT-5), but zero OS-level notification path. A user with "buy groceries — DUE 09:00" cannot be notified by the OS unless the GCal push has already fired and their calendar app shows it. Org-mode / Logseq users expect "10 minutes before scheduled" and "due now" to surface as native notifications.

**Fix:** Adopt `@tauri-apps/plugin-notification` + `tauri-plugin-notification`. New backend module `src-tauri/src/notifier/mod.rs` schedules notifications based on `due_date` + `scheduled_date` + property events from the materializer (analogous to `gcal_push::DirtyEvent`). Reuses the existing `agenda_view` queries to find blocks within the next-24h window on boot and on every materialize commit. Frontend: a Settings tab toggle + per-property filter. Mobile permissions: request `POST_NOTIFICATIONS` on Android 13+ via the plugin's permission API. Coupled stack — bump with the rest of the Tauri plugins.

**Cost:** L — design (which events fire? how to dedupe? snooze semantics?), backend scheduler (~6 files), one Settings sub-tab, mobile permission flow, ~25 tests.
**Risk:** M — wrong-time notifications and notification spam are both real failure modes; needs careful dedupe and "do not re-fire on materialize replay" guard.
**Impact:** L — closes a recognised feature gap with Org-mode / Logseq parity; especially valuable on mobile where the user is unlikely to have the app foregrounded when a task is due.

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
| Net findings in this report | 333 |
| **Critical** | **1** |
| **High** | **6** |
| **Medium** | **36** |
| **Low** | **124** |
| **Info / nits** | **125** |

### Top-priority items (Impact ÷ Cost)

1. **C-2b** — Boot-time op-log replay path for unmaterialized ops; op_log diverges from materialized state with no automatic remediation (<ref_file file="/home/javier/dev/org-mode-for-the-rest-of-us/src-tauri/src/materializer/consumer.rs" />). C-2a (divergence detection) shipped — divergence is now visible via `fg_apply_dropped` in `StatusInfo`; C-2b remains as the actual replay path. **Schema migration approval required**.
2. **H-4** — `set_todo_state_inner` runs state change + timestamp writes + recurrence sibling creation across separate transactions; crash mid-sequence leaves recurring task stuck (<ref_file file="/home/javier/dev/org-mode-for-the-rest-of-us/src-tauri/src/commands/properties.rs" />).
3. **H-13** — Op-log immutability has zero database-level enforcement; only application-level invariant (<ref_file file="/home/javier/dev/org-mode-for-the-rest-of-us/src-tauri/src/op_log.rs" />).
4. **H-17** — `recurrence::handle_recurrence` reads counters BEFORE `BEGIN IMMEDIATE` (TOCTOU); two clicks on a recurring task can duplicate or skip the next-occurrence sibling (<ref_file file="/home/javier/dev/org-mode-for-the-rest-of-us/src-tauri/src/recurrence/handle.rs" />).

### Findings by Domain × Severity

| Domain | Crit | High | Med | Low | Info |
|---|---|---|---|---|---|
| Core data layer | 0 | 1 | 6 | 9 | 11 |
| Materializer | 1 | 2 | 6 | 8 | 4 |
| Cache + Pagination | 0 | 0 | 6 | 12 | 6 |
| Commands (CRUD) | 0 | 1 | 6 | 9 | 13 |
| Commands (System) | 0 | 2 | 12 | 13 | 6 |
| Sync stack | 0 | 3 | 13 | 25 | 5 |
| Search & Links | 0 | 2 | 4 | 16 | 19 |
| Lifecycle / Snapshots | 0 | 0 | 17 | 16 | 8 |
| MCP | 0 | 0 | 6 | 12 | 8 |
| GCal / Spaces / Drafts | 0 | 0 | 9 | 11 | 9 |

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
| **H-17** | `recurrence::handle_recurrence` reads counters before BEGIN IMMEDIATE (TOCTOU) | Two clicks duplicate next-occurrence sibling |
| **M-23** | `flush_draft_inner` reads `prev_edit` outside the flush transaction | Conflict-detection asymmetry vs `edit_block_inner` |

---

## CRITICAL findings (1)

### C-2b — Boot-time op-log replay path for unmaterialized ops
- **Domain:** Materializer / Recovery
- **Location:** `src-tauri/src/recovery/boot.rs:43-126`; `src-tauri/src/materializer/coordinator.rs`
- **What:** On boot, identify ops whose materialized state is missing or stale (e.g., compare `op_log` max-seq vs each derived table's high-water mark) and re-enqueue them through the materializer foreground queue. Idempotent: every existing op handler is already idempotent or trivially convertible (the materializer ALREADY uses `INSERT OR IGNORE` / UPSERT on the convergence path).
- **Why it matters:** This is the actual fix for the C-2 family of findings: foreground `ApplyOp` / `BatchApplyOps` failures only bump `fg_errors` + `fg_apply_dropped` and the task is dropped after a single 100ms in-memory retry — there is no persistent retry queue (`RetryKind::from_task` excludes both task types) and no boot-time op-log replay path (`recover_at_boot` only handles drafts and pending snapshots). With C-2b in place, op log truly is the source of truth: even after a crash mid-apply or a transient FK contention drop, the next boot reconciles automatically. C-2a (divergence detection — `fg_apply_dropped` metric + warn line) shipped, so the divergence rate is now observable in `StatusInfo`.
- **Cost:** M–L
- **Risk:** Medium (idempotency must be verified end-to-end across every op handler; replay needs progress markers so a partial replay survives a second crash)
- **Impact:** High (closes the last automatic-divergence gap in CQRS)
- **Recommendation:** Build on the existing `recover_at_boot` infrastructure. Each derived table tracks a "materialized through seq N" cursor; the replay walks `op_log WHERE seq > cursor`. Add an integration test that injects ApplyOp failure mid-batch, restarts the pool, and asserts state convergence post-replay. **Schema migration required** (per-table cursor tracking) — needs explicit user approval before implementing per AGENTS.md "Architectural Stability".
- **Status:** Open. No dependencies (C-2a shipped). Schema migration approval required.

---

## HIGH findings (6)

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

### H-9 — Bug-report redaction allow-list misses GCal email, peer device IDs, and any other PII (parent — split into H-9b, H-9c after H-9a shipped)
- **Domain:** Commands / System
- **Location:** `src-tauri/src/commands/bug_report.rs`
- **What:** Redaction now scrubs `$HOME` + local `device_id` + GCal email + peer device IDs + a generic email regex (H-9a shipped). The remaining work is the architectural shift to a deny-list (H-9b) and the user-facing preview UI (H-9c).
- **Why it matters:** H-9a closed the immediate user-visible leak vectors. H-9b makes the redaction posture future-proof; H-9c adds defense-in-depth UI.
- **Cost:** L (combined) — split into H-9b (M, generic redaction architecture), H-9c (M, preview UI). Both can be scheduled separately.
- **Pass-1 source:** 05-commands-system / F5

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

## MEDIUM findings (44 — expanded)

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

### Cache + Pagination

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

## LOW findings (101 — expanded)

> Each entry is a fully-detailed block (Domain / Location / What / Why / Cost / Risk / Impact / Recommendation / Pass-1 source / Status).

### Core

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

### Materializer

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

## INFO / nits (68 — expanded)

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
