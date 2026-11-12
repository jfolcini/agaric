# Session 3866 — shortcut labels follow the platform, and the desktop help and header tell the truth (#6548, checkboxes 1–2)

The first two checkboxes of #6548: platform-correct shortcut chips everywhere the palette and slash menu show them, and the desktop help and header batch. Mid-run the maintainer ruled (2026-11-12) that an existing test may be edited where the issue changes the behaviour it asserts, so the sub-items first skipped for that reason were done too. The report lists each edited assertion.

- **Chips follow the platform.**
  - **Palette and slash menu.** `CommandsModeBody` and `SuggestionList` render their chords through `KbdChord size="sm"`, which reads `isMac()` (`src/lib/platform`). Linux and Windows read `Ctrl + Shift + F`; macOS reads `⌘ + Shift + F`. `formatChordTokens` drew `⌃ ⇧ ⌥` on every platform. It had no other caller, so `format-chord.ts` and its barrel export are deleted.
  - **SpaceSwitcher.** Its `isMac()` branch existed only for those glyphs. It is gone, and the space hint reads `Alt+1` everywhere.
  - **Palette footer and action menu.** The new-tab hints were hard-coded `⌘↵`. They are now the chord `Ctrl + Enter`, rendered by `KbdChord`. The palette's new-tab handler takes `metaKey || ctrlKey` and has no catalog binding, so that chord is the binding's only spelling.
  - **Settings input still parses glyphs.** `parse.ts` still accepts `⌘⌥⌃⇧` typed into Settings, because users copy them from macOS menus. Only its comment changed.
- **The help says what the keys do.**
  - Enter reads "Save block and add a new block below", which is what it does (`use-block-keyboard.ts`).
  - The Essential "Search your notes" row showed `findInPage` (Ctrl+F). It now shows `focusSearch` (Ctrl+Shift+F), the chord that searches the notes.
- **The Quick Reference is no longer cramped.**
  - On desktop the sheet is `sm:max-w-lg` (512 px), and from `sm` up the chord column takes half its width.
  - The Shortcut / Action header row now appears once.
  - In `KbdChord`, each alternative sits in its own flex span. Below `sm` that span still wraps, because a phone's column is too narrow for `Ctrl + Shift + Arrow Right` on one line. Above `sm` it does not.
  - Widening alone was not enough: `Ctrl + Y / Ctrl + Shift + Z` still broke inside the second alternative.
- **The first palette open is not empty.** Before any page is recent, desktop Ctrl+K lists the Navigate commands (`CommandsModeBody navigateOnly`) under the welcome sentence. The sentence moved above the list, because cmdk's `CommandEmpty` hides once the list has items. The phone search sheet is unchanged and keeps the sentence alone, which a vitest now pins.
- **The header carries Today alone outside the journal.**
  - The `DATE_CONTROL_VIEWS` allowlist (#1740) gave Pages, Search, Tags and Query an Agenda button and a calendar that Graph, History, Templates and Trash lacked. #6548 replaces that allowlist, so `GlobalDateControls` is now the Today button and nothing else. The journal's own header keeps Agenda and the calendar.
  - The header-calendar tests in `GlobalDateControls.test.tsx` went with the behaviour. The dropdown keeps its own coverage in `JournalCalendarDropdown*.test.tsx` and `JournalControls.test.tsx`.
  - `journal.agenda` and `journal.goToAgenda` had no other user and are deleted.
  - From Pages, Search, Tags or Query the Agenda is now two steps (Today or the sidebar's Journal, then the journal's Agenda tab), and a date picker is two (Today, then the journal's calendar).
  - `phone-header-bar.spec.ts` no longer checks for Agenda and calendar buttons that no view renders any more, and the `useViewChangeAnnouncer.ts` comment names the palette's Go to today instead of `GlobalDateControls`, which never renders on the journal.
- **Checks run:**
  - vitest on every changed test file, including `App`, `JournalPage`, `JournalControls`, `SpaceSwitcher`, `keyboard-config`, `kbd`, `ViewDispatcher` and the i18n tests. Each new or rewritten assertion was red first, or was shown red by putting the old code back.
  - `npm run typecheck`, `npx knip`, and oxfmt and oxlint on the changed files.
  - Playwright: `e2e/shortcut-labels.spec.ts`, `narrow-window-tabs`, `palette-desktop`, `slash-commands-happy-paths`, `suggestion-keyboard`, `phone-header-bar`, `menus-popovers`, `keyboard-collisions`, `editor-reference-sheets`, `phone-bottom-sheets`, `keyboard-shortcuts`, and the Quick Reference case of `mobile-overflow`. `e2e-related` selects the whole lane for a `kbd.tsx` change, so this is a sample, not the lane.

The bundle gate then failed on `index` (293,732 B gzip against 258,033 B) with no new startup code. Removing `formatChordTokens` from `SpaceSwitcher` cut the entry chunk's last edge to `format-chord.ts`, and Rolldown folded about 40 shared chunks into `index` that `index` already imported statically on `main`. Bisected by applying one branch file at a time to a `main` snapshot. `index` plus everything it statically imports went from 672,398 B gzip on `main` to 659,166 B here, so the `index` budget alone is re-baselined in `scripts/bundle-budgets.json`. The gate measures one chunk, so any change to an import edge can move bytes across it this way.
