//! A tag's suggested properties (#6755): the keys a tag lists under
//! `tag_properties` ([`agaric_store::op::TAG_PROPERTIES_KEY`]), offered as empty rows on the blocks tagged with it,
//! and a value set on all of them at once.
//!
//! "Tagged with it" is the tag page's set (`TaggedItemsSection`): pages and
//! content blocks carrying the tag directly, attached or written inline,
//! live, in the tag's space, neither under a template page nor a saved view.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use tauri::State;
use tracing::instrument;

use crate::db::{CommandTx, ReadPool, WriteCtx};
use crate::materializer::Materializer;
use agaric_core::error::{AppError, ValidationCode};
use agaric_core::ulid::BlockId;
use agaric_engine::block_ops::{
    PropertyDeclaration, check_property_fields, property_declaration, set_property_value_in_tx,
};
use agaric_store::op::{PropertyList, PropertyValueFields};

use super::history::MAX_REVERT_OPS;
use super::properties::refuse_builtin_definition_write;
use super::property_keys::refuse_internal_key;
use super::{SetPropertyArgs, WithOps, capture_op_refs, sanitize_internal_error};

/// A key a block is offered because a tag it carries lists it: `tag_id` is the
/// tag that lists it, the block's own or one its name nests under.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct SuggestedProperty {
    pub key: String,
    pub tag_id: String,
    pub tag_name: String,
}

/// A value to set on the blocks tagged with `tag_id`: those tagged with a tag
/// nested under it too when `include_nested`, and over the values they hold
/// when `overwrite`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct TaggedBlocksWrite {
    pub tag_id: BlockId,
    pub key: String,
    pub value: SetPropertyArgs,
    #[serde(default)]
    pub include_nested: bool,
    #[serde(default)]
    pub overwrite: bool,
}

/// What a [`TaggedBlocksWrite`] does: `added` blocks get the value, which they
/// lack; `changed` blocks hold another value, which it replaces (none without
/// `overwrite`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct TaggedWriteCounts {
    pub added: i64,
    pub changed: i64,
}

/// The keys `block_id` is offered and does not hold, each once, from the
/// first tag by name that lists it. Nothing for a block that is gone, in the
/// Trash, under a template page or a saved view.
///
/// # Errors
///
/// Returns [`AppError`] if the query fails.
#[instrument(skip(pool), err)]
pub async fn list_suggested_properties_inner(
    pool: &SqlitePool,
    block_id: BlockId,
) -> Result<Vec<SuggestedProperty>, AppError> {
    let block_id = block_id.as_str();
    let rows = sqlx::query_as!(
        SuggestedProperty,
        r#"WITH direct(id, content, space_id) AS (
               SELECT t.id, t.content, t.space_id FROM blocks t
               WHERE t.block_type = 'tag' AND t.deleted_at IS NULL
                 AND t.id IN (SELECT tag_id FROM block_tags WHERE block_id = ?1
                              UNION SELECT tag_id FROM block_tag_refs WHERE source_id = ?1)
                 AND EXISTS (SELECT 1 FROM blocks b WHERE b.id = ?1 AND b.deleted_at IS NULL
                     AND NOT EXISTS (SELECT 1 FROM block_properties tp
                                     WHERE tp.block_id = b.page_id AND tp.key = 'template')
                     AND b.id NOT IN (SELECT block_id FROM block_properties
                                      WHERE key = 'saved_view'))
           ),
           givers(id, content) AS (
               SELECT DISTINCT g.id, g.content FROM direct d
               JOIN blocks g ON g.block_type = 'tag' AND g.deleted_at IS NULL
                AND g.space_id IS d.space_id
                AND (g.id = d.id
                     OR substr(d.content, 1, length(g.content) + 1)
                        = (g.content || '/') COLLATE NOCASE)
           )
           SELECT CAST(je.value AS TEXT) AS "key!: String", g.id AS "tag_id!: String",
                  g.content AS "tag_name!: String"
           FROM givers g
           JOIN block_properties bp ON bp.block_id = g.id AND bp.key = 'tag_properties'
           JOIN json_each(bp.value_list) je
           WHERE je.type = 'text'
             AND NOT EXISTS (SELECT 1 FROM block_properties h
                             WHERE h.block_id = ?1 AND h.key = je.value)
           ORDER BY g.content COLLATE NOCASE, g.id, je.key"#,
        block_id,
    )
    .fetch_all(pool)
    .await?;
    let mut seen = std::collections::HashSet::new();
    Ok(rows
        .into_iter()
        .filter(|row| seen.insert(row.key.clone()))
        .collect())
}

