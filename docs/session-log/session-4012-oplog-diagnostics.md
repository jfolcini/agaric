# Session 4012 — op-log bytes in the bug report, and a Loro snapshot-cost bench

`Refs #6563` (both items; their numbers and decisions are the maintainer's).

- The bug report's metadata gains an optional `op_log`: rows and UTF-8 payload bytes per
  `op_type` from one `GROUP BY`, and the pages the `op_log` table and its indexes occupy, read
  from SQLite's `dbstat` in aggregate mode. The issue body shows it as one Environment line,
  largest payload first. A failed read leaves it out instead of failing the report.
- `loro_snapshot_bench` joins `engine_bench`: one space of 10K or 100K blocks, with no edits or
  ten rounds of one edit to every block. It prints snapshot bytes and the heap a rehydrated
  engine keeps, and times export, rehydrate, a cold first sync through `apply_remote`
  (printed against `HANDSHAKE_TIMEOUT`), and the attachment scan over 10K files.

Decisions and traps:

- The field is optional (`#[specta(optional)]`, as `ReconciliationReport.samples` is), so the
  existing frontend fixtures that build a `BugReport` still type-check, and the mock leaves it
  out: it has no SQLite file to measure. The command stays waived from conformance as host
  metadata.
- Payload bytes are `length(CAST(payload AS BLOB))`; `length(payload)` counts characters.
- The bench reuses `loro_wire_bench`'s counting allocator, the binary's one global allocator.
- A cold first sync leaves `blocks.space_id` empty, since the materializer fills it later, so the
  bench's probe counts every block in the fresh vault rather than the space's.
- In `rehydrate_bench`'s fixture `ids[n / 2]` is a page; the new probe reads `n / 2 + 1`.

Ran: workspace nextest in two partitions, clippy over the workspace with all targets, the
offline sqlx check, the full vitest, and typecheck. The new bench ran in `--test` mode at 1K
blocks through a throwaway dev-profile target; the release bench was not built here
(`src-tauri/benches/AGENTS.md`), so the 10K and 100K numbers are left to the weekly lane.
