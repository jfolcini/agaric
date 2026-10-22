# Session 2854 — tabs in a narrow desktop window, page mode's advertised chords, three contrast fixes

The UI findings of the 2026-10-22 architecture review, #6053.

- **A narrow desktop window keeps its tabs.** The tab bar, Ctrl+T, Ctrl+W, Ctrl+Tab, Open in new tab, Ctrl+click into a background tab, and the header's Today, Agenda and calendar now hide only on a touch phone (`useIsTouch() && useIsMobile()`), not below a width. The issue suggested `useShouldShowMobileChrome()`. That was not used because it still returns true whenever `useIsMobile()` does. `useAppKeyboardShortcuts`'s `isMobile` parameter is now `isTouchPhone`, because that is what it means.
- **Page mode binds the chords its block menu prints.** Move up, Move down and Duplicate are bound in a `PageBlockKeys` extension at the end of `page-block-actions.ts`, and the history chord is bound in `PageTaskKeys`. Putting them in `PageKeys` made an import cycle with `page-block-actions.ts`. The extension keeps the dependency one way and moves none of the helpers both files use.
- **A chord-parity test** in `page-mode-surface-parity` covers every rebindable chord in `keyboard-config/catalog.ts`, so the next chord cannot drift between modes. `heading1`–`heading6` are waived: block mode handles them in the block tree's own listener, which page mode does not mount. The test checks that a handler claims each chord, and the chord tests check the action.
- **Three labels drop their alpha:** Agenda's upcoming date, the Pages row count and the attachment caption placeholder. The tokens' own muted tier already meets 4.5:1.
- **A tap in the week view lands on the block tapped** when another day's editor is in a code block.
  - `keepEditorUntilClick` now reads the focused editor through `active-editor.ts` instead of its own tree's editor.
  - `handleFocus` blurs another tree's editor before mounting, so that editor's blur handler saves its block first. Without the blur, the global check alone lost the other day's unsaved text, and `editor-lifecycle.spec.ts` went red.
  - Paths traced: mouse, touch, modified clicks, arrow keys across days and programmatic focus. Arrow keys and programmatic focus go through the auto-mount effect, which is unchanged. Page mode saves on blur too.
- **Horizontal strips scroll only when they overflow:** the tab bar, the recents strip and the Pages filter row. Before this they reserved an empty 10 px scrollbar strip. The issue's breadcrumb premise was false: the breadcrumb does not have that strip.

Not done: page mode has no heading chords. Binding Ctrl+Alt+1–6 to `/h1`–`/h6` is small if anyone misses them. The quick-capture button still shows in a narrow mouse window because it keys on `useShouldShowMobileChrome`; that predates this change.

**Shown red:**
- removing `PageBlockKeys` (6 tests);
- the tab bar back on width alone;
- dropping the other tree's blur in `handleFocus`;
- unbinding the history chord;
- `keepEditorUntilClick` back to its own tree (`week-touch-tap.spec.ts`).

**Suites run:**
- the import-cycle check (0 cycles);
- typecheck and lint;
- vitest over `src/__tests__` and the agenda, graph, layout, pages, editor-component, hooks and page-mode folders;
- `prek run --hook-stage manual --all-files`;
- Playwright over the new specs, tabs and header, phone and touch, editor lifecycle and week view, pages and page mode: 268 passed. The one failure was the page-mode first-switch spec, which #6063 fixed on main.
