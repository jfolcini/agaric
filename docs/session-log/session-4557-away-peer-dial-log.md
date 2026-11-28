# Session 4557 — an away peer's dial timeout stops warning on every retry

A read of a desktop 0.27.0 install's logs (2026-11-15 to 2026-11-28) found `peer did not answer the dial within the connect budget` was nearly every WARN line: 7,928 of 7,945 from 2026-11-20 on, roughly 1,000 a day, all against the one paired phone while it slept. Backoff caps at 60 s (`MAX_BACKOFF`) plus the 10 s `CONNECT_TIMEOUT`, so an away peer is redialled about every 90 s for as long as it is away, and each redial warned. Sync itself was healthy: outbound and responder sessions completed whenever the phone was on the LAN.

**Fix**

The warning moves from `connect_to_peer` into `dial_timeout_report`, after the #6523 away classification (paired, not announced by mDNS, not pulling from us). An away peer's timeout logs at debug; every other timeout still warns on each attempt. The frontend already shows `PeerAway` as a state, so nothing user-facing changes.

**Test**

`a_dial_timeout_is_away_only_for_a_silent_peer_not_pulling_from_us_6523` now also counts the dial-timeout warnings each case logs: none for the away peer, two (one per cycle) for the announced, still-pulling and unpaired ones. Red before the fix on the away case (2 vs 0); with the fix in, demoting the remaining warning reddens the announced case (0 vs 2).

**Also in the logs, not changed here**

The `Sync already in progress for this peer` ERROR every 3 minutes (1,676 lines over 2026-11-20 to 11-27) is already INFO in 0.27.0. Four boot failures (`migration 122 was previously applied but is missing`) were a pre-0.17 AppImage left in `~/Applications`, a local install problem fixed on that machine.

**Ran**

`cargo nextest run -p agaric-sync` (whole crate), `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all -- --check`.
