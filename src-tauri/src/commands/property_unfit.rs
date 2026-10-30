//! A key's values that don't fit its definition (#6206): counted, listed,
//! removed, and added to a select's options.
//!
//! A value doesn't fit when its `block_properties` row is not in the column
//! its key's type takes (`declared_type_admits_shape`), or when it is a
//! select's text outside the options. `space` and `is_space` are left out,
//! as `count_property_usage` leaves them out, and an undeclared key has none.

use std::collections::{BTreeSet, HashMap};

use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use tauri::State;
use tracing::instrument;

use crate::db::{CommandTx, ReadPool, WriteCtx};
use crate::materializer::Materializer;
use agaric_core::error::{AppError, ValidationCode};
use agaric_core::ulid::BlockId;
use agaric_engine::loro::engine::PropertyValue;
use agaric_store::op::{
    OpPayload, PropertyDefState, PropertyValueFields, PropertyValueWrite, RewritePropertiesPayload,
    RewriteReason,
};
use agaric_store::pagination::{Cursor, PageRequest, PageResponse, build_page_response};
use agaric_store::space::SpaceId;

use super::properties::{
    UNCOUNTED_PROPERTY_KEYS, append_and_apply, refuse_builtin_definition_write, user_property_def,
    write_property_def_in_tx,
};
use super::property_keys::{declared_def, value_fields};
use super::{PropertyDefinition, WithOps, capture_op_refs, sanitize_internal_error};

/// How many values of a key don't fit it: `unfit` on live blocks,
/// `unfit_in_trash` on trashed ones.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct PropertyUnfitCounts {
    pub unfit: i64,
    pub unfit_in_trash: i64,
}

/// The column a value is stored in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PropertyValueForm {
    Text,
    Number,
    Date,
    Ref,
    Boolean,
}

impl PropertyValueForm {
    fn of(fields: &PropertyValueFields) -> Self {
        if fields.value_num.is_some() {
            Self::Number
        } else if fields.value_date.is_some() {
            Self::Date
        } else if fields.value_ref.is_some() {
            Self::Ref
        } else if fields.value_bool.is_some() {
            Self::Boolean
        } else {
            Self::Text
        }
    }
}

/// One value that doesn't fit its key: the block holding it, its page, the
/// value as text and the column it is stored in.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct UnfitPropertyValue {
    pub block_id: String,
    pub page_id: Option<String>,
    pub page_title: Option<String>,
    pub content: Option<String>,
    /// The block is in the Trash.
    pub deleted: bool,
    pub value: String,
    pub form: PropertyValueForm,
}

/// A held value that doesn't fit its key, with its block.
struct Unfit {
    key: String,
    block_id: String,
    fields: PropertyValueFields,
    deleted: bool,
    page_id: Option<String>,
    page_title: Option<String>,
    content: Option<String>,
}

/// The built-in definitions whose values count, as a JSON array of
/// `{key, value_type, options}`.
fn counted_builtin_defs() -> Result<String, AppError> {
    Ok(serde_json::to_string(
        &agaric_store::op::BUILTIN_PROPERTY_DEFS
            .iter()
            .filter(|def| !UNCOUNTED_PROPERTY_KEYS.contains(&def.key))
            .map(|def| {
                serde_json::json!({
                    "key": def.key,
                    "value_type": def.value_type,
                    "options": def.options_json(),
                })
            })
            .collect::<Vec<_>>(),
    )?)
}

