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

22 open items.

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
| TEST-1 | TEST | Frontend test coverage gaps in 6 specific files surfaced by review (filter-pill, switch, textarea, useEditorBlur portal scan, page-blocks loadSubtree cap, main.tsx error handlers) | S |
| UX-257 | UX | Breadcrumb bar (zoom + page header) doesn't read as a breadcrumb, is oversized, and styling is inconsistent across the two surfaces | M |
| UX-258 | UX | DailyView / DaySection don't scroll to `selectedBlockId` on mount when navigating into a date-titled page (`TODO(UX-242)` in `src/stores/navigation.ts`) | S |
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
