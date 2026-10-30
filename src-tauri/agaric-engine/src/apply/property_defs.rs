//! The definition ops' apply (#5841): the space's doc, then its
//! `property_definitions` rows, then the values they move. `SetPropertyDef`
//! re-types a key's values when the definition moves them to another column;
//! `RenamePropertyKey` and `RewriteProperties` move values between keys,
//! `RenamePropertyOption` renames a select's option and the values holding it,
//! and `RewriteProperties` changes a key's type.

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

/// Apply `RenamePropertyOption` through `p.space_id`'s engine, then project
/// it to SQL: the definition the engine holds after, then the values.
pub async fn apply_rename_property_option_via_loro(
    conn: &mut sqlx::SqliteConnection,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    p: &RenamePropertyOptionPayload,
) -> Result<(), AppError> {
    use crate::loro::projection::{
        project_property_def_to_sql, project_rename_property_option_to_sql,
    };
    let space_id = p.space_id.as_str();
    let def = {
        let mut guard = state.registry.for_space_recording(
            &agaric_store::space::SpaceId::from_trusted(space_id),
            device_id,
            &state.revert,
        )?;
        guard
            .engine_mut()
            .apply_rename_property_option(&p.key, &p.old_option, &p.new_option)?
    };
    project_property_def_to_sql(conn, space_id, &p.key, def.as_ref()).await?;
    project_rename_property_option_to_sql(conn, space_id, &p.key, &p.old_option, &p.new_option)
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

    /// #5841 S4 — the rename reaches the space's rows, the Trash's included,
    /// and no other space's, and the definition row is the engine's.
    #[tokio::test]
    async fn an_option_rename_projects_the_spaces_rows_and_the_engines_definition_5841() {
        const OTHER: &str = "01HZ0000000000000000000SP2";
        const TRASHED: &str = "01HZ0000000000000000000BX2";
        const ELSEWHERE: &str = "01HZ0000000000000000000BY1";
        let (pool, _dir) = agaric_store::test_support::test_pool().await;
        for space in [SPACE, OTHER] {
            for sql in [
                "INSERT INTO blocks (id, block_type, content, page_id) VALUES (?1, 'page', 'S', ?1)",
                "INSERT INTO spaces (id) VALUES (?1)",
                "INSERT INTO property_definitions (space_id, key, value_type, options, created_at) \
                 VALUES (?1, 'stage', 'select', '[\"draft\",\"review\"]', '2026-01-01T00:00:00.000Z')",
            ] {
                sqlx::query(sql).bind(space).execute(&pool).await.unwrap();
            }
        }
        for (block, space, deleted_at) in [
            (BLOCK, SPACE, None),
            (TRASHED, SPACE, Some(1_i64)),
            (ELSEWHERE, OTHER, None),
        ] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, page_id, space_id, deleted_at) \
                 VALUES (?1, 'page', 'X', ?1, ?2, ?3)",
            )
            .bind(block)
            .bind(space)
            .bind(deleted_at)
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'stage', 'review')",
            )
            .bind(block)
            .execute(&pool)
            .await
            .unwrap();
        }
        let state = LoroState::new();
        {
            let mut guard = state
                .registry
                .for_space(&SpaceId::from_trusted(SPACE), DEV)
                .unwrap();
            let engine = guard.engine_mut();
            let options = r#"["draft","review"]"#;
            engine
                .apply_set_property_def(
                    "stage",
                    Some(&PropertyDefState {
                        value_type: "select".into(),
                        options: Some(options.into()),
                    }),
                )
                .unwrap();
            for block in [BLOCK, TRASHED] {
                engine
                    .apply_create_block(block, "page", "X", None, 0)
                    .unwrap();
                engine
                    .apply_set_property(block, "stage", Some("review"))
                    .unwrap();
            }
        }
        let rename = RenamePropertyOptionPayload {
            space_id: BlockId::from_trusted(SPACE),
            key: "stage".into(),
            old_option: "review".into(),
            new_option: "in_review".into(),
        };

        let mut conn = pool.acquire().await.unwrap();
        apply_rename_property_option_via_loro(&mut conn, &state, DEV, &rename)
            .await
            .unwrap();

        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT block_id, value_text FROM block_properties WHERE key = 'stage' ORDER BY block_id",
        )
        .fetch_all(&mut *conn)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![
                (BLOCK.to_owned(), "in_review".to_owned()),
                (TRASHED.to_owned(), "in_review".to_owned()),
                (ELSEWHERE.to_owned(), "review".to_owned()),
            ],
            "the space's rows, the Trash's included, and no other space's"
        );
        let options: Vec<(String, String)> = sqlx::query_as(
            "SELECT space_id, options FROM property_definitions WHERE key = 'stage' ORDER BY space_id",
        )
        .fetch_all(&mut *conn)
        .await
        .unwrap();
        let engine_options = state
            .registry
            .for_space(&SpaceId::from_trusted(SPACE), DEV)
            .unwrap()
            .engine_mut()
            .read_property_def("stage")
            .unwrap()
            .and_then(|def| def.options);
        assert_eq!(engine_options.as_deref(), Some(r#"["draft","in_review"]"#));
        assert_eq!(
            options,
            vec![
                (SPACE.to_owned(), engine_options.unwrap()),
                (OTHER.to_owned(), r#"["draft","review"]"#.to_owned()),
            ],
            "the space's definition row is the engine's; the other space's stays"
        );
    }
}
