# Session 1502 — #3443: contract tests in the crates the mutants lane mutates

Goal: the first slice of #3443 as narrowed on 2026-09-02. `cargo mutants -p agaric-store` and `-p agaric-engine` run only that package's tests, so a public item whose only tests live in the app crate shows every mutant as a survivor. This session gives the zero-test items on the two surfaces #3393 reaches (`agaric_store::{op, op_log}`, `agaric_engine::loro`) tests in the providing crate, written against the boundary the callers rely on.

## What shipped

Twelve tests, every one shown red under a named mutation of the method it pins before it was kept.

`agaric-store`, new files under `op_log/tests/`:

- `undo_redo_append.rs`: `append_local_undo_op_in_tx` stamps `is_undo = 1` and the reversed op's foreign `(device, seq)`; `append_local_redo_op_in_tx` stamps `is_undo = 0` and links the reversed op.
- `resolve_prev_edit.rs`: `resolve_prev_edit_target` returns the op the pointer names, `None` for a `(device, seq)` that does not exist (the device predicate is pinned, not just the seq), and resolves a replicated audit row. The last one is the deliberate absence of an `is_replicated` predicate; the app-crate fixture at `src/reverse/tests.rs:2879` only pins parity between the batched and single-op copies, so adding the predicate to both would leave it green.

`agaric-engine`, inline test modules:

- `loro/engine/reads.rs`: `contains_block` follows index membership (true after create and after soft delete, false for an unknown id and after purge); `read_position` is the dense sibling rank before and after a move, with the exact `Validation` error for an unknown block.
- `loro/engine/tree.rs`: `children_ordered_block_ids` returns the root forest for `None` and an empty vector for an unknown parent; the sibling order was already pinned in-crate by `merge/apply.rs`.
- `loro/engine/snapshot.rs`: `live_blocks_preorder` enumerates every unpurged block depth-first in sibling order across two roots, keeps a soft-deleted block, and drops a purged subtree.
- `loro/engine/sync.rs`: `screen_inbound_blob` reports the exporter's declared frontier with no fork on a fresh update and again on redelivery of the same bytes, reports the full own-peer fork message on a divergent lineage under the same peer id, and does not panic on bytes that are not a Loro blob (that test pins only the decode-failure return, and its name says so).

Not added: `OpPayload::attachment_id` already has the `_3452` pair in `op_log/tests/append.rs` with a distinct id per attachment arm, so the builder's copy was deleted. `import_with_changed_blocks` has two in-crate tests and stays.

## What review corrected

- The builder's `live_blocks_preorder` fixture had one root, so the root-level `stack.reverse()` was unpinned; the kept test has two roots and reddens under that mutation.
- The fresh-update `screen_inbound_blob` test had a receiving doc with no ops, so `fork == None` held through the `local_counter == 0` carve-out rather than the peer-scoping rule; the receiver now mints its own op first.
- The undo append test compared against a second pool's plain append; the hash-equality half was structurally true (`compute_op_hash` has no provenance input) and the chain half duplicated `append.rs::second_op_references_first_as_parent`. Cut to the provenance triple with a foreign `reverses` ref and the `seq` it reads.
- A rollback test asserting the op log untouched was deleted: the `_in_tx` signature makes the assertion unreachable, and its `seq` assertions were duplicates.
- A trailing `count == 0` after an explicit rollback was vacuous and was cut.
- The PR reviewer cut two more duplicates: the valueless `set_property` redo test (the validation runs in the shared append and `op.rs` already pins it) and the redo hash recomputation (same shape as `tests/hash.rs`; `parent_seqs` carries the load), and narrowed the sibling-order test to its two new arms.

## Verified

- `cargo nextest run -p agaric-store` after review: 1347 passed, 3 skipped.
- `cargo nextest run -p agaric-engine` after review: 471 passed, 0 skipped.
- Each test's falsification was re-run by the reviewer against a copy of the production file; `cmp` silent after every restore. Production files are byte-identical to `HEAD` at commit time.

## Left for the next slice

`RevertScope::detach`, `evict_space`, `for_space_recording` and the remaining relocation artefacts in the #3443 inventory (`doc_handle`, `loro_vv`, `guard_acquisitions`, `reproject_call_spy`, `load_all_space_snapshots`) wait for a weekly mutants run to show which of them surface as relocation-artefact survivors, per the narrowed scope.
