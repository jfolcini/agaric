<!-- markdownlint-disable MD060 -->
# Frontend & Spaces

How the UI is wired together. Companion to [`docs/UI-MAP.md`](../UI-MAP.md) (surface tree + glossary).

## State

State lives in Zustand stores under `src/stores/`. One store per concern:

- `boot.ts` — boot lifecycle (`booting` / `ready` / `error`).
- `blocks.ts` — global block focus + multi-selection. Holds `focusedBlockId` and `selectedBlockIds: string[]`.
- `page-blocks.ts` — **per-page factory**. `createPageBlockStore(pageId)` mints an independent store wrapped in `PageBlockStoreProvider`; the module-level `pageBlockRegistry` lets siblings reach in by `pageId`. Dependencies flow one way: page-block stores → global focus, never the reverse.
- `journal.ts` — date cursor + mode (`daily` / `weekly` / `monthly` / `agenda`). Per-space slice: `currentDateBySpace`, `modeBySpace`.
- `navigation.ts` — `currentView`, `selectedBlockId`, `currentViewBySpace`. (Tab state lives in `tabs.ts`.)
- `tabs.ts` — page-stack per tab + active tab. Per-space slice: `tabsBySpace`.
- `recent-pages.ts` — recent pages strip. Per-space slice: `recentPagesBySpace`.
- `space.ts` — `currentSpaceId` + `availableSpaces`.
- `sync.ts` — sync state (`idle` / `syncing` / `error` / `offline` / `pending` / `disabled`) + per-peer progress.
- `resolve.ts` — ULID → title cache, keyed by `${spaceId}::${ulid}` (with `__global__` sentinel for cross-space resolution).
- `undo.ts` — page-level undo/redo stacks. `UNDO_GROUP_WINDOW_MS` + `MAX_REDO_STACK` constants here.

**Selector discipline.** Always select individual slices: `useStore(s => s.slice)`. Destructuring (`const { a, b } = useStore()`) re-renders on every state change.

**`useStore.getState()` inside async callbacks is intentional** — it reads fresh state instead of the closure snapshot. Don't refactor it to a hook call.

## ViewDispatcher (no router)

`src/components/pages/ViewDispatcher.tsx` is the single source of truth for which view renders. It switches on `useNavigationStore.currentView` (a 12-value enum: `journal | search | pages | tags | properties | trash | status | history | templates | settings | graph | page-editor`).

No router. Navigation is store-driven. `useTabsStore` owns the per-tab page stack; `useNavigationStore` owns the active view. `agaric://` deep links are parsed by the Rust backend, emitted as Tauri events, and dispatched into the nav / tabs stores by `useDeepLinkRouter`.

**Lazy boundary.** Only `JournalPage` is eager-mounted. Every other view is `React.lazy()` + `<Suspense fallback={<ViewFallback />}>`. Each lazy view becomes its own Rollup chunk.

**Error boundaries.** Every view in the dispatcher is wrapped in `FeatureErrorBoundary` so a crashed view doesn't take down the shell.

## App shell

`App.tsx` mounts:

```text
BootGate
  SpaceTopStripe          (3 px accent bar)
  GcalReauthBanner        (conditional)
  SidebarProvider
    AppSidebar            (collapsible left rail)
    SidebarInset
      Header bar
      TabBar              (hoisted; hidden on mobile / 1 tab)
      RecentPagesStrip    (desktop chip grid)
      ViewHeaderOutletSlot
      ScrollArea
        ViewDispatcher → one of the views
  Suspense
    KeyboardShortcuts, WelcomeModal, BugReportDialog,
    QuickCaptureDialog, NoPeersDialog       (all lazy)
  Toaster
```

`ViewHeaderOutletSlot` is the per-view sticky-header outlet — a React portal that hoists view-specific headers (mainly `PageHeader`) outside the `ScrollArea` so they stay pinned.

## View transitions & scroll restoration

Cross-view transitions use a rAF-driven opacity fade gated by `prefers-reduced-motion`. Scroll position per view is held in a `Map<viewKey, number>` and re-applied after the new view mounts. The key is `${currentView}` for most views and `page-editor:${pageId}` for the page editor.

## Drag and drop

`@dnd-kit` with split sensors (mouse: distance; touch: delay) so scrolling doesn't accidentally start drags. Depth projection on every drag move: `horizontal_offset / indent_width`, clamped to sibling bounds. Drop indicator is a thin bar styled with `margin-left: calc(var(--indent-width) * depth)`. Auto-scroll near viewport edges via `useAutoScrollOnDrag` (rAF + reduced-motion-aware).

Sentinel-drop-zone behind every block prevents the "no drop target on the empty area" UX bug.

## Spaces

A space is a `blocks` row with `block_type = 'page'` and an `is_space = 'true'` property. No new tables. No new op types. No new sync messages. The space model is layered on the existing property system — that's the architectural commitment.

Every page carries a `space` property whose `value_ref` is the space's ULID. Lists, search, agenda, backlinks, history, journal, link picker all filter by this property when the active scope is `Active(space_id)` (the canonical `SpaceScope`).

### Data model

