# Session 2344 — The Markdown reveal for inline marks, from spike to merge quality

#5689: the maintainer decided on 2026-10-17 to extend the spike (#5699) to
merge quality for inline marks. Headings come next, in their own PR. Links
come only on request, and there is no hover reveal. The preference stays off
by default and per device.

**Fixed:**
- **Backspace right after a marker at the start of a block** merged the block
  into the one above. `useBlockKeyboard`'s capture-phase "Backspace at start"
  rule, and its Android `beforeinput` twin, ran before ProseMirror. Both now
  step aside when a marker sits before the caret, and the plugin removes the
  mark in one undo step.
- **One caret stop at a mark's edge.** Both sides of a marker are the same
  document position, so stored marks now tell them apart:
  - the arrows step over a marker;
  - a click is judged against the markers the user saw at mousedown;
  - ArrowRight at a block's end first steps out of the mark, then leaves the
    block.

  Mark inclusivity was rejected, because it would change typing with the
  preference off. Right-to-left text is not handled.
- **IME.** While composing, the decorations are frozen and map through the
  edits. One redraw follows the composition, and it never starts a new one.

**Kept, with reasons:**
- Italic shows `*`, because the serializer always writes `*`.
- Text shifts as markers appear (32 px measured): readable markers need the
  space.
- A caret move into another run still costs the browser's line layout,
  about 2 ms against 0.4 ms off, and 11 ms against 2 ms at CPU ×4. That
  equals typing one character there. The plugin's own state work stays
  within the noise of off.

Markers are `aria-hidden`: the formatting is already announced from
`<strong>`, `<em>`, `<code>` and `<s>`. The marker logic moved to
`src/editor/revealed-markers.ts`, which has no ProseMirror runtime imports,
because `use-block-keyboard.ts` sits on the cold-start path (#2939).

**Tests:**
- Every fix was shown red by reverting it.
- A fast-check property (200 runs) went red on a leaked backtick and on a
  shrunken delete range.
- Mutation testing: `revealed-markers.ts` 93.9%, and `markdown-reveal.ts`
  91.9% of covered mutants. All 19 survivors are equivalent.
- An `e2e-tauri` spec checks persistence by leaving the view and coming back,
  because the lane forbids `browser.refresh()`. It is written and typechecks,
  and is run by the orchestrator.
- The Android Gboard check is still to do.

Gates:
- vitest: 8,407 and 3,613;
- typecheck, lint and oxfmt;
- `e2e/markdown-reveal.spec.ts` 7 of 7 three times over;
- 28 editor specs with the preference off (213).
