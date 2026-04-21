//! Tags command handlers.

use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::{ReadPool, WritePool};
use crate::device::DeviceId;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::now_rfc3339;
use crate::op::{AddTagPayload, OpPayload, RemoveTagPayload};
use crate::op_log;
use crate::pagination::BlockRow;
use crate::pagination::PageResponse;
use crate::tag_query::{self, TagCacheRow, TagExpr};
use crate::ulid::BlockId;

use super::*;

/// Add a tag to a block.
///
/// Validates both the block and the tag block exist and are not deleted,
/// checks that `tag_id` refers to a block with `block_type = 'tag'`, ensures
/// the association does not already exist, appends an `AddTag` op, inserts
/// into `block_tags`, and dispatches background cache tasks.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block or tag block does not exist or is deleted
/// - [`AppError::InvalidOperation`] — `tag_id` is not a tag block, or tag already applied
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn add_tag_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    tag_id: String,
) -> Result<TagResponse, AppError> {
    // 1. Build OpPayload
    let payload = OpPayload::AddTag(AddTagPayload {
        block_id: BlockId::from_trusted(&block_id),
        tag_id: BlockId::from_trusted(&tag_id),
    });

    // 2. Single IMMEDIATE transaction: validation + op_log + block_tags write.
    //    BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    //    SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    //    and the actual mutation.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Validate block exists and is not deleted (TOCTOU-safe)
    let exists = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // Validate tag_id refers to a block with block_type = 'tag' and is not deleted (TOCTOU-safe)
    let tag_row = sqlx::query!(
        "SELECT block_type FROM blocks WHERE id = ? AND deleted_at IS NULL",
        tag_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    match tag_row {
        None => {
            return Err(AppError::NotFound(format!(
                "tag block '{tag_id}' (not found or deleted)"
            )));
        }
        Some(ref r) if r.block_type != "tag" => {
            return Err(AppError::InvalidOperation(format!(
                "block '{tag_id}' has block_type '{}', expected 'tag'",
                r.block_type
            )));
        }
        _ => {}
    }

    // Check for existing association (TOCTOU-safe)
    let dup = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
        block_id,
        tag_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if dup.is_some() {
        return Err(AppError::InvalidOperation("tag already applied".into()));
    }

    // 3. Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

    // 4. Insert into block_tags within same transaction
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(&block_id)
        .bind(&tag_id)
        .execute(&mut *tx)
        .await?;

    // P-4: Propagate inherited tag to descendants
    crate::tag_inheritance::propagate_tag_to_descendants(&mut tx, &block_id, &tag_id).await?;

    tx.commit().await?;

    // 5. Dispatch background cache tasks (fire-and-forget)
    materializer.dispatch_background_or_warn(&op_record);

    // 6. Return response
    Ok(TagResponse { block_id, tag_id })
}

/// Remove a tag from a block.
///
/// Validates the block exists and is not deleted, checks the tag association
/// exists, appends a `RemoveTag` op, deletes from `block_tags`, and dispatches
/// background cache tasks.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist, is deleted, or tag association missing
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn remove_tag_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    tag_id: String,
) -> Result<TagResponse, AppError> {
    // 1. Build OpPayload
    let payload = OpPayload::RemoveTag(RemoveTagPayload {
        block_id: BlockId::from_trusted(&block_id),
        tag_id: BlockId::from_trusted(&tag_id),
    });

    // 2. Single IMMEDIATE transaction: validation + op_log + block_tags write.
    //    BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    //    SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    //    and the actual mutation.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Validate block exists and is not deleted (TOCTOU-safe)
    let exists = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // Check association exists (TOCTOU-safe)
    let assoc = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
        block_id,
        tag_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if assoc.is_none() {
        return Err(AppError::NotFound("tag association".into()));
    }

    // 3. Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

    // 4. Delete from block_tags within same transaction
    sqlx::query("DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?")
        .bind(&block_id)
        .bind(&tag_id)
        .execute(&mut *tx)
        .await?;

    // P-4: Clean up inherited tag entries
    crate::tag_inheritance::remove_inherited_tag(&mut tx, &block_id, &tag_id).await?;

    tx.commit().await?;

    // 5. Dispatch background cache tasks (fire-and-forget)
    materializer.dispatch_background_or_warn(&op_record);

    // 6. Return response
    Ok(TagResponse { block_id, tag_id })
}

