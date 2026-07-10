<!-- markdownlint-disable MD060 -->
# Frontend & Spaces

How the UI is wired together. Companion to [`docs/UI-MAP.md`](../UI-MAP.md) (surface tree + glossary).

## State

State lives in Zustand stores under `src/stores/`. One store per concern:

- `boot.ts` — boot lifecycle (`booting` / `ready` / `error`).
- `blocks.ts` — global block focus + multi-selection. Holds `focusedBlockId` and `selectedBlockIds: string[]`. Edit/select-mode exclusivity and the selection-clear-on-navigation lifecycle are pinned mechanically by `src/stores/__tests__/store-invariants.test.ts` (#2465).
- `page-blocks.ts` — **per-page factory**. `createPageBlockStore(pageId)` mints an independent store wrapped in `PageBlockStoreProvider`; the module-level `pageBlockRegistry` lets siblings reach in by `pageId`. Dependencies flow one way: page-block stores → global focus, never the reverse — enforced mechanically by the `store-layering` prek hook (`scripts/check-store-layering.mjs`, #2465).
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

## Store-action failure contract

Page-block store actions (`src/stores/page-blocks-reducers.ts`, wired into the factory in `src/stores/page-blocks.ts`) never reject. Every mutating action — `createBelow`, `edit`, `remove`, `splitBlock`, `reorder`, `moveToParent`, `moveBlocks`, `indent`/`dedent`/`moveUp`/`moveDown`, `pasteBlocks` — wraps its `invoke()` call in its own `try/catch`, and on failure: (1) logs a structured error (`logger.error('page-blocks', ...)`), (2) shows a user-visible toast (`notify.error(i18n.t('error.xFailed'))`), (3) rolls back whatever optimistic write it applied (e.g. `edit` restores `previousContent` only if the live content still matches what it wrote — `page-blocks-reducers.ts` lines 259-283), and (4) **resolves, never rejects** — `false`/`void`, or (for the id-returning `createBelow`/`pasteBlocks`) `null`/`[]` (empty or partial) on failure.

This is #2462 off the FE↔BE boundary review, filed after the #2451 audit found every keyboard handler's failure path was dead code (built for a throw-on-failure contract the store never had) and every existing failure test mocked the store as throwing — the #2407 class, where a Backspace-merge permanently deleted a source block whose merged content never actually saved. The regression test for that fix lives in `src/hooks/__tests__/useBlockKeyboardHandlers.test.ts` under `describe('merge honors edit() resolving false (store contract)')` — it mocks `edit: vi.fn(async () => false)`, never `mockRejectedValue`. **Any new failure-path test must mock the store the same way**: `mockResolvedValue(false)` / `vi.fn(async () => false)`, never `mockRejectedValue` — a rejecting mock tests a contract the store doesn't implement.

### Boolean vs void — and why

Actions whose result gates a caller's follow-up decision resolve a **boolean**; actions whose only observable effect is the mutation itself resolve **void**. From the JSDoc on `PageBlockState` in `src/stores/page-blocks-types.ts`:

- **`boolean`**: `edit`, `splitBlock`, `indent`, `dedent`, `moveUp`, `moveDown` — `true` on success, `false` on a caught backend error (or, for the movers, a legitimate no-op). `edit`'s `false` is what `useBlockKeyboardHandlers`' merge handlers gate `remove()` on (the #2407 fix): don't delete the source block of a merge unless the merged content actually landed. `splitBlock` mirrors `edit`'s resolve-false contract end-to-end so the blur path (`useEditorBlur.ts` → `discardDraft`) can forward its outcome and keep the crash-recovery draft row alive when the first-line write failed — `useDraftAutosave.ts`'s `discardDraftFor` gates the delete on `ok === false`.
- **`void`**: `load`, `remove`, `reorder`, `moveToParent`, `moveBlocks` — the mutation either lands or it doesn't, and (today) no caller needs the resolved value itself to branch on. `remove`'s void resolution is the outstanding straggler the issue calls out: two call sites in `src/components/editor/BlockTree.tsx` (around lines 696-704 and 714-728) need to know whether `remove`/`moveBlocks` actually succeeded (the #1342 reparent-before-delete sequencing for merges), so they wrap the store action, re-check the post-call state against the store, and **throw** if the mutation didn't happen — a local adapter converting the void-either-way contract into a throw for that one try/catch-based caller. This wrapper is the exception that proves the rule: it exists at exactly two call sites because those two callers need a signal the store doesn't otherwise expose, not because throwing is the general contract.

### The toast funnel — two layers, same shape

`docs/architecture/tooling.md` names `reportIpcError` (`src/lib/report-ipc-error.ts`) as "the canonical IPC-error funnel," and component/hook-level `catch` blocks (`EditableBlock.tsx`, `BlockPropertyDrawer.tsx`, `useSearchResults.ts`, etc.) do call it directly. Store actions **do not** — `reportIpcError` takes the `TFunction` returned by `useTranslation()`, which requires a component render context the vanilla Zustand store (created outside React, in `createPageBlockStore`) doesn't have. Instead every reducer inlines the same two-step shape by hand: `logger.error('page-blocks', ..., err)` + `notify.error(i18n.t('error.xFailed'))`, using the standalone `i18n.t` export rather than a hook-bound `t`. Same log-then-toast contract, different call surface for the same structural reason (no React context inside a store factory) — not a second, divergent error path.

### `pool_busy` retry policy

`pool_busy` is a first-class `AppError` kind (`src/lib/app-error.ts`) for transient sqlx connection-pool exhaustion. Every mutating IPC call inside `page-blocks-reducers.ts`, plus the autosave writes in `src/hooks/useDraftAutosave.ts` and the failed-save draft re-save in `EditableBlock.tsx`, wraps its `invoke()` in `retryOnPoolBusy` (three attempts, 0/50/150 ms backoff) **before** the surrounding `try/catch`. The policy is uniform, not per-call-site: `retryOnPoolBusy` re-throws every non-`pool_busy` error immediately, and once its own retries are exhausted it throws the last `pool_busy` `AppError` too — at which point it's handled by that action's ordinary catch block exactly like any other backend failure (logged, generic `error.xFailed` toast, rollback). No FE path surfaces `pool_busy` to the user as a distinct case; `isPoolBusy` is used in exactly one place (`useDraftAutosave.ts`) purely to label a post-exhaustion log line, not to branch the user-facing outcome.

### What a new store action must do

1. Wrap the `invoke()` call (via `retryOnPoolBusy` if it's a plain write) in `try/catch`. Never let an IPC rejection propagate out of the action.
2. On failure: `logger.error('page-blocks', ...)`, then `notify.error(i18n.t('error.<action>Failed'))` — add the i18n key.
3. Roll back the optimistic update, guarded so a newer in-flight write for the same block isn't clobbered (see `edit`'s `cur.content !== content` check).
4. Resolve `true`/`false` if any caller will ever need to gate follow-up work on the outcome (draft discard, cascading delete, announcing success to assistive tech); resolve `void` only if truly nothing downstream depends on knowing whether the write landed. Document the choice in the action's JSDoc in `page-blocks-types.ts`, matching the existing entries.
5. Never `throw`.

**The one-line rule for callers:** never wrap a store action call in `try/catch` — branch on its resolved value instead. A store action that appears to reject is either a test double built for the wrong contract, or a call-site wrapper (like `BlockTree.tsx`'s `remove`/`moveBlocks`) explicitly converting a void result into a throw for a specific downstream need — not evidence that the store itself rejects.

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

A space is a `blocks` row with `block_type = 'page'` and an `is_space = 'true'` property. No new op types. No new sync messages.

Page membership lives in the native, indexed `blocks.space_id` column (migration 0086, #533) — the sole source of truth. `space` is no longer a property (forbidden by the 0088 `key_not_reserved` CHECK); the `is_space = 'true'` marker on a space's own page is the only space-related property that remains. Lists, search, agenda, backlinks, history, journal, link picker all filter by `b.space_id = ?N` when the active scope is `Active(space_id)` (the canonical `SpaceScope`).

### Data model

- **Seeded spaces** — Personal and Work are seeded on first boot. Both use deterministic ULIDs (`SPACE_PERSONAL_ULID` / `SPACE_WORK_ULID` constants) so peer devices converge without a name match.
- **Legacy migration** — pre-spaces pages are routed to Personal or Work by a time-gated boot migration (one-shot, idempotent).
- **Bootstrap re-runs every boot** — `pages_without_space` backfill is defensive: any page lacking a `space_id` gets one via `UPDATE blocks SET space_id = ?` (`bootstrap.rs`, handles peer-synced or future-bypass cases).

### Scoping rules

- **Tauri commands.** Every list / search / agenda / backlink / history command takes a `SpaceScope` argument: `Active(SpaceId)` (filter) or `Global` (unscoped — used by MCP).
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

Tabs, recent pages, active view, journal date, journal mode, journal template, search results, agenda projections, backlinks, history view default filter (with opt-in "All spaces" toggle).

### What's not per-space

Drafts, undo stacks (per-page, not per-space — `useUndoStore` is not space-partitioned by design), keyboard customisations, theme, sidebar width, link preview cache.

### Preferences registry (device scope, not synced)

`localStorage` is a SECOND persistence tier, distinct from the SQL tier and from the Zustand `persist`-backed stores above. `src/lib/preferences.ts` (#2466) is its typed, central registry of `localStorage`-backed preferences (`page-browser-density`, `page-browser-sort`, `starred-pages`, `tag-colors`, per-space recent searches/commands, per-page block-collapse state, …). `scripts/check-raw-local-storage.mjs` fails a raw `localStorage.getItem`/`setItem`/`removeItem`/`clear` call outside a small grandfathered list, so a new preference has to go through the registry.

The contract:

- **Device scope, never synced.** These values live only in `localStorage` and deliberately never sync between devices — same posture `tag-colors.ts` / `starred-pages.ts` had before they were folded into the registry. A preference that should follow the user's *data* (not their device) belongs in a block property or a backend table, not here.
- **Scope is a 3-way key axis, not just sync-vs-not.** Each `PreferenceDefinition` declares `scope`: `'device'` → bare key; `'space'` → `${key}:${spaceId}`; `'page'` → `${key}:${pageKey}` (same key computation as `'space'`, but keyed by a page root id — e.g. `PREFERENCES.blockCollapse`'s per-page collapsed-block-id list). `'space'`/`'page'` are about WHICH runtime id partitions the value (which space's recent searches, which page's collapse state), not about device/sync scope — every entry, regardless of key scope, is still device-local.
- **Grandfathering.** New keys should be `agaric:`-namespaced (`agaric:<feature>[:vN]`). Pre-registry bare keys (`theme-preference`, `tag-colors`, `sidebar_width`, …) are grandfathered — renaming one discards every existing user's stored value, so don't without a `migrate` transform (migrate-on-read, `tag-colors` style, run via the `migrate` field before `parse`).
- **Versioning.** `version` is contract metadata (documentation of the current on-disk shape), NOT a stored envelope — it's where a future incompatible shape change attaches a `migrate` transform.
- **Mutation-safe defaults.** `readPreference` never hands back a shared reference to `defaultValue` on the "nothing stored" branch (`cloneDefault`) — several migrated call sites read a fresh array/object and mutate it in place before writing it back, exactly like the pre-registry code.
- **`hasPreference` vs. equality.** Distinguishes "never stored" from "stored, and happens to equal the default" (e.g. an explicitly-persisted empty array) — `useBlockCollapse` needs this to tell a page's genuinely-empty scoped collapse list apart from "no scoped entry yet, fall back to the legacy global key".
- **Multi-window coherence is a separate concern.** The registry itself does not broadcast writes across windows — a real `localStorage` write already fires a native `storage` event in every OTHER window. A caller that needs same-tab reactivity (the tab that made the write) still owns its own `useSyncExternalStore` + synthetic `StorageEvent` dispatch, same as before the registry existed (`useTheme`, `useWeekStart`, `useJournalDateFormat`, `useExternalImagePolicy` — these are exactly the guard's grandfathered exemptions, see the script's `EXEMPT_FILES` for the full per-file rationale).

Consume via `usePreference` (which wraps `useLocalStoragePreference`) or the pure `readPreference` / `writePreference` / `hasPreference` / `removePreference` helpers. New preference keys MUST be added to the registry rather than reaching into `localStorage` ad hoc, so all preferences stay discoverable with one naming/versioning/migration contract. Migration off raw `localStorage` calls was opportunistic — Zustand-`persist`-backed stores (`tabs.ts`, `navigation.ts`, `journal.ts`, `recent-pages.ts`, `search-history.ts`, `pageBrowserFilters.ts`, `useDebugStore.ts`) are explicitly OUT of the registry's scope: they already carry their own versioned envelope and migrate function via `persist` middleware.

## Reduced motion + a11y

See `docs/UX.md § Accessibility` for the canonical rule. Frontend specifics: hooks that drive motion (`useScrollToFocus`, `useAutoScrollOnDrag`, `useKeyboardNavigableList`) check `prefers-reduced-motion` and skip the smooth path. Roving tabindex is used in `SearchablePopover`, `RecentPagesStrip`, `TabBar` — exactly one `tabindex=0` per group, arrows move it.

## Tauri command wrappers

`src/lib/tauri.ts` wraps every `invoke()` call in a type-safe function. The bindings type is regenerated by specta (`src/lib/bindings.ts`, checked in, CI-enforced). The wrapper layer also handles Tauri 2's explicit-null-vs-undefined contract (Tauri rejects `undefined` over the wire; the wrapper coerces).

## Component inventory

The full inventory lives in [`docs/UI-MAP.md`](../UI-MAP.md). The architecture-relevant fact is the layering:

- `src/components/ui/` — shadcn-style primitives. Anything new should reuse from here first.
- `src/components/` — domain components.
- `src/components/<Feature>/` — per-feature sub-component directories (FormattingToolbar, SpaceManageDialog, properties/PropertyRowEditor, …).

The decomposition pattern (a "god component" with an `oxlint-disable-next-line eslint/complexity` suppression → orchestrator + per-concern children + a containing hook) is documented in `docs/UX.md § UI primitives`.
