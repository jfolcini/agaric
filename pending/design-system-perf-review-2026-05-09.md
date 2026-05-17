# Design-system performance review — remaining open work

Two open items: Tier 1.3 (lazy-load the TipTap editor stack) and the Tier 2.6 follow-up (BlockListRenderer + BlockTree windowing).

---

## Tier 1.3 — Lazy-load the TipTap editor stack

**Symptom.** `dist/index.html` emits 93 `modulepreload` tags, including `editor-q3nmlp2u.js` (480K) and `highlight-bqqDqH2C.js` (148K). Even though `JournalPage` is the only eager view, `BlockTree` → `use-roving-editor.ts` pulls all 28 TipTap extensions into the critical path. The `vite.config.ts:35-36` comment already acknowledges this.

**Fix.** JournalPage's static-render path can use `StaticBlock` until first focus/edit, then dynamic-import the editor and its 28 extensions. The mark renderers under `src/components/RichContentRenderer/marks/` already render content without the editor — the chunk-split target is the *editing* surface.

This is architectural, not mechanical: validate with a focused prototype before scheduling. Confirm that:

1. First-focus latency (idle → import → mount → caret in place) stays under ~100 ms on a cold cache so users don't notice the swap.
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
