//! What a cross-space move takes and leaves behind (#5841 S0.6).
//!
//! Definitions are per space, so a value typed by its source space's
//! definition may mean something else in the target. A move keeps a property
//! when its key is a built-in, when both spaces define it identically (same
//! `value_type` and `options`), or when neither defines it; every other value
//! is dropped, after the user confirms. A built-in is never a
//! `property_definitions` row (#5841 S0.1), so it compares as undeclared on
//! both sides and stays.
//!
//! The blocks a move re-stamps are each live root and its page group
//! (`id = root OR page_id = root`), trashed rows included, exactly the rows
//! `project_set_property_to_sql` moves. A nested page keeps its own space
//! (#4480), so neither it nor its blocks lose anything.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tracing::instrument;

use crate::db::{CommandTx, ReadPool};
use agaric_core::error::ValidationCode;
use agaric_store::op::{DeletePropertyPayload, PropertyValueFields};
use agaric_store::pagination::{Cursor, PageRequest, build_page_response};
use agaric_store::space::SpaceId;

use super::super::*;

/// One key a cross-space move would drop, and how many values it holds.
/// `move_blocks_to_space` takes the list back as its acknowledgement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PropertyLoss {
    pub key: String,
    pub count: i64,
}

/// One value a cross-space move would drop: the block holding it, its page,
/// and the typed value (`PropertyRow`'s slots).
#[derive(Debug, Clone, Serialize, Type)]
pub struct PropertyLossValue {
    pub block_id: String,
    pub page_id: Option<String>,
    pub page_title: Option<String>,
    pub content: Option<String>,
    /// The block is in the Trash; it moves with its page all the same.
    pub deleted: bool,
    pub key: String,
    pub value_text: Option<String>,
    pub value_num: Option<f64>,
    pub value_date: Option<String>,
    pub value_ref: Option<String>,
    pub value_bool: Option<i64>,
}

/// Per key, the values moving `block_ids_json` (a JSON id array) to
/// `target` would drop, ordered by key.
async fn space_move_losses(
    conn: &mut sqlx::SqliteConnection,
    block_ids_json: &str,
    target: &str,
) -> Result<Vec<PropertyLoss>, AppError> {
    Ok(sqlx::query_as!(
        PropertyLoss,
        r#"WITH roots AS (
               SELECT id FROM blocks
               WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL
           ),
           moved AS (
               SELECT id FROM roots
               UNION
               SELECT b.id FROM blocks b JOIN roots r ON b.page_id = r.id
           )
           SELECT bp.key AS "key!: String", COUNT(*) AS "count!: i64"
           FROM moved m
           JOIN blocks b ON b.id = m.id
           JOIN block_properties bp ON bp.block_id = b.id
           LEFT JOIN property_definitions src ON src.space_id = b.space_id AND src.key = bp.key
           LEFT JOIN property_definitions dst ON dst.space_id = ?2 AND dst.key = bp.key
           WHERE b.space_id IS NOT ?2
             AND NOT (src.value_type IS dst.value_type AND src.options IS dst.options)
           GROUP BY bp.key
           ORDER BY bp.key"#,
        block_ids_json,
        target,
    )
    .fetch_all(conn)
    .await?)
}

/// The values [`space_move_losses`] counts, ordered by `(block_id, key)`:
/// only `key`'s when it is `Some`, from after block `after`, at most `limit`.
async fn space_move_loss_values(
    conn: &mut sqlx::SqliteConnection,
    block_ids_json: &str,
    target: &str,
    key: Option<&str>,
    after: Option<&str>,
    limit: i64,
) -> Result<Vec<PropertyLossValue>, AppError> {
    Ok(sqlx::query_as!(
        PropertyLossValue,
        r#"WITH roots AS (
               SELECT id FROM blocks
               WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL
           ),
           moved AS (
               SELECT id FROM roots
               UNION
               SELECT b.id FROM blocks b JOIN roots r ON b.page_id = r.id
           )
           SELECT b.id AS "block_id!: String", b.page_id, pg.content AS page_title,
                  b.content, b.deleted_at IS NOT NULL AS "deleted!: bool",
                  bp.key AS "key!: String", bp.value_text, bp.value_num, bp.value_date,
                  bp.value_ref, bp.value_bool
           FROM moved m
           JOIN blocks b ON b.id = m.id
           JOIN block_properties bp ON bp.block_id = b.id
           LEFT JOIN blocks pg ON pg.id = b.page_id
           LEFT JOIN property_definitions src ON src.space_id = b.space_id AND src.key = bp.key
           LEFT JOIN property_definitions dst ON dst.space_id = ?2 AND dst.key = bp.key
           WHERE b.space_id IS NOT ?2
             AND NOT (src.value_type IS dst.value_type AND src.options IS dst.options)
             AND (?3 IS NULL OR bp.key = ?3)
             AND (?4 IS NULL OR b.id > ?4)
           ORDER BY b.id, bp.key
           LIMIT ?5"#,
        block_ids_json,
        target,
        key,
        after,
        limit,
    )
    .fetch_all(conn)
    .await?)
}

