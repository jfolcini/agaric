//! `loro_doc_delta` (#6521): what each transaction added to a space's engine,
//! saved in that transaction.
//!
//! A snapshot pass writes a space's whole engine to `loro_doc_state` some time
//! after the write. A row here is committed with the write: the Loro update a
//! transaction's engine writes produced, or the blob a sync import brought. A
//! space's saved engine is its snapshot with its rows imported in `id` order,
//! and a pass deletes the rows its snapshot covers
//! ([`crate::loro::snapshot::save_all_engines`]).
//!
//! Nothing reads the rows at boot yet. Boot still builds each engine from its
//! snapshot and the op log, so the rows an earlier process left do not
//! describe the engine boot builds: boot deletes them before its first engine
//! write ([`clear_deltas`]), and what it writes saves rows of its own.
//!
//! ## Who saves a row
//!
//! * A transaction that armed the engine rollback log: [`commit_with_deltas`]
//!   exports each engine's update since the transaction first touched it. The
//!   app's `CommandTx` does the same in its own commit.
//! * An engine write with no transaction of its own (the fan-outs that follow
//!   a delete, restore or purge commit): [`write_engines`] takes the write
//!   lock, so a concurrent transaction's rollback cannot rewind the engine
//!   under a row that is already saved.
//! * A sync import or export, which writes the engine outside the write lock:
//!   `LoroEngine::capturing_delta` exports what the write added under the
//!   engine lock, and the caller saves it with [`insert_delta`]; an import
//!   saves it in the projection transaction that clears its inbox slot.
//!
//! An engine write that saves no row leaves a gap: the next row depends on ops
//! no row holds. [`saved_engine_divergences`] is the test oracle for that.

use std::future::Future;

use sqlx::{Sqlite, SqliteConnection, SqlitePool};

use crate::loro::registry::LoroEngineRegistry;
use crate::loro::revert::{DetachedRevert, RevertLog, RevertScope};
use agaric_core::error::AppError;
use agaric_store::space::SpaceId;

/// Save `bytes`, a Loro update or snapshot `space_id`'s engine holds, on `conn`.
pub async fn insert_delta(
    conn: &mut SqliteConnection,
    space_id: &SpaceId,
    bytes: &[u8],
) -> Result<(), sqlx::Error> {
    let space = space_id.as_str();
    sqlx::query!(
        "INSERT INTO loro_doc_delta (space_id, bytes) VALUES (?, ?)",
        space,
        bytes,
    )
    .execute(conn)
    .await?;
    Ok(())
}

/// Save what `pending`'s transaction added to each engine it wrote, on that
/// transaction's connection. The caller commits, and rewinds `pending` when
/// this or the commit fails.
pub async fn save_deltas(
    conn: &mut SqliteConnection,
    registry: &LoroEngineRegistry,
    pending: &DetachedRevert,
) -> Result<(), AppError> {
    for (space_id, bytes) in pending.deltas(registry)? {
        insert_delta(conn, &space_id, &bytes).await?;
    }
    Ok(())
}

/// Commit `tx` with the deltas of the engine writes `pending` recorded. When
/// the save or the commit fails, the transaction rolls back and the engines
/// are rewound.
pub async fn commit_with_deltas(
    mut tx: sqlx::Transaction<'_, Sqlite>,
    registry: &LoroEngineRegistry,
    pending: DetachedRevert,
) -> Result<(), AppError> {
    let committed = match save_deltas(&mut tx, registry, &pending).await {
        Ok(()) => tx.commit().await.map_err(AppError::from),
        Err(e) => {
            drop(tx);
            Err(e)
        }
    };
    if committed.is_err() {
        pending.revert();
    }
    committed
}

/// Run `write`, engine writes that belong to no SQL transaction, under the
/// write lock, and save what they added.
///
/// `write` reaches its engines through
/// [`LoroEngineRegistry::for_space_recording`] with `log`: the state's shared
/// log when it goes through the apply handlers, or a log of the caller's own.
/// A failed save or commit rewinds them, and so does dropping this future.
pub async fn write_engines<T>(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    log: &RevertLog,
    label: &'static str,
    write: impl Future<Output = T>,
) -> Result<T, AppError> {
    // allow-raw-tx: engine-only writes and their `loro_doc_delta` row; no op_log write.
    let tx = agaric_store::db::begin_immediate_logged(pool, label).await?;
    let scope = RevertScope::arm_log(log);
    let written = write.await;
    commit_with_deltas(tx, registry, scope.detach()).await?;
    Ok(written)
}

