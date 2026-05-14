# Agaric Design System — Performance Review

> **Status:** Tier 2 + Tier 3 small wins shipped, plus Tier 1.4 (partial)
> and Tier 1.1, 1.2, 1.5 closed. Closed: items **1** (`useResolveStore`
> double-subscribe removed from `useBlockResolve` + `useRichContentCallbacks`
> — sole subscription is `cache`; immutable-Map identity drives re-renders);
> **2** (`page-blocks.ts` single-block-edit hot paths derive `blocksById`
> from the previous Map via `cloneBlocksByIdWith` / `cloneBlocksByIdWithout`
> instead of full-scan rebuilding from `blocks`; bulk paths — `load`,
> external `setState` — still rebuild as before);
> **5** (`SortableBlockWrapper` wrapped
> with `React.memo`; `useRovingEditor` and `useViewportObserver` return
> values now memoized so handle/observer identity is stable across parent
> re-renders); **9** (DonePanel `useMemo` wrappers); **10** (React.memo on
> HistoryListItem, DaySection, AppSidebar — ConflictListItem was already
> deleted by PEND-09 Phase 5 so the plan is stale on that name); **13**
> (`createSpaceSubscriber` migrated to `subscribeWithSelector` on
> `useSpaceStore`); **14** (`BlockTree` DnD measuring switched to
> `WhileDragging`); **15** (calendar.tsx classNames + buttonVariants
> hoist); **16** (overlay base-string hoist on dialog, sheet, popover,
> select); **17** (Sidebar `useMemo` deps complete); **18** (Breadcrumb
> inline onClick replaced by event delegation); **11**
> (`navigateToPage` cross-store fan-out — verified React 19 + zustand 5
>
> + `useSyncExternalStore` already batches the 4-5 `set()` calls into a
> single render per subscribed component; no transactional helper
> needed; invariant pinned by render-count probes in `navigation.test.ts`);
> **19** (App.tsx zustand-selector audit — pushed `syncStore.{state,
> peers,lastSyncedAt}`, `spaceStore.{availableSpaces,currentSpaceId}`,
> and `useTrashCount` directly into AppSidebar; pushed `tabsStore.goBack`
> into ViewDispatcher; App now subscribes to 4 selectors —
> `currentView`, `setView`, `navigateToPage`, `pageStack` — of which
> `setView` and `navigateToPage` are stable action refs (zero re-render
> cost), leaving only `currentView` + `pageStack` as effective rerender
> triggers; AppSidebar's prop surface dropped from 16 to 10 props,
> tightening the existing `React.memo` shallow-compare gate).
> **Partial:** **4** — inline `onClick`/`onKeyDown` arrows on
> `BlockListItem` rows replaced via a memoed per-block handler factory
> in `useBlockNavigation` (`getRowHandlers`) across AgendaResults,
> DuePanel, and DonePanel. The inline JSX `metadata` prop is unchanged,
> so `BlockListItem.memo` will still not fully hit until the prop
> surface is primitivized (BlockListItem renders its own metadata from
> typed primitive props) — tracked as a follow-up.
> **Still open:** Tier 1 item 3; the `metadata` half of item 4;
> Tier 2 remaining items (6, 12). Item **7** closed —
> `DaySection.lazyMount` defers per-day `BlockTree` mounting until the
> day enters the viewport via a one-shot inline `IntersectionObserver`
> (`200px 0px` rootMargin, disconnects after first intersection),
> swapping a 200px placeholder for the heavy
> `SortableContext`/viewport-observer/batch-attachments/slash-commands/
> roving-editor subtree only when needed; `WeeklyView` opts in for all
> 7 days while `DailyView` keeps eager mount; `prefers-reduced-motion`
> eagerly mounts to avoid the visible swap; a 2-3 visible-day Week view
> now mounts 2-3 BlockTrees instead of 7.
>
> **Tier 2.8 closed** (`useGraphSimulation` split into setup + patch
> effects; the SVG `g` group, zoom behavior, and ResizeObserver now
> survive filter changes; node DOM is patched in place via d3's
> data-join keyed by id so existing nodes keep their x/y on filter
> toggle). Worker/main-thread simulation is still rebuilt on data
> change because the worker protocol has no "update data" message —
> follow-up tier could extend the protocol to avoid the re-spawn.

