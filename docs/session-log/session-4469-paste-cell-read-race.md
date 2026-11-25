# Session 4469 — the #6033 paste spec waits for the save it reads

Main's bridge lane went red on f78c210 at `e2e/paste-one-line-names-6033.spec.ts` › "a line pasted into a table cell stays inline". The stored content was still `| one | two |`.

**Cause.** CI's failure snapshot shows the reopened page rendering the cell as "one see [[Fresh page]]". The paste had landed, and the save on leaving the page reached the database after the test's single `storedContent` read. The wait before leaving was `table` count 1, which the seed already satisfied, so it said nothing about the paste.

**Fix.** Every `storedContent(GS1)` read in the spec after a reopen polls until it holds (`expect.poll`), as the spec's embed test already did. The table test also waits for the pasted text in the editor before it leaves. The same read shape was in all seven.

**Ran.**
- The spec on the bridge: 14 passed (7 tests, twice).
- The original test under four busy CPUs: 24 of 24 passed, so the race needs CI's load to show.
- Dropping the serializer's `[` escape fails the table test at its poll.
- `npm run typecheck:e2e`, oxlint and oxfmt.
