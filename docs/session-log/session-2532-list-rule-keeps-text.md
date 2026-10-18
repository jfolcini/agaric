# Session 2532

Block mode's list-style input rule (`src/editor/extensions/list-style-input-rule.ts`)
no longer loses text. Found while building page mode's lists (#5743, session
2530), and by #5825's review.

**Text after the caret.** With the caret at the start of a block that holds
text, `- ` (or `1. `) wraps the whole paragraph in a one-item list through the
stock `BulletList` / `OrderedList` rule. The next character fired the unwrap
rule, whose `find` reads only the text before the caret, and its handler
rebuilt the paragraph from that one character: `hello world` became `a`, marks
and all. TipTap inserts the typed character before the handler runs, so the
paragraph already holds `ahello world`; the handler now keeps the list item's
paragraph content as it is and puts the caret after the typed character.

**Enter after `- `.** TipTap runs input rules on Enter with the text `\n`, and
the bullet rule's `[^[]` matched it: the rule set `bullet`, swallowed the Enter
and stored a hard break (`\` and a newline). The bullet rule is now
`[^[\n]`. The ordered rule's `.` never matched `\n`. Enter after `- ` now does
what Enter after `1. ` already did: `splitListItem` declines an empty top-level
item and the core keymap's `liftEmptyBlock` lifts it out, leaving one empty
plain block with no style.

**Checkboxes.** `CheckboxInputRule`'s bare rule had the same loss: `- [ ] ` or
`- [x] ` typed before `hello world` set the task state and left the block empty.
It now keeps the text after the trigger, with the caret at its start.

**Tests**, each shown red against the unfixed code:
- vitest (`list-style-input-rule.test.ts`): `- a` and `1. a` at the start of
  `hello world` keep `ahello world` with the caret after `a`; a bold word after
  the caret keeps its bold. Red: `"a"` for `"ahello world"`, and the caret at 1.
- vitest: `- ` and `1. ` then Enter call no `onListStyle` and leave one empty
  paragraph. Red: the bullet regex put back; the ordered pin with `.` matching
  `\n`.
- Playwright (`e2e/list-style-keyboard.spec.ts`): `- a` at the start of
  `hello world` shows `ahello world`, and after navigating away and back the
  block reads `•ahello world`. Red with the fix reverted: `Received: "a"`.

Page mode's own rule has the same `\n` match; its fix goes with #5825's review
notes.