/// Inside a move's transaction: refuse it when its losses differ from
/// `acknowledged`, or when dropping them and moving `roots` would exceed one
/// undo; otherwise append one `DeleteProperty` per lost value, with the value
/// as its `prior`. The caller appends the moves after these, so an undo moves
/// the page back before it restores the values.
pub(super) async fn drop_acknowledged_losses_in_tx(
    tx: &mut CommandTx,
    materializer: &Materializer,
    device_id: &str,
    block_ids_json: &str,
    target: &str,
    roots: usize,
    acknowledged: &[PropertyLoss],
) -> Result<(), AppError> {
    let losses = space_move_losses(tx, block_ids_json, target).await?;
    let values: i64 = losses.iter().map(|loss| loss.count).sum();
    if values == 0 {
        return Ok(());
    }
    let ops = usize::try_from(values)
        .unwrap_or(usize::MAX)
        .saturating_add(roots);
    if ops > crate::commands::history::MAX_REVERT_OPS {
        return Err(AppError::validation(format!(
            "this move would remove {values} property values, more than one undo can restore; \
             move fewer pages"
        )));
    }
    let mut acknowledged = acknowledged.to_vec();
    acknowledged.sort_by(|a, b| a.key.cmp(&b.key));
    if acknowledged != losses {
        return Err(AppError::validation_coded(
            ValidationCode::UnacknowledgedPropertyLoss,
            format!(
                "moving would remove values of properties the target space does not define \
                 the same way: {}",
                describe_losses(&losses)
            ),
        ));
    }
    let rows = space_move_loss_values(tx, block_ids_json, target, None, None, values).await?;
    for row in rows {
        let payload = OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::from_trusted(&row.block_id),
            key: row.key,
            prior: Some(PropertyValueFields {
                value_text: row.value_text,
                value_num: row.value_num,
                value_date: row.value_date,
                value_ref: row.value_ref.map(BlockId::from),
                value_bool: row.value_bool.map(|b| b != 0),
            }),
        });
        let record =
            op_log::append_local_op_in_tx(tx, device_id, payload, crate::db::now_ms()).await?;
        crate::materializer::apply_op_projected(tx, &record, materializer.loro_state(), false)
            .await?;
        tx.enqueue_background(Arc::new(record));
    }
    Ok(())
}

/// `related (2), status (1)`.
pub(crate) fn describe_losses(losses: &[PropertyLoss]) -> String {
    losses
        .iter()
        .map(|loss| format!("{} ({})", loss.key, loss.count))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The properties moving `block_ids` to `target_space_id` would drop, one row
/// per key with its count of values. Empty when nothing is lost or nothing is
/// listed.
///
/// # Errors
///
/// - [`AppError::Validation`] — more than `MAX_BATCH_BLOCK_IDS` ids
#[instrument(skip(pool, block_ids), err)]
pub async fn preview_space_move_inner(
    pool: &SqlitePool,
    block_ids: Vec<BlockId>,
    target_space_id: String,
) -> Result<Vec<PropertyLoss>, AppError> {
    if block_ids.is_empty() {
        return Ok(Vec::new());
    }
    crate::commands::ensure_batch_within_cap("block_ids", block_ids.len())?;
    let block_ids_json = serde_json::to_string(&block_ids)?;
    let mut conn = pool.acquire().await?;
    space_move_losses(
        &mut conn,
        &block_ids_json,
        &target_space_id.to_ascii_uppercase(),
    )
    .await
}

/// Tauri command: the properties a cross-space move would drop. Delegates to
/// [`preview_space_move_inner`].
#[tauri::command]
#[specta::specta]
pub async fn preview_space_move(
    pool: State<'_, ReadPool>,
    block_ids: Vec<BlockId>,
    target_space_id: SpaceId,
) -> Result<Vec<PropertyLoss>, AppError> {
    target_space_id.validate_shape()?;
    preview_space_move_inner(&pool.0, block_ids, target_space_id.into_string())
        .await
        .map_err(sanitize_internal_error)
}

/// The values of `key` that moving `block_ids` to `target_space_id` would
/// drop, with the block and page holding each, cursor-paginated by block id.
///
/// # Errors
///
/// - [`AppError::Validation`] — more than `MAX_BATCH_BLOCK_IDS` ids, a
///   `limit` outside `PageRequest::new`'s range, or a malformed cursor
#[instrument(skip(pool, block_ids, cursor), err)]
pub async fn list_property_loss_values_inner(
    pool: &SqlitePool,
    block_ids: Vec<BlockId>,
    target_space_id: String,
    key: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<PropertyLossValue>, AppError> {
    let page = PageRequest::new(cursor, limit)?;
    crate::commands::ensure_batch_within_cap("block_ids", block_ids.len())?;
    let block_ids_json = serde_json::to_string(&block_ids)?;
    let after = page.after.as_ref().map(|c| c.id.as_str());
    let mut conn = pool.acquire().await?;
    let rows = space_move_loss_values(
        &mut conn,
        &block_ids_json,
        &target_space_id.to_ascii_uppercase(),
        Some(&key),
        after,
        page.limit + 1,
    )
    .await?;
    build_page_response(rows, page.limit, |last| {
        Cursor::for_id(last.block_id.clone())
    })
}

/// Tauri command: one page of the values a cross-space move would drop under
/// `key`. Delegates to [`list_property_loss_values_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_property_loss_values(
    pool: State<'_, ReadPool>,
    block_ids: Vec<BlockId>,
    target_space_id: SpaceId,
    key: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<PropertyLossValue>, AppError> {
    target_space_id.validate_shape()?;
    list_property_loss_values_inner(
        &pool.0,
        block_ids,
        target_space_id.into_string(),
        key,
        cursor,
        limit,
    )
    .await
    .map_err(sanitize_internal_error)
}
