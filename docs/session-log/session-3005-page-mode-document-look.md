# Session 3005 — Page mode reads as a document (#5691)

Set out to make page mode look like GitLab's rich text editor (#5691, the maintainer's decision of 2026-10-28). Page mode looked almost pixel-identical to block mode, so users could not tell which mode they were in.

**Shipped.** All of it is CSS scoped under `.page-mode-editor`; block mode is unchanged.
- A bordered frame holding page mode's toolbar (#6148), the text, and a footer hint: "Supports Markdown. Type / for commands".
- Document spacing between blocks, tighter between list items.
- Rules under H1 and H2.
- No ring or tint on the current block.
- Dates, priority and repeat as small muted text. An overdue or today date and the priority keep their colour.
- Property chips and the attachment badge hidden at rest. They show on hover, focus-within or with the caret in the block, by opacity only, so nothing shifts and screen readers still reach them.

**Decisions:**
- **Specs.** The gutter and query/embed specs no longer compare page mode's pixels with block mode's, because the layouts now differ on purpose. They assert page mode's own geometry: the grip in the frame, 2 px from the chevron, centred on the first line.
- **Reduced motion.** The review caught that the chip fade's unlayered `transition-opacity` outranked the app's reduced-motion reset. The reveal is now instant, like `COLLAPSE_TOGGLE_HIDDEN_AT_REST`.
- **The journal keeps the footer hint.** Only the Daily view uses page mode, so the hint shows once per screen.

**Traps:**
- **Merge order.** The toolbar merged first, so this branch was rebased onto it, with the toolbar moved inside the frame as the frame's first child.
- **Stale preview server.** A `vite preview` left on the review's Playwright port kept serving a three-hour-old bundle. The first post-rebase run therefore tested the pre-rebase code: the toolbar spec failed with "not found", and the page-mode specs passed without testing anything new. Killing the server and re-running gave the real result.

**Suites, after the rebase:**
- vitest `src/editor/page-mode` (785 tests), typecheck and lint;
- Playwright: `page-mode-look`, `-gutter`, `-toolbar` and `journal-page-mode` (16), plus `page-mode.spec` (41).
- Before the rebase, the review ran the wider vitest set (6,562 tests), the manual hooks, and the block-mode chip specs.
