//! #1683 — B2/B3/B4/B5 property tests over the materializer apply / reproject
//! pipeline (op-log entry → engine apply → `project_*_to_sql` →
//! `reproject_dense_positions`).
//!
//! The existing convergence proptests (`loro::engine_proptest`) stop at the
//! engine read-back and never reproject SQL, so a post-merge reprojection bug
//! (the #891 class) slips through them. These tests close that gap by driving
//! randomly generated, structurally valid op chains (from the shared
//! `proptest_db_harness`) all the way through the **production engine apply
//! path** and asserting on the **settled materialized SQL state**.
//!
//! ## Why the engine path is guaranteed (the #891 false-green trap)
//!
//! A test that applies ops WITHOUT `agaric_engine::loro::shared::install_for_test()`
//! silently runs the `apply_*_sql_only` FALLBACK, whose provisional positions
//! differ from production — so it would never see a reprojection bug. Every
//! test here therefore:
//!
//! * `install_for_test()`s the process-global Loro engine and `registry.clear()`s
//!   it per case (the shared-registry isolation contract — run under
//!   `cargo nextest`, one process per test, never plain `cargo test`; see
//!   `loro::shared::install_for_test` and #1079);
//! * seeds a real page (with `space_id`) into BOTH SQL and the engine tree, and
//!   re-anchors every harness ROOT `CreateBlock` under that page, so
//!   `resolve_block_space` always resolves and ops route through
//!   `apply_*_via_loro`, not the fallback;
//! * stamps `parent_id` / `page_id` / `space_id` after each create (mirroring
//!   `move_convergence_tests`) so the NEXT op's space resolves in-line without
//!   waiting on the deferred `SetBlockPageId` background task; and
//! * asserts `sql_only_fallback::count()` did NOT advance across the whole chain
//!   — a hard, per-case guard that the production engine path actually ran.
//!
//! ## Properties
//!
//! * **B2 (apply round-trip):** after the chain settles, SQL `blocks.position`
//!   equals the engine's `children_ordered_block_ids` ranks within every sibling
//!   group — dense, gap-free, in the engine's authoritative order.
//! * **B3 (idempotent boot-replay):** re-applying the SAME op chain from a
//!   fresh boot (a cleared engine + a fresh DB, re-driven through the production
//!   `apply_op_tx` engine path) yields byte-identical materialized SQL state.
//! * **B4 (two-peer convergence):** two peers apply their own chains, exchange
//!   snapshots through the production inbound-sync path (`apply_remote` +
//!   `reproject_dense_positions`), and end with identical SQL `parent_id` /
//!   `position` / `block_links` for every block.
//! * **B5 (LOCAL == REMOTE apply parity):** the Stage-1 safety net for the
//!   #2325/#2250 apply-path collapse — the SAME op chain driven through the
//!   LOCAL command path (`apply_*_via_loro` called directly) and the REMOTE
//!   dispatcher (`apply_op_tx`) yields byte-identical `blocks` /
//!   `block_properties` / `block_links` SQL state.

use crate::db::init_pool;
use crate::proptest_db_harness::{HARNESS_DEVICE, op_chain_strategy, resolve_chain, ts_for};
use agaric_core::ulid::BlockId;
use agaric_engine::loro::projection::reproject_dense_positions;
use agaric_engine::loro::registry::LoroEngineRegistry;
use agaric_store::op::{CreateBlockPayload, DeleteBlockPayload, OpPayload, RestoreBlockPayload};
use agaric_store::op_log::{OpRecord, append_local_op_at};
use agaric_store::space::SpaceId;
use agaric_sync::sync_protocol::loro_sync::{
    ApplyOutcome, apply_remote, prepare_outgoing_for_pool,
};
use agaric_sync::sync_protocol::loro_sync_types::{LORO_SYNC_PROTOCOL_VERSION, LoroSyncMessage};
use proptest::prelude::*;
use sqlx::SqlitePool;
use std::collections::BTreeMap;
use tempfile::TempDir;
use tokio::runtime::Runtime;

use super::sql_only_fallback;
use super::{
    apply_op_projected, apply_op_tx, dispatch_delete_descendants, dispatch_restore_ancestors,
    dispatch_restore_descendants,
};

/// Low case counts keep the suite fast (the apply pipeline is DB-bound). Bump
/// locally via `PROPTEST_CASES` for a deeper search.
const B2_CASES: u32 = 48;
const B3_CASES: u32 = 32;
const B4_CASES: u32 = 32;
/// B5 (LOCAL-vs-REMOTE apply parity) drives the same chain twice per case, so
/// keep the budget in line with B3.
const B5_CASES: u32 = 32;

/// Short op chains: a handful of ops already exercises create / edit / move /
/// property interleavings and keeps shrunk counter-examples small.
const CHAIN_LEN: std::ops::RangeInclusive<usize> = 1..=14;

/// Fixed test-space + page ids (26-char ULID shape). The page roots every
/// harness chain so `resolve_block_space` succeeds and the engine path engages.
const SPACE_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PAGE_ID: &str = "01HZ0000000000000000001683";
/// #2325/#2250 B5 tag coverage: the single real `tag` block every remapped
/// `AddTag`/`RemoveTag` edge points at (satisfies `block_tags.tag_id REFERENCES
/// blocks(id)`). Same 26-char ULID shape as `tag_convergence_tests::TAG_ID`.
const TAG_ID: &str = "01HZ0000000000000000TAGTAG";

async fn fresh_pool(name: &str) -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let pool = init_pool(&dir.path().join(format!("{name}.db")))
        .await
        .unwrap();
    (pool, dir)
}

/// Register the test space (`blocks` row + `spaces` FK target) in a fresh DB.
async fn seed_space_row(pool: &SqlitePool) {
    // The space block itself carries `space_id = NULL` (membership is itself);
    // a self-referencing `space_id` would violate the `blocks.space_id
    // REFERENCES blocks(id)` FK at insert time. The `blocks` row must exist
    // before the `spaces` row (`spaces.id REFERENCES blocks(id)`, migration
    // 0089), so insert it first.
    // dynamic-sql: test-only harness seed/readback (not a production query path)
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', 'TestSpace', NULL, 1, ?)",
    )
    .bind(SPACE_ID)
    .bind(SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
    // dynamic-sql: test-only harness seed/readback (not a production query path)
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(SPACE_ID)
        .execute(pool)
        .await
        .unwrap();
}

/// Seed the rooting page into BOTH the per-space engine tree AND SQL so every
/// harness root create can be re-anchored under it and route through the engine.
///
/// The page is seeded DIRECTLY into the engine (`engine.apply_create_block`),
/// mirroring `conformance::seed_block_into_engine`, NOT through the op apply
/// path: a page create's space resolves against itself, and at page-create time
/// the space is not yet registered, so the op path would take the SQL-only
/// fallback and leave the page ABSENT from the engine tree — which then makes
/// every child create land at the engine root instead of under the page. The
/// caller must have run [`seed_space_row`] first (registers SPACE_ID + the space
/// block) so `for_space` resolves and the child creates' `resolve_block_space`
/// succeeds via the page's stamped `space_id`.
async fn seed_page_via_engine(
    pool: &SqlitePool,
    state: &agaric_engine::loro::shared::LoroState,
    device_id: &str,
) {
    let space = SpaceId::from_trusted(SPACE_ID);
    {
        let mut guard = state
            .registry
            .for_space(&space, device_id)
            .expect("for_space (page seed)");
        guard
            .engine_mut()
            .apply_create_block(PAGE_ID, "page", "page", None, 1)
            .expect("seed page into engine");
    }
    // dynamic-sql: test-only harness seed/readback (not a production query path)
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', 'page', NULL, 1, ?, ?)",
    )
    .bind(PAGE_ID)
    .bind(PAGE_ID)
    .bind(SPACE_ID)
    .execute(pool)
    .await
    .expect("seed page row");
}

