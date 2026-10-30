//! Rename a select property's option (#5841): one `RenamePropertyOption` op,
//! in the space whose definition it is, renaming the option in place and every
//! value of the space's blocks holding it, the Trash's included.

use sqlx::{SqliteConnection, SqlitePool};
use tauri::State;
use tracing::instrument;

use crate::db::{CommandTx, WriteCtx};
use crate::materializer::Materializer;
use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::op::{OpPayload, RenamePropertyOptionPayload};
use agaric_store::space::SpaceId;

use super::properties::{append_and_apply, refuse_builtin_definition_write, user_property_def};
use super::property_keys::{declared_def, refuse_internal_key};
use super::{PropertyDefinition, WithOps, capture_op_refs, sanitize_internal_error};

/// Refuse renaming `old_option` of `space_id`'s select `key` to `new_option`,
/// or the undo of such a rename (#5841): the key must be a declared select
/// listing `old_option`, and `new_option` neither listed nor held by any block
/// of the space, the Trash's included. A name already taken would merge two
/// options, which a rename back could not split again.
pub(crate) async fn refuse_unrenamable_option(
    conn: &mut SqliteConnection,
    space_id: &str,
    key: &str,
    old_option: &str,
    new_option: &str,
) -> Result<(), AppError> {
    let def = declared_def(conn, space_id, key).await?;
    if def.value_type != "select" {
        return Err(AppError::validation(format!(
            "'{key}' is a {} property; only a select has options",
            def.value_type
        )));
    }
    let options: Vec<String> = def
        .options
        .as_deref()
        .and_then(|o| serde_json::from_str(o).ok())
        .ok_or_else(|| AppError::validation("options must be a JSON array of strings".into()))?;
    if !options.iter().any(|o| o == old_option) {
        return Err(AppError::validation(format!(
            "'{old_option}' is not an option of '{key}'"
        )));
    }
    if options.iter().any(|o| o == new_option) {
        return Err(AppError::validation(format!(
            "'{new_option}' is already an option of '{key}'"
        )));
    }
    let held: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "n!: i64" FROM block_properties bp
           JOIN blocks b ON b.id = bp.block_id
           WHERE bp.key = ?1 AND bp.value_text = ?2 AND (b.space_id = ?3 OR b.id = ?3)"#,
        key,
        new_option,
        space_id,
    )
    .fetch_one(&mut *conn)
    .await?;
    if held > 0 {
        return Err(AppError::validation(format!(
            "'{new_option}' is already held by {held} block(s) of this space, the Trash \
             included"
        )));
    }
    Ok(())
}

/// Rename `old_option` of `space_id`'s select `key` to `new_option` (#5841):
/// the option in place, keeping the options' order, and every value of the
/// space's blocks equal to it, the Trash's included, in one
/// `RenamePropertyOption` op. Returns the definition after.
///
/// # Errors
///
/// - [`AppError::Validation`] coded
///   [`agaric_core::error::ValidationCode::BuiltinPropertyLocked`] when `key`
///   is built in.
/// - [`AppError::Validation`] when `key` is the app's own, `new_option` is
///   blank or equals `old_option`, or `refuse_unrenamable_option` refuses.
/// - [`AppError::NotFound`] when the space does not declare `key`.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn rename_property_option_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    key: String,
    old_option: String,
    new_option: String,
) -> Result<PropertyDefinition, AppError> {
    refuse_builtin_definition_write(&key)?;
    refuse_internal_key(&key)?;
    if new_option.trim().is_empty() {
        return Err(AppError::validation("an option cannot be empty".into()));
    }
    if old_option == new_option {
        return Err(AppError::validation(format!(
            "'{old_option}' cannot be renamed to itself"
        )));
    }
    let mut tx = CommandTx::begin_immediate(pool, "rename_property_option").await?;
    tx.arm_engine_rollback(materializer.loro_state());
    refuse_unrenamable_option(&mut tx, space_id, &key, &old_option, &new_option).await?;
    let payload = OpPayload::RenamePropertyOption(RenamePropertyOptionPayload {
        space_id: BlockId::from_trusted(space_id),
        key: key.clone(),
        old_option,
        new_option,
    });
    append_and_apply(&mut tx, materializer.loro_state(), device_id, payload).await?;
    let renamed = user_property_def(&mut tx, space_id, &key)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("property definition '{key}'")))?;
    tx.commit_and_dispatch(materializer).await?;
    Ok(renamed)
}

/// Tauri command: rename an option of a space's select property. Delegates to
/// [`rename_property_option_inner`]; the response carries the op ref.
#[tauri::command]
#[specta::specta]
pub async fn rename_property_option(
    ctx: State<'_, WriteCtx>,
    space_id: SpaceId,
    key: String,
    old_option: String,
    new_option: String,
) -> Result<WithOps<PropertyDefinition>, AppError> {
    space_id.validate_shape()?;
    capture_op_refs(rename_property_option_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        space_id.as_str(),
        key,
        old_option,
        new_option,
    ))
    .await
    .map_err(sanitize_internal_error)
}
