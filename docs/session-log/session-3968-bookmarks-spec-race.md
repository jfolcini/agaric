# Session 3968 — the bookmarks sort spec waits for the re-sort

`e2e/bookmarked-pages.spec.ts` "bookmarking a second page respects the active sort within the
group" went red on PR CI and locally. Since #6640 a bookmark toggle updates a TanStack query, so
the Pages list re-sorts one task after the click instead of inside it. The spec clicked the second
star straight away: Playwright found the "Meetings" row before the re-sort, the list keeps each row
element at its position, and the click landed on the page that had moved into that row.

The spec now waits for the first bookmark to sort to the top before it looks for the second row.
Its final assertions are unchanged. With list re-renders delayed by 20 ms the old spec failed 6 of
10 runs and the new one passed 10 of 10.

Traps:

- `e2e/meeting-attachments.spec.ts` "dialog remembers the template" was red on this machine only.
  The main checkout's `node_modules`, which every seeded worktree links to, was a month behind
  `package-lock.json`; `@radix-ui/react-select` 2.3.8 clears a value set in the same render as its
  option, and the locked 2.4.1 does not. Compare installed versions with the lockfile before
  chasing a red that CI does not show.
- The Pages browser's virtual rows are keyed by position. A mouse cannot re-aim within one task,
  but keyboard focus stays on the position after a re-sort; that fix is its own change.

Ran: both specs with `--repeat-each=10` on a fresh `npm ci`, and `npm run typecheck:e2e`.
