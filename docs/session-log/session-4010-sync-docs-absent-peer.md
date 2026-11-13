# Session 4010 — the docs and the relay setting say what the daemon dials for an absent peer

`Refs #6564`: the copy now matches the code, but the two-network hardware run in #6519 has not
happened, so whether such a dial completes a session stays open.

What the code does, traced and pinned: `run_resync_round` resolves each due paired peer through
`resolve_peer_address`, which falls back to `build_fallback_peer` (the `peer_refs` key and stale
`last_address`) when mDNS does not see it; `try_sync_with_peer` dials `dial_addr`, which adds
`ctx.relay_url` whenever the internet fallback is on, whichever source resolved the peer. The new
daemon test `absent_paired_peer_is_dialled_through_the_relay_only_when_the_fallback_is_on` pins
both arms. `dial_addr` became `pub(super)` so the test can reach it.

Copy corrected: `docs/features/sync.md` (the fallback paragraph and the same-network pitfall no
longer say the relay only carries traffic for mDNS-discovered devices), `docs/architecture/sync-and-network.md`
(cached-address fallback and the Endpoint bullet), `docs/FEATURE-MAP.md`, the
`InternetRelaySetting` doc comment, and `device.internetRelayDescription`, which now says the
setting is opt-in, whose server it is (n0, iroh's makers) and that an away paired device is dialled
through it. The docs say the cross-network case is untried rather than claiming it works.

Trap: `cargo-nextest` would not install in this cloud session, so the test ran under
`cargo test -p agaric-sync --lib`; it reads no process-global counter.

Ran: the new test green, then red under each mutation (relay dropped from `dial_addr`; relay always
added); `cargo clippy --workspace --all-targets -- -D warnings`; vitest on the two relay-setting
suites; `npm run typecheck`; oxlint; `prek run --all-files`.
