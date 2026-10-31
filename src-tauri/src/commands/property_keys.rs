//! Rename a property key, and merge one key into another (#5841): one
//! `RenamePropertyKey` or `RewriteProperties` op each, in the space whose
//! definitions they are.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use tauri::State;
use tracing::instrument;

use crate::db::{CommandTx, ReadPool, WriteCtx};
use crate::materializer::Materializer;
use agaric_core::error::{AppError, ValidationCode};
use agaric_core::ulid::BlockId;
use agaric_engine::loro::engine::PropertyValue;
use agaric_engine::loro::shared::LoroState;
use agaric_store::op::{
    OpPayload, PropertyDefState, PropertyDefWrite, PropertyValueFields, PropertyValueWrite,
    RenamePropertyKeyPayload, RewritePropertiesPayload, RewriteReason, is_internal_property_key,
};
use agaric_store::space::SpaceId;

use super::properties::{
    append_and_apply, refuse_builtin_definition_write, user_property_def,
    validate_property_def_shape,
};
use super::{PropertyDefinition, WithOps, capture_op_refs, sanitize_internal_error};

/// What merging one key into another does to a space's blocks, the Trash's
/// included (#5841): `moved` blocks hold the merged key and not the target, so
/// their value moves; `dropped` blocks hold both, so they keep the target and
/// lose the merged key's value, which an undo brings back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct PropertyMergeCounts {
    pub moved: i64,
    pub dropped: i64,
}

/// Refuse a rename, merge or type change of `key`, one the app writes for
/// itself (`INTERNAL_PROPERTY_KEYS`): moving or converting the template
/// markers' values, say, would break templates.
pub(crate) fn refuse_internal_key(key: &str) -> Result<(), AppError> {
    if is_internal_property_key(key) {
        return Err(AppError::validation(format!(
            "property '{key}' is the app's own and cannot be changed"
        )));
    }
    Ok(())
}

/// Refuse `key` as the key a rename, or its undo, moves a space's values to
/// (#5841): it must be a well-formed key of the user's, and one `space_id`
/// neither declares nor holds a value under on any block, the Trash's
/// included.
pub(crate) async fn refuse_taken_key(
    conn: &mut SqliteConnection,
    space_id: &str,
    key: &str,
) -> Result<(), AppError> {
    validate_property_def_shape(key, "text", None)?;
    refuse_internal_key(key)?;
    if user_property_def(conn, space_id, key).await?.is_some() {
        return Err(AppError::validation(format!(
            "'{key}' is already a property of this space"
        )));
    }
    let used: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "n!: i64" FROM block_properties bp
           JOIN blocks b ON b.id = bp.block_id
           WHERE bp.key = ?1 AND (b.space_id = ?2 OR b.id = ?2)"#,
        key,
        space_id,
    )
    .fetch_one(&mut *conn)
    .await?;
    if used > 0 {
        return Err(AppError::validation(format!(
            "'{key}' is already used by {used} block(s) of this space, the Trash included"
        )));
    }
    Ok(())
}

/// `space_id`'s definition of `key`, or `NotFound`.
pub(crate) async fn declared_def(
    conn: &mut SqliteConnection,
    space_id: &str,
    key: &str,
) -> Result<PropertyDefState, AppError> {
    user_property_def(conn, space_id, key)
        .await?
        .map(|row| PropertyDefState {
            value_type: row.value_type,
            options: row.options,
        })
        .ok_or_else(|| AppError::NotFound(format!("property definition '{key}'")))
}

