# Session 2501 — References tag and property filters, and a deep link to a block

Mock-lane specs for #5736 item 11's tag and property filters and #5740 item
4.

**`e2e/references-filters.spec.ts`, Has Tag and Property:**
- **Sources:** three referrers of one page, each with a different mix of a
  tag and a property, plus the seeded referrer.
- **The narrowing:** Has Tag narrows to the two tagged sources. Adding a
  Property filter narrows to the one with both. Removing the tag pill leaves
  the two with the property, so each filter works on its own.
- **Each step checks** the rows and the "Showing N of M" line.
- **Mock vs backend:** for these shapes the mock's tag and property
  evaluation matches the backend. Both union attached tags with
  `#[ULID]` references, and a block without the property fails every
  operator.

**`e2e/deep-link.spec.ts`, `deeplink:navigate-to-block`:**
- **Setup:** the target block sits below the fold of a long page.
- **The effect:** emitting the event from the Journal opens the page,
  scrolls the target into view and focuses its editor on the target's text.
- **The scroll is proven:** the page's first block is out of view
  afterwards, so the target really started below the fold.

**Not covered here:**
- **Created Date:** item 11 has no date presets. The Created Date category
  is two date inputs building `CreatedInRange`, which the mock does not
  model, so it needs the real lane.
- **Item 13's backlinks query** lists the target's children instead of its
  referrers. It is fixed in its own PR.

**Shown red:**
- **Has Tag:** the filter wrapped in `Not`.
- **Property:** the text operator forced to `Neq`.
- **Deep link:** the block id dropped in `safeNavigateToPage`, and the
  editor focus skipped in `PageEditor`.

**Ran:** both files with `--repeat-each=3`, `npm run typecheck`, oxlint and
oxfmt.