/// A tagged block and the value it holds under the written key.
struct TaggedRow {
    id: String,
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
    value_bool: Option<bool>,
    value_list: Option<PropertyList>,
    holds: bool,
}

/// Every block tagged with `tag_id` (and, with `include_nested`, with a tag
/// nested under it), with what it holds under `key`.
async fn tagged_rows(
    conn: &mut SqliteConnection,
    tag_id: &str,
    include_nested: bool,
    key: &str,
) -> Result<Vec<TaggedRow>, AppError> {
    Ok(sqlx::query_as!(
        TaggedRow,
        r#"WITH tag AS (
               SELECT id, content, space_id FROM blocks
               WHERE id = ?1 AND block_type = 'tag' AND deleted_at IS NULL
           ),
           tagset(id) AS (
               SELECT n.id FROM tag p JOIN blocks n
                 ON n.id = p.id OR (?2 AND n.block_type = 'tag' AND n.deleted_at IS NULL
                    AND n.space_id IS p.space_id
                    AND substr(n.content, 1, length(p.content) + 1)
                        = (p.content || '/') COLLATE NOCASE)
           )
           SELECT b.id AS "id!: String", bp.value_text, bp.value_num, bp.value_date,
                  bp.value_ref, bp.value_bool AS "value_bool: bool",
                  bp.value_list AS "value_list: PropertyList",
                  bp.block_id IS NOT NULL AS "holds!: bool"
           FROM blocks b
           LEFT JOIN block_properties bp ON bp.block_id = b.id AND bp.key = ?3
           WHERE b.id IN (SELECT block_id FROM block_tags WHERE tag_id IN (SELECT id FROM tagset)
                          UNION SELECT source_id FROM block_tag_refs
                                WHERE tag_id IN (SELECT id FROM tagset))
             AND b.block_type IN ('page', 'content')
             AND b.deleted_at IS NULL
             AND b.space_id = (SELECT space_id FROM tag)
             AND NOT EXISTS (SELECT 1 FROM block_properties tp
                             WHERE tp.block_id = b.page_id AND tp.key = 'template')
             AND b.id NOT IN (SELECT block_id FROM block_properties WHERE key = 'saved_view')
           ORDER BY b.id"#,
        tag_id,
        include_nested,
        key,
    )
    .fetch_all(conn)
    .await?)
}

impl TaggedRow {
    fn held(&self) -> PropertyValueFields {
        PropertyValueFields {
            value_text: self.value_text.clone(),
            value_num: self.value_num,
            value_date: self.value_date.clone(),
            value_ref: self.value_ref.clone().map(BlockId::from),
            value_bool: self.value_bool,
            value_list: self.value_list.clone(),
        }
    }
}

/// The checked write: the value as fields, its key's declaration in the tag's
/// space, and the blocks to write with their counts.
struct Plan {
    value: PropertyValueFields,
    declaration: Option<PropertyDeclaration>,
    targets: Vec<String>,
    counts: TaggedWriteCounts,
}

/// Check `write` as `set_property` checks a value, under the key's
/// definition in the tag's space, and pick the blocks it writes. A built-in
/// key or one the app keeps for itself is refused: those are set where their
/// own rules run.
async fn plan(conn: &mut SqliteConnection, write: &TaggedBlocksWrite) -> Result<Plan, AppError> {
    refuse_builtin_definition_write(&write.key)?;
    refuse_internal_key(&write.key)?;
    let tag_id = write.tag_id.as_str();
    let space_id = sqlx::query_scalar!(
        "SELECT space_id FROM blocks WHERE id = ? AND block_type = 'tag' AND deleted_at IS NULL",
        tag_id,
    )
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("tag '{tag_id}' does not exist")))?;
    let declaration = property_declaration(conn, space_id.as_deref(), &write.key).await?;
    let SetPropertyArgs {
        value_text,
        value_num,
        value_date,
        value_ref,
        value_bool,
        value_list,
    } = write.value.clone();
    let value = PropertyValueFields {
        value_text,
        value_num,
        value_date,
        value_ref: value_ref.map(BlockId::from),
        value_bool,
        value_list,
    };
    check_property_fields(&write.key, value.clone(), declaration.as_ref())?;
    let mut counts = TaggedWriteCounts::default();
    let mut targets = Vec::new();
    for row in tagged_rows(conn, tag_id, write.include_nested, &write.key).await? {
        if !row.holds {
            counts.added += 1;
        } else if write.overwrite && row.held() != value {
            counts.changed += 1;
        } else {
            continue;
        }
        targets.push(row.id);
    }
    Ok(Plan {
        value,
        declaration,
        targets,
        counts,
    })
}