/// Rename `space_id`'s property `old_key` to `new_key` (#5841): the
/// definition and every value of the space's blocks under it, the Trash's
/// included, move in one `RenamePropertyKey` op. Returns the definition under
/// its new key.
///
/// # Errors
///
/// - [`AppError::Validation`] coded [`ValidationCode::BuiltinPropertyLocked`]
///   when either key is built in.
/// - [`AppError::Validation`] when the keys are equal, either is the app's
///   own, `new_key` is malformed, or the space declares or uses `new_key`.
/// - [`AppError::NotFound`] when the space does not declare `old_key`.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn rename_property_key_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    old_key: String,
    new_key: String,
) -> Result<PropertyDefinition, AppError> {
    if old_key == new_key {
        return Err(AppError::validation(format!(
            "'{old_key}' cannot be renamed to itself"
        )));
    }
    refuse_builtin_definition_write(&old_key)?;
    refuse_internal_key(&old_key)?;
    let mut tx = CommandTx::begin_immediate(pool, "rename_property_key").await?;
    tx.arm_engine_rollback(materializer.loro_state());
    declared_def(&mut tx, space_id, &old_key).await?;
    refuse_taken_key(&mut tx, space_id, &new_key).await?;
    let payload = OpPayload::RenamePropertyKey(RenamePropertyKeyPayload {
        space_id: BlockId::from_trusted(space_id),
        old_key,
        new_key: new_key.clone(),
    });
    append_and_apply(&mut tx, materializer.loro_state(), device_id, payload).await?;
    let renamed = user_property_def(&mut tx, space_id, &new_key)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("property definition '{new_key}'")))?;
    tx.commit_and_dispatch(materializer).await?;
    Ok(renamed)
}

/// The definitions of `from_key` and `into_key`, which `space_id` must both
/// declare, as user keys of one type (#5841).
async fn mergeable_defs(
    conn: &mut SqliteConnection,
    space_id: &str,
    from_key: &str,
    into_key: &str,
) -> Result<(PropertyDefState, PropertyDefState), AppError> {
    if from_key == into_key {
        return Err(AppError::validation(format!(
            "'{from_key}' cannot be merged into itself"
        )));
    }
    refuse_builtin_definition_write(from_key)?;
    refuse_builtin_definition_write(into_key)?;
    refuse_internal_key(from_key)?;
    refuse_internal_key(into_key)?;
    let from = declared_def(conn, space_id, from_key).await?;
    let into = declared_def(conn, space_id, into_key).await?;
    if from.value_type != into.value_type {
        return Err(AppError::validation(format!(
            "'{from_key}' is a {} property and '{into_key}' a {} one: change one type first",
            from.value_type, into.value_type
        )));
    }
    Ok((from, into))
}

/// [`PropertyMergeCounts`] of merging `from_key` into `into_key` in
/// `space_id`, from the rows the user sees. Trashed blocks count: the merge
/// rewrites their values too.
async fn property_merge_counts(
    conn: &mut SqliteConnection,
    space_id: &str,
    from_key: &str,
    into_key: &str,
) -> Result<PropertyMergeCounts, AppError> {
    let row = sqlx::query!(
        r#"SELECT COUNT(*) AS "held!: i64", COUNT(i.block_id) AS "dropped!: i64"
           FROM block_properties f
           JOIN blocks b ON b.id = f.block_id
           LEFT JOIN block_properties i ON i.block_id = f.block_id AND i.key = ?3
           WHERE f.key = ?2 AND (b.space_id = ?1 OR b.id = ?1)"#,
        space_id,
        from_key,
        into_key,
    )
    .fetch_one(conn)
    .await?;
    Ok(PropertyMergeCounts {
        moved: row.held - row.dropped,
        dropped: row.dropped,
    })
}

/// The blocks of `space_id`, the Trash's included, holding a value of `key`
/// SQL shows: the target values [`property_merge_counts`] counts, and the
/// blocks a move of values that don't fit leaves alone.
pub(super) async fn visible_holders(
    conn: &mut SqliteConnection,
    space_id: &str,
    key: &str,
) -> Result<HashSet<String>, AppError> {
    let ids = sqlx::query_scalar!(
        r#"SELECT bp.block_id AS "block_id!: String" FROM block_properties bp
           JOIN blocks b ON b.id = bp.block_id
           WHERE bp.key = ?1 AND (b.space_id = ?2 OR b.id = ?2)"#,
        key,
        space_id,
    )
    .fetch_all(conn)
    .await?;
    Ok(ids.into_iter().collect())
}

/// What merging `from_key` into `into_key` would move and drop in `space_id`
/// (#5841), which [`merge_property_key_inner`] takes as its acknowledgement.
/// Refused as the merge is.
#[instrument(skip(pool), err)]
pub async fn preview_property_merge_inner(
    pool: &SqlitePool,
    space_id: &str,
    from_key: String,
    into_key: String,
) -> Result<PropertyMergeCounts, AppError> {
    let mut conn = pool.acquire().await?;
    mergeable_defs(&mut conn, space_id, &from_key, &into_key).await?;
    property_merge_counts(&mut conn, space_id, &from_key, &into_key).await
}

