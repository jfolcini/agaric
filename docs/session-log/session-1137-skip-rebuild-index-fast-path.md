## Session 1137 — incremental sync: skip rebuild_index on non-structural imports (#2036 follow-up) (2026-06-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-30 |
| **Files touched** | `src-tauri/src/loro/engine/snapshot.rs` |
| **Tests added** | 1 (`fast_path_edit_preserves_index_across_structural_ops`) |

**Summary:** Closes the last O(N) cost in the #2036 incremental-sync fast path. After #2036
(merged in #2166/#2167), a remote single-block edit projected only the changed blocks and
recomputed inheritance only for affected subtrees — but `import_with_changed_purged_tagscope`
still called `rebuild_index()` (an O(N_live) tree meta-walk) and cloned the index keyset twice
for the purged delta on EVERY real import. A content/property/tag edit touches no tree node, so
that whole O(N) pass was pure waste for the headline single-edit case.

**Change:** `DiffCapture` now records `has_tree_diff` (set when a `blocks_tree` `Diff::Tree`
structural change — create/move/delete — is seen). When an import has no structural diff, is not
a fallback, and did not trigger the legacy sibling-order migration, `self.index` is provably
unchanged (no node created/deleted) and nothing was purged, so the method skips `rebuild_index`
+ both index-key clones and returns the resolved changed set with an empty purged vector — the
fast path is now truly O(changed) end-to-end. Structural/fallback imports keep the full
rebuild + purged-delta. Soft-delete/restore are meta-only (no `Tree` diff), so they also take
the fast path now (the node stays live in the index). The migration call was hoisted above the
rebuild (it operates on the doc tree, not `self.index`, so it is order-independent) so the
`migrated`→fallback decision is made before any O(N) work.

**Verification:** new `fast_path_edit_preserves_index_across_structural_ops` sandwiches a
rebuild-skipped content edit between two structural ops on the same block, proving the index
stays correct across the skip. No regressions: `loro::engine` 103 (incl. convergence proptests),
`sync_protocol::loro_sync` 40, all `incremental_detection`/`noop_short_circuit` tests + the
scoped-vs-global inheritance equivalence test green; `clippy -D warnings` + `fmt --check` clean.

**Commit plan:** single commit on `claude/issue-2036-skip-rebuild-index`; draft PR referencing
#2036 (already closed) as a follow-up perf refinement.
