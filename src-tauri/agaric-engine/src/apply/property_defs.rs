//! `SetPropertyDef` apply (#5841): the space's doc, then its
//! `property_definitions` row, then the key's values when the definition moves
//! them to another column.

use super::*;

/// Apply `SetPropertyDef` through `p.space_id`'s engine, then project it to
/// SQL. When the definition moves the key's `Str` values to another column
/// (`str_column_for`), every value of the space under the key is re-typed from
/// the engine in the caller's transaction.
pub async fn apply_set_property_def_via_loro(
    conn: &mut sqlx::SqliteConnection,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    p: &SetPropertyDefPayload,
) -> Result<(), AppError> {
    use crate::loro::projection::{
        project_property_def_to_sql, reproject_key_values, str_column_for,
    };
    let space_id = p.space_id.as_str();
    let declared = sqlx::query_scalar!(
        "SELECT value_type FROM property_definitions WHERE space_id = ? AND key = ?",
        space_id,
        p.key,
    )
    .fetch_optional(&mut *conn)
    .await?;
    let value_type = p.def.as_ref().map(|def| def.value_type.as_str());
    let retyped = str_column_for(declared.as_deref()) != str_column_for(value_type);
    let holders = {
        let mut guard = state.registry.for_space_recording(
            &agaric_store::space::SpaceId::from_trusted(space_id),
            device_id,
            &state.revert,
        )?;
        let engine = guard.engine_mut();
        engine.apply_set_property_def(&p.key, p.def.as_ref())?;
        if retyped {
            engine.read_property_holders(&p.key)?
        } else {
            Vec::new()
        }
    };
    project_property_def_to_sql(conn, space_id, &p.key, p.def.as_ref()).await?;
    reproject_key_values(conn, space_id, &p.key, value_type, &holders).await?;
    Ok(())
}
