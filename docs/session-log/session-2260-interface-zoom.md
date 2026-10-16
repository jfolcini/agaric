# Session 2260 — Interface zoom beside the note text size

#5646: the Appearance "Font size" grew only block content, so a user who
found the app too small could not grow the sidebar, menus, dialogs or lists.

**What changed (desktop):**
- A Zoom row in Settings → Appearance, plus Ctrl+=, Ctrl+− and Ctrl+0. The
  shortcuts go through the shortcut catalog, so they are rebindable and listed
  in the sheet.
- The level is a device-scoped preference, applied at startup through the
  webview's own zoom (`setWebviewZoom` in `src/lib/platform/window.ts`, behind
  `core:webview:allow-set-webview-zoom`). That scales fixed pixel sizes too.
  At 100% no call is made.
- The cap is the largest Chrome zoom step that keeps the default window wider
  than the narrowest layout `mobile-overflow.spec.ts` sweeps.
  `interface-zoom.spec.ts` lays every view out at the default window divided
  by the cap and checks that none scrolls sideways.
- "Font size" is now "Note text size".

The webview API is loaded once and reused. Separate dynamic imports resolved
out of order, so an older level could land last.

**Review.** The reviewer found that `useZoomPan` (the image lightbox and the
diagram viewer) took `=`, `-` and `0` on `window` with any modifier. Ctrl+=
there zoomed both the picture and the interface. Ctrl/⌘ chords now belong to
the interface zoom. A new test went red with the fix reverted. A preferences
comment that claimed more than the spec checks was reworded, and an unused
type re-export was deleted.

Three specs now each install their own boot-time IPC recorder (`perf`,
`boot-ipc-counts`, `interface-zoom`). They record different things, and an
init script must be self-contained, so they were not merged.

**Not done:** Android. Whether the app follows the system font size needs a
device; the Zoom row and the zoom call are skipped on mobile.

Gates: full vitest in four shards, `npm run typecheck`, `npm run lint`, the
zoom and overflow Playwright specs at `--retries=0`, and prek on the changed
files. Each new test was shown red by breaking its code.