/// Prepare a resolved harness chain for the engine apply path.
///
/// Kept ops — the ones that drive the **position-reprojection** pipeline these
/// tests target: `CreateBlock`, `EditBlock`, `MoveBlock`, `SetProperty`,
/// `DeleteProperty`, and — **#2681** — `DeleteBlock` / `RestoreBlock`. Every
/// root create / root move (`parent_id == None`) is re-anchored under
/// [`PAGE_ID`] so `resolve_block_space` always succeeds and the op routes
/// through `apply_*_via_loro` rather than the SQL-only fallback.
///
/// **#2681 — delete/restore are no longer dropped.** They used to be excluded
/// because the harness minted `RestoreBlock` with a placeholder
/// `deleted_at_ref = 0` (a no-op un-delete) and a restore could drop to the
/// SQL-only fallback when its space failed to resolve. The harness now (a)
/// cascades deletes in its `ChainModel` and only restores a *deleted seed whose
/// parent is live*, so `apply_restore_block_via_loro` resolves the space via the
/// live parent and STAYS on the engine path (the per-case zero-fallback guard
/// still holds), and (b) mints the REAL `deleted_at_ref = ts_for(delete_step)`.
/// The driver appends every op with `ts_for(step)`, so the `deleted_at` a
/// `DeleteBlock` stamps matches the ref a later `RestoreBlock` carries — the
/// restore is a genuine cohort un-delete. Soft-deleted blocks keep their tree
/// node + `position` in both the engine and SQL, so the dense-rank / convergence
/// assertions stay honest across the tombstone window.
///
/// Dropped ops, and why (harness artifacts, NOT #891-class reprojection bugs):
///
/// * `AddTag` / `RemoveTag` — the harness draws `tag_id` from the SAME ULID pool
///   as block ids, so a tag edge can reference a pool id that was never created.
///   The op-log accepts it; the materializer rejects it
///   (`block_tags.tag_id REFERENCES blocks(id)`, an FK violation). Tags do not
///   affect `parent_id` / `position` / `block_links`, so the B2/B3/B4 sibling-
///   order + link assertions do not need them — and a tag block seeded under
///   [`PAGE_ID`] would pollute B2's full-SQL-child-list-vs-engine-order check.
///   **#2325/#2250:** the B5 LOCAL-vs-REMOTE parity property DOES now cover
///   tags — it uses [`prepare_chain_b5`] instead, which RETAINS the tag ops and
///   remaps their `tag_id` to the seeded [`TAG_ID`].
/// * `PurgeBlock` — dropped from these reprojection / LOCAL-vs-REMOTE parity
///   properties, but NO LONGER because it forces the engine's SQL-only arm.
///   #2868 fixed `apply_purge_block_via_loro` to resolve a soft-deleted block's
///   space via `resolve_soft_deleted_block_space` (the `deleted_at IS NULL`
///   filter in the canonical `resolve_block_space` USED to force the SQL-only
///   cascade + a `sql_only_fallback`), so a remote purge now runs the engine
///   arm with a ZERO fallback delta. Purge still stays out of these chains for
///   STRUCTURAL reasons: it is TERMINAL (removes the block + its subtree, so
///   later generated ops that reference it are invalidated) and its LOCAL path
///   is the dedicated `purge_block_inner` COMMAND — not `apply_op_tx` — so it
///   cannot join the shared apply-kernel LOCAL/REMOTE parity drive these
///   properties use. Dedicated engine-tombstone coverage for the fixed remote
///   path lives in `engine_path_tests::\
///   apply_op_tx_remote_purge_of_soft_deleted_block_clears_engine_tombstone_2868`;
///   engine-layer purge mechanics in `loro::engine_proptest`'s `Purge` arm;
///   plus the B1 NonReversible classification.
/// * `AddAttachment` / `DeleteAttachment` — attachment apply writes the
///   `attachments` table + touches the filesystem (`fs_path`) and does not
///   affect `parent_id` / `position` / `block_links` / `block_properties`, so it
///   is orthogonal to the reprojection pipeline these tests target. Attachment
///   coverage lives in the B1 inverse-law property.
fn prepare_chain(payloads: Vec<OpPayload>) -> Vec<OpPayload> {
    payloads
        .into_iter()
        .filter(|p| {
            !matches!(
                p,
                OpPayload::AddTag(_)
                    | OpPayload::RemoveTag(_)
                    | OpPayload::PurgeBlock(_)
                    | OpPayload::AddAttachment(_)
                    | OpPayload::DeleteAttachment(_)
            )
        })
        .map(|p| match p {
            OpPayload::CreateBlock(mut c) if c.parent_id.is_none() => {
                c.parent_id = Some(BlockId::from_trusted(PAGE_ID));
                OpPayload::CreateBlock(c)
            }
            OpPayload::MoveBlock(mut m) if m.new_parent_id.is_none() => {
                m.new_parent_id = Some(BlockId::from_trusted(PAGE_ID));
                OpPayload::MoveBlock(m)
            }
            other => other,
        })
        .collect()
}

/// #2325/#2250 — B5-only variant of [`prepare_chain`] that RETAINS
/// `AddTag`/`RemoveTag` so the LOCAL-vs-REMOTE parity property covers the tag
/// projection + inheritance fan-out.
///
/// Each tag edge's `tag_id` is remapped to the seeded [`TAG_ID`] (the harness
/// draws `tag_id` from the block-id pool, so an un-remapped edge would
/// FK-violate `block_tags.tag_id`). The tagged `block_id` is left untouched —
/// the harness always targets a live block (`ChainModel::live_ids()`), and by
/// the time an `AddTag` runs that block is stamped with `page_id`/`space_id`
/// (both drivers stamp on create), so `resolve_block_space` succeeds and the tag
/// stays on the ENGINE path (no `sql_only` fallback).
///
/// **#2681:** `DeleteBlock` / `RestoreBlock` are now RETAINED (the harness mints
/// valid `deleted_at_ref`s and the driver appends with `ts_for(step)` so the
/// LOCAL and REMOTE drives stamp the SAME deterministic `deleted_at`, keeping
/// the `read_blocks_full` `deleted_at` column byte-identical between the two
/// paths). Only `PurgeBlock` (TERMINAL + a distinct LOCAL command path, not the
/// shared apply kernel — see [`prepare_chain`]; no longer an engine-side
/// SQL-only concern since #2868) and the attachment ops (FS-touching, off the
/// projection path) are dropped; B5 asserts a zero `sql_only_fallback` delta, so
/// a stray fallback would fail the property.
fn prepare_chain_b5(payloads: Vec<OpPayload>) -> Vec<OpPayload> {
    payloads
        .into_iter()
        .filter(|p| {
            !matches!(
                p,
                OpPayload::PurgeBlock(_)
                    | OpPayload::AddAttachment(_)
                    | OpPayload::DeleteAttachment(_)
            )
        })
        .map(|p| match p {
            OpPayload::CreateBlock(mut c) if c.parent_id.is_none() => {
                c.parent_id = Some(BlockId::from_trusted(PAGE_ID));
                OpPayload::CreateBlock(c)
            }
            OpPayload::MoveBlock(mut m) if m.new_parent_id.is_none() => {
                m.new_parent_id = Some(BlockId::from_trusted(PAGE_ID));
                OpPayload::MoveBlock(m)
            }
            OpPayload::AddTag(mut a) => {
                a.tag_id = BlockId::from_trusted(TAG_ID);
                OpPayload::AddTag(a)
            }
            OpPayload::RemoveTag(mut r) => {
                r.tag_id = BlockId::from_trusted(TAG_ID);
                OpPayload::RemoveTag(r)
            }
            other => other,
        })
        .collect()
}

/// #2325/#2250 — seed the single real `tag` block ([`TAG_ID`]) into `pool`'s
/// SQL so B5's remapped `AddTag`/`RemoveTag` edges satisfy the
/// `block_tags.tag_id REFERENCES blocks(id)` FK.
///
/// SQL-only on purpose: the engine's `apply_add_tag` stores the tag id as a
/// plain value in the TAGGED block's tag-map slot (it does NOT require the tag
/// to be a tree node — see `LoroEngine::apply_add_tag`), so no engine seed is
/// needed, and keeping the tag OUT of the engine tree also keeps it out of
/// `PAGE_ID`'s child-order reprojection. Seeded IDENTICALLY into both B5 pools,
/// so it is symmetric in the LOCAL-vs-REMOTE comparison. Parent/page NULL so it
/// never appears as a sibling of the chain's `PAGE_ID` children.
async fn seed_tag(pool: &SqlitePool) {
    // dynamic-sql: test-only harness seed/readback (not a production query path)
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'tag', 'tag', NULL, 0, NULL, ?)",
    )
    .bind(TAG_ID)
    .bind(SPACE_ID)
    .execute(pool)
    .await
    .expect("seed TAG_ID row");
}

