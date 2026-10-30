//! The definition ops' apply (#5841): the space's doc, then its
//! `property_definitions` rows, then the values they move. `SetPropertyDef`
//! re-types a key's values when the definition moves them to another column;
//! `RenamePropertyKey` and `RewriteProperties` move values between keys, and
//! `RewriteProperties` changes a key's type.

use super::*;
use agaric_store::op::PropertyDefWrite;

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

/// Apply `RenamePropertyKey` through `p.space_id`'s engine, then project it to
/// SQL. No value changes type: the definition moves with them.
pub async fn apply_rename_property_key_via_loro(
    conn: &mut sqlx::SqliteConnection,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    p: &RenamePropertyKeyPayload,
) -> Result<(), AppError> {
    let space_id = p.space_id.as_str();
    {
        let mut guard = state.registry.for_space_recording(
            &agaric_store::space::SpaceId::from_trusted(space_id),
            device_id,
            &state.revert,
        )?;
        guard
            .engine_mut()
            .apply_rename_property_key(&p.old_key, &p.new_key)?;
    }
    crate::loro::projection::project_rename_property_key_to_sql(
        conn, space_id, &p.old_key, &p.new_key,
    )
    .await
}

/// The type `write` leaves its key with; `None` when it deletes the definition.
fn new_type(write: &PropertyDefWrite) -> Option<&str> {
    write.def.as_ref().map(|def| def.value_type.as_str())
}

/// Apply `RewriteProperties` through `p.space_id`'s engine, then project it
/// to SQL: the definitions first, so the values are typed by them. A
/// definition that moves its key's `Str` values to another column
/// (`str_column_for`) re-types every value of the space under the key from the
/// engine afterwards, as `SetPropertyDef` does: a type change writes only the
/// values whose engine form it changes (#5841).
pub async fn apply_rewrite_properties_via_loro(
    conn: &mut sqlx::SqliteConnection,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    p: &RewritePropertiesPayload,
) -> Result<(), AppError> {
    use crate::loro::projection::{
        project_property_def_to_sql, project_property_value_writes, reproject_key_values,
        str_column_for,
    };
    let space_id = p.space_id.as_str();
    let declared = crate::block_ops::load_value_types(conn, space_id).await?;
    let retyped: Vec<&PropertyDefWrite> = p
        .defs
        .iter()
        .filter(|w| {
            str_column_for(declared.get(&w.key).map(String::as_str)) != str_column_for(new_type(w))
        })
        .collect();
    let holders = {
        let mut guard = state.registry.for_space_recording(
            &agaric_store::space::SpaceId::from_trusted(space_id),
            device_id,
            &state.revert,
        )?;
        let engine = guard.engine_mut();
        engine.apply_rewrite_properties(p)?;
        retyped
            .iter()
            .map(|w| engine.read_property_holders(&w.key))
            .collect::<Result<Vec<_>, _>>()?
    };
    for write in &p.defs {
        project_property_def_to_sql(conn, space_id, &write.key, write.def.as_ref()).await?;
    }
    let value_types = crate::block_ops::load_value_types(conn, space_id).await?;
    project_property_value_writes(conn, space_id, &p.values, &value_types).await?;
    for (write, holders) in retyped.iter().zip(&holders) {
        reproject_key_values(conn, space_id, &write.key, new_type(write), holders).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loro::shared::LoroState;
    use agaric_core::ulid::BlockId;
    use agaric_store::op::{PropertyDefState, RewriteReason};
    use agaric_store::space::SpaceId;

    const SPACE: &str = "01HZ0000000000000000000SP1";
    const BLOCK: &str = "01HZ0000000000000000000BX1";
    const DEV: &str = "dev-property-defs";

    fn def(value_type: &str) -> PropertyDefState {
        PropertyDefState {
            value_type: value_type.into(),
            options: None,
        }
    }

    /// #5841 S3 — a type change writes only the values whose engine form it
    /// changes, so the apply moves the rest to the new type's column itself: a
    /// date held as text lands in `value_date` with no write of its own.
    #[tokio::test]
    async fn a_type_change_moves_values_it_does_not_write_to_the_new_column_5841() {
        let (pool, _dir) = agaric_store::test_support::test_pool().await;
        for sql in [
            "INSERT INTO blocks (id, block_type, content, page_id) VALUES (?1, 'page', 'S', ?1)",
            "INSERT INTO spaces (id) VALUES (?1)",
            "INSERT INTO blocks (id, block_type, content, page_id, space_id) \
             VALUES ('01HZ0000000000000000000BX1', 'page', 'X', '01HZ0000000000000000000BX1', ?1)",
            "INSERT INTO property_definitions (space_id, key, value_type, created_at) \
             VALUES (?1, 'due2', 'text', '2026-01-01T00:00:00.000Z')",
            "INSERT INTO block_properties (block_id, key, value_text) \
             VALUES ('01HZ0000000000000000000BX1', 'due2', '2026-01-05')",
        ] {
            sqlx::query(sql).bind(SPACE).execute(&pool).await.unwrap();
        }
        let state = LoroState::new();
        {
            let mut guard = state
                .registry
                .for_space(&SpaceId::from_trusted(SPACE), DEV)
                .unwrap();
            let engine = guard.engine_mut();
            engine
                .apply_create_block(BLOCK, "page", "X", None, 0)
                .unwrap();
            engine
                .apply_set_property(BLOCK, "due2", Some("2026-01-05"))
                .unwrap();
            engine
                .apply_set_property_def("due2", Some(&def("text")))
                .unwrap();
        }
        let change = RewritePropertiesPayload {
            space_id: BlockId::from_trusted(SPACE),
            reason: RewriteReason::ChangeType,
            defs: vec![PropertyDefWrite {
                key: "due2".into(),
                def: Some(def("date")),
                prior: Some(def("text")),
            }],
            values: Vec::new(),
        };

        let mut conn = pool.acquire().await.unwrap();
        apply_rewrite_properties_via_loro(&mut conn, &state, DEV, &change)
            .await
            .unwrap();

        let row: (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT value_text, value_date FROM block_properties WHERE block_id = ? AND key = 'due2'",
        )
        .bind(BLOCK)
        .fetch_one(&mut *conn)
        .await
        .unwrap();
        assert_eq!(
            row,
            (None, Some("2026-01-05".into())),
            "the unwritten value moved to value_date"
        );
    }
}
