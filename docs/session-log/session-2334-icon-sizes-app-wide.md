# Session 2334 — Button icons render the size their class asks for

The app-wide half of #5682, after the toolbar fix in session 2296.

**Measured before** (static walk of every lucide icon written directly inside
a `Button` or `IconButton`, then Playwright at pixel ratios 1 and 2 on the
journal header, Pages rows and tree, the batch toolbar, Settings › Properties
and the Tags list):
- **`icon-xs` shrank its icons to 12 px.** 40 icons outside the toolbar, 35
  of them asking for 14 or 16 px or for nothing: the header Back and Forward,
  the journal day controls, page row and page tree actions, property
  definition deletes, tag row actions, page quick actions.
- **`h-*`/`w-*` on an icon inside any Button did nothing.** The variant's
  `[&_svg:not([class*='size-'])]` rule outranks a single class. 53 icons
  asked for 12 or 14 px and rendered 16; 44 of them were `h-3.5 w-3.5`. The
  issue's "about 145" counted every `h-3.5 w-3.5` icon in the app, most of
  which sit outside a Button and already render 14.

**Fix.**
- `button.tsx`: the icon size rule is `[:where(&)_svg]:size-4`, so it has
  zero specificity and any `size-*`, `h-*` or `w-*` on the icon wins.
  `icon-xs` no longer overrides it, so its icons default to 16 px. `xs`, a
  text button, keeps 12 px icons beside its 12 px text.
- Call sites: in text and larger icon buttons, the sizing classes that never
  applied are deleted, so they keep rendering 16 px (12 px in `xs`), as they
  always did. `toolbarIconClass` from session 2296 and `PageQuickActions`'
  per-preset `iconClass` now restate the default, so both are deleted. Four
  `Spinner size="sm"` in `sm` buttons take the default, which is what they
  already showed.
- **Kept at 14 px:** the Tags list row actions (their color swatch is
  14 px, and the brush swaps with it) and the saved-views delete (its row's
  check mark is 14 px). **Kept at 12 px:** the `icon-xs` property remove and
  option-reorder buttons, which ask for `h-3 w-3` and render it.

No button changed size at either pixel ratio, so nothing in the measured
rows, tree, header or toolbar moved.

**Page row alignment.** A Pages row's checkbox sat 2.5 px above its icons,
and its delete button 0.5 px above: their gridcells were block boxes around
an inline-flex control, so the line box's descender space pushed the
control to the top. Both cells are now `flex items-center`, and the row's
checkbox, bookmark, page and trash icons share one centre at pixel ratios 1
and 2. The page tree, Tags list and property definition rows were already
centred.

**Proof.** `e2e/icon-button-sizes.spec.ts` requires 16×16 for the header Back
button, a page row's bookmark and delete, a page tree delete and a property
definition delete, 14×14 for a tag row's rename, and one vertical centre
(within 0.5 px) for a page row's checkbox and icons. With the old
`button.tsx` it failed at Back (12×12); with only the old specificity
restored it failed at the tag row (16×16 against 14×14); with the old row
cells it failed at the centres (2.5 px apart). It passed ten
repeated runs with the fix.

Gates: vitest related to the changed files (276 files), `npm run typecheck`,
oxlint, oxfmt, and Playwright: the toolbar-icons, icon-button-sizes,
mobile-overflow, pages, page tree, bookmark, header, navigation, properties,
tags, journal panel, Edit as Markdown and selection bubble specs (174
passed), and the formatting toolbar specs (67 passed, 2 skips that already
existed).

The mobile header's search icon asked for 20 px through `h-5 w-5`, which never applied. Rather than let it grow to 20 px beside 16 px neighbours, the class is dropped and it stays at 16.
