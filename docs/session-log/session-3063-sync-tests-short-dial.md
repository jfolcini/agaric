# Session 3063 — sync tests stop burning the real dial budget and pairing's QR wait

A CI-log survey (2026-10-28) ranked `agaric-sync`'s daemon tests among the slowest in nextest, with two FLAKY events. Re-measured before building: every test that dials a peer nobody answers spent the full 10 s `CONNECT_TIMEOUT`. QUIC runs over UDP, so a dead peer sends nothing back and the dial can only time out. The branch tests then had 15 s to see the failure, so a loaded runner had 5 s of slack.

**Changed:**
- `SyncScheduler` carries the dial budget as `connect_timeout`, defaulting to `CONNECT_TIMEOUT`. `connect_to_peer` reads it from there. The scheduler already holds the daemon's other timing knobs (`debounce_window`, `resync_interval`), and every test hands it to both `try_sync_with_peer` and `SyncDaemon::start`. A `#[cfg(test)]` `with_connect_timeout` sets it.
- These tests now use a 200 ms budget (`UNANSWERED_DIAL_BUDGET`):
  - the five daemon branch-B/C dial tests;
  - `try_sync_with_peer_emits_error_event_on_connection_failure`;
  - the #4120 wiring test.
- The cancel-during-dial tests (#5739) keep the full budget, because their cancel has to land mid-dial.
- The #4120 and #4203 wiring tests waited out a real ~2 s backoff per arm. They now expire it with a `#[cfg(test)]` `expire_backoff`, after asserting the gate was armed.
- `start_pairing_armed` waits up to 5 s for a bound endpoint to put in the QR. The pairing tests run no daemon and never read the QR, so each of them paid the full 5 s. They now publish an endpoint first, as a running daemon does. `start_pairing_armed_degrades_when_no_endpoint_is_published` still waits, because the wait is what it tests.

**Measured** (`cargo nextest run -p agaric-sync --retries 0`, same 4-core box, before and after):
- The whole crate went from 118.8 s to 68.9 s wall.
- Tests at 2 s or more summed 260 s before and 106 s after.

| Test | Before | After |
| --- | --- | --- |
| The five daemon branch tests | 13.3 s each | 3.5 s each |
| #4120 wiring | 25.0 s | 1.2 s |
| `emits_error_event` | 10.2 s | 0.4 s |
| #4203 wiring | 6.7 s | 0.55 s |
| The seven two-device pairing tests | 5.5 s each | 0.4–0.5 s |

The branch tests' remaining 3 s is iroh's `Endpoint::close` on daemon shutdown after a dial was abandoned. That is production shutdown behaviour and was left alone.

**Not done:** `feat6_end_to_end_compact_then_snapshot_catchup` and `empty_responder_reset_is_progress_and_stamps_synced_at_4960` still take about 5.5 s each, from a different wait.

**Suites:**
- `cargo nextest run -p agaric-sync` (1030 passed);
- `cargo clippy --workspace --all-targets -- -D warnings`.
