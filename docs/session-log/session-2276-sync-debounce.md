# Session 2276 — A manual Sync starts its session at once

**Problem.** Pressing Sync waited about 3 s before any session started.
`start_sync` answered "complete" at once, but the real session began 3 s later.
In real-backend run 38925731657, every click took about 3.07 s to reach
`try_sync_with_peer` for a session of about 0.25 s. The real-lane sync specs
waited on it too.

**Cause.** The path is sidebar Sync → `syncAll` → `start_sync` per peer →
`start_sync_inner` → `notify_change()` → the daemon's
`wait_for_debounced_change`, which waits out `DEFAULT_DEBOUNCE`. The debounce
only coalesces bursts. Its only production callers are `start_sync_inner` and
the two pairing commands; no local edit or materializer path calls
`notify_change`. Bursts are the per-peer calls a few milliseconds apart, and
a round already dials every peer at once (`run_change_round`).

**Fix.** `DEFAULT_DEBOUNCE` is 250 ms, and so is the copy in `e2e_sync_peer`.
Every stale claim of a 3 s window or of "a sync after each local edit burst"
is corrected: the protocol comments, the daemon docs,
`sync-and-network.md` (which now names the constant instead of a figure)
and three frontend comments. `sync-refresh.e2e.ts` polls every second instead
of every 3 and 5 s, with its timeouts unchanged.

**Test.** `sync_now_opens_one_prompt_round_per_burst`, on a paused clock,
checks that one `notify_change` opens a round within 500 ms and that five
calls 5 ms apart make exactly one round. It was red on 3 s ("opened its round
after 3s"). With a 1 ms window, the burst half went red at 6 rounds against 2.

Gates: targeted nextest (scheduler, supervisor, daemon, pairing, sync
commands) 380 passed; full workspace suite 3494 + 3486; clippy;
`SQLX_OFFLINE=true cargo check`; fmt; `npm run typecheck`.
