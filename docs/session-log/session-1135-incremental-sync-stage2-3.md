## Session 1135 — incremental sync import: changed-block detection + scoped tag inheritance (#2036 stage 2/3) (2026-06-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-30 |
| **Subagents** | 1 Explore (earlier mapping); orchestrator implementation |
| **Items closed** | `#2036` (stage 1 landed in #2166; this completes stages 2–3) |
| **Files touched** | `loro/engine/snapshot.rs`, `loro/engine/mod.rs`, `sync_protocol/loro_sync.rs` |
| **Tests added** | 8 resolver unit tests + 1 scoped-vs-global equivalence test |

**Summary:** Completes #2036. A remote single-block edit no longer reprojects the whole space
or rebuilds the entire inherited-tag cache; it reprojects only the changed blocks and recomputes
inheritance only for the affected subtrees, with a brute-force fallback that keeps correctness
identical to the old path on anything unrecognised.

**Stage 2 — incremental changed-block detection (`snapshot.rs`).** `import_with_changed_purged_tagscope`
subscribes the doc for the import, then resolves the resulting `DiffEvent` to the exact blocks
whose projected SQL state changed, validated empirically against loro 1.13.6 diff shapes:
- node meta-map / content `LoroText` change → that node's block (`Index::Node(TreeID)` in the diff path);
- `block_properties` / `block_tags` change → its `block_id` (`Index::Key`, or root-map updated keys);
- `blocks_tree` structural change (create/move/delete) → the node PLUS every sibling at the
  affected parent(s) (`TreeDiffItem.action` carries `parent`/`old_parent`), because the projected
  `position` is a per-parent dense rank that shifts for the whole sibling group.
Soft-delete/restore need no special handling (meta-only; the caller's Pass C cascades from the
seed). The changed set is ordered parent-before-child by tree depth for the FK-ordered projection.
**Fallback** to the historical whole-tree enumeration on any unrecognised root/container, an
`is_unknown` diff, or (defensively) the one-time legacy sibling-order migration appending ops —
so correctness is never worse than pre-#2036. `import_with_changed_and_purged_blocks` is kept as
a thin wrapper. The #2036-stage-1 no-op short-circuit (oplog-frontier equality) is preserved.

**Stage 3 — scoped tag inheritance (`loro_sync.rs`).** The engine returns a `TagScope`:
`Subtrees(roots)` (deduped to top-most) for the fast path or `Global` for the fallback. The
caller replaces the unconditional `tag_inheritance::rebuild_all` with a per-subtree
`recompute_subtree_inheritance` over the changed/created/moved subtree roots (tag edits and
structural re-parenting both shift inherited rows); purged subtrees are handled by Pass D.

**Verification:**
- 8 resolver unit tests (`incremental_detection_tests`): content/property edits → only that block;
  tag add → block + subtree scope; create → new block + siblings; move → both sibling groups +
  moved-subtree scope; soft-delete → seed only; purge → reported purged, excluded from changed;
  duplicate → empty.
- 1 end-to-end equivalence test (`incremental_tag_inheritance_matches_global_rebuild`): after a
  snapshot + an incremental tag-add + a structural move that drops an inherited tag, the
  scoped-incremental `block_tag_inherited` is byte-identical to a from-scratch global `rebuild_all`.
- No regressions: `sync_protocol::loro_sync` 40, `loro::engine` 102 (incl. convergence proptests),
  `tag_inheritance` 34; `cargo clippy -p agaric --lib -- -D warnings` + `cargo fmt --check` clean.

**Commit plan:** stages 2–3 on `claude/issue-2036-stage2-incremental`, `Closes #2036`, draft PR,
merge when green + agaric-reviewer-approved (standing authorization).
