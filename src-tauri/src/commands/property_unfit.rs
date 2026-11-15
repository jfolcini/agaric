//! A key's values that don't fit its definition (#6206): counted, listed,
//! removed, converted as the user maps each, moved to another key where they
//! fit, and added to a select's options.
//!
//! A value doesn't fit when its `block_properties` row is not in the column
//! its key's type takes (`declared_type_admits_shape`), or when it is a
//! select's text outside the options. Under a key that holds a list (#6741),
//! a value fits when it is a list a write of it would be taken as
//! (`check_property_fields`), so a single value doesn't; under any other key
//! a list doesn't. `space` and `is_space` are left out,
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
use agaric_engine::block_ops::{PropertyDeclaration, check_property_fields, property_declaration};
use agaric_engine::import::property_list_items;
use agaric_engine::loro::coerce::{coerce, value_fields_under};
use agaric_engine::loro::engine::PropertyValue;
use agaric_store::op::{
    OpPayload, PropertyDefState, PropertyList, PropertyListItem, PropertyValueFields,
    PropertyValueWrite, RewritePropertiesPayload, RewriteReason,
};
use agaric_store::pagination::{Cursor, PageRequest, PageResponse, build_page_response};
use agaric_store::space::SpaceId;

use super::properties::{
    UNCOUNTED_PROPERTY_KEYS, append_and_apply, refuse_builtin_definition_write, user_property_def,
    write_property_def_in_tx,
};
use super::property_keys::{
    declared_def, refuse_internal_key, shown_value, value_fields, visible_holders,
};
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
    List,
}

