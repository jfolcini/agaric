# Session 4453 — keyboard affordances only with a keyboard, and one way to draw a shortcut

Part of the #7040 UI review, items S8 and S14. The maintainer decided on 2026-11-25 that keyboard-only surfaces are hidden on a touch device unless a hardware keyboard is detected.

**What shipped**

- **List cursor.** The `list-cursor` tint and bar paint only under `:root[data-list-cursor]`. `showListCursor()` in `useListKeyboardNavigation` sets it when a key moves the cursor, and the next pointer press clears it. One place covers Pages, History, Trash, Query, the agenda, Tags and the reference lists. Like `:focus-visible`, the paint is document-wide, so after arrowing in one list the next list shows its cursor too. History's touch ↑/↓ buttons also show it.
- **No focus ring on load.** The view-change focus move (the primary-focus registry and `#main-content`), Search, the Quick reference and reference-sheet filters, and the welcome modal's Get started focus with `focus({ focusVisible: false })`. Tab still draws the ring.
  - The Settings section select and the first block-menu row did not actually ring after a tap or right-click. The UI-review tour rang them because it pressed keys first.
- **Keyboard hints on touch.** `useKeyboardHints()` = `!useIsTouch() || useHasHardwareKeyboard()`, so a mouse desktop always shows hints. It gates:
  - the Settings Keyboard tab;
  - the Quick reference palette command (`requires: 'keyboard'`) and the palette's chips;
  - the space switcher's `Alt+N` hints;
  - "Press ? for help" under Search;
  - the suggestion list's footer and chips;
  - the slash-reference sheet;
  - the block-menu, page-menu and table hints.

  "Tap to select" is gone.
- **One shortcut renderer.** `ui/kbd.tsx`'s `<Kbd keys="Ctrl + Shift + Arrow Up" />` draws each alternative as one keycap: glyphs on macOS (`⌘⇧↑`), `Ctrl+Shift+↑` elsewhere, arrows as glyphs everywhere.
  - It replaces `KbdChord`, `renderKeys`, the bare `<Kbd>` literals, the menus' grey `formatHintKeys` text, and the palette's inline `→ Ctrl+Shift+F`.
  - The dead helpers and their tests are deleted.
  - The quick-capture accelerator goes through `acceleratorToKeys` in `lib/quick-capture-shortcut.ts`.

**Traps**

- **Emulated phones count as having a keyboard.** `useHasHardwareKeyboard` also turns true when `navigator.keyboard.getLayoutMap()` returns a layout. Playwright's emulated phones run on desktop Chromium, so they do. Android's WebView has no `navigator.keyboard`. Phone specs that check the hidden hints, and the UI-review tour's phone profile, delete `Navigator.prototype.keyboard` first; the tour's first key press still latches a keyboard.
- **`shortcutHint(id)` stays a catalog read.** Calling `getShortcutKeys` for display would count as consumption in `keyboard-config-rebindable-drift.test.ts`.
- **Not done:** the empty-block placeholder's "Shift+Enter for a line break" still shows on touch.

**Tests**

- New: `useKeyboardHints` vitest; `kbd` vitest (rewritten); the suggestion list's touch gates; cursor paint in `useListKeyboardNavigation`.
- e2e: `pages-keyboard-controls` (no cursor bar at rest; no ring on App's focus, a ring on Tab); `settings-phone` (no Keyboard tab and no "Press ?" on a touch phone without a keyboard); `list-rows-phone` (the card corner at rest); `onboarding-first-run` (Get started with no ring).
- Each was shown red by a mutation.
- Existing tests that pinned the old keycap format or tooltip spacing (`Ctrl + X` → `Ctrl+X`) were updated, as was `SpaceSwitcher`'s macOS hint, which is now `⌥1`.
- `just check-fe` passed. The full vitest suite ran in four shards (i18n changed), plus 105 keyboard, list, settings, search, palette, picker and phone specs.
