# Session 4034 — creating a page or picking a date no longer fetches every page

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
  from nine to ten: two title lookups replace one listing. The frontend tests that pinned the fold
  (another spelling, `Untitled N` numbering) now pin that the backend's answer is used as given;
  the fold itself is pinned by the Rust tests and the fixture. Review deleted the one that became
  a copy of its neighbour.
- `src/lib/untitled-page.ts` is gone: after the switch only the mock called it, so the mock numbers
  `Untitled N` inline, pinned by the fixture.
- Where the frontend's own find disagreed with the create, the create's rule now wins: a title
  padded with U+0085 is trimmed, a title two old pages share in spellings `NOCASE` sorts apart
  (padding, non-ASCII case, NFD) opens the smaller id, and a day that has both an ISO and a
  `DD/MM/YYYY` page links the ISO one. The old find took whichever sorted first.
- Each lookup still reads and folds every title in the space on the backend, because SQLite cannot
  apply the name rule. What is gone is the IPC payload and the main-thread parse. Not measured.
- Opening the New page dialog still lists every page once for its similar-pages list; that is a
  picker cache and belongs to step 2.
- The fixture authoring run writes U+0085 and combining accents raw; they are kept raw so the
  next run does not churn them.

Review (cloud continuation): every edited test was judged. The stubs swap the listing for the
command the issue asked for and keep their behaviour assertions, and the removed frontend cases
live on as the Rust table cases and the fixture. The perf pin's soft assertion became a hard one.

Ran: the full nextest workspace suite, doc-tests, clippy over the workspace, the related vitest
suites, typecheck, lint, the manual-stage hooks, and the perf, templates, date-picker and page-name
Playwright specs. The perf pin went red with a listing put back in the date picker, and the
`Untitled N` table went red with the numbering started at 2. The whole Playwright lane and the
WebdriverIO lane are CI's run.
