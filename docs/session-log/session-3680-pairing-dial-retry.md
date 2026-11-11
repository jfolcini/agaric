# Session 3680 — the pairing window redials a peer that was not listening yet

#6451: on a first pair, the desktop (host) found the phone over mDNS and dialled it right away. The dial ran out its 10 s `CONNECT_TIMEOUT` while the phone's user was still typing the passphrase, and nothing dialled again inside the 5-minute window.

## The trace

- In a pairing window, an unpaired peer is dialled from two places only: Branch A, on an mDNS resolve (`process_discovery_event`), and Branch B, on a local change wake (`peers_for_change_round`). Branch C, the 30 s resync tick, enumerated paired peers only (`peers_due_for_resync(&refs)`).
- So once the first dial timed out, the peer was redialled only if it re-announced or this device made a local change. The phone confirming wakes only the phone's own daemon, and that daemon can dial the desktop only if it found the desktop itself.
- The stale `sync.pending_pairing` marker: `start_if_peers_exist_with_lifecycle` already clears it at startup, and 0.23.0 ships that. A daemon going active seconds after boot is the host's own `start_pairing` arming the marker. No change.

## The change

`run_resync_round` (Branch C) redials the window's unpaired candidates (discovered peers and the scanned host) after the paired round while `is_pending_pairing` holds. A cancel in the paired round skips the tail. The scheduler's per-peer backoff paces the retries, and ordinary sync keeps its 10 s budget. The reporter's workaround, raising the timeouts to 120 s, was rejected: a dead address would then cost 120 s per round.

The cost: a peer that comes up after a failed dial waits for the next tick, up to 30 s plus backoff.

## Tests

- **`the_resync_round_redials_a_pairing_peer_that_was_not_listening_yet_6451`** (`sync_daemon/tests.rs`): the host's round dials a discovered unpaired peer at an address nothing holds yet, and the dial times out. Then a responder comes up at that address and key, and the next round pairs the two: the host's `peer_refs` row is pinned to the joiner's key. Red on main at the first assertion, because the round never dials an unpaired peer.
- `ServiceHarness::at` (test support) binds the service at a chosen address and key.
- No e2e-tauri spec: that lane pairs through the QR, with the peer dialling the app, because a CI runner cannot rely on mDNS. The failure needs the app to find the joiner over mDNS and dial it.
