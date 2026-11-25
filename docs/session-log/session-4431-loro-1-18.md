# Session 4431 — Loro 1.13.6 → 1.18.0, the #3161 hold lifted

**Ask.** The maintainer lifted the hold that kept `loro` at 1.13.6 (#3161: since 1.13.7 a concurrent import of the same `LoroText` walks the history back to the fork) and asked for 1.18.0 with nothing else breaking. 1.19.x was inside the 7-day release-age cooldown.

**The bump.** `loro = "=1.18.0"` in `agaric-engine` and `agaric-sync`, and `loro-internal = "=1.18.0"` in `agaric-engine`. No source uses `loro-internal`; `loro` requires it by caret, so without the second pin a lockfile update can pair the 1.18 facade with a newer encoding and merge. Both lockfiles move only the Loro family, `generic-btree` and the `imbl` stack 1.18.0 uses in place of `im`; the five `im`-stack advisory waivers went with it.

- A plain `cargo update -p loro --precise 1.18.0` resolves `loro-internal`, `loro-common`, `loro-delta` and `loro-kv-store` to 1.19.x, and walking them back with `--precise` re-resolves unrelated `windows-sys` edges. Pinning the four in `agaric-engine/Cargo.toml` for the one `cargo update`, then removing the pins and running `cargo metadata`, leaves a minimal diff. The fuzz lock is refreshed the same way.
- The Dependabot `ignore` entries for `loro` are deleted on both cargo entries. The fuzz entry is `lockfile-only`, so it can still move `loro-common`, `loro-delta` and `loro-kv-store` within `^1.18` while the two `=` pins hold.

**What Loro changed that Agaric meets.** The changelog from 1.13.7 to 1.18.0 was read against each call Agaric makes, and the claims checked in the two crates' sources.

- An import whose ops reuse op ids the doc holds with other content fails with `UsedOpID` (1.16.4, widened in 1.18.0); 1.13.6 returned `Ok` and dropped them. Three tests met it:
  - `reset_reusing_same_peer_id_…_792` pinned the silent drop as a tripwire. It now pins the refusal, under a name that says so.
  - `issue2140_snapshot_fallback_on_real_compaction_over_real_socket` gave the initiator six responder-peer ops that were not an extension of the responder's history, though its comment calls the catch-up snapshot a prefix. The initiator's engine now starts from the responder's lineage, so it is one. A lineage that really forked (a device restored from an old `notes.db` that then minted any op) used to merge silently and diverge; its peers' sync sessions with it now fail on every attempt. The maintainer chose to ship that; #7065 tracks the handling.
  - `replay_batch_keeps_slots_whose_end_frontier_the_import_never_reached_3194`: a shallow snapshot batched into an empty doc now initialises it (1.17.0), and an update that depends on trimmed history is refused instead of parked. The receiver holds a block of its own now, which reaches the same "admitted, never settles" state on both versions. Broken delete condition: red on the slot count.
- That last failure exposed a defect that is on `main` too. When `import_batch` fails after importing some blobs, `import_payload_with_changed_purged_tagscope` returned before `rebuild_index`, so the per-slot retry's whole-tree reprojection read through a stale index, projected nothing for the new blocks and cleared their slots. 1.13.6 reaches it with a blob whose checksum is wrong; 1.18.0 adds every blob that fails on its own. The index is now rebuilt on that path, with `replay_batch_that_fails_after_importing_part_projects_what_it_clears`, red before the fix on the projected rows. Not covered: a purge or a kept local block inside such a half-imported batch, whose deltas the error path still drops.
- 1.16.4 emits tree events for the descendants of a node a move brings out of a deleted subtree. 1.13.6 reported the node alone, so the projection missed its children; the resolver takes the extra events as it stands.
- Nothing else reaches production code: no manual transaction or import from a callback (`ImportWhenInTxn`), no detached editing, `set_peer_id`, `fork` and `fork_at` unchanged, and the write refusal while own-peer changes are parked needs a blob the inbound gates already turn away.

**Data compatibility.** No `ENGINE_FORMAT_VERSION` bump.

- `head_boots_the_vault_the_last_release_wrote_6567` already boots head over the 0.26.0 vault, whose `loro_doc_state` snapshots 1.13.6 wrote and whose compacted op log leaves them the only record. With the saved snapshot's import skipped it goes red on nine diverged block rows, so no fixture was added.
- A throwaway harness drove `LoroEngine`'s own API on both versions (a worktree at `origin/main` for 1.13.6): two devices with concurrent text edits, moves, a purge, tags, aliases, attachments and property definitions; a snapshot, 80 saved delta rows, updates and a batch; a device booting the other version from its saved rows and writing on; `revert_to_frontier` and `fork_staging` on inherited history. All four writer and reader pairings ended on the same state, 89 of 90 blobs were byte-identical between the versions, and every `ImportDelta` matched. It was not committed.

**Stale copies.** The comments that cited `loro-internal-1.13.6/src/…:line` name the symbol now, each checked against 1.18.0. One claim was false after the bump and was rewritten: that Loro's encoder cannot write a per-peer gap.

**Ran.**
- `cargo nextest run --workspace` in two partitions: 8,560 passed. The first run, before the test and index changes, had 8,556 of 8,559.
- `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --doc --workspace` (10), `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo deny check`, `cargo machete`.
- `scripts/e2e-related.sh` selects the whole WebdriverIO lane, which is CI's.
- Independent review of the diff against both Loro sources, before the test changes; its findings are in the diff.
- `just measure-loro`, then `just measure-loro 10000`, on a 4-core cloud container; `docs/architecture/operations.md` § Loro engine cost and the vault-size envelope carry the results. Against the 1.13.6 figures they replace, taken on another container of the same kind: snapshot and delta-row bytes are the same; a snapshot export is 12.6 ms at 100K where it was 556 ms; the heap after rehydrate is 86.7 MB where it was 171.5 MB; a rehydrate at 100K is 1,117 ms [981–1,169] against 968 ms [861–1,113], bands that overlap; a cold first sync at 100K is 26.7 s against 29.7 s.
- On the PR's first head, dispatched: `scheduled-deep-checks.yml` with `bench-slo,bench-smoke`.
