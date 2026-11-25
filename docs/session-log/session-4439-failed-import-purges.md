# Session 4439 — Review notes from #7064 and #7072: a failed import keeps its purges

**Ask.** One follow-up PR for the two Loro upgrade PRs: the data-integrity defect session 4431 left open ("a purge or a kept local block inside such a half-imported batch"), a committed test for a `loro_doc_delta` row loro 1.13.6 wrote, and two review notes.

**The defect.** An import can fail after part of it landed: `import_batch` keeps what its other blobs imported, and a single `import` keeps a valid prefix. `import_payload_with_changed_purged_tagscope` returned the error before it resolved that part, so the purged set and the #6561 rescue were never computed. Boot replay then retried slot by slot, and the purge's re-import was a no-op that resolves nothing: the purged page and its blocks kept their live rows with no tombstone, and a block written here that the purging device never received left the engine instead of going to a Trash page. Shown red first, on the purged rows.

**The fix.** The engine resolves what a failed import did land exactly as it resolves an import, and `ImportDelta::failed` carries the error. `import_and_project` projects that delta (Pass D and the kept pages with it), clears no slot, and returns the error, so the per-slot retry and its accounting run as before. One body serves the single and the batch payload and the live and the replay delivery, so all four are covered by the one change.

- Considered and not taken: loro 1.19's `import_batch_detailed`, which names the blob that failed. It would let the batch clear the healthy slots itself, but it changes which slots a batch clears and how a poison slot is charged, and it does nothing for a single import that keeps a prefix.
- A failed import clears no slot even when the failed blob's declared frontier is covered. The test's poison is a second delivery of the purge with its checksum broken, which declares exactly such a frontier.
- Not fixed: `reject_legacy_v1_snapshot` and `reject_unknown_format_version` still return after an import that landed. The sync handshake refuses a peer on another engine format before any import.
- Not fixed: when the projection of a successful batch fails and the per-slot retry then commits, the retry uses the tombstones read at the start of the walk, not the ones the batch stamped. It needs the same transaction to fail and then succeed within one boot.
- On the live path the `LocalTextKept` notice is not sent for an import that failed; the Trash page is there.
- `import_and_project_saving` returns the error at both of its exits. No test reaches the trusted no-op one: it needs a failed import whose landed part resolves to no block.
- Trap: both functions sat at `clippy::too_many_lines`' threshold. The engine's purged-and-kept step is its own function now, and the projection body is at the limit.

**The 1.13.6 delta row.** The 0.26.0 release vault holds two snapshots and no `loro_doc_delta` row, because the generator exits through a snapshot pass. The new fixture is one row 0.26.0 saves for a write to a new space, written by a throwaway test in a worktree of 7105736 (the last commit on loro 1.13.6); `a_delta_row_written_by_loro_1_13_6_rehydrates` boots from it and reads the blocks back.

**Review notes.**

- The `verify-lockfiles` error text in `_validate.yml` and its copy in `docs/BUILD.md` said loro is pinned exactly in `agaric-engine`. #7072 made it a caret requirement; the sentence is gone from both.
- #7060's review said "jiff 0.2 costs compile time". It does not: `jiff 0.2.46` is in `Cargo.lock` only as the optional dependency behind `serde_with`'s `jiff_0_2` feature, which nothing enables, and `cargo tree --workspace --target all -i jiff@0.2.46` prints nothing. No code change.

**Ran.**

- Red first: `cargo nextest run -p agaric-sync -E 'test(replay_batch_that_fails_after_importing_a_purge)'` before the fix, failing on "what the peer purged has no row" with the page and its block still there.
- Four mutations of the fix, one at a time, each red on the assertion predicted: the old error path (the purged rows), no rescue (the local block is not in the engine), slots cleared on a failed import (the poison slot is gone), the error dropped after the projection (no slot counted as replayed). The fixture test is red with the delta rows not imported at boot.
- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `scripts/test-related-rust.sh --worktree` (every crate that depends on `agaric-engine` or `agaric-sync`): 6,684 passed.
- `prek run --hook-stage manual --files .github/workflows/_validate.yml docs/BUILD.md`.
- Not run: the whole suite and the WebdriverIO lane, which `scripts/e2e-related.sh` selects whole; both are CI's.