**Date:** 2026-05-09
**Method.** Round 1: five parallel subagents reviewed (a) UI primitives in `src/components/ui/`, (b) heavy-render hotspots, (c) bundle and code-splitting, (d) zustand store fan-out, (e) perf claims in the markdown docs. Round 2: two independent verifiers fact-checked every claim against actual code (file/line/grep/`du`). Six round-1 claims were debunked or softened on verification and are excluded from this list. Findings below are confirmed against the current tree.

The system is **strong on a few intentional architectural decisions** (single roving TipTap editor, lazy secondary views, manualChunks split, 100% named-import lucide, zero `useStore()` whole-state reads) and **weak on render-fan-out from store mutations and on critical-path bytes**. The fixes below are ordered by leverage.

---

## Tier 1 — Highest leverage

**1. ~~`useResolveStore` consumers double-subscribe to `version` + `cache`.~~** *(closed)*
~~`src/hooks/useBlockResolve.ts:230-231` and `src/hooks/useRichContentCallbacks.ts:26-27, 87-88` each call the store twice on consecutive lines:~~

```ts
const version = useResolveStore((s) => s.version)
const cache = useResolveStore((s) => s.cache)
```

~~Every cache write fires both subscriptions, and `src/stores/resolve.ts:220, 241, 270` allocates a brand-new `Map` of up to 10K entries per write. Per-keystroke `batchSet` flows from search/picker re-render every chip-rendering surface twice.~~
**Resolved:** the `version` subscription was dropped from `useBlockResolve`, `useRichContentCallbacks`, and `useTagClickHandler`. Each cache mutation in `src/stores/resolve.ts` already allocates a fresh `Map`, so zustand's `Object.is` shallow compare on the `cache` slice fires re-renders on every write. `version` is still bumped in the store (kept as a public field — the test suite still asserts on `useResolveStore.getState().version` as a write counter) but no React subscriber listens for it. `cacheRef` continues to be the read path inside the stable `useCallback`s; no `useMemo`/`useCallback` deps needed rekeying — `version` was only ever a render-trigger, never appeared in any dep array.

**2. ~~`page-blocks.ts` rebuilds `blocksById` on every mutation.~~** *(closed)*
~~`src/stores/page-blocks.ts:187` defines `buildBlocksById`; called at lines 258, 320, 335, 347, 363, 451, 489, 532, 588, 646, 663. For a 2000-block page, every keystroke that flushes via `edit()` (`page-blocks.ts:333-336`) maps the full `blocks` array and constructs a fresh 2000-entry Map. Combined with `EditableBlock.tsx:117-120` and `BlockPropertyDrawer.tsx:67-70` selectors keyed on `blocksById`, the new Map identity fans out to every mounted EditableBlock per edit. Even the recently-added `appendBlock` (`page-blocks.ts:656-664`) pays this cost.~~
**Resolved:** introduced `cloneBlocksByIdWith(prev, touched[])` and `cloneBlocksByIdWithout(prev, removedIds)` helpers in `src/stores/page-blocks.ts`. The new Map is now derived from the previous one via `new Map(prev)` (which iterates the existing Map's internal slots — no `FlatBlock.id` property access) plus an `O(k)` set/delete for the touched keys, replacing the per-mutation full-scan rebuild on the single-block-edit hot path. Migrated `edit` (success + rollback), `createBelow`, `remove`, `splitBlock` rollback, `reorder`, `indent`, `dedent`, `moveUp`, `moveDown`, and `appendBlock` to the immutable touched-key path. `load` and the external `setState` augment (`augmentBlocksUpdate`) keep the full-scan `buildBlocksById` — those are legitimate bulk paths. Invariant guarded by `'edit() does not full-scan rebuild blocksById from the blocks array'` in `src/stores/__tests__/page-blocks.test.ts` (counts `.id` accessor reads across a 50-block `edit()` and asserts `≤ N + 5` instead of the regression's `~2N`).