impl PropertyValueForm {
    fn of(fields: &PropertyValueFields) -> Self {
        if fields.value_list.is_some() {
            Self::List
        } else if fields.value_num.is_some() {
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

/// What moving a key's values that don't fit to another key does to a
/// space's blocks, the Trash's included: `moved` values fit the other key and
/// move to it; on `occupied` blocks, which hold it already, and as
/// `unfit_there` values, which don't fit it, they stay.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct UnfitMoveCounts {
    pub moved: i64,
    pub occupied: i64,
    pub unfit_there: i64,
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

/// A `block_properties` row [`unfit_values`] reads, with its key's definition.
struct UnfitRow {
    key: String,
    block_id: String,
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
    value_bool: Option<i64>,
    value_list: Option<PropertyList>,
    value_type: String,
    options: Option<String>,
    multiple: bool,
    deleted: bool,
    page_id: Option<String>,
    page_title: Option<String>,
    content: Option<String>,
}

impl UnfitRow {
    /// The row as a value that doesn't fit its key, or `None` when it does.
    /// The query keeps every value of a key that holds a list: whether a
    /// list's items fit is the write check's to say.
    fn unfit(self) -> Option<Unfit> {
        let fields = PropertyValueFields {
            value_text: self.value_text,
            value_num: self.value_num,
            value_date: self.value_date,
            value_ref: self.value_ref.map(BlockId::from),
            value_bool: self.value_bool.map(|b| b != 0),
            value_list: self.value_list,
        };
        if self.multiple {
            let decl = PropertyDeclaration {
                value_type: self.value_type,
                options: self.options,
                multiple: true,
            };
            if check_property_fields(&self.key, fields.clone(), Some(&decl)).is_ok() {
                return None;
            }
        }
        Some(Unfit {
            key: self.key,
            block_id: self.block_id,
            fields,
            deleted: self.deleted,
            page_id: self.page_id,
            page_title: self.page_title,
            content: self.content,
        })
    }
}

/// The built-in definitions whose values count, as a JSON array of
/// `{key, value_type, options}`; none holds a list.
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
    let mut rows = sqlx::query_as!(
        UnfitRow,
        r#"WITH defs(key, value_type, options, multiple) AS (
               SELECT key, value_type, options, multiple
               FROM property_definitions WHERE space_id = ?1
               UNION ALL
               SELECT json_extract(je.value, '$.key'), json_extract(je.value, '$.value_type'),
                      json_extract(je.value, '$.options'), 0
               FROM json_each(?2) AS je
           )
           SELECT bp.key AS "key!: String", bp.block_id AS "block_id!: String",
                  bp.value_text AS "value_text?: String", bp.value_num AS "value_num?: f64",
                  bp.value_date AS "value_date?: String", bp.value_ref AS "value_ref?: String",
                  bp.value_bool AS "value_bool?: i64",
                  bp.value_list AS "value_list?: PropertyList",
                  d.value_type AS "value_type!: String", d.options AS "options?: String",
                  d.multiple AS "multiple!: bool",
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
             AND (d.multiple OR NOT CASE d.value_type
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
                 END)
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
        values.extend(row.unfit());
    }
    Ok(values)
}

/// A held value as text: how the list shows it and the distinct read groups it.
fn shown(fields: &PropertyValueFields) -> String {
    shown_value(&PropertyValue::from(fields))
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
/// doesn't fit it, counted from the rows the list and every action read: a
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

/// A select's options followed by the texts of `held` they lack, sorted:
/// each text that doesn't fit, or under a select that holds a list each such
/// item of the lists that don't. The options as stored when nothing is added.
fn with_unfit_texts(def: &PropertyDefState, held: &[Unfit]) -> Result<Option<String>, AppError> {
    let Some(stored) = def.options.as_deref() else {
        return Ok(None);
    };
    let mut listed: Vec<String> = serde_json::from_str(stored)?;
    let texts = held.iter().flat_map(|u| -> Vec<&str> {
        match (&u.fields.value_list, def.multiple) {
            (Some(list), true) => list.texts().collect(),
            (None, false) => u.fields.value_text.as_deref().into_iter().collect(),
            _ => Vec::new(),
        }
    });
    let added: BTreeSet<&str> = texts
        .filter(|text| !listed.iter().any(|o| o == text))
        .collect();
    if added.is_empty() {
        return Ok(Some(stored.to_owned()));
    }
    listed.extend(added.into_iter().map(str::to_owned));
    Ok(Some(serde_json::to_string(&listed)?))
}

/// Add to `space_id`'s select `key` the texts its blocks hold under it that
/// aren't among its options, the Trash's included (under a select that holds
/// a list, the items of its lists), sorted after the options it has, in one
/// `SetPropertyDef` op. With nothing to add it appends no op.
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
        options: with_unfit_texts(&def, &held)?,
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
/// converts a value (`coerce`), under a key that holds a list each item of
/// one, then admitted by the check every typed write passes
/// (`check_property_fields`), which adds a select's options and refuses blank
/// text. `None` when it doesn't fit: a list fits only a key that holds one,
/// and a single value only a key that doesn't.
fn fitted(key: &str, value: &PropertyValue, decl: &PropertyDeclaration) -> Option<PropertyValue> {
    let held = match (value, decl.multiple) {
        (PropertyValue::List(list), true) => PropertyValue::List(PropertyList(
            list.0
                .iter()
                .map(|item| coerce(&PropertyValue::from(item), &decl.value_type)?.into_list_item())
                .collect::<Option<_>>()?,
        )),
        (_, true) => return None,
        (single, false) => coerce(single, &decl.value_type)?,
    };
    let fields = value_fields_under(&held, &decl.value_type);
    check_property_fields(key, fields, Some(decl))
        .ok()
        .map(|()| held)
}

/// The value a replacement's text is read as under `decl`: under a key that
/// holds a list, the items of the text ([`property_list_items`]).
fn replacement_value(replacement: &str, decl: &PropertyDeclaration) -> PropertyValue {
    if !decl.multiple {
        return PropertyValue::Str(replacement.to_owned());
    }
    let items = property_list_items(replacement);
    PropertyValue::List(PropertyList(
        items.into_iter().map(PropertyListItem::Text).collect(),
    ))
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
            fitted(key, &replacement_value(&r.replacement, &decl), &decl).ok_or_else(|| {
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
/// read under the key's type (under a key that holds a list, as the list its
/// text writes), in one `RewriteProperties` op recording each, so an undo puts
/// them all back. A value not mapped stays. Returns how many it
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

/// `into_key`'s declaration in `space_id`, as the key a move of `key`'s
/// values that don't fit takes them to: a user's key, not `key`, not the app's
/// own, and not a ref, whose values are blocks.
async fn move_target(
    conn: &mut SqliteConnection,
    space_id: &str,
    key: &str,
    into_key: &str,
) -> Result<PropertyDeclaration, AppError> {
    if into_key == key {
        return Err(AppError::validation(format!(
            "the values of '{key}' cannot move to '{key}' itself"
        )));
    }
    refuse_builtin_definition_write(into_key)?;
    refuse_internal_key(into_key)?;
    let def = declared_def(conn, space_id, into_key).await?;
    if def.value_type == "ref" {
        return Err(AppError::validation(format!(
            "'{into_key}' is a ref property; its values are blocks"
        )));
    }
    Ok(PropertyDeclaration {
        value_type: def.value_type,
        options: def.options,
        multiple: def.multiple,
    })
}

/// What moving `space_id`'s values under `key` that don't fit it to
/// `into_key` does, and per value moved its two writes, by block: removed
/// under `key`, then written under `into_key` as [`fitted`] to it, a list
/// only under a key that holds one. A block
/// holding `into_key` keeps its value under `key`, whether or not it would
/// fit; a target that is no ref has a `block_properties` row for each value,
/// so the write over none records none.
async fn plan_move(
    conn: &mut SqliteConnection,
    space_id: &str,
    key: &str,
    into_key: &str,
) -> Result<(UnfitMoveCounts, Vec<PropertyValueWrite>), AppError> {
    let decl = move_target(conn, space_id, key, into_key).await?;
    let held = unfit_values(conn, space_id, Some(key), None, usize::MAX).await?;
    let occupied = visible_holders(conn, space_id, into_key).await?;
    let mut counts = UnfitMoveCounts::default();
    let mut writes = Vec::new();
    for u in held {
        if occupied.contains(&u.block_id) {
            counts.occupied += 1;
            continue;
        }
        let value = PropertyValue::from(&u.fields);
        let Some(fit) = fitted(into_key, &value, &decl) else {
            counts.unfit_there += 1;
            continue;
        };
        counts.moved += 1;
        let block_id = BlockId::from_trusted(&u.block_id);
        writes.push(PropertyValueWrite {
            block_id: block_id.clone(),
            key: key.to_owned(),
            value: None,
            prior: value_fields(&value),
        });
        writes.push(PropertyValueWrite {
            block_id,
            key: into_key.to_owned(),
            value: value_fields(&fit),
            prior: None,
        });
    }
    Ok((counts, writes))
}

/// What moving `space_id`'s values under `key` that don't fit it to
/// `into_key` would do, which [`move_unfit_property_values_inner`] takes as
/// its acknowledgement. Refused as the move is.
///
/// # Errors
///
/// The refusals of [`move_unfit_property_values_inner`] but the stale
/// acknowledgement's.
#[instrument(skip(pool), err)]
pub async fn preview_unfit_property_move_inner(
    pool: &SqlitePool,
    space_id: &str,
    key: String,
    into_key: String,
) -> Result<UnfitMoveCounts, AppError> {
    let mut conn = pool.acquire().await?;
    Ok(plan_move(&mut conn, space_id, &key, &into_key).await?.0)
}

/// Move each value of `space_id`'s blocks under `key` that doesn't fit it,
/// the Trash's included, to `into_key` on the same block, where it fits read
/// under `into_key`'s type, in one `RewriteProperties` op recording each, so
/// an undo puts them all back. A value on a block holding `into_key` stays,
/// and so does one that doesn't fit `into_key`. `key` may be a built-in.
/// Returns what it moved and left; with nothing to move it appends no op.
///
/// `acknowledged` is what [`preview_unfit_property_move_inner`] answered; the
/// move counts again in its transaction and refuses when the answer changed.
///
/// # Errors
///
/// - [`AppError::Validation`] when `into_key` is `key`, the app's own or a
///   ref.
/// - [`AppError::Validation`] coded [`ValidationCode::BuiltinPropertyLocked`]
///   when `into_key` is built in.
/// - [`AppError::NotFound`] when the space does not declare `into_key`.
/// - [`AppError::Validation`] coded [`ValidationCode::UnacknowledgedPropertyLoss`]
///   when the counts differ from `acknowledged`.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn move_unfit_property_values_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    key: String,
    into_key: String,
    acknowledged: UnfitMoveCounts,
) -> Result<UnfitMoveCounts, AppError> {
    let mut tx = CommandTx::begin_immediate(pool, "move_unfit_property_values").await?;
    tx.arm_engine_rollback(materializer.loro_state());
    let (counts, values) = plan_move(&mut tx, space_id, &key, &into_key).await?;
    if counts != acknowledged {
        return Err(AppError::validation_coded(
            ValidationCode::UnacknowledgedPropertyLoss,
            format!(
                "moving '{key}' to '{into_key}' now moves {}, and leaves {} already set there \
                 and {} that don't fit; look again",
                counts.moved, counts.occupied, counts.unfit_there
            ),
        ));
    }
    if values.is_empty() {
        return Ok(counts);
    }
    let payload = OpPayload::RewriteProperties(RewritePropertiesPayload {
        space_id: BlockId::from_trusted(space_id),
        reason: RewriteReason::MoveUnfit,
        defs: Vec::new(),
        values,
    });
    append_and_apply(&mut tx, materializer.loro_state(), device_id, payload).await?;
    tx.commit_and_dispatch(materializer).await?;
    Ok(counts)
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

/// Tauri command: what moving a key's values that don't fit to another key
/// would move and leave. Delegates to [`preview_unfit_property_move_inner`].
#[tauri::command]
#[specta::specta]
pub async fn preview_unfit_property_move(
    read_pool: State<'_, ReadPool>,
    space_id: SpaceId,
    key: String,
    into_key: String,
) -> Result<UnfitMoveCounts, AppError> {
    space_id.validate_shape()?;
    preview_unfit_property_move_inner(&read_pool.0, space_id.as_str(), key, into_key)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: move a key's values that don't fit to another key where
/// they fit. Delegates to [`move_unfit_property_values_inner`]; the response
/// carries the op ref.
#[tauri::command]
#[specta::specta]
pub async fn move_unfit_property_values(
    ctx: State<'_, WriteCtx>,
    space_id: SpaceId,
    key: String,
    into_key: String,
    acknowledged: UnfitMoveCounts,
) -> Result<WithOps<UnfitMoveCounts>, AppError> {
    space_id.validate_shape()?;
    capture_op_refs(move_unfit_property_values_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        space_id.as_str(),
        key,
        into_key,
        acknowledged,
    ))
    .await
    .map_err(sanitize_internal_error)
}