/// The values of `space_id`'s blocks, the Trash's included, that don't fit
/// their key, or `key` alone, by key then block id from after `after`, up to
/// the first `wanted`.
async fn unfit_values(
    conn: &mut SqliteConnection,
    space_id: &str,
    key: Option<&str>,
    after: Option<&str>,
    wanted: usize,
) -> Result<Vec<Unfit>, AppError> {
    let builtins = counted_builtin_defs()?;
    // Every block id sorts after the empty string, so no cursor is no bound.
    let after = after.unwrap_or_default();
    let mut rows = sqlx::query!(
        r#"WITH defs(key, value_type, options) AS (
               SELECT key, value_type, options FROM property_definitions WHERE space_id = ?1
               UNION ALL
               SELECT json_extract(je.value, '$.key'), json_extract(je.value, '$.value_type'),
                      json_extract(je.value, '$.options')
               FROM json_each(?2) AS je
           )
           SELECT bp.key AS "key!: String", bp.block_id AS "block_id!: String",
                  bp.value_text AS "value_text?: String", bp.value_num AS "value_num?: f64",
                  bp.value_date AS "value_date?: String", bp.value_ref AS "value_ref?: String",
                  bp.value_bool AS "value_bool?: i64",
                  b.deleted_at IS NOT NULL AS "deleted!: bool",
                  b.page_id AS "page_id?: String", pg.content AS "page_title?: String",
                  b.content AS "content?: String"
           FROM defs d
           JOIN block_properties bp ON bp.key = d.key
           JOIN blocks b ON b.id = bp.block_id
           LEFT JOIN blocks pg ON pg.id = b.page_id
           WHERE (?3 IS NULL OR d.key = ?3)
             AND bp.block_id > ?4
             AND (+b.space_id = ?1 OR +b.id = ?1)
             AND NOT CASE d.value_type
                   WHEN 'text' THEN bp.value_text IS NOT NULL OR bp.value_ref IS NOT NULL
                   WHEN 'select' THEN bp.value_ref IS NOT NULL
                        OR (bp.value_text IS NOT NULL
                            AND (d.options IS NULL
                                 OR bp.value_text IN (SELECT value FROM json_each(d.options))))
                   WHEN 'url' THEN bp.value_text IS NOT NULL
                   WHEN 'number' THEN bp.value_num IS NOT NULL
                   WHEN 'date' THEN bp.value_date IS NOT NULL
                   WHEN 'boolean' THEN bp.value_bool IS NOT NULL
                   WHEN 'ref' THEN bp.value_ref IS NOT NULL
                 END
           ORDER BY bp.key, bp.block_id"#,
        space_id,
        builtins,
        key,
        after,
    )
    .fetch(conn);
    let mut values = Vec::new();
    while values.len() < wanted
        && let Some(row) = rows.try_next().await?
    {
        values.push(Unfit {
            key: row.key,
            block_id: row.block_id,
            fields: PropertyValueFields {
                value_text: row.value_text,
                value_num: row.value_num,
                value_date: row.value_date,
                value_ref: row.value_ref.map(BlockId::from),
                value_bool: row.value_bool.map(|b| b != 0),
            },
            deleted: row.deleted,
            page_id: row.page_id,
            page_title: row.page_title,
            content: row.content,
        });
    }
    Ok(values)
}

fn counts_of(values: &[Unfit]) -> PropertyUnfitCounts {
    let count = |n: usize| i64::try_from(n).unwrap_or(i64::MAX);
    let in_trash = values.iter().filter(|u| u.deleted).count();
    PropertyUnfitCounts {
        unfit: count(values.len() - in_trash),
        unfit_in_trash: count(in_trash),
    }
}

/// [`PropertyUnfitCounts`] of every key of `space_id` with a value that
/// doesn't fit it.
pub(super) async fn unfit_counts(
    conn: &mut SqliteConnection,
    space_id: &str,
) -> Result<HashMap<String, PropertyUnfitCounts>, AppError> {
    let values = unfit_values(conn, space_id, None, None, usize::MAX).await?;
    Ok(values
        .chunk_by(|a, b| a.key == b.key)
        .map(|run| (run[0].key.clone(), counts_of(run)))
        .collect())
}

/// The values of `space_id`'s blocks under `key` that don't fit it, the
/// Trash's included, with the block and page holding each, cursor-paginated
/// by block id. An undeclared key has none.
///
/// # Errors
///
/// - [`AppError::Validation`] — a `limit` outside `PageRequest::new`'s range,
///   or a malformed cursor.
#[instrument(skip(pool, cursor), err)]
pub async fn list_unfit_property_values_inner(
    pool: &SqlitePool,
    space_id: &str,
    key: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<UnfitPropertyValue>, AppError> {
    let page = PageRequest::new(cursor, limit)?;
    let mut conn = pool.acquire().await?;
    let after = page.after.as_ref().map(|c| c.id.as_str());
    let wanted = usize::try_from(page.limit + 1).unwrap_or(usize::MAX);
    let rows = unfit_values(&mut conn, space_id, Some(&key), after, wanted)
        .await?
        .into_iter()
        .map(|u| UnfitPropertyValue {
            value: PropertyValue::from(&u.fields)
                .as_legacy_string()
                .unwrap_or_default(),
            form: PropertyValueForm::of(&u.fields),
            block_id: u.block_id,
            page_id: u.page_id,
            page_title: u.page_title,
            content: u.content,
            deleted: u.deleted,
        })
        .collect();
    build_page_response(rows, page.limit, |last| {
        Cursor::for_id(last.block_id.clone())
    })
}

/// Remove every value of `space_id`'s blocks under `key` that doesn't fit
/// it, the Trash's included, in one `RewriteProperties` op recording each,
/// so an undo puts them all back. Returns what it removed; with nothing to
/// remove it appends no op.
///
/// `acknowledged` is what `count_property_usage` answered for the key; the
/// removal counts again in its transaction and refuses when the answer
/// changed.
///
/// # Errors
///
/// - [`AppError::Validation`] coded [`ValidationCode::UnacknowledgedPropertyLoss`]
///   when the counts differ from `acknowledged`.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn remove_unfit_property_values_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    key: String,
    acknowledged: PropertyUnfitCounts,
) -> Result<PropertyUnfitCounts, AppError> {
    let mut tx = CommandTx::begin_immediate(pool, "remove_unfit_property_values").await?;
    tx.arm_engine_rollback(materializer.loro_state());
    let held = unfit_values(&mut tx, space_id, Some(&key), None, usize::MAX).await?;
    let counts = counts_of(&held);
    if counts != acknowledged {
        return Err(AppError::validation_coded(
            ValidationCode::UnacknowledgedPropertyLoss,
            format!(
                "'{key}' now has {} value(s) that don't fit and {} in the Trash; look again",
                counts.unfit, counts.unfit_in_trash
            ),
        ));
    }
    if held.is_empty() {
        return Ok(counts);
    }
    let values = held
        .into_iter()
        .map(|u| PropertyValueWrite {
            block_id: BlockId::from_trusted(&u.block_id),
            key: key.clone(),
            value: None,
            prior: value_fields(&PropertyValue::from(&u.fields)),
        })
        .collect();
    let payload = OpPayload::RewriteProperties(RewritePropertiesPayload {
        space_id: BlockId::from_trusted(space_id),
        reason: RewriteReason::RemoveUnfit,
        defs: Vec::new(),
        values,
    });
    append_and_apply(&mut tx, materializer.loro_state(), device_id, payload).await?;
    tx.commit_and_dispatch(materializer).await?;
    Ok(counts)
}

