//! Change a property's type (#5841): one `RewriteProperties` op, in the space
//! whose definition it is, converting each value the space's blocks hold
//! under the key, the Trash's included, and keeping the ones the new type
//! does not take as they are, after the user has seen which (#6206).
//!
//! A change may also turn the key into one that holds a list, or back
//! (#6741): [`convert`] is the one rule for what each held value becomes.
//!
//! Preview, list and write read the values from the `block_properties` rows.
//! A value only the space's doc holds (a ref whose block is gone) is left
//! there, and its projection follows the new type.

use std::collections::HashMap;

use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use tauri::State;
use tracing::instrument;

use crate::db::{CommandTx, ReadPool, WriteCtx};
use crate::materializer::Materializer;
use agaric_core::error::{AppError, ValidationCode};
use agaric_core::ulid::BlockId;
use agaric_engine::loro::coerce::coerce;
use agaric_engine::loro::engine::PropertyValue;
use agaric_store::op::{
    OpPayload, PropertyDefState, PropertyDefWrite, PropertyList, PropertyListItem,
    PropertyValueFields, PropertyValueWrite, RewritePropertiesPayload, RewriteReason,
};
use agaric_store::pagination::{Cursor, PageRequest, PageResponse, build_page_response};
use agaric_store::space::SpaceId;

use super::properties::{
    append_and_apply, refuse_builtin_definition_write, user_property_def,
    validate_property_def_shape, validate_property_def_state,
};
use super::property_keys::{declared_def, refuse_internal_key, shown_value, value_fields};
use super::{PropertyDefinition, WithOps, capture_op_refs, sanitize_internal_error};

/// What changing a key's type does to a space's values, the Trash's included:
/// `converted` ones are kept in the new type's form (one already in it among
/// them), `unfit` ones the new type does not take, and they stay as they are,
/// not fitting it (#6206).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct PropertyTypeChangeCounts {
    pub converted: i64,
    pub unfit: i64,
}

/// Which of a type change's values [`list_property_type_change_values_inner`]
/// lists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PropertyTypeChangeKind {
    Converted,
    Unfit,
}

/// One value a type change converts or leaves unfit: the block holding it, its
/// page, and the value as text, before and after.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct PropertyTypeChangeValue {
    pub block_id: String,
    pub page_id: Option<String>,
    pub page_title: Option<String>,
    pub content: Option<String>,
    /// The block is in the Trash; its value changes all the same.
    pub deleted: bool,
    /// The value the block holds, as text.
    pub value: String,
    /// The value under the new type, as text; `None` when it does not fit.
    pub converted: Option<String>,
}

/// Where a type change splits one text into a list's items, and what it
/// joins a list's items with into one text (#6741).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ListSeparator {
    Comma,
    Semicolon,
}

impl ListSeparator {
    fn char(self) -> char {
        match self {
            Self::Comma => ',',
            Self::Semicolon => ';',
        }
    }

    fn joiner(self) -> &'static str {
        match self {
            Self::Comma => ", ",
            Self::Semicolon => "; ",
        }
    }
}

/// The type a change takes `key` to: `value_type`, for a select its
/// `options` (a JSON array), and whether the key holds a list (`multiple`;
/// `None` keeps what it holds now). `separator` splits a text into a list's
/// items, or joins a list into one text; `None` does neither.
#[derive(Debug, Clone)]
pub struct PropertyTypeTarget {
    pub key: String,
    pub value_type: String,
    pub options: Option<String>,
    pub multiple: Option<bool>,
    pub separator: Option<ListSeparator>,
}

/// A held value: the block, the value, and what it becomes under the new type
/// (`None`: it does not fit).
type Conversion = (String, PropertyValue, Option<PropertyValue>);

/// The definition a change leaves, with its select options parsed, and the
/// separator the change splits or joins with.
struct ConversionRule<'a> {
    to: &'a PropertyDefState,
    options: Option<Vec<String>>,
    separator: Option<ListSeparator>,
}

