# Session 3886 — The view-crash test gets its axe audit

`main` went red at `lint` when two PRs merged a few minutes apart: #6577 widened the `axe-presence` guard from `src/components/__tests__/` to every component test directory, and #6579 added `src/components/pages/__tests__/ViewDispatcher.error-boundary.test.tsx` without an audit. Neither branch saw the other, so both were green.

The test file now audits the error panel a crashed view renders through the dispatcher. That is the one DOM this file owns; the views themselves are mocked.

Ran: the test file under vitest, `npm run typecheck`, and the `axe-presence` hook over the tree.
