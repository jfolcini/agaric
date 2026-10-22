# Session 2862 — the recent-page drag spec opens Projects through its bookmark

`e2e/page-link-drag.spec.ts` › "a recent page dragged onto a block links it" failed in CI on #6064 (run 39797568639, shard 3), both attempts. The failure was in its first step, `openPage(page, 'Projects')`, with "strict mode violation: getByText('Projects', { exact: true }) resolved to 2 elements": the sidebar bookmark and the Pages row.

**Cause.** The describe's `beforeEach` stars Projects, so a sidebar bookmark reads "Projects". `openPage` clicks the first page-wide text match after opening Pages. That makes the step depend on whether the bookmark is in the DOM by then. Locally the bookmark never produced the second match, even when the test waited for it, so the local runs passed; CI's page snapshot shows both.

**Fix: test only.** This test opens Projects through its bookmark, scoped to `sidebar-bookmarks`, and asserts the page title. That visit still puts Projects in the recent pages, which is what the test drags. `openPage` is left as is, because no other caller opens a bookmarked page by its title.

**Not shown red:** the CI race does not reproduce locally, as the waits above show, so no local command can make the old step fail.

**Suites run:** the whole spec twice in a row, with no retries: 8 passed.
