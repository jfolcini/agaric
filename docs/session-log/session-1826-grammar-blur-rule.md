# Session 1826 — grammar, phase 2c part 2: the blur acts on what the edit added

Phase 2c of #5160 (D2, X1), second half, split out of #5167 after its review timed out twice. Part 1 (#5169) made a stored line break a line of the block. The blur still classified the whole block every time it ran. It split a loaded two-paragraph block, extracted a stored `key:: v` line as a property, and folded a stored `- [ ] x` into a checkbox, although the user had typed none of them.

**The change.**
- The blur classifies only what the edit added. A block splits when the edit added top-level blocks. A `key:: value` line becomes a property only when its key is new, and a leading checkbox folds only when the loaded text had none.
- The baseline is the text the editor loaded, read before the unmount resets it. It is used at all three blur call sites, in the debounced commit and in the eight restructure handlers.
- A block loaded with `key:: v` no longer pauses the debounced commit while you type.
- The formatting toolbar has a "New line" button (Shift+Enter) for phones, which have no Shift+Enter. It survives the phone-width overflow.
- The remaining X1 rows in `block-content.vectors.json` flip to plain edits.

**Decisions.**
- A loaded `status:: todo` line whose value is edited stays text; only a new key is extracted. A loaded key edited to a different key is extracted.
- The count rule means a loaded two-paragraph block where the user deletes one paragraph and adds another is an edit, not a split.

**Left as is.** Duplicate, copy and Edit as Markdown still don't see a draft that introduces a property line, a split or a task marker until the blur. Committing it earlier would strip or split the stored text while the editor still shows the unclassified text. The scope note is in `active-draft-flush.ts`.

**Review.** The whole of Phase 2c had an independent review with the full suite before the split. It covered the blur rule's edge cases (deleting and adding a paragraph, Enter at the end of a loaded block, a loaded property key changed to another), the debounced commit and the restructure handlers' baseline, the interaction with 2b's paste (after a paste, the remount's baseline is the stored text), and the toolbar button's label, 44 px target and overflow priority. It found no defect in this half.

**Verified.**
- Every new test failed before its change, and each fix was broken again on a copy and restored with `cmp`.
- On top of part 1: typecheck and vitest are green (counts in the PR).
- `e2e/block-line-break.spec.ts` taps "New line" on an iPhone 13 viewport and reads the block back through the mock.
