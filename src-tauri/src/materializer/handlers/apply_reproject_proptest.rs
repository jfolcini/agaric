//! #1683 — B2/B3/B4 property tests over the materializer apply / reproject
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
//! A test that applies ops WITHOUT `crate::loro::shared::install_for_test()`
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

use crate::db::init_pool;
use crate::loro::projection::reproject_dense_positions;
use crate::loro::registry::LoroEngineRegistry;
use crate::op::OpPayload;
use crate::op_log::append_local_op;
use crate::proptest_db_harness::{HARNESS_DEVICE, op_chain_strategy, resolve_chain};
use crate::space::SpaceId;
use crate::sync_protocol::loro_sync::{ApplyOutcome, apply_remote, prepare_outgoing};
use crate::sync_protocol::loro_sync_types::{LORO_SYNC_PROTOCOL_VERSION, LoroSyncMessage};
use crate::ulid::BlockId;
use proptest::prelude::*;
use sqlx::SqlitePool;
use std::collections::BTreeMap;
use tempfile::TempDir;
use tokio::runtime::Runtime;

use super::apply_op_tx;
use super::sql_only_fallback;

/// Low case counts keep the suite fast (the apply pipeline is DB-bound). Bump
/// locally via `PROPTEST_CASES` for a deeper search.
const B2_CASES: u32 = 48;
const B3_CASES: u32 = 32;
const B4_CASES: u32 = 32;

/// Short op chains: a handful of ops already exercises create / edit / move /
/// property interleavings and keeps shrunk counter-examples small.
const CHAIN_LEN: std::ops::RangeInclusive<usize> = 1..=14;

/// Fixed test-space + page ids (26-char ULID shape). The page roots every
/// harness chain so `resolve_block_space` succeeds and the engine path engages.
const SPACE_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PAGE_ID: &str = "01HZ0000000000000000001683";

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
    state: &crate::loro::shared::LoroState,
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
/// `DeleteProperty`. Every root create / root move (`parent_id == None`) is
/// re-anchored under [`PAGE_ID`] so `resolve_block_space` always succeeds and
/// the op routes through `apply_*_via_loro` rather than the SQL-only fallback.
///
/// Dropped ops, and why (all harness artifacts of the op-log-only B1 surface,
/// NOT #891-class reprojection bugs):
///
/// * `AddTag` / `RemoveTag` — the harness draws `tag_id` from the SAME ULID pool
///   as block ids, so a tag edge can reference a pool id that was never created.
///   The op-log accepts it; the materializer rejects it
///   (`block_tags.tag_id REFERENCES blocks(id)`, an FK violation). Tags do not
///   affect `parent_id` / `position` / `block_links`.
/// * `DeleteBlock` / `RestoreBlock` — soft-delete + restore in this synthetic
///   single-page setup repeatedly drops to the SQL-only fallback: a restore's
///   space resolves via the block's own (deleted, space-unresolvable) row or a
///   cascade-orphaned anchor, and the harness mints `RestoreBlock` with a
///   placeholder `deleted_at_ref = 0` that no-ops the SQL un-delete. Tombstone /
///   cohort-ref lifecycle is its own concern (covered by the dedicated
///   `delete_restore_convergence_tests`); excluding it here keeps EVERY op on
///   the engine path so the dense-rank / convergence assertions stay honest.
///   With both dropped, every block stays live for the whole chain, so the
///   harness `ChainModel`'s validity (which assumed them) is not violated by
///   their removal.
fn prepare_chain(payloads: Vec<OpPayload>) -> Vec<OpPayload> {
    payloads
        .into_iter()
        .filter(|p| {
            !matches!(
                p,
                OpPayload::AddTag(_)
                    | OpPayload::RemoveTag(_)
                    | OpPayload::DeleteBlock(_)
                    | OpPayload::RestoreBlock(_)
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

/// Drives a prepared op chain through the production engine apply path.
struct ChainDriver {
    /// Device id every op is appended under — drives the engine's per-space Loro
    /// peer id (`for_space(space, device_id)`). Distinct device ids give B4's two
    /// peers distinct Loro op-spaces so their independent edits merge cleanly
    /// (a shared device id would fork — #792 — and request snapshot fallback).
    device_id: String,
}

impl ChainDriver {
    fn new(device_id: &str) -> Self {
        Self {
            device_id: device_id.to_owned(),
        }
    }

    /// Append `payload` to the op_log and apply it through `apply_op_tx` in its
    /// own tx (the production engine path). After a create, stamp the new
    /// block's `parent_id`/`page_id`/`space_id` so the NEXT op resolves a space
    /// in-line (the discipline `move_convergence_tests` uses).
    async fn drive(&mut self, pool: &SqlitePool, payload: OpPayload) {
        let created: Option<(String, String)> = match &payload {
            OpPayload::CreateBlock(c) => Some((
                c.block_id.as_str().to_owned(),
                c.parent_id
                    .as_ref()
                    .map(|p| p.as_str().to_owned())
                    .unwrap_or_else(|| PAGE_ID.to_owned()),
            )),
            _ => None,
        };

        let record = append_local_op(pool, &self.device_id, payload)
            .await
            .expect("append op");

        let mut tx = pool.begin().await.expect("begin apply");
        apply_op_tx(&mut tx, &record).await.expect("apply op");
        tx.commit().await.expect("commit apply");

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
            let state = crate::loro::shared::install_for_test();
            state.registry.clear();

            let (pool, _dir) = fresh_pool("b2").await;
            seed_space_row(&pool).await;
            seed_page_via_engine(&pool, state, HARNESS_DEVICE).await;

            let fallback_before = sql_only_fallback::count();

            let payloads = prepare_chain(resolve_chain(&sketches));
            let mut driver = ChainDriver::new(HARNESS_DEVICE);
            for payload in payloads {
                driver.drive(&pool, payload).await;
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
            let state = crate::loro::shared::install_for_test();

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
                driver_a.drive(&pool_a, payload).await;
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
                driver_b.drive(&pool_b, payload).await;
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
            let state = crate::loro::shared::install_for_test();

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
async fn build_base_snapshot(state: &'static crate::loro::shared::LoroState) -> Vec<u8> {
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
    state: &'static crate::loro::shared::LoroState,
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
        driver.drive(&pool, payload).await;
    }
    prop_assert!(
        sql_only_fallback::count() - fallback_before == 0,
        "B4 peer build took the SQL-only fallback"
    );

    let msg = prepare_outgoing(&pool, &state.registry, &space, device_id, None)
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
