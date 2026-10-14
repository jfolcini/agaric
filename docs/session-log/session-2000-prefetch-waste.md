# Session 2000 — Pages and journal stream prefetch waste

Set out to remove the three wasted fetches in #5446.

Shipped: the Pages list prefetches its visible rows only on touch, through
the existing `useIsTouch`, so on a mouse device a hover right after opening
gets a prefetch slot instead of finding the cap full. The journal stream's
"load older" fetches only the newly revealed days and merges them; the first
fetch, a space switch and a calendar invalidation still fetch the whole
window.

Not done: the serial refetch of every loaded page on Pages reopen. Each fix
the issue suggests breaks something: refetching only page 1 caps scroll
restoration at its height, parallel refetch with cached cursors can gap or
duplicate rows after an edit, and keeping the cached rest shows a moved page
twice. That needs the maintainer's call, left as a comment on the issue.

Counts in the PR come from the vitest tests with mocked IPC, not a Playwright
run. Suites run: full vitest, typecheck, lint.
