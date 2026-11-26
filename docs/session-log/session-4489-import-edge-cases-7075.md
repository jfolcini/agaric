# Session 4489 — the four import edge cases #7075 left open

Session 4439 (#7075) left four import edge cases open. One was a real bug and is fixed. The other three cannot be reached; two now say why in a comment, and one was dropped because its premise was false.

**Fixed: a retry swept nothing a failed batch purged.**
- The sequence:
  1. A boot-replay batch imports a peer's purge and stamps the purged ids on its slots.
  2. Its projection fails, and the per-slot retry runs in the same boot.
  3. The retry passed the tombstones the walk had read before the stamp, which were empty.
  4. Its re-import resolves no purge, because the engine already holds it, so the retry's purge pass had nothing to sweep.
  5. The retry committed and deleted the slot along with its tombstone.
- Result: the purged page and its block kept live SQL rows for good.
- Fix: `replay_accepted_slots_individually` now reads each slot's tombstone from its row before the retry (`stamped_tombstone`).
- `decode_purged_tombstone` moved unchanged into `loro_sync.rs`, so that the boot walk and the retry share it.

**Unreachable, with a comment saying why.**
- **The format gates after a landed import** (`reject_legacy_v1_snapshot`, `reject_unknown_format_version`):
  - Only sync deliveries and their inbox replay import through the shared body.
  - The handshake (`on_head_exchange`) turns away a peer on another engine format before anything is imported.
  - Disaster recovery and boot rehydrate use plain `import` into engines they throw away on error.
- **The trusted no-op exit with a failed import** (`import_and_project_saving`): only a live delivery is trusted, and a live delivery is one blob. Only a replay batch fails with part landed, and a replay is never trusted. No input reaches the exit, so no test can.

**Dropped: `LocalTextKept` on a failed live import.** A live import is one blob, and loro 1.19 imports one blob whole or not at all. Checksum, decode and missing-op failures are caught before anything applies, and a failed state apply is rolled back. So a failed live import lands nothing, keeps no block and has no notice to send. This rests on reading loro's source and its `import_atomicity` tests, not on a test of ours. A loro bump that changes single-blob atomicity reopens this case and the no-op exit above.

**Left alone.**
- A live import that succeeds with a kept block, and whose projection then fails, sends no `LocalTextKept` notice. The Trash page still appears at the next boot replay. That needs a projection failure at the same time as a purge rescue, which is none of the four.
- The `engine_format_version == 0` branch in `on_head_exchange` is dead, but removing it is out of scope.

**Ran.**
- `retry_after_a_failed_projection_sweeps_what_the_batch_purged`:
  - Red before the fix, on "what the peer purged has no row", with the page and the block still listed.
  - Green after.
  - Red again on the same assertion with the retry reading the walk's stale tombstone.
- Its trigger fails only the batch's projection. It keys on the `loro_doc_delta` count, which grows by one when the failed import saves its delta on its own (#6521). The test asserts that growth as a precondition.
- Full suites: `agaric-sync` 1083 passed, `agaric-engine` 1407 passed.
- `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all --check` passed.
- The new `query_scalar!` compiles offline from the `.sqlx` entry `just gen-sqlx` added.
