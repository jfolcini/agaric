# Session 4447 — the recent-pages strip gives way to tabs and phones; the Pages "+" goes plain beside the capture button

Part of the #7040 UI review, items S4 and P5, built on the maintainer's 2026-11-25 decisions.

**What shipped**

- **The recent-pages strip** (`QuickAccessBar`) is gone on a touch phone (`useIsTouch() && useIsMobile()`, the gate the tab bar and `App.tsx` already use for phones). It is also gone while the tab bar shows, which is more than one tab in the space (`TabBar` hides itself at one). It stays on a desktop with one tab, in a narrow mouse window, and on a touch tablet. Recent pages stay in the palette's recents group, and on a phone in the search sheet. They were never in the sidebar: `BookmarksSection` lists bookmarks, and its comment now says so.
- **The view-header hairline** is drawn by the view's centred header column, not the full-width slot, so it is as wide as the column. The top bar, the tab strip and the strip keep their full-width borders: they frame the window, or carry left-aligned content.
- **The Pages "+"** is a ghost icon button wherever the red capture button shows (`useShouldShowMobileChrome`), so the capture button is the only filled create there. A narrow mouse window has no capture button and keeps the filled "+".

**Traps**

- `pages-view.spec.ts` and other bridge specs only run as temporary `e2e/zz-*.spec.ts` copies with `--project=chromium`.
- Once a second tab opens, the strip is gone, so specs that middle- or Ctrl-clicked a second chip after the first tab opened had to change. `spaces-happy-paths` now reads each space's recents through the palette.

**Tests**

- `recent-pages-strip`, `phone-view-headers`, `list-view-width`, `pages-view`, `phone-touch-targets`, `spaces-happy-paths`, `strip-scrollbars`, plus `QuickAccessBar` and `App` vitest. Each new check was shown red with its fix reverted. The narrow-window "+" check was also shown red with the variant keyed back on `isMobile`.
- `just check-fe` passed. The targeted mock specs passed, and 20 bridge specs passed as local copies.
