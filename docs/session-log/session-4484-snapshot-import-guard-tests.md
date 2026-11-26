# Session 4484 — engine tests for a batch import that fails partway

Tonight's deep checks left three survivors at one match guard in `snapshot.rs`, filed to #4690. The guard is `Err(error) if self.doc.oplog_frontiers() != before_frontiers` in `import_payload_with_changed_purged_tagscope`. It decides whether a failed import that still appended ops resolves what landed and returns the error in `failed` (#7075), or returns `Err`. The mutants were the guard forced to `true`, forced to `false`, and `!=` turned into `==`.

**Why they survived.** #7075 tested the behaviour in `agaric-sync` (`replay_batch_that_fails_after_importing_a_purge`), and the nightly shard runs `cargo mutants -p agaric-engine` against that crate's own tests. Nothing in `agaric-engine` reached a failed import. #7091's reused-op-id test, merged since, kills the `true` and `==` mutants but not `false`.

**Tests**, in `incremental_detection_tests`:
- `failed_batch_resolves_the_blob_that_landed_7075`: the batch is a purge of BB, then an edit of AA with a corrupted header checksum. The result is `Ok`, with BB purged, nothing changed, the import error in `failed`, BB gone and AA untouched.
- `failed_batch_that_landed_nothing_is_an_error`: both blobs are corrupted. The result is the import `Err`, and the oplog frontiers are unchanged.

A corrupted checksum (byte 18) leaves loro's batch metadata decodable, so loro tries each blob and that blob's import fails. That is the poison #7075's own test uses. A two-blob batch is needed because loro sends a one-blob batch straight to `import`.

**Ran.**
- `cargo mutants --in-place --workspace -f agaric-engine/src/loro/engine/snapshot.rs`, filtered to the guard: 3 caught, 0 missed. The source was byte-identical afterwards.
- Hand falsifications of the guard:
  - forced to `false`: the first test goes red;
  - forced to `true`: the second test goes red, with `Ok(ImportDelta { changed: [], …, failed: None })`;
  - `==`: both go red.
- `cargo nextest run --workspace` over `agaric-engine`'s import and snapshot tests, and `cargo clippy --workspace --all-targets -- -D warnings`.
