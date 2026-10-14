# Session 2062 — date-utils: pin the journal-page glob

#3752 carried one Stryker survivor, a StringLiteral at `date-utils.ts:276:34`
on the run's commit. The line has moved since #5474, which is why the issue's
anchor no longer points at it: the literal is `JOURNAL_PAGE_GLOB`, the
`PathGlob` pattern the Pages "exclude journal pages" filter sends to the
backend. Its only consumers import the constant and compare it with itself, so
emptying it failed no test.

The new test reads the glob as a regex (it uses only `[0-9]` and `-`, which
mean the same in both) and asserts it accepts exactly the titles
`isDateFormattedPage` accepts, over valid dates, a non-date, too-short and
too-long dates, and the empty string.

The issue is the mutation filer's: it closes itself once the next weekly run
finds nothing, so the PR says `Refs`.

Suites run: `date-utils.test.ts` with the `''` mutant shown red on the new
assertion, plus seven hand mutations of the glob (a digit class dropped or
added per group, the separators swapped, a leading `*`), all killed;
`npm run typecheck`; `npm run lint`.