/// Drives a prepared op chain through the production engine apply path.
struct ChainDriver {
    /// Device id every op is appended under — drives the engine's per-space Loro
    /// peer id (`for_space(space, device_id)`). Distinct device ids give B4's two
    /// peers distinct Loro op-spaces so their independent edits merge cleanly
    /// (a shared device id would fork — #792 — and request snapshot fallback).
    device_id: String,
    /// #2681: per-op chain step, incremented on every `drive` / `drive_local`
    /// call. Each op is appended with `ts_for(step)` so its `created_at` — and,
    /// for `DeleteBlock`, the `deleted_at` it stamps — is DETERMINISTIC and
    /// identical across boots (B3) and across the LOCAL/REMOTE drives (B5). This
    /// is what makes a later `RestoreBlock`'s `deleted_at_ref` (minted by the
    /// harness as `ts_for(delete_step)`) match the stamped `deleted_at`, so the
    /// restore is a real cohort un-delete rather than a silent no-op. The
    /// counter is the driver's own POST-filter op index (`prepare_chain` drops
    /// some ops after the model resolved them, so this need not equal the
    /// harness `ChainModel::step`). Because of that decoupling the restore's
    /// `deleted_at_ref` is patched at drive time from [`Self::delete_ts`] rather
    /// than trusted from the payload.
    step: usize,
    /// #2681: the deterministic `deleted_at` (`ts_for(step)`) the driver stamped
    /// for the most recent `DeleteBlock` of each block id. A following
    /// `RestoreBlock` for that id has its `deleted_at_ref` OVERWRITTEN with this
    /// value so the SQL cohort restore's `WHERE deleted_at = ?` guard matches
    /// the row the delete actually stamped — turning the restore from a silent
    /// no-op into a real un-delete. Identical across boots (B3) and across the
    /// LOCAL/REMOTE drives (B5) because both replay the SAME filtered payload
    /// list with the SAME `ts_for(index)` schedule.
    delete_ts: BTreeMap<String, i64>,
}

impl ChainDriver {
    fn new(device_id: &str) -> Self {
        Self {
            device_id: device_id.to_owned(),
            step: 0,
            delete_ts: BTreeMap::new(),
        }
    }

    /// Assign the deterministic `created_at` for the next op (advancing the
    /// step), and reconcile delete/restore timestamps: record the stamp a
    /// `DeleteBlock` will apply, and patch a `RestoreBlock`'s `deleted_at_ref`
    /// to the stamp its target's delete used.
    fn next_ts(&mut self, payload: &mut OpPayload) -> i64 {
        let ts = ts_for(self.step);
        self.step += 1;
        match payload {
            OpPayload::DeleteBlock(p) => {
                self.delete_ts.insert(p.block_id.as_str().to_owned(), ts);
            }
            OpPayload::RestoreBlock(p) => {
                if let Some(&stamped) = self.delete_ts.get(p.block_id.as_str()) {
                    p.deleted_at_ref = stamped;
                }
            }
            _ => {}
        }
        ts
    }

    /// Append `payload` to the op_log and apply it through `apply_op_tx` in its
    /// own tx (the production engine path). After a create, stamp the new
    /// block's `parent_id`/`page_id`/`space_id` so the NEXT op resolves a space
    /// in-line (the discipline `move_convergence_tests` uses).
    async fn drive(
        &mut self,
        pool: &SqlitePool,
        state: &agaric_engine::loro::shared::LoroState,
        mut payload: OpPayload,
    ) {
        let ts = self.next_ts(&mut payload);
        let created: Option<(String, String)> = match &payload {
            OpPayload::CreateBlock(c) => Some((
                c.block_id.as_str().to_owned(),
                c.parent_id
                    .as_ref()
                    .map_or_else(|| PAGE_ID.to_owned(), |p| p.as_str().to_owned()),
            )),
            _ => None,
        };

        let record = append_local_op_at(pool, &self.device_id, payload, ts)
            .await
            .expect("append op");

        let mut tx = pool.begin().await.expect("begin apply");
        let effects = apply_op_tx(&mut tx, &record, None, state)
            .await
            .expect("apply op");
        tx.commit().await.expect("commit apply");

        // #2681: mirror `apply_op`'s post-commit engine cohort fan-out. The
        // in-tx `apply_*_via_loro` delete/restore is per-block-id only (it
        // touches just the SEED in the engine), while the SQL projection cascades
        // to the whole descendant cohort (and, for restore, the #1884 ancestor
        // chain). Without replaying that cascade onto the engine, a
        // cascade-deleted descendant stays engine-LIVE while SQL-deleted — which
        // the #1257 outbound freshness gate (B4's snapshot export) correctly
        // REFUSES. Running the same three fan-outs `apply_op` runs keeps the
        // engine and SQL cohort state in agreement.
        dispatch_restore_descendants(pool, &record, &effects.restored_cohort, state).await;
        dispatch_restore_ancestors(pool, &record, &effects.restored_ancestors, state).await;
        dispatch_delete_descendants(
            &record,
            &effects.deleted_cohort,
            effects.delete_space_id.as_ref(),
            state,
        )
        .await;

        if let Some((id, parent)) = created {
            // The engine read-back projected at create time can leave
            // `blocks.parent_id` / `page_id` / `space_id` NULL (the engine tracks
            // parentage in its Loro tree; these SQL columns are reconciled
            // post-commit by a deferred bg task in production). The next op on
            // this block must resolve a space in-line, so stamp them here. Every
            // harness block lives under PAGE_ID's subtree ⇒ page_id == PAGE_ID,
            // space_id == SPACE_ID. This makes the NEXT op on the block resolve a
            // space and
            // take the engine path.
            // dynamic-sql: test-only harness seed/readback (not a production query path)
            sqlx::query("UPDATE blocks SET parent_id = ?, page_id = ?, space_id = ? WHERE id = ?")
                .bind(&parent)
                .bind(PAGE_ID)
                .bind(SPACE_ID)
                .bind(&id)
                .execute(pool)
                .await
                .expect("stamp created block space");
        }
    }

