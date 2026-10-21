# Session 2826 — the Markdown reveal is on by default

The maintainer decided on 2026-10-21 that the Markdown reveal (#5689) should be on by default, as Obsidian's Live Preview is its default editing view, with the toggle staying where it is in Settings › Editor.

- **Default.** `src/lib/preferences.ts` gives the reveal `defaultValue: true` and parses any stored value other than `'false'` as on, the pattern `tabIndentsBlocks` uses. `readPreference` falls back to the default only when nothing is stored, and the Settings switch has always saved a bare `'false'`, so a device that turned the reveal off keeps it off and no migration is needed.
- **Tests that assumed the old default.** The reveal's "with the preference off" block and the `use-block-keyboard` setup helpers now write the preference explicitly. Two specs (`editor-keyboard-chords`, `markdown-syntax`'s bold-plus-code case) marked one word and then selected another by character offset; the markers revealed around the first word shifted the second's offsets, so they now work right to left with the reveal on.
- **No marker text escapes.** Everything that reads editor text in production works on the ProseMirror document (`getText`, `textBetween`, the serializer) and the clipboard is built from it, so revealed markers never reach saved Markdown or the clipboard.

Four local Playwright failures fail the same way with the reveal off and are not this change's: `block-line-break` (two `<br>` instead of one) and three `diagram-legibility` cases (a label at 10.99994 px against an 11 px floor, and a tooltip intercepting a click on the phone viewer). CI on main passes them.

Suites run: vitest over `src/editor`, `src/components`, `src/hooks` and `src/lib`, typecheck, lint, and the Playwright specs `just e2e-related` selects for the change. A fresh device reading the reveal as on, and an explicit off staying off, were each shown red by reverting the default and the parse.
