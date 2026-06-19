//! Unit tests for `merge::engine_apply`.
//!
//! The former `dispatch_for_record` helper (OpRecord → OpPayload →
//! `engine_apply`, post-commit) was removed in #603: every op type is
//! already engine-applied INSIDE the materializer apply transaction
//! (`apply_op_tx` → `apply_*_via_loro`), and the post-commit re-apply
//! ignored the new-scheme `index`/`new_index` routing, converging
//! engine sibling order toward ULID order on every boot replay.

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
            guard
                .engine_mut()
                .read_property_typed(BLOCK_1, "k")
                .unwrap(),
            None,
            "delete_property must remove the key entirely"
        );
    }

    /// #603 — new-scheme creates (`index: Some(slot)`, `position: None`)
    /// routed through `engine_apply` must land at the requested slot,
    /// exactly like `apply_create_block_via_loro` does. Pre-#603 the
    /// CreateBlock arm ignored `index` and fell back to the legacy
    /// position path (`position.unwrap_or(0)`), converging sibling
    /// order toward ULID order.
    #[test]
    fn engine_apply_routes_create_on_new_scheme_index() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);
        const PARENT: &str = "01HZ00000000000000000000PP";
        // ULID order: A < B — the expected sibling order below is the
        // REVERSE, so a legacy-path regression (ULID-order convergence)
        // flips the assertion.
        const CHILD_A: &str = "01HZ00000000000000000000XA";
        const CHILD_B: &str = "01HZ00000000000000000000XB";

        let new_scheme_create = |block_id: &str, index: i64| {
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::from_trusted(block_id),
                block_type: "content".into(),
                parent_id: Some(BlockId::from_trusted(PARENT)),
                position: None,
                index: Some(index),
                content: "c".into(),
            })
        };

        dispatch(&state, &space, "DEV/1", &create_op(PARENT, "parent"));
        // A appended at slot 0, then B inserted ABOVE it at slot 0.
        dispatch(&state, &space, "DEV/2", &new_scheme_create(CHILD_A, 0));
        dispatch(&state, &space, "DEV/3", &new_scheme_create(CHILD_B, 0));

        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let order = guard
            .engine_mut()
            .children_ordered_block_ids(Some(PARENT))
            .expect("children_ordered_block_ids");
        assert_eq!(
            order,
            vec![CHILD_B.to_string(), CHILD_A.to_string()],
            "insert-above at index 0 must place B before A (legacy \
             position fallback would yield ULID order [A, B])"
        );
    }

    /// #603 — new-scheme moves (`new_index: Some(slot)`) routed through
    /// `engine_apply` must use the slot-based move, mirroring
    /// `apply_move_block_via_loro`.
    #[test]
    fn engine_apply_routes_move_on_new_scheme_index() {
        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);
        const PARENT: &str = "01HZ00000000000000000000PP";
        const CHILD_A: &str = "01HZ00000000000000000000MA";
        const CHILD_B: &str = "01HZ00000000000000000000MB";

        let new_scheme_create = |block_id: &str, index: i64| {
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::from_trusted(block_id),
                block_type: "content".into(),
                parent_id: Some(BlockId::from_trusted(PARENT)),
                position: None,
                index: Some(index),
                content: "c".into(),
            })
        };

        dispatch(&state, &space, "DEV/1", &create_op(PARENT, "parent"));
        dispatch(&state, &space, "DEV/2", &new_scheme_create(CHILD_A, 0));
        dispatch(&state, &space, "DEV/3", &new_scheme_create(CHILD_B, 1));
        // Move B (currently last) to slot 0. The legacy breadcrumb
        // `new_position` is deliberately set to a junk trailing value so
        // a regression that routes on it is caught.
        let mv = OpPayload::MoveBlock(crate::op::MoveBlockPayload {
            block_id: BlockId::from_trusted(CHILD_B),
            new_parent_id: Some(BlockId::from_trusted(PARENT)),
            new_position: 99,
            new_index: Some(0),
        });
        dispatch(&state, &space, "DEV/4", &mv);

        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        let order = guard
            .engine_mut()
            .children_ordered_block_ids(Some(PARENT))
            .expect("children_ordered_block_ids");
        assert_eq!(
            order,
            vec![CHILD_B.to_string(), CHILD_A.to_string()],
            "move-to-index-0 must place B before A (routing on the \
             legacy new_position breadcrumb would keep/append B last)"
        );
    }

    /// #1571: when a swallowed `engine_apply` failure occurs in a
    /// post-commit cohort fan-out (the SQL tx already committed, so the
    /// failure cannot be rolled back), `engine_apply` must bump the
    /// dedicated, machine-detectable divergence counter — not only emit a
    /// free-text warn.
    ///
    /// We drive a cohort-shaped op (`op_id` carries the `#cohort/<id>`
    /// suffix the fan-out helpers synthesise) through the SAME
    /// `engine_apply` entry point the fan-out helpers call, and force the
    /// engine dispatch to fail deterministically with a `MoveBlock` on a
    /// block id that was never created (`apply_move_block` returns
    /// "block not found"). The swallow path must advance
    /// `crate::merge::divergence::count()`.
    #[test]
    fn swallowed_cohort_fanout_failure_increments_divergence_counter() {
        use crate::merge::divergence;

        let state = fresh_state();
        let space = SpaceId::from_trusted(SPACE_A);

        // A MoveBlock targeting a never-created block id forces
        // `engine.apply_move_block` to return Err, which engine_apply
        // swallows (warn + skip). `new_index: None` routes through the
        // legacy `apply_move_block` arm whose `node_for` miss is the
        // deterministic error.
        let missing = "01HZ00000000000000000000ZZ";
        let mv = OpPayload::MoveBlock(crate::op::MoveBlockPayload {
            block_id: BlockId::from_trusted(missing),
            new_parent_id: None,
            new_position: 0,
            new_index: None,
        });
        // `op_id` mirrors the cohort fan-out shape:
        // `<device>/<seq>#cohort/<block_id>`.
        let cohort_op_id = format!("{DEVICE_ID}/7#cohort/{missing}");

        // Monotonic counter: capture the baseline, then assert it strictly
        // advances. Robust under nextest parallelism (the counter is never
        // reset, so other tests can only push it higher).
        let before = divergence::count();
        dispatch(&state, &space, &cohort_op_id, &mv);
        let after = divergence::count();

        assert!(
            after > before,
            "a swallowed cohort fan-out engine_apply failure must bump the \
             divergence counter (before={before}, after={after})"
        );
    }
}