    /// Drive `payload` through the LOCAL command path: call the matching
    /// `apply_*_via_loro` helper DIRECTLY inside a tx — exactly as the command
    /// handlers do inside their `CommandTx` — instead of dispatching through
    /// `apply_op_tx`, and deliberately WITHOUT advancing the apply cursor
    /// (#1257). The op is still appended to the op_log (as the LOCAL path does
    /// in production) so both drivers see an identical log, but the projection
    /// is driven by the direct helper call. The post-create space stamp is
    /// identical to [`ChainDriver::drive`], so the two entry points resolve
    /// spaces the same way and any divergence must come from the apply path
    /// itself.
    async fn drive_local(
        &mut self,
        pool: &SqlitePool,
        state: &agaric_engine::loro::shared::LoroState,
        mut payload: OpPayload,
    ) {
        use super::loro_apply;

        let ts = self.next_ts(&mut payload);
        let created: Option<(String, String)> = match &payload {
            OpPayload::CreateBlock(c) => Some((
                c.block_id.as_str().to_owned(),
                c.parent_id
                    .as_ref()
                    .map_or_else(|| PAGE_ID.to_owned(), |p| p.as_str().to_owned()),
            )),
            _ => None,
        };

        // Append for parity with the REMOTE driver (keeps the op_log identical);
        // the LOCAL path does not consult the cursor and does not advance it.
        // #2681: same deterministic `ts_for(step)` as `drive`, so a `DeleteBlock`
        // stamps an IDENTICAL `deleted_at` on both the LOCAL and REMOTE pools
        // (B5 compares that column byte-for-byte). `ts` was assigned (and the
        // restore ref patched) by `next_ts` above.
        append_local_op_at(pool, &self.device_id, payload.clone(), ts)
            .await
            .expect("append op");

        let mut tx = pool.begin().await.expect("begin apply");
        // prepare_chain retains only these five op kinds, mirroring the command
        // handlers that call the via_loro helpers directly on the LOCAL path.
        match &payload {
            OpPayload::CreateBlock(p) => {
                // #2896: `None` reprojection sink = `ApplyMode::Normal` (inline
                // reproject), matching the LOCAL command path these mirror.
                loro_apply::apply_create_block_via_loro(
                    &mut tx,
                    state,
                    &self.device_id,
                    p,
                    None,
                    None,
                )
                .await
                .expect("local create_block");
            }
            OpPayload::EditBlock(p) => {
                loro_apply::apply_edit_block_via_loro(&mut tx, state, &self.device_id, p)
                    .await
                    .expect("local edit_block");
            }
            OpPayload::MoveBlock(p) => {
                loro_apply::apply_move_block_via_loro(&mut tx, state, &self.device_id, p, None)
                    .await
                    .expect("local move_block");
            }
            OpPayload::SetProperty(p) => {
                loro_apply::apply_set_property_via_loro(&mut tx, state, &self.device_id, p)
                    .await
                    .expect("local set_property");
            }
            OpPayload::DeleteProperty(p) => {
                loro_apply::apply_delete_property_via_loro(&mut tx, state, &self.device_id, p)
                    .await
                    .expect("local delete_property");
            }
            // #2681: delete/restore on the LOCAL command path are bare
            // `apply_*_via_loro` calls too. `DeleteBlock` stamps `deleted_at`
            // from the passed `now` (the same deterministic `ts` the REMOTE
            // `apply_op_tx` reads off `record.created_at`), and `RestoreBlock`
            // reads its `deleted_at_ref` from the payload — identical to the
            // dispatcher path — so the projected `deleted_at` cascade is
            // byte-identical between LOCAL and REMOTE.
            OpPayload::DeleteBlock(p) => {
                loro_apply::apply_delete_block_via_loro(&mut tx, state, &self.device_id, p, ts)
                    .await
                    .expect("local delete_block");
            }
            OpPayload::RestoreBlock(p) => {
                loro_apply::apply_restore_block_via_loro(&mut tx, state, &self.device_id, p)
                    .await
                    .expect("local restore_block");
            }
            // #2325/#2250: the LOCAL AddTag/RemoveTag command path IS a bare
            // `apply_*_via_loro` call (now routed via `apply_op_projected`,
            // which for these `PreOpState::None` ops is exactly the via_loro
            // call + a no-op cursor/maintenance step), so driving the bare
            // helper here faithfully models it. Retained only by
            // `prepare_chain_b5`.
            OpPayload::AddTag(p) => {
                loro_apply::apply_add_tag_via_loro(&mut tx, state, &self.device_id, p)
                    .await
                    .expect("local add_tag");
            }
            OpPayload::RemoveTag(p) => {
                loro_apply::apply_remove_tag_via_loro(&mut tx, state, &self.device_id, p)
                    .await
                    .expect("local remove_tag");
            }
            other => panic!("drive_local: op not retained by prepare_chain_b5: {other:?}"),
        }
        tx.commit().await.expect("commit apply");

        if let Some((id, parent)) = created {
            // Same post-create space stamp as `drive` (see its comment).
            // dynamic-sql: test-only harness seed/readback (not a production query path)
            sqlx::query("UPDATE blocks SET parent_id = ?, page_id = ?, space_id = ? WHERE id = ?")
                .bind(&parent)
                .bind(PAGE_ID)
                .bind(SPACE_ID)
                .bind(&id)
                .execute(pool)
                .await
                .expect("stamp created block space");
        }
    }
}

/// Read every block's `(parent_id, position)`, excluding the synthetic space
/// row, ordered by id — the canonical materialized shape compared across boots
/// / peers.
async fn read_block_positions(pool: &SqlitePool) -> Vec<(String, Option<String>, Option<i64>)> {
    // dynamic-sql: test-only harness seed/readback (not a production query path)
    sqlx::query_as::<_, (String, Option<String>, Option<i64>)>(
        "SELECT id, parent_id, position FROM blocks WHERE id <> ? ORDER BY id",
    )
    .bind(SPACE_ID)
    .fetch_all(pool)
    .await
    .expect("read block positions")
}

/// Read all `block_links` rows, ordered — compared across peers in B4.
async fn read_block_links(pool: &SqlitePool) -> Vec<(String, String)> {
    // dynamic-sql: test-only harness seed/readback (not a production query path)
    sqlx::query_as::<_, (String, String)>(
        "SELECT source_id, target_id FROM block_links ORDER BY source_id, target_id",
    )
    .fetch_all(pool)
    .await
    .expect("read block_links")
}

/// #2325/#2250 — read every `block_tags` edge, ordered. Used by B5 to compare
/// direct tag projection across the LOCAL and REMOTE apply paths.
async fn read_block_tags(pool: &SqlitePool) -> Vec<(String, String)> {
    // dynamic-sql: test-only harness seed/readback (not a production query path)
    sqlx::query_as::<_, (String, String)>(
        "SELECT block_id, tag_id FROM block_tags ORDER BY block_id, tag_id",
    )
    .fetch_all(pool)
    .await
    .expect("read block_tags")
}

/// #2325/#2250 — read every `block_tag_inherited` row (the tag-inheritance
/// fan-out that propagates a parent's tag onto its descendant subtree),
/// ordered. Used by B5 to compare the inheritance fan-out across the LOCAL and
/// REMOTE apply paths.
async fn read_block_tag_inherited(pool: &SqlitePool) -> Vec<(String, String, String)> {
    // dynamic-sql: test-only harness seed/readback (not a production query path)
    sqlx::query_as::<_, (String, String, String)>(
        "SELECT block_id, tag_id, inherited_from FROM block_tag_inherited \
         ORDER BY block_id, tag_id, inherited_from",
    )
    .fetch_all(pool)
    .await
    .expect("read block_tag_inherited")
}

/// Read every block's full materialized shape (excluding the synthetic space
/// row), ordered by id — used by B5 to compare tree + position + content +
/// soft-delete state across the LOCAL and REMOTE apply paths.
#[allow(clippy::type_complexity)]
async fn read_blocks_full(
    pool: &SqlitePool,
) -> Vec<(
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<i64>,
)> {
    // dynamic-sql: test-only harness seed/readback (not a production query path)
    sqlx::query_as::<
        _,
        (
            String,
            Option<String>,
            Option<i64>,
            Option<String>,
            Option<i64>,
        ),
    >(
        "SELECT id, parent_id, position, content, deleted_at FROM blocks \
         WHERE id <> ? ORDER BY id",
    )
    .bind(SPACE_ID)
    .fetch_all(pool)
    .await
    .expect("read blocks full")
}

/// Read every `block_properties` row (typed columns), ordered — used by B5 to
/// compare property projection across the LOCAL and REMOTE apply paths.
#[allow(clippy::type_complexity)]
async fn read_block_properties(
    pool: &SqlitePool,
) -> Vec<(
    String,
    String,
    Option<String>,
    Option<f64>,
    Option<String>,
    Option<String>,
)> {
    // dynamic-sql: test-only harness seed/readback (not a production query path)
    sqlx::query_as::<
        _,
        (
            String,
            String,
            Option<String>,
            Option<f64>,
            Option<String>,
            Option<String>,
        ),
    >(
        "SELECT block_id, key, value_text, value_num, value_date, value_ref \
         FROM block_properties ORDER BY block_id, key",
    )
    .fetch_all(pool)
    .await
    .expect("read block_properties")
}

/// The distinct set of parent groups present in SQL (including the NULL/root
/// group and PAGE_ID's group), used to reproject + check dense ranks.
async fn distinct_parents(pool: &SqlitePool) -> Vec<Option<String>> {
    // dynamic-sql: test-only harness seed/readback (not a production query path)
    sqlx::query_as::<_, (Option<String>,)>("SELECT DISTINCT parent_id FROM blocks WHERE id <> ?")
        .bind(SPACE_ID)
        .fetch_all(pool)
        .await
        .expect("distinct parents")
        .into_iter()
        .map(|r| r.0)
        .collect()
}