**3. `editor` chunk (480 KB) and `LinkPreviewTooltip` chunk (304 KB) are eagerly preloaded.**
`dist/index.html` emits 93 `modulepreload` tags including `editor-q3nmlp2u.js` (480K), `LinkPreviewTooltip-DQWPFXIe.js` (304K), `highlight-bqqDqH2C.js` (148K), `dnd-_ieDZQYq.js` (56K), `datepicker-DrlFMZhF.js` (76K), `export-graph-DgPJkOA3.js` (96K). Even though `JournalPage` is the only eager view, `BlockTree` → `use-roving-editor.ts` pulls all 28 TipTap extensions into the critical path. The `vite.config.ts:35-36` comment already acknowledges this. (`d3-CHvRSp5e.js` is *not* preloaded — it ships only when `GraphView` mounts.)
**Fix (in priority order):**

+ Lazy-load the TipTap stack — JournalPage's static-render path can use `StaticBlock` until first focus/edit, then dynamic-import the editor and its 28 extensions.
+ Lazy-mount `BugReportDialog` / `QuickCaptureDialog` / `NoPeersDialog` (currently mounted unconditionally at `src/App.tsx:494, 510, 515`) — drops `export-graph`/jszip out of the critical path.
+ Investigate `LinkPreviewTooltip` (304K) with `ANALYZE=1 npm run build`; sub-deps are unattributed in the present build.
+ ~~Curate `lowlight` languages — currently uses the `common` preset = 37 languages (`src/components/RichContentRenderer.tsx:33`, `src/editor/use-roving-editor.ts:89`). Estimated savings ~70-100 KB.~~ *(closed — Tier 1.3 sub-point 4)* Both call sites now import a shared `curatedLowlight` instance from `src/lib/lowlight-curated.ts`, which registers 16 hand-picked grammars (`bash`, `css`, `diff`, `dockerfile`, `go`, `javascript`, `json`, `markdown`, `plaintext`, `python`, `rust`, `shell`, `sql`, `typescript`, `xml`, `yaml`) covering the languages users actually write in the app. Dropped `arduino`, `c`, `cpp`, `csharp`, `graphql`, `ini`, `java`, `kotlin`, `less`, `lua`, `makefile`, `objectivec`, `perl`, `php`, `php-template`, `python-repl`, `r`, `ruby`, `scss`, `swift`, `vbnet`, `wasm` from the `common` preset — 21 grammars off the critical path. Unsupported languages fall back to plain text via the existing `try/catch` in `renderHighlightedCode`. Pinned by `src/lib/__tests__/lowlight-curated.test.ts` (exact-set assertion guards against drift back toward `common`).

**4. `BlockListItem.memo` is defeated by inline JSX and inline handlers in every panel.** *(partial — handlers fixed; metadata still inline.)*
Inline `metadata={<>...</>}` plus inline `onClick`/`onKeyDown` arrow functions were confirmed at `src/components/AgendaResults.tsx:280, 313, 314`; `src/components/DuePanel.tsx:301, 320, 321`; `src/components/DonePanel.tsx:254, 268, 269`. New element + new function identities every parent render — the memo never hits.
**What shipped (handlers half).** `useBlockNavigation` now exposes `getRowHandlers(block)` — a memoed factory backed by an internal `Map<blockId, { onClick, onKeyDown }>`. Each row pulls a stable pair instead of allocating `() => handleBlockClick(block)` / `(e) => handleBlockKeyDown(e, block)` per render. The cache invalidates whenever the underlying click/keydown identities change (driven by `onNavigateToPage` / `pageTitles` / `untitledLabel`). AgendaResults, DuePanel, and DonePanel row maps consume the factory; verified by `src/hooks/__tests__/useBlockNavigation.test.ts` (identity stability across renders, distinct ids → distinct bundles, cache invalidation on dep change).
**Still open (metadata half).** `metadata={<>…</>}` JSX expressions in all three panels still allocate a fresh React element per render, so `BlockListItem.memo`'s shallow compare still bails on the `metadata` prop. Fully closing this requires changing `BlockListItem`'s prop surface from a `metadata?: ReactNode` slot to typed primitive fields (e.g. `metadataIcon?: 'check' | 'todo' | …`, `priority?: '1' | '2' | '3' | null`, `dueDate?: string | null`, `dependencyBlockId?: string`) and letting `BlockListItem` render those primitives itself. Memoing a `<RowMetadata />` sub-component is insufficient — the JSX expression still produces a new element each parent render. Track as a follow-up Tier 1 task; cost is moderate (touches the BlockListItem prop API and all three callers).

