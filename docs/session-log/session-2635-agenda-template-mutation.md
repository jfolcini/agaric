# Session 2635 — agenda-filters and template-utils join the weekly mutation run

#5915 asked for the modules the mutation sweep had deferred to be enrolled;
the maintainer added `agenda-filters` and `template-utils` to it.
`jaro-winkler` stays deferred.

- **Enrolled:** both in `stryker.modules.mjs` with `setup: true`, and their
  paragraph is gone from "Measured but deferred". Dropping `setup` for a
  file-local `invoke` mock saved nothing measurable, so they keep it.
- **Survivors:** new tests kill most of them, and each one left is recorded as
  equivalent in its test file's header. Among the new pins:
  - Agenda: load-more fetches whichever list still has pages; a list that
    claims more but gives no cursor counts as finished; a cursor without its
    prefix or with a wrong-typed field is refused; an undated task stays out
    of Overdue + Today; the exact tag name beats a longer prefix.
  - Templates: nesting three levels deep, the first `{{cursor}}`, 60-character
    previews, and the `<% today : FORMAT %>` variants.
- **Code deleted, not tested:**
  - `isValidCursorField`'s null check: only `encodeUnfilteredCursor` writes
    these cursors, and it never writes a null, so a cursor with one is now
    refused like any other malformed one.
  - `insertTemplateBlocks`' skip for an empty depth: a block's parent is always
    placed before it, so no depth between 0 and the deepest is empty.
- **Kept:** the frontend's sibling sort in `insertTemplateBlocks`. Both
  backends return rows in position order, but `load_page_subtree` documents
  that order as not load-bearing. A test feeds rows out of order instead.

Ran: `node scripts/run-mutation.mjs` on both modules after the review
(template-utils 91.84%, agenda-filters 95.92%; the timeouts are
`fetchFilteredBlocksWindow`'s loop), `vitest run` on both test files (151),
`npm run typecheck`, `npm run lint`, `node scripts/check-stryker-modules.mjs`.
The lane fits only if the dispatch #5915 calls for shows it under its 60-minute
timeout.
