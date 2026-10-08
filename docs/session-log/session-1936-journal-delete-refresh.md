# Session 1936 — Delete page empties the journal day right away (#5358)

The user deleted today's journal page from the daily view; the database
soft-deleted the page and its blocks, but the day kept showing them. Week and
stream views had the same bug.

Two causes, either one enough to break the empty state:

- `useJournalBlockCreation` keeps a `createdPages` map (date → page id) of
  pages made this session, and every view resolves a day as
  `createdPages.get(date) ?? pageMap.get(date)`. Nothing pruned it, so after
  a delete the stale entry won over the refetched page map.
- `useJournalAutoCreate` re-ran whenever the page map changed, so deleting a
  page that predated the session made it create a fresh one at once.

What shipped:

- `forgetCreatedPage(date)` drops the entry; `DaySection` calls it through the
  delete flow's existing `onDeleted`, wired through daily, weekly and stream.
- The arrival auto-create runs on arrival only (`loading`, `mode`, date,
  space), reading page state through `useEffectEvent`, and re-checks
  `createdPages` when its lookup returns so "Add your first block" during the
  lookup still can't add a stray block.
- Review found a regression the fix made reachable: after deleting an
  auto-created day, the `n`/Enter create shortcut stayed dead for the session,
  because the date was still claimed by the double-create guard. The auto-create
  hook now returns a release for the claim, called with `forgetCreatedPage`.
- Tests: an integration suite with the real `BlockTree` and the tauri-mock
  handlers (pre-existing page, and session-created pages in daily, weekly and
  stream, plus the shortcut after delete), each re-querying the DOM and the
  mock backend; a hook test for the pending-lookup re-check; and a real-backend
  spec, `e2e-tauri/journal-delete-page.e2e.ts`.

Verified: each piece of the fix removed on a copy turned its tests red, and
the fix restored made them green (builder and reviewer, `cmp`-checked);
targeted suites 472 passed; `npm run typecheck`, `typecheck:e2e-tauri` exit
0; `npx vitest run e2e-tauri` 40 passed. Full `npx vitest run`: 20,751
passed; the only failures were two boot tests that cannot resolve
`@fontsource-variable/inter` because the main checkout's `node_modules`
predates that dependency, unrelated to this change.
