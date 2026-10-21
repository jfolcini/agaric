# Session 2823 — Obsidian's core chords: Ctrl+E page mode, tabs, quick switcher, back and forward

The maintainer wants an Obsidian user to feel at home from the keyboard and the mouse. This session moved the chords that collided with Obsidian's muscle memory and bound the ones Agaric left free, following the four keymap decisions the maintainer made.

- **Moved:**
  - `Ctrl+E` now toggles Blocks / Page mode (`Ctrl+Shift+M` stays), so inline code moves to `Ctrl+Shift+K`.
  - `Ctrl+Shift+T` reopens the last closed tab, so Turn into moves to `Ctrl+Shift+L`.
  - `Ctrl+1`–`Ctrl+8` select tab N and `Ctrl+9` the last tab, so space switching moves to `Alt+1`–`Alt+9`.
- **Bound:**
  - `Ctrl+L` cycles the task state beside `Ctrl+Enter`.
  - `Ctrl+O` opens the palette in page search and `Ctrl+P` in commands mode.
  - `Ctrl+Alt+←/→` and mouse buttons 3 and 4 go back and forward.
- **Why these chords:** `Ctrl+Shift+K`, `Ctrl+Shift+L` and `Alt+digit` are free in the catalog, the WebViews, GNOME and macOS. macOS sends Option+digit as `¡` and the like, so `match.ts` reads the digit-row key as its digit when Alt is held alone, and not with Ctrl, where Windows AltGr types `²`.
- **Reopen closed tab:**
  - The tabs store keeps the closed tabs with a page per space, capped at `MAX_CLOSED_TABS`. The stack is not persisted.
  - A reopen restores the tab at its old position with its page stack, and replaces the lone empty tab that closing the last tab leaves.
- **Palette:** it lists Back, Forward, Reopen closed tab and Toggle page mode with their chips. It leaves out the editor-only chords, because opening the palette takes the block's focus, and the per-digit rows.

- **Review.** The commit left `SuggestionList.test.tsx` expecting the old inline-code chip; the 21 touched test files had passed, but the full suite caught it. A new test sends `Ctrl+E` through the editor's real keymap and checks no code mark appears. The Back and Forward header buttons now show their chord in the tooltip and `aria-keyshortcuts`, and stale chord text in the Settings help, comments, `COMPARISON.md` and a conformance fixture's description is fixed.

Left for slice 2: `Ctrl+G` graph and `Ctrl+,` settings. `Alt+digit` reads `e.code`, so it fires on AZERTY; `Ctrl+digit` still does not there, where the digit row needs Shift, as before. `Alt+digit` is ignored while the cursor is in a block, because macOS Option+digit types a character. On GNOME, `Ctrl+Alt+←/→` is the desktop's workspace switch, as it is for Obsidian; the mouse buttons and the palette rows still reach Back and Forward. The mouse buttons are documented in `keyboard.md` but have no catalog row.

Suites run:
- the full vitest suite in six shards (one load failure in an untouched file passed alone).
- typecheck, lint, the manual-stage prek hooks.
- Playwright: the collision, turn-into, markdown-syntax, spaces, page-mode, navigation-history, keyboard, tabs and palette specs, plus the new `e2e/obsidian-keymap.spec.ts`.

Each new test was shown red by a mutation of the code it covers.
