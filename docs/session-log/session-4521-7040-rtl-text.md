# Session 4521 — right-to-left block text in arrows, rows and the source buffer

Part of the #7040 UI review, coverage item C3. Block text already ran in its own direction in the editor and the static render (#6558); five places still broke it.

**What shipped**

- **The arrows move the way they point.** ArrowLeft at the start of an Arabic or Hebrew block jumped to the block before instead of moving into the text, and ArrowRight at its end to the block after. The boundary rule in `use-block-keyboard.ts` now asks ProseMirror's bidi-aware `endOfTextblock` whether the arrow leaves the paragraph. Left-to-right blocks, empty blocks and Shift+Arrow behave as before.
- **Rows that show block text keep its direction.** Search results, the palette, the linked and unlinked references, the agenda's rows and a repeating task's coming occurrences drew block text in a left-to-right box, so Arabic mixed with English read out of order and a truncated Arabic line lost its start. Their text boxes take a new `bidi-plaintext` utility.
- **Edit as Markdown's lines** run in their own direction.
- **A callout's revealed `> [!NOTE]`** no longer turns an Arabic title left to right: the syntax marker is isolated.

**Reviewed, not defects**

Left-to-right rows are pixel-identical: element screenshots of search, the palette, the references and the agenda, on desktop and a 360 px phone, truncated rows and an English row holding an Arabic word among them, are byte-identical with and without the change. A right-to-left row puts its text on the right and keeps the checkbox, chips and breadcrumb on the left, the split the editor already uses.

**Left as they are**

The block's chrome (list markers, the checkbox side) and arrows across revealed markers are decision 33, built separately.

**Tests**

- e2e (mock lane): `rtl-text` gains the arrows walking through an Arabic block and out of it, the search, palette, references and agenda rows reading right to left, a callout's revealed marker, and Edit as Markdown's lines. Each was red on the old code.
- e2e (bridge): `agenda-projected-repeat` gains a projected Arabic task's row reading right to left, red without the class (the mock returns no projected entries).
- vitest: `use-block-keyboard-lines.test` gains the two right-to-left boundary cases.
- Falsified one mutation at a time: the old arrow mapping, the marker's isolate, and `bidi-plaintext` off a row.
- A separate session reviewed it. It added the projected-occurrence rows and made the arrows test wait for the block it lands in, which had failed one run in six.
