# Session 2138 — "Sync now" fires while a peer is announcing

"Sync now" did nothing while another device was on the LAN. Found by the
two-device spec in #5589: in its failing CI run the click came at
19:49:38.5, and the app never dialled the peer in the 50 s after it.

The cause has two halves:

- `start_sync` only calls `notify_change()`, which Branch B of the
  daemon's `select!` debounces over 3 s.
  `SyncScheduler::wait_for_debounced_change` started a fresh 3 s `sleep`
  each time it was called, and the loop re-creates that future on every
  pass.
- `iroh-mdns-address-lookup` 0.6.0 reports every republish of a known
  peer as a new `Discovered` event. Its known-peer check compares a `Peer`
  that includes `last_seen`, so the check never matches. In CI these
  arrived about every 0.8 s, so Branch A won each pass, Branch B's window
  restarted each time and never closed.

The fix stamps the time of the last `notify_change()` on the scheduler,
and the debounce sleeps until that stamp plus the window. A re-created
future now finishes on time, and a change inside the window still extends
it. `wait_for_change_after` and `debounced_through` are unchanged.

Two paused-time tests in `sync_scheduler.rs`:

- `debounce_window_survives_a_sibling_arm_that_keeps_winning` runs the
  daemon's shape, a `select!` against an 800 ms sibling, and asserts the
  round fires at exactly 3 s. Restoring the old `sleep(window)` turns it
  red with `left: None, right: Some(3s)`.
- `a_change_inside_the_debounce_window_extends_it` asserts a second change
  at 1 s moves the round to exactly 4 s. Reading the deadline once before
  the loop turns it red with `left: 3s, right: 4s`; no existing test
  caught that.

Not fixed here: the upstream lookup still emits an event per republish.
With the window now surviving cancellation, the extra wakes no longer
starve a round. Outside a pairing window each costs Branch A two small
reads; inside one, each republish re-dials the peer, bounded by the
per-peer lock and backoff as before.

Ran: `cargo nextest run -p agaric-sync` (979 passed),
`cargo clippy -p agaric-sync --all-targets -- -D warnings`,
`cargo fmt --check -p agaric-sync`; workspace gates in the build lane.
