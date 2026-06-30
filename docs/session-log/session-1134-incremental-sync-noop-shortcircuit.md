## Session 1134 — incremental sync import: no-op short-circuit (#2036, stage 1) (2026-06-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-30 |
| **Subagents** | 1 Explore (mapped the sync-import path) |
| **Items closed** | none (partial progress on `#2036`; issue stays open) |
| **Files touched** | `src-tauri/src/loro/engine/snapshot.rs` |
| **Tests added** | 3 (`noop_short_circuit_tests`) |

**Summary:** #2036 (incremental sync reprojects/rebuilds the entire space on every pull) is a
*large* refactor of the hottest sync-correctness path. This session lands the first, provably
safe slice from the issue's own suggested fix — "short-circuiting to empty on a no-op" — and
maps the codebase + Loro 1.13.6 API for the remaining stages.

**What changed (stage 1):** `LoroEngine::import` and `import_with_changed_and_purged_blocks`
now capture `doc.oplog_frontiers()` before the import and compare it to the frontiers after.
If they are equal, the import appended **zero** ops (the peer already had everything in
`bytes` — a duplicate/redelivered snapshot or update, common on reconnect catch-up and gossip
overlap), so the doc state is byte-identical to before. In that case we short-circuit:
`import` returns `Ok(())` and `import_with_changed_and_purged_blocks` returns
`(vec![], vec![])`, skipping the O(N_live) `rebuild_index`, the full-tree pre-order DFS, the
one-time legacy sibling-order migration scan, AND (via the empty changed set) the caller's
GLOBAL `tag_inheritance::rebuild_all` in `loro_sync::import_and_project`. Previously a
redelivered update in an N-block space cost a full reproject + full inherited-tag recompute
for a delta of zero.

**Correctness:** equal oplog frontiers ⟺ nothing appended to the oplog ⟺ materialised state
unchanged ⟺ `self.index` still current ⟺ no block changed or purged. Returning empty is exactly
correct. Verified: `noop_short_circuit_tests` (duplicate snapshot → empty; realistic
snapshot-then-update where the real update reports the new block and the duplicate update
returns empty; `import` idempotent on duplicate). No regressions: `sync_protocol::loro_sync`
39/39, `loro::engine::snapshot` 7/7, `cargo clippy -p agaric --lib -D warnings` clean, fmt clean.

**Remaining stages (designed, not yet implemented — validated against loro 1.13.6 source):**
- *Stage 2 — single-edit incrementalization (the issue headline).* `doc.import` returns
  `ImportStatus`; `doc.subscribe_root` diff events carry `ContainerDiff.path: &[(ContainerID,
  Index)]`, and a tree node's meta-map `ContainerID` is `Normal{peer,counter,Map}` where
  `(peer,counter)` == its `TreeID` (`TreeID::associated_meta_container`). Per-block state spans
  4 container topologies (tree node, meta map, nested content `LoroText`, and
  `block_properties`/`block_tags` root→`[block_id]`→sub-map); the diff `path`/`Index::Key`
  resolves any changed container back to its block. Plan: capture the diff during import and
  return only the actually-changed blocks (ordered parent-before-child by tree depth), with a
  **brute-force fallback** on any unrecognised container/path so correctness can never be worse
  than today.
- *Stage 3 — scoped tag inheritance.* Replace the global `rebuild_all` with the existing
  incremental `tag_inheritance::recompute_subtree_inheritance` over the changed subtrees (only
  on the precise stage-2 set; keep `rebuild_all` when stage 2 falls back).
- *Stage 4 — gate/incrementalise `rebuild_index`* (upsert only touched nodes).

**Commit plan:** stage-1 commit on `claude/issue-2036-incremental-sync`, draft PR referencing
#2036 as partial (does NOT close it).
