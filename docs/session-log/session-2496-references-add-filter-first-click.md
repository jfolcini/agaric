# Session 2496 — one click on *Add filter* opens it while a block is edited

The real-lane References spec (#5806) found that the first click on *Add
filter* was lost while a block above it was being edited.

- **The cause:** the desktop formatting toolbar sits in the page flow above
  the block's text, and it exists only while the block is edited. The press
  blurred the editor, the toolbar unmounted, and the button moved up by the
  toolbar's height. The release landed on a different element, so no click
  fired.
- **Not the cause:** the empty row. The editing row and the static row are
  the same height, for empty and non-empty blocks alike.

**Changed:** *Add filter* prevents the default mousedown, the pattern
`AddBlockButton` and the Search controls (#5803) already use. The editor
keeps focus and the filter row opens on one click.
- **Unchanged:**
  - Keyboard activation fires no mousedown.
  - Right-click still opens the context menu.
  - Touch was never affected: its toolbar is pinned outside the flow.
- **Afterwards:** the block above stays in edit mode, as it does after *Add
  block*.

**Open:** the same shift costs the first click on every control below a
block being edited. A review probe confirmed it on the *Page links* toggle,
*Filter by source page*, the References and Unlinked references headers, and
the journal Due panel header. A fix for all of them is a design call, filed
as #5807 with measurements and three options.

**Spec:** `e2e/references-add-filter-click.spec.ts`. With the formatting
toolbar showing for the edited block, one click on *Add filter* shows the
filter row. A vitest presses the button while an input is focused: the input
keeps focus, and the row opens on release.

**Shown red:** the guard removed fails the spec at the filter row and the
vitest at the focus assertion.

**Ran:**
- the spec with `--repeat-each=3`;
- the references, unlinked-references and journal-panels specs;
- vitest over `src/components`;
- `npm run typecheck`, `npm run lint` and oxfmt.
