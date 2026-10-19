# Session 2685 — The slow-test inventory of #5908, measured

Each nextest item was run alone before any change. Run alone, every one but
the #5712 proptest was under 10 s; the inventory's times came from CI
partitions running many tests at once.

- **`a_peer_converges_whatever_order_and_end_its_pulls_take_5712`** spent
  about three quarters of each case on setup (two vaults, three spaces, the
  pages, the first full pull). The setup is now built once, persisted with
  `save_all_engines`, and each case copies the two database files and
  rehydrates the registry the way boot does. Without the rehydrate the
  test's own assertions go red; with the sweep's two guards removed it still
  goes red. What remains is the cases, which the new comment says.
- **`a_snapshot_past_the_old_frame_cap_syncs_over_quic_5761`** (the former
  `issue611_…`), the op-cap journal test, the multi-chunk import test and the
  n-way proptest now say why their cost is the test.
- `find_lca_terminates_on_any_graph` already documents its case count.
- `reminder-due-task.e2e.ts` already says it waits one real scheduler tick.
  `agenda-projected-repeat.e2e.ts` was not run or profiled here (WDIO lane
  unavailable on this machine), so it stays open.