/// What [`set_property_on_tagged_blocks_inner`] would write, without writing.
///
/// # Errors
///
/// - [`AppError::NotFound`] — `tag_id` is not a live tag.
/// - [`AppError::Validation`] — the value does not fit the key's definition
///   in the tag's space, or the key is built in or the app's own.
#[instrument(skip(pool, write), err)]
pub async fn preview_set_property_on_tagged_blocks_inner(
    pool: &SqlitePool,
    write: TaggedBlocksWrite,
) -> Result<TaggedWriteCounts, AppError> {
    let mut conn = pool.acquire().await?;
    Ok(plan(&mut conn, &write).await?.counts)
}

/// Set `write`'s value on the blocks tagged with its tag, chosen and counted
/// in one `BEGIN IMMEDIATE` transaction, as one `set_property` op per block,
/// so one `undo_ops` of the refs reverts them all and puts each overwritten
/// value back. Returns what it wrote; with nothing to write it appends no op.
///
/// `acknowledged` is what the preview answered; a recount that differs is
/// refused so the user can look again.
///
/// # Errors
///
/// - Every error of [`preview_set_property_on_tagged_blocks_inner`].
/// - [`AppError::Validation`] coded [`ValidationCode::UnacknowledgedPropertyLoss`]
///   when the counts differ from `acknowledged`.
/// - [`AppError::Validation`] when it would write more ops than one undo
///   reverts (`MAX_REVERT_OPS`).
#[instrument(skip(pool, device_id, materializer, write), err)]
pub async fn set_property_on_tagged_blocks_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    write: TaggedBlocksWrite,
    acknowledged: TaggedWriteCounts,
) -> Result<TaggedWriteCounts, AppError> {
    let mut tx = CommandTx::begin_immediate(pool, "set_property_on_tagged_blocks").await?;
    tx.arm_engine_rollback(materializer.loro_state());
    let plan = plan(&mut tx, &write).await?;
    if plan.counts != acknowledged {
        return Err(AppError::validation_coded(
            ValidationCode::UnacknowledgedPropertyLoss,
            format!(
                "{} block(s) would now get '{}' and {} value(s) would change; look again",
                plan.counts.added, write.key, plan.counts.changed
            ),
        ));
    }
    if plan.targets.len() > MAX_REVERT_OPS {
        return Err(AppError::validation(format!(
            "setting '{}' on {} blocks is more than one undo can take back \
             (maximum is {MAX_REVERT_OPS})",
            write.key,
            plan.targets.len()
        )));
    }
    for id in plan.targets {
        // Boxed: inlined, the six-slot write trips `clippy::large_futures`.
        let (_, record) = Box::pin(set_property_value_in_tx(
            &mut tx,
            materializer.loro_state(),
            device_id,
            id,
            &write.key,
            plan.value.clone(),
            plan.declaration.clone(),
        ))
        .await?;
        tx.enqueue_background(Arc::new(record));
    }
    tx.commit_and_dispatch(materializer).await?;
    Ok(plan.counts)
}

/// Tauri command: [`list_suggested_properties_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_suggested_properties(
    pool: State<'_, ReadPool>,
    block_id: BlockId,
) -> Result<Vec<SuggestedProperty>, AppError> {
    list_suggested_properties_inner(&pool.0, block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: [`preview_set_property_on_tagged_blocks_inner`].
#[tauri::command]
#[specta::specta]
pub async fn preview_set_property_on_tagged_blocks(
    pool: State<'_, ReadPool>,
    write: TaggedBlocksWrite,
) -> Result<TaggedWriteCounts, AppError> {
    preview_set_property_on_tagged_blocks_inner(&pool.0, write)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: [`set_property_on_tagged_blocks_inner`], with the refs of
/// the ops it appended for the toast's Undo.
#[tauri::command]
#[specta::specta]
pub async fn set_property_on_tagged_blocks(
    ctx: State<'_, WriteCtx>,
    write: TaggedBlocksWrite,
    acknowledged: TaggedWriteCounts,
) -> Result<WithOps<TaggedWriteCounts>, AppError> {
    capture_op_refs(set_property_on_tagged_blocks_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        write,
        acknowledged,
    ))
    .await
    .map_err(sanitize_internal_error)
}
