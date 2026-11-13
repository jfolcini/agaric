# Session 4031 — a local edit starts a sync, and a press on Sync clears backoff

Continued from handover #6667, on a parked `wip:` commit that held the
production code and no tests for it.

## What shipped

- **#6551, last box.** A local command that commits ops asks the sync scheduler
  for a round (`CommandTx::commit_and_dispatch` runs the materializer's
  `on_local_commit` hook; `lib.rs` points it at `SyncScheduler::notify_local_edit`),
  debounced by `LOCAL_EDIT_DEBOUNCE`. A session is a pull, so that round only
  shows the peer this device's version vectors. The responder that served a
  peer holding ops it lacks (`SyncOrchestrator::peer_holds_news`) calls
  `notify_change` after the session and pulls back. No wire change.
- **#6523, the press decision.** `start_sync` takes `user_initiated`. A press
  clears that peer's backoff and dials; a scheduled call for a peer in backoff
  resolves with state `backoff` and dials nothing. The failure toast's Retry is
  a press too, which the parked diff had left scheduled.
- Two review notes from #6657: the "could not start" sentence only suggests the
  version check, and the comment on the responder's `Failed` exit covers both
  ways a session ends there.

## Why two devices cannot ping-pong

A served session asks for a round only when the device that dialled is ahead.
After A pulls from B, A holds everything B does, so when B pulls back A sees
nothing new and the exchange ends after two sessions. The cases where a pull
does not close the gap (a refused export, an update parked on a missing
dependency) are bounded by `peer_refs.loro_vv_bytes`: the responder pulls back
only for a space whose advertisement has moved since that peer's last completed
session. The placement and repairs that follow an inbound session run inside
`db::following_a_sync`, so their commits ask for no round.

## Tests, each shown red by one mutation

- `peer_advertises_news_*` (sync_protocol): ahead, level, behind, unknown space,
  already-shown advertisement, undecodable vector.
- `a_burst_of_local_edits_is_one_round_after_the_last_6551`,
  `a_local_edit_does_not_hold_back_a_round_asked_for_now_6551` (scheduler).
- `the_local_commit_hook_runs_for_a_commit_that_wrote_ops_6551` (CommandTx) and
  `the_placement_after_a_session_asks_for_no_sync_round_6551` (its call site).
- `an_edit_costs_one_pull_back_and_a_converged_pair_none_6551`: exact counts over
  real loopback sessions, three idle resyncs before and after the edit.
- `a_gap_no_pull_can_close_is_pulled_for_once_6551`: the refused-export gap.
- `a_local_edit_reaches_the_other_running_device_6551`: two running daemons,
  dialling each other by cached address, no other trigger.
- vitest for the press and tick arguments and the `backoff` answer.
- `e2e-tauri/sync-two-device.e2e.ts` gains a case with no Sync press. It could
  not run here (no WebKit driver); the PR's real-backend lane is its first run.

## Traps

- The sync peer of the real-backend lane now pulls back by itself after serving
  the app. Its `sync` command waits out a session already running before it
  reads its baseline, or a pull that began before the app's write could answer
  it. The peer does not register the local-commit hook, so its own writes still
  reach the app only when the app dials.
- `cargo test` runs the daemon tests in one process, where two of them raced on
  the shared migrated-template database ("disk I/O error"). They pass under
  nextest and one at a time; it is not this change.
- A pull-back that finds the first device still holding its per-peer lock is
  refused as `Busy`, which books a backoff quietly. The two-daemon test did not
  hit it; if it shows up in the field the edit arrives with the periodic pull.

## Suites run

Listed in the PR body.
