# Session 2654 — the mobile drawer opens only from its button

The maintainer's call on #5932 item 6: the sidebar drawer opens only from the
panel button at the top left. The left-edge swipe hint and the edge
swipe-to-open gesture are gone.

- **Why:** on Android gesture navigation a swipe from the left edge is the
  system Back gesture, so the hint advertised a gesture that competes with
  Back, and it painted a grey strip down every mobile screen. It did not take
  layout width: it was a fixed 3 px overlay, and the content's left edge is
  the same before and after (the first block at x = 16).
- **Deleted:** `use-sidebar-edge-swipe.ts` and its test, the strip in
  `sidebar.tsx`, the Sidebar test block for the gesture, `e2e/mobile-edge-swipe.spec.ts`,
  the coach mark's edge-swipe row and its strings. The coach mark stays: it
  also teaches swiping a block, long-press and the capture button.
- **Kept:** the panel button, Ctrl+B, swiping or tapping to close the open
  drawer, and Android back closing it.
- **Docs:** `docs/UX.md` and `docs/UI-MAP.md` say the drawer opens from the
  button or Ctrl+B, never a left-edge swipe.

`e2e/mobile-drawer.spec.ts` (390 × 844, touch) checks the strip is absent, the
first block starts at the gutter, a left-edge swipe sent through CDP leaves
the drawer closed, and the button opens it. It was red against the old code
twice: with the strip, and with only the gesture.

Ran: Playwright over the 62 specs touching the sidebar, drawer, mobile, touch
or coach mark (536 passed); vitest over `src/components/ui`,
`src/components/mobile`, `src/lib` and the Sidebar and App tests (6247);
`npm run typecheck`, `npm run lint`, `knip`.