proptest! {
    #![proptest_config(ProptestConfig { cases: B2_CASES, .. ProptestConfig::default() })]

    /// **B2 — apply round-trip.** After driving a random op chain through the
    /// real apply+settle path, SQL `blocks.position` equals the engine's
    /// `children_ordered_block_ids` ranks within each sibling group (dense,
    /// gap-free, matching order). Proves the materializer's projected position
    /// is the engine's authoritative dense rank — the #891 invariant.
    #[test]
    fn b2_apply_round_trip_position_matches_engine_rank(
        sketches in op_chain_strategy(CHAIN_LEN),
    ) {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let state = &agaric_engine::loro::shared::LoroState::new();

            let (pool, _dir) = fresh_pool("b2").await;
            seed_space_row(&pool).await;
            seed_page_via_engine(&pool, state, HARNESS_DEVICE).await;

            let fallback_before = sql_only_fallback::count();

            let payloads = prepare_chain(resolve_chain(&sketches));
            let mut driver = ChainDriver::new(HARNESS_DEVICE);
            for payload in payloads {
                driver.drive(&pool, state, payload).await;
            }

            // ENGINE-PATH GUARD (#891): no op silently degraded to sql_only.
            prop_assert_eq!(
                sql_only_fallback::count() - fallback_before,
                0,
                "an op took the SQL-only FALLBACK — the test is false-green (not the engine path)"
            );

            // For every parent group, the engine's authoritative child order
            // must equal SQL position order, AND positions must be dense 1..=N.
            let space = SpaceId::from_trusted(SPACE_ID);
            let parents = distinct_parents(&pool).await;
            for parent in parents {
                let engine_order: Vec<String> = {
                    let mut guard = state.registry.for_space(&space, HARNESS_DEVICE)
                        .expect("for_space");
                    guard.engine_mut()
                        .children_ordered_block_ids(parent.as_deref())
                        .expect("children_ordered_block_ids")
                };
                if engine_order.is_empty() {
                    continue;
                }
                // SQL siblings of `parent`, ordered by position then id.
// dynamic-sql: test-only harness seed/readback (not a production query path)
                let sql_rows = sqlx::query_as::<_, (String, Option<i64>)>(
                    "SELECT id, position FROM blocks \
                     WHERE id <> ?1 \
                       AND ((?2 IS NULL AND parent_id IS NULL) OR parent_id = ?2) \
                     ORDER BY position ASC, id ASC",
                )
                .bind(SPACE_ID)
                .bind(parent.as_deref())
                .fetch_all(&pool)
                .await
                .expect("sql siblings");

                let sql_ids: Vec<String> = sql_rows.iter().map(|(id, _)| id.clone()).collect();
                prop_assert_eq!(
                    &sql_ids,
                    &engine_order,
                    "SQL sibling order != engine children_ordered for parent {:?}", parent
                );
                let sql_positions: Vec<i64> =
                    sql_rows.iter().map(|(_, p)| p.expect("every sibling has a position")).collect();
                let n = i64::try_from(sql_positions.len()).expect("sibling count fits in i64");
                let dense: Vec<i64> = (1..=n).collect();
                prop_assert_eq!(
                    sql_positions,
                    dense,
                    "SQL positions not dense 1..=N for parent {:?}", parent
                );
            }
            Ok(())
        })?;
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: B3_CASES, .. ProptestConfig::default() })]

    /// **B3 — idempotent boot-replay.** The same op chain re-applied from a
    /// fresh boot (a cleared engine + a fresh DB, re-driven through the
    /// production `apply_op_tx` engine path) yields byte-identical materialized
    /// SQL `(parent_id, position)` for every block. A reprojection bug that
    /// depended on residual engine/SQL state from the first apply (rather than
    /// the op log alone — a #891-class divergence) would surface here.
    #[test]
    fn b3_boot_replay_is_idempotent(
        sketches in op_chain_strategy(CHAIN_LEN),
    ) {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let state = &agaric_engine::loro::shared::LoroState::new();

            // Resolve the op chain ONCE so both boots replay the IDENTICAL
            // payloads (same block ULIDs) — `resolve_chain` mints a fresh ULID
            // pool per call, so resolving twice would produce different ids and
            // the comparison would be meaningless.
            let payloads = prepare_chain(resolve_chain(&sketches));

            // --- First boot: apply the chain through the live pipeline. ---
            state.registry.clear();
            let (pool_a, _dir_a) = fresh_pool("b3a").await;
            seed_space_row(&pool_a).await;
            seed_page_via_engine(&pool_a, state, HARNESS_DEVICE).await;

            let fallback_before = sql_only_fallback::count();
            let mut driver_a = ChainDriver::new(HARNESS_DEVICE);
            for payload in payloads.clone() {
                driver_a.drive(&pool_a, state, payload).await;
            }
            prop_assert_eq!(
                sql_only_fallback::count() - fallback_before,
                0,
                "B3 first boot took the SQL-only fallback"
            );
            let first = read_block_positions(&pool_a).await;

            // --- Fresh boot: a clean DB + a CLEARED engine, then re-apply the
            //     SAME resolved op chain in seq order through the production
            //     engine apply path. This models a boot that rebuilds the
            //     per-space engine tree and re-materializes SQL from the op log,
            //     from scratch. A #891-class reprojection bug whose outcome
            //     depended on residual engine/SQL state from the first apply (as
            //     opposed to the op log alone) would surface here as a mismatch.
            //
            //     We re-drive through `append_and_apply` (the real `apply_op_tx`
            //     engine path) rather than `replay_unmaterialized_ops`: the
            //     foreground-only boot-replay walk runs no deferred
            //     space-propagation task mid-walk, so for this synthetic
            //     non-`is_space` page the replayed child ops cannot resolve a
            //     space in-line and would silently fall to the SQL-only fallback
            //     — making the comparison apply-path-vs-fallback, not a genuine
            //     idempotency check. Driving both boots through the identical
            //     engine path keeps the property honest (and the per-case
            //     fallback-count guard below proves neither boot degraded).
            state.registry.clear();
            let (pool_b, _dir_b) = fresh_pool("b3b").await;
            seed_space_row(&pool_b).await;
            seed_page_via_engine(&pool_b, state, HARNESS_DEVICE).await;

            let replay_fallback_before = sql_only_fallback::count();
            let mut driver_b = ChainDriver::new(HARNESS_DEVICE);
            for payload in payloads {
                driver_b.drive(&pool_b, state, payload).await;
            }
            prop_assert_eq!(
                sql_only_fallback::count() - replay_fallback_before,
                0,
                "B3 fresh boot took the SQL-only fallback"
            );

            let replayed = read_block_positions(&pool_b).await;

            prop_assert_eq!(
                first,
                replayed,
                "boot-replay produced different materialized SQL state than the live apply"
            );
            Ok(())
        })?;
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: B4_CASES, .. ProptestConfig::default() })]

    /// **B4 — two-peer convergence to identical SQL.** Two peers each apply
    /// their own random chain through the production engine path, then exchange
    /// full snapshots through the production inbound-sync path
    /// (`apply_remote` → `import_and_project` → `reproject_dense_positions`).
    /// After both peers have imported the other's snapshot and reprojected,
    /// their SQL `parent_id` / `position` / `block_links` must be identical for
    /// every block. This is the #891-class merge property the engine-only
    /// convergence proptests cannot see (they never reproject SQL).
    #[test]
    fn b4_two_peer_snapshot_exchange_converges_sql(
        sketches_a in op_chain_strategy(CHAIN_LEN),
        sketches_b in op_chain_strategy(CHAIN_LEN),
    ) {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let state = &agaric_engine::loro::shared::LoroState::new();

            // --- Shared common ancestor: the rooting page, created ONCE. ---
            // Both peers start from this same base snapshot so the page node has
            // ONE Loro identity across peers. Without a shared base, each peer
            // would create its own page node with the same id but a different
            // (peer, counter) — an own-peer fork (#792) that `apply_remote`
            // answers with SnapshotFallbackRequested instead of merging.
            let base = build_base_snapshot(state).await;

            // --- Each peer applies its OWN chain on top of the shared base,
            //     under a DISTINCT device id (⇒ distinct Loro peer id). ---
            let snap_a = build_peer_snapshot(state, "b4a", "peer-A", &base, &sketches_a).await?;
            let snap_b = build_peer_snapshot(state, "b4b", "peer-B", &base, &sketches_b).await?;

            // --- Peer A's final pool: import A then B through apply_remote. ---
            let (pool_a, _dir_a) = fresh_pool("b4-final-a").await;
            seed_space_row(&pool_a).await;
            let reg_a = LoroEngineRegistry::new();
            merge_snapshot(&pool_a, &reg_a, "peer-A", &snap_a).await?;
            merge_snapshot(&pool_a, &reg_a, "peer-A", &snap_b).await?;
            reproject_all_groups(&pool_a, &reg_a, "peer-A").await;

            // --- Peer B's final pool: import B then A through apply_remote. ---
            let (pool_b, _dir_b) = fresh_pool("b4-final-b").await;
            seed_space_row(&pool_b).await;
            let reg_b = LoroEngineRegistry::new();
            merge_snapshot(&pool_b, &reg_b, "peer-B", &snap_b).await?;
            merge_snapshot(&pool_b, &reg_b, "peer-B", &snap_a).await?;
            reproject_all_groups(&pool_b, &reg_b, "peer-B").await;

            let a_pos = read_block_positions(&pool_a).await;
            let b_pos = read_block_positions(&pool_b).await;
            prop_assert_eq!(
                a_pos,
                b_pos,
                "two peers diverged on parent_id/position after snapshot exchange + reproject"
            );

            let a_links = read_block_links(&pool_a).await;
            let b_links = read_block_links(&pool_b).await;
            prop_assert_eq!(
                a_links,
                b_links,
                "two peers diverged on block_links after snapshot exchange"
            );
            Ok(())
        })?;
    }
}

