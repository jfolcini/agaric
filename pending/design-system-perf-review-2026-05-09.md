# Design-system performance review — remaining open work

> **Status:** Tier 1.1, 1.2, 1.4, 1.5 closed. Tier 2.6 (virtualization for AgendaResults / HistoryListView / DonePanel / DuePanel), 2.7 (DaySection lazyMount), 2.8 (GraphView simulation patch), 2.9 (DonePanel useMemo), 2.10 (React.memo on HistoryListItem/DaySection/AppSidebar), 2.11 (navigateToPage batching — verified, no fix needed), 2.12 (lazy-mount three dialogs), 2.19 closed. Tier 3.13-3.18 closed.
>
> History of closed items lives in `SESSION-LOG.md` sessions 706-729. Don't reintroduce them here.
>
> **Open below: Tier 1.3 TipTap lazy-load; Tier 2.6 follow-up BlockListRenderer + BlockTree windowing; one doc-drift cleanup (AGENTS.md import-boundary automation).**

---

## Tier 1.3 — Lazy-load the TipTap editor stack

**Symptom.** `dist/index.html` emits 93 `modulepreload` tags, including `editor-q3nmlp2u.js` (480K) and `highlight-bqqDqH2C.js` (148K). Even though `JournalPage` is the only eager view, `BlockTree` → `use-roving-editor.ts` pulls all 28 TipTap extensions into the critical path. The `vite.config.ts:35-36` comment already acknowledges this.

**Fix.** JournalPage's static-render path can use `StaticBlock` until first focus/edit, then dynamic-import the editor and its 28 extensions. The mark renderers under `src/components/RichContentRenderer/marks/` already render content without the editor — the chunk-split target is the *editing* surface.

This is architectural, not mechanical: validate with a focused prototype before scheduling. Confirm that:

1. First-focus latency (idle → import → mount → caret in place) stays under ~100 ms on a cold cache so users don't notice the swap.
2. Slash-commands, keyboard shortcuts, and roving-editor handle hot-import without losing the keystroke that triggered focus.
3. Test infrastructure (vitest jsdom) tolerates the dynamic-import boundary, or move the hot path behind a synchronous test toggle.

**Cost:** M-L (prototype + migration + test fan-out). **Risk:** medium — focus race conditions can corrupt the editor state if the dynamic-import lands after the user has typed. **Impact:** drops the eager preload from ~480K (editor) + ~148K (highlight) to whichever subset the user's first interaction needs.

Closed sibling pieces of the original 1.3:

- `lowlight` curated to 16 grammars (Session 723).
- `LinkPreviewTooltip-*.js` 304K chunk investigation — name is a rolldown artifact, not a real lib; chunk imports 73 modules. Accept the size; it's parallel-fetched with the editor chunk, not on the critical path of first paint.

---

## Tier 2.6 follow-up — Windowing for `BlockListRenderer` + `BlockTree`

The four flat virtualisation conversions (AgendaResults, HistoryListView, DonePanel, DuePanel) shipped 2026-05-14. The original audit also flagged:

- `src/components/BlockListRenderer.tsx:172` — `.map()` over every row.
- `src/components/BlockTree.tsx` — `IntersectionObserver` placeholder pattern (`SortableBlockWrapper.tsx:80-93`) skips paint offscreen but keeps the React tree mounted, so reconciliation still walks every row.

The audit's phrasing was "evaluate" rather than "convert" because the existing placeholder scheme already implies correct measured heights and the IntersectionObserver path is structurally different from the four flat lists. **Defer until a real complaint surfaces:** a 2000-block page is the only realistic stressor; if profiling shows reconciliation time dominating during edit/scroll, that's the trigger to add `useVirtualizer` to BlockListRenderer (smaller scope) first and only touch BlockTree if the windowed `BlockListRenderer` doesn't already address it.

**Cost when picked up:** S-M for BlockListRenderer, M for BlockTree. **Risk:** medium — BlockTree's DnD context, slash commands, and roving editor all assume a flat mounted tree.

---

## Doc-vs-code drift

- `AGENTS.md:130-138` documents the layer table as policy but no automated import-boundary check exists in the prek hook list at `AGENTS.md:249`.

**Fix.** Add the missing automation (`dependency-cruiser` or biome equivalent for the documented `ui/` → `stores/` import boundary).

(The two text-only docs/ARCHITECTURE.md fixes — shadcn/ui count and `P-15/P-16` → `PERF-19/PERF-20` — landed in Session 729.)

---

## Confirmed wins (don't break these)

Reference snapshot of the architectural decisions that already paid off. Don't regress:

- **Single roving TipTap editor** — only the focused block hosts `<EditorContent>`; others render `StaticBlock` (`EditableBlock.tsx:247-262`). Matches `docs/ARCHITECTURE.md:627-641`.
- **React 19 ref-as-prop migration complete** — zero `forwardRef` in `src/components/ui/` (37 primitives).
- **All 13 secondary views are `React.lazy`** (`src/components/ViewDispatcher.tsx:48-66`); `KeyboardShortcuts` and `WelcomeModal` lazy in `App.tsx:60-65`.
- **Mermaid + PdfViewerDialog + html5-qrcode lazy/dynamic-imported** — `src/components/RichContentRenderer.tsx:29`, `src/components/StaticBlock.tsx:27`, `src/components/QrScanner.tsx:43`.
- **Zustand selector discipline enforced** — zero `useStore()` whole-state reads anywhere in `src/`.
- **lucide-react tree-shake correct** — all 118 import sites use named imports.
- **DuePanel is the gold-standard memoization example** — `useMemo` at lines 98, 107, 113, 130, 151, 161 with documented FE-H-19 rationale.
- **`manualChunks`** in `vite.config.ts:29-92` (editor / highlight / dnd / datepicker / ui-radix / react-vendor / d3) for cache stability.
- **`BlockTree` action/resolver bags memoized** via `useMemo` at `BlockTree.tsx:626-673`.
- **Graph simulation runs in a Web Worker** with main-thread fallback (`useGraphSimulation.ts:75-76`).
- **`useBlockPropertiesBatch` and `BatchAttachmentsProvider`** collapse N per-row IPC calls into one per page (`BlockTree.tsx:357, 701`, MAINT-131 / PEND-35).
- **`BootGate` uses `useShallow`** for object selector (`BootGate.tsx:13`).
- **Production builds drop sourcemaps** (`vite.config.ts:133`); `withGlobalTauri: false` (`tauri.conf.json:13`); single-locale i18n (`src/lib/i18n/index.ts:60`).
