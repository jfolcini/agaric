# Session 1882 — a taken alias is reported, not silently dropped (#5280)

This is the third `/batch-issues` batch of the session that logged 1877, 1879
and 1880.

## Board

- #5305 merged once `validate-all` and `dco` passed and the reviewer had
  approved.
- Its one note is held for the next follow-up PR: the journal-template catch
  comment in `SpaceManageDialog` still says "the next render can retry".
- Another session holds #5276, #5279, #5281, #5282, #5285, #5293 and #5302
  (draft #5306).
- #5280 was unclaimed.

## #5280

**The bug.** `page_aliases` has one `alias COLLATE NOCASE` unique index across
the vault, and `set_page_aliases` writes with `INSERT OR IGNORE`, returning only
what it stored. `usePageAliases.handleAddAlias` had three faults:

- it announced "Alias added" before the write;
- it ignored the returned list;
- it refetched only when `pageId` changed.

So an alias held by another page (in this space, another space, or the Trash)
showed as added and vanished on the next visit.

**The fix.** On success, `handleAddAlias` now adopts the returned list, unless
a later edit superseded it.

- **Alias missing from the list.** It shows "That alias is already used by
  another page, which may be in another space or in the Trash", and keeps the
  draft so the user can change it.
- **Comparison.** The check is case-insensitive, because a case variant of the
  page's own alias is skipped by the same NOCASE index and is not taken by
  anyone else.
- **Announcement.** "Alias added" is announced only after a write that stored
  the alias.
- **Not done.** Per-space, per-live-page uniqueness is left to the maintainer,
  as the issue says. It needs a migration of `idx_page_aliases_alias`.
- **The mock.** It already mirrors the backend's `INSERT OR IGNORE`, so it
  needed no change.

## Verified

- `usePageAliases.test.ts`: 14 tests pass. The default `setPageAliases` mock
  now echoes the list it was given. Three mutations were run against a copy,
  then restored:
  - Dropping the taken check turns the taken-alias test red.
  - A case-sensitive compare turns the case-variant test red.
  - Not adopting the returned list turns both tests red.
- **Neighbouring suites.** PageHeader, PageHeaderMenu, the i18n catalog-parity
  and locale tests all pass: 8 files, 524 tests.
- `npm run typecheck` passes.
- **Playwright.** The four specs that touch aliases pass on a fresh
  `build:e2e`: `page-source-edit`, `pages-view`, `rename-invalidation` and
  `search-results`, with 71 passed and 1 already skipped.
