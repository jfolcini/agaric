//! Repair 5 (#5841) — property definitions written before definitions were
//! ops.
//!
//! A `property_definitions` row written before #5841 has no op and no entry in
//! its space's Loro doc, so it never reaches another device and an engine
//! reprojection does not know it. Each such row gets the `SetPropertyDef` the
//! definition writer appends now: ordinary ops, not a migration (invariant 2).
//! Each device backfills its own rows, and the root's per-key last-writer-wins
//! collapses two devices' copies of one definition when they meet. A trashed
//! space's rows are backfilled too, so restoring it brings them back.
//!
//! Idempotent by construction: a backfilled row's key is in its space's root,
//! so it is not a candidate on the next run.

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::db::now_ms;
use agaric_store::op::{OpPayload, PropertyDefState, SetPropertyDefPayload};
use agaric_store::op_log;
use agaric_store::space::SpaceId;
use agaric_store::task_locals::ACTOR;

use super::{RepairOp, housekeeping};
use crate::apply::kernel::apply_op_projected;
use crate::loro::shared::LoroState;

/// What one run of the definition backfill did.
#[derive(Debug, Default)]
pub struct PropertyDefinitionRepair {
    /// `SetPropertyDef` ops emitted, in append order.
    pub ops: Vec<RepairOp>,
}

/// The `SetPropertyDef` of every row whose key its space's root lacks.
async fn select_unbackfilled(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
) -> Result<Vec<SetPropertyDefPayload>, AppError> {
    let rows = sqlx::query!(
        "SELECT space_id, key, value_type, options FROM property_definitions \
         ORDER BY space_id, key"
    )
    .fetch_all(&mut **tx)
    .await?;
    let mut missing = Vec::new();
    let mut held: Option<(String, Vec<String>)> = None;
    for row in rows {
        if held
            .as_ref()
            .is_none_or(|(space, _)| *space != row.space_id)
        {
            let mut guard = state
                .registry
                .for_space(&SpaceId::from_trusted(&row.space_id), device_id)?;
            let keys = guard.engine_mut().read_property_defs()?;
            held = Some((
                row.space_id.clone(),
                keys.into_iter().map(|(k, _)| k).collect(),
            ));
        }
        if held
            .as_ref()
            .is_some_and(|(_, keys)| keys.contains(&row.key))
        {
            continue;
        }
        missing.push(SetPropertyDefPayload {
            space_id: BlockId::from_trusted(&row.space_id),
            key: row.key,
            def: Some(PropertyDefState {
                value_type: row.value_type,
                options: row.options,
            }),
            prior: None,
        });
    }
    Ok(missing)
}

/// Emit a `SetPropertyDef` for every definition row its space's doc lacks.
pub async fn repair_property_definitions(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
) -> Result<PropertyDefinitionRepair, AppError> {
    let missing = select_unbackfilled(tx, state, device_id).await?;
    ACTOR
        .scope(housekeeping("property_definitions"), async {
            let mut report = PropertyDefinitionRepair::default();
            for payload in missing {
                let record = op_log::append_local_op_in_tx(
                    tx,
                    device_id,
                    OpPayload::SetPropertyDef(payload),
                    now_ms(),
                )
                .await?;
                apply_op_projected(tx, &record, state, false).await?;
                report.ops.push(RepairOp::Plain(record));
            }
            Ok(report)
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use crate::spaces::{SPACE_PERSONAL_ULID, SPACE_WORK_ULID};
    use agaric_store::task_locals::Actor;
    use sqlx::SqlitePool;

    async fn run(pool: &SqlitePool, state: &LoroState) -> PropertyDefinitionRepair {
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let report = repair_property_definitions(&mut tx, state, DEV)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        report
    }

    /// A definition as a pre-#5841 writer left it: a row, no op.
    async fn legacy_def(pool: &SqlitePool, space: &str, key: &str, value_type: &str) {
        sqlx::query!(
            "INSERT INTO property_definitions (space_id, key, value_type, created_at) \
             VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')",
            space,
            key,
            value_type,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    fn root_keys(state: &LoroState, space: &str) -> Vec<String> {
        let mut guard = state
            .registry
            .for_space(&SpaceId::from_trusted(space), DEV)
            .unwrap();
        let defs = guard.engine_mut().read_property_defs().unwrap();
        defs.into_iter().map(|(key, _)| key).collect()
    }

    /// A fresh `LoroState` holding what `state` would persist, as a restart
    /// rehydrates it.
    fn restarted(state: &LoroState) -> LoroState {
        let next = LoroState::new();
        for (space, bytes) in state.registry.snapshot_all_engines() {
            let mut engine = crate::loro::engine::LoroEngine::new();
            engine.import(&bytes.unwrap()).unwrap();
            next.registry.install_engine(space, engine);
        }
        next
    }

    #[tokio::test]
    async fn legacy_rows_get_a_set_property_def_each_as_housekeeping() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        legacy_def(&pool, SPACE_PERSONAL_ULID, "stage", "text").await;
        legacy_def(&pool, SPACE_PERSONAL_ULID, "due2", "date").await;
        legacy_def(&pool, SPACE_WORK_ULID, "stage", "text").await;
        sqlx::query!(
            "UPDATE blocks SET deleted_at = 1 WHERE id = ?",
            SPACE_WORK_ULID
        )
        .execute(&pool)
        .await
        .unwrap();

        let report = run(&pool, &state).await;

        assert_eq!(report.ops.len(), 3, "one op per row");
        assert_eq!(
            root_keys(&state, SPACE_PERSONAL_ULID),
            vec!["due2".to_owned(), "stage".to_owned()],
            "Personal's doc now holds its rows"
        );
        assert_eq!(
            root_keys(&state, SPACE_WORK_ULID),
            vec!["stage".to_owned()],
            "a trashed space's rows are backfilled too"
        );
        let tag = Actor::Housekeeping.origin_tag();
        assert_eq!(
            ops_on(&pool, SPACE_PERSONAL_ULID).await,
            vec![
                ("set_property_def".to_owned(), tag.clone()),
                ("set_property_def".to_owned(), tag)
            ],
            "ops on the space, and housekeeping so they are outside undo"
        );
    }

    #[tokio::test]
    async fn a_second_start_emits_nothing() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        legacy_def(&pool, SPACE_PERSONAL_ULID, "stage", "text").await;
        assert_eq!(
            run(&pool, &state).await.ops.len(),
            1,
            "first start backfills"
        );
        let ops_before = op_count(&pool).await;

        let report = run(&pool, &restarted(&state)).await;

        assert_eq!(
            report.ops.len(),
            0,
            "the second start finds every definition in the doc"
        );
        assert_eq!(op_count(&pool).await, ops_before, "and appends no op");
    }
}
