# Agaric Design System — Performance Review

> **Status:** Tier 2 + Tier 3 small wins shipped. Closed: items **9**
> (DonePanel `useMemo` wrappers), **10** (React.memo on HistoryListItem +
> DaySection — ConflictListItem was already deleted by PEND-09 Phase 5
> so the plan is stale on that name), **15** (calendar.tsx classNames +
> buttonVariants hoist), **16** (overlay base-string hoist on dialog +
> sheet + popover + select), **17** (Sidebar `useMemo` deps complete),
> **18** (Breadcrumb inline onClick replaced by event delegation).
> **Still open:** every Tier 1 item (1-5) + Tier 2 remaining items
> (6, 7, 8, 11, 12) + Tier 3 items (13, 14, 19).

**Date:** 2026-05-09
**Method.** Round 1: five parallel subagents reviewed (a) UI primitives in `src/components/ui/`, (b) heavy-render hotspots, (c) bundle and code-splitting, (d) zustand store fan-out, (e) perf claims in the markdown docs. Round 2: two independent verifiers fact-checked every claim against actual code (file/line/grep/`du`). Six round-1 claims were debunked or softened on verification and are excluded from this list. Findings below are confirmed against the current tree.

The system is **strong on a few intentional architectural decisions** (single roving TipTap editor, lazy secondary views, manualChunks split, 100% named-import lucide, zero `useStore()` whole-state reads) and **weak on render-fan-out from store mutations and on critical-path bytes**. The fixes below are ordered by leverage.

---

## Tier 1 — Highest leverage

**1. `useResolveStore` consumers double-subscribe to `version` + `cache`.**
`src/hooks/useBlockResolve.ts:230-231` and `src/hooks/useRichContentCallbacks.ts:26-27, 87-88` each call the store twice on consecutive lines:

```ts
const version = useResolveStore((s) => s.version)
const cache = useResolveStore((s) => s.cache)
```

Every cache write fires both subscriptions, and `src/stores/resolve.ts:220, 241, 270` allocates a brand-new `Map` of up to 10K entries per write. Per-keystroke `batchSet` flows from search/picker re-render every chip-rendering surface twice.
**Fix:** drop `version` (the new Map identity is already a re-render trigger), or read `cache` outside React via `getState()` and subscribe once on a narrower derivation.

**2. `page-blocks.ts` rebuilds `blocksById` on every mutation.**
`src/stores/page-blocks.ts:187` defines `buildBlocksById`; called at lines 258, 320, 335, 347, 363, 451, 489, 532, 588, 646, 663. For a 2000-block page, every keystroke that flushes via `edit()` (`page-blocks.ts:333-336`) maps the full `blocks` array and constructs a fresh 2000-entry Map. Combined with `EditableBlock.tsx:117-120` and `BlockPropertyDrawer.tsx:67-70` selectors keyed on `blocksById`, the new Map identity fans out to every mounted EditableBlock per edit. Even the recently-added `appendBlock` (`page-blocks.ts:656-664`) pays this cost.
**Fix:** mutate Map in place on the single-block-edit hot path, or split state into `blocks: Block[]` + `byId: Map` updated immutably only at the touched key.

**3. `editor` chunk (480 KB) and `LinkPreviewTooltip` chunk (304 KB) are eagerly preloaded.**
`dist/index.html` emits 93 `modulepreload` tags including `editor-q3nmlp2u.js` (480K), `LinkPreviewTooltip-DQWPFXIe.js` (304K), `highlight-bqqDqH2C.js` (148K), `dnd-_ieDZQYq.js` (56K), `datepicker-DrlFMZhF.js` (76K), `export-graph-DgPJkOA3.js` (96K). Even though `JournalPage` is the only eager view, `BlockTree` → `use-roving-editor.ts` pulls all 28 TipTap extensions into the critical path. The `vite.config.ts:35-36` comment already acknowledges this. (`d3-CHvRSp5e.js` is *not* preloaded — it ships only when `GraphView` mounts.)
**Fix (in priority order):**

- Lazy-load the TipTap stack — JournalPage's static-render path can use `StaticBlock` until first focus/edit, then dynamic-import the editor and its 28 extensions.
- Lazy-mount `BugReportDialog` / `QuickCaptureDialog` / `NoPeersDialog` (currently mounted unconditionally at `src/App.tsx:494, 510, 515`) — drops `export-graph`/jszip out of the critical path.
- Investigate `LinkPreviewTooltip` (304K) with `ANALYZE=1 npm run build`; sub-deps are unattributed in the present build.
- Curate `lowlight` languages — currently uses the `common` preset = 37 languages (`src/components/RichContentRenderer.tsx:33`, `src/editor/use-roving-editor.ts:89`). Estimated savings ~70-100 KB.

