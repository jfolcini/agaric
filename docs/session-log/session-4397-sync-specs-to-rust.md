# Session 4397 — six WDIO sync specs give way to Rust two-device tests

#6926 stage 2, slice S1. Six WebdriverIO specs asserted the backend state that a pull from the scripted peer (`e2e_sync_peer`) leaves behind; the UI only read it out. The plan moves each to a Rust test that runs the same pull between two in-process devices, then deletes the spec. `page-mode-save-cost` is not a sync scenario: the map keeps it as an opt-in measurement, so it stays.

**Per spec:**
- **`page-alias-contested-sync` (#6229): new test.**
  - Test: `src/spaces/tests.rs::dropping_a_pulled_contested_alias_hands_it_to_the_peers_page_6229`, on the `SyncedPair` QUIC harness.
  - Why new: no test pulled a contested alias and then dropped it locally.
  - Why the app crate: the local commit's hand-off (`hand_off_unheld_page_aliases`) is app-crate code, which `agaric-sync` cannot reach.
  - Shown red: with the hand-off disabled, the final alias rows read `([], [])`, not `([], ["plans"])`.
- **`page-name-tie-sync` (#6278): covered.**
  - Test: `src/repair/name_collisions/tests.rs::only_the_later_pages_creator_renames_it_and_both_devices_converge`.
  - Shown red: without `renames_due`'s `created_here` filter, both devices rename and end at `foo (2) (2)`.
- **`sync-cross-space-move` (#5712): covered.**
  - Tests: `src/spaces/tests.rs::crossing_moves_reach_the_peer_whole_over_quic_5712` and `a_page_moved_there_and_back_survives_on_its_peer_in_every_order_5712`.
  - Shown red: both fail when `project_pass_d` purges a moved page's rows at once instead of at the session's end.
- **`sync-large-vault` (#5739): new test.**
  - Test: `agaric-sync/src/sync_daemon/tests.rs::a_fresh_device_pulls_a_vault_several_op_batches_long_5739`, on the real-loopback session harness.
  - What it does: checks that the op log spans at least three batches, then that the fresh device holds every page and block, and that the last block's op arrived.
  - Shown red: with the last batch dropped, that op is missing.
- **`sync-raw-loro-bytes` (#5761): covered.**
  - Test: `agaric-sync/src/sync_daemon/tests.rs::a_snapshot_past_the_old_frame_cap_syncs_over_quic_5761`, which the spec's own header named as the real control.
  - Shown red: with the old 64 MiB cap, the responder refuses the payload.
- **`sync-ref-to-new-block` (#6232): covered.**
  - Test: `agaric-sync/src/sync_protocol/loro_sync_tests.rs::apply_remote_keeps_a_ref_to_a_block_the_same_import_brings_6232`.
  - Shown red: with pass A's properties projected before its rows, the ref is dropped.

**Removed with the specs:**
- the peer commands only they used, in `e2e-tauri/sync-peer.ts` and `diagnostics/src/bin/e2e_sync_peer.rs`: `SeedVault`, `CreateSpace`, `MoveToSpace`, `SetPageAliases`, and `CreateInSpace`'s space argument;
- their entries in `e2e-tauri/spec-durations.json`.

`COMPARISON-LOGSEQ-MATRIX.md` now cites the Rust tests.

**Ran:**
- nextest over the new and cited tests plus the peer binary's tests: 28 passed;
- `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --check`;
- `npx vitest run e2e-tauri`: 52 passed;
- `node --test scripts/e2e-related.test.mjs`: 17 passed;
- `npm run typecheck` and `typecheck:e2e-tauri`, knip, oxlint, oxfmt, and the doc-code-paths check.
