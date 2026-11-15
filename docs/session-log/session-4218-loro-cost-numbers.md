# Session 4218 — Loro engine cost numbers, and a pulled vault beside an app-written one

`Refs #6563`: the Loro measurement is finished; the op-log diagnostics item still needs the numbers from the maintainer's own vault and the decision, so its box stays open.

#6776 had already landed `loro_snapshot_bench` and the bug-report breakdown, with no run behind either. This session ran the bench, recorded the numbers where the issue names them, and measured the engine as #6521 left it.

- `loro_snapshot_bench` prints each timing as median, lowest and highest sample and the count, instead of a mean, so a difference inside the range reads as none. `LORO_SNAPSHOT_MAX_BLOCKS` skips the larger scales for a short run. It also prints what a cold first sync leaves in `loro_doc_delta` and `loro_doc_state`.
- `pulled_vault_bench` is new, for #6811: the issue's vault (a 1,100-block page, about 3K blocks) written by commands on device A, A's space snapshot pulled into an empty second vault through `apply_remote`, and a split and a 300-line paste timed on both with the arms alternating. The page grows with every sample, so the figure that cancels it is the ratio of each pair.
- Numbers and both commands are in `docs/architecture/operations.md` § Loro engine cost. The "not yet measured" peak-memory sentence there is replaced.

Findings:

- A cold first sync of 100K blocks takes 30 to 33 s of the 120 s dispatch, and scales with the block count. The Loro import is about a second of it.
- A pulled vault holds the update in one `loro_doc_delta` row, larger than the snapshot (10.3 MB against 8.8 MB at 100K blocks), until a compaction folds it.
- In a release build, commands over a pulled vault are not slower than over the vault that wrote it (pulled over written 0.93 to 0.98). #6811's gap is not in an engine built from a peer's snapshot; the harness has no UI, IPC, paired peer, materializer or sync daemon, and its build is release where the issue's table is debug.

Traps:

- Another group's fixtures run whatever the name filter says, so `-- pulled_vault` alone also seeds the 100K Loro fixtures; the command sets `LORO_SNAPSHOT_MAX_BLOCKS=0`.
- A cold-synced vault has no `blocks.space_id` until the materializer stamps it, so the harness stamps it itself before running commands.
- `CARGO_PROFILE_BENCH_LTO=off CARGO_PROFILE_BENCH_CODEGEN_UNITS=16` makes the bench build finish in about 20 minutes cold; the shipped profile's thin LTO does not on a shared box.

Ran: the full `loro_snapshot` run (100K and 10K, about 19 minutes), `pulled_vault` twice, `engine_bench --test` as the weekly smoke lane runs it (343 s, exit 0), and workspace clippy over all targets.