/// `value` in the slot the engine's own kind of it projects from: a string is
/// text, whatever the definition later types it as.
pub(crate) fn value_fields(value: &PropertyValue) -> Option<PropertyValueFields> {
    let mut fields = PropertyValueFields::default();
    match value {
        PropertyValue::Str(s) => fields.value_text = Some(s.clone()),
        PropertyValue::Num(n) => fields.value_num = Some(*n),
        PropertyValue::Bool(b) => fields.value_bool = Some(*b),
        PropertyValue::Null => return None,
    }
    Some(fields)
}

/// The value writes of merging `from_key` into `into_key`, read from the
/// space's doc (a ref whose block is gone, which SQL cannot show, moves too),
/// in block order. Every `from_key` value is removed; one whose block is not
/// in `into_shown` (the blocks whose `into_key` value SQL shows, as the
/// preview counts them) is written there as well, over any value only the doc
/// holds, which the write records so an undo puts it back.
fn merge_value_writes(
    state: &LoroState,
    device_id: &str,
    space_id: &str,
    (from_key, into_key): (&str, &str),
    into_shown: &HashSet<String>,
) -> Result<Vec<PropertyValueWrite>, AppError> {
    let (mut from, into) = {
        let mut guard = state
            .registry
            .for_space(&SpaceId::from_trusted(space_id), device_id)?;
        let engine = guard.engine_mut();
        (
            engine.read_property_holders(from_key)?,
            engine.read_property_holders(into_key)?,
        )
    };
    let mut into_hidden: HashMap<String, PropertyValueFields> = into
        .into_iter()
        .filter_map(|(block_id, value)| Some((block_id, value_fields(&value)?)))
        .collect();
    from.sort_by(|a, b| a.0.cmp(&b.0));
    let mut writes = Vec::with_capacity(from.len() * 2);
    for (block_id, value) in from {
        let moves = !into_shown.contains(&block_id);
        let prior = into_hidden.remove(&block_id);
        let block_id = BlockId::from_trusted(&block_id);
        let value = value_fields(&value);
        writes.push(PropertyValueWrite {
            block_id: block_id.clone(),
            key: from_key.to_owned(),
            value: None,
            prior: value.clone(),
        });
        if moves && value.is_some() {
            writes.push(PropertyValueWrite {
                block_id,
                key: into_key.to_owned(),
                value,
                prior,
            });
        }
    }
    Ok(writes)
}

/// `into`'s options followed by those of `from` it lacks; `into` as it is
/// stored when it lacks none.
fn union_options(into: Option<&str>, from: Option<&str>) -> Result<Option<String>, AppError> {
    let (Some(into), Some(from)) = (into, from) else {
        return Ok(into.map(str::to_owned));
    };
    let mut options: Vec<String> = serde_json::from_str(into)?;
    let held = options.len();
    for option in serde_json::from_str::<Vec<String>>(from)? {
        if !options.contains(&option) {
            options.push(option);
        }
    }
    if options.len() == held {
        return Ok(Some(into.to_owned()));
    }
    Ok(Some(serde_json::to_string(&options)?))
}

/// The definition writes of a merge, `from_key`'s then `into_key`'s: the
/// first is deleted, the second keeps its type and gains the first's options.
fn merge_def_writes(
    from_key: &str,
    from: PropertyDefState,
    into_key: &str,
    into: PropertyDefState,
) -> Result<Vec<PropertyDefWrite>, AppError> {
    let merged = PropertyDefState {
        value_type: into.value_type.clone(),
        options: union_options(into.options.as_deref(), from.options.as_deref())?,
    };
    Ok(vec![
        PropertyDefWrite {
            key: from_key.to_owned(),
            def: None,
            prior: Some(from),
        },
        PropertyDefWrite {
            key: into_key.to_owned(),
            def: Some(merged),
            prior: Some(into),
        },
    ])
}

