# Design-system performance review — remaining open work

Two open items, both inherited from the 2026-05-09 design-system performance audit (the "Tier 1.3" / "Tier 2.6" labels below are local to that audit and are not part of any other PEND-* numbering):

1. Lazy-load the TipTap editor stack ("Tier 1.3").
2. Windowing for `BlockListRenderer` + `BlockTree` ("Tier 2.6" follow-up).

---

## Tier 1.3 — Lazy-load the TipTap editor stack

**Symptom.** `dist/index.html` emits 18 `modulepreload` tags (count refreshed 2026-05-17 against the current build), including the `editor-*.js` chunk (~480K) and `highlight-CTboDF8r.js` (~53K). Even though `JournalPage` is the only eager view, `BlockTree` → `use-roving-editor.ts` pulls all 28 TipTap extensions into the critical path. The `vite.config.ts:35-36` comment already acknowledges this. Re-derive both the preload count and the per-chunk sizes from a fresh `npm run build` before scheduling — these numbers drift with every Vite/TipTap bump.

**Fix.** JournalPage's static-render path can use `StaticBlock` until first focus/edit, then dynamic-import the editor and its 28 extensions. The mark renderers under `src/components/RichContentRenderer/marks/` already render content without the editor — the chunk-split target is the *editing* surface.

This is architectural, not mechanical: validate with a focused prototype before scheduling. Confirm that:

1. First-focus latency (idle → import → mount → caret in place) does not regress against the current synchronous-mount baseline. **Measure the baseline first** (devtools perf trace on a cold cache) and set the budget at "current cost + headroom" rather than inventing a number; the dynamic-import overhead is the only new cost being added.
2. Slash-commands, keyboard shortcuts, and roving-editor handle hot-import without losing the keystroke that triggered focus.
3. Test infrastructure (vitest jsdom) tolerates the dynamic-import boundary, or move the hot path behind a synchronous test toggle.

**Cost:** M-L (prototype + migration + test fan-out). **Risk:** medium — focus race conditions can corrupt the editor state if the dynamic-import lands after the user has typed. **Impact:** drops the eager preload from ~480K (editor) + ~148K (highlight) to whichever subset the user's first interaction needs.

---

## Tier 2.6 follow-up — Windowing for `BlockListRenderer` + `BlockTree`

The four flat virtualisation conversions (AgendaResults, HistoryListView, DonePanel, DuePanel) shipped. The original audit also flagged:

- `src/components/BlockListRenderer.tsx:172` — `.map()` over every row.
- `src/components/BlockTree.tsx` — `IntersectionObserver` placeholder pattern (`SortableBlockWrapper.tsx:80-93`) skips paint offscreen but keeps the React tree mounted, so reconciliation still walks every row.

The audit's phrasing was "evaluate" rather than "convert" because the existing placeholder scheme already implies correct measured heights and the IntersectionObserver path is structurally different from the four flat lists. **Defer until a real complaint surfaces:** a 2000-block page is the only realistic stressor; if profiling shows reconciliation time dominating during edit/scroll, that's the trigger to add `useVirtualizer` to BlockListRenderer (smaller scope) first and only touch BlockTree if the windowed `BlockListRenderer` doesn't already address it.

**Cost when picked up:** S-M for BlockListRenderer, M for BlockTree. **Risk:** medium — BlockTree's DnD context, slash commands, and roving editor all assume a flat mounted tree.