/// A select's `options` followed by the texts of `held`, sorted: under a
/// select, a text that doesn't fit is one not among them. `options` as stored
/// when `held` has no text.
fn with_unfit_texts(options: Option<&str>, held: &[Unfit]) -> Result<Option<String>, AppError> {
    let added: BTreeSet<&str> = held
        .iter()
        .filter_map(|u| u.fields.value_text.as_deref())
        .collect();
    let Some(stored) = options.filter(|_| !added.is_empty()) else {
        return Ok(options.map(str::to_owned));
    };
    let mut listed: Vec<String> = serde_json::from_str(stored)?;
    listed.extend(added.into_iter().map(str::to_owned));
    Ok(Some(serde_json::to_string(&listed)?))
}

/// Add to `space_id`'s select `key` the texts its blocks hold under it that
/// aren't among its options, the Trash's included, sorted after the options
/// it has, in one `SetPropertyDef` op. With nothing to add it appends no op.
/// Returns the definition after.
///
/// # Errors
///
/// - [`AppError::Validation`] coded [`ValidationCode::BuiltinPropertyLocked`]
///   when the key is built in.
/// - [`AppError::NotFound`] when the space does not declare the key.
/// - [`AppError::Validation`] when the key is not a select.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn add_unfit_values_to_options_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    key: String,
) -> Result<PropertyDefinition, AppError> {
    refuse_builtin_definition_write(&key)?;
    let mut tx = CommandTx::begin_immediate(pool, "add_unfit_values_to_options").await?;
    tx.arm_engine_rollback(materializer.loro_state());
    let def = declared_def(&mut tx, space_id, &key).await?;
    if def.value_type != "select" {
        return Err(AppError::validation(format!(
            "'{key}' is a {} property; only a select has options",
            def.value_type
        )));
    }
    let held = unfit_values(&mut tx, space_id, Some(&key), None, usize::MAX).await?;
    let def = PropertyDefState {
        options: with_unfit_texts(def.options.as_deref(), &held)?,
        ..def
    };
    let state = materializer.loro_state();
    write_property_def_in_tx(&mut tx, state, device_id, space_id, &key, Some(def)).await?;
    let changed = user_property_def(&mut tx, space_id, &key)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("property definition '{key}'")))?;
    tx.commit_and_dispatch(materializer).await?;
    Ok(changed)
}

/// Tauri command: one page of a key's values that don't fit it. Delegates to
/// [`list_unfit_property_values_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_unfit_property_values(
    read_pool: State<'_, ReadPool>,
    space_id: SpaceId,
    key: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<UnfitPropertyValue>, AppError> {
    space_id.validate_shape()?;
    list_unfit_property_values_inner(&read_pool.0, space_id.as_str(), key, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: remove a key's values that don't fit it. Delegates to
/// [`remove_unfit_property_values_inner`]; the response carries the op ref.
#[tauri::command]
#[specta::specta]
pub async fn remove_unfit_property_values(
    ctx: State<'_, WriteCtx>,
    space_id: SpaceId,
    key: String,
    acknowledged: PropertyUnfitCounts,
) -> Result<WithOps<PropertyUnfitCounts>, AppError> {
    space_id.validate_shape()?;
    capture_op_refs(remove_unfit_property_values_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        space_id.as_str(),
        key,
        acknowledged,
    ))
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: add a select's values that don't fit it to its options.
/// Delegates to [`add_unfit_values_to_options_inner`]; the response carries
/// the op ref.
#[tauri::command]
#[specta::specta]
pub async fn add_unfit_values_to_options(
    ctx: State<'_, WriteCtx>,
    space_id: SpaceId,
    key: String,
) -> Result<WithOps<PropertyDefinition>, AppError> {
    space_id.validate_shape()?;
    capture_op_refs(add_unfit_values_to_options_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        space_id.as_str(),
        key,
    ))
    .await
    .map_err(sanitize_internal_error)
}
