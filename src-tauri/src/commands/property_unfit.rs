//! A key's values that don't fit its definition (#6206): counted, listed,
//! removed, converted as the user maps each, and added to a select's options.
//!
//! A value doesn't fit when its `block_properties` row is not in the column
//! its key's type takes (`declared_type_admits_shape`), or when it is a
//! select's text outside the options. `space` and `is_space` are left out,
//! as `count_property_usage` leaves them out, and an undeclared key has none.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use tauri::State;
use tracing::instrument;

use crate::db::{CommandTx, ReadPool, WriteCtx};
use crate::materializer::Materializer;
use agaric_core::error::{AppError, ValidationCode};
use agaric_core::ulid::BlockId;
use agaric_engine::block_ops::{PropertyDeclaration, check_property_value, property_declaration};
use agaric_engine::loro::coerce::{coerce, value_fields_under};
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

/// One value of a key that doesn't fit it, and how many blocks hold it.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct DistinctUnfitValue {
    /// The value as [`list_unfit_property_values_inner`] shows it.
    pub value: String,
    #[serde(flatten)]
    pub counts: PropertyUnfitCounts,
}

/// What replaces one [`DistinctUnfitValue`].
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct UnfitValueReplacement {
    /// A [`DistinctUnfitValue::value`].
    pub value: String,
    /// Read under the key's type as a typed write reads it.
    pub replacement: String,
    /// That value's counts as the user saw them.
    pub acknowledged: PropertyUnfitCounts,
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
    // `CROSS JOIN` pins the definitions as the outer loop and `idx_block_props_key` as the way
    // into their keys' rows: with `sqlite_stat1`, which a vault has once its periodic optimise
    // has run, the planner otherwise drives from every property row of the vault.
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
           CROSS JOIN block_properties bp ON bp.key = d.key
           CROSS JOIN blocks b ON b.id = bp.block_id
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

/// A held value as text: how the list shows it and the distinct read groups it.
fn shown(fields: &PropertyValueFields) -> String {
    PropertyValue::from(fields)
        .as_legacy_string()
        .unwrap_or_default()
}

/// [`PropertyUnfitCounts`] of `held` by each value as [`shown`], in byte order.
fn counts_by_shown(held: &[Unfit]) -> BTreeMap<String, PropertyUnfitCounts> {
    let mut groups = BTreeMap::<String, PropertyUnfitCounts>::new();
    for u in held {
        let counts = groups.entry(shown(&u.fields)).or_default();
        if u.deleted {
            counts.unfit_in_trash += 1;
        } else {
            counts.unfit += 1;
        }
    }
    groups
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
/// doesn't fit it, counted from the rows the list and both actions read: a
/// count query of its own would be a second predicate to drift from theirs.
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
            value: shown(&u.fields),
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

/// The distinct values of `space_id`'s blocks under `key` that don't fit it,
/// the Trash's included, each as [`list_unfit_property_values_inner`] shows it
/// with how many live and trashed blocks hold it, cursor-paginated by that
/// text in byte order: the text "42" and the number 42 are one value. An
/// undeclared key has none.
///
/// # Errors
///
/// - [`AppError::Validation`] — a `limit` outside `PageRequest::new`'s range,
///   or a malformed cursor.
#[instrument(skip(pool, cursor), err)]
pub async fn list_distinct_unfit_property_values_inner(
    pool: &SqlitePool,
    space_id: &str,
    key: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<DistinctUnfitValue>, AppError> {
    let page = PageRequest::new(cursor, limit)?;
    let mut conn = pool.acquire().await?;
    let held = unfit_values(&mut conn, space_id, Some(&key), None, usize::MAX).await?;
    let after = page.after.map(|c| c.id);
    let wanted = usize::try_from(page.limit + 1).unwrap_or(usize::MAX);
    let rows = counts_by_shown(&held)
        .into_iter()
        .filter(|(value, _)| after.as_ref().is_none_or(|a| value > a))
        .take(wanted)
        .map(|(value, counts)| DistinctUnfitValue { value, counts })
        .collect();
    build_page_response(rows, page.limit, |last| Cursor::for_id(last.value.clone()))
}

/// `value` as `key` holds it under `decl`: converted as the projection
/// converts a value (`coerce`), then admitted by the check every typed write
/// passes (`check_property_value`), which adds a select's options and refuses
/// blank text. `None` when it doesn't fit.
fn fitted(key: &str, value: &PropertyValue, decl: &PropertyDeclaration) -> Option<PropertyValue> {
    let held = coerce(value, &decl.value_type)?;
    let f = value_fields_under(&held, &decl.value_type);
    let args = (
        f.value_text,
        f.value_num,
        f.value_date,
        f.value_ref.map(BlockId::into_string),
        f.value_bool,
    );
    check_property_value(key, &args, Some(decl))
        .ok()
        .map(|()| held)
}

/// Refuse a mapping that names no value, or one value twice.
fn refuse_malformed(replacements: &[UnfitValueReplacement]) -> Result<(), AppError> {
    if replacements.is_empty() {
        return Err(AppError::validation("no value to convert".into()));
    }
    let mut seen = BTreeSet::new();
    match replacements.iter().find(|r| !seen.insert(r.value.as_str())) {
        Some(twice) => Err(AppError::validation(format!(
            "'{}' is mapped twice",
            twice.value
        ))),
        None => Ok(()),
    }
}

/// Each replacement [`fitted`] under `key`'s declaration in `space_id`, in
/// the order given.
async fn fitted_replacements(
    conn: &mut SqliteConnection,
    space_id: &str,
    key: &str,
    replacements: &[UnfitValueReplacement],
) -> Result<Vec<PropertyValue>, AppError> {
    let decl = property_declaration(conn, Some(space_id), key)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("property definition '{key}'")))?;
    if decl.value_type == "ref" {
        return Err(AppError::validation(format!(
            "'{key}' is a ref property; its values can't be converted"
        )));
    }
    replacements
        .iter()
        .map(|r| {
            fitted(key, &PropertyValue::Str(r.replacement.clone()), &decl).ok_or_else(|| {
                AppError::validation(format!(
                    "'{}' doesn't fit '{key}' ({})",
                    r.replacement, decl.value_type
                ))
            })
        })
        .collect()
}

/// What `replacements` convert of `held`. Each mapped value's counts must be
/// the ones the user saw; a value left alone may have changed since.
fn acknowledged_counts(
    key: &str,
    held: &[Unfit],
    replacements: &[UnfitValueReplacement],
) -> Result<PropertyUnfitCounts, AppError> {
    let groups = counts_by_shown(held);
    let mut converted = PropertyUnfitCounts::default();
    for r in replacements {
        let counts = groups.get(&r.value).copied().unwrap_or_default();
        if counts != r.acknowledged {
            return Err(AppError::validation_coded(
                ValidationCode::UnacknowledgedPropertyLoss,
                format!(
                    "'{}' of '{key}' is now on {} block(s) and {} in the Trash; look again",
                    r.value, counts.unfit, counts.unfit_in_trash
                ),
            ));
        }
        converted.unfit += counts.unfit;
        converted.unfit_in_trash += counts.unfit_in_trash;
    }
    Ok(converted)
}

/// Replace each value of `space_id`'s blocks under `key` that doesn't fit it,
/// the Trash's included, by the replacement its shown text is mapped to,
/// read under the key's type, in one `RewriteProperties` op recording each, so
/// an undo puts them all back. A value not mapped stays. Returns how many it
/// converted; with nothing to convert it appends no op.
///
/// # Errors
///
/// - [`AppError::Validation`] when `replacements` is empty or maps a value
///   twice, when the key is a ref, or when a replacement doesn't fit the key.
/// - [`AppError::NotFound`] when the space does not declare the key.
/// - [`AppError::Validation`] coded [`ValidationCode::UnacknowledgedPropertyLoss`]
///   when a mapped value's counts differ from its `acknowledged`.
#[instrument(skip(pool, device_id, materializer, replacements), err)]
pub async fn convert_unfit_property_values_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    key: String,
    replacements: Vec<UnfitValueReplacement>,
) -> Result<PropertyUnfitCounts, AppError> {
    refuse_malformed(&replacements)?;
    let mut tx = CommandTx::begin_immediate(pool, "convert_unfit_property_values").await?;
    tx.arm_engine_rollback(materializer.loro_state());
    let fits = fitted_replacements(&mut tx, space_id, &key, &replacements).await?;
    let held = unfit_values(&mut tx, space_id, Some(&key), None, usize::MAX).await?;
    let converted = acknowledged_counts(&key, &held, &replacements)?;
    let mapped: HashMap<&str, &PropertyValue> = replacements
        .iter()
        .map(|r| r.value.as_str())
        .zip(&fits)
        .collect();
    let values: Vec<PropertyValueWrite> = held
        .into_iter()
        .filter_map(|u| {
            let fit = mapped.get(shown(&u.fields).as_str())?;
            Some(PropertyValueWrite {
                block_id: BlockId::from_trusted(&u.block_id),
                key: key.clone(),
                value: value_fields(fit),
                prior: value_fields(&PropertyValue::from(&u.fields)),
            })
        })
        .collect();
    if values.is_empty() {
        return Ok(converted);
    }
    let payload = OpPayload::RewriteProperties(RewritePropertiesPayload {
        space_id: BlockId::from_trusted(space_id),
        reason: RewriteReason::ConvertUnfit,
        defs: Vec::new(),
        values,
    });
    append_and_apply(&mut tx, materializer.loro_state(), device_id, payload).await?;
    tx.commit_and_dispatch(materializer).await?;
    Ok(converted)
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

/// Tauri command: one page of a key's distinct values that don't fit it.
/// Delegates to [`list_distinct_unfit_property_values_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_distinct_unfit_property_values(
    read_pool: State<'_, ReadPool>,
    space_id: SpaceId,
    key: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<DistinctUnfitValue>, AppError> {
    space_id.validate_shape()?;
    list_distinct_unfit_property_values_inner(&read_pool.0, space_id.as_str(), key, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: replace a key's values that don't fit it as mapped.
/// Delegates to [`convert_unfit_property_values_inner`]; the response carries
/// the op ref.
#[tauri::command]
#[specta::specta]
pub async fn convert_unfit_property_values(
    ctx: State<'_, WriteCtx>,
    space_id: SpaceId,
    key: String,
    replacements: Vec<UnfitValueReplacement>,
) -> Result<WithOps<PropertyUnfitCounts>, AppError> {
    space_id.validate_shape()?;
    capture_op_refs(convert_unfit_property_values_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        space_id.as_str(),
        key,
        replacements,
    ))
    .await
    .map_err(sanitize_internal_error)
}
