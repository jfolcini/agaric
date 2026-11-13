# Session 3994 — creating a page or picking a date no longer fetches every page

`Refs #6527` (item 1, step 1; the shared page-list query of step 2, the bench fixture and linear
page creation stay open).

Four call sites fetched `list_all_pages_in_space` on a gesture only to ask what a title would
open. A new read command, `resolve_page_title(title, scope)`, answers that with `SpacePageNames`,
the resolver `create_page_in_space` already uses: the page that holds the title, or the trimmed
title a new page would take, and for a blank title the first free `Untitled N`.

Decisions and traps:

- Not the MCP `resolve` matcher: it follows the `[[Name]]` rule and matches aliases, so an alias
  would open the aliased page where a create refuses it. A parity test pins the new command
  against the old "list all, then find" for case, NFD, padding, alias, trashed and other-space
  inputs.
- The date picker asks `get_journal_page_by_date` first and looks up the old `DD/MM/YYYY` title
  only when the day has no journal page.
- `TemplatesView` was filed in the issue as needing every page. It asks whether a title is taken,
  so it switched too.
- Existing tests stubbed or asserted the old listing call. Eight files had their stubs swapped,
  three assertions now name the command the issue asked for, and WelcomeModal's call count went
  from nine to ten: two title lookups replace one listing. No behavioural assertion changed.
- Each lookup still reads and folds every title in the space on the backend, because SQLite cannot
  apply the name rule. What is gone is the IPC payload and the main-thread parse. Not measured.
- Opening the New page dialog still lists every page once for its similar-pages list; that is a
  picker cache and belongs to step 2.
- The fixture authoring run writes U+0085 and combining accents raw; they are kept raw so the
  next run does not churn them.

Ran: the new and related Rust tests, clippy over the workspace, full vitest, typecheck, and about
three hundred related Playwright tests, with `e2e/perf.spec.ts` pinning that neither gesture sends
the listing. The whole Playwright lane is CI's run.