/// Delete every row: the ones an earlier process saved, which the engines boot
/// is about to build from snapshots and the op log do not hold.
pub async fn clear_deltas(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query!("DELETE FROM loro_doc_delta")
        .execute(pool)
        .await?;
    Ok(())
}

/// The highest `loro_doc_delta.id`, 0 for an empty table. A snapshot pass
/// reads it before it collects any engine: a row is committed after its engine
/// write, so an export taken after this read holds every row at or below it.
pub(crate) async fn delta_head(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar!(r#"SELECT COALESCE(MAX(id), 0) AS "head!: i64" FROM loro_doc_delta"#)
        .fetch_one(pool)
        .await
}

/// Every space whose engine differs from what its saved rows rebuild, each
/// with what differs. Empty when every engine write saved its delta.
///
/// A space's rebuild is its `loro_doc_state` snapshot, its `loro_doc_delta`
/// rows in `id` order, and the inbound blobs `loro_sync_inbox` and
/// `loro_sync_quarantine` still hold for it: an import reaches the engine
/// before its projection moves the blob here, and a blob whose projection
/// never commits stays there.
#[cfg(any(test, feature = "test-util"))]
pub async fn saved_engine_divergences(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
) -> Result<Vec<String>, AppError> {
    use std::collections::BTreeMap;

    let mut saved: BTreeMap<String, Vec<Vec<u8>>> = BTreeMap::new();
    for row in sqlx::query!(r#"SELECT space_id AS "space_id!", snapshot FROM loro_doc_state"#)
        .fetch_all(pool)
        .await?
    {
        saved.entry(row.space_id).or_default().push(row.snapshot);
    }
    for row in sqlx::query!("SELECT space_id, bytes FROM loro_doc_delta ORDER BY id")
        .fetch_all(pool)
        .await?
    {
        saved.entry(row.space_id).or_default().push(row.bytes);
    }
    for row in sqlx::query!(
        "SELECT space_id, bytes FROM loro_sync_inbox \
         UNION ALL SELECT space_id, bytes FROM loro_sync_quarantine"
    )
    .fetch_all(pool)
    .await?
    {
        saved.entry(row.space_id).or_default().push(row.bytes);
    }

    let live: BTreeMap<String, loro::LoroDoc> = registry
        .doc_handles()
        .into_iter()
        .map(|(space_id, doc)| (space_id.as_str().to_owned(), doc))
        .collect();
    let spaces: std::collections::BTreeSet<&String> = saved.keys().chain(live.keys()).collect();

    let mut divergences = Vec::new();
    for space in spaces {
        let rebuilt = loro::LoroDoc::new();
        let mut pending = Vec::new();
        for bytes in saved.get(space).into_iter().flatten() {
            match rebuilt.import(bytes) {
                Ok(status) if status.pending.is_some() => pending.push(format!("{status:?}")),
                Ok(_) => {}
                Err(e) => pending.push(format!("import failed: {e}")),
            }
        }
        let empty = loro::LoroDoc::new();
        let live = live.get(space).unwrap_or(&empty);
        if rebuilt.oplog_vv() != live.oplog_vv() {
            divergences.push(format!(
                "space {space}: the saved rows rebuild version {:?}, the engine is at {:?} \
                 (imports left pending: {pending:?})",
                rebuilt.oplog_vv(),
                live.oplog_vv(),
            ));
        } else if rebuilt.get_deep_value() != live.get_deep_value() {
            divergences.push(format!(
                "space {space}: the saved rows rebuild the engine's version with another state"
            ));
        }
    }
    Ok(divergences)
}

/// Panic unless every engine in `registry` equals what its saved rows rebuild
/// ([`saved_engine_divergences`]).
#[cfg(any(test, feature = "test-util"))]
pub async fn assert_saved_engines_match_live(pool: &SqlitePool, registry: &LoroEngineRegistry) {
    let divergences = saved_engine_divergences(pool, registry)
        .await
        .expect("read the saved engine rows");
    assert!(
        divergences.is_empty(),
        "an engine write saved no loro_doc_delta row (#6521):\n{}",
        divergences.join("\n")
    );
}
