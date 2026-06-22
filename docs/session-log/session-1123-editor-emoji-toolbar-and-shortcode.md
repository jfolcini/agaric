# Session 1123 — editor emoji: toolbar button + `:shortcode:` auto-replace

User asked for: an emoji button in the editor toolbar, a `:smile:` shortcode syntax, and a
recent-emojis strip in the picker. The recents strip already existed (`EmojiPicker.tsx` renders
a "Recents" row when the search is empty and recents are non-empty) — it was just empty until
you've used emojis. The new work is the toolbar button + the closing-colon auto-replace, plus
feeding recents from the typing paths so the existing strip actually fills.

## Shipped

1. **`:shortcode:` closing-colon auto-replace.** The `:` suggestion popup already fired as you
   type `:joy`; added a TipTap `addInputRules()` to the EmojiPicker extension that converts a
   COMPLETED `:joy:` to 😂 the instant the closing colon is typed (Slack/GitHub style).
   - `src/editor/emoji-data.ts` — `emojiByShortcode(name)`: a once-built `Map<name, char>`,
     exact canonical-`name` match only (not keywords) for deterministic 1:1 replacement.
   - `src/editor/extensions/emoji-picker.ts` — `InputRule` find
     `/(?:^|\s):([A-Za-z0-9_+-]{2,}):$/` (anchored to start/whitespace so `http://a:b:`, `3:30:`
     and the `::` property trigger never fire), gated by the same `isEmojiPickerEnabled()` pref,
     replaces only the `:name:` token, and pushes recents. Coexists with the popup.

2. **Editor toolbar emoji button.** A `Smile` button that opens the same browse-grid picker the
   `/emoji` slash command uses (dialog on desktop, bottom-sheet on mobile), inserting at the
   caret via `insertEmojiIntoActiveEditor`.
   - `src/lib/block-event-names.ts` — `OPEN_EMOJI_PICKER`.
   - `src/hooks/useBlockTreeEventListeners.ts` — `handleOpenEmojiPicker` handler + registration.
   - `src/components/editor/BlockTree.tsx` — passes `handleOpenEmojiPicker: openEmojiPicker`.
   - `src/lib/toolbar-config.ts` — Smile button in `createRefsAndBlocks`, dispatches the event.
   - `src/lib/i18n/toolbar.ts` — `toolbar.emoji` / `toolbar.emojiTip`.

3. **Recents fill from typing.** The inline `:` command handler and the new input rule both call
   `pushEmojiRecent(emoji)`, so the existing recents strip populates from typing, not just the
   dialog.

## Verification
- Unit: `emojiByShortcode` lookup (case-insensitive, unknown → null), hook options — 66 passed
  across the emoji/hook suites.
- E2e (`emoji-picker.spec.ts`): `:joy:` closing-colon auto-replace; the toolbar emoji button
  opens the picker; coexistence preserved (`::` property picker, `:joy` popup, bare `:`, and the
  Settings disable toggle still gates the input rule) — 6 passed. Adjacent suites
  (`slash-commands`, `toolbar-and-blocks`, `toolbar-controls`, `settings`) — 70 passed.
- `oxlint` + `tsc -b` clean.
