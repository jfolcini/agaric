## Session 950 — PEND-80: LoroTree block hierarchy + typed lossless projection (#86) (2026-06-02)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-02 |
| **Subagents** | 3 Explore (snapshot/version, projection paths, move/position commands) + 1 adversarial reviewer |
| **Items closed** | — (#86 stays open; PR #331 continues as WIP — Phase 3 data-model change wants maintainer review before merge) |
| **Items modified** | #86 (Phases 3 + 4 + §5 docs landed on the PR branch) |
| **Tests added** | 12 engine tree/migration/convergence unit tests; reproject tests migrated to native typed routing |
| **Files touched** | `loro/engine.rs`, `materializer/handlers.rs`, `loro/projection.rs`, `sync_protocol/loro_sync.rs`, `AGENTS.md`, `docs/architecture/crdt-and-recovery.md`, `docs/architecture/data-and-events.md`, this log |
| **Outcome** | **SHIPPED to the PR branch** — full suite green (4094 passed) |

**Task:** finish PEND-80 (#86) on PR #331 in one PR — Phase 3 (`LoroTree`), Phase 4
(unify projection onto the lossless typed engine), §5 docs — with deep testing, a
subagent code review, and a rock-solid upgrade path.

### Phase 3 — `LoroTree` block hierarchy

Replaced the flat-`LoroMap` block model (each block's `parent_id`/`position` as scalar
fields, parent reassignment as per-key LWW with documented cycle/position edge cases)
with a `LoroTree` at `blocks_tree`. Each block is a tree node whose meta map holds
`block_id` / `block_type` / `content` (a `LoroText`) / `position` (`i64`) / `deleted_at`;
the parent is the tree structure. `create`/`move`/`delete`/`restore`/`purge` and the read
surface (`read_block`, `read_parent`, `list_children_walk`, `count_alive_blocks`,
`import_with_changed_blocks`) are rewritten onto tree ops. **The engine's public API
signatures are unchanged**, so the materializer/projection/merge/sync callers are
untouched.

- **Headline wins:** concurrent reparents converge via Loro's move-CRDT (not per-key
  LWW); a cycle-forming move is rejected deterministically (`CyclicMoveError`) instead of
  silently corrupting the tree.
- **`block_id → TreeID` index:** maintained incrementally on the local write path, rebuilt
  from node meta after any `import` (skipping hard-purged nodes).
- **Scoping decision (pragmatic, rock-solid):** sibling order stays the `i64` `position`
  meta sort key, **not** a derived fractional-index ordinal — the SQL `position` column,
  its `ORDER BY position` pagination cursors, and the frontend's sparse-integer position
  arithmetic are byte-for-byte unchanged (no §3a "open risk #1" ordinal-stability
  exposure). Convergent fractional-index reorder is a future refinement.
- **Migration:** old flat-map snapshots migrate in place to the tree on load —
  `import()` runs `migrate_flat_blocks_to_tree` (idempotent: a no-op once the legacy root
  is empty) then rebuilds the index, so `rehydrate_registry` and inbound sync both upgrade
  transparently. No SQL migration and no engine-format DB column are needed because the
  migration is unconditional and idempotent. `loro::engine::ENGINE_FORMAT_VERSION` = 2.

### Phase 4 — lossless typed projection

`reproject_block_properties_from_engine` now consumes the engine's native
`PropertyValue` snapshot (`read_all_properties_typed`): `Num`/`Bool` route directly to
`value_num`/`value_bool` with no string round-trip and no `property_definitions` lookup;
only `Str` values (text/date/ref/select per the §8 Q5 encoding) consult `value_type`.
Both projection paths are now lossless and typed end-to-end (the local `SetProperty`
path already projected from the typed op payload). The structural single-function collapse
of local + remote projection is a pure refactor on the hot local write path — **deferred**
as out of scope for a rock-solid PR; the losslessness goal is met.

### Adversarial review (subagent) — fixes applied

- **Finding 1/3 (HIGH/MED):** the purge command emits one `PurgeBlock` op for the seed and
  SQL-cascades descendants, so `tree.delete(seed)` orphaned descendant nodes (transitively
  deleted) while they lingered in the in-memory index → `read_block(descendant)` returned a
  stray live root block. Fixed: prune the whole subtree from the index before delete.
- **Finding 4 (MED, gated):** hardened `migrate_flat_blocks_to_tree` against a partial-tree
  / mixed doc (skip block_ids already present as tree nodes; only reparent freshly-created
  nodes). The concurrent-purge test also caught a real inbound-sync bug — `rebuild_index`
  was re-adding hard-purged nodes — fixed by an `is_node_deleted` filter.
- Findings 5/6 (LOW): added targeted tests (cyclic move lands position not reparent).

### §5 docs

`AGENTS.md` invariant #2 refined with the three-layer responsibility boundary (op_log =
canonical typed history; Loro engine = derived merge index owning content + tree + typed
scalars; SQL = derived query/derivation view) + the engine-format-version / migration rule.
`crdt-and-recovery.md` rewritten engine data model (tree, typed values, real `deleted_at`)
+ engine-format-version + migration section (and fixed a stale `LoroEngine::flush`
citation → `export_snapshot`). `data-and-events.md` notes the engine-derived
`parent_id`/`position`.

### Verification

`cargo nextest run` full suite: **4094 passed, 0 failed.** `cargo clippy --tests`: 0
warnings. New engine tests: tree create/reparent/read, position-ordered children excluding
soft-deleted, deterministic cycle rejection, soft-delete/restore/purge lifecycle,
replay-idempotent create, flat-map → tree migration round-trip (dangling parent +
soft-delete + idempotency + re-export), two-device concurrent-reparent / concurrent-purge
convergence, purge-parent-prunes-descendants.
