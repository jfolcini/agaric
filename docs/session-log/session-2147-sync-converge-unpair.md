# Session 2147 — two-device sync: concurrent edits and unpair

Two more #5365 sync scenarios on the headless-peer harness.
`e2e-tauri/sync-two-device.e2e.ts` now runs five cases in one vault.

**Peer commands.** All three go through the app's own command functions:
- `edit_block` calls `edit_block_inner`.
- `list_peers` calls `list_peer_refs_inner`.
- `sync_refused` wakes the daemon and returns the first `SyncEvent::Error` message after the wake. The event sink that used to drop everything now keeps the error messages; `sync` is unchanged.

Each command has a parse test. Renaming its field or variant turns that test red.

**Concurrent edits converge.**
- `edit_block_inner` reaches Loro as a character splice between the common prefix and suffix (`LoroEngine::apply_edit_via_diff_splice`). So the peer prepends and the app appends to the same block, and the edits cannot overlap.
- The order is what makes the edits concurrent.
  - A session is a pull by the device that dials. The app dials on "Sync now", on the frontend's 60 s `useSyncTrigger` chain, and when its last pull is over 60 s old; a local save does not dial. So the app can pull at any moment.
  - That is why the app writes first: its editor closes before the peer writes, so no pull lands under an open editor. Such a pull would save the stale text over the peer's edit.
  - The peer dials only on `sync`, and, as the joiner, on an mDNS sighting during its 5-minute pairing window.
  - Right after the app's save, the spec checks that the peer's copy still lacks the app's edit. Then the peer prepends to it.
- If that check fails, the edits were not concurrent, and the test fails rather than passing on a sequential edit.
- Each side then pulls, and both read exactly `PEER_HEAD PEER_EDIT APP_TAIL`.

**Unpair.** The issue's premise is half false. Unpairing is one-sided:
- `delete_peer_ref_inner` deletes the local row and tells the other device nothing.
- The peer's next dial is refused by the app's unpaired-device gate (`admit_peer`, `Rejection::Unpaired`). It reports `peer not paired with this device`.
- The peer keeps its row. It marks the row `unpaired_by_peer_at_ms` ("Pairing lost") only outside its own pairing window, and this run reaches unpair inside the window. So the spec asserts that the row is gone on the app and still present on the peer, and does not assert the flag.

Not run here: the WebdriverIO lane needs the real app under tauri-driver, so the PR's real-backend job is these cases' first run.

Ran:
- `cargo nextest run -p agaric-diagnostics` (39);
- `cargo clippy -p agaric-diagnostics --all-targets -- -D warnings`;
- `cargo fmt --check`;
- `npx vitest run e2e-tauri/sync-peer.test.ts`;
- `npm run typecheck`, `npm run typecheck:e2e-tauri`, `oxlint`, `oxfmt`.