**5. ~~`SortableBlockWrapper` is not memoized.~~** *(closed)*
~~`src/components/SortableBlockWrapper.tsx:53` is a plain `export function`. Every BlockTree re-render fans out to every wrapper, defeating downstream `SortableBlock`'s own `React.memo` because `rovingEditor` (a handle whose identity changes per render — `EditableBlock.tsx:128`) and `viewport` (recreated on observer state changes) flow through.~~
**Resolved:** `SortableBlockWrapper` now uses the `Inner` + `React.memo` pattern (`src/components/SortableBlockWrapper.tsx`). Both unstable props were stabilized at the source rather than via a custom memo comparator — `useRovingEditor` and `useViewportObserver` each wrap their returned handle in `useMemo`, so identity only changes when the underlying values (`editor` for the roving editor; `offscreenIds` for the observer) actually change. The parent-side fix also helps every other consumer of those two hooks (`EditableBlock`, `BlockListRenderer`, etc.).

---

## Tier 2 — Verified, second wave

**6. ~~Most large lists are not virtualized.~~** *(closed for AgendaResults / HistoryListView / DonePanel / DuePanel; BlockListRenderer + BlockTree windowing still open as a separate follow-up.)*
~~`src/components/HistoryListView.tsx:78`, `src/components/AgendaResults.tsx:351-378`, `src/components/DonePanel.tsx:248`, `src/components/DuePanel.tsx:292`, and `src/components/BlockListRenderer.tsx:172` all `.map()` every row. BlockTree uses an `IntersectionObserver` placeholder pattern (`SortableBlockWrapper.tsx:80-93`) — paint is skipped offscreen but the React tree stays mounted, so reconciliation walks every row. PageBrowser is the only large list using `@tanstack/react-virtual` (`src/components/PageBrowser.tsx:14, 292`).~~
**Resolved (2026-05-14):** `@tanstack/react-virtual`'s `useVirtualizer` now drives `AgendaResults`, `HistoryListView`, `DonePanel`, and `DuePanel` — offscreen rows are no longer mounted in the React tree. `AgendaResults` and `DonePanel`/`DuePanel` use a flat-row approach: a `useMemo` builds a single `VirtualRow` list of `{ kind: 'group-header' | 'item', ... }` so the virtualizer can drop entire offscreen groups instead of mounting every sub-list (the audit's flagged `groups.map(g => g.items.map(b => …))` nested chain is gone). `HistoryListView` runs a single flat list of entries through the virtualizer. `estimateSize` per view: `AgendaResults` 36px header / 56px item, `HistoryListView` 80px item (collapsed default; `measureElement` corrects when a diff expands the row), `DonePanel` / `DuePanel` 32px header / 44px item. `BlockListItem` and `HistoryListItem` each gained `style` / `liRef` (resp. `rowRef`) / `dataIndex` pass-through props so each virtual row maps to exactly one listitem-roled (resp. `role="row"`) DOM element — wrapping the existing `<li>` in another positioning `<li>` or `<div>` would have either emitted invalid nested-`<li>` HTML or broken axe's `list` / `listitem` rules.
Keyboard nav still indexes into the pre-existing `flatItems` (items-only) array; a `flatToVirtualIndex` lookup maps each `focusedIndex` to the matching virtual-row index, then calls `virtualizer.scrollToIndex(...)` so arrow-key navigation continues to scroll the focused row into view. `DuePanel`'s projected-entries `<ul>` and the overdue / upcoming sections stay un-virtualized because they're bounded and live outside the audit-flagged `.map()` chain (line 292). Per-file tests adopt a vi.mock of `@tanstack/react-virtual` mirroring `src/components/__tests__/PageBrowser.test.tsx` — the mock returns every row so jsdom's zero-height scroll container doesn't collapse the windowed view to zero rows, and existing assertions querying by content / role / test-id keep working unchanged. `BlockListRenderer.tsx` + the `BlockTree` IntersectionObserver scheme stay out of scope (audit noted "evaluate" rather than "convert"; placeholder mounts already imply correct measured heights and the IntersectionObserver path is independent of the four flat-list views fixed here).