/// Build the shared common-ancestor snapshot: a single per-space Loro doc
/// containing just the rooting page, created on the GLOBAL engine (cleared
/// first) under a dedicated base device id. Both peers import this so the page
/// shares ONE Loro identity across them.
async fn build_base_snapshot(state: &agaric_engine::loro::shared::LoroState) -> Vec<u8> {
    state.registry.clear();
    let (pool, _dir) = fresh_pool("b4-base").await;
    seed_space_row(&pool).await;
    seed_page_via_engine(&pool, state, "base-peer").await;
    let space = SpaceId::from_trusted(SPACE_ID);
    let mut guard = state
        .registry
        .for_space(&space, "base-peer")
        .expect("for_space (base export)");
    guard.engine_mut().export_snapshot().expect("export base")
}

/// Apply a peer's chain on top of the shared `base` snapshot through the
/// production engine path against the GLOBAL engine (cleared, then re-seeded
/// from `base`) + a throwaway pool, then export the per-space Loro snapshot.
/// The snapshot encodes the shared base PLUS this peer's full op history under
/// its own `device_id` (⇒ its own Loro peer id), which is what makes the two
/// peers' independent edits merge cleanly on cross-import.
async fn build_peer_snapshot(
    state: &agaric_engine::loro::shared::LoroState,
    name: &str,
    device_id: &str,
    base: &[u8],
    sketches: &[crate::proptest_db_harness::OpKind],
) -> Result<Vec<u8>, TestCaseError> {
    state.registry.clear();
    let (pool, _dir) = fresh_pool(name).await;
    seed_space_row(&pool).await;
    let space = SpaceId::from_trusted(SPACE_ID);

    // Re-seed the global engine from the shared base (page only), and mirror the
    // page into this pool's SQL so child creates resolve a space.
    {
        let mut guard = state
            .registry
            .for_space(&space, device_id)
            .expect("for_space (peer base import)");
        guard.engine_mut().import(base).expect("import base");
    }
    // dynamic-sql: test-only harness seed/readback (not a production query path)
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', 'page', NULL, 1, ?, ?)",
    )
    .bind(PAGE_ID)
    .bind(PAGE_ID)
    .bind(SPACE_ID)
    .execute(&pool)
    .await
    .expect("seed page row (peer)");

    let fallback_before = sql_only_fallback::count();
    let payloads = prepare_chain(resolve_chain(sketches));
    let mut driver = ChainDriver::new(device_id);
    for payload in payloads {
        driver.drive(&pool, state, payload).await;
    }
    prop_assert!(
        sql_only_fallback::count() - fallback_before == 0,
        "B4 peer build took the SQL-only fallback"
    );

    let msg = prepare_outgoing_for_pool(&pool, &state.registry, &space, device_id, None)
        .await
        .expect("prepare_outgoing")
        .expect("#1257 freshness gate must not refuse a consistent engine");
    let bytes = match msg {
        LoroSyncMessage::Snapshot { bytes, .. } => bytes,
        LoroSyncMessage::Update { bytes, .. } => bytes,
    };
    Ok(bytes)
}

/// Import a snapshot into `registry`'s per-space engine + project it to `pool`'s
/// SQL through the production inbound-sync path (`apply_remote`). The space row
/// must already be registered in `pool` (so `project_block_full_to_sql` can
/// stamp `space_id`).
async fn merge_snapshot(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    device_id: &str,
    bytes: &[u8],
) -> Result<(), TestCaseError> {
    let space = SpaceId::from_trusted(SPACE_ID);
    let msg = LoroSyncMessage::Snapshot {
        protocol_version: LORO_SYNC_PROTOCOL_VERSION,
        space_id: space,
        bytes: bytes.to_vec(),
    };
    let outcome = apply_remote(pool, registry, device_id, msg)
        .await
        .expect("apply_remote");
    match outcome {
        ApplyOutcome::Imported { .. } => Ok(()),
        ApplyOutcome::SnapshotFallbackRequested { reason, .. } => {
            prop_assert!(false, "apply_remote requested snapshot fallback: {reason}");
            unreachable!()
        }
    }
}

