# Session 2145 — the two-device spec covers properties, moves and a re-minted passphrase

#5365's sync section, on the harness from #5589. Two of its boxes were
half covered; this fills the rest of both.

The headless peer (`e2e_sync_peer`) gains three commands, each through the
app's own command functions rather than SQL: `set_property`
(`set_property_inner`), `move_block` (`move_block_inner`) and
`get_property` (`get_property_inner`), each with a parse test.

`sync-two-device.e2e.ts` now runs three cases in one vault:

1. **Cancel and reopen.** Open pairing, read the passphrase, cancel
   through the guard, reopen: the new passphrase differs, and the redrawn
   QR carries the one on screen.
2. **Pair and one edit each way**, as before.
3. **A property and a move each way.** The app nests the peer's block with
   Tab and sets a custom property by typing `wdiosync:: value`; after a
   round trip and the peer's pull, the peer reads the new parent and the
   value. The peer then sets the property on the app's block and moves its
   own block to the top; after "Sync now" and the app's pull, the outline
   and the chip show both.

Each assertion is a re-queried state on the side that did not write.

Known residual: the app also resyncs on its own every 60 s, and if one of
those pulls lands while the peer is writing, `wait_pulled` can return
before the app has the write. The window is sub-second against a 60 s
cadence; `WaitPulled`'s doc says so.

Ran: `cargo nextest run -p agaric-diagnostics` (36),
`cargo clippy -p agaric-diagnostics --all-targets -- -D warnings`,
`cargo fmt --check`, `npx vitest run e2e-tauri/sync-peer.test.ts`,
`npm run typecheck` and `typecheck:e2e-tauri`, `oxlint`, `oxfmt`; the
real-backend lane runs on the PR.
