# Session 1032 — audit fix #1252: recovery replay honors new-scheme index/new_index

2026-06-15. From the 2026-06 Opus quality audit (#1252). Shipped as part of the
`/loop /batch-issues` run on the validated audit bugs.

## Bug
`recover_blocks_from_op_log` (`src-tauri/src/db/recovery.rs`) — the emergency
SQL-only block-table rebuild reconstructed sibling order from ONLY the legacy
payload fields: the `create_block` arm read `payload["position"]` and the
`move_block` arm read `payload["new_position"]`. Since #400/#603 the default op
scheme carries sibling placement in `index`/`new_index`, and
`CreateBlockPayload.position` is `#[serde(skip_serializing_if = "Option::is_none")]`,
so new-scheme create ops serialize **no** `position` key. Recovery therefore wrote
`blocks.position = NULL` for every new-scheme-created block, and
`ORDER BY position ASC, id ASC` collapsed siblings to ULID order — losing the
user's intra-parent block order after a crash recovery.

## Fix
- Create arm: `position` prefers legacy `payload["position"]`, else derives a
  1-based provisional position from `payload["index"]` via
  `crate::pagination::index_to_provisional_position`.
- Move arm: `new_position` prefers new-scheme `payload["new_index"]` (same
  mapping), else legacy `payload["new_position"]`.

Both arms mirror the established SQL-only materializer fallbacks
(`apply_create_block_sql_only` / `apply_move_block_sql_only`) byte-for-byte, so
recovered positions match what a live create/move would have written. No
op-schema or migration changes.

## Tests / verification
- New test `recover_honors_new_scheme_index_for_sibling_order` (recovery.rs) seeds
  new-scheme create ops carrying ONLY `index` (asserts the payload omits
  `position`) + a `move_block` carrying `new_index`; asserts zero NULL positions
  and that recovered order follows index order, not id order. **Fails on pre-fix
  code (3 NULL positions), passes after.**
- `cargo nextest run -E 'test(recovery)'` → 83 passed. Independent reviewer ran
  the full Rust suite (4165 passed, 0 failed) + `cargo clippy --lib` clean, and
  verified the recovered positions provably match the live command-path mapping.
  Verdict: SOUND.
