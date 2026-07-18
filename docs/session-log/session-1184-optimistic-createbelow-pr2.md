# Session 1184 — optimistic createBelow via client-generated ULID, #2849 PR2

## Scope

Complete the create+delete+keyboard-structural-move optimistic-write set for #2849:
`createBelow` (new block on Enter) now applies **before** the IPC round-trip, using a
**client-generated ULID** threaded through `create_block` (the maintainer's approved
option (b)). Cross-cutting: backend command-signature change + validation + specta regen +
FE optimistic reducer + docs. Builds on PR1's provisional-splice infrastructure (#2875).

This is PR2 of #2849. `moveToParent` / `moveBlocks` / `pasteBlocks` and the cross-parent
`moveUp`/`moveDown` pop-out branches remain non-optimistic follow-ups (lower frequency).

## Backend (`agaric-engine` + app command)

- `create_block_in_tx` (`block_ops.rs`) and the `create_block` Tauri command gain an
  optional `client_id: Option<BlockId>`. `None` → server ULID (all ~30 existing callers
  updated to pass `None`, unchanged behavior; a 7-arg `create_block_inner` wrapper +
  `create_block_inner_with_id` keep the ~40 test/journal/space callers untouched). `Some(id)`
  → re-parse via `BlockId::from_string` (malformed → `AppError::Ulid`) + a collision
  `SELECT 1 FROM blocks WHERE id = ?` against **all** rows incl. tombstoned (duplicate →
  `AppError::Conflict`), inside the same `BEGIN IMMEDIATE` tx as the insert (TOCTOU-safe).
  Never a silent fallback.
- specta `bindings.ts` and the `.sqlx` offline cache (one new agaric-engine query; the root
  cache already held the identical text) regenerated; `sqlx prepare --check` clean for both.

## Frontend

- New `src/lib/block-id.ts` `newBlockId()` — a self-contained canonical uppercase
  Crockford-base32 ULID (48-bit `Date.now()` MSB-first + 80 bits `crypto.getRandomValues`),
  byte-compatible with the Rust `ulid` crate. **No npm dependency** (avoids
  shared-node_modules/lockfile churn).
- `createBelow` (`page-blocks-reducers.ts`) mints the ULID, provisional-splices the new
  `FlatBlock` synchronously pre-await via PR1's `applyProvisionalMove`, fires
  `createBlock({ blockId })`, then confirms in place on success
  (`reconcileProvisionalMoveSuccess` — no id swap, so focus/selection never move) or rolls
  back on error (`rollbackProvisionalMove` — exact restore, or reload if a concurrent op
  built on the provisional block). Returns the stable client id. `tauri.ts` + the tauri-mock
  honor `blockId`. The now-dead `applyStructuralMove` helper is removed.

## Review

Adversarial review's priority check: the FE unit tests **mock** `newBlockId`, so the real
generator's cross-language format agreement was unverified — a mismatch would silently break
every production create. The reviewer ran the **real** `newBlockId()` via node, hardcoded 6
actual outputs into a Rust test (`from_string_accepts_real_frontend_new_block_id_output_2849`,
`agaric-core/src/ulid/tests.rs`), and proved each parses canonically through
`BlockId::from_string` and the IPC `Deserialize` path. It also caught a real red the build
left behind (`tauri.test.ts` assertions missing the now-always-present `blockId: null`) and
fixed it. Confirmed collision-vs-all-rows (no `deleted_at` filter), TOCTOU safety, the
call-site sweep (arg order/position), no double-insert on create-reconcile, and
`.sqlx`/bindings hygiene.

## Verification

186 Rust tests (5 new `create_block` `_2849` + the round-trip test) + 2811 vitest +
`cargo clippy --workspace -D warnings` clean + `sqlx prepare --check` (root + agaric-engine)
clean + `tsc -b` clean + `oxlint` clean + 5 Playwright e2e (`block-keyboard-fundamentals`,
incl. Enter/create-below) green.

## Docs

`docs/FEATURE-MAP.md` (optimistic block-writes / client-ULID create row) +
`src-tauri/src/commands/AGENTS.md` write-path note.
