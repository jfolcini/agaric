use crate::op::*;
use crate::op_log::OpRecord;
use crate::ulid::BlockId;
use sqlx::SqlitePool;

// ---------------------------------------------------------------------------
// Engine dispatch helper.
//
// Threads an op_log `OpRecord` (the materializer authoritative output)
// into `merge::engine_apply`. Resolves the block's owning space via
// `crate::space::resolve_block_space` and walks the global engine state
// installed at bootstrap. Failures are logged-and-skipped so the
// engine-dispatch path can never break the materializer.
// ---------------------------------------------------------------------------

pub(crate) async fn dispatch_for_record(pool: &SqlitePool, record: &OpRecord) {
    let Some(state) = crate::loro::shared::get() else {
        // Engine state not initialised (e.g. unit-test environments
        // that bypass `crate::run`).  Skip silently.
        return;
    };

    // `OpPayload` is `#[serde(tag = "op_type")]` (internally tagged),
    // but `op_log::serialize_inner_payload` strips the tag (it lives
    // in the `op_log.op_type` column, not the JSON blob). Branch on
    // `record.op_type` (the dedicated column), parse the
    // corresponding inner-only struct, then re-wrap as `OpPayload` so
    // the rest of the function (block-id extraction, space resolve,
    // `engine_apply` call) is untouched.
    let payload: OpPayload = match record.op_type.as_str() {
        "create_block" => {
            match serde_json::from_str::<crate::op::CreateBlockPayload>(&record.payload) {
                Ok(p) => OpPayload::CreateBlock(p),
                Err(e) => return dispatch_log_parse_err(record, &e),
            }
        }
        "edit_block" => {
            match serde_json::from_str::<crate::op::EditBlockPayload>(&record.payload) {
                Ok(p) => OpPayload::EditBlock(p),
                Err(e) => return dispatch_log_parse_err(record, &e),
            }
        }
        "delete_block" => {
            match serde_json::from_str::<crate::op::DeleteBlockPayload>(&record.payload) {
                Ok(p) => OpPayload::DeleteBlock(p),
                Err(e) => return dispatch_log_parse_err(record, &e),
            }
        }
        "restore_block" => {
            match serde_json::from_str::<crate::op::RestoreBlockPayload>(&record.payload) {
                Ok(p) => OpPayload::RestoreBlock(p),
                Err(e) => return dispatch_log_parse_err(record, &e),
            }
        }
        "purge_block" => {
            match serde_json::from_str::<crate::op::PurgeBlockPayload>(&record.payload) {
                Ok(p) => OpPayload::PurgeBlock(p),
                Err(e) => return dispatch_log_parse_err(record, &e),
            }
        }
        "move_block" => {
            match serde_json::from_str::<crate::op::MoveBlockPayload>(&record.payload) {
                Ok(p) => OpPayload::MoveBlock(p),
                Err(e) => return dispatch_log_parse_err(record, &e),
            }
        }
        "add_tag" => match serde_json::from_str::<crate::op::AddTagPayload>(&record.payload) {
            Ok(p) => OpPayload::AddTag(p),
            Err(e) => return dispatch_log_parse_err(record, &e),
        },
        "remove_tag" => {
            match serde_json::from_str::<crate::op::RemoveTagPayload>(&record.payload) {
                Ok(p) => OpPayload::RemoveTag(p),
                Err(e) => return dispatch_log_parse_err(record, &e),
            }
        }
        "set_property" => {
            match serde_json::from_str::<crate::op::SetPropertyPayload>(&record.payload) {
                Ok(p) => OpPayload::SetProperty(p),
                Err(e) => return dispatch_log_parse_err(record, &e),
            }
        }
        "delete_property" => {
            match serde_json::from_str::<crate::op::DeletePropertyPayload>(&record.payload) {
                Ok(p) => OpPayload::DeleteProperty(p),
                Err(e) => return dispatch_log_parse_err(record, &e),
            }
        }
        "add_attachment" => {
            match serde_json::from_str::<crate::op::AddAttachmentPayload>(&record.payload) {
                Ok(p) => OpPayload::AddAttachment(p),
                Err(e) => return dispatch_log_parse_err(record, &e),
            }
        }
        "delete_attachment" => {
            match serde_json::from_str::<crate::op::DeleteAttachmentPayload>(&record.payload) {
                Ok(p) => OpPayload::DeleteAttachment(p),
                Err(e) => return dispatch_log_parse_err(record, &e),
            }
        }
        other => {
            // Unknown op_type — matches the pre-fix "unsupported" path
            // (log + return, never break the engine-dispatch path).
            tracing::warn!(
                device_id = %record.device_id,
                seq = record.seq,
                op_type = %other,
                "engine_dispatch: unknown op_type; skipping",
            );
            return;
        }
    };

    let Some(block_id_str) = payload.block_id() else {
        // Op types without a `block_id` (today only DeleteAttachment)
        // can't be assigned to a space; skip.
        return;
    };
    let block_id = BlockId::from_trusted(block_id_str);

    let space_id = match crate::space::resolve_block_space(pool, &block_id).await {
        Ok(Some(s)) => s,
        Ok(None) => {
            // No `space` ref on the owning page — pre-FEAT-3 data, or
            // a block created before space membership was assigned.
            // Skip: there's no canonical engine to mirror onto.  Day-3
            // may revisit by routing such ops to a "default" space.
            tracing::trace!(
                block_id = block_id_str,
                "engine_dispatch: no space found for block; skipping",
            );
            return;
        }
        Err(e) => {
            tracing::warn!(
                block_id = block_id_str,
                error = %e,
                "engine_dispatch: resolve_block_space failed; skipping",
            );
            return;
        }
    };

    let op_id = format!("{}/{}", record.device_id, record.seq);

    super::engine_apply(
        &op_id,
        &payload,
        &record.device_id,
        &space_id,
        &record.created_at.to_string(),
        state,
    );
}

