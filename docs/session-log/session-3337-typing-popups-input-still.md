# Session 3337 — popups you type into keep their input still

This is the audit half of the maintainer's "pickers stay still while typing" report; session 3336 fixed the shared editor-picker renderer. Three more surfaces moved their own input while the user typed, measured with the input's top after each of six keys:

- **Command palette (desktop).** The dialog is centred (`top-[50%]` plus `translate-y-[-50%]`), so it re-centred as results narrowed. The input slid 124 px down. It now hangs from `top-[12dvh]`.
- **Mobile search sheet, All pages.** The bottom sheet sized to its rows, so the input rode the sheet's top edge: 608 → 246 → 320 → 548 px. In All pages it now fills its existing 90dvh cap. In This page it keeps its height-to-content, so the page highlights stay visible.
- **Ref-property value picker** (`BlockPropertyEditor`). Opened near the viewport bottom, `flip` swapped it from above to below as the filtered list shrank, a 162 px jump. The side is now chosen by the first placement. Later placements keep it without `flip`, and above the chip the opened height is kept as `min-height`, so neither edge moves.

`e2e/typing-popups-stay-still.spec.ts` pins each case. It failed on all three with the old code (124, 162 and 88 px) and passes with the fix. `BlockPropertyEditor.test.tsx` gained a side-lock test, which reds when the lock is removed. `CommandPalette.mobileSearch.test.tsx` pinned `top-[50%]`, the centring the maintainer asked to remove. It now pins `top-[12dvh]`.

Measured still, no change: the search panel's inline filter autocomplete. It is anchored at the token's value start, and keeps stale results while loading.

Ran: vitest over `src/components/{mobile,common,editor,palette}`, `npm run typecheck`, oxlint, and Playwright over the new spec plus the palette, search-sheet and property specs (46 passed).