impl ConversionRule<'_> {
    /// One value under the new type: what [`coerce`] makes of it, and under a
    /// select only one of the options.
    fn item(&self, value: &PropertyValue) -> Option<PropertyValue> {
        let fit = coerce(value, &self.to.value_type)?;
        let listed = match (&fit, &self.options) {
            (PropertyValue::Str(s), Some(options)) => options.contains(s),
            _ => true,
        };
        listed.then_some(fit)
    }

    /// `items` as the list the new definition holds: every one converted, and
    /// at least one, or nothing.
    fn list(&self, items: &[PropertyValue]) -> Option<PropertyValue> {
        let converted = items
            .iter()
            .map(|item| match self.item(item)? {
                PropertyValue::Str(s) => Some(PropertyListItem::Text(s)),
                PropertyValue::Num(n) => Some(PropertyListItem::Num(n)),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()?;
        (!converted.is_empty()).then_some(PropertyValue::List(PropertyList(converted)))
    }

    /// What a held `value` becomes under the new definition, or `None` when it
    /// does not fit (#6741): a single value becomes a list of one item, or of
    /// the parts its text splits into at the separator; a list of one item
    /// becomes that item, and a longer one only a text or URL, joined by the
    /// separator.
    fn convert(&self, value: &PropertyValue) -> Option<PropertyValue> {
        match (value, self.to.multiple) {
            (PropertyValue::List(list), true) => {
                self.list(&list.0.iter().map(item_value).collect::<Vec<_>>())
            }
            (PropertyValue::List(list), false) => match (list.0.as_slice(), self.separator) {
                ([only], _) => self.item(&item_value(only)),
                (items, Some(separator))
                    if matches!(self.to.value_type.as_str(), "text" | "url") =>
                {
                    let texts: Vec<String> = items.iter().map(item_text).collect();
                    Some(PropertyValue::Str(texts.join(separator.joiner())))
                }
                _ => None,
            },
            (PropertyValue::Str(text), true) if self.separator.is_some() => {
                let separator = self.separator.map(ListSeparator::char)?;
                let parts = text.split(separator).map(str::trim);
                self.list(
                    &parts
                        .filter(|part| !part.is_empty())
                        .map(|part| PropertyValue::Str(part.to_owned()))
                        .collect::<Vec<_>>(),
                )
            }
            (single, true) => self.list(std::slice::from_ref(single)),
            (single, false) => self.item(single),
        }
    }
}

fn item_value(item: &PropertyListItem) -> PropertyValue {
    match item {
        PropertyListItem::Text(s) => PropertyValue::Str(s.clone()),
        PropertyListItem::Num(n) => PropertyValue::Num(*n),
    }
}

fn item_text(item: &PropertyListItem) -> String {
    item_value(item).as_legacy_string().unwrap_or_default()
}

/// A definition's options, parsed.
fn parse_options(options: Option<&str>) -> Result<Option<Vec<String>>, AppError> {
    Ok(options.map(serde_json::from_str).transpose()?)
}

/// `space_id`'s definition of `target.key` and the one the change leaves,
/// refused in this order: a built-in key, one of the app's own, a malformed
/// target, an undeclared key, and a change that changes neither the type nor
/// whether the key holds a list (a select's options change through
/// `update_property_def_options`).
async fn type_change_defs(
    conn: &mut SqliteConnection,
    space_id: &str,
    target: &PropertyTypeTarget,
) -> Result<(PropertyDefState, PropertyDefState), AppError> {
    let key = target.key.as_str();
    refuse_builtin_definition_write(key)?;
    refuse_internal_key(key)?;
    validate_property_def_shape(key, &target.value_type, target.options.as_deref())?;
    let from = declared_def(conn, space_id, key).await?;
    let multiple = target.multiple.unwrap_or(from.multiple);
    if from.value_type == target.value_type && from.multiple == multiple {
        return Err(AppError::validation(format!(
            "'{key}' is already a {} property",
            from.value_type
        )));
    }
    let to = PropertyDefState {
        value_type: target.value_type.clone(),
        options: target.options.clone(),
        multiple,
    };
    validate_property_def_state(key, &to)?;
    Ok((from, to))
}

/// The values `space_id`'s blocks hold under `key`, the Trash's included, by
/// block id from after `after`, each with what it becomes under `to`, split
/// or joined at `separator`: those `keep` takes, up to the first `wanted` of
/// them.
async fn conversions(
    conn: &mut SqliteConnection,
    space_id: &str,
    key: &str,
    (to, separator): (&PropertyDefState, Option<ListSeparator>),
    after: Option<&str>,
    keep: impl Fn(&Conversion) -> bool,
    wanted: usize,
) -> Result<Vec<Conversion>, AppError> {
    let rule = ConversionRule {
        to,
        options: parse_options(to.options.as_deref())?,
        separator,
    };
    let mut rows = sqlx::query!(
        r#"SELECT bp.block_id AS "block_id!: String", bp.value_text, bp.value_num,
                  bp.value_date, bp.value_ref, bp.value_bool,
                  bp.value_list AS "value_list: PropertyList"
           FROM block_properties bp JOIN blocks b ON b.id = bp.block_id
           WHERE bp.key = ?2 AND (+b.space_id = ?1 OR +b.id = ?1)
             AND (?3 IS NULL OR bp.block_id > ?3)
           ORDER BY bp.block_id"#,
        space_id,
        key,
        after,
    )
    .fetch(conn);
    let mut kept = Vec::new();
    while kept.len() < wanted
        && let Some(row) = rows.try_next().await?
    {
        let value = PropertyValue::from(&PropertyValueFields {
            value_text: row.value_text,
            value_num: row.value_num,
            value_date: row.value_date,
            value_ref: row.value_ref.map(BlockId::from),
            value_bool: row.value_bool.map(|b| b != 0),
            value_list: row.value_list,
        });
        let converted = rule.convert(&value);
        let conversion = (row.block_id, value, converted);
        if keep(&conversion) {
            kept.push(conversion);
        }
    }
    Ok(kept)
}

fn counts_of(conversions: &[Conversion]) -> PropertyTypeChangeCounts {
    let converted = conversions.iter().filter(|(.., w)| w.is_some()).count();
    let count = |n: usize| i64::try_from(n).unwrap_or(i64::MAX);
    PropertyTypeChangeCounts {
        converted: count(converted),
        unfit: count(conversions.len() - converted),
    }
}

/// What changing `space_id`'s property to `target`'s type would convert and
/// leave unfit (#5841), which [`change_property_type_inner`] takes as its
/// acknowledgement. Refused as the change is.
#[instrument(skip(pool), err)]
pub async fn preview_property_type_change_inner(
    pool: &SqlitePool,
    space_id: &str,
    target: PropertyTypeTarget,
) -> Result<PropertyTypeChangeCounts, AppError> {
    let mut conn = pool.acquire().await?;
    let (_, to) = type_change_defs(&mut conn, space_id, &target).await?;
    Ok(counts_of(
        &conversions(
            &mut conn,
            space_id,
            &target.key,
            (&to, target.separator),
            None,
            |_| true,
            usize::MAX,
        )
        .await?,
    ))
}

/// `listed` with each block's page and content; a block gone since it was
/// listed is left out.
async fn with_holders(
    conn: &mut SqliteConnection,
    listed: Vec<Conversion>,
) -> Result<Vec<PropertyTypeChangeValue>, AppError> {
    let ids = serde_json::to_string(&listed.iter().map(|(id, ..)| id).collect::<Vec<_>>())?;
    let mut holders: HashMap<String, _> = sqlx::query!(
        r#"SELECT b.id AS "block_id!: String", b.page_id, pg.content AS page_title, b.content,
                  b.deleted_at IS NOT NULL AS "deleted!: bool"
           FROM blocks b LEFT JOIN blocks pg ON pg.id = b.page_id
           WHERE b.id IN (SELECT value FROM json_each(?1))"#,
        ids,
    )
    .fetch_all(conn)
    .await?
    .into_iter()
    .map(|row| (row.block_id.clone(), row))
    .collect();
    Ok(listed
        .into_iter()
        .filter_map(|(block_id, value, converted)| {
            let holder = holders.remove(&block_id)?;
            Some(PropertyTypeChangeValue {
                block_id,
                page_id: holder.page_id,
                page_title: holder.page_title,
                content: holder.content,
                deleted: holder.deleted,
                value: shown_value(&value),
                converted: converted.as_ref().map(shown_value),
            })
        })
        .collect())
}

/// The values of `kind` changing `space_id`'s property to `target`'s type
/// would convert or leave unfit, with the block and page holding each,
/// cursor-paginated by block id.
///
/// # Errors
///
/// - [`AppError::Validation`] — a `limit` outside `PageRequest::new`'s range,
///   a malformed cursor, or a change refused as [`change_property_type_inner`]
///   refuses it.
/// - [`AppError::NotFound`] — the space does not declare the key.
#[instrument(skip(pool, cursor), err)]
pub async fn list_property_type_change_values_inner(
    pool: &SqlitePool,
    space_id: &str,
    target: PropertyTypeTarget,
    kind: PropertyTypeChangeKind,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<PropertyTypeChangeValue>, AppError> {
    let page = PageRequest::new(cursor, limit)?;
    let mut conn = pool.acquire().await?;
    let (_, to) = type_change_defs(&mut conn, space_id, &target).await?;
    let after = page.after.as_ref().map(|c| c.id.as_str());
    let converted = kind == PropertyTypeChangeKind::Converted;
    let of_kind = |(.., w): &Conversion| w.is_some() == converted;
    let wanted = usize::try_from(page.limit + 1).unwrap_or(usize::MAX);
    let listed = conversions(
        &mut conn,
        space_id,
        &target.key,
        (&to, target.separator),
        after,
        of_kind,
        wanted,
    )
    .await?;
    let rows = with_holders(&mut conn, listed).await?;
    build_page_response(rows, page.limit, |last| {
        Cursor::for_id(last.block_id.clone())
    })
}

/// The value writes of a type change: one per held value the change converts
/// to another engine form, recording the value it replaces. A value whose
/// form stays, or that does not fit the new type, is not written; the apply
/// moves it to the column the new type gives it (#6206).
fn type_change_writes(key: &str, conversions: Vec<Conversion>) -> Vec<PropertyValueWrite> {
    conversions
        .into_iter()
        .filter_map(|(block_id, value, converted)| {
            let converted = converted.filter(|c| *c != value)?;
            Some(PropertyValueWrite {
                block_id: BlockId::from_trusted(&block_id),
                key: key.to_owned(),
                value: value_fields(&converted),
                prior: value_fields(&value),
            })
        })
        .collect()
}

/// Change `space_id`'s property `target.key` to `target.value_type` (#5841),
/// in one `RewriteProperties` op: the definition, and every value the
/// space's blocks hold under the key, the Trash's included, converted to the
/// new type, or, when it does not take it, kept as it is (#6206). A select
/// takes only values among its options. With `target.multiple` the key starts
/// or stops holding a list (#6741). Returns the definition after the change.
///
/// `acknowledged` is what [`preview_property_type_change_inner`] answered;
/// the change counts again in its transaction and refuses when the answer
/// changed.
///
/// # Errors
///
/// - [`AppError::Validation`] coded [`ValidationCode::BuiltinPropertyLocked`]
///   when the key is built in.
/// - [`AppError::Validation`] when the key is the app's own, the target type
///   or its options are malformed, a boolean would hold a list, or the change
///   changes neither the type nor whether the key holds a list.
/// - [`AppError::NotFound`] when the space does not declare the key.
/// - [`AppError::Validation`] coded [`ValidationCode::UnacknowledgedPropertyLoss`]
///   when the counts differ from `acknowledged`.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn change_property_type_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    target: PropertyTypeTarget,
    acknowledged: PropertyTypeChangeCounts,
) -> Result<PropertyDefinition, AppError> {
    let mut tx = CommandTx::begin_immediate(pool, "change_property_type").await?;
    tx.arm_engine_rollback(materializer.loro_state());
    let key = target.key.as_str();
    let (from, to) = type_change_defs(&mut tx, space_id, &target).await?;
    let rule = (&to, target.separator);
    let held = conversions(&mut tx, space_id, key, rule, None, |_| true, usize::MAX).await?;
    let counts = counts_of(&held);
    if counts != acknowledged {
        return Err(AppError::validation_coded(
            ValidationCode::UnacknowledgedPropertyLoss,
            format!(
                "changing '{key}' to {} now converts {} value(s) and leaves {} that do not fit; \
                 preview it again",
                to.value_type, counts.converted, counts.unfit
            ),
        ));
    }
    let payload = OpPayload::RewriteProperties(RewritePropertiesPayload {
        space_id: BlockId::from_trusted(space_id),
        reason: RewriteReason::ChangeType,
        defs: vec![PropertyDefWrite {
            key: key.to_owned(),
            def: Some(to),
            prior: Some(from),
        }],
        values: type_change_writes(key, held),
    });
    append_and_apply(&mut tx, materializer.loro_state(), device_id, payload).await?;
    let changed = user_property_def(&mut tx, space_id, key)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("property definition '{key}'")))?;
    tx.commit_and_dispatch(materializer).await?;
    Ok(changed)
}