**4. `BlockListItem.memo` is defeated by inline JSX and inline handlers in every panel.**
Inline `metadata={<>...</>}` plus inline `onClick`/`onKeyDown` arrow functions confirmed at `src/components/AgendaResults.tsx:280, 313, 314`; `src/components/DuePanel.tsx:301, 320, 321`; `src/components/DonePanel.tsx:254, 268, 269`. New element + new function identities every parent render — the memo never hits.
**Fix:** lift handlers to `useCallback` keyed by `block.id` (or a memoed handler factory), and factor `metadata` into a memoed sub-component receiving primitives.

**5. `SortableBlockWrapper` is not memoized.**
`src/components/SortableBlockWrapper.tsx:53` is a plain `export function`. Every BlockTree re-render fans out to every wrapper, defeating downstream `SortableBlock`'s own `React.memo` because `rovingEditor` (a handle whose identity changes per render — `EditableBlock.tsx:128`) and `viewport` (recreated on observer state changes) flow through.
**Fix:** wrap with `React.memo` and stabilize `rovingEditor` (likely a `useRef`-backed wrapper) and the `viewport` prop.

---

## Tier 2 — Verified, second wave

**6. Most large lists are not virtualized.**
`src/components/HistoryListView.tsx:78`, `src/components/AgendaResults.tsx:351-378`, `src/components/ConflictList.tsx:623`, `src/components/DonePanel.tsx:248`, `src/components/DuePanel.tsx:292`, and `src/components/BlockListRenderer.tsx:172` all `.map()` every row. BlockTree uses an `IntersectionObserver` placeholder pattern (`SortableBlockWrapper.tsx:80-93`) — paint is skipped offscreen but the React tree stays mounted, so reconciliation walks every row. PageBrowser is the only large list using `@tanstack/react-virtual` (`src/components/PageBrowser.tsx:14, 292`).
**Fix:** extend the PageBrowser pattern to AgendaResults, History, Conflict, Done/Due panels. For BlockTree, evaluate replacing the IntersectionObserver scheme with windowing — placeholder mounts already imply correct measured heights.

**7. WeeklyView mounts one `BlockTree` per day; `DaySection` is not memoized.**
`src/components/journal/WeeklyView.tsx:42` maps `entries` to `DaySection`; `src/components/journal/DaySection.tsx:38` is a plain function and `:162` mounts a `BlockTree`. Each BlockTree carries its own `SortableContext`, viewport observer, batch-attachments provider, slash-commands hook, and roving editor. Concurrent fan-out scales with the entry count.
**Fix:** memoize `DaySection`; consider a single shared `SortableContext` across days, and lazy-mount day BlockTrees on viewport entry.

**8. GraphView simulation rebuilt on filter change.**
`src/hooks/useGraphSimulation.ts:108` deps array is `[svgRef, nodes, workerFailed, attachZoom, renderElements, runWorker, runMainThread]`. Filter toggles change `nodes`/`renderElements` identity, causing the entire d3 simulation and SVG selection trees to be torn down and rebuilt rather than patched.
**Fix:** keep the simulation alive across filter changes; patch nodes/links via `selection.data(...).join(...)`.

**9. `DonePanel` recomputes derived data each render.**
`src/components/DonePanel.tsx:165` (`grouped = groupBlocksByPage(...)`) and `:168` (`flatItems = grouped.flatMap(...)`) are bare expressions. `groupBlocksByPage` runs every render. Asymmetric with `DuePanel`, which memoizes the equivalents at lines 130/161.
**Fix:** wrap both in `useMemo` matching DuePanel's pattern.

**10. Heavy list-row components without `React.memo`.**
`src/components/HistoryListItem.tsx:216`, `src/components/ConflictListItem.tsx:83`, `src/components/journal/DaySection.tsx:38`, `src/components/AppSidebar.tsx:104` are all plain function exports. `AppSidebar` receives ~10 store-derived props from `App.tsx`; every store change in App cascades into the sidebar tree.
**Fix:** wrap in `React.memo`; for `AppSidebar`, also audit which selectors actually need to live in App vs the sidebar.