- **Seeded spaces** — Personal and Work are seeded on first boot. Both use deterministic ULIDs (`SPACE_PERSONAL_ULID` / `SPACE_WORK_ULID` constants) so peer devices converge without a name match.
- **Per-space keychain accounts** — GCal stores OAuth tokens under per-space keychain entries (`oauth_tokens_<SPACE_ULID>`).
- **Legacy migration** — pre-spaces pages are routed to Personal or Work by a time-gated boot migration (one-shot, idempotent).
- **Bootstrap re-runs every boot** — `pages_without_space` backfill is defensive: any page lacking a `space` property gets one (handles peer-synced or future-bypass cases).

### Scoping rules

- **Tauri commands.** Every list / search / agenda / backlink / history command takes a `SpaceScope` argument: `Active(SpaceId)` (filter) or `Global` (unscoped — used by MCP, GCal connector).
- **SQL.** The canonical space-filter clause is pinned by `SPACE_FILTER_CANONICAL` constant + a parity test (`space_filter_canonical.rs`) that ensures the same predicate appears at every read site.
- **Cross-space links.** Three enforcement points: `edit_block`'s content scan, `set_property`'s ref-type validation, `add_tag`'s space check. A `[[ULID]]` to a foreign-space target is rejected at write time AND rendered as a broken-link chip at render time.
- **`create_block` IPC tightening.** Pages without a `space_id` are rejected at the IPC boundary. The four legacy FE bypass call sites (JournalPage daily / TemplatesView / WelcomeModal / `useBlockDatePicker`) all route through `createPageInSpace`.

### Per-space store partitioning

Four stores carry per-space slices: `tabs.tabsBySpace`, `navigation.currentViewBySpace`, `journal.currentDateBySpace` (+ `modeBySpace`), `recent-pages.recentPagesBySpace`. All four are driven by one shared helper, `createSpaceSubscriber` (`src/lib/createSpaceSubscriber.ts`), keyed via `activeSpaceKey()` (`src/lib/active-space.ts`) with `LEGACY_SPACE_KEY = '__legacy__'` for pre-bootstrap state.

There is exactly one subscriber pattern, not four — adding a fifth per-space slice means consuming the same helper.

### Resolve cache

`useResolveStore` uses composite cache keys: `${spaceId}::${ulid}`. The sentinel `__global__` is used when the resolver runs in `Global` scope (cross-space view lookups). On space switch, `clearAllForSpace(prevSpaceId)` fires before the new space takes effect — prevents stale chip titles flashing across the switch.

### Frontend integration surfaces

- **SpaceSwitcher** — Radix Select dropdown in `SidebarHeader`. Shows current space + alphabetical list + `Manage spaces…` entry. On a collapsed sidebar, replaced by **SpaceAccentBadge** (32 px coloured circle; click cycles to next space).
- **SpaceTopStripe** — 3 px accent bar across the top of the window.
- **SpaceManageDialog** — five sub-components (`SpaceRowEditor`, `SpaceAccentPicker`, `SpaceDeleteButton`, `SpaceJournalTemplateEditor`, `SpaceNameEditor`, plus `SpaceOnboardingHint`). Onboarding banner shows while `availableSpaces.length ≤ 2`.
- **Digit hotkeys** — `Ctrl+1`–`Ctrl+9` (or `⌘1`–`⌘9` on macOS) switch to the first nine spaces alphabetically. The hint chip on the first nine dropdown rows shows the binding.
- **OS window title prefix** — `<SpaceName> · Agaric` via Tauri's window-title API. No-op on browser-dev / vitest.

### What's per-space (full list)

Tabs, recent pages, active view, journal date, journal mode, journal template, GCal connector configuration (foundation in place; per-space connector is the active in-progress slice), search results, agenda projections, backlinks, history view default filter (with opt-in "All spaces" toggle).

### What's not per-space

Drafts, undo stacks (per-page, not per-space — `useUndoStore` is not space-partitioned by design), keyboard customisations, theme, sidebar width, link preview cache.

## Reduced motion + a11y

See `docs/UX.md § Accessibility` for the canonical rule. Frontend specifics: hooks that drive motion (`useScrollToFocus`, `useAutoScrollOnDrag`, `useKeyboardNavigableList`) check `prefers-reduced-motion` and skip the smooth path. Roving tabindex is used in `SearchablePopover`, `RecentPagesStrip`, `TabBar` — exactly one `tabindex=0` per group, arrows move it.

## Tauri command wrappers

`src/lib/tauri.ts` wraps every `invoke()` call in a type-safe function. The bindings type is regenerated by specta (`src/lib/bindings.ts`, checked in, CI-enforced). The wrapper layer also handles Tauri 2's explicit-null-vs-undefined contract (Tauri rejects `undefined` over the wire; the wrapper coerces).

## Component inventory

The full inventory lives in [`docs/UI-MAP.md`](../UI-MAP.md). The architecture-relevant fact is the layering:

- `src/components/ui/` — shadcn-style primitives. Anything new should reuse from here first.
- `src/components/` — domain components.
- `src/components/<Feature>/` — per-feature sub-component directories (FormattingToolbar, PropertyRowEditor, SpaceManageDialog, …).

The decomposition pattern (a "god component" with a `biome-ignore` for cognitive complexity → orchestrator + per-concern children + a containing hook) is documented in `docs/UX.md § UI primitives`.
