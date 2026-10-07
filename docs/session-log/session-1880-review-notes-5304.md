# Session 1880 — review notes from #5304

This is the follow-up PR for the `/batch-issues` sweep that merged #5303 and
#5304. The reviewer left no notes on #5303. Both of its notes on #5304 hold:

- **Dead guards.** The `if (mountedRef.current)` guards around the
  fetched-set deletes in the two catch paths did nothing: after unmount the
  sets are garbage. The deletes now run unconditionally.
- **Stale comments.** The catch comment ("recover by reopening the dialog") and
  the cache-contract comment predate #5304, where a reopen became a fresh mount.
  They now say a released id is retried on the next `availableSpaces` change.

Behaviour while mounted is unchanged. `SpaceManageDialog.test.tsx` passes all
31 tests, including the B-7 unmount test, and oxlint is clean.
