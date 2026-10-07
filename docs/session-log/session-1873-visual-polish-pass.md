# Session 1873 — visual polish pass: elevation, surfaces, menus, lists and panels

The user asked for a sleeker, more professional app. They named borders
and shadows first, then asked for every panel, drawer, modal and picker
to look coherent. All of it shipped in five batches on #5271, on one
branch. Audits found the problems: a static border and shadow audit, a
Playwright screenshot sweep of every view in light, dark and at 390px,
three per-area audits (modals and drawers, pickers and popovers,
in-page panels) and a design lead. Builders worked in parallel on
disjoint files. A separate reviewer checked each builder's diff: it
re-ran the tests, falsified the new ones and looked at the result in
both themes and at phone width.

## What shipped

- **Elevation and chrome (722e568).**
  - The elevation tiers were stock 10%-black shadows that vanished on
    the dark ground. They now pair contact and ambient shadows, with an
    inset highlight in dark.
  - The dark `--border` no longer sits at the `--muted` fill's
    lightness.
  - The sidebar default width is 224px, and the active item is an inset
    bar.
  - Skeletons no longer use the brand-tinted `--accent`.
- **Menus, banners, chips and controls (60ede2d, with test fixes in
  6de856f and e9b7fba).**
  - Toasts follow the alert tokens.
  - Editor pickers share the floating radius.
  - Overdue chips and inline error banners use `alert-error` instead
    of five destructive tints.
  - P2 chips get a dark foreground. White on yellow was 1.9:1; it is
    now about 7.3:1, pinned in `theme-contrast.test.ts`.
  - Calendar: the selected day's number was invisible. The cell's
    `aria-selected` accent outranked `selected`'s primary fill.
  - `color-scheme: dark` lets native controls follow the theme.
- **Modals, sheets, menus and pickers (e374ab1).**
  - Dialogs, alert dialogs and sheets take `bg-popover`. Dark modals sat
    below cards and popovers.
  - Width overrides now win over the base `sm:max-w-lg`. Before, the
    bug report, diagnostics and PDF viewer all rendered at 512px.
  - Destructive confirms use the destructive variant.
  - Toolbar menu rows share one `toolbarMenuRowClass`. Two of the eight
    copies had drifted.
  - Tooltips use the popover surface in dark themes.
  - Solarized Dark and One Dark Pro muted text clears AA on the lifted
    surfaces.
- **Lists, panels and page chrome (this batch).**
  - The list cursor no longer rests on row 0 with a red ring. It is a
    tint at rest (`list-cursor`), and the ring shows only while keyboard
    focus is in that list.
  - Lists whose keys arrive at `document` (History, Trash, Pages) and
    the reference lists move focus to the list on a navigation key.
    Due, Done and Agenda rows take focus as the cursor reaches them.
  - The agenda's source filters and All/Any are segmented ToggleGroups.
  - Agenda mode has a single h1, above the sticky filter bar.
  - Day panels follow the day's blocks.
  - EmptyState drops its dashed box.
  - The settings tabs that lacked cards now have them.
  - Graph and Templates use the shell label as their h1.
  - Page titles are text-3xl.
  - Static blocks share the editor's line height, so focusing a block
    no longer shifts it.
  - The checkbox border reaches 3:1.

## Found along the way

- The bugs this batch fixed:
  - A failed refresh after a space delete reported the delete as failed.
  - Space on a focused History or Trash row toggled it twice.
  - The tag-filter cursor ring sat under the opaque result card.
- CI went red once, on 6de856f: `BlockInlineControls.test.tsx` still
  pinned `text-destructive` for overdue dates. The targeted runs had
  missed it. From then on, every batch ran the full suite before
  pushing.
- Pre-existing and left for later:
  - `useJournalAutoCreate.ts:62` calls `preventDefault()` on Enter for
    any non-editable target, so Enter does nothing on buttons in the
    Journal day view (#5301).
  - In Due, Done and Agenda lists longer than the virtual window,
    Home/End/PageUp/PageDown unmount the focused row before the target
    row mounts, and focus falls to `<body>` (#5302).
  - The due-source radiogroup has no accessible name.

## Left for the maintainer

Brand-level choices were proposed but not made:

- a neutral focus and selection colour instead of red
- a neutral `--accent` hover
- an ink primary with a separate `--brand` token
- bundling Inter Variable
- warm neutrals
- a reading-width measure
- trimming the chrome
- a softer priority chip palette

## Verification

- Batches 3–4: the full vitest suite, 866 files and 20325 tests, plus
  `npm run typecheck`.
- Batch 5: the full vitest suite, 866 files and 20382 tests (1 expected
  fail, 51 skipped), plus `npm run typecheck`.
- The batch-5 reviewers ran these Playwright specs against the mock
  backend:
  - `keyboard-collisions`, `features-coverage` and `query-blocks`: 45
    passed.
  - The pages-view arrow test.
- Each new test was shown red against a scratch copy first, then the
  copy was restored and checked with `cmp`.