/// Merge `space_id`'s property `from_key` into `into_key`, of the same type
/// (#5841), in one `RewriteProperties` op: every value under `from_key` moves
/// to `into_key`, except on a block already holding `into_key`, which keeps it
/// (the `from_key` value is recorded, so an undo brings it back); `from_key`'s
/// definition is deleted, and a select's options are unioned. Returns
/// `into_key`'s definition.
///
/// `acknowledged` is what [`preview_property_merge_inner`] answered; the merge
/// counts again in its transaction and refuses when the answer changed.
///
/// # Errors
///
/// - [`AppError::Validation`] coded [`ValidationCode::UnacknowledgedPropertyLoss`]
///   when the counts differ from `acknowledged`.
/// - [`AppError::Validation`] coded [`ValidationCode::BuiltinPropertyLocked`]
///   when either key is built in.
/// - [`AppError::Validation`] when the keys are equal, either is the app's own
///   or their types differ.
/// - [`AppError::NotFound`] when the space does not declare either key.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn merge_property_key_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    from_key: String,
    into_key: String,
    acknowledged: PropertyMergeCounts,
) -> Result<PropertyDefinition, AppError> {
    let mut tx = CommandTx::begin_immediate(pool, "merge_property_key").await?;
    tx.arm_engine_rollback(materializer.loro_state());
    let (from, into) = mergeable_defs(&mut tx, space_id, &from_key, &into_key).await?;
    let counts = property_merge_counts(&mut tx, space_id, &from_key, &into_key).await?;
    if counts != acknowledged {
        return Err(AppError::validation_coded(
            ValidationCode::UnacknowledgedPropertyLoss,
            format!(
                "merging '{from_key}' into '{into_key}' now moves {} and drops {} value(s); \
                 preview it again",
                counts.moved, counts.dropped
            ),
        ));
    }
    let into_shown = visible_holders(&mut tx, space_id, &into_key).await?;
    let state = materializer.loro_state();
    let keys = (from_key.as_str(), into_key.as_str());
    let payload = OpPayload::RewriteProperties(RewritePropertiesPayload {
        space_id: BlockId::from_trusted(space_id),
        reason: RewriteReason::Merge,
        values: merge_value_writes(state, device_id, space_id, keys, &into_shown)?,
        defs: merge_def_writes(&from_key, from, &into_key, into)?,
    });
    append_and_apply(&mut tx, state, device_id, payload).await?;
    let merged = user_property_def(&mut tx, space_id, &into_key)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("property definition '{into_key}'")))?;
    tx.commit_and_dispatch(materializer).await?;
    Ok(merged)
}

/// Tauri command: rename a space's property key. Delegates to
/// [`rename_property_key_inner`]; the response carries the op ref.
#[tauri::command]
#[specta::specta]
pub async fn rename_property_key(
    ctx: State<'_, WriteCtx>,
    space_id: SpaceId,
    old_key: String,
    new_key: String,
) -> Result<WithOps<PropertyDefinition>, AppError> {
    space_id.validate_shape()?;
    capture_op_refs(rename_property_key_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        space_id.as_str(),
        old_key,
        new_key,
    ))
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: what merging one of a space's property keys into another
/// would move and drop. Delegates to [`preview_property_merge_inner`].
#[tauri::command]
#[specta::specta]
pub async fn preview_property_merge(
    read_pool: State<'_, ReadPool>,
    space_id: SpaceId,
    from_key: String,
    into_key: String,
) -> Result<PropertyMergeCounts, AppError> {
    space_id.validate_shape()?;
    preview_property_merge_inner(&read_pool.0, space_id.as_str(), from_key, into_key)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: merge one of a space's property keys into another.
/// Delegates to [`merge_property_key_inner`]; the response carries the op ref.
#[tauri::command]
#[specta::specta]
pub async fn merge_property_key(
    ctx: State<'_, WriteCtx>,
    space_id: SpaceId,
    from_key: String,
    into_key: String,
    acknowledged: PropertyMergeCounts,
) -> Result<WithOps<PropertyDefinition>, AppError> {
    space_id.validate_shape()?;
    capture_op_refs(merge_property_key_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        space_id.as_str(),
        from_key,
        into_key,
        acknowledged,
    ))
    .await
    .map_err(sanitize_internal_error)
}
