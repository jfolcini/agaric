# Session 4335: graph-view's Fit-to-view test seeds concurrently

`graph-view` is on `REAL_BACKEND_SPECS`. Its test "after the first settle every node is in view, and Fit to view returns there (reduced motion: reduce)" hit its 20 s timeout once on the bridge at three workers (#6939's checks). It takes about 13 s alone.

**Where the time went**, on the bridge, by phase:

| | seed (88 pages) | first node | animated settle |
|---|---|---|---|
| no-preference | 6.5 s | 0.2 s | 4.9 s |
| reduce | 6.4 s | 0.2 s | 0.2 s |

- The seed sent about 160 IPC calls one at a time, each a ~40 ms write round trip on the real backend. On the mock the same seed takes 0.09 s.
- The 4.9 s settle is d3's animated layout, about 300 ticks on its timer, the same on the mock. It is the behaviour this test checks, not a defect.
- So the reduce variant that timed out spent nearly all its time seeding, and parallel workers stretched that past the budget.

**Fix:** the seed creates the hubs' pages and the loose pages concurrently, and only the chain one at a time, since each link names the previous page. The bridge seed drops from 6.4 s to 1.2–1.3 s. No timeout changed.

**Ran:** under four workers with a CPU hog on every core, with each test repeated four times:
- reduce runs: 8.5–10.3 s before, 4.8–7.0 s after;
- no-preference runs: 12–15.5 s before and after, all of it the animated settle.

All of `graph-view` passes on the mock and the bridge (22 each), and lint, oxfmt and typecheck are clean.
