# Session 3021 — Heading chords in page mode and in Edit as Markdown (#5691)

Set out to close the last chord gap in page mode: Ctrl+Alt+1–6 made headings only in block mode, and the parity test waived all six.

**Shipped:**
- **One matcher, `headingChordLevel(e)`** in `src/lib/keyboard-config/match.ts`, reads the catalog, rebinds included. Block mode, page mode and the Markdown buffer all call it. Block mode's own six-way loop was replaced in review.
- **Page mode** turns every block the selection touches into that heading level, in one transaction, so one Ctrl+Z undoes it. This applies only to a block that opens with text or a heading. A block that opens with code, a quote or a table is left as it is, where block mode would prepend `# `. A list style goes through `page-lists.ts`'s existing `leftTheirList`.
- **The Markdown buffer** runs its existing `turnInto(block, 'h<n>')` on the caret's line.
- **The block menu's** Heading 1–3 rows show their chord. `TURN_INTO_OPTIONS` stops at Heading 3, so there are no rows for 4–6.
- **The parity test's** six heading waivers are gone; only zoom stays waived, because page mode has no zoom.

**Traps:**
- **Routing the chord through Turn into does not work.** Turn into stops at Heading 3, so Ctrl+Alt+6 did nothing.
- **AltGr is Ctrl+Alt on Linux and Windows.** The matcher reads `e.key` when both are down, so AltGr+7/8 typing `{` or `[` never matches. `keyboard-config.test.ts` already pins AltGr+2.

**Tests:**
- e2e: `page-mode-toolbar` checks each level, a level change, and a cleared list style, after navigating away and back; `page-source-edit` checks a heading chord saved from the buffer.
- vitest: `page-keys`, `source-buffer-keys`, `BlockContextMenu` and `keyboard-config`.
- Each shown red, as was review's block-mode change.

**Suites:**
- vitest over `src/editor`, `src/components/editor`, `block-tree`, `pages`, `editor-toolbar` and `src/hooks` (10,048 tests);
- typecheck, lint and the manual-stage hooks;
- Playwright: every `page-mode-*` spec, `journal-page-mode`, `page-source-edit`, and the keyboard, menu and Obsidian keymap specs (191).