/// Tauri command: what changing a space's property to another type would
/// convert and leave unfit. Delegates to [`preview_property_type_change_inner`].
#[tauri::command]
#[specta::specta]
pub async fn preview_property_type_change(
    read_pool: State<'_, ReadPool>,
    space_id: SpaceId,
    key: String,
    value_type: String,
    options: Option<String>,
    multiple: Option<bool>,
    separator: Option<ListSeparator>,
) -> Result<PropertyTypeChangeCounts, AppError> {
    space_id.validate_shape()?;
    let target = PropertyTypeTarget {
        key,
        value_type,
        options,
        multiple,
        separator,
    };
    preview_property_type_change_inner(&read_pool.0, space_id.as_str(), target)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: one page of the values a type change would convert or
/// leave unfit. Delegates to [`list_property_type_change_values_inner`].
#[tauri::command]
#[specta::specta]
#[expect(
    clippy::too_many_arguments,
    reason = "the IPC's arguments are positional; its inner takes them as one target"
)]
pub async fn list_property_type_change_values(
    read_pool: State<'_, ReadPool>,
    space_id: SpaceId,
    key: String,
    value_type: String,
    options: Option<String>,
    multiple: Option<bool>,
    separator: Option<ListSeparator>,
    kind: PropertyTypeChangeKind,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<PropertyTypeChangeValue>, AppError> {
    space_id.validate_shape()?;
    let target = PropertyTypeTarget {
        key,
        value_type,
        options,
        multiple,
        separator,
    };
    list_property_type_change_values_inner(
        &read_pool.0,
        space_id.as_str(),
        target,
        kind,
        cursor,
        limit,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: change a space's property to another type. Delegates to
/// [`change_property_type_inner`]; the response carries the op ref.
#[tauri::command]
#[specta::specta]
#[expect(
    clippy::too_many_arguments,
    reason = "the IPC's arguments are positional; its inner takes them as one target"
)]
pub async fn change_property_type(
    ctx: State<'_, WriteCtx>,
    space_id: SpaceId,
    key: String,
    value_type: String,
    options: Option<String>,
    multiple: Option<bool>,
    separator: Option<ListSeparator>,
    acknowledged: PropertyTypeChangeCounts,
) -> Result<WithOps<PropertyDefinition>, AppError> {
    space_id.validate_shape()?;
    let target = PropertyTypeTarget {
        key,
        value_type,
        options,
        multiple,
        separator,
    };
    capture_op_refs(change_property_type_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        space_id.as_str(),
        target,
        acknowledged,
    ))
    .await
    .map_err(sanitize_internal_error)
}