/// Reproject dense positions for EVERY parent group in `pool` from the engine's
/// authoritative child order — the explicit `reproject_dense_positions` step
/// the issue's B4 calls for, applied symmetrically on both peers so the
/// comparison reflects the reprojected (not raw-imported) ordering.
async fn reproject_all_groups(pool: &SqlitePool, registry: &LoroEngineRegistry, device_id: &str) {
    let space = SpaceId::from_trusted(SPACE_ID);
    // Gather every parent that appears in SQL (incl. NULL root + the page).
    let parents = distinct_parents(pool).await;
    // Read the engine order for each group under one guard, then write.
    let mut groups: BTreeMap<Option<String>, Vec<String>> = BTreeMap::new();
    {
        let mut guard = registry.for_space(&space, device_id).expect("for_space");
        let engine = guard.engine_mut();
        for parent in &parents {
            let order = engine
                .children_ordered_block_ids(parent.as_deref())
                .expect("children_ordered_block_ids");
            groups.insert(parent.clone(), order);
        }
    }
    let mut conn = pool.acquire().await.expect("acquire");
    for (_parent, order) in groups {
        if !order.is_empty() {
            reproject_dense_positions(&mut conn, &order)
                .await
                .expect("reproject_dense_positions");
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: B5_CASES, .. ProptestConfig::default() })]

    /// **B5 — LOCAL command path == REMOTE (`apply_op_tx`) path.** The Stage-1
    /// safety net for the #2325/#2250 apply-path collapse. Every mutating op is
    /// projected to SQL through two entry points that MUST stay byte-identical:
    ///
    /// * the **LOCAL** command path calls `apply_*_via_loro` directly inside a
    ///   `CommandTx` and deliberately does NOT advance the apply cursor (#1257);
    /// * the **REMOTE** / boot-replay path (`apply_op_tx`) dispatches by op_type
    ///   (deserializing an `OpRecord`), advances the cursor, and does
    ///   count-maintenance / cohort capture around the SAME helpers.
    ///
    /// This drives the SAME resolved op chain through BOTH entry points on TWO
    /// independently-seeded pools + freshly-cleared engines (the B3 pattern),
    /// then asserts the projected `blocks` (id / parent_id / position / content
    /// / deleted_at), `block_properties`, and `block_links` rows are identical.
    /// Today both entry points funnel into the same `apply_*_via_loro` helpers,
    /// so this pins that equivalence; when Stage 2 collapses the two paths into
    /// one `advance_cursor: bool` function, any accidental divergence (a
    /// cursor/count side-effect leaking into the projection, or a mis-mapped
    /// dispatch arm) fails here. It is not always-true: it round-trips each op
    /// through JSON serialize→deserialize→string-dispatch on the REMOTE side vs
    /// a typed direct call on the LOCAL side, on separate engines/DBs, and
    /// compares the full materialized state. The per-drive fallback-count guards
    /// assert BOTH paths ran on the engine, not the SQL-only fallback (the #891
    /// false-green trap), so the equivalence is genuinely exercised.
    #[test]
    fn b5_local_command_path_matches_remote_apply_op_tx(
        sketches in op_chain_strategy(CHAIN_LEN),
    ) {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let state = &agaric_engine::loro::shared::LoroState::new();

            // Resolve the chain ONCE so both entry points replay the IDENTICAL
            // payloads (same block ULIDs). `resolve_chain` mints a fresh ULID
            // pool per call, so resolving twice would make the comparison
            // meaningless.
            // #2325/#2250: `prepare_chain_b5` RETAINS AddTag/RemoveTag (remapped
            // to the seeded TAG_ID) so this property covers the tag projection +
            // inheritance fan-out too.
            let payloads = prepare_chain_b5(resolve_chain(&sketches));

            // --- REMOTE path: dispatch via `apply_op_tx`. ---
            state.registry.clear();
            let (pool_remote, _dir_r) = fresh_pool("b5-remote").await;
            seed_space_row(&pool_remote).await;
            seed_page_via_engine(&pool_remote, state, HARNESS_DEVICE).await;
            seed_tag(&pool_remote).await;

            let fb_remote = sql_only_fallback::count();
            let mut driver_r = ChainDriver::new(HARNESS_DEVICE);
            for payload in payloads.clone() {
                driver_r.drive(&pool_remote, state, payload).await;
            }
            prop_assert_eq!(
                sql_only_fallback::count() - fb_remote,
                0,
                "B5 REMOTE (apply_op_tx) drive took the SQL-only fallback — not the engine path"
            );
            let remote_blocks = read_blocks_full(&pool_remote).await;
            let remote_props = read_block_properties(&pool_remote).await;
            let remote_links = read_block_links(&pool_remote).await;
            let remote_tags = read_block_tags(&pool_remote).await;
            let remote_tag_inherited = read_block_tag_inherited(&pool_remote).await;

            // --- LOCAL path: call `apply_*_via_loro` directly. ---
            state.registry.clear();
            let (pool_local, _dir_l) = fresh_pool("b5-local").await;
            seed_space_row(&pool_local).await;
            seed_page_via_engine(&pool_local, state, HARNESS_DEVICE).await;
            seed_tag(&pool_local).await;

            let fb_local = sql_only_fallback::count();
            let mut driver_l = ChainDriver::new(HARNESS_DEVICE);
            for payload in payloads {
                driver_l.drive_local(&pool_local, state, payload).await;
            }
            prop_assert_eq!(
                sql_only_fallback::count() - fb_local,
                0,
                "B5 LOCAL command path drive took the SQL-only fallback — not the engine path"
            );
            let local_blocks = read_blocks_full(&pool_local).await;
            let local_props = read_block_properties(&pool_local).await;
            let local_links = read_block_links(&pool_local).await;
            let local_tags = read_block_tags(&pool_local).await;
            let local_tag_inherited = read_block_tag_inherited(&pool_local).await;

            prop_assert_eq!(
                local_blocks,
                remote_blocks,
                "LOCAL vs REMOTE apply diverged on blocks (parent/position/content/deleted_at)"
            );
            prop_assert_eq!(
                local_props,
                remote_props,
                "LOCAL vs REMOTE apply diverged on block_properties"
            );
            prop_assert_eq!(
                local_links,
                remote_links,
                "LOCAL vs REMOTE apply diverged on block_links"
            );
            // #2325/#2250: tag projection (`block_tags`) + the inheritance
            // fan-out (`block_tag_inherited`, which propagates a parent's tag to
            // its descendant subtree) must be byte-identical between the LOCAL
            // command path and the REMOTE `apply_op_tx` path.
            prop_assert_eq!(
                local_tags,
                remote_tags,
                "LOCAL vs REMOTE apply diverged on block_tags"
            );
            prop_assert_eq!(
                local_tag_inherited,
                remote_tag_inherited,
                "LOCAL vs REMOTE apply diverged on block_tag_inherited (tag inheritance fan-out)"
            );
            Ok(())
        })?;
    }
}

// ---------------------------------------------------------------------------
// #2325/#2250 — delete/restore LOCAL-vs-REMOTE parity fixture.
// ---------------------------------------------------------------------------

/// A `read_blocks_full` row: `(id, parent_id, position, content, deleted_at)`.
type BlockFullRow = (
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<i64>,
);

/// One drive's observed outcome, captured for cross-drive comparison.
struct DeleteRestoreObs {
    name: String,
    blocks: Vec<BlockFullRow>,
    links: Vec<(String, String)>,
    /// `ApplyEffects` the DeleteBlock apply returned (sorted for comparison).
    del_cohort: Vec<String>,
    del_space: Option<String>,
    /// `ApplyEffects` the RestoreBlock apply returned (sorted).
    restored_cohort: Vec<String>,
    restored_ancestors: Vec<String>,
    /// `blocks.deleted_at` for PARENT/CHILD BETWEEN the delete and the restore.
    post_delete_parent: Option<i64>,
    post_delete_child: Option<i64>,
    /// `blocks.deleted_at` for PARENT/CHILD AFTER the restore.
    post_restore_parent: Option<i64>,
    post_restore_child: Option<i64>,
    /// `sql_only_fallback::count()` delta across the delete+restore region.
    fallback_delta: u64,
    /// `materializer_apply_cursor.materialized_through_seq` after both ops.
    cursor: i64,
}

/// Build a synthetic [`OpRecord`] (the delete/restore ops are minted directly,
/// not appended to the op_log — `apply_op_projected` only reads the record's
/// fields, and a fixed `created_at` makes the stamped `deleted_at` deterministic
/// across the two independent drives).
fn synth_record(
    op_type: &str,
    payload: String,
    seq: i64,
    created_at: i64,
    block_id: &str,
) -> OpRecord {
    OpRecord {
        device_id: HARNESS_DEVICE.to_owned(),
        seq,
        parent_seqs: None,
        hash: String::new(),
        op_type: op_type.to_owned(),
        payload,
        created_at,
        block_id: Some(block_id.to_owned()),
    }
}

