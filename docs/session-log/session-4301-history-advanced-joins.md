# Session 4301 — history-advanced joins the real-backend project

The follow-up #6917 left open (#6529, stage 2). `history-advanced` stayed off `REAL_BACKEND_SPECS` because its compaction test needs ops older than 90 days. Only the mock's seed holds such ops; a command stamps every op with now. The maintainer decided on 2026-11-18 that a test whose precondition only the mock's seed can produce may be tagged `@mock-only`.

- The compaction test is tagged `@mock-only`, with the reason beside it.
- `history-advanced.spec.ts` joins `REAL_BACKEND_SPECS`.
- `e2e/AGENTS.md` § "The real backend, through the bridge" states both reasons a test may be tagged `@mock-only`: it drives a mock hook, or its precondition only the mock's seed can produce.
- From #6917's review: `history-keyboard`'s history probe now passes the History view's own page size (`PAGINATION_LIMIT`), not a literal 50, so End's target cannot drift from the view's first page.

Ran: `history-advanced` on a locally built `bridge` (4 passed; the tagged test is filtered out) and on the mock (5 passed); with `history-keyboard`, 6 on the bridge and 7 on the mock.
