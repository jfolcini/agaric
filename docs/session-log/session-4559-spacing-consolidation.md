# Session 4559 — spacing consolidation: one gutter token, padded primitives, fewer steps

The maintainer asked for a review of all spacing to consolidate it into fewer tokens. An audit counted 2,385 spacing utilities over 19 Tailwind steps plus 25 arbitrary values (counted by a regex script over `src/`, comments stripped). Most divergence was the same role spelled several ways: popovers overriding their primitive's padding (1 of 27 used the `p-4` default), every batch toolbar overriding `BatchActionToolbar`, three alert-box paddings, hand-rolled menu rows without the touch minimum, two leading-icon search field layouts, and the 16/24 px view gutter written out as `X-4 md:X-6` pairs.

**What changed**

- `--pane-gutter` (1rem, 1.5rem from 48rem) is the view's side gutter: `App`'s scroller and header, sheets, the tab bar, quick-access bar, view and page toolbars, and `outline-column`. Every value computes as before, except that a sheet setting its own padding (calendar, `MenuSheet`, sidebar) now keeps it on a phone held sideways, where `md:p-6` used to override it.
- `PopoverContent` pads `p-3`: the ten `p-3` overrides went, forms and panels on `p-2` took the default, menus and toolbars stay `p-1` (the colour picker's `p-1.5` joined them).
- `BatchActionToolbar` pads `gap-3 p-3`, what all three consumers set; `BlockBatchActionMenu` matches it. Alert boxes pad `p-3`.
- Nine hand-rolled menu rows use `menuRowVariants`, gaining its 44 px coarse minimum; their text sits in an inner span so `truncate` and two-line rows still work in its flex row. Page-tree rows stay as they are: they are tree rows, not menu choices.
- `SearchInput` takes `searchIcon`: the magnifier at `left-3` (the input's `px-3`), text at `pl-9`; the four hand-rolled fields use it.
- Off-scale steps: the `xs` button and recent-page chip pad `px-3` on every pointer; `py-10` empty states are `py-8`; the phone chips pad `max-sm:px-3`; arbitrary values that equalled a step became the step; `InPageFind` sits at `--phone-header-h`. Command items take the touch minimum (`coarse:min-h-(--touch-target)`) in place of `coarse:py-2.5`, which only reached 44 px through the text size.
- The block inset is `--block-inset` in `.ProseMirror`, `StaticBlock` and the metadata row, which the alignment test already pinned as one value.

**Kept**, because geometry derives them: the block tokens; the negative margins that cancel a button's padding (`-ml-1.25`, `-ml-2.5`, the `coarse:-m*-3` set); the priority badge's `py-0.75` (18 px like its sibling chips); icon-plus-gap indents (`pl-7`, `pl-9`, menu indents); the clear button's `pr-10`; list-marker `pl-5`; `sidebar.tsx`'s vendored shadcn geometry; safe-area and FAB calcs. The agenda scroller's `pr-2.5` claimed a 10 px scrollbar that is now 6 px (8 px on touch): it is `pr-2`.

The list row keeps `py-2.5`. `py-3` made a Pages row 48 px against its virtualizer's 44 px estimate (its 24 px control set the height, not a text line), and the Pages scroll specs went red; a 44 px minimum on every pointer broke `desktop-app-touch`, which keeps the desktop app's rows mouse-sized. Since derived values keep `2.5` in use anyway, moving the row would not have cut a step.

**Ran**

`npm run typecheck`; oxlint and oxfmt over the changed files; `npx vitest related` over every changed source file (424 files, 10,623 tests); the whole Playwright mock lane, both projects (1,382 passed; the one failure was the list-row attempt above, reverted and re-run with the Pages, palette and desktop-touch specs).