**7. ~~WeeklyView mounts one `BlockTree` per day; `DaySection` is not memoized.~~** *(closed)*
~~`src/components/journal/WeeklyView.tsx:42` maps `entries` to `DaySection`; `DaySection` was wrapped with `React.memo` in Session 710, but each instance still mounts a full `BlockTree` (`:162`) carrying its own `SortableContext`, viewport observer, batch-attachments provider, slash-commands hook, and roving editor. Concurrent fan-out scales with the entry count.~~
**Resolved:** `DaySection` now accepts an opt-in `lazyMount` prop. When enabled, the heavy `BlockTree` + `PageBlockStoreProvider` subtree is replaced by a `200px` min-height placeholder until a one-shot `IntersectionObserver` (inline in `DaySection.tsx`, `rootMargin: '200px 0px'` matching the existing virtualisation convention) reports entry — the observer disconnects after the first intersection so the tree stays mounted across subsequent quick scrolls (no re-spawn churn). `WeeklyView` opts in for all 7 days; `DailyView` (single-day) keeps the eager default. `prefers-reduced-motion: reduce` is honoured by eagerly mounting (avoids the visible placeholder→tree swap for motion-sensitive users). The existing `useViewportObserver` hook was evaluated and rejected: its contract is "toggle offscreen state for already-mounted blocks" (virtualisation lite), whereas this fix needs "mount once on first viewport entry, stay mounted." Regression coverage: `DaySection.test.tsx` (`lazyMount` describe block) pins (a) eager mount when `lazyMount` is unset, (b) placeholder rendered until `IntersectionObserver` fires, (c) swap to `BlockTree` after intersection, (d) eager mount under `prefers-reduced-motion`, (e) no phantom placeholder when `pageId` is null; `WeeklyView.test.tsx` asserts every DaySection receives `lazyMount`. A 7-day Week view that's only showing 2-3 days in the viewport now mounts only 2-3 BlockTrees instead of 7, cutting concurrent `SortableContext` / viewport observer / batch-attachments / slash-commands / roving-editor fan-out proportionally. Memoization of `DaySection` (Session 710) and the single-shared-`SortableContext` exploration mentioned in the original fix note are out of scope here — the lazy-mount alone delivers the perf win and is the simpler change.

**8. ~~GraphView simulation rebuilt on filter change.~~** *(closed)*
~~`src/hooks/useGraphSimulation.ts:108` deps array is `[svgRef, nodes, workerFailed, attachZoom, renderElements, runWorker, runMainThread]`. Filter toggles change `nodes`/`renderElements` identity, causing the entire d3 simulation and SVG selection trees to be torn down and rebuilt rather than patched.~~
**Resolved:** `useGraphSimulation` now runs two effects. The **setup effect** is keyed on `[svgRef, workerFailed, attachZoom, runWorker, runMainThread, setupKey]` (no `nodes`/`edges`/`renderElements` — all consumed via refs) and handles the SVG group creation, zoom attach, ResizeObserver, and initial simulation run; its cleanup only fires on unmount or worker-fallback flip. The **patch effect** is keyed on `[nodes, edges, svgRef]` and is what runs on filter toggles: it uses d3's `selection.data(...).join(...)` keyed by node id on the persistent `g` group (existing nodes keep their DOM and x/y/vx/vy across the toggle), re-binds the click/keyboard/hover/focus listeners on the merged selection, and reruns the simulation against the patched ctx. Result: zoom transform survives filter changes, the ResizeObserver stays attached, and visible nodes don't snap back to the centre. The worker IS still re-spawned on data change because the worker protocol has no "update data" message (`src/workers/graph-worker-types.ts` only exports `start`/`stop`/`drag`) — extending the protocol so the worker can patch its own simulation in place is a follow-up. Regression tests in `src/hooks/__tests__/useGraphSimulation.test.ts` pin (a) ResizeObserver constructor fires once per mount and (b) `zoom()` is not re-called on filter rerenders.

