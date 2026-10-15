//! Repair 4 (#5387) — page aliases written before aliases were ops.
//!
//! A `page_aliases` row written before #5387 has no op and no entry in its
//! page's Loro doc, so it never reaches another device and an engine
//! reprojection does not know it. Each such row gets the `AddPageAlias` the
//! alias editor appends now: ordinary ops, not a migration (invariant 2). Each
//! device backfills its own rows, and the page's keyed alias map collapses the
//! duplicates when they meet.
//!
//! Idempotent by construction: a backfilled alias has its engine entry, so it
//! is not a candidate on the next run.

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::db::now_ms;
use agaric_store::op::{AddPageAliasPayload, OpPayload};
use agaric_store::op_log;
use agaric_store::space::SpaceId;
use agaric_store::task_locals::ACTOR;

use super::{RepairOp, housekeeping};
use crate::apply::kernel::apply_op_projected;
use crate::loro::engine::page_alias_key;
use crate::loro::shared::LoroState;

/// What one run of the page-alias backfill did.
#[derive(Debug, Default)]
pub struct PageAliasRepair {
    /// `AddPageAlias` ops emitted, in append order.
    pub ops: Vec<RepairOp>,
}

/// `(page_id, alias)` of every row whose page's doc does not hold the alias.
async fn select_unbackfilled(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
) -> Result<Vec<(String, String)>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT pa.page_id AS "page_id!: String", pa.alias, b.space_id AS "space_id!: String"
           FROM page_aliases pa
           JOIN blocks b ON b.id = pa.page_id
           WHERE b.space_id IS NOT NULL
           ORDER BY pa.page_id, pa.alias"#,
    )
    .fetch_all(&mut **tx)
    .await?;
    let mut missing = Vec::new();
    for row in rows {
        let held = {
            let space = SpaceId::from_trusted(&row.space_id);
            let mut guard = state.registry.for_space(&space, device_id)?;
            guard.engine_mut().read_page_aliases(&row.page_id)?
        };
        let key = page_alias_key(&row.alias);
        if !held.is_some_and(|held| held.iter().any(|a| page_alias_key(a) == key)) {
            missing.push((row.page_id, row.alias));
        }
    }
    Ok(missing)
}

/// Emit an `AddPageAlias` for every alias row its page's doc does not hold.
pub async fn repair_page_aliases(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
) -> Result<PageAliasRepair, AppError> {
    let missing = select_unbackfilled(tx, state, device_id).await?;
    ACTOR
        .scope(housekeeping("page_aliases"), async {
            let mut report = PageAliasRepair::default();
            for (page_id, alias) in missing {
                let payload = OpPayload::AddPageAlias(AddPageAliasPayload {
                    page_id: BlockId::from_trusted(&page_id),
                    alias,
                });
                let record =
                    op_log::append_local_op_in_tx(tx, device_id, payload, now_ms()).await?;
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
    use crate::spaces::SPACE_PERSONAL_ULID;
    use agaric_store::task_locals::Actor;
    use sqlx::SqlitePool;

    async fn run(pool: &SqlitePool, state: &LoroState) -> PageAliasRepair {
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let report = repair_page_aliases(&mut tx, state, DEV).await.unwrap();
        tx.commit().await.unwrap();
        report
    }

    /// A page under Personal holding `aliases` as pre-#5387 rows: SQL only.
    async fn page_with_legacy_aliases(pool: &SqlitePool, aliases: &[&str]) -> String {
        let id = next_id();
        insert(
            pool,
            Row {
                id: &id,
                block_type: "page",
                content: "Planning",
                parent_id: Some(SPACE_PERSONAL_ULID),
                page_id: Some(&id),
                space_id: Some(SPACE_PERSONAL_ULID),
                position: 1,
            },
        )
        .await;
        for alias in aliases {
            sqlx::query!(
                "INSERT INTO page_aliases (page_id, alias) VALUES (?, ?)",
                id,
                alias
            )
            .execute(pool)
            .await
            .unwrap();
        }
        id
    }

    fn engine_aliases(state: &LoroState, page_id: &str) -> Option<Vec<String>> {
        let space = SpaceId::from_trusted(SPACE_PERSONAL_ULID);
        let mut guard = state.registry.for_space(&space, DEV).unwrap();
        guard.engine_mut().read_page_aliases(page_id).unwrap()
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
    async fn legacy_rows_get_an_add_page_alias_each_as_housekeeping() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        let page = page_with_legacy_aliases(&pool, &["Plans", "roadmap"]).await;

        let report = run(&pool, &state).await;

        assert_eq!(report.ops.len(), 2, "one op per row");
        assert_eq!(
            engine_aliases(&state, &page),
            Some(vec!["Plans".to_owned(), "roadmap".to_owned()]),
            "the page's doc now holds both aliases"
        );
        let tag = Actor::Housekeeping.origin_tag();
        assert_eq!(
            ops_on(&pool, &page).await,
            vec![
                ("add_page_alias".to_owned(), tag.clone()),
                ("add_page_alias".to_owned(), tag)
            ],
            "ops, not raw rows, and housekeeping so they are outside undo"
        );
        let rows: Vec<String> = sqlx::query_scalar!(
            "SELECT alias FROM page_aliases WHERE page_id = ? ORDER BY alias",
            page
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec!["Plans".to_owned(), "roadmap".to_owned()],
            "rows kept"
        );
    }

    #[tokio::test]
    async fn a_second_start_emits_nothing() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        page_with_legacy_aliases(&pool, &["Plans"]).await;
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
            "the second start finds every alias in the doc"
        );
        assert_eq!(op_count(&pool).await, ops_before, "and appends no op");
    }
}
