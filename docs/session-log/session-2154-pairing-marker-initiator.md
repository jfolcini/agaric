# Session 2154 — the dialing side of a first pair closes its pairing window

The real-backend lane found this on #5609's first run.

**Symptom.** Unpairing a device within five minutes of pairing it did not stick.
- The app re-dialed the unpaired device on its next mDNS announcement.
- That session re-created the device's row, and its syncs were admitted again.
- The device list still showed no peers.

**Cause.** Opening the pairing dialog arms a pending-pairing marker, with a 5-minute TTL. While the marker is armed:
- `should_attempt_sync_with_discovered_peer` dials every discovered device;
- the S-1 gate in `admit_peer` admits an unknown device and binds it.

Only the responder ever cleared the marker, in `bind_peer_to_key` after a successful bind. A first pair can complete with either side dialing first, depending on an mDNS race. When the host dialed first, it bound the joiner in `record_session_success` and never cleared its marker. #5604's unpair case passed or failed on that race.

**Fix.**
- `record_session_success` now clears the marker when its own session binds a previously unpinned peer. This mirrors the responder: best-effort, with a warning on failure.
- A routine session with an already-bound peer binds nothing, so it leaves a window opened for another device alone.
- The joiner's marker clears the same way when it dials first. Once its bind is done, it needs no window. The host's later dials are admitted by key, and leaving the marker armed would give the joiner the same five minutes of dialing and admitting strangers.
- Two doc comments that claimed this already happened (`should_attempt_sync_with_discovered_peer`, `start_pairing_armed`) now say where it happens.

**Tests** (`sync_daemon/tests.rs`):
- `a_host_that_dials_the_first_pair_closes_its_pairing_window` runs the real pairing commands, the production discovery decision, and `try_sync_with_peer` against `handle_incoming_sync`. It then asserts:
  - the host's marker is cleared;
  - after the user unpairs the joiner, the joiner's next announcement is not dialed;
  - a stranger offering a valid proof is refused as `Unpaired`.
- `a_routine_sync_with_a_bound_peer_leaves_the_pairing_window_open` checks the other half of the condition.
- `two_devices_pair_bind_each_other_and_converge_3507`, where the joiner dials, now also asserts that the joiner's marker clears.

Falsified on copies:
- Removing the clear fails the host test on the marker assertion and the #3507 test on its new assertion.
- Clearing on every success instead fails the routine-sync test.

Left alone: `clear_scanned_peer` still runs only in `cancel_pairing`, as it did for the responder, so a scanned QR candidate is kept in memory after a bind.

Ran:
- `cargo nextest run --workspace -E 'package(agaric-sync)'`;
- `cargo clippy --workspace --all-targets -- -D warnings`;
- `cargo fmt --check`.