/// Query blocks by boolean tag expression.
///
/// Builds a `TagExpr` from the provided tag_ids, prefixes, and mode.
/// `mode` is `"and"` for intersection, anything else defaults to `"or"` (union).
/// Returns an empty page when no tag IDs or prefixes are supplied.
#[instrument(skip(pool, tag_ids), err)]
pub async fn query_by_tags_inner(
    pool: &SqlitePool,
    tag_ids: Vec<String>,
    prefixes: Vec<String>,
    mode: String,
    include_inherited: Option<bool>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let mut exprs = Vec::new();
    for tag_id in tag_ids {
        exprs.push(TagExpr::Tag(tag_id));
    }
    for prefix in prefixes {
        exprs.push(TagExpr::Prefix(prefix));
    }

    if exprs.is_empty() {
        return Ok(PageResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
        });
    }

    let expr = match mode.as_str() {
        "and" => TagExpr::And(exprs),
        "not" => TagExpr::Not(Box::new(TagExpr::Or(exprs))),
        _ => TagExpr::Or(exprs), // default to OR
    };

    let page = pagination::PageRequest::new(cursor, limit)?;
    tag_query::eval_tag_query(pool, &expr, &page, include_inherited.unwrap_or(false)).await
}

/// List all tags matching a name prefix (autocomplete / UI).
#[instrument(skip(pool), err)]
pub async fn list_tags_by_prefix_inner(
    pool: &SqlitePool,
    prefix: String,
    limit: Option<i64>,
) -> Result<Vec<TagCacheRow>, AppError> {
    tag_query::list_tags_by_prefix(pool, &prefix, limit).await
}

/// List every tag in the tag cache, up to `limit` entries (default
/// matches `list_tags_by_prefix`'s internal default). Thin wrapper over
/// [`list_tags_by_prefix_inner`] with the empty prefix — exposed under a
/// shorter name for the FEAT-4c MCP `list_tags` tool where "list all"
/// is the primary use case.
#[instrument(skip(pool), err)]
pub async fn list_tags_inner(
    pool: &SqlitePool,
    limit: Option<i64>,
) -> Result<Vec<TagCacheRow>, AppError> {
    list_tags_by_prefix_inner(pool, String::new(), limit).await
}

/// List all tag_ids currently associated with a block.
#[instrument(skip(pool), err)]
pub async fn list_tags_for_block_inner(
    pool: &SqlitePool,
    block_id: String,
) -> Result<Vec<String>, AppError> {
    tag_query::list_tags_for_block(pool, &block_id).await
}

/// Tauri command: add a tag to a block. Delegates to [`add_tag_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn add_tag(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    tag_id: String,
) -> Result<TagResponse, AppError> {
    add_tag_inner(&pool.0, device_id.as_str(), &materializer, block_id, tag_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: remove a tag from a block. Delegates to [`remove_tag_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn remove_tag(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    tag_id: String,
) -> Result<TagResponse, AppError> {
    remove_tag_inner(&pool.0, device_id.as_str(), &materializer, block_id, tag_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: query blocks by boolean tag expression. Delegates to [`query_by_tags_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn query_by_tags(
    pool: State<'_, ReadPool>,
    tag_ids: Vec<String>,
    prefixes: Vec<String>,
    mode: String,
    include_inherited: Option<bool>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    query_by_tags_inner(
        &pool.0,
        tag_ids,
        prefixes,
        mode,
        include_inherited,
        cursor,
        limit,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: list tags matching a name prefix. Delegates to [`list_tags_by_prefix_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_tags_by_prefix(
    pool: State<'_, ReadPool>,
    prefix: String,
    limit: Option<i64>,
) -> Result<Vec<TagCacheRow>, AppError> {
    list_tags_by_prefix_inner(&pool.0, prefix, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list tag IDs for a block. Delegates to [`list_tags_for_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_tags_for_block(
    pool: State<'_, ReadPool>,
    block_id: String,
) -> Result<Vec<String>, AppError> {
    list_tags_for_block_inner(&pool.0, block_id)
        .await
        .map_err(sanitize_internal_error)
}