/// Shared warn-and-return helper for the per-variant inner-payload
/// parse arms in `dispatch_for_record`. Pulling the warn into a
/// single function keeps the dispatcher's match arms uniform and the
/// per-arm boilerplate to one line.
fn dispatch_log_parse_err(record: &OpRecord, err: &serde_json::Error) {
    tracing::warn!(
        device_id = %record.device_id,
        seq = record.seq,
        op_type = %record.op_type,
        error = %err,
        "engine_dispatch: failed to parse inner payload; skipping",
    );
}

// ---------------------------------------------------------------------------
// Engine-dispatch unit tests. Exercise `engine_apply` directly.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod engine_apply_unit_tests {
    use crate::loro::registry::LoroEngineRegistry;
    use crate::loro::shared::LoroState;
    use crate::merge::engine_apply;
    use crate::op::{
        AddTagPayload, CreateBlockPayload, DeleteBlockPayload, DeletePropertyPayload,
        EditBlockPayload, OpPayload, PurgeBlockPayload, RemoveTagPayload, RestoreBlockPayload,
        SetPropertyPayload,
    };
    use crate::space::SpaceId;
    use crate::ulid::BlockId;

    /// Two valid ULIDs reused across these tests.
    const SPACE_A: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const SPACE_B: &str = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
    const BLOCK_1: &str = "01HZ00000000000000000000AB";
    const BLOCK_2: &str = "01HZ00000000000000000000CD";
    const DEVICE_ID: &str = "device-engine-apply-test";

    fn fresh_state() -> LoroState {
        LoroState {
            registry: LoroEngineRegistry::new(),
        }
    }

    fn create_op(block_id: &str, content: &str) -> OpPayload {
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(block_id),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: content.into(),
        })
    }

    fn edit_op(block_id: &str, to_text: &str) -> OpPayload {
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::from_trusted(block_id),
            to_text: to_text.into(),
            prev_edit: None,
        })
    }

    fn delete_op(block_id: &str) -> OpPayload {
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::from_trusted(block_id),
        })
    }

    fn set_prop_op(block_id: &str, key: &str, value_text: &str) -> OpPayload {
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::from_trusted(block_id),
            key: key.into(),
            value_text: Some(value_text.into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        })
    }

    /// Dispatching a `CreateBlock` op via engine_apply must populate
    /// the per-space engine.
    #[test]
    fn dispatch_create_block_populates_engine() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);
        let op = create_op(BLOCK_1, "hello");

        engine_apply(
            "DEV/1",
            &op,
            DEVICE_ID,
            &space,
            "2025-01-15T12:00:00Z",
            &state,
        );

        // The engine for SPACE_A must hold BLOCK_1 with content "hello".
        // Scope the guard so the registry mutex is released before
        // `state.registry.len()` re-locks it (the registry uses a
        // single coarse Mutex; `for_space` + `len` share it).
        {
            let mut guard = state
                .registry
                .for_space(&space, DEVICE_ID)
                .expect("for_space");
            let snap = guard
                .engine_mut()
                .read_block(BLOCK_1)
                .expect("read")
                .expect("block exists");
            assert_eq!(snap.content, "hello");
            assert_eq!(snap.block_type, "content");
        }
        assert_eq!(state.registry.len(), 1);
    }

    /// A Create + Edit + Delete sequence on the same engine must
    /// reflect each step in the engine's state.
    #[test]
    fn dispatch_create_edit_delete_sequence_matches_engine_state() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);

        for op in [
            create_op(BLOCK_1, "alpha"),
            edit_op(BLOCK_1, "alpha-beta"),
            delete_op(BLOCK_1),
        ] {
            engine_apply(
                "DEV/x",
                &op,
                DEVICE_ID,
                &space,
                "2025-01-15T12:00:00Z",
                &state,
            );
        }

        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let engine = guard.engine_mut();
        let snap = engine.read_block(BLOCK_1).expect("read").expect("present");
        assert_eq!(snap.content, "alpha-beta", "edit must have applied");
        assert!(
            engine.read_deleted(BLOCK_1).expect("read_deleted"),
            "delete must have applied"
        );
    }

    /// CreateBlocks for two different spaces must produce two engines
    /// in the registry that don't share state.
    #[test]
    fn dispatch_two_spaces_yields_two_isolated_engines() {
        let state = fresh_state();
        let space_a = SpaceId::from_trusted(SPACE_A);
        let space_b = SpaceId::from_trusted(SPACE_B);

        let op_a = create_op(BLOCK_1, "in A");
        engine_apply(
            "DEV/1",
            &op_a,
            DEVICE_ID,
            &space_a,
            "2025-01-15T12:00:00Z",
            &state,
        );
        let op_b = create_op(BLOCK_2, "in B");
        engine_apply(
            "DEV/2",
            &op_b,
            DEVICE_ID,
            &space_b,
            "2025-01-15T12:00:00Z",
            &state,
        );

        assert_eq!(state.registry.len(), 2, "must hold two distinct engines");

        // Engine A must NOT have BLOCK_2 and engine B must NOT have BLOCK_1.
        {
            let mut g = state.registry.for_space(&space_a, DEVICE_ID).expect("a");
            assert!(g.engine_mut().read_block(BLOCK_2).unwrap().is_none());
            assert!(g.engine_mut().read_block(BLOCK_1).unwrap().is_some());
        }
        {
            let mut g = state.registry.for_space(&space_b, DEVICE_ID).expect("b");
            assert!(g.engine_mut().read_block(BLOCK_1).unwrap().is_none());
            assert!(g.engine_mut().read_block(BLOCK_2).unwrap().is_some());
        }
    }

    // ---------------------------------------------------------------------
    // Dispatcher coverage for the five op types beyond the basic
    // CreateBlock / EditBlock / DeleteBlock / MoveBlock / SetProperty
    // set (AddTag / RemoveTag / RestoreBlock / PurgeBlock /
    // DeleteProperty). Each test seeds the engine with a CreateBlock,
    // dispatches the new op via `engine_apply`, and asserts the
    // engine reflects the mutation.
    // ---------------------------------------------------------------------

    /// Valid ULID fixture for the tag-id position.  Distinct from
    /// `BLOCK_1` / `BLOCK_2` so a swapped (block_id, tag_id) bug
    /// surfaces as a wrong-id assertion.
    const TAG_ULID: &str = "01HZ00000000000000000000T1";

    fn add_tag_op(block_id: &str, tag_id: &str) -> OpPayload {
        OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::from_trusted(block_id),
            tag_id: BlockId::from_trusted(tag_id),
        })
    }

    fn remove_tag_op(block_id: &str, tag_id: &str) -> OpPayload {
        OpPayload::RemoveTag(RemoveTagPayload {
            block_id: BlockId::from_trusted(block_id),
            tag_id: BlockId::from_trusted(tag_id),
        })
    }

    fn restore_op(block_id: &str) -> OpPayload {
        OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::from_trusted(block_id),
            // `deleted_at_ref` is not consulted by the engine (LWW
            // happens at the LoroValue level); supply a placeholder.
            deleted_at_ref: 1_736_942_400_000,
        })
    }

    fn purge_op(block_id: &str) -> OpPayload {
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::from_trusted(block_id),
        })
    }

    fn delete_prop_op(block_id: &str, key: &str) -> OpPayload {
        OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::from_trusted(block_id),
            key: key.into(),
        })
    }

    /// Helper: drive an op through `engine_apply`.  Mirrors the pattern
    /// from the existing tests.
    fn dispatch(state: &LoroState, space: &SpaceId, op_id: &str, op: &OpPayload) {
        engine_apply(op_id, op, DEVICE_ID, space, "2025-01-15T12:00:00Z", state);
    }

    #[test]
    fn engine_apply_dispatches_add_tag() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);
        // Seed: block must exist before tags are applied.
        dispatch(&state, &space, "DEV/1", &create_op(BLOCK_1, "seed"));
        dispatch(&state, &space, "DEV/2", &add_tag_op(BLOCK_1, TAG_ULID));

        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let tags = guard.engine_mut().read_tags(BLOCK_1).expect("read_tags");
        assert_eq!(
            tags,
            vec![BlockId::from_trusted(TAG_ULID).as_str().to_string()]
        );
    }

    #[test]
    fn engine_apply_dispatches_remove_tag() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);
        dispatch(&state, &space, "DEV/1", &create_op(BLOCK_1, "seed"));
        dispatch(&state, &space, "DEV/2", &add_tag_op(BLOCK_1, TAG_ULID));
        dispatch(&state, &space, "DEV/3", &remove_tag_op(BLOCK_1, TAG_ULID));

        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let tags = guard.engine_mut().read_tags(BLOCK_1).expect("read_tags");
        assert!(tags.is_empty(), "tag must be removed");
    }

    #[test]
    fn engine_apply_dispatches_restore_block() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);
        dispatch(&state, &space, "DEV/1", &create_op(BLOCK_1, "seed"));
        dispatch(&state, &space, "DEV/2", &delete_op(BLOCK_1));
        dispatch(&state, &space, "DEV/3", &restore_op(BLOCK_1));

        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        assert!(
            !guard
                .engine_mut()
                .read_deleted(BLOCK_1)
                .expect("read_deleted"),
            "post-restore must not be flagged deleted"
        );
    }

    #[test]
    fn engine_apply_dispatches_purge_block() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);
        dispatch(&state, &space, "DEV/1", &create_op(BLOCK_1, "seed"));
        dispatch(&state, &space, "DEV/2", &purge_op(BLOCK_1));

        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        assert!(
            guard.engine_mut().read_block(BLOCK_1).unwrap().is_none(),
            "purged block must be absent from engine"
        );
    }

    #[test]
    fn engine_apply_dispatches_delete_property() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);
        dispatch(&state, &space, "DEV/1", &create_op(BLOCK_1, "seed"));
        dispatch(&state, &space, "DEV/2", &set_prop_op(BLOCK_1, "k", "v"));
        dispatch(&state, &space, "DEV/3", &delete_prop_op(BLOCK_1, "k"));

        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        assert_eq!(
            guard.engine_mut().read_property(BLOCK_1, "k").unwrap(),
            None,
            "delete_property must remove the key entirely"
        );
    }
}

