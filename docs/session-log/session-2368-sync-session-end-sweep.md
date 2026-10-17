# Session 2368 — A sync session holds its deletions until every space has landed

#5712's remaining loss, after #5720: when a pull imported the old space's
doc before the new one, Pass D deleted the moved blocks' rows. The new doc's
import recreated the blocks, but rows no Loro doc carries were gone:
- the peer's drafts and "last opened" entries;
- backlinks, reference-type property values, tags, inherited tags, tag refs
  and page-link cache rows on other blocks pointing at the moved ones.

The maintainer chose the session-end sweep over a move-out marker. It needs
no engine format change, and it approved the one new device-local table.

**Change.**
- Migration 0126 adds `sync_deferred_purges` (STRICT,
  `ON DELETE CASCADE` to `blocks`).
- Pass D records the ids no engine holds, in its own transaction, and
  deletes nothing.
- `sweep_deferred_purges_if_last` runs where a pull completes
  (`complete_pull_session`) and after a snapshot catch-up. It purges the ids
  no engine holds by then, clears the table and fans the purged ids out. It
  reads the table before taking the write lock, so most pulls never take it.
- The import no longer returns a purged list, since it never purges now.

**Where the design was incomplete.**
- **The #5670 boot repair can meet a deferred row.** Boot replays the sync
  inbox before the repair, and a failed repair runs again next boot. It now
  skips deferred ids, so a moved or purged block isn't hydrated back into
  its old space.
- **The snapshot catch-up** imports every space too, so it sweeps at its end.
- **Concurrent pulls** from different peers share the table, so one
  session's end could sweep ids another session deferred before its new doc
  landed. Review closed it. A session that imports takes a claim on the
  engine registry's in-flight inbound syncs before its first import (a
  catch-up inherits the claim of the session that fell back to it), and
  leaves in the sweep, holding the write lock, which a deferral needs. Only
  the last session to leave sweeps, the ids of earlier and failed sessions
  included. Boot replay records deferrals before the daemon starts and never
  sweeps.
- **The e2e spec.** A ref-only property has no inline chip, and backlinks
  show only within one space. So the spec reads the ref in the property
  drawer, and each page ends in its referrer's space.

**Tests,** each shown red under one of eleven mutations:
- unit tests for Pass D, the sweep, an empty sweep, the cascade, the
  crashed-slot tombstone, the pull hook and the catch-up;
- the repair skip and the migration;
- the integration test across all eleven tables in both orders: there and
  back, an interrupted session, move then purge, a real purge, and a session
  without the new doc (which pins the gap);
- a 64-case proptest over shuffled, cut and crashed delivery rounds, with a
  mid-run invariant and final equality with A (about 21 s, in the
  slow-test override);
- `crossing_moves_reach_the_peer_whole_over_quic_5712`, red in 4 of 4 runs
  across both HashMap orders;
- `e2e-tauri/sync-cross-space-move.e2e.ts`, run on the real lane and red at
  the predicted point;
- overlapping sessions, each red without its part of the claim: a pull that
  ends while another still imports (`a_pull_ending_while_another_still_imports…`),
  the same for a catch-up, the catch-up taking over the claim of the session
  that fell back to it (the daemon's `run_snapshot_catchup` hands it over),
  the last session sweeping the earlier ones' ids, and a session that starts
  while the sweep waits for the write lock.

**Bench.** `sync_import_bench` covers the design's four cases at 100K blocks
over 3 spaces. It passes in criterion's test mode. Its numbers come from a
release run, which the scheduled lanes do not give it. `interactive_slo`
carries two measurement-only probes, `sweep_deferred_purges` with nothing
deferred and with 10K unheld ids at 100K blocks, which the weekly `bench-slo`
lane measures.

Gates:
- `cargo check` and clippy;
- targeted nextest;
- the full workspace, in two partitions;
- fmt;
- e2e-tauri typecheck and vitest (46);
- `just gen-sqlx`.
