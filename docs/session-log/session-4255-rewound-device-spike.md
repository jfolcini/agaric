# Session 4255 — the rewound-device spike for #6524 and #6744

The orchestrator asked for #6744 (restore from a daily snapshot without breaking sync) and #6524 (heal a device whose own Loro counter is behind its peers) to be designed together. The design note on #6524 proposed one mechanism: bump `loro.peer_id_epoch` when the snapshot is swapped in, before any engine loads. The maintainer took all six decisions as recommended. This PR is the first slice: a test-only spike, recorded as go or no-go on #6524.

`agaric-sync/src/sync_daemon/tests/rewound_device_6524.rs` reuses the #602 two-registry seam (`pump_full_session_602`, `make_local_edit_602`). A and B sync, A's database is copied the way the daily snapshot copies it (engines saved, then `VACUUM INTO`), and A edits once more and B pulls that edit. A is then booted on the copy the way `crate::run` boots: `load_peer_epoch`, `set_peer_epoch`, `rehydrate_registry`.

- **Restore under a fresh epoch** (#6744's case) converges. Both sessions complete, both databases hold every edit, the one the copy lost included, and both version vectors agree. Falsified without the bump: both sessions still report `Complete`, but the lost edit never reaches A. A post-restore write that takes as many counters as the lost one leaves B's counter for A no higher than A's own, so the fork guard does not fire and the loss is silent.
- **Heal after a write under the old PeerID** (#6524's case) converges on A's engine and B's database. Rebuild A's engine from B's snapshot, then re-apply the ops of A's whose `(seq, hash)` B's audit copy of A's op log lacks. Falsified by skipping the re-apply: A's post-rewind edit goes missing. Two findings: (1) with epoch 0 it passes too, because the re-applied ops continue from B's counter for A, so the bump was dropped from the prototype; it matters only if the replaced ops reached another device. (2) A's SQL still lacks the lost edit, because no session delivers what the rebuilt engine already holds, so the heal needs a reproject from the engine (`reproject_blocks_from_engine`).

## What ran

- `cargo nextest run --workspace -E 'test(rewound_device_6524)'`: 2 passed. Each case was falsified as described above, and each red was the content assertion predicted.
- `cargo clippy -p agaric-sync --all-targets -- -D warnings`.
