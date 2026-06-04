# Session 966 — DnD #400: fractional-index sibling order (closes #400–#404, #406)

**Date:** 2026-06-04
**Scope:** The dedicated #400 effort staged in session 965 — replace the gapless
1-based integer `position` with Loro's native movable-tree **fractional index**
as the sibling-order source. Fixes the four DnD correctness bugs at their root
and folds in R5 (#404, optimistic drag path). Op-log-backcompat-first, as planned.

## Root cause (recap)

All four bugs trace to one flaw: sibling order was a gapless 1-based `i64`
`position` stored as an LWW register in Loro node meta and projected to SQL,
never renumbered. The frontend handed the backend either a *colliding* integer
(ULID tie-break wins, not drop intent) or a *non-positive* one (rejected). The
repo already uses `LoroTree` but deliberately opted out of its fractional index;
this is that refinement.

## Approach

Use Loro's native fractional index (the CRDT owns rank + concurrent-reorder
convergence). Keep SQL `position` as `i64` but **derive it as a dense 1-based
rank** from `tree.children(parent)` — so `ORDER BY position`, pagination cursors,
and the `i64::MAX` NULL sentinel are unchanged, and `.snap` churn is minimal.
The op payload carries an integer **sibling index**; Loro derives the convergent
fractional key at apply time.

### Spike findings (gating, step 1 — retired)

- Loro's default `TreeState` config is already `GenerateFractionalIndex{jitter:0}`,
  so `is_fractional_index_enabled()` is **always true** — useless as a migration
  signal. We use an explicit doc-internal version marker (`engine_meta.sibling_order_v`).
- Enabling assigns indices in **creation/idlp** order, NOT legacy `position`
  order → a pre-#400 doc needs a one-time reorder migration on import.
- `jitter = 0` chosen: convergent for concurrent reorders (equal indices tie-break
  by idlp), deterministic, smallest encoding.

## Implementation

- **Engine** (`loro/engine.rs`): enable fractional index at init; marker-gated
  legacy migration on `import` / `import_with_changed_blocks` (only reorders a
  genuine pre-#400 doc — guarded by `any_node_has_legacy_position` so a
  marker-less new-scheme doc is never clobbered). New `apply_create_block_at` /
  `apply_move_block_to` use `create_at`/`mov_to`; the legacy position-based
  methods stay (op-log replay maps sparse `position` → slot via `legacy_slot`,
  reproducing the old `position ASC, id ASC`). `read_block.position` is now the
  dense rank. **Live-slot translation** (`live_tree_slot`): the frontend sends a
  slot among *live* siblings, so soft-deleted siblings don't shift placement.
- **Op payloads** (`op.rs`): `CreateBlockPayload.index` / `MoveBlockPayload.new_index`
  added as optional, omitted-when-`None` fields; legacy `position`/`new_position`
  retained so historical payloads round-trip unchanged. Backcompat covered by
  deserialize tests.
- **Materializer/projection**: route on `index` (new) vs `position` (legacy);
  `reproject_dense_positions` rewrites the affected parent's children to dense
  1-based positions (both source + target parent on a cross-parent move) —
  projection-only, no new Loro ops.
- **Commands**: `create_block`/`move_block` take a 0-based `index`; the
  `position <= 0` validation is gone (slot 0 = first child / top now works).
  Optimistic SQL write uses a provisional rank; the materializer reprojects the
  authoritative dense rank async (existing eventual-consistency model).
- **Frontend**: `computeDropIndex` (replaces `computePosition`) returns the slot
  from the post-removal order — fixes all four bugs. `handleDragEnd` routes
  same-parent reorders through the optimistic local-splice path (R5/#404),
  reserving `moveToParent`'s reload for reparents. `page-blocks` keyboard ops
  compute slots; `midpointPosition`/`computeReorderPosition` deleted. The web
  mock renumbers densely to match the backend.
- **MCP / batch**: `append_block` and `create_blocks_batch` keep their stable
  1-based `position` wire contract, converting to the 0-based engine index at
  the boundary (no agent-facing break).

## Backwards-compatibility

The maintainer **does not sync today** (engine docstring), so history is
single-device and temporally ordered: every historical op is legacy (sparse
position), every future op carries an index — a clean boundary. Legacy ops
convert deterministically on replay; a pre-#400 snapshot migrates once on import.
The marker + legacy-position guard make migration idempotent and safe. (Open
future-sync note: two peers independently migrating the same legacy snapshot mint
peer-keyed fractional indices; convergence then relies on the idlp tie-break —
to revisit when sync lands, PEND-81.)

## Verification

- `cargo nextest run --lib`: **4105 passed, 0 failed** (incl. new engine unit
  tests for `apply_create_block_at`/`apply_move_block_to`, slot-0 moves, the
  soft-deleted live-slot case, and legacy-snapshot migration). `.sqlx`
  regenerated (`--all-targets`); offline build clean.
- `vitest run`: **11238 passed** (485 files). The 5 `dnd-pipeline` + 4
  `page-blocks` `it.fails` acceptance markers now pass as plain `it`.
- `tsc -b` clean; `oxlint` clean (pre-existing complexity warnings only).
- Bindings regenerated (`create_block`→`index`, `move_block`→`new_index`).
- `/code-review` (high) run; findings fixed: MCP/batch off-by-one, soft-deleted
  live-slot placement, marker-loss migration hardening, sync-path migration.