**9. `DonePanel` recomputes derived data each render.**
`src/components/DonePanel.tsx:165` (`grouped = groupBlocksByPage(...)`) and `:168` (`flatItems = grouped.flatMap(...)`) are bare expressions. `groupBlocksByPage` runs every render. Asymmetric with `DuePanel`, which memoizes the equivalents at lines 130/161.
**Fix:** wrap both in `useMemo` matching DuePanel's pattern.

**10. ~~Heavy list-row components without `React.memo`.~~** *(partial — only AppSidebar remains.)*
HistoryListItem and `journal/DaySection` were wrapped with `React.memo` in Session 710. `ConflictListItem` was deleted by PEND-09 Phase 5 (no longer applicable). `src/components/AppSidebar.tsx:104` is still a plain function export and receives ~10 store-derived props from `App.tsx`; every store change in App cascades into the sidebar tree.
**Fix:** wrap `AppSidebar` in `React.memo`; also audit which selectors actually need to live in App vs the sidebar.

**11. ~~`tabs.navigateToPage` chains 5 cross-store mutations per click.~~** *(closed — no fix needed; subscribers already batch.)*
~~`src/stores/tabs.ts:212` (`recordVisit`), `:228` (`navigateToDate`), `:234, 253, 266` (`setNavigationView`), `:235, 254, 267` (`setNavigationSelectedBlockId`), `:264` (tabs `set`). Each fans out to its own subscriber set on every page navigation.~~
**Resolved (Session 711):** verified empirically that React 19's automatic batching already coalesces the fan-out into a single render per subscribed component. zustand 5.0.12 subscribes each React hook via `useSyncExternalStore` (`node_modules/zustand/esm/react.mjs:6`), and React 19.2's scheduler collapses all `useSyncExternalStore` notifications that land in the same sync tick into ONE render pass — even when the notifications come from distinct stores. The audit's "5 separate subscriber waves" is accurate at the JS notify layer (each store's listener list does fire immediately on `set()`) but does NOT translate to 5 React renders.
The invariant is pinned by two new tests in `src/stores/__tests__/navigation.test.ts` (`'perf-review #11 — navigateToPage batches cross-store renders'`):

1. A page-editor `navigateToPage('P1', 'My Page')` produces exactly **one** render in each of three independent probe components (subscribed to `recentPages`, `tabs`, and `navigation` × 2 slices respectively). Total tree-wide renders: 3.
2. A date-routed `navigateToPage('DATE', '2026-04-20')` produces exactly **one** render each in a journal probe (subscribed to `currentDate` + `mode`) and a navigation probe (subscribed to `currentView` + `selectedBlockId`) — i.e. the two writes inside each store still coalesce into one render.
If a future change introduces an awaited tick between any of the four `set()` calls in `navigateToPage`, those tests fail. An inline comment block at `src/stores/tabs.ts:205` documents the verification and points at the test for future readers. No transactional helper introduced — Option A (rely on React 19 batching) holds.

**12. `BugReportDialog`, `QuickCaptureDialog`, `NoPeersDialog` mounted unconditionally.**
`src/App.tsx:494, 510, 515`. Controlled by `open` props but always in the React tree. Pulls `jszip` (via `bug-report-zip.ts:11`) and dialog content into the entry chunk via the `export-graph-DgPJkOA3.js` 96K chunk.
**Fix:** convert all three to `React.lazy` with `Suspense`, mount only when their open state flips.

---

## Tier 3 — Verified, lower priority