**11. `tabs.navigateToPage` chains 5 cross-store mutations per click.**
`src/stores/tabs.ts:212` (`recordVisit`), `:228` (`navigateToDate`), `:234, 253, 266` (`setNavigationView`), `:235, 254, 267` (`setNavigationSelectedBlockId`), `:264` (tabs `set`). Each fans out to its own subscriber set on every page navigation.
**Fix:** introduce a transactional helper that batches the writes, or rely on React 19 automatic batching by ensuring all writes happen inside a single sync tick.

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

**19. App.tsx subscribes to ~10 store slices.**
`src/App.tsx:67-92` — verified count is ~10 zustand selectors plus a few hook composites (the round-1 "~17" estimate counted destructured fields). Any store change cascades into the unmemoized AppSidebar plus the dialogs that mount unconditionally (see #10, #12).
**Fix:** push selectors down into the components that actually use them; let App subscribe only to the routing/view-shell slices.

---

## Confirmed wins (don't break these)

- **Single roving TipTap editor** — only the focused block hosts `<EditorContent>`; others render `StaticBlock` (`EditableBlock.tsx:247-262`). Matches `ARCHITECTURE.md:627-641`.
- **React 19 ref-as-prop migration is complete** — zero `forwardRef` in `src/components/ui/` (verified by grep across all 37 primitives).
- **All 13 secondary views are `React.lazy`** (`src/components/ViewDispatcher.tsx:48-66`); `KeyboardShortcuts` and `WelcomeModal` lazy in `App.tsx:60-65`.
- **Mermaid + PdfViewerDialog + html5-qrcode lazy/dynamic-imported** — `src/components/RichContentRenderer.tsx:29`, `src/components/StaticBlock.tsx:27`, `src/components/QrScanner.tsx:43`.
- **Zustand selector discipline enforced** — zero `useStore()` whole-state reads anywhere in `src/`.
- **lucide-react tree-shake correct** — all 118 import sites use named imports.
- **DuePanel is the gold-standard memoization example** — `useMemo` at lines 98, 107, 113, 130, 151, 161 with documented FE-H-19 rationale.
- **manualChunks** in `vite.config.ts:29-92` (editor / highlight / dnd / datepicker / ui-radix / react-vendor / d3) for cache stability.
- **`BlockTree` action/resolver bags correctly memoized** via `useMemo` at `src/components/BlockTree.tsx:626-673` — descendants using context don't re-render on unrelated state.
- **Graph simulation runs in a Web Worker** with main-thread fallback (`useGraphSimulation.ts:75-76`).
- **`useBlockPropertiesBatch` and `BatchAttachmentsProvider`** collapse N per-row IPC calls into one per page (`BlockTree.tsx:357, 701`, MAINT-131 / PEND-35).
- **`BootGate` uses `useShallow`** for object selector (`BootGate.tsx:13`).
- **Production builds drop sourcemaps** (`vite.config.ts:133`); `withGlobalTauri: false` (`tauri.conf.json:13`); single-locale i18n (`src/lib/i18n/index.ts:60`).

---

## Doc-vs-code drift to resolve

- `ARCHITECTURE.md:1024, 1048` says "29 shadcn/ui" — actual count is 37 (`pending/design-system-maintainability-2026-05-09.md:35-44` already notes this).
- `ARCHITECTURE.md:2206` cites "REVIEW-LATER.md P-15/P-16" — those IDs don't exist; current ones are `PERF-19/PERF-20`.
- `AGENTS.md:130-138` documents the layer table as policy but no automated import-boundary check exists in the prek hook list at `AGENTS.md:249`.

---

## Suggested ordering (largest verified ROI first)

1. Lazy-load `BugReportDialog` / `QuickCaptureDialog` / `NoPeersDialog` (#12) — biggest critical-path bytes per LOC changed.
2. Fix `useResolveStore` double-subscription (#1) — hits every chip-rendering surface.
3. In-place mutation for `blocksById` on single-block edits (#2) — reduces fan-out per keystroke.
4. Memoize `SortableBlockWrapper` and stabilize its props (#5).
5. Replace inline `metadata`/handlers in DuePanel/DonePanel/AgendaResults rows (#4).
6. Run `ANALYZE=1 npm run build` to attribute the unnamed 472K/212K chunks; then decide on TipTap split (#3).
7. Add `@tanstack/react-virtual` to AgendaResults and HistoryListView (#6).
8. Memoize DonePanel `grouped`/`flatItems`, HistoryListItem, ConflictListItem, DaySection, AppSidebar (#9, #10).
9. Fix Sidebar useMemo deps (#17).
10. Add a `dependency-cruiser` (or biome equivalent) check for the documented `ui/` → `stores/` import boundary.
