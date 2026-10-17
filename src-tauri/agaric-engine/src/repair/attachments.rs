//! Repair 6 (#5608) — attachment rows written before attachments were in the
//! engine.
//!
//! An `attachments` row written before #5608 has its `AddAttachment` op but no
//! entry in its block's Loro doc, so it never reaches another device and an
//! engine reprojection does not know it. Each such row's fields are written
//! into the doc, with the row's own `created_at`.
//!
//! Unlike the other repairs this writes no op: every row already has its
//! `AddAttachment`, and a second one would stamp the backfill time, list in
//! History and give a delete's undo two adds to choose from. The engine write
//! happens in this pass, and the snapshot pass persists it like any other.
//! Each device backfills its own rows; one id written on two devices lands in
//! one mergeable entry.
//!
//! Idempotent by construction: a backfilled row has its entry, so it is not a
//! candidate on the next run, and a tombstoned entry counts as held, so a row
//! a peer deleted is not brought back by its own backfill.

use std::collections::BTreeMap;

use agaric_core::error::AppError;
use agaric_store::space::SpaceId;

use crate::loro::engine::AttachmentFields;
use crate::loro::shared::LoroState;

/// What one run of the attachment backfill did.
#[derive(Debug, Default)]
pub struct AttachmentHydration {
    /// Rows whose entry this run wrote.
    pub hydrated: usize,
}

/// One row a backfill reads.
struct Candidate {
    id: String,
    block_id: String,
    fields: AttachmentFields,
}