**13. `createSpaceSubscriber` subscribes to whole space-store state.**
`src/lib/createSpaceSubscriber.ts:45` subscribes with no equality fn; the inner closure dedups on `currentSpaceId` (`:51, :54`). Wakeup fires for every space-store write (`availableSpaces` refresh, `isReady` flip), times the four module-level subscribers in `journal.ts:178`, `navigation.ts:178`, `recent-pages.ts:137`, `tabs.ts:444`. Cost is small today; brittle as more state lands. None of the four ever unsubscribes (process-lifetime).
**Fix:** subscribe via `subscribeWithSelector` middleware on `useSpaceStore` so each subscriber listens only to `currentSpaceId`.

**14. `MeasuringStrategy.Always` on BlockTree's DnD context.**
`src/components/BlockTree.tsx:79`. Re-measures every drop target during drag; fine for typical pages, can stutter at hundreds of blocks during drag.
**Fix:** consider `MeasuringStrategy.WhileDragging` with manual invalidation on insertion.

**15. `calendar.tsx` rebuilds a 22-key inline `classNames` object per render.**
`src/components/ui/calendar.tsx:39-77` constructs the object inline and calls `buttonVariants()` three times (lines 47, 51, 64).
**Fix:** hoist the `classNames` object to module scope; memoize the two `buttonVariants` invocations once.

**16. `cn()` per render with 200+ char Tailwind strings on overlay primitives.**
`dialog.tsx:60` (~320 chars), `sheet.tsx:67` (~280 chars after side-conditional), `popover.tsx:36-37` (~400 chars total), `select.tsx:102-105` (~650 chars total). `clsx` is fast; `twMerge` parses every token. Per-overlay cost is small but pays on every open and re-render.
**Fix:** hoist the static base strings to module-scope constants; only `cn()` to merge `className` from the consumer.

**17. `Sidebar` `useMemo` deps incomplete.**
`src/components/ui/sidebar.tsx:206-231` value object includes `setOpen`, `setOpenMobile`, `setSidebarWidth`, `setIsResizing` but the deps array (`:220-230`) lists only `setOpen` and `setSidebarWidth`. Biome's `useExhaustiveDependencies` should flag.
**Fix:** add the missing deps; verify no lint suppression hides it.

**18. `Breadcrumb` inline `onClick` arrow per crumb.**
`src/components/ui/breadcrumb.tsx:270-273` — `.map()` builds an inline arrow per item. Defeats memoization on every render of the popover content.
**Fix:** extract the click handler to a stable `useCallback` or pass `data-id` and use event delegation.

