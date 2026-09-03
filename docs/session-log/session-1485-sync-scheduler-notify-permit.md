# Session 1485 — The debounce that swallowed its wake (#4025)

`SyncScheduler::wait_for_debounced_change` is one arm of `daemon_loop`'s `select!`. It consumed the `Notify` permit up front and then waited out its debounce window, so whenever a sibling arm won the select during that window the future was dropped and the permit went with it. At daemon startup a sibling always wins: Branch C's resync interval fires its first tick immediately. A local change signalled in that startup window, which is exactly when `start_pairing_armed_inner` signals one, never produced a sync round, and the pairing dialog never dialled.

The fix replaces the permit with a `watch` counter and a high-water mark of the count the last completed window ran to. Cancelling the future no longer loses anything: the count outlives it, so the next call sees the same change still owed a round. A `select!` arm is now safe to drop at any point, which is the property the daemon loop always assumed.

The unit test signals a change, cancels the debounce from a sibling `select!` arm, and asserts the next wait still completes. It goes red against a copy of the file with the consumption moved back in front of the window (the old permit semantics) and green with the fix. The three workarounds the issue named are gone: the fixed 300 ms startup sleeps in the two Branch B daemon tests, and `wait_for_change_round` with its `CHANGE_WAKE_NUDGE` re-arm. The Branch B tests now stamp their peers as freshly synced so Branch C's round cannot claim the dial, which is the attribution the sleep used to buy by timing.

Verified: the five `daemon_branch_b` and `4025` tests pass, the whole `agaric-sync` package and the `sync_daemon` module pass on two consecutive runs.