/// Write an engine entry for every `attachments` row whose block's space doc
/// holds none.
pub async fn hydrate_attachments_into_engine(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
) -> Result<AttachmentHydration, AppError> {
    let rows = sqlx::query!(
        r#"SELECT a.id AS "id!: String", a.block_id AS "block_id!: String", a.filename,
                  a.mime_type, a.fs_path, a.size_bytes, a.created_at, a.content_hash,
                  b.space_id AS "space_id!: String"
           FROM attachments a
           JOIN blocks b ON b.id = a.block_id
           WHERE b.space_id IS NOT NULL
           ORDER BY a.id"#,
    )
    .fetch_all(&mut **tx)
    .await?;
    let mut by_space: BTreeMap<String, Vec<Candidate>> = BTreeMap::new();
    for row in rows {
        by_space.entry(row.space_id).or_default().push(Candidate {
            id: row.id,
            block_id: row.block_id,
            fields: AttachmentFields {
                filename: row.filename,
                mime_type: row.mime_type,
                fs_path: row.fs_path,
                size_bytes: row.size_bytes,
                created_at: row.created_at,
                content_hash: row.content_hash,
            },
        });
    }
    let mut report = AttachmentHydration::default();
    for (space, candidates) in by_space {
        let space = SpaceId::from_trusted(&space);
        let mut guard = state
            .registry
            .for_space_recording(&space, device_id, &state.revert)?;
        let engine = guard.engine_mut();
        for c in candidates {
            let held = engine
                .read_attachments(&c.block_id)?
                .is_some_and(|entries| entries.iter().any(|e| e.attachment_id == c.id));
            if !held {
                engine.apply_add_attachment(&c.block_id, &c.id, &c.fields)?;
                report.hydrated += 1;
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use crate::loro::engine::{EngineAttachment, LoroEngine};
    use crate::spaces::SPACE_PERSONAL_ULID;
    use sqlx::SqlitePool;

    async fn run(pool: &SqlitePool, state: &LoroState) -> AttachmentHydration {
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let report = hydrate_attachments_into_engine(&mut tx, state, DEV)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        report
    }

    /// A content block under Personal holding `ids` as pre-#5608 rows: SQL only.
    async fn block_with_legacy_attachments(pool: &SqlitePool, ids: &[&str]) -> String {
        let id = next_id();
        insert(
            pool,
            Row {
                id: &id,
                block_type: "content",
                content: "photos",
                parent_id: Some(SPACE_PERSONAL_ULID),
                page_id: None,
                space_id: Some(SPACE_PERSONAL_ULID),
                position: 1,
            },
        )
        .await;
        for att in ids {
            let fs_path = format!("attachments/{att}");
            let filename = format!("{att}.png");
            sqlx::query!(
                "INSERT INTO attachments \
                 (id, block_id, mime_type, filename, size_bytes, fs_path, created_at, content_hash) \
                 VALUES (?, ?, 'image/png', ?, 4, ?, 1000, 'HASH')",
                att,
                id,
                filename,
                fs_path,
            )
            .execute(pool)
            .await
            .unwrap();
        }
        id
    }

    fn entries(state: &LoroState, block: &str) -> Vec<EngineAttachment> {
        let space = SpaceId::from_trusted(SPACE_PERSONAL_ULID);
        let mut guard = state.registry.for_space(&space, DEV).unwrap();
        guard
            .engine_mut()
            .read_attachments(block)
            .unwrap()
            .unwrap_or_default()
    }

    fn version_vector(state: &LoroState) -> Vec<u8> {
        let space = SpaceId::from_trusted(SPACE_PERSONAL_ULID);
        state.registry.loro_vv(&space).unwrap_or_default()
    }

    /// A fresh `LoroState` holding what `state` would persist, as a restart
    /// rehydrates it.
    fn restarted(state: &LoroState) -> LoroState {
        let next = LoroState::new();
        for (space, bytes) in state.registry.snapshot_all_engines() {
            let mut engine = LoroEngine::new();
            engine.import(&bytes.unwrap()).unwrap();
            next.registry.install_engine(space, engine);
        }
        next
    }

    #[tokio::test]
    async fn legacy_rows_enter_the_doc_with_their_fields_and_no_op() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        let block = block_with_legacy_attachments(&pool, &["ATT1", "ATT2"]).await;
        let ops_before = op_count(&pool).await;

        let report = run(&pool, &state).await;

        assert_eq!(report.hydrated, 2, "one entry per row");
        let held = entries(&state, &block);
        assert_eq!(
            held.iter()
                .map(|e| (e.attachment_id.as_str(), e.deleted_at))
                .collect::<Vec<_>>(),
            vec![("ATT1", None), ("ATT2", None)],
            "both rows are live entries"
        );
        assert_eq!(
            (
                held[0].fields.fs_path.as_str(),
                held[0].fields.created_at,
                held[0].fields.content_hash.as_deref()
            ),
            ("attachments/ATT1", 1000, Some("HASH")),
            "with the row's own fields"
        );
        assert_eq!(op_count(&pool).await, ops_before, "and no op");
    }

    #[tokio::test]
    async fn a_second_start_writes_nothing() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        block_with_legacy_attachments(&pool, &["ATT1"]).await;
        assert_eq!(
            run(&pool, &state).await.hydrated,
            1,
            "first start backfills"
        );
        let state = restarted(&state);
        let vv_before = version_vector(&state);

        let report = run(&pool, &state).await;

        assert_eq!(report.hydrated, 0, "the second start finds the entry");
        assert_eq!(
            version_vector(&state),
            vv_before,
            "and leaves the doc's version vector as it was"
        );
    }

    /// A row on two devices that each backfilled it meets as one entry.
    #[tokio::test]
    async fn two_devices_backfilling_one_row_converge_to_one_entry() {
        let (pool, _tmp) = pool_with_spaces().await;
        let block = block_with_legacy_attachments(&pool, &["ATT1"]).await;
        let space = SpaceId::from_trusted(SPACE_PERSONAL_ULID);
        let devices = [LoroState::new(), LoroState::new()];
        for (i, state) in devices.iter().enumerate() {
            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
            hydrate_attachments_into_engine(&mut tx, state, &format!("device-{i}"))
                .await
                .unwrap();
            tx.rollback().await.unwrap();
        }
        let export = |state: &LoroState| {
            state
                .registry
                .for_space(&space, "any")
                .unwrap()
                .engine_mut()
                .export_snapshot()
                .unwrap()
        };
        let (zero, one) = (export(&devices[0]), export(&devices[1]));
        let read = |state: &LoroState, bytes: &[u8]| {
            let mut guard = state.registry.for_space(&space, "any").unwrap();
            guard.engine_mut().import(bytes).unwrap();
            guard
                .engine_mut()
                .read_attachments(&block)
                .unwrap()
                .unwrap()
        };
        let on_zero = read(&devices[0], &one);
        assert_eq!(on_zero, read(&devices[1], &zero), "the devices converge");
        assert_eq!(on_zero.len(), 1, "to one entry");
    }
}