**19. ~~App.tsx subscribes to ~10 store slices.~~** *(closed)*
~~`src/App.tsx:67-92` — verified count is ~10 zustand selectors plus a few hook composites (the round-1 "~17" estimate counted destructured fields). Any store change cascades into the unmemoized AppSidebar plus the dialogs that mount unconditionally (see #10, #12).~~
**Resolved:** App.tsx now subscribes to only four zustand selectors —
`currentView`, `setView` (stable action), `navigateToPage` (stable
action), and `pageStack` — all genuine routing / view-shell slices.
Pushed down into `AppSidebar` (the sole consumer): `useSyncStore.{state,
peers, lastSyncedAt}`, `useSpaceStore.{availableSpaces, currentSpaceId}`,
and the polling `useTrashCount` hook (now imported from `ViewDispatcher`
where it is defined). Pushed down into `ViewDispatcher` (the sole
consumer): `useTabsStore.goBack`. Effective re-render triggers in App
collapse to `currentView` and `pageStack`; the two action subscriptions
never change identity. As a side benefit, AppSidebar's prop surface
shrinks from 16 to 10 props, which tightens the `React.memo`
shallow-compare gate added in Session 717 (item 10). Tests in
`src/components/__tests__/AppSidebar.test.tsx` were updated to seed the
sync store via a `seedSyncStore({…})` helper instead of injecting prop
overrides; `ViewDispatcher.test.tsx` dropped the `onBack` prop from
its `defaultProps` builder.

---

## Confirmed wins (don't break these)

+ **Single roving TipTap editor** — only the focused block hosts `<EditorContent>`; others render `StaticBlock` (`EditableBlock.tsx:247-262`). Matches `ARCHITECTURE.md:627-641`.
+ **React 19 ref-as-prop migration is complete** — zero `forwardRef` in `src/components/ui/` (verified by grep across all 37 primitives).
+ **All 13 secondary views are `React.lazy`** (`src/components/ViewDispatcher.tsx:48-66`); `KeyboardShortcuts` and `WelcomeModal` lazy in `App.tsx:60-65`.
+ **Mermaid + PdfViewerDialog + html5-qrcode lazy/dynamic-imported** — `src/components/RichContentRenderer.tsx:29`, `src/components/StaticBlock.tsx:27`, `src/components/QrScanner.tsx:43`.
+ **Zustand selector discipline enforced** — zero `useStore()` whole-state reads anywhere in `src/`.
+ **lucide-react tree-shake correct** — all 118 import sites use named imports.
+ **DuePanel is the gold-standard memoization example** — `useMemo` at lines 98, 107, 113, 130, 151, 161 with documented FE-H-19 rationale.
+ **manualChunks** in `vite.config.ts:29-92` (editor / highlight / dnd / datepicker / ui-radix / react-vendor / d3) for cache stability.
+ **`BlockTree` action/resolver bags correctly memoized** via `useMemo` at `src/components/BlockTree.tsx:626-673` — descendants using context don't re-render on unrelated state.
+ **Graph simulation runs in a Web Worker** with main-thread fallback (`useGraphSimulation.ts:75-76`).
+ **`useBlockPropertiesBatch` and `BatchAttachmentsProvider`** collapse N per-row IPC calls into one per page (`BlockTree.tsx:357, 701`, MAINT-131 / PEND-35).
+ **`BootGate` uses `useShallow`** for object selector (`BootGate.tsx:13`).
+ **Production builds drop sourcemaps** (`vite.config.ts:133`); `withGlobalTauri: false` (`tauri.conf.json:13`); single-locale i18n (`src/lib/i18n/index.ts:60`).

---

## Doc-vs-code drift to resolve

+ `ARCHITECTURE.md:1024, 1048` says "29 shadcn/ui" — actual count is 37 (`pending/design-system-maintainability-2026-05-09.md:35-44` already notes this).
+ `ARCHITECTURE.md:2206` cites "REVIEW-LATER.md P-15/P-16" — those IDs don't exist; current ones are `PERF-19/PERF-20`.
+ `AGENTS.md:130-138` documents the layer table as policy but no automated import-boundary check exists in the prek hook list at `AGENTS.md:249`.

---

## Suggested ordering (largest verified ROI first)

1. Lazy-load `BugReportDialog` / `QuickCaptureDialog` / `NoPeersDialog` (#12) — biggest critical-path bytes per LOC changed.
2. ~~Fix `useResolveStore` double-subscription (#1) — hits every chip-rendering surface.~~ *(closed)*
3. ~~In-place mutation for `blocksById` on single-block edits (#2) — reduces fan-out per keystroke.~~ *(closed; immutable touched-key path via `cloneBlocksByIdWith` / `cloneBlocksByIdWithout`.)*
4. ~~Memoize `SortableBlockWrapper` and stabilize its props (#5).~~ *(closed)*
5. ~~Replace inline handlers in DuePanel/DonePanel/AgendaResults rows~~ (closed; row handlers now sourced from `useBlockNavigation.getRowHandlers`). Remaining half of #4: primitivize `BlockListItem`'s `metadata` prop surface so `metadata={<>…</>}` JSX is no longer required at each call site.
6. Run `ANALYZE=1 npm run build` to attribute the unnamed 472K/212K chunks; then decide on TipTap split (#3).
7. ~~Add `@tanstack/react-virtual` to AgendaResults and HistoryListView (#6).~~ *(closed 2026-05-14 — also extended to DonePanel and DuePanel; BlockListRenderer/BlockTree windowing remains a follow-up.)*
8. ~~Memoize DonePanel `grouped`/`flatItems`, HistoryListItem, DaySection~~ (closed Session 710); AppSidebar still open (#10). ConflictListItem deleted by PEND-09 Phase 5.
9. ~~Fix Sidebar useMemo deps (#17).~~ Closed Session 710.
10. Add a `dependency-cruiser` (or biome equivalent) check for the documented `ui/` → `stores/` import boundary.
