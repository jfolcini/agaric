//! `loro_doc_delta` (#6521): what each write added to a space's engine, saved
//! with the write.
//!
//! A snapshot pass writes a space's whole engine to `loro_doc_state` some time
//! after the write. A row here is the Loro update one write added to the
//! engine's op log, committed in the write's transaction. A space's saved
//! engine is its snapshot with its rows imported in `id` order, and a pass
//! deletes the rows its snapshot covers
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
//!   exports each engine's update since the transaction first touched it, and
//!   a failed save fails the transaction. The app's `CommandTx` commits
//!   through it.
//! * The engine writes that follow a commit (the cascade of a delete, a
//!   restore or a purge): [`write_engines`] runs them under the write lock in
//!   a transaction of their own.
//! * A sync import or export, which writes the engine outside the write lock:
//!   `LoroEngine::capturing_delta` exports what the write added under the
//!   engine lock, and the caller saves it with [`insert_delta`]; an import
//!   saves it in the projection transaction that clears its inbox slot.
//!
//! An engine write that saves no row leaves a gap: the next row depends on ops
//! no row holds, until a snapshot pass saves the space. The test oracle for
//! that is `saved_engine_divergences`, in this module's test builds.

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
    tx: sqlx::Transaction<'_, Sqlite>,
    registry: &LoroEngineRegistry,
    pending: DetachedRevert,
) -> Result<(), AppError> {
    let committed = save_and_commit(tx, registry, &pending).await;
    if committed.is_err() {
        pending.revert();
    }
    committed
}

async fn save_and_commit(
    mut tx: sqlx::Transaction<'_, Sqlite>,
    registry: &LoroEngineRegistry,
    pending: &DetachedRevert,
) -> Result<(), AppError> {
    save_deltas(&mut tx, registry, pending).await?;
    Ok(tx.commit().await?)
}

/// Run `write`, the engine writes that follow a commit and belong to no SQL
/// transaction, under the write lock, and save what they added. Returns
/// `write`'s output and whether the delta was saved.
///
/// `write` reaches its engines through
/// [`LoroEngineRegistry::for_space_recording`] with `log`, a log of the
/// caller's own. Under the lock no transaction's rollback can rewind an engine
/// beneath the row this saves.
///
/// The writes are the engine half of work SQL has already committed, so they
/// stand whatever becomes of their delta: when the lock cannot be taken they
/// run without it, and when the save or the commit fails they are not
/// rewound. The `Err` then says no row holds them. Their space is dirty, so
/// the next snapshot pass saves it.
pub async fn write_engines<T>(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    log: &RevertLog,
    label: &'static str,
    write: impl FnOnce() -> T,
) -> (T, Result<(), AppError>) {
    // allow-raw-tx: engine-only writes and their `loro_doc_delta` row; no op_log write.
    let tx = match agaric_store::db::begin_immediate_logged(pool, label).await {
        Ok(tx) => tx,
        Err(e) => return (write(), Err(e.into())),
    };
    let scope = RevertScope::arm_log(log);
    let written = write();
    let kept = scope.detach();
    let saved = save_and_commit(tx, registry, &kept).await;
    (written, saved)
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
/// write, so an export taken after this read holds the ops of every row at or
/// below it that the engine still holds. (A sync import writes the engine
/// outside the write lock, so a transaction that rolls back can rewind it
/// before its row commits; that row then holds ops the engine lost, and
/// deleting it is right too.)
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
/// before its projection saves what it added, and a blob whose projection
/// never commits stays there. What a test fixture seeded through
/// [`LoroEngineRegistry::seed`] counts as saved too.
#[cfg(any(test, feature = "test-util"))]
pub async fn saved_engine_divergences(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
) -> Result<Vec<String>, AppError> {
    use std::collections::BTreeMap;

    let saved = saved_rows(pool, registry).await?;
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
        } else {
            let (rebuilt, live) = (non_empty_roots(&rebuilt), non_empty_roots(live));
            let differing: Vec<&String> = rebuilt
                .keys()
                .chain(live.keys())
                .filter(|root| rebuilt.get(*root) != live.get(*root))
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect();
            if !differing.is_empty() {
                divergences.push(format!(
                    "space {space}: the saved rows rebuild the engine's version with another \
                     state in the roots {differing:?}"
                ));
            }
        }
    }
    Ok(divergences)
}

/// Everything saved for each space, in the order a rebuild imports it: the
/// snapshot, the deltas by `id`, the inbound blobs, then what fixtures seeded.
#[cfg(any(test, feature = "test-util"))]
async fn saved_rows(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
) -> Result<std::collections::BTreeMap<String, Vec<Vec<u8>>>, AppError> {
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

    for (space_id, bytes) in registry.seeded() {
        saved
            .entry(space_id.as_str().to_owned())
            .or_default()
            .push(bytes);
    }
    Ok(saved)
}

/// `doc`'s state by root container, without the empty ones: a root a reader
/// has merely looked up is in the state as an empty container, and one no
/// reader has looked up is not there at all.
#[cfg(any(test, feature = "test-util"))]
fn non_empty_roots(doc: &loro::LoroDoc) -> std::collections::BTreeMap<String, loro::LoroValue> {
    let loro::LoroValue::Map(roots) = doc.get_deep_value() else {
        return std::collections::BTreeMap::new();
    };
    roots
        .iter()
        .filter(|(_, value)| match value {
            loro::LoroValue::Map(map) => !map.is_empty(),
            loro::LoroValue::List(list) => !list.is_empty(),
            loro::LoroValue::String(text) => !text.is_empty(),
            _ => true,
        })
        .map(|(root, value)| (root.clone(), value.clone()))
        .collect()
}