async fn deleted_at_of(pool: &SqlitePool, id: &str) -> Option<i64> {
    // dynamic-sql: test-only harness readback (not a production query path)
    sqlx::query_scalar::<_, Option<i64>>("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("read deleted_at")
}

/// Seed a PAGE -> PARENT -> CHILD hierarchy (identically on an independent pool)
/// and drive `DeleteBlock(PARENT)` then `RestoreBlock(PARENT, <real deleted_at>)`
/// through [`apply_op_projected`] with the given `advance_cursor`, running the
/// returned [`ApplyEffects`] fan-out on the engine exactly as `apply_op` does.
async fn run_delete_restore(
    state: &agaric_engine::loro::shared::LoroState,
    name: &str,
    parent_id: &str,
    child_id: &str,
    delete_ts: i64,
    advance_cursor: bool,
) -> DeleteRestoreObs {
    state.registry.clear();
    let (pool, _dir) = fresh_pool(name).await;
    seed_space_row(&pool).await;
    seed_page_via_engine(&pool, state, HARNESS_DEVICE).await;

    // PAGE -> PARENT -> CHILD through the production create path (append +
    // `apply_op_tx` + post-create stamp), identical on both pools. CHILD carries
    // a wiki-link to PAGE so `block_links` is non-empty (a real edge to compare).
    let mut driver = ChainDriver::new(HARNESS_DEVICE);
    driver
        .drive(
            &pool,
            state,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::from_trusted(parent_id),
                block_type: "content".to_owned(),
                parent_id: Some(BlockId::from_trusted(PAGE_ID)),
                position: Some(0),
                index: None,
                content: String::new(),
            }),
        )
        .await;
    driver
        .drive(
            &pool,
            state,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::from_trusted(child_id),
                block_type: "content".to_owned(),
                parent_id: Some(BlockId::from_trusted(parent_id)),
                position: Some(0),
                index: None,
                content: format!("[[{PAGE_ID}]]"),
            }),
        )
        .await;

    // Measured AFTER the creates, so only the delete+restore region counts.
    let fallback_before = sql_only_fallback::count();

    // --- DeleteBlock(PARENT) through the collapsed entry point. ---
    let del_record = synth_record(
        "delete_block",
        serde_json::to_string(&DeleteBlockPayload {
            block_id: BlockId::from_trusted(parent_id),
        })
        .unwrap(),
        3,
        delete_ts,
        parent_id,
    );
    let mut tx = pool.begin().await.expect("begin delete");
    let del_effects = apply_op_projected(&mut tx, &del_record, state, advance_cursor)
        .await
        .expect("delete apply_op_projected");
    tx.commit().await.expect("commit delete");
    // Cohort fan-out onto the engine (mirrors `apply_op`'s post-commit step).
    dispatch_delete_descendants(
        &del_record,
        &del_effects.deleted_cohort,
        del_effects.delete_space_id.as_ref(),
        state,
    )
    .await;

    let post_delete_parent = deleted_at_of(&pool, parent_id).await;
    let post_delete_child = deleted_at_of(&pool, child_id).await;
    // The REAL deleted_at the cascade stamped (== the delete op's created_at),
    // fed back as the restore guard.
    let stamped = post_delete_parent.expect("PARENT must be soft-deleted by DeleteBlock");

    // --- RestoreBlock(PARENT, <real deleted_at>) through the collapsed entry point. ---
    let restore_record = synth_record(
        "restore_block",
        serde_json::to_string(&RestoreBlockPayload {
            block_id: BlockId::from_trusted(parent_id),
            deleted_at_ref: stamped,
        })
        .unwrap(),
        4,
        delete_ts + 1,
        parent_id,
    );
    let mut tx = pool.begin().await.expect("begin restore");
    let restore_effects = apply_op_projected(&mut tx, &restore_record, state, advance_cursor)
        .await
        .expect("restore apply_op_projected");
    tx.commit().await.expect("commit restore");
    dispatch_restore_descendants(
        &pool,
        &restore_record,
        &restore_effects.restored_cohort,
        state,
    )
    .await;
    dispatch_restore_ancestors(
        &pool,
        &restore_record,
        &restore_effects.restored_ancestors,
        state,
    )
    .await;

    let post_restore_parent = deleted_at_of(&pool, parent_id).await;
    let post_restore_child = deleted_at_of(&pool, child_id).await;

    let fallback_delta = sql_only_fallback::count() - fallback_before;
    // dynamic-sql: test-only harness readback (not a production query path)
    let cursor: i64 = sqlx::query_scalar(
        "SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1",
    )
    .fetch_one(&pool)
    .await
    .expect("read apply cursor");

    let sort = |mut v: Vec<String>| {
        v.sort();
        v
    };

    DeleteRestoreObs {
        name: name.to_owned(),
        blocks: read_blocks_full(&pool).await,
        links: read_block_links(&pool).await,
        del_cohort: sort(del_effects.deleted_cohort),
        del_space: del_effects
            .delete_space_id
            .as_ref()
            .map(|s| s.as_str().to_owned()),
        restored_cohort: sort(restore_effects.restored_cohort),
        restored_ancestors: sort(restore_effects.restored_ancestors),
        post_delete_parent,
        post_delete_child,
        post_restore_parent,
        post_restore_child,
        fallback_delta,
        cursor,
    }
}

/// #2325/#2250 — the delete/restore half of the LOCAL-vs-REMOTE collapse guard
/// (the B5 proptest cannot mint a valid runtime `deleted_at_ref`, so this
/// fixture owns delete/restore parity). Drives an identical PAGE->PARENT->CHILD
/// tree through `apply_op_projected` on two independently-seeded pools+engines —
/// `advance_cursor = true` (REMOTE/single-op) on one, `false` (LOCAL, #1257) on
/// the other, running the returned `ApplyEffects` cohort fan-out on both — and
/// asserts:
///   * identical `blocks` (incl. the `deleted_at` cascade over CHILD) +
///     `block_links`,
///   * identical returned effects (delete cohort/space, restore cohort/ancestors),
///   * ZERO `sql_only_fallback` delta (delete/restore stay on the engine path),
///   * the cursor advanced ONLY on the `advance_cursor = true` drive, and
///   * the EXPLICIT expected cascade (PARENT+CHILD deleted, then both cleared) on
///     BOTH drives — so it is a correctness test, not merely cross-drive equality.
#[tokio::test]
async fn delete_restore_local_matches_remote() {
    // 26-char digit-only ULIDs for a PAGE -> PARENT -> CHILD tree.
    const PARENT_ID: &str = "01HZ0000000000000000002222";
    const CHILD_ID: &str = "01HZ0000000000000000003333";
    // Fixed delete-op `created_at`: BOTH pools stamp the SAME `deleted_at`, so
    // the deleted_at cascade is byte-comparable across the two drives.
    const DELETE_TS: i64 = 1_900_000_000_000;

    let state = &agaric_engine::loro::shared::LoroState::new();
    let remote = run_delete_restore(state, "dr-remote", PARENT_ID, CHILD_ID, DELETE_TS, true).await;
    let local = run_delete_restore(state, "dr-local", PARENT_ID, CHILD_ID, DELETE_TS, false).await;

    // The collapse invariant: the ONLY permitted difference between the REMOTE
    // (advance_cursor=true) and LOCAL (advance_cursor=false) drives is the apply
    // cursor. Materialized SQL + returned effects must be byte-identical.
    assert_eq!(
        local.blocks, remote.blocks,
        "blocks (incl. deleted_at cascade) diverged LOCAL vs REMOTE"
    );
    assert_eq!(
        local.links, remote.links,
        "block_links diverged LOCAL vs REMOTE"
    );
    assert_eq!(
        local.del_cohort, remote.del_cohort,
        "DeleteBlock cohort diverged LOCAL vs REMOTE"
    );
    assert_eq!(
        local.del_space, remote.del_space,
        "DeleteBlock space diverged LOCAL vs REMOTE"
    );
    assert_eq!(
        local.restored_cohort, remote.restored_cohort,
        "RestoreBlock cohort diverged LOCAL vs REMOTE"
    );
    assert_eq!(
        local.restored_ancestors, remote.restored_ancestors,
        "RestoreBlock ancestors diverged LOCAL vs REMOTE"
    );

    // Neither drive may touch the sql_only fallback — delete/restore must stay on
    // the engine path (the whole point of the collapse; the #891 failure mode).
    assert_eq!(
        remote.fallback_delta, 0,
        "REMOTE delete/restore took an sql_only fallback"
    );
    assert_eq!(
        local.fallback_delta, 0,
        "LOCAL delete/restore took an sql_only fallback"
    );

    // The cursor is the ONE thing that differs: REMOTE advances to the restore
    // seq (4); LOCAL leaves it at the migration seed (0) so boot replay stays
    // idempotent (#1257).
    assert_eq!(
        remote.cursor, 4,
        "REMOTE (advance_cursor=true) must advance the apply cursor"
    );
    assert_eq!(
        local.cursor, 0,
        "LOCAL (advance_cursor=false) must NOT advance the apply cursor"
    );

    // Non-vacuity: the effects carried the WHOLE PARENT+CHILD cohort and a
    // resolved space; no ancestor was deleted so the restored-ancestor set is
    // empty.
    let mut expected_cohort = vec![PARENT_ID.to_owned(), CHILD_ID.to_owned()];
    expected_cohort.sort();
    assert_eq!(
        remote.del_cohort, expected_cohort,
        "delete cohort must be exactly {{PARENT, CHILD}}"
    );
    assert_eq!(
        remote.restored_cohort, expected_cohort,
        "restore cohort must be exactly {{PARENT, CHILD}}"
    );
    assert!(
        remote.restored_ancestors.is_empty(),
        "no ancestor was deleted, so none restored"
    );
    assert_eq!(
        remote.del_space.as_deref(),
        Some(SPACE_ID),
        "delete space must resolve to SPACE_ID"
    );

    // Explicit EXPECTED cascade on BOTH drives (correctness, not just equality):
    // DeleteBlock(PARENT) soft-deletes PARENT *and* CHILD; RestoreBlock clears
    // both.
    for obs in [&remote, &local] {
        assert_eq!(
            obs.post_delete_parent,
            Some(DELETE_TS),
            "{}: PARENT must be soft-deleted",
            obs.name
        );
        assert_eq!(
            obs.post_delete_child,
            Some(DELETE_TS),
            "{}: CHILD must cascade-soft-delete",
            obs.name
        );
        assert_eq!(
            obs.post_restore_parent, None,
            "{}: PARENT must be restored",
            obs.name
        );
        assert_eq!(
            obs.post_restore_child, None,
            "{}: CHILD must cascade-restore",
            obs.name
        );
    }
}