// ---------------------------------------------------------------------------
// Regression coverage for the `dispatch_for_record` payload-parsing
// path.
//
// `OpPayload` is internally tagged on `op_type`, but
// `op_log::serialize_inner_payload` strips the tag (the op_type lives
// in the dedicated column). The dispatcher therefore branches on
// `record.op_type` and parses the inner-only payload struct directly.
// These tests build real `OpRecord`s via `op_log::append_local_op`
// (which exercises the same `serialize_inner_payload` path that
// production uses) and assert the engine state is mutated by
// `dispatch_for_record`. A future change that drops a match arm or
// reverts to a tagged parse will fail them.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod dispatch_for_record_regression {
    use super::dispatch_for_record;
    use crate::db::init_pool;
    use crate::loro::shared::{install_for_test, LoroState};
    use crate::op::{CreateBlockPayload, EditBlockPayload, OpPayload, SetPropertyPayload};
    use crate::op_log::append_local_op;
    use crate::space::SpaceId;
    use crate::ulid::BlockId;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    const SPACE_ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const BLOCK_ULID: &str = "01HZ00000000000000000000AB";
    const DEVICE_ID: &str = "device-engine-dispatch-regression";

    async fn fresh_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("engine_dispatch.db");
        let pool = init_pool(&db_path).await.expect("init_pool");
        (pool, dir)
    }

    /// Seed the SQL minimum that lets `resolve_block_space` resolve
    /// `BLOCK_ULID` to `SPACE_ULID`:
    ///   * a `blocks` row for the space (so the FK on
    ///     `block_properties.value_ref` is satisfied)
    ///   * a `blocks` row for the target block (so the
    ///     `JOIN blocks tgt` in `resolve_block_space` returns a hit)
    ///   * a `block_properties (key='space', value_ref=SPACE)` row on
    ///     the target block (so the property lookup itself succeeds).
    async fn seed_space_membership(pool: &SqlitePool) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'space', NULL, 0)",
        )
        .bind(SPACE_ULID)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'content', '', NULL, 0, ?)",
        )
        .bind(BLOCK_ULID)
        .bind(BLOCK_ULID)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'space', ?)",
        )
        .bind(BLOCK_ULID)
        .bind(SPACE_ULID)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Read the engine snapshot for `BLOCK_ULID` in `SPACE_ULID`.
    fn engine_block_content(state: &LoroState) -> Option<String> {
        let space = SpaceId::from_trusted(SPACE_ULID);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        guard
            .engine_mut()
            .read_block(BLOCK_ULID)
            .expect("read_block")
            .map(|s| s.content)
    }

    /// Engine-side property lookup, flattened to `Option<String>`:
    ///   * `Ok(None)`        → key never set            → returns `None`
    ///   * `Ok(Some(None))`  → key explicitly cleared   → returns `None`
    ///   * `Ok(Some(Some(s)))` → key holds string `s`   → returns `Some(s)`
    fn engine_property(state: &LoroState, key: &str) -> Option<String> {
        let space = SpaceId::from_trusted(SPACE_ULID);
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        guard
            .engine_mut()
            .read_property(BLOCK_ULID, key)
            .expect("read_property")
            .flatten()
    }

    /// `CreateBlock` must reach the engine when threaded through
    /// `dispatch_for_record`.
    #[tokio::test]
    async fn dispatch_for_record_applies_create_block() {
        let (pool, _dir) = fresh_pool().await;
        seed_space_membership(&pool).await;
        let state = install_for_test();

        // Build a real OpRecord via the production write path so the
        // payload column matches `serialize_inner_payload`'s shape
        // exactly (no `op_type` tag).
        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ULID),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "hello-from-record".into(),
        });
        let record = append_local_op(&pool, DEVICE_ID, payload)
            .await
            .expect("append");

        // Sanity: the persisted payload must NOT carry the `op_type`
        // tag (the dispatcher parses the inner-only payload — if a
        // future change starts including the tag, the dispatcher's
        // inner-only parse needs to be revisited).
        assert!(
            !record.payload.contains("\"op_type\""),
            "op_log payload must not embed the op_type tag (regression: \
             serialize_inner_payload changed shape, dispatcher parse needs review)"
        );

        // Drive the dispatcher.
        dispatch_for_record(&pool, &record).await;

        // Engine must now hold the block with the content from the
        // payload. This is the load-bearing assertion.
        assert_eq!(
            engine_block_content(state).as_deref(),
            Some("hello-from-record"),
            "dispatch_for_record must apply CreateBlock to the engine"
        );
    }

    /// `EditBlock` and `SetProperty` must also reach the engine. Two
    /// variants in one test to give the regression net more breadth
    /// without spinning up two pools.
    #[tokio::test]
    async fn dispatch_for_record_applies_edit_and_set_property() {
        let (pool, _dir) = fresh_pool().await;
        seed_space_membership(&pool).await;
        let state = install_for_test();

        // Seed the engine with the block (via the dispatcher, so we
        // also cover CreateBlock as a side effect).
        let create_payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ULID),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "v1".into(),
        });
        let r1 = append_local_op(&pool, DEVICE_ID, create_payload)
            .await
            .expect("append create");
        dispatch_for_record(&pool, &r1).await;
        assert_eq!(
            engine_block_content(state).as_deref(),
            Some("v1"),
            "seed CreateBlock must reach the engine"
        );

        // EditBlock — content must update.
        let edit_payload = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_ULID),
            to_text: "v2".into(),
            prev_edit: None,
        });
        let r2 = append_local_op(&pool, DEVICE_ID, edit_payload)
            .await
            .expect("append edit");
        dispatch_for_record(&pool, &r2).await;
        assert_eq!(
            engine_block_content(state).as_deref(),
            Some("v2"),
            "dispatch_for_record must apply EditBlock to the engine"
        );

        // SetProperty — property must appear.
        let set_payload = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::from_trusted(BLOCK_ULID),
            key: "priority".into(),
            value_text: Some("high".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        });
        let r3 = append_local_op(&pool, DEVICE_ID, set_payload)
            .await
            .expect("append set");
        dispatch_for_record(&pool, &r3).await;
        assert_eq!(
            engine_property(state, "priority").as_deref(),
            Some("high"),
            "dispatch_for_record must apply SetProperty to the engine"
        );
    }
}
