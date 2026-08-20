use super::*;
use crate::db::init_pool;
use agaric_engine::loro::engine::LoroEngine;
use agaric_engine::loro::registry::LoroEngineRegistry;
use agaric_store::space::SpaceId;
use sqlx::SqlitePool;
use tempfile::TempDir;

const SPACE_A: &str = "01HZ00000000000000000000SP";
const BLOCK_A: &str = "01HZ00000000000000000000A1";
const BLOCK_B: &str = "01HZ00000000000000000000B2";
const BLOCK_C: &str = "01HZ00000000000000000000C3";
const BLOCK_D: &str = "01HZ00000000000000000000D4";
const BLOCK_E: &str = "01HZ00000000000000000000E5";

async fn fresh_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("loro_sync_test.db");
    let pool = init_pool(&db_path).await.expect("init_pool");
    (pool, dir)
}

/// `prepare_outgoing(None)` → Snapshot variant carrying the full
/// engine state.  Initial-sync invariant.
#[tokio::test]
async fn prepare_outgoing_with_no_peer_vv_returns_snapshot() {
    let (pool, _dir) = fresh_pool().await;
    let registry = LoroEngineRegistry::new();
    let space = SpaceId::from_trusted(SPACE_A);

    // Seed the engine with one block so the snapshot has a payload.
    {
        let mut g = registry.for_space(&space, "device-S").expect("for_space");
        g.engine_mut()
            .apply_create_block(BLOCK_A, "content", "hello", None, 0)
            .expect("create");
    }

    let msg = prepare_outgoing_for_pool(&pool, &registry, &space, "device-S", None)
        .await
        .expect("prepare_outgoing")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    match msg {
        LoroSyncMessage::Snapshot {
            protocol_version,
            space_id,
            bytes,
        } => {
            assert_eq!(protocol_version, LORO_SYNC_PROTOCOL_VERSION);
            assert_eq!(space_id, space);
            assert!(!bytes.is_empty(), "snapshot bytes must be non-empty");
        }
        other => panic!("expected Snapshot, got {other:?}"),
    }
}

/// `prepare_outgoing(Some(vv))` → Update variant carrying only the
/// post-vv ops.  Mirrors the engine's `export_update_since`
/// invariant: receiver re-creates the post-vv blocks but not the
/// pre-vv ones (it has those already).
#[tokio::test]
async fn prepare_outgoing_with_peer_vv_returns_update() {
    let (pool, _dir) = fresh_pool().await;
    let registry = LoroEngineRegistry::new();
    let space = SpaceId::from_trusted(SPACE_A);

    // Apply 3 ops, capture vv, apply 2 more.
    let vv_after_first_batch = {
        let mut g = registry.for_space(&space, "device-S").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "first", None, 0)
            .expect("create A");
        e.apply_create_block(BLOCK_B, "content", "second", None, 1)
            .expect("create B");
        e.apply_create_block(BLOCK_C, "content", "third", None, 2)
            .expect("create C");
        let vv = e.version_vector();
        e.apply_create_block(BLOCK_D, "content", "fourth", None, 3)
            .expect("create D");
        e.apply_create_block(BLOCK_E, "content", "fifth", None, 4)
            .expect("create E");
        vv
    };

    let msg = prepare_outgoing_for_pool(
        &pool,
        &registry,
        &space,
        "device-S",
        Some(&vv_after_first_batch),
    )
    .await
    .expect("prepare_outgoing")
    .expect("#1257 freshness gate must not refuse a consistent engine");

    let (from_vv, delta_bytes) = match msg {
        LoroSyncMessage::Update {
            protocol_version,
            space_id,
            from_vv,
            bytes,
        } => {
            assert_eq!(protocol_version, LORO_SYNC_PROTOCOL_VERSION);
            assert_eq!(space_id, space);
            assert!(!bytes.is_empty(), "update bytes must be non-empty");
            (from_vv, bytes)
        }
        other => panic!("expected Update, got {other:?}"),
    };
    assert_eq!(
        from_vv, vv_after_first_batch,
        "Update.from_vv must echo the peer-vv passed by the caller"
    );

    // Verify the delta carries D and E but NOT A/B/C: import into
    // a receiver that already has A/B/C.
    let mut receiver = LoroEngine::with_peer_id("device-S").expect("rcv");
    receiver
        .apply_create_block(BLOCK_A, "content", "first", None, 0)
        .expect("rcv create A");
    receiver
        .apply_create_block(BLOCK_B, "content", "second", None, 1)
        .expect("rcv create B");
    receiver
        .apply_create_block(BLOCK_C, "content", "third", None, 2)
        .expect("rcv create C");
    assert!(receiver.read_block(BLOCK_D).unwrap().is_none());
    assert!(receiver.read_block(BLOCK_E).unwrap().is_none());

    receiver.import(&delta_bytes).expect("import delta");
    assert!(receiver.read_block(BLOCK_D).unwrap().is_some());
    assert!(receiver.read_block(BLOCK_E).unwrap().is_some());
}

/// Apply A's snapshot to a fresh B; assert B's engine sees the
/// blocks A had.  Engine-level convergence after a Snapshot
/// import.
#[tokio::test]
async fn apply_remote_imports_snapshot_into_engine() {
    let (pool, _dir) = fresh_pool().await;

    // Build A and produce a Snapshot message.
    let registry_a = LoroEngineRegistry::new();
    let space = SpaceId::from_trusted(SPACE_A);
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        g.engine_mut()
            .apply_create_block(BLOCK_A, "content", "from-A", None, 0)
            .expect("create");
    }
    let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    // Apply on B (fresh registry).
    let registry_b = LoroEngineRegistry::new();
    let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
        .await
        .expect("apply_remote");
    match outcome {
        ApplyOutcome::Imported {
            space_id: returned, ..
        } => assert_eq!(returned, space),
        ApplyOutcome::SnapshotFallbackRequested { reason, .. } => {
            panic!("expected Imported, got SnapshotFallbackRequested: {reason}")
        }
    }

    // B's engine now sees BLOCK_A.
    let mut g = registry_b.for_space(&space, "device-B").expect("for_space");
    let snap = g
        .engine_mut()
        .read_block(BLOCK_A)
        .expect("read")
        .expect("BLOCK_A must be present after import");
    assert_eq!(snap.content, "from-A");
}

/// #2188 — the `block_in_place` wrap around the CPU-bound CRDT
/// export (`prepare_outgoing`) and import (`apply_remote`) must:
///   1. NOT panic on a genuine multi-thread tokio runtime, and
///   2. preserve behaviour — the exported bytes import into an
///      equivalent doc (full-snapshot AND incremental-update round
///      trips), converging both the engine and SQL projection.
///
/// `block_in_place` PANICS on a current-thread runtime; production
/// sync always runs on tauri's multi-thread async runtime / the
/// daemon's `tokio::spawn`, so this test pins the multi-thread flavor
/// to exercise the real path. A regression that ran these calls on a
/// current-thread runtime would panic here.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_import_round_trips_through_block_in_place_2188() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    // Sender A: seed three blocks, capture vv, then add two more so
    // we can exercise BOTH the snapshot and the incremental-update
    // export paths (each wrapped in `block_in_place`).
    let registry_a = LoroEngineRegistry::new();
    let vv_after_first_batch = {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "first", None, 0)
            .expect("create A");
        e.apply_create_block(BLOCK_B, "content", "second", None, 1)
            .expect("create B");
        e.apply_create_block(BLOCK_C, "content", "third", None, 2)
            .expect("create C");
        let vv = e.version_vector();
        e.apply_create_block(BLOCK_D, "content", "fourth", None, 3)
            .expect("create D");
        e.apply_create_block(BLOCK_E, "content", "fifth", None, 4)
            .expect("create E");
        vv
    };

    // --- Full snapshot export (block_in_place) → apply on fresh B ---
    let snapshot_msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare snapshot")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    let registry_b = LoroEngineRegistry::new();
    let outcome = apply_remote(&pool, &registry_b, "device-B", snapshot_msg)
        .await
        .expect("apply snapshot");
    assert!(
        matches!(outcome, ApplyOutcome::Imported { space_id: ref s, .. } if s == &space),
        "snapshot apply must report Imported, got {outcome:?}"
    );

    // B's engine converged to A's full state via the block_in_place import.
    {
        let mut g = registry_b.for_space(&space, "device-B").expect("for_space");
        let e = g.engine_mut();
        for id in [BLOCK_A, BLOCK_B, BLOCK_C, BLOCK_D, BLOCK_E] {
            assert!(
                e.read_block(id).expect("read").is_some(),
                "block {id} must be present in B after snapshot import"
            );
        }
    }
    assert_eq!(
        registry_b.loro_vv(&space).expect("b vv"),
        registry_a.loro_vv(&space).expect("a vv"),
        "B's version vector must match A's after snapshot round-trip"
    );

    // --- Incremental update export (block_in_place) → apply on B ---
    // B now shares A's exact causal lineage (it imported A's snapshot),
    // so an incremental update A produces after adding MORE ops imports
    // cleanly (no `(peer,counter)` fork). This exercises the
    // `export_update_since` + `import_with_changed_purged_tagscope`
    // block_in_place paths on a genuinely reachable delta.
    let _ = vv_after_first_batch; // captured above for documentation only
    let vv_before_delta = registry_b.loro_vv(&space).expect("b vv pre-delta");
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        g.engine_mut()
            .apply_create_block("01HZ00000000000000000000F6", "content", "sixth", None, 5)
            .expect("create F");
    }

    let update_msg = prepare_outgoing_for_pool(
        &pool,
        &registry_a,
        &space,
        "device-A",
        Some(&vv_before_delta),
    )
    .await
    .expect("prepare update")
    .expect("#1257 freshness gate must not refuse a consistent engine");

    let outcome = apply_remote(&pool, &registry_b, "device-B", update_msg)
        .await
        .expect("apply update");
    assert!(
        matches!(outcome, ApplyOutcome::Imported { space_id: ref s, .. } if s == &space),
        "incremental update apply must report Imported, got {outcome:?}"
    );

    // The delta carried the new block; B now holds it.
    {
        let mut g = registry_b.for_space(&space, "device-B").expect("for_space");
        assert!(
            g.engine_mut()
                .read_block("01HZ00000000000000000000F6")
                .expect("read F")
                .is_some(),
            "delta must have added the sixth block"
        );
    }
    assert_eq!(
        registry_b.loro_vv(&space).expect("b vv post-delta"),
        registry_a.loro_vv(&space).expect("a vv"),
        "B must converge to A's vv after the incremental round-trip"
    );
}

/// `apply_remote` writes the projected `blocks` row to SQL.
/// SQL-level convergence end-to-end through the helper.
#[tokio::test]
async fn apply_remote_projects_changed_blocks_to_sql() {
    let (pool, _dir) = fresh_pool().await;

    // Build A and produce a Snapshot message.
    let registry_a = LoroEngineRegistry::new();
    let space = SpaceId::from_trusted(SPACE_A);
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        g.engine_mut()
            .apply_create_block(BLOCK_A, "content", "from-A", None, 7)
            .expect("create");
    }
    let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    // Apply on B (fresh registry, fresh DB).
    let registry_b = LoroEngineRegistry::new();
    let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
        .await
        .expect("apply_remote");
    assert!(
        matches!(outcome, ApplyOutcome::Imported { space_id: ref s, .. } if s == &space),
        "snapshot apply must report Imported, got {outcome:?}"
    );

    // SQL now has the projected `blocks` row.
    let row: (String, String, String, Option<String>, i64) = sqlx::query_as(
        "SELECT id, block_type, content, parent_id, position FROM blocks WHERE id = ?",
    )
    .bind(BLOCK_A)
    .fetch_one(&pool)
    .await
    .expect("fetch row");
    assert_eq!(row.0, BLOCK_A);
    assert_eq!(row.1, "content");
    assert_eq!(row.2, "from-A");
    assert_eq!(row.3, None);
    // #400: the engine maps the legacy sparse position 7 to a sibling slot
    // and the materializer reprojects the authoritative DENSE 1-based rank.
    // BLOCK_A is the sole root child, so its rank is 1.
    assert_eq!(row.4, 1);
}

/// Regression (end-to-end): an inbound sync that
/// re-projects an already-materialised block must NOT cascade-wipe
/// that block's tags / properties. The bug was `INSERT OR REPLACE`,
/// which deletes the `blocks` row first so the `ON DELETE CASCADE`
/// FKs delete `block_tags` / `block_properties`; the fix is an
/// upsert that updates only the core columns.
#[tokio::test]
async fn apply_remote_does_not_wipe_existing_block_derived_state() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    // Pre-seed B's SQL with the state a prior sync had materialised:
    // block X plus a tag-block, a tag edge, and a property row.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'old', NULL, 0)",
    )
    .bind(BLOCK_A)
    .execute(&pool)
    .await
    .unwrap();
    // Pre-seed a page block so BLOCK_A can carry a `page_id` — the
    // genuine F1 cascade witness. `page_id` is rebuilt by NO inbound
    // re-projection (not by the core upsert, the property pass, or the
    // Phase-2 deleted_at pass) and is in the `ON DELETE CASCADE`
    // set, so it survives a correct UPSERT but a REPLACE regression
    // (delete + re-insert the row) resets it to NULL.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'page', 'pg', NULL, 0)",
    )
    .bind(BLOCK_C)
    .execute(&pool)
    .await
    .unwrap();
    // `deleted_at` is now re-projected by the Phase-2 pass
    // (Pass C): A's engine carries BLOCK_A alive, so the pre-seeded
    // soft-delete must be cleared on inbound sync (the converged engine
    // state wins). Asserted below.
    //
    // `todo_state` is a reserved hot-path column the
    // reserved-key pass re-projects under authoritative-replace: A's
    // engine carries none for BLOCK_A, so the stale SQL-only value must
    // be NULLed (same authoritative-replace semantics as the `sql_only`
    // block_properties sweep below).
    sqlx::query(
        "UPDATE blocks SET deleted_at = 1777593600000, todo_state = 'DOING', \
             page_id = ? \
             WHERE id = ?",
    )
    .bind(BLOCK_C)
    .bind(BLOCK_A)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'tag-X', NULL, 0)",
    )
    .bind(BLOCK_B)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'effort', '3')",
    )
    .bind(BLOCK_A)
    .execute(&pool)
    .await
    .unwrap();
    // A second, SQL-only property that A's engine will NOT carry — under
    // the new authoritative-replace semantics it must be swept by the
    // inbound re-projection (proves the behavior isn't just "re-affirm").
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) \
             VALUES (?, 'sql_only', 'should-be-swept')",
    )
    .bind(BLOCK_A)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(BLOCK_A)
        .bind(BLOCK_B)
        .execute(&pool)
        .await
        .unwrap();

    // A edits X's content and sends a snapshot.  A's engine carries
    // the same `effort` property AND the same tag edge B already
    // materialised (both derived from the same CRDT) — so the inbound
    // Property/tag re-projections (re-affirm
    // those rows rather than sweeping them.  The point of this test is
    // that the *core* upsert does not cascade-wipe the block's derived
    // tags/properties.
    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "edited-by-A", None, 0)
            .expect("create");
        e.apply_create_block(BLOCK_B, "tag", "tag-X", None, 0)
            .expect("create tag block");
        e.apply_set_property(BLOCK_A, "effort", Some("3"))
            .expect("set effort");
        e.apply_add_tag(BLOCK_A, BLOCK_B).expect("add tag");
    }
    // #1257: `pool` here is the RECEIVER B's SQL (pre-seeded with a
    // soft-deleted BLOCK_A to exercise the inbound clear). The sender A
    // has no SQL of its own, so gate A's export against a fresh empty A
    // pool — otherwise the freshness gate would (correctly) see B's
    // soft-deleted-but-engine-live divergence and refuse.
    let (pool_a, _dir_a) = fresh_pool().await;
    let msg = prepare_outgoing_for_pool(&pool_a, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    // B applies the inbound snapshot.
    let registry_b = LoroEngineRegistry::new();
    let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
        .await
        .expect("apply_remote");
    assert!(
        matches!(outcome, ApplyOutcome::Imported { space_id: ref s, .. } if s == &space),
        "snapshot apply must report Imported, got {outcome:?}"
    );

    // Content updated from the inbound edit.
    let content: (String,) = sqlx::query_as("SELECT content FROM blocks WHERE id = ?")
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch content");
    assert_eq!(
        content.0, "edited-by-A",
        "content must update from the inbound edit"
    );

    // The genuine, un-masked F1 guard: `page_id` is rebuilt by NO
    // re-projection, so it must survive the core upsert. A REPLACE
    // regression would delete + re-insert the row, resetting it to NULL.
    //
    // `deleted_at`, by contrast, is now re-projected by the
    // Phase-2 pass (Pass C): A's engine carries BLOCK_A alive, so the
    // pre-seeded soft-delete must be cleared (the converged engine state
    // wins on inbound sync).
    //
    // `todo_state` is a reserved hot-path column the
    // reserved-key pass re-projects under authoritative-replace: A's
    // engine carries none for BLOCK_A, so the stale SQL-only value must be
    // NULLed (same authoritative-replace semantics as the `sql_only`
    // block_properties sweep below).
    let projected: (Option<String>, Option<String>, Option<String>) =
        sqlx::query_as("SELECT page_id, deleted_at, todo_state FROM blocks WHERE id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .expect("fetch projected columns");
    assert_eq!(
        projected,
        (Some(BLOCK_C.to_string()), None, None),
        "page_id must survive the inbound core upsert (F1); the pre-seeded \
             deleted_at is cleared by the Phase-2 deleted_at re-projection \
             (engine alive); the stale SQL-only todo_state is swept by the \
             reserved-key re-projection"
    );

    // block_tags is re-affirmed by the tag re-projection (the engine
    // carries this edge). NOTE: this no longer isolates the cascade-wipe
    // on its own — re-projection would re-insert it even after a REPLACE
    // cascade — which is why the `page_id` assertion above is the real F1
    // guard. This still verifies the tag re-projection path.
    let tag_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_tags WHERE block_id = ?")
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch tag count");
    assert_eq!(
        tag_count.0, 1,
        "block_tags must survive the inbound sync (F1)"
    );

    // Engine-backed property is re-affirmed; the SQL-only property
    // (absent from A's engine) is swept by the authoritative replace.
    let prop_keys: Vec<(String,)> =
        sqlx::query_as("SELECT key FROM block_properties WHERE block_id = ? ORDER BY key")
            .bind(BLOCK_A)
            .fetch_all(&pool)
            .await
            .expect("fetch prop keys");
    let keys: Vec<String> = prop_keys.into_iter().map(|r| r.0).collect();
    assert_eq!(
        keys,
        vec!["effort".to_string()],
        "engine-backed `effort` survives; SQL-only `sql_only` is swept by re-projection"
    );
}

/// #1071 happy path: `apply_remote` resolves the owning *page* id of every
/// changed block and surfaces a DEDUPED set on `ApplyOutcome::Imported`.
/// A page block and two of its content children, all touched by one
/// inbound snapshot, must collapse to the single page-root id (the page
/// resolves to itself; the children resolve up the `parent_id` chain).
#[tokio::test]
async fn apply_remote_imported_carries_deduped_changed_page_ids() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    // No `spaces` row needed: `project_block_full_to_sql` stamps
    // `blocks.space_id` via a `(SELECT id FROM spaces WHERE id = ?)`
    // subquery that resolves to NULL when the space block isn't
    // registered, and the #1071 page-id resolution walks `parent_id`
    // independent of `space_id`.

    // A builds a page (BLOCK_C) with two content children (A1, D4) and
    // syncs a full snapshot to B.
    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_C, "page", "the page", None, 0)
            .expect("create page");
        e.apply_create_block(BLOCK_A, "content", "child one", Some(BLOCK_C), 0)
            .expect("create child A1");
        e.apply_create_block(BLOCK_D, "content", "child two", Some(BLOCK_C), 1)
            .expect("create child D4");
    }
    let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    let registry_b = LoroEngineRegistry::new();
    let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
        .await
        .expect("apply_remote");

    let page_ids = match outcome {
        ApplyOutcome::Imported {
            changed_page_ids, ..
        } => changed_page_ids,
        other => panic!("expected Imported, got {other:?}"),
    };
    assert_eq!(
        page_ids,
        vec![BLOCK_C.to_string()],
        "the page and both its children must resolve to the single page-root id (deduped)"
    );
}

/// #1071 empty case: when an import changes no blocks, the resolved
/// page-id set is empty — the frontend then falls back to a full reload
/// rather than skipping a phantom update. Exercised directly through the
/// resolution helper (no changed blocks → empty), which is the exact
/// degenerate path `apply_remote` hits for a no-op import.
#[tokio::test]
async fn resolve_changed_page_ids_empty_when_no_blocks_changed() {
    let (pool, _dir) = fresh_pool().await;
    let page_ids = resolve_changed_page_ids(&pool, &[]).await.expect("resolve");
    assert!(
        page_ids.is_empty(),
        "no changed blocks must yield no page ids, got {page_ids:?}"
    );
}

/// #1071: an orphan changed block (no page ancestor in the `parent_id`
/// chain) contributes no page id — the resolution degrades to empty
/// rather than inventing a root, so the frontend falls back to a full
/// reload (the in-doubt-reload-everything contract).
#[tokio::test]
async fn resolve_changed_page_ids_skips_orphan_without_page_ancestor() {
    let (pool, _dir) = fresh_pool().await;
    // A content block whose parent chain never reaches a `page` row.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'orphan', NULL, 0)",
    )
    .bind(BLOCK_A)
    .execute(&pool)
    .await
    .unwrap();
    let page_ids = resolve_changed_page_ids(&pool, &[agaric_core::ulid::BlockId::from(BLOCK_A)])
        .await
        .expect("resolve");
    assert!(
        page_ids.is_empty(),
        "an orphan block resolves to no page id, got {page_ids:?}"
    );
}

/// R27: a merged (sync-composed) tree can legally exceed the depth-100
/// ancestor-CTE cap. The changed-page resolution must keep walking in
/// batches past the cap so a deep changed block still refreshes its
/// owning page on the frontend (pre-fix: the capped walk resolved no
/// page and the block's page was silently never invalidated).
#[tokio::test]
async fn resolve_changed_page_ids_resolves_deep_block_past_depth_cap() {
    let (pool, _dir) = fresh_pool().await;
    // Page root + a 120-deep content chain under it.
    let page = "01HZ00000000000000000DEEPPG";
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', 'pg', NULL, 0, ?)",
    )
    .bind(page)
    .bind(page)
    .execute(&pool)
    .await
    .unwrap();
    let mut parent = page.to_string();
    let mut leaf = String::new();
    for i in 0..120 {
        let id = format!("01HZDEEPCHAIN{i:04}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'content', '', ?, 0)",
        )
        .bind(&id)
        .bind(&parent)
        .execute(&pool)
        .await
        .unwrap();
        parent.clone_from(&id);
        leaf = id;
    }

    let page_ids =
        resolve_changed_page_ids(&pool, &[agaric_core::ulid::BlockId::from(leaf.as_str())])
            .await
            .expect("resolve");
    assert_eq!(
        page_ids,
        vec![page.to_string()],
        "a changed block 120 levels below its page must still resolve \
             the owning page (batched ancestor walk past the depth-100 cap)"
    );
}

/// R9: concurrent cross-peer "delete subtree" vs "move block INTO that
/// subtree" must NOT permanently diverge the two peers' SQL projections.
///
/// Device-1 soft-deletes subtree P (P + then-current child C get engine
/// tombstones — the local cascade + #2344 descendant fan-out); device-2,
/// which has not yet seen the delete, legally moves live block X under C.
/// After exchanging the two concurrent updates the CRDT converges on both
/// peers, and both peers' `blocks.deleted_at` for X must agree: X inherits
/// P's cohort tombstone (the mover peer computes this via the inbound
/// delete cascade; the deleter peer must reach the same state via the
/// live-under-tombstone sweep). Pre-fix the deleter peer kept X live as an
/// invisible orphan under tombstoned P while the mover peer trashed it.
#[tokio::test]
async fn concurrent_delete_vs_move_into_subtree_converges_deleted_at_on_both_peers() {
    let space = SpaceId::from_trusted(SPACE_A);
    let cohort_ts: i64 = 1_779_703_200_000;
    let ts_str = cohort_ts.to_string();

    // Device-1 (the DELETER) authors the shared tree: page P with child
    // C, and a SECOND page Q holding block X. (X must live under a
    // different parent than root so the later move's changed-set
    // resolution — children of the move's old/new parents — never pulls
    // P itself back into the reproject set on the deleter peer.)
    let (pool1, _dir1) = fresh_pool().await;
    let registry1 = LoroEngineRegistry::new();
    {
        let mut g = registry1.for_space(&space, "device-1").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "page", "P", None, 0)
            .expect("P");
        e.apply_create_block(BLOCK_B, "content", "C", Some(BLOCK_A), 0)
            .expect("C");
        e.apply_create_block(BLOCK_D, "page", "Q", None, 1)
            .expect("Q");
        e.apply_create_block(BLOCK_C, "content", "X", Some(BLOCK_D), 0)
            .expect("X");
    }

    // Converge device-2 (the MOVER) via a snapshot import (projects the
    // three blocks into pool2's SQL too).
    let (pool2, _dir2) = fresh_pool().await;
    let registry2 = LoroEngineRegistry::new();
    let seed_msg = prepare_outgoing_for_pool(&pool1, &registry1, &space, "device-1", None)
        .await
        .expect("prepare seed")
        .expect("freshness gate must not refuse");
    apply_remote(&pool2, &registry2, "device-2", seed_msg)
        .await
        .expect("seed device-2");

    // Mirror device-1's own materialized SQL state (its local commands
    // would have written these rows synchronously).
    for (id, block_type, parent) in [
        (BLOCK_A, "page", None),
        (BLOCK_B, "content", Some(BLOCK_A)),
        (BLOCK_D, "page", None),
        (BLOCK_C, "content", Some(BLOCK_D)),
    ] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
                 VALUES (?, ?, '', ?, 0, CASE WHEN ? = 'page' THEN ? ELSE NULL END)",
        )
        .bind(id)
        .bind(block_type)
        .bind(parent)
        .bind(block_type)
        .bind(id)
        .execute(&pool1)
        .await
        .unwrap();
    }

    // Both peers are converged; capture each side's vv for the later
    // concurrent exchange.
    let vv1 = registry1.loro_vv(&space).expect("vv1");
    let vv2 = registry2.loro_vv(&space).expect("vv2");

    // ── Concurrent divergence ─────────────────────────────────────────
    // Device-1: soft-delete P. Local cascade stamps P + C in SQL; the
    // engine gets tombstones for the seed AND the then-current
    // descendant C (#2344 fan-out). X is NOT a descendant here, so no
    // delete op for X exists anywhere.
    {
        let mut g = registry1.for_space(&space, "device-1").expect("for_space");
        let e = g.engine_mut();
        e.apply_delete_block(BLOCK_A, &ts_str).expect("delete P");
        e.apply_delete_block(BLOCK_B, &ts_str)
            .expect("delete C fanout");
    }
    {
        let mut conn = pool1.acquire().await.expect("acquire pool1");
        agaric_engine::loro::projection::project_delete_block_to_sql(&mut conn, BLOCK_A, cohort_ts)
            .await
            .expect("local delete cascade");
    }

    // Device-2 (has not seen the delete): legally move X under C.
    {
        let mut g = registry2.for_space(&space, "device-2").expect("for_space");
        g.engine_mut()
            .apply_move_block_to(BLOCK_C, Some(BLOCK_B), 0)
            .expect("move X under C");
    }
    sqlx::query("UPDATE blocks SET parent_id = ? WHERE id = ?")
        .bind(BLOCK_B)
        .bind(BLOCK_C)
        .execute(&pool2)
        .await
        .unwrap();

    // ── Exchange (prepared BEFORE either import — truly concurrent) ──
    let msg_1_to_2 = prepare_outgoing_for_pool(&pool1, &registry1, &space, "device-1", Some(&vv2))
        .await
        .expect("prepare 1→2")
        .expect("device-1 export must not be refused");
    let msg_2_to_1 = prepare_outgoing_for_pool(&pool2, &registry2, &space, "device-2", Some(&vv1))
        .await
        .expect("prepare 2→1")
        .expect("device-2 export must not be refused");

    apply_remote(&pool1, &registry1, "device-1", msg_2_to_1)
        .await
        .expect("device-1 imports the move");
    apply_remote(&pool2, &registry2, "device-2", msg_1_to_2)
        .await
        .expect("device-2 imports the delete");

    // ── Convergence: identical SQL deleted_at on both peers ──────────
    for id in [BLOCK_A, BLOCK_B, BLOCK_C] {
        let d1: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&pool1)
            .await
            .expect("pool1 deleted_at");
        let d2: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&pool2)
            .await
            .expect("pool2 deleted_at");
        assert_eq!(
            d1, d2,
            "block {id}: the two peers' SQL soft-delete state diverged \
                 after the concurrent delete-vs-move merge"
        );
        assert_eq!(
            d1,
            Some(cohort_ts),
            "block {id} must land in P's trash cohort on BOTH peers \
                 (move-into-deleted-subtree converges to 'deleted with the \
                 subtree')"
        );
    }

    // ── No #1257 freshness-gate wedge: the swept tombstone must also
    // reach each peer's ENGINE, so outbound export keeps working. ─────
    for (label, registry, device, pool) in [
        ("device-1", &registry1, "device-1", &pool1),
        ("device-2", &registry2, "device-2", &pool2),
    ] {
        {
            let mut g = registry.for_space(&space, device).expect("for_space");
            let engine_deleted = g
                .engine_mut()
                .read_deleted_at(BLOCK_C)
                .expect("read_deleted_at X");
            assert!(
                engine_deleted.is_some(),
                "{label}: X's cohort tombstone must be fanned out to the \
                     engine (engine-live + SQL-deleted would wedge the #1257 \
                     freshness gate)"
            );
        }
        let msg = prepare_outgoing_for_pool(pool, registry, &space, device, None)
            .await
            .expect("prepare post-merge");
        assert!(
            msg.is_some(),
            "{label}: outbound export must not be refused after the \
                 reconciled merge (#1257 gate must see engine and SQL agree)"
        );
    }
}

/// Phase 2: a remote `DeleteBlock` of a subtree seed
/// propagates the soft-delete to SQL for the seed AND its
/// descendants — even though the engine marks only the seed.
/// `apply_remote`'s deleted_at pass re-derives the SQL descendant
/// cascade from the seed timestamp.
#[tokio::test]
async fn apply_remote_cascades_remote_subtree_delete_to_sql() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    // A builds a 3-level subtree and soft-deletes the seed (the page)
    // with a real timestamp. The engine marks ONLY the seed.
    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "page", "pg", None, 0)
            .expect("page");
        e.apply_create_block(BLOCK_B, "content", "c1", Some(BLOCK_A), 0)
            .expect("c1");
        e.apply_create_block(BLOCK_C, "content", "c2", Some(BLOCK_B), 0)
            .expect("c2");
        e.apply_delete_block(BLOCK_A, "1779703200000")
            .expect("delete seed");
    }
    let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    let registry_b = LoroEngineRegistry::new();
    apply_remote(&pool, &registry_b, "device-B", msg)
        .await
        .expect("apply_remote");

    // Seed + both descendants are soft-deleted at the seed's timestamp.
    for id in [BLOCK_A, BLOCK_B, BLOCK_C] {
        let deleted_at: Option<i64> =
            sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("fetch deleted_at");
        assert_eq!(
            deleted_at,
            Some(1_779_703_200_000),
            "block {id} must be soft-deleted at the seed's cohort timestamp"
        );
    }
}

/// R27 end-to-end: a remote subtree delete over a merged tree DEEPER
/// than the depth-100 CTE cap must cascade to EVERY descendant on the
/// receiving peer (pre-fix the sub-cap tail stayed live under the
/// tombstoned ancestor — invisible orphans). The 120-deep chain stands
/// in for a sync-composed tree that no local command could create but
/// two peers can legally merge.
#[tokio::test]
async fn apply_remote_deep_subtree_delete_cascades_below_depth_cap() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "page", "pg", None, 0)
            .expect("page");
        let mut parent = BLOCK_A.to_string();
        for i in 0..120 {
            let id = format!("01HZDEEPSYNC{i:04}");
            e.apply_create_block(&id, "content", "", Some(parent.as_str()), 0)
                .expect("chain row");
            parent = id;
        }
        e.apply_delete_block(BLOCK_A, "1779703200000")
            .expect("delete seed");
    }
    let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    let registry_b = LoroEngineRegistry::new();
    apply_remote(&pool, &registry_b, "device-B", msg)
        .await
        .expect("apply_remote");

    let live: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE deleted_at IS NULL")
        .fetch_one(&pool)
        .await
        .expect("count live");
    assert_eq!(
        live, 0,
        "the inbound delete cascade must reach every block of the \
             121-block chain, including those below the depth-100 CTE cap"
    );
    let deleted: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE deleted_at = 1779703200000")
            .fetch_one(&pool)
            .await
            .expect("count cohort");
    assert_eq!(
        deleted, 121,
        "every block must carry the seed's cohort timestamp"
    );
}

/// Phase 2: a remote `RestoreBlock` of a subtree seed clears
/// the soft-delete in SQL for the whole cohort.
#[tokio::test]
async fn apply_remote_propagates_remote_subtree_restore_to_sql() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    // B has already materialised the subtree as soft-deleted at T (a
    // prior sync delivered the delete cascade).
    for (id, parent) in [
        (BLOCK_A, None),
        (BLOCK_B, Some(BLOCK_A)),
        (BLOCK_C, Some(BLOCK_B)),
    ] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
                 VALUES (?, 'content', '', ?, 0, 1779703200000)",
        )
        .bind(id)
        .bind(parent)
        .execute(&pool)
        .await
        .unwrap();
    }

    // A carries the same subtree ALIVE (it restored the seed); the
    // engine marks the seed alive.
    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "", None, 0)
            .expect("a");
        e.apply_create_block(BLOCK_B, "content", "", Some(BLOCK_A), 0)
            .expect("b");
        e.apply_create_block(BLOCK_C, "content", "", Some(BLOCK_B), 0)
            .expect("c");
    }
    // #1257: `pool` is the RECEIVER B's SQL (pre-seeded soft-deleted). A's
    // engine carries the subtree alive, so gate A's export against a fresh
    // empty A pool — passing B's stale pool would (correctly) trip the
    // freshness gate.
    let (pool_a, _dir_a) = fresh_pool().await;
    let msg = prepare_outgoing_for_pool(&pool_a, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    let registry_b = LoroEngineRegistry::new();
    apply_remote(&pool, &registry_b, "device-B", msg)
        .await
        .expect("apply_remote");

    for id in [BLOCK_A, BLOCK_B, BLOCK_C] {
        let deleted_at: Option<i64> =
            sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("fetch deleted_at");
        assert_eq!(
            deleted_at, None,
            "block {id} must be restored (deleted_at cleared) by the inbound restore"
        );
    }
}

/// Phase 2 centerpiece: re-importing a snapshot whose seed is
/// soft-deleted must NOT resurrect the already-soft-deleted
/// descendants. The engine marks only the seed, so a naive per-block
/// re-projection would read each descendant's `deleted_at` as `None`
/// and clear it; the ancestor guard in the deleted_at pass keeps a
/// descendant of a still-deleted ancestor soft-deleted.
#[tokio::test]
async fn apply_remote_reimport_does_not_resurrect_soft_deleted_subtree() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "page", "pg", None, 0)
            .expect("page");
        e.apply_create_block(BLOCK_B, "content", "c1", Some(BLOCK_A), 0)
            .expect("c1");
        e.apply_create_block(BLOCK_C, "content", "c2", Some(BLOCK_B), 0)
            .expect("c2");
        e.apply_delete_block(BLOCK_A, "1779703200000")
            .expect("delete seed");
    }

    let registry_b = LoroEngineRegistry::new();
    // #1257: `pool` is the RECEIVER B's SQL. After the first import it holds
    // the descendants soft-deleted, while A's engine still carries them
    // live (only the seed is tombstoned engine-side) — exactly the kind of
    // divergence the freshness gate refuses. But that divergence is B's,
    // not the sender A's: A's own SQL never had these rows. Gate A's export
    // against a fresh empty A pool so the (correct) gate doesn't fire on a
    // receiver-side state that is irrelevant to the sender.
    let (pool_a, _dir_a) = fresh_pool().await;
    // First import: cascades the soft-delete onto B's SQL (seed + descendants).
    let msg1 = prepare_outgoing_for_pool(&pool_a, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare 1")
        .expect("#1257 freshness gate must not refuse a consistent engine");
    apply_remote(&pool, &registry_b, "device-B", msg1)
        .await
        .expect("apply 1");

    // Second import of the SAME snapshot. The descendants are now
    // deleted in SQL but read back `None` from the (seed-only) engine —
    // the resurrection trap. The ancestor guard must keep them deleted.
    let msg2 = prepare_outgoing_for_pool(&pool_a, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare 2")
        .expect("#1257 freshness gate must not refuse a consistent engine");
    apply_remote(&pool, &registry_b, "device-B", msg2)
        .await
        .expect("apply 2");

    for id in [BLOCK_A, BLOCK_B, BLOCK_C] {
        let deleted_at: Option<i64> =
            sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("fetch deleted_at");
        assert_eq!(
            deleted_at,
            Some(1_779_703_200_000),
            "block {id} must stay soft-deleted after re-import (no resurrection)"
        );
    }
}

/// A Snapshot envelope with `protocol_version != 1` must be
/// rejected before any engine import — wire-format-version
/// invariant.
#[tokio::test]
async fn apply_remote_rejects_unsupported_protocol_version() {
    let (pool, _dir) = fresh_pool().await;
    let registry = LoroEngineRegistry::new();
    let space = SpaceId::from_trusted(SPACE_A);

    // Hand-craft a Snapshot with a bumped protocol_version. The
    // bytes payload doesn't matter — apply_remote MUST reject
    // before importing.
    let bad_snapshot = LoroSyncMessage::Snapshot {
        protocol_version: 99,
        space_id: space.clone(),
        bytes: vec![0xff, 0xff, 0xff],
    };
    let err = apply_remote(&pool, &registry, "device-B", bad_snapshot)
        .await
        .expect_err("must reject unsupported protocol_version");
    match err {
        AppError::Validation { message: msg, .. } => {
            assert!(
                msg.contains("99") && msg.contains("protocol version"),
                "error must mention the rejected version, got: {msg}"
            );
        }
        other => panic!("expected AppError::Validation, got {other:?}"),
    }

    // Same check for Update.
    let bad_update = LoroSyncMessage::Update {
        protocol_version: 99,
        space_id: space.clone(),
        from_vv: vec![],
        bytes: vec![0xff],
    };
    let err = apply_remote(&pool, &registry, "device-B", bad_update)
        .await
        .expect_err("must reject unsupported protocol_version (Update)");
    match err {
        AppError::Validation { message: msg, .. } => {
            assert!(
                msg.contains("99") && msg.contains("protocol version"),
                "error must mention the rejected version, got: {msg}"
            );
        }
        other => panic!("expected AppError::Validation, got {other:?}"),
    }
}

// -----------------------------------------------------------------
// #792 — own-peer (peer,counter) fork guard
// -----------------------------------------------------------------

/// #792 — an inbound Snapshot carrying OUR peer id at counters
/// beyond what our doc holds, while we already minted ops under
/// that id (the post-RESET fork a pre-epoch build created), must
/// short-circuit into `SnapshotFallbackRequested` WITHOUT touching
/// the engine, the inbox, or SQL. Importing it would corrupt
/// loro-internal's causal state (the issue's inbound SIGABRT — not
/// reproducible in-suite because the failure is a destructor panic
/// → process abort, which is exactly why the guard must fire first).
#[tokio::test]
async fn apply_remote_snapshot_into_forked_doc_requests_fallback_792() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    // The peer's copy of device-F's pre-reset history (3 blocks).
    let registry_pre = LoroEngineRegistry::new();
    {
        let mut g = registry_pre.for_space(&space, "device-F").expect("pre");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "pre 1", None, 0)
            .expect("a");
        e.apply_create_block(BLOCK_B, "content", "pre 2", None, 1)
            .expect("b");
        e.apply_create_block(BLOCK_C, "content", "pre 3", None, 2)
            .expect("c");
    }
    let msg = prepare_outgoing_for_pool(&pool, &registry_pre, &space, "device-F", None)
        .await
        .expect("peer-held history")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    // device-F after a pre-#792 RESET: fresh registry, SAME device
    // id (epoch 0 ⇒ same peer id), one re-minted block — the fork.
    let registry_forked = LoroEngineRegistry::new();
    {
        let mut g = registry_forked
            .for_space(&space, "device-F")
            .expect("forked");
        g.engine_mut()
            .apply_create_block(BLOCK_D, "content", "post reset", None, 0)
            .expect("post");
    }

    let outcome = apply_remote(&pool, &registry_forked, "device-F", msg)
        .await
        .expect("the guard returns a typed fallback, not an error");
    match outcome {
        ApplyOutcome::SnapshotFallbackRequested { space_id, reason } => {
            assert_eq!(space_id, space);
            assert!(
                reason.contains("#792") && reason.contains("fork"),
                "reason must be self-diagnosing, got: {reason}"
            );
        }
        ApplyOutcome::Imported { .. } => {
            panic!("a forked blob must NEVER be imported (#792)")
        }
    }

    // Side-effect-free: no engine import (BLOCK_A absent), no SQL
    // projection, and — critically — no write-ahead inbox slot that
    // boot replay would re-import into a crash loop.
    {
        let mut g = registry_forked
            .for_space(&space, "device-F")
            .expect("forked");
        assert!(g.engine_mut().read_block(BLOCK_A).unwrap().is_none());
    }
    let blocks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .expect("count blocks");
    assert_eq!(blocks, 0, "no SQL projection on a fork miss");
    let inbox: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(&pool)
        .await
        .expect("count inbox");
    assert_eq!(inbox, 0, "a forked blob must not be persisted for replay");
}

/// #792 control — the CLEAN post-reset shape: the locally reset doc
/// has NO own ops, so the peer's snapshot (which contains our
/// pre-reset ops) imports cleanly and projects to SQL. The guard
/// must not block the very resync that heals a reset.
#[tokio::test]
async fn apply_remote_snapshot_into_empty_post_reset_doc_imports_792() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    let registry_pre = LoroEngineRegistry::new();
    {
        let mut g = registry_pre.for_space(&space, "device-F").expect("pre");
        g.engine_mut()
            .apply_create_block(BLOCK_A, "content", "pre", None, 0)
            .expect("a");
    }
    let msg = prepare_outgoing_for_pool(&pool, &registry_pre, &space, "device-F", None)
        .await
        .expect("peer-held history")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    // Post-reset, zero local ops minted (the safe window).
    let registry_fresh = LoroEngineRegistry::new();
    let outcome = apply_remote(&pool, &registry_fresh, "device-F", msg)
        .await
        .expect("clean resync");
    assert!(
        matches!(outcome, ApplyOutcome::Imported { .. }),
        "an op-free post-reset doc must accept its own history back, got {outcome:?}"
    );
    let content: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("projected row");
    assert_eq!(content, "pre");
}

/// #792 — `replay_inbox_row` (boot recovery) must DROP a forked
/// write-ahead slot instead of importing it: a slot persisted by a
/// pre-#792 build would otherwise SIGABRT the app at every boot
/// (crash loop). The slot is deleted so the next session's
/// `apply_remote` guard can route into snapshot catch-up.
#[tokio::test]
async fn replay_inbox_row_drops_forked_slot_792() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    // Peer-held pre-reset history bytes.
    let registry_pre = LoroEngineRegistry::new();
    let history_bytes = {
        let mut g = registry_pre.for_space(&space, "device-F").expect("pre");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "pre 1", None, 0)
            .expect("a");
        e.apply_create_block(BLOCK_B, "content", "pre 2", None, 1)
            .expect("b");
        e.export_snapshot().expect("snap")
    };

    // A leftover inbox slot holding those bytes (as a pre-#792
    // build would have persisted before crashing mid-projection).
    let inbox_id: i64 = sqlx::query_scalar(
        "INSERT INTO loro_sync_inbox (space_id, bytes, created_at) \
             VALUES (?, ?, 0) RETURNING id",
    )
    .bind(space.as_str())
    .bind(&history_bytes)
    .fetch_one(&pool)
    .await
    .expect("seed slot");

    // The forked engine (same device id, re-minted op).
    let registry_forked = LoroEngineRegistry::new();
    {
        let mut g = registry_forked
            .for_space(&space, "device-F")
            .expect("forked");
        g.engine_mut()
            .apply_create_block(BLOCK_D, "content", "post reset", None, 0)
            .expect("post");
    }

    let (changed, _purged) = replay_inbox_row(
        &pool,
        &registry_forked,
        "device-F",
        space.as_str(),
        &history_bytes,
        inbox_id,
        &[],
    )
    .await
    .expect("replay must not error — it drops the slot and skips");
    assert!(changed.is_empty(), "nothing imported from a forked slot");

    // The slot is gone (no boot crash loop) and the engine untouched.
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(&pool)
        .await
        .expect("count inbox");
    assert_eq!(remaining, 0, "the forked slot must be deleted");
    {
        let mut g = registry_forked
            .for_space(&space, "device-F")
            .expect("forked");
        assert!(g.engine_mut().read_block(BLOCK_A).unwrap().is_none());
    }
}

// -----------------------------------------------------------------
// `from_vv` reachability check + snapshot-fallback
// -----------------------------------------------------------------

/// Happy-path: peer's `from_vv` is exactly our current
/// `oplog_vv()`.  Reachability passes; `apply_remote` performs the
/// engine import and returns `ApplyOutcome::Imported`.
///
/// Locks the wire-shape pin for normal flow — every
/// in-band incremental sync between two peers that have been
/// continuously paired hits this path.
#[tokio::test]
async fn apply_remote_update_with_reachable_from_vv_imports() {
    let (pool, _dir) = fresh_pool().await;

    // Build A with one block, capture B's vv (== A's vv before
    // the next op), then A adds a second block; A exports the
    // delta with `from_vv = b_vv`.
    let registry_a = LoroEngineRegistry::new();
    let space = SpaceId::from_trusted(SPACE_A);
    {
        let mut g = registry_a
            .for_space(&space, "device-A")
            .expect("for_space A");
        g.engine_mut()
            .apply_create_block(BLOCK_A, "content", "first", None, 0)
            .expect("create A");
    }
    // Mirror A's pre-second-op state into B so B's local vv
    // exactly matches the `from_vv` A will use.
    let registry_b = LoroEngineRegistry::new();
    let snap_msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare snapshot")
        .expect("#1257 freshness gate must not refuse a consistent engine");
    let snap_outcome = apply_remote(&pool, &registry_b, "device-B", snap_msg)
        .await
        .expect("apply snapshot");
    assert!(
        matches!(snap_outcome, ApplyOutcome::Imported { .. }),
        "seed snapshot must import cleanly, got {snap_outcome:?}"
    );

    let b_vv: Vec<u8> = {
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B");
        g.engine_mut().version_vector()
    };
    assert!(!b_vv.is_empty(), "B's vv must be non-empty after import");

    {
        let mut g = registry_a
            .for_space(&space, "device-A")
            .expect("for_space A2");
        g.engine_mut()
            .apply_create_block(BLOCK_B, "content", "second", None, 1)
            .expect("create B");
    }
    let update = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", Some(&b_vv))
        .await
        .expect("prepare update")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    let outcome = apply_remote(&pool, &registry_b, "device-B", update)
        .await
        .expect("apply update");
    match outcome {
        ApplyOutcome::Imported { space_id: s, .. } => assert_eq!(s, space),
        ApplyOutcome::SnapshotFallbackRequested { reason, .. } => {
            panic!("reachable from_vv must Imported, got SnapshotFallbackRequested: {reason}")
        }
    }

    // B's engine actually advanced — BLOCK_B is now visible.
    let mut g = registry_b
        .for_space(&space, "device-B")
        .expect("for_space B3");
    assert!(
        g.engine_mut()
            .read_block(BLOCK_B)
            .expect("read B")
            .is_some(),
        "BLOCK_B must be visible after a reachable Update is imported",
    );
}

/// Miss-path: peer's `from_vv` claims ops from a peer we have
/// never heard of (counter > 0 for an unknown peer).  Reachability
/// fails; `apply_remote` returns `SnapshotFallbackRequested`
/// **without** attempting the engine import.
///
/// Invariant. Pre-fix the engine raised an opaque Loro
/// decode error from `import_with_changed_blocks`; the new path
/// emits a typed fallback signal the orchestrator can route to
/// the snapshot catch-up sub-flow.
#[tokio::test]
async fn apply_remote_update_with_unreachable_from_vv_requests_fallback() {
    let (pool, _dir) = fresh_pool().await;

    // B starts fresh (vv is empty / contains only its own peer
    // at counter 0).  We then hand B an Update whose `from_vv`
    // claims a third peer's ops at a non-zero counter — B has
    // no entry for that peer, so the import would lose context.
    let registry_b = LoroEngineRegistry::new();
    let space = SpaceId::from_trusted(SPACE_A);

    // Construct a `from_vv` that includes a phantom peer with a
    // non-zero counter.  Use a real LoroEngine with a distinct
    // device_id to manufacture the encoded vv; this matches the
    // production wire shape (a postcard-encoded VersionVector).
    let phantom_vv_bytes: Vec<u8> = {
        let mut phantom = LoroEngine::with_peer_id("device-PHANTOM").expect("phantom engine");
        phantom
            .apply_create_block(BLOCK_C, "content", "phantom-op", None, 0)
            .expect("phantom op");
        phantom.version_vector()
    };

    // The `bytes` payload must be syntactically a valid Update
    // body so that, if the reachability check were ever
    // bypassed, the test would loudly fail on the import call
    // rather than coincidentally pass.  Use an Update produced by
    // the phantom engine itself against a known prior vv.
    let payload_bytes: Vec<u8> = {
        let phantom = LoroEngine::with_peer_id("device-PHANTOM").expect("phantom payload");
        let empty_vv = phantom.version_vector();
        // Produce a delta from the *initial* empty vv — even if
        // this is somehow imported, it does not contain the ops
        // referenced by `phantom_vv_bytes`, so the assertion
        // below ("BLOCK_C not present on B") still pins the
        // "import NOT attempted" invariant.
        phantom
            .export_update_since(&empty_vv)
            .unwrap_or_else(|_| vec![0u8])
    };

    let unreachable_update = LoroSyncMessage::Update {
        protocol_version: LORO_SYNC_PROTOCOL_VERSION,
        space_id: space.clone(),
        from_vv: phantom_vv_bytes,
        bytes: payload_bytes,
    };

    let outcome = apply_remote(&pool, &registry_b, "device-B", unreachable_update)
            .await
            .expect("apply_remote must NOT error on unreachable from_vv — it must return the typed fallback variant");

    match outcome {
        ApplyOutcome::SnapshotFallbackRequested {
            space_id: returned_space,
            reason,
        } => {
            assert_eq!(returned_space, space);
            assert!(
                reason.contains("from_vv") || reason.contains("oplog_vv"),
                "reason should mention the vv mismatch context, got: {reason}"
            );
        }
        ApplyOutcome::Imported { .. } => {
            panic!("unreachable from_vv MUST NOT report Imported")
        }
    }

    // Side-effect-free guarantee: the import was NOT attempted.
    // B's engine has no entry for BLOCK_C (the phantom's op).
    let mut g = registry_b
        .for_space(&space, "device-B")
        .expect("for_space B");
    assert!(
        g.engine_mut()
            .read_block(BLOCK_C)
            .expect("read C")
            .is_none(),
        "BLOCK_C must NOT be present on B — the engine import must be skipped on a fallback miss",
    );

    // Same guarantee at the SQL layer.
    let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
        .bind(BLOCK_C)
        .fetch_one(&pool)
        .await
        .expect("count rows");
    assert_eq!(
        row_count, 0,
        "no blocks must be projected to SQL when fallback is requested",
    );
}

/// Miss-path corner: peer has us **behind** on a peer we DO
/// share — same peer_id in both vvs, peer's counter is strictly
/// greater than ours.  Reachability must reject.
#[tokio::test]
async fn apply_remote_update_with_behind_counter_requests_fallback() {
    let (pool, _dir) = fresh_pool().await;

    // A and B share device-A as a peer, but A is 2 ops ahead.
    // B receives an Update whose `from_vv` echoes A's full vv —
    // since B's vv has device-A at counter 0 (B has no ops from
    // A), the reachability check must fail.
    let registry_a = LoroEngineRegistry::new();
    let registry_b = LoroEngineRegistry::new();
    let space = SpaceId::from_trusted(SPACE_A);

    {
        let mut g = registry_a
            .for_space(&space, "device-A")
            .expect("for_space A");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "a1", None, 0)
            .expect("a1");
        e.apply_create_block(BLOCK_B, "content", "a2", None, 1)
            .expect("a2");
    }
    let a_vv: Vec<u8> = {
        let mut g = registry_a
            .for_space(&space, "device-A")
            .expect("for_space A2");
        g.engine_mut().version_vector()
    };
    // A produces a third op then an Update whose from_vv == its
    // *pre-third-op* vv (which B does not have).
    {
        let mut g = registry_a
            .for_space(&space, "device-A")
            .expect("for_space A3");
        g.engine_mut()
            .apply_create_block(BLOCK_D, "content", "a3", None, 2)
            .expect("a3");
    }
    let update = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", Some(&a_vv))
        .await
        .expect("prepare update")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    let outcome = apply_remote(&pool, &registry_b, "device-B", update)
        .await
        .expect("apply_remote must return fallback variant cleanly");

    assert!(
        matches!(outcome, ApplyOutcome::SnapshotFallbackRequested { .. }),
        "behind-on-shared-peer from_vv must yield SnapshotFallbackRequested, got {outcome:?}",
    );

    // Engine import was skipped — none of A's blocks landed.
    let mut g = registry_b
        .for_space(&space, "device-B")
        .expect("for_space B");
    let e = g.engine_mut();
    for blk in [BLOCK_A, BLOCK_B, BLOCK_D] {
        assert!(
            e.read_block(blk).expect("read").is_none(),
            "{blk} must NOT be present after a fallback miss",
        );
    }
}

/// Unit-test the reachability classifier in isolation against
/// hand-built version vectors — three cases:
///  - exact match  → reachable
///  - local ahead  → reachable
///  - local behind → unreachable (with diagnostic)
///  - peer mentions an unknown peer at counter==0 → reachable
///    (no-op entries do not gate reachability)
#[tokio::test]
async fn classify_from_vv_reachability_cases() {
    // Build two engines + extract their encoded vvs at known
    // states.  Using real engines avoids hand-rolling postcard.
    let mut e_local = LoroEngine::with_peer_id("device-L").expect("L");
    let mut e_peer = LoroEngine::with_peer_id("device-L").expect("peer-L"); // same peer_id

    // Local: 2 ops.  Peer (echo): 2 ops too → exact match.
    for (eng, prefix) in [(&mut e_local, "l"), (&mut e_peer, "p")] {
        eng.apply_create_block(BLOCK_A, "content", &format!("{prefix}1"), None, 0)
            .expect("op1");
        eng.apply_create_block(BLOCK_B, "content", &format!("{prefix}2"), None, 1)
            .expect("op2");
    }
    let local_vv = e_local.version_vector();
    let peer_vv_eq = e_peer.version_vector();
    assert!(
        classify_from_vv_reachability(&local_vv, &peer_vv_eq)
            .expect("decode")
            .is_none(),
        "exact match must be reachable",
    );

    // Local ahead: local has 3 ops, peer still at 2.
    e_local
        .apply_create_block(BLOCK_C, "content", "l3", None, 2)
        .expect("l3");
    let local_vv_ahead = e_local.version_vector();
    assert!(
        classify_from_vv_reachability(&local_vv_ahead, &peer_vv_eq)
            .expect("decode")
            .is_none(),
        "local ahead must be reachable (we have everything peer claims)",
    );

    // Local behind: peer has 4 ops, local still at 3.
    e_peer
        .apply_create_block(BLOCK_C, "content", "p3", None, 2)
        .expect("p3");
    e_peer
        .apply_create_block(BLOCK_D, "content", "p4", None, 3)
        .expect("p4");
    let peer_vv_ahead = e_peer.version_vector();
    let miss = classify_from_vv_reachability(&local_vv_ahead, &peer_vv_ahead)
        .expect("decode")
        .expect("local-behind must be unreachable");
    assert!(
        miss.contains("counter") || miss.contains("peer"),
        "diagnostic should mention peer/counter, got: {miss}",
    );
}

// -----------------------------------------------------------------
// #1054 — boot-replay reachability gate (mirrors the live
// gate in the inbox replay path).
// -----------------------------------------------------------------

/// #1054 — a leftover write-ahead inbox slot holding an *Update*-shaped
/// blob whose causal base (`partial_start_vv`) is UNREACHABLE from the
/// rehydrated-then-op-log-replayed engine must be DROPPED at boot
/// replay — not imported. Pre-fix it was imported unconditionally,
/// surfacing an opaque Loro decode error and re-erroring at every boot
/// (a permanent poison row, since op-log replay never advances the
/// engine past the remote gap). The fix mirrors the live gate: drop the
/// slot and let the next live sync re-detect the gap and snapshot
/// catch-up.
#[tokio::test]
async fn replay_inbox_row_drops_unreachable_update_slot_1054() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    // Producer A: 2 ops → capture vv → a 3rd op. The update exported
    // since the post-2-ops vv has a non-trivial `partial_start_vv`
    // (peer A at counter 2) — the causal base a fresh replaying engine
    // does NOT hold.
    let registry_a = LoroEngineRegistry::new();
    let base_vv = {
        let mut g = registry_a
            .for_space(&space, "device-A")
            .expect("for_space A");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "a1", None, 0)
            .expect("a1");
        e.apply_create_block(BLOCK_B, "content", "a2", None, 1)
            .expect("a2");
        let vv = e.version_vector();
        e.apply_create_block(BLOCK_C, "content", "a3", None, 2)
            .expect("a3");
        vv
    };
    let update_bytes: Vec<u8> = {
        let mut g = registry_a
            .for_space(&space, "device-A")
            .expect("for_space A2");
        g.engine_mut().export_update_since(&base_vv).expect("delta")
    };

    // A leftover inbox slot holding that update (as a crash mid-projection
    // would have left behind).
    let inbox_id: i64 = sqlx::query_scalar(
        "INSERT INTO loro_sync_inbox (space_id, bytes, created_at) \
             VALUES (?, ?, 0) RETURNING id",
    )
    .bind(space.as_str())
    .bind(&update_bytes)
    .fetch_one(&pool)
    .await
    .expect("seed slot");

    // A FRESH replaying engine (device-B) that has never seen A's ops:
    // its oplog_vv has no entry for peer A, so the update's base is
    // unreachable.
    let registry_b = LoroEngineRegistry::new();
    let (changed, _purged) = replay_inbox_row(
        &pool,
        &registry_b,
        "device-B",
        space.as_str(),
        &update_bytes,
        inbox_id,
        &[],
    )
    .await
    .expect("replay must not error — it drops the slot and skips");
    assert!(
        changed.is_empty(),
        "nothing imported from an unreachable update slot"
    );

    // The slot is gone (no permanent poison row, no boot re-error).
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(&pool)
        .await
        .expect("count inbox");
    assert_eq!(remaining, 0, "the unreachable update slot must be deleted");

    // Engine state is NOT corrupted: the unreachable ops never landed.
    {
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B");
        let e = g.engine_mut();
        for blk in [BLOCK_A, BLOCK_B, BLOCK_C] {
            assert!(
                e.read_block(blk).expect("read").is_none(),
                "{blk} must NOT be present — the unreachable update was not imported"
            );
        }
    }

    // No SQL projection either.
    let blocks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .expect("count blocks");
    assert_eq!(blocks, 0, "no SQL projection on a dropped slot");
}

/// #1054 control — a leftover Update slot whose base IS reachable from
/// the replaying engine must still replay normally (import + project +
/// clear the slot). The gate must not block a legitimately-applicable
/// boot replay.
#[tokio::test]
async fn replay_inbox_row_replays_reachable_update_slot_1054() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    // Producer A: 2 ops → capture vv → a 3rd op; export the delta since
    // the post-2-ops vv (base = peer A @ counter 2).
    let registry_a = LoroEngineRegistry::new();
    let (seed_bytes, base_vv) = {
        let mut g = registry_a
            .for_space(&space, "device-A")
            .expect("for_space A");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "a1", None, 0)
            .expect("a1");
        e.apply_create_block(BLOCK_B, "content", "a2", None, 1)
            .expect("a2");
        let vv = e.version_vector();
        let seed = e.export_snapshot().expect("seed snapshot");
        e.apply_create_block(BLOCK_C, "content", "a3", None, 2)
            .expect("a3");
        (seed, vv)
    };
    let update_bytes: Vec<u8> = {
        let mut g = registry_a
            .for_space(&space, "device-A")
            .expect("for_space A2");
        g.engine_mut().export_update_since(&base_vv).expect("delta")
    };

    // The replaying engine (device-B) already holds A's first 2 ops —
    // so the update's base IS reachable.
    let registry_b = LoroEngineRegistry::new();
    {
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B");
        g.engine_mut().import(&seed_bytes).expect("seed import");
    }

    let inbox_id: i64 = sqlx::query_scalar(
        "INSERT INTO loro_sync_inbox (space_id, bytes, created_at) \
             VALUES (?, ?, 0) RETURNING id",
    )
    .bind(space.as_str())
    .bind(&update_bytes)
    .fetch_one(&pool)
    .await
    .expect("seed slot");

    let (changed, _purged) = replay_inbox_row(
        &pool,
        &registry_b,
        "device-B",
        space.as_str(),
        &update_bytes,
        inbox_id,
        &[],
    )
    .await
    .expect("reachable update must replay cleanly");
    assert!(
        !changed.is_empty(),
        "a reachable update must import its changed block(s)"
    );

    // The slot is cleared (in-tx with the projection).
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(&pool)
        .await
        .expect("count inbox");
    assert_eq!(remaining, 0, "a successfully-replayed slot is cleared");

    // The update's new block (BLOCK_C) landed in the engine and SQL.
    {
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B2");
        assert!(
            g.engine_mut().read_block(BLOCK_C).expect("read").is_some(),
            "BLOCK_C from the reachable update must be imported"
        );
    }
    let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
        .bind(BLOCK_C)
        .fetch_one(&pool)
        .await
        .expect("count rows");
    assert_eq!(row_count, 1, "BLOCK_C must be projected to SQL");
}

/// #1054 — a Snapshot-shaped slot is self-contained and must always
/// replay unconditionally, even against a fresh engine. The gate only
/// applies to Update-shaped blobs (mirrors the live gate, which only
/// checks `LoroSyncMessage::Update`).
#[tokio::test]
async fn replay_inbox_row_replays_snapshot_slot_1054() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    // Producer A's full snapshot (carries its own causal base).
    let registry_a = LoroEngineRegistry::new();
    let snapshot_bytes: Vec<u8> = {
        let mut g = registry_a
            .for_space(&space, "device-A")
            .expect("for_space A");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "a1", None, 0)
            .expect("a1");
        e.apply_create_block(BLOCK_B, "content", "a2", None, 1)
            .expect("a2");
        e.export_snapshot().expect("snapshot")
    };

    let inbox_id: i64 = sqlx::query_scalar(
        "INSERT INTO loro_sync_inbox (space_id, bytes, created_at) \
             VALUES (?, ?, 0) RETURNING id",
    )
    .bind(space.as_str())
    .bind(&snapshot_bytes)
    .fetch_one(&pool)
    .await
    .expect("seed slot");

    // A FRESH replaying engine — a snapshot must import regardless.
    let registry_b = LoroEngineRegistry::new();
    let (changed, _purged) = replay_inbox_row(
        &pool,
        &registry_b,
        "device-B",
        space.as_str(),
        &snapshot_bytes,
        inbox_id,
        &[],
    )
    .await
    .expect("a snapshot slot must replay unconditionally");
    assert!(!changed.is_empty(), "the snapshot must import its blocks");

    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(&pool)
        .await
        .expect("count inbox");
    assert_eq!(remaining, 0, "the snapshot slot is cleared on success");

    {
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B");
        let e = g.engine_mut();
        for blk in [BLOCK_A, BLOCK_B] {
            assert!(
                e.read_block(blk).expect("read").is_some(),
                "{blk} from the snapshot must be imported"
            );
        }
    }
}

// -----------------------------------------------------------------
// Inbound property re-projection (end-to-end).
// -----------------------------------------------------------------

/// Seed the `property_definitions` rows the re-projection consults to
/// recover SQL types for the typed-column assertions below.
async fn seed_property_defs(pool: &SqlitePool) {
    // `INSERT OR REPLACE` so these test-chosen types win over any
    // builtin seed (e.g. migration 0014 seeds `effort` as `select`).
    for (key, value_type) in [
        ("note", "text"),
        ("effort", "number"),
        ("done", "boolean"),
        ("due", "date"),
    ] {
        sqlx::query(
            "INSERT OR REPLACE INTO property_definitions (key, value_type, created_at) \
                 VALUES (?, ?, '2026-01-01T00:00:00Z')",
        )
        .bind(key)
        .bind(value_type)
        .execute(pool)
        .await
        .unwrap();
    }
}

/// A remote engine sets several typed properties on a block; after
/// `apply_remote`, each `block_properties` row carries the correct
/// typed column (text/number/boolean/date), recovered from
/// `property_definitions`.
#[tokio::test]
async fn apply_remote_reprojects_typed_properties_to_sql() {
    let (pool, _dir) = fresh_pool().await;
    seed_property_defs(&pool).await;
    let space = SpaceId::from_trusted(SPACE_A);

    // Build A: create a block and set typed properties (string form,
    // mirroring the engine's single-string storage).
    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "from-A", None, 0)
            .expect("create");
        e.apply_set_property(BLOCK_A, "note", Some("hello"))
            .expect("set note");
        e.apply_set_property(BLOCK_A, "effort", Some("2.5"))
            .expect("set effort");
        e.apply_set_property(BLOCK_A, "done", Some("true"))
            .expect("set done");
        e.apply_set_property(BLOCK_A, "due", Some("2026-01-01"))
            .expect("set due");
    }
    let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    // Apply on B.
    let registry_b = LoroEngineRegistry::new();
    let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
        .await
        .expect("apply_remote");
    assert!(
        matches!(outcome, ApplyOutcome::Imported { space_id: ref s, .. } if s == &space),
        "snapshot apply must report Imported, got {outcome:?}"
    );

    // Each property landed in the right typed column.
    let note: (Option<String>, Option<f64>, Option<i64>) = sqlx::query_as(
        "SELECT value_text, value_num, value_bool FROM block_properties \
             WHERE block_id = ? AND key = 'note'",
    )
    .bind(BLOCK_A)
    .fetch_one(&pool)
    .await
    .expect("fetch note");
    assert_eq!(note, (Some("hello".into()), None, None));

    let effort: (Option<f64>, Option<String>) = sqlx::query_as(
        "SELECT value_num, value_text FROM block_properties \
             WHERE block_id = ? AND key = 'effort'",
    )
    .bind(BLOCK_A)
    .fetch_one(&pool)
    .await
    .expect("fetch effort");
    assert_eq!(effort, (Some(2.5), None));

    let done: (Option<i64>, Option<String>) = sqlx::query_as(
        "SELECT value_bool, value_text FROM block_properties \
             WHERE block_id = ? AND key = 'done'",
    )
    .bind(BLOCK_A)
    .fetch_one(&pool)
    .await
    .expect("fetch done");
    assert_eq!(done, (Some(1), None));

    let due: (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT value_date, value_text FROM block_properties \
             WHERE block_id = ? AND key = 'due'",
    )
    .bind(BLOCK_A)
    .fetch_one(&pool)
    .await
    .expect("fetch due");
    assert_eq!(due, (Some("2026-01-01".into()), None));
}

/// A property present after a first sync, then removed on the remote
/// (engine `apply_delete_property`), must have its `block_properties`
/// row gone after a second `apply_remote`.  Pins remote-delete
/// propagation via the authoritative-replace DELETE.
#[tokio::test]
async fn apply_remote_reproject_removes_deleted_property_on_resync() {
    let (pool, _dir) = fresh_pool().await;
    seed_property_defs(&pool).await;
    let space = SpaceId::from_trusted(SPACE_A);

    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "from-A", None, 0)
            .expect("create");
        e.apply_set_property(BLOCK_A, "note", Some("hello"))
            .expect("set note");
    }
    let registry_b = LoroEngineRegistry::new();

    // First sync: B materialises the `note` property.
    let msg1 = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare 1")
        .expect("#1257 freshness gate must not refuse a consistent engine");
    apply_remote(&pool, &registry_b, "device-B", msg1)
        .await
        .expect("apply 1");
    let count_before: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'note'",
    )
    .bind(BLOCK_A)
    .fetch_one(&pool)
    .await
    .expect("count before");
    assert_eq!(count_before, 1, "note must be present after first sync");

    // A deletes the property, then re-syncs (incremental update).
    let b_vv: Vec<u8> = {
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B");
        g.engine_mut().version_vector()
    };
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        g.engine_mut()
            .apply_delete_property(BLOCK_A, "note")
            .expect("delete note");
    }
    let msg2 = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", Some(&b_vv))
        .await
        .expect("prepare 2")
        .expect("#1257 freshness gate must not refuse a consistent engine");
    apply_remote(&pool, &registry_b, "device-B", msg2)
        .await
        .expect("apply 2");

    let count_after: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'note'",
    )
    .bind(BLOCK_A)
    .fetch_one(&pool)
    .await
    .expect("count after");
    assert_eq!(
        count_after, 0,
        "note row must be gone after the remote deletes it and re-syncs"
    );
}

// -----------------------------------------------------------------
// Inbound tag re-projection (end-to-end).
// -----------------------------------------------------------------

/// A remote engine creates a tag block and tags a content block;
/// after `apply_remote`, the `block_tags` edge exists in SQL (and
/// the FK to the tag block is satisfied because Pass A upserts the
/// tag block before Pass B inserts the edge).
#[tokio::test]
async fn apply_remote_reprojects_added_tag_to_sql() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    // BLOCK_A = content block, BLOCK_B = tag block, edge A→B.
    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "tagged", None, 0)
            .expect("create content");
        e.apply_create_block(BLOCK_B, "tag", "tag-X", None, 1)
            .expect("create tag block");
        e.apply_add_tag(BLOCK_A, BLOCK_B).expect("add tag");
    }
    let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    let registry_b = LoroEngineRegistry::new();
    let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
        .await
        .expect("apply_remote");
    assert!(
        matches!(outcome, ApplyOutcome::Imported { space_id: ref s, .. } if s == &space),
        "snapshot apply must report Imported, got {outcome:?}"
    );

    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(BLOCK_A)
            .bind(BLOCK_B)
            .fetch_one(&pool)
            .await
            .expect("count edge");
    assert_eq!(count, 1, "tag edge must be projected after apply_remote");
}

/// A tag present after a first sync, then removed on the remote
/// (engine `apply_remove_tag`), must have its `block_tags` row gone
/// after a second `apply_remote`.  Pins remote-removal propagation
/// via the authoritative-replace DELETE in the tag re-projection.
#[tokio::test]
async fn apply_remote_reproject_removes_tag_on_resync() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "tagged", None, 0)
            .expect("create content");
        e.apply_create_block(BLOCK_B, "tag", "tag-X", None, 1)
            .expect("create tag block");
        e.apply_add_tag(BLOCK_A, BLOCK_B).expect("add tag");
    }
    let registry_b = LoroEngineRegistry::new();

    // First sync: B materialises the edge.
    let msg1 = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare 1")
        .expect("#1257 freshness gate must not refuse a consistent engine");
    apply_remote(&pool, &registry_b, "device-B", msg1)
        .await
        .expect("apply 1");
    let before: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(BLOCK_A)
            .bind(BLOCK_B)
            .fetch_one(&pool)
            .await
            .expect("count before");
    assert_eq!(before, 1, "edge must exist after first sync");

    // A removes the tag, then re-syncs (incremental update).
    let b_vv: Vec<u8> = {
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B");
        g.engine_mut().version_vector()
    };
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        g.engine_mut()
            .apply_remove_tag(BLOCK_A, BLOCK_B)
            .expect("remove tag");
    }
    let msg2 = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", Some(&b_vv))
        .await
        .expect("prepare 2")
        .expect("#1257 freshness gate must not refuse a consistent engine");
    apply_remote(&pool, &registry_b, "device-B", msg2)
        .await
        .expect("apply 2");

    let after: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(BLOCK_A)
            .bind(BLOCK_B)
            .fetch_one(&pool)
            .await
            .expect("count after");
    assert_eq!(
        after, 0,
        "tag edge must be gone after the remote removes it and re-syncs"
    );
}

/// Inheritance: a parent block tagged on the sender, with a child
/// block.  After `apply_remote`, `block_tag_inherited` must carry the
/// child's inherited row — proving the post-commit `rebuild_all` ran
/// off the freshly re-projected `block_tags`.
#[tokio::test]
async fn apply_remote_rebuilds_inherited_tags_for_child() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    // BLOCK_A = tagged parent, BLOCK_C = child of A, BLOCK_B = tag block.
    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "parent", None, 0)
            .expect("create parent");
        e.apply_create_block(BLOCK_C, "content", "child", Some(BLOCK_A), 0)
            .expect("create child");
        e.apply_create_block(BLOCK_B, "tag", "tag-X", None, 1)
            .expect("create tag block");
        e.apply_add_tag(BLOCK_A, BLOCK_B).expect("tag parent");
    }
    let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    let registry_b = LoroEngineRegistry::new();
    let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
        .await
        .expect("apply_remote");
    assert!(
        matches!(outcome, ApplyOutcome::Imported { space_id: ref s, .. } if s == &space),
        "snapshot apply must report Imported, got {outcome:?}"
    );

    // Direct edge on the parent.
    let direct: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(BLOCK_A)
            .bind(BLOCK_B)
            .fetch_one(&pool)
            .await
            .expect("count direct");
    assert_eq!(direct, 1, "parent's direct tag edge must be projected");

    // Inherited row on the child — proves rebuild_all ran.
    let inherited: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM block_tag_inherited \
             WHERE block_id = ? AND tag_id = ? AND inherited_from = ?",
    )
    .bind(BLOCK_C)
    .bind(BLOCK_B)
    .bind(BLOCK_A)
    .fetch_one(&pool)
    .await
    .expect("count inherited");
    assert_eq!(
        inherited.0, 1,
        "child must inherit the parent's tag after apply_remote (rebuild_all ran)"
    );
}

/// #2036 stage 3 divergence guard: after a sequence of INCREMENTAL updates
/// applied through the scoped per-subtree recompute path (tag-add, then a
/// structural move that drops an inherited tag), `block_tag_inherited` must
/// be byte-identical to a from-scratch global `rebuild_all`.
#[tokio::test]
async fn incremental_tag_inheritance_matches_global_rebuild() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    // A: parent BLOCK_A with children BLOCK_C, BLOCK_D; BLOCK_B is the tag.
    let reg_a = LoroEngineRegistry::new();
    {
        let mut g = reg_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "parent", None, 0)
            .unwrap();
        e.apply_create_block(BLOCK_C, "content", "c1", Some(BLOCK_A), 0)
            .unwrap();
        e.apply_create_block(BLOCK_D, "content", "c2", Some(BLOCK_A), 1)
            .unwrap();
        e.apply_create_block(BLOCK_B, "tag", "tag-X", None, 1)
            .unwrap();
    }

    // Initial snapshot sync A -> B.
    let reg_b = LoroEngineRegistry::new();
    let msg = prepare_outgoing_for_pool(&pool, &reg_a, &space, "device-A", None)
        .await
        .unwrap()
        .unwrap();
    apply_remote(&pool, &reg_b, "device-B", msg).await.unwrap();

    let b_vv = |reg_b: &LoroEngineRegistry| {
        let mut g = reg_b.for_space(&space, "device-B").unwrap();
        g.engine_mut().version_vector()
    };

    // Update 1: tag the parent — BLOCK_C and BLOCK_D inherit it.
    {
        let mut g = reg_a.for_space(&space, "device-A").unwrap();
        g.engine_mut().apply_add_tag(BLOCK_A, BLOCK_B).unwrap();
    }
    let vv = b_vv(&reg_b);
    let msg = prepare_outgoing_for_pool(&pool, &reg_a, &space, "device-A", Some(&vv))
        .await
        .unwrap()
        .unwrap();
    apply_remote(&pool, &reg_b, "device-B", msg).await.unwrap();

    // Update 2: move BLOCK_D out to root — it must LOSE the inherited tag.
    {
        let mut g = reg_a.for_space(&space, "device-A").unwrap();
        g.engine_mut().apply_move_block(BLOCK_D, None, 2).unwrap();
    }
    let vv = b_vv(&reg_b);
    let msg = prepare_outgoing_for_pool(&pool, &reg_a, &space, "device-A", Some(&vv))
        .await
        .unwrap()
        .unwrap();
    apply_remote(&pool, &reg_b, "device-B", msg).await.unwrap();

    // Scoped-incremental result.
    let scoped: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT block_id, tag_id, inherited_from FROM block_tag_inherited ORDER BY 1, 2, 3",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    // Force a global rebuild and re-read.
    agaric_store::tag_inheritance::rebuild_all(&pool)
        .await
        .unwrap();
    let global: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT block_id, tag_id, inherited_from FROM block_tag_inherited ORDER BY 1, 2, 3",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(
        scoped, global,
        "scoped incremental inheritance diverged from global rebuild",
    );
    assert!(
        scoped.iter().any(|(b, t, f)| b.as_str() == BLOCK_C
            && t.as_str() == BLOCK_B
            && f.as_str() == BLOCK_A),
        "BLOCK_C must still inherit the parent's tag, got {scoped:?}",
    );
    assert!(
        !scoped.iter().any(|(b, _, _)| b.as_str() == BLOCK_D),
        "moved BLOCK_D must not inherit any tag, got {scoped:?}",
    );
}

// -----------------------------------------------------------------
// #535 — write-ahead inbox durability + boot replay.
// -----------------------------------------------------------------

/// Happy path: a normal `apply_remote` inserts an inbox slot then deletes
/// it in the projection tx, so the table is EMPTY after success.
#[tokio::test]
async fn apply_remote_leaves_inbox_empty_on_success() {
    let (pool, _dir) = fresh_pool().await;

    let registry_a = LoroEngineRegistry::new();
    let space = SpaceId::from_trusted(SPACE_A);
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        g.engine_mut()
            .apply_create_block(BLOCK_A, "content", "from-A", None, 0)
            .expect("create");
    }
    let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    let registry_b = LoroEngineRegistry::new();
    apply_remote(&pool, &registry_b, "device-B", msg)
        .await
        .expect("apply_remote");

    let inbox_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(&pool)
        .await
        .expect("count inbox");
    assert_eq!(
        inbox_rows, 0,
        "inbox slot must be cleared atomically with the projection on success"
    );
}

/// Crash recovery: simulate the data-loss window — an inbox row whose
/// projection never committed — then replay it and assert (a) the block
/// is now projected into SQL and (b) the inbox row is gone.
#[tokio::test]
async fn replay_sync_inbox_projects_leftover_slot_and_clears_it() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    // Produce valid snapshot bytes from an engine that has a block.
    let snapshot_bytes: Vec<u8> = {
        let mut e = LoroEngine::with_peer_id("device-A").expect("engine");
        e.apply_create_block(BLOCK_A, "content", "from-A", None, 0)
            .expect("create");
        e.export_snapshot().expect("export")
    };

    // Simulate the crash: insert the inbox row but DO NOT project.
    let created_at = crate::db::now_ms();
    sqlx::query("INSERT INTO loro_sync_inbox (space_id, bytes, created_at) VALUES (?, ?, ?)")
        .bind(space.as_str())
        .bind(&snapshot_bytes)
        .bind(created_at)
        .execute(&pool)
        .await
        .expect("seed inbox");

    // Boot replay.
    let registry = LoroEngineRegistry::new();
    let mat = crate::materializer::Materializer::new(pool.clone());
    let replayed = crate::recovery::replay_sync_inbox(&pool, &registry, "device-B", &mat)
        .await
        .expect("replay_sync_inbox");
    assert_eq!(replayed, 1, "exactly one slot must be replayed");

    // (a) the block is now projected into SQL.
    let content: (String,) = sqlx::query_as("SELECT content FROM blocks WHERE id = ?")
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("block must be projected after replay");
    assert_eq!(content.0, "from-A");

    // (b) the inbox row is gone.
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(&pool)
        .await
        .expect("count inbox");
    assert_eq!(remaining, 0, "the replayed slot must be cleared");
}

/// Idempotent replay: replaying the same payload twice does not error and
/// leaves SQL consistent (one `blocks` row, inbox empty).
#[tokio::test]
async fn replay_sync_inbox_is_idempotent_across_two_replays() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    let snapshot_bytes: Vec<u8> = {
        let mut e = LoroEngine::with_peer_id("device-A").expect("engine");
        e.apply_create_block(BLOCK_A, "content", "from-A", None, 0)
            .expect("create");
        e.export_snapshot().expect("export")
    };

    let registry = LoroEngineRegistry::new();

    // First replay cycle.
    let created_at = crate::db::now_ms();
    sqlx::query("INSERT INTO loro_sync_inbox (space_id, bytes, created_at) VALUES (?, ?, ?)")
        .bind(space.as_str())
        .bind(&snapshot_bytes)
        .bind(created_at)
        .execute(&pool)
        .await
        .expect("seed inbox 1");
    let mat = crate::materializer::Materializer::new(pool.clone());
    let r1 = crate::recovery::replay_sync_inbox(&pool, &registry, "device-B", &mat)
        .await
        .expect("replay 1");
    assert_eq!(r1, 1);

    // Second replay cycle with the SAME bytes (re-seeded as if a second
    // crashed apply landed the identical snapshot). Re-import is idempotent.
    sqlx::query("INSERT INTO loro_sync_inbox (space_id, bytes, created_at) VALUES (?, ?, ?)")
        .bind(space.as_str())
        .bind(&snapshot_bytes)
        .bind(crate::db::now_ms())
        .execute(&pool)
        .await
        .expect("seed inbox 2");
    let r2 = crate::recovery::replay_sync_inbox(&pool, &registry, "device-B", &mat)
        .await
        .expect("replay 2 must not error");
    assert_eq!(r2, 1);

    // SQL is consistent: exactly one BLOCK_A row, inbox empty.
    let block_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("count blocks");
    assert_eq!(
        block_count, 1,
        "idempotent replay must not duplicate the block"
    );
    let inbox_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(&pool)
        .await
        .expect("count inbox");
    assert_eq!(inbox_count, 0, "both slots must be cleared");
}

/// #2292 gate: a purge whose SQL Pass-D sweep never committed — the engine
/// already shows the subtree gone, but the stale SQL child rows survive —
/// is re-swept on boot from the durable `purged_ids` tombstone. This pins
/// the exact gap the pre-#2292 additive fallback misses: on re-import the
/// engine delta is EMPTY (nothing left to purge), so the purged set can
/// come ONLY from the tombstone — never from a FORBIDDEN (#779) "SQL minus
/// engine" reconcile. The post-crash state is constructed directly (no real
/// crash): full tree in SQL+engine, purge applied to the ENGINE only, an
/// inbox slot carrying the (no-op-on-replay) bytes + the tombstone.
#[tokio::test]
async fn replay_sync_inbox_resweeps_purge_from_tombstone_2292() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    let page = BLOCK_A;
    let c1 = BLOCK_B;
    let c2 = BLOCK_C;

    // Steady state: build page -> {c1, c2} in a bare engine and project it
    // into B's engine + SQL via a real inbound snapshot apply (the apply's
    // own slot clears on success).
    let snapshot_bytes: Vec<u8> = {
        let mut e = LoroEngine::with_peer_id("device-A").expect("engine");
        e.apply_create_block(page, "page", "Parent", None, 0)
            .expect("page");
        e.apply_create_block(c1, "content", "child one", Some(page), 0)
            .expect("c1");
        e.apply_create_block(c2, "content", "child two", Some(page), 1)
            .expect("c2");
        e.export_snapshot().expect("export")
    };
    let registry_b = LoroEngineRegistry::new();
    apply_remote(
        &pool,
        &registry_b,
        "device-B",
        LoroSyncMessage::Snapshot {
            protocol_version: LORO_SYNC_PROTOCOL_VERSION,
            space_id: space.clone(),
            bytes: snapshot_bytes,
        },
    )
    .await
    .expect("apply snapshot");
    for id in [page, c1, c2] {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(n, 1, "pre-crash: {id} must be projected");
    }
    // Seed derived fts rows for the subtree to prove Pass D sweeps derived
    // tables too, not just `blocks`.
    for id in [page, c1, c2] {
        sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, 'x')")
            .bind(id)
            .execute(&pool)
            .await
            .expect("seed fts");
    }

    // Post-crash state: apply the purge to the ENGINE only (Phase 1
    // persisted via loro_doc_state) while the SQL rows survive (Phase-2
    // Pass D never committed). Export B's post-purge snapshot as the
    // leftover slot's bytes — re-importing it on recovery is a no-op, so
    // the engine delta is empty and ONLY the tombstone can drive Pass D.
    {
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B");
        g.engine_mut()
            .apply_purge_block(page)
            .expect("purge B engine");
    }
    let slot_bytes: Vec<u8> = {
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B-export");
        g.engine_mut().export_snapshot().expect("export post-purge")
    };
    {
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B-check");
        assert!(
            g.engine_mut().read_block(page).expect("read").is_none(),
            "engine must show the purged subtree gone"
        );
    }

    // Seed the crashed slot WITH the durable tombstone (JSON id array).
    let purged_json = serde_json::to_string(&[page, c1, c2]).expect("serialise tombstone");
    sqlx::query(
        "INSERT INTO loro_sync_inbox (space_id, bytes, purged_ids, created_at) \
             VALUES (?, ?, ?, ?)",
    )
    .bind(space.as_str())
    .bind(&slot_bytes)
    .bind(&purged_json)
    .bind(crate::db::now_ms())
    .execute(&pool)
    .await
    .expect("seed crashed slot");

    // Boot replay.
    let mat = crate::materializer::Materializer::new(pool.clone());
    let replayed = crate::recovery::replay_sync_inbox(&pool, &registry_b, "device-B", &mat)
        .await
        .expect("replay");
    assert_eq!(replayed, 1, "the crashed purge slot must replay");

    // The stale SQL rows for the whole purged subtree are now swept —
    // across `blocks` AND the seeded derived table — driven solely by the
    // tombstone (the re-import's engine delta was empty).
    for id in [page, c1, c2] {
        let blk: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("count blocks");
        assert_eq!(
            blk, 0,
            "#2292: stale purged row {id} must be swept via the tombstone"
        );
        let fts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fts_blocks WHERE block_id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("count fts");
        assert_eq!(
            fts, 0,
            "#2292: stale fts row {id} must be swept via the tombstone"
        );
    }
    // The slot is cleared iff the projection committed.
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(&pool)
        .await
        .expect("count inbox");
    assert_eq!(remaining, 0, "the replayed slot must be cleared");
}

/// #2292 happy path: a normal inbound purge apply (Live) sweeps the SQL
/// subtree AND clears the write-ahead slot on commit. The tombstone written
/// mid-apply (before the projection tx) is transparent to the success path
/// — the in-tx slot DELETE clears it for free — so the observable end-state
/// is identical to the pre-#2292 purge apply (additive).
#[tokio::test]
async fn apply_remote_purge_clears_slot_and_tombstone_on_commit_2292() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    let page = BLOCK_A;
    let c1 = BLOCK_B;
    let c2 = BLOCK_C;

    // Bare engine A: build the tree, remember its vv, snapshot into B.
    let mut engine_a = LoroEngine::with_peer_id("device-A").expect("engine");
    engine_a
        .apply_create_block(page, "page", "Parent", None, 0)
        .expect("page");
    engine_a
        .apply_create_block(c1, "content", "child one", Some(page), 0)
        .expect("c1");
    engine_a
        .apply_create_block(c2, "content", "child two", Some(page), 1)
        .expect("c2");
    let vv_before = engine_a.version_vector();
    let snapshot_bytes = engine_a.export_snapshot().expect("snapshot");

    let registry_b = LoroEngineRegistry::new();
    apply_remote(
        &pool,
        &registry_b,
        "device-B",
        LoroSyncMessage::Snapshot {
            protocol_version: LORO_SYNC_PROTOCOL_VERSION,
            space_id: space.clone(),
            bytes: snapshot_bytes,
        },
    )
    .await
    .expect("apply snapshot");

    // A purges the subtree; export the purge as an incremental Update.
    engine_a.apply_purge_block(page).expect("purge A");
    let purge_update = engine_a
        .export_update_since(&vv_before)
        .expect("export update");

    // Live inbound purge apply — writes the tombstone before the projection
    // tx, sweeps Pass D, then clears the slot in the same tx.
    let outcome = apply_remote(
        &pool,
        &registry_b,
        "device-B",
        LoroSyncMessage::Update {
            protocol_version: LORO_SYNC_PROTOCOL_VERSION,
            space_id: space.clone(),
            from_vv: vv_before.clone(),
            bytes: purge_update,
        },
    )
    .await
    .expect("apply purge update");
    assert!(
        matches!(outcome, ApplyOutcome::Imported { .. }),
        "purge apply must report Imported, got {outcome:?}"
    );

    // Additive end-state: SQL subtree swept, slot (with its tombstone) gone.
    for id in [page, c1, c2] {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(n, 0, "purged {id} must be swept from SQL on the live path");
    }
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(&pool)
        .await
        .expect("count inbox");
    assert_eq!(
        remaining, 0,
        "the slot (with its tombstone) must be gone after a successful commit"
    );
}

/// #2292 (CR, Fix 3): exercise the REAL tombstone WRITER, not a hand-seeded
/// `purged_ids`. A live inbound purge `apply_remote` runs the genuine
/// tombstone UPDATE (its real WHERE / union-serialization / guard), but the
/// Phase-2 projection tx is forced to FAIL AFTER that autocommit UPDATE has
/// committed — reproducing the crash window the tombstone exists to survive.
/// We assert the surviving row's `purged_ids` deserializes to EXACTLY the
/// engine's purged set, then that a later `replay_sync_inbox` (injection
/// removed) re-sweeps the stale SQL rows and clears the slot.
///
/// Injection mechanism — why NOT a competing `BEGIN IMMEDIATE` writer lock:
/// the preferred busy-lock injection is unworkable in this schema. The
/// tombstone UPDATE is itself an autocommit WRITE on the same WAL database as
/// the Phase-2 `BEGIN IMMEDIATE`; a single held writer lock fails BOTH — and
/// also the write-ahead inbox INSERT that runs even earlier in `apply_remote`
/// — so it is impossible to let the tombstone COMMIT while busy-failing only
/// Phase 2 with one lock. Instead we inject a deterministic Phase-2 failure
/// that leaves the autocommit tombstone intact: a temporary BEFORE-DELETE
/// trigger on `loro_sync_inbox` that RAISEs. The in-tx slot DELETE is the
/// LAST statement of the Phase-2 tx, so its abort drops (rolls back) Passes
/// A–D AFTER the tombstone UPDATE already committed — exactly the
/// SQL-behind-engine crash state. Dropped before the replay so the recovery
/// DELETE can clear the slot.
#[tokio::test]
async fn apply_remote_purge_writes_tombstone_before_failed_projection_2292() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    let page = BLOCK_A;
    let c1 = BLOCK_B;
    let c2 = BLOCK_C;

    // Bare engine A: build the tree, remember its vv, snapshot into B.
    let mut engine_a = LoroEngine::with_peer_id("device-A").expect("engine");
    engine_a
        .apply_create_block(page, "page", "Parent", None, 0)
        .expect("page");
    engine_a
        .apply_create_block(c1, "content", "child one", Some(page), 0)
        .expect("c1");
    engine_a
        .apply_create_block(c2, "content", "child two", Some(page), 1)
        .expect("c2");
    let vv_before = engine_a.version_vector();
    let snapshot_bytes = engine_a.export_snapshot().expect("snapshot");

    let registry_b = LoroEngineRegistry::new();
    apply_remote(
        &pool,
        &registry_b,
        "device-B",
        LoroSyncMessage::Snapshot {
            protocol_version: LORO_SYNC_PROTOCOL_VERSION,
            space_id: space.clone(),
            bytes: snapshot_bytes,
        },
    )
    .await
    .expect("apply snapshot");
    for id in [page, c1, c2] {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(n, 1, "pre-crash: {id} must be projected");
    }
    // Seed derived fts rows so the replay proves Pass D sweeps derived tables
    // too, not just `blocks`.
    for id in [page, c1, c2] {
        sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, 'x')")
            .bind(id)
            .execute(&pool)
            .await
            .expect("seed fts");
    }

    // Inject the deterministic Phase-2 failure (see fn docs): abort the
    // in-tx slot DELETE, Phase 2's last statement, leaving the autocommit
    // tombstone intact.
    sqlx::query(
        "CREATE TRIGGER t_fail_projection_2292 BEFORE DELETE ON loro_sync_inbox \
             BEGIN SELECT RAISE(ABORT, 'injected #2292 projection failure'); END",
    )
    .execute(&pool)
    .await
    .expect("install failure trigger");

    // A purges the subtree; export the purge as an incremental Update.
    engine_a.apply_purge_block(page).expect("purge A");
    let purge_update = engine_a
        .export_update_since(&vv_before)
        .expect("export update");

    // Live inbound purge apply — writes the REAL tombstone (autocommit)
    // before the projection tx, which the trigger then aborts. `apply_remote`
    // must surface the failure as `Err` AFTER the tombstone committed.
    let result = apply_remote(
        &pool,
        &registry_b,
        "device-B",
        LoroSyncMessage::Update {
            protocol_version: LORO_SYNC_PROTOCOL_VERSION,
            space_id: space.clone(),
            from_vv: vv_before.clone(),
            bytes: purge_update,
        },
    )
    .await;
    assert!(
        result.is_err(),
        "injected Phase-2 abort must make apply_remote return Err, got {result:?}"
    );

    // The engine DID import the purge (Phase 1) ...
    {
        let mut g = registry_b.for_space(&space, "device-B").expect("for_space");
        assert!(
            g.engine_mut().read_block(page).expect("read").is_none(),
            "engine must show the purged subtree gone"
        );
    }
    // ... but the SQL rows survive (Phase 2 rolled back) — the crash state.
    for id in [page, c1, c2] {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(
            n, 1,
            "post-crash: stale SQL row {id} must survive the rolled-back projection"
        );
    }

    // THE WRITER ASSERTION: the surviving slot's `purged_ids` was written by
    // the real UPDATE and deserializes to EXACTLY the engine's purged set.
    let stored: Option<String> =
        sqlx::query_scalar("SELECT purged_ids FROM loro_sync_inbox WHERE space_id = ?")
            .bind(space.as_str())
            .fetch_one(&pool)
            .await
            .expect("the slot must survive with its tombstone");
    let stored =
        stored.expect("purged_ids must be non-NULL — the real writer must have persisted it");
    let mut got: Vec<String> =
        serde_json::from_str(&stored).expect("tombstone must be a JSON id array");
    got.sort();
    let mut want = vec![page.to_string(), c1.to_string(), c2.to_string()];
    want.sort();
    assert_eq!(
        got, want,
        "#2292: the WRITER must persist exactly the engine's purged seed + descendants"
    );

    // Remove the injected failure so recovery can clear the slot.
    sqlx::query("DROP TRIGGER t_fail_projection_2292")
        .execute(&pool)
        .await
        .expect("drop failure trigger");

    // Boot replay re-sweeps the stale rows FROM THE WRITTEN TOMBSTONE (the
    // re-import's engine delta is empty) and clears the slot.
    let mat = crate::materializer::Materializer::new(pool.clone());
    let replayed = crate::recovery::replay_sync_inbox(&pool, &registry_b, "device-B", &mat)
        .await
        .expect("replay");
    assert_eq!(replayed, 1, "the crashed purge slot must replay");
    for id in [page, c1, c2] {
        let blk: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("count blocks");
        assert_eq!(
            blk, 0,
            "#2292: stale row {id} must be swept via the written tombstone"
        );
        let fts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fts_blocks WHERE block_id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("count fts");
        assert_eq!(
            fts, 0,
            "#2292: stale fts row {id} must be swept via the written tombstone"
        );
    }
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(&pool)
        .await
        .expect("count inbox");
    assert_eq!(remaining, 0, "the replayed slot must be cleared");
}

/// #1257 freshness gate — DIVERGENCE case. The sender's engine still
/// holds a block as LIVE while SQL has soft-deleted it (the eager-apply
/// gap: a delete reached SQL but not the engine). `prepare_outgoing` MUST
/// refuse: emit NO payload (`Ok(None)`) and never export the stale block.
#[tokio::test]
async fn prepare_outgoing_refuses_when_engine_live_block_is_sql_deleted() {
    let (pool, _dir) = fresh_pool().await;
    let registry = LoroEngineRegistry::new();
    let space = SpaceId::from_trusted(SPACE_A);

    // Engine A holds BLOCK_A as live (never deleted in the engine).
    {
        let mut g = registry.for_space(&space, "device-A").expect("for_space");
        g.engine_mut()
            .apply_create_block(BLOCK_A, "content", "from-A", None, 0)
            .expect("create A");
    }
    // The engine indeed reports it as exportable-live.
    {
        let mut g = registry.for_space(&space, "device-A").expect("for_space");
        let live = g.engine_mut().live_block_ids().expect("live ids");
        assert!(
            live.iter().any(|id| id == BLOCK_A),
            "precondition: engine must hold BLOCK_A as live"
        );
    }

    // SQL has the row but it is SOFT-DELETED (deleted_at set) — and the
    // engine was NOT told. This is the divergence the gate must catch.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
             VALUES (?, 'content', 'from-A', NULL, 1, ?)",
    )
    .bind(BLOCK_A)
    .bind(crate::db::now_ms())
    .execute(&pool)
    .await
    .expect("insert soft-deleted block");

    // Initial-sync (snapshot) export must REFUSE.
    let snap = prepare_outgoing_for_pool(&pool, &registry, &space, "device-A", None)
        .await
        .expect("prepare_outgoing must not error");
    assert!(
        snap.is_none(),
        "stale engine (engine-live block is SQL-deleted) must refuse the \
             snapshot export, got a payload: {snap:?}"
    );

    // Incremental (update) export must ALSO refuse — the gate runs before
    // the export branch, independent of peer_vv.
    let some_vv: Vec<u8> = {
        let mut g = registry.for_space(&space, "device-A").expect("for_space");
        g.engine_mut().version_vector()
    };
    let upd = prepare_outgoing_for_pool(&pool, &registry, &space, "device-A", Some(&some_vv))
        .await
        .expect("prepare_outgoing must not error");
    assert!(
        upd.is_none(),
        "stale engine must refuse the update export too, got: {upd:?}"
    );
}

/// #1257 freshness gate — HAPPY PATH (no false-refuse). When the engine
/// and SQL agree (the block is live in both), `prepare_outgoing` exports
/// exactly as before and the block is present in the snapshot.
#[tokio::test]
async fn prepare_outgoing_exports_normally_when_engine_and_sql_agree() {
    let (pool, _dir) = fresh_pool().await;
    let registry = LoroEngineRegistry::new();
    let space = SpaceId::from_trusted(SPACE_A);

    {
        let mut g = registry.for_space(&space, "device-A").expect("for_space");
        g.engine_mut()
            .apply_create_block(BLOCK_A, "content", "from-A", None, 0)
            .expect("create A");
    }
    // SQL row exists and is ALIVE (deleted_at NULL) — consistent state.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'from-A', NULL, 1)",
    )
    .bind(BLOCK_A)
    .execute(&pool)
    .await
    .expect("insert alive block");

    let msg = prepare_outgoing_for_pool(&pool, &registry, &space, "device-A", None)
        .await
        .expect("prepare_outgoing must not error")
        .expect("consistent engine must NOT be refused (no false-refuse)");

    // The exported snapshot must carry BLOCK_A: import into a fresh
    // receiver engine and read it back.
    let bytes = match &msg {
        LoroSyncMessage::Snapshot { bytes, .. } => bytes.clone(),
        other => panic!("expected Snapshot, got {other:?}"),
    };
    let mut receiver = LoroEngine::with_peer_id("device-B").expect("rcv");
    receiver.import(&bytes).expect("import snapshot");
    assert!(
        receiver.read_block(BLOCK_A).expect("read").is_some(),
        "happy-path export must include the live block"
    );
}

// ---------------------------------------------------------------------
// #2040 — soft-deleted-id read hoisted out of the per-space loop
// ---------------------------------------------------------------------

/// #2040 unit: `first_engine_live_block_sql_deleted` selects the SAME
/// element the pre-refactor `Vec` + `sort()` + `into_iter().next()` chose —
/// the lexicographically smallest engine-live id that SQL has soft-deleted —
/// but via `.iter().min()` with no allocation / full sort. The live set is
/// passed out of `due_date` order on purpose so a no-op (returning the
/// first encountered, not the minimum) would fail.
#[test]
fn first_engine_live_block_sql_deleted_picks_min_like_old_sort() {
    let sql_deleted: std::collections::HashSet<String> = [BLOCK_A, BLOCK_C, BLOCK_E]
        .iter()
        .map(std::string::ToString::to_string)
        .collect();

    // Engine-live set: two are soft-deleted (C3, A1), one is alive (B2).
    // Insertion order puts the LARGER deleted id (C3) first to prove we
    // return the minimum, not the first hit.
    let live = vec![
        BLOCK_C.to_string(),
        BLOCK_B.to_string(),
        BLOCK_A.to_string(),
    ];
    let hit = first_engine_live_block_sql_deleted(&live, &sql_deleted);
    assert_eq!(
        hit.as_deref(),
        Some(BLOCK_A),
        "must return the lexicographically smallest matching id (old sort+first)"
    );

    // Replicate the OLD algorithm explicitly and assert parity.
    let mut old: Vec<String> = live
        .iter()
        .filter(|id| sql_deleted.contains(*id))
        .cloned()
        .collect();
    old.sort();
    assert_eq!(
        hit,
        old.into_iter().next(),
        "must match the old sort-then-first"
    );

    // No engine-live block is soft-deleted → None.
    let none_live = vec![BLOCK_B.to_string(), BLOCK_D.to_string()];
    assert_eq!(
        first_engine_live_block_sql_deleted(&none_live, &sql_deleted),
        None,
        "no intersection must yield None"
    );
    // Empty live set → None (the old early-return path).
    assert_eq!(
        first_engine_live_block_sql_deleted(&[], &sql_deleted),
        None,
        "empty live set must yield None"
    );
}

/// #2040 integration: the soft-deleted set is read ONCE and reused across
/// multiple spaces. We read it via `read_sql_soft_deleted_ids`, assert its
/// contents, then drive `prepare_outgoing` for two different spaces with
/// that SINGLE shared set — both must succeed and select the expected
/// outgoing message, proving the per-space loop no longer needs its own
/// vault read. (The orchestrator hoists exactly this read out of the loop.)
#[tokio::test]
async fn read_sql_soft_deleted_ids_read_once_reused_across_spaces() {
    let (pool, _dir) = fresh_pool().await;
    const SPACE_B: &str = "01HZ00000000000000000000SQ";

    // Seed SQL with two ALIVE blocks and two SOFT-DELETED blocks. Only the
    // soft-deleted ids must appear in the set.
    for (id, alive) in [
        (BLOCK_A, true),
        (BLOCK_B, false),
        (BLOCK_C, true),
        (BLOCK_D, false),
    ] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'content', 'x', NULL, 0)",
        )
        .bind(id)
        .execute(&pool)
        .await
        .expect("insert block");
        if !alive {
            sqlx::query("UPDATE blocks SET deleted_at = 1777593600000 WHERE id = ?")
                .bind(id)
                .execute(&pool)
                .await
                .expect("soft-delete");
        }
    }

    // Read ONCE for the whole round.
    let sql_deleted = read_sql_soft_deleted_ids(&pool)
        .await
        .expect("read soft-deleted ids");
    let mut got: Vec<String> = sql_deleted.iter().cloned().collect();
    got.sort();
    assert_eq!(
        got,
        vec![BLOCK_B.to_string(), BLOCK_D.to_string()],
        "set must contain exactly the soft-deleted ids (read once)"
    );

    // Two distinct spaces, each with an engine holding only ALIVE blocks
    // (A1 in space A, C3 in space B). Neither engine-live block is in the
    // shared soft-deleted set, so BOTH exports must succeed using the
    // single shared set — no per-space re-read needed.
    let registry = LoroEngineRegistry::new();
    let space_a = SpaceId::from_trusted(SPACE_A);
    let space_b = SpaceId::from_trusted(SPACE_B);
    {
        let mut g = registry
            .for_space(&space_a, "device-A")
            .expect("for_space A");
        g.engine_mut()
            .apply_create_block(BLOCK_A, "content", "in-a", None, 0)
            .expect("create A");
    }
    {
        let mut g = registry
            .for_space(&space_b, "device-A")
            .expect("for_space B");
        g.engine_mut()
            .apply_create_block(BLOCK_C, "content", "in-b", None, 0)
            .expect("create C");
    }

    let msg_a = prepare_outgoing(&registry, &space_a, "device-A", None, &sql_deleted)
        .await
        .expect("prepare A")
        .expect("space A export must not be refused (A1 is alive)");
    let msg_b = prepare_outgoing(&registry, &space_b, "device-A", None, &sql_deleted)
        .await
        .expect("prepare B")
        .expect("space B export must not be refused (C3 is alive)");
    assert!(
        matches!(msg_a, LoroSyncMessage::Snapshot { ref space_id, .. } if space_id == &space_a),
        "space A must export its own snapshot"
    );
    assert!(
        matches!(msg_b, LoroSyncMessage::Snapshot { ref space_id, .. } if space_id == &space_b),
        "space B must export its own snapshot"
    );

    // Now make space B's engine hold a block that SQL soft-deleted (B2):
    // the SAME shared set must drive a per-space REFUSAL for B while A
    // still exports — proving the shared set is applied independently per
    // space (the #1257 gate is preserved under the #2040 hoist).
    let registry2 = LoroEngineRegistry::new();
    {
        let mut g = registry2
            .for_space(&space_a, "device-A")
            .expect("for_space A2");
        g.engine_mut()
            .apply_create_block(BLOCK_A, "content", "in-a", None, 0)
            .expect("create A2");
    }
    {
        let mut g = registry2
            .for_space(&space_b, "device-A")
            .expect("for_space B2");
        g.engine_mut()
            .apply_create_block(BLOCK_B, "content", "deleted-in-sql", None, 0)
            .expect("create B2");
    }
    let a_again = prepare_outgoing(&registry2, &space_a, "device-A", None, &sql_deleted)
        .await
        .expect("prepare A again");
    let b_refused = prepare_outgoing(&registry2, &space_b, "device-A", None, &sql_deleted)
        .await
        .expect("prepare B refused-path");
    assert!(
        a_again.is_some(),
        "space A still exports under the shared set"
    );
    assert!(
        b_refused.is_none(),
        "space B must be refused: its engine-live B2 is in the shared soft-deleted set"
    );
}

const TAG_X: &str = "01HZ0000000000000000000TX1";
const TAG_Y: &str = "01HZ0000000000000000000TY2";

/// Sync a full snapshot from a fresh sender registry into a fresh
/// receiver registry + pool. Returns the receiver registry.
async fn seed_receiver_via_snapshot(
    pool: &SqlitePool,
    registry_a: &LoroEngineRegistry,
    space: &SpaceId,
) -> LoroEngineRegistry {
    let msg = prepare_outgoing_for_pool(pool, registry_a, space, "device-A", None)
        .await
        .expect("prepare snapshot")
        .expect("freshness gate must not refuse");
    let registry_b = LoroEngineRegistry::new();
    let outcome = apply_remote(pool, &registry_b, "device-B", msg)
        .await
        .expect("apply snapshot");
    assert!(
        matches!(outcome, ApplyOutcome::Imported { .. }),
        "snapshot apply must import, got {outcome:?}"
    );
    registry_b
}

/// Produce an incremental update from A covering everything past
/// B's current vv and apply it on B, returning the outcome.
async fn round_trip_update(
    pool: &SqlitePool,
    registry_a: &LoroEngineRegistry,
    registry_b: &LoroEngineRegistry,
    space: &SpaceId,
) -> ApplyOutcome {
    let b_vv = registry_b.loro_vv(space).expect("B vv");
    let msg = prepare_outgoing_for_pool(pool, registry_a, space, "device-A", Some(&b_vv))
        .await
        .expect("prepare update")
        .expect("freshness gate must not refuse");
    apply_remote(pool, registry_b, "device-B", msg)
        .await
        .expect("apply update")
}

/// #2264 (a): an inbound delta that edited ONE block of a multi-block
/// vault reports a changed set bounded to exactly that block — not the
/// whole vault — so the per-block SQL projection, page-id resolution and
/// FTS reindex all scale with the delta.
#[tokio::test]
async fn inbound_small_delta_changed_set_bounded_to_touched_block_2264() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        for (i, id) in [BLOCK_A, BLOCK_B, BLOCK_C, BLOCK_D, BLOCK_E]
            .iter()
            .enumerate()
        {
            let pos = i64::try_from(i).expect("seed index fits i64");
            e.apply_create_block(id, "content", "seed", None, pos)
                .expect("create");
        }
    }
    let registry_b = seed_receiver_via_snapshot(&pool, &registry_a, &space).await;

    // Remote one-block content edit.
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        g.engine_mut()
            .apply_edit_content(BLOCK_C, 0, 0, "x")
            .expect("edit C");
    }
    let outcome = round_trip_update(&pool, &registry_a, &registry_b, &space).await;
    match outcome {
        ApplyOutcome::Imported {
            changed_blocks,
            purged_blocks,
            ..
        } => {
            let changed: Vec<&str> = changed_blocks
                .iter()
                .map(agaric_core::ulid::BlockId::as_str)
                .collect();
            assert_eq!(
                changed,
                vec![BLOCK_C],
                "a one-block content delta must report exactly that block \
                     as changed, not the whole vault (#2264)"
            );
            assert!(purged_blocks.is_empty(), "content edit purges nothing");
        }
        other => panic!("expected Imported, got {other:?}"),
    }
    // And the projection converged that block in SQL.
    let content: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
        .bind(BLOCK_C)
        .fetch_one(&pool)
        .await
        .expect("read C");
    assert_eq!(content, "xseed", "the edited block's row converged");
}

/// #2264: a redelivered (already-imported) update is a complete no-op —
/// empty changed / purged / page-id sets — and still clears its
/// write-ahead inbox slot via the short-circuit path.
#[tokio::test]
async fn redelivered_update_is_complete_noop_2264() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        g.engine_mut()
            .apply_create_block(BLOCK_A, "content", "seed", None, 0)
            .expect("create");
    }
    let registry_b = seed_receiver_via_snapshot(&pool, &registry_a, &space).await;

    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        g.engine_mut()
            .apply_edit_content(BLOCK_A, 0, 0, "y")
            .expect("edit A");
    }
    // Build ONE update message and deliver it twice.
    let b_vv = registry_b.loro_vv(&space).expect("B vv");
    let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", Some(&b_vv))
        .await
        .expect("prepare update")
        .expect("freshness gate must not refuse");
    let first = apply_remote(&pool, &registry_b, "device-B", msg.clone())
        .await
        .expect("first apply");
    assert!(
        matches!(&first, ApplyOutcome::Imported { changed_blocks, .. } if !changed_blocks.is_empty()),
        "first delivery imports the edit, got {first:?}"
    );

    let second = apply_remote(&pool, &registry_b, "device-B", msg)
        .await
        .expect("second apply");
    match second {
        ApplyOutcome::Imported {
            changed_blocks,
            purged_blocks,
            changed_page_ids,
            ..
        } => {
            assert!(changed_blocks.is_empty(), "redelivery changes nothing");
            assert!(purged_blocks.is_empty(), "redelivery purges nothing");
            assert!(changed_page_ids.is_empty(), "no page invalidation on no-op");
        }
        other => panic!("expected Imported, got {other:?}"),
    }
    // The no-op short-circuit still cleared the write-ahead inbox slot.
    let inbox_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(&pool)
        .await
        .expect("count inbox");
    assert_eq!(inbox_rows, 0, "no-op path must clear its inbox slot (#535)");
}

/// #2265 (b): a content-only inbound delta triggers NO tag-inheritance
/// rebuild work — neither the global `rebuild_all` nor a scoped subtree
/// recompute. Observable via a deliberately-wrong sentinel row in
/// `block_tag_inherited`: ANY recompute covering the touched subtree
/// would sweep it; a content-only delta must leave it in place.
#[tokio::test]
async fn content_only_inbound_delta_skips_tag_inheritance_rebuild_2265() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(TAG_X, "tag", "tag-x", None, 0)
            .expect("create tag x");
        e.apply_create_block(TAG_Y, "tag", "tag-y", None, 1)
            .expect("create tag y");
        e.apply_create_block(BLOCK_A, "content", "parent", None, 2)
            .expect("create AA");
        e.apply_create_block(BLOCK_B, "content", "child", Some(BLOCK_A), 0)
            .expect("create BB");
        e.apply_add_tag(BLOCK_A, TAG_X).expect("tag AA");
    }
    let registry_b = seed_receiver_via_snapshot(&pool, &registry_a, &space).await;

    // Snapshot projection computed the genuine inherited row.
    let inherited: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_tag_inherited \
             WHERE block_id = ? AND tag_id = ? AND inherited_from = ?",
    )
    .bind(BLOCK_B)
    .bind(TAG_X)
    .bind(BLOCK_A)
    .fetch_one(&pool)
    .await
    .expect("count inherited");
    assert_eq!(
        inherited, 1,
        "child inherits the parent's tag after snapshot"
    );

    // Sentinel: a row NO recompute would produce (BB does not inherit
    // TAG_Y from anywhere). A global rebuild_all — or a subtree
    // recompute covering AA/BB — would delete it.
    sqlx::query(
        "INSERT INTO block_tag_inherited (block_id, tag_id, inherited_from) \
             VALUES (?, ?, ?)",
    )
    .bind(BLOCK_B)
    .bind(TAG_Y)
    .bind(BLOCK_A)
    .execute(&pool)
    .await
    .expect("insert sentinel");

    // Content-only remote edit on the tagged parent.
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        g.engine_mut()
            .apply_edit_content(BLOCK_A, 0, 0, "z")
            .expect("edit AA");
    }
    let outcome = round_trip_update(&pool, &registry_a, &registry_b, &space).await;
    match outcome {
        ApplyOutcome::Imported { changed_blocks, .. } => {
            let changed: Vec<&str> = changed_blocks
                .iter()
                .map(agaric_core::ulid::BlockId::as_str)
                .collect();
            assert_eq!(changed, vec![BLOCK_A], "content edit changes only AA");
        }
        other => panic!("expected Imported, got {other:?}"),
    }

    let sentinel: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_tag_inherited \
             WHERE block_id = ? AND tag_id = ?",
    )
    .bind(BLOCK_B)
    .bind(TAG_Y)
    .fetch_one(&pool)
    .await
    .expect("count sentinel");
    assert_eq!(
        sentinel, 1,
        "a content-only inbound delta must trigger NO tag-inheritance \
             recompute (the sentinel row would have been swept) — #2265"
    );
}

/// #2265 (c): an inbound MOVE recomputes inherited tags for the moved
/// block's WHOLE subtree — descendants included, even though they are
/// not in the changed set — because a move changes the ancestor chain
/// for every node under it, with or without tag ops in the delta.
#[tokio::test]
async fn inbound_move_delta_recomputes_descendant_inherited_tags_2265() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(TAG_X, "tag", "tag-x", None, 0)
            .expect("create tag x");
        e.apply_create_block(TAG_Y, "tag", "tag-y", None, 1)
            .expect("create tag y");
        // AA (tagged X) → BB → DD;  CC (tagged Y) is the move target.
        e.apply_create_block(BLOCK_A, "content", "old parent", None, 2)
            .expect("create AA");
        e.apply_create_block(BLOCK_C, "content", "new parent", None, 3)
            .expect("create CC");
        e.apply_create_block(BLOCK_B, "content", "moved", Some(BLOCK_A), 0)
            .expect("create BB");
        e.apply_create_block(BLOCK_D, "content", "descendant", Some(BLOCK_B), 0)
            .expect("create DD");
        e.apply_add_tag(BLOCK_A, TAG_X).expect("tag AA");
        e.apply_add_tag(BLOCK_C, TAG_Y).expect("tag CC");
    }
    let registry_b = seed_receiver_via_snapshot(&pool, &registry_a, &space).await;

    let inherited_pairs = |pool: &SqlitePool, block: &'static str| {
        let pool = pool.clone();
        async move {
            let rows: Vec<(String, String)> = sqlx::query_as(
                "SELECT tag_id, inherited_from FROM block_tag_inherited \
                     WHERE block_id = ? ORDER BY tag_id",
            )
            .bind(block)
            .fetch_all(&pool)
            .await
            .expect("fetch inherited");
            rows
        }
    };

    assert_eq!(
        inherited_pairs(&pool, BLOCK_D).await,
        vec![(TAG_X.to_string(), BLOCK_A.to_string())],
        "pre-move: DD inherits X from AA"
    );

    // Remote structural move: BB (with DD under it) from AA to CC.
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        g.engine_mut()
            .apply_move_block(BLOCK_B, Some(BLOCK_C), 0)
            .expect("move BB under CC");
    }
    let outcome = round_trip_update(&pool, &registry_a, &registry_b, &space).await;
    match outcome {
        ApplyOutcome::Imported { changed_blocks, .. } => {
            let changed: Vec<&str> = changed_blocks
                .iter()
                .map(agaric_core::ulid::BlockId::as_str)
                .collect();
            assert_eq!(
                changed,
                vec![BLOCK_B],
                "move delta changed set is bounded to the moved block + \
                     affected sibling groups (here: just BB) — NOT the subtree"
            );
            assert!(
                !changed.contains(&BLOCK_D),
                "descendant DD must not need to be in the changed set"
            );
        }
        other => panic!("expected Imported, got {other:?}"),
    }

    // The scoped subtree recompute covered the whole moved subtree.
    assert_eq!(
        inherited_pairs(&pool, BLOCK_B).await,
        vec![(TAG_Y.to_string(), BLOCK_C.to_string())],
        "post-move: BB inherits Y from CC (X swept)"
    );
    assert_eq!(
        inherited_pairs(&pool, BLOCK_D).await,
        vec![(TAG_Y.to_string(), BLOCK_C.to_string())],
        "post-move: descendant DD re-inherits through the new ancestor \
             chain even though it was not in the changed set (#2265)"
    );
    // And the moved block's row converged.
    let parent: Option<String> = sqlx::query_scalar("SELECT parent_id FROM blocks WHERE id = ?")
        .bind(BLOCK_B)
        .fetch_one(&pool)
        .await
        .expect("read BB parent");
    assert_eq!(parent.as_deref(), Some(BLOCK_C), "BB reparented in SQL");
}

/// #535/#2264 review: a boot-replay of a surviving inbox slot whose ops
/// the engine ALREADY holds (`loro_doc_state` was persisted ahead of the
/// crashed SQL projection — exactly the window the write-ahead inbox
/// exists to heal) must STILL project to SQL and clear the slot in-tx.
/// Trusting the no-op import diff here would drop the slot and leave SQL
/// permanently diverged from the engine.
#[tokio::test]
async fn replay_projects_slot_even_when_engine_already_has_ops_2264() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    // Device A mints a block; its snapshot is the slot's payload.
    let registry_a = LoroEngineRegistry::new();
    let bytes = {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "recovered", None, 0)
            .expect("create");
        e.export_snapshot().expect("export")
    };

    // Receiver: the ENGINE already imported the bytes (as after a crash
    // where `save_all_engines` persisted the doc ahead of SQL), but the
    // SQL projection never committed — the write-ahead slot survives.
    let registry_b = LoroEngineRegistry::new();
    {
        let mut g = registry_b.for_space(&space, "device-B").expect("for_space");
        g.engine_mut()
            .import(&bytes)
            .expect("pre-import into engine");
    }
    let inbox_id: i64 = sqlx::query_scalar(
        "INSERT INTO loro_sync_inbox (space_id, bytes, created_at) \
             VALUES (?, ?, ?) RETURNING id",
    )
    .bind(space.as_str())
    .bind(&bytes)
    .bind(crate::db::now_ms())
    .fetch_one(&pool)
    .await
    .expect("seed surviving slot");

    let (changed, _purged) = replay_inbox_row(
        &pool,
        &registry_b,
        "device-B",
        space.as_str(),
        &bytes,
        inbox_id,
        &[],
    )
    .await
    .expect("replay");
    assert!(
        changed.iter().any(|b| b.as_str() == BLOCK_A),
        "replay must distrust the no-op import diff and fall back to the \
             full live-tree projection (#2264 review)"
    );

    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("count block");
    assert_eq!(n, 1, "the slot's block must be projected to SQL");

    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(&pool)
        .await
        .expect("count inbox");
    assert_eq!(remaining, 0, "slot cleared atomically with the projection");
}

/// #2264 review: a LIVE no-op redelivery is fast-pathed only when no
/// OTHER slot is pending for the space. Here a leftover slot (a prior
/// delivery whose projection failed after the engine import) marks SQL
/// as possibly stale: the redelivery must fall back to the full
/// projection — healing SQL immediately — and leave the leftover slot
/// for boot replay.
#[tokio::test]
async fn live_noop_redelivery_with_leftover_slot_forces_full_projection_2264() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        g.engine_mut()
            .apply_create_block(BLOCK_A, "content", "seed", None, 0)
            .expect("create");
    }
    let registry_b = seed_receiver_via_snapshot(&pool, &registry_a, &space).await;

    // Remote edit; build ONE update message for it.
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        g.engine_mut()
            .apply_edit_content(BLOCK_A, 0, 0, "y")
            .expect("edit A");
    }
    let b_vv = registry_b.loro_vv(&space).expect("B vv");
    let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", Some(&b_vv))
        .await
        .expect("prepare update")
        .expect("freshness gate must not refuse");
    let LoroSyncMessage::Update { ref bytes, .. } = msg else {
        panic!("expected an Update message");
    };

    // Simulate delivery 1 dying AFTER the engine import but BEFORE its
    // projection tx: import into B's ENGINE only + leave its slot behind.
    {
        let mut g = registry_b.for_space(&space, "device-B").expect("for_space");
        g.engine_mut().import(bytes).expect("engine-only import");
    }
    sqlx::query("INSERT INTO loro_sync_inbox (space_id, bytes, created_at) VALUES (?, ?, ?)")
        .bind(space.as_str())
        .bind(&bytes[..])
        .bind(crate::db::now_ms())
        .execute(&pool)
        .await
        .expect("seed leftover slot");

    // Redelivery: the import diff is a no-op, but the leftover slot must
    // veto the fast path and force the healing full projection.
    let outcome = apply_remote(&pool, &registry_b, "device-B", msg.clone())
        .await
        .expect("redelivery apply");
    match outcome {
        ApplyOutcome::Imported { changed_blocks, .. } => {
            assert!(
                changed_blocks.iter().any(|b| b.as_str() == BLOCK_A),
                "leftover slot must force the full-projection fallback"
            );
        }
        other => panic!("expected Imported, got {other:?}"),
    }

    // SQL healed: the edit that delivery 1 failed to project is now there.
    let content: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("read A");
    assert_eq!(content, "yseed", "the failed delivery's edit converged");

    // Our own slot was cleared in-tx; the leftover stays for boot replay.
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(&pool)
        .await
        .expect("count inbox");
    assert_eq!(
        remaining, 1,
        "redelivery clears its own slot in-tx and leaves the leftover \
             slot for boot replay"
    );
}

/// #2275 — the derived `block_tag_inherited` cache rebuild runs AFTER the
/// projection tx commits (and after the #535 inbox slot is deleted). A
/// failure there must NOT turn a committed import into an `Err`: the caller
/// would treat the committed projection as unprojected while the inbox slot
/// is already gone (no retry possible). We inject a rebuild failure with
/// triggers that abort any post-commit write to `block_tag_inherited`, then
/// assert the import still reports `Imported` and the blocks are persisted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn post_commit_inherited_tags_rebuild_failure_is_non_fatal() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    // A tag block + a tagged parent + a child that inherits the tag, so the
    // post-commit rebuild has an inherited row to (attempt to) insert.
    const TAG_T: &str = "01HZ0000000000000000000T01";
    let registry = LoroEngineRegistry::new();
    {
        let mut g = registry.for_space(&space, "device-T").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(TAG_T, "content", "mytag", None, 0)
            .expect("tag block");
        e.apply_create_block(BLOCK_A, "content", "parent", None, 1)
            .expect("parent");
        e.apply_create_block(BLOCK_B, "content", "child", Some(BLOCK_A), 0)
            .expect("child");
        e.apply_add_tag(BLOCK_A, TAG_T).expect("add tag to parent");
    }
    let msg = prepare_outgoing_for_pool(&pool, &registry, &space, "device-T", None)
        .await
        .expect("prepare_outgoing")
        .expect("#1257 freshness gate must not refuse a consistent engine");

    // Inject the fault: any post-commit write to the derived cache aborts.
    // The projection itself writes only `block_tags` (direct edges); the
    // inherited cache is populated solely by the post-commit rebuild, so
    // these fire only there.
    for event in ["INSERT", "DELETE"] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "CREATE TRIGGER fail_inh_{event} AFTER {event} ON block_tag_inherited \
                 BEGIN SELECT RAISE(ABORT, 'injected rebuild failure'); END"
        )))
        .execute(&pool)
        .await
        .expect("install trigger");
    }

    let dest = LoroEngineRegistry::new();
    let outcome = apply_remote(&pool, &dest, "device-T", msg)
        .await
        .expect("a post-commit inherited-tags rebuild failure must be non-fatal");
    assert!(
        matches!(outcome, ApplyOutcome::Imported { .. }),
        "import must report Imported despite the rebuild failure, got {outcome:?}"
    );

    // The projection committed: parent and child are persisted...
    let parent: Option<String> = sqlx::query_scalar("SELECT id FROM blocks WHERE id = ?")
        .bind(BLOCK_A)
        .fetch_optional(&pool)
        .await
        .expect("query parent");
    assert!(
        parent.is_some(),
        "projection must have committed despite the rebuild failure"
    );
    let child: Option<String> = sqlx::query_scalar("SELECT id FROM blocks WHERE id = ?")
        .bind(BLOCK_B)
        .fetch_optional(&pool)
        .await
        .expect("query child");
    assert!(child.is_some(), "child block must be persisted");

    // ...including the direct tag edge (part of the committed projection),
    // while the derived inherited cache stayed empty (its rebuild aborted;
    // it heals on the next full RebuildTagInheritanceCache — local tag op,
    // global-scope import, or snapshot restore).
    let direct: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(BLOCK_A)
            .bind(TAG_T)
            .fetch_one(&pool)
            .await
            .expect("count direct tag edges");
    assert_eq!(direct, 1, "the direct tag edge must be committed");
}

// ---------------------------------------------------------------------------
// #3162 adversarial review — SQL-level guards for the `rank_only` skip.
//
// `import_and_project` skips Pass A-properties, Pass B (tags) and Pass C
// (soft-delete) for every block the engine reports as `rank_only`. A
// mis-classification there produces no error and no red test — SQL simply
// stops matching the CRDT. These two tests assert the outcome in SQL rather
// than the resolver's own bookkeeping.
// ---------------------------------------------------------------------------

const R_P: &str = "01HZ00000000000000000000P0";
const R_G: &str = "01HZ00000000000000000000G0";
const R_T: &str = "01HZ00000000000000000000T0";
const R_N: &str = "01HZ00000000000000000000N0";
const R_C0: &str = "01HZ0000000000000000000C00";
const R_C1: &str = "01HZ0000000000000000000C11";
const R_C2: &str = "01HZ0000000000000000000C22";
const R_C3: &str = "01HZ0000000000000000000C33";

/// Ship every op `registry_a` accumulated since `registry_b`'s vv to B through
/// the production inbound path.
async fn ship_update(
    pool: &SqlitePool,
    registry_a: &LoroEngineRegistry,
    registry_b: &LoroEngineRegistry,
    space: &SpaceId,
) {
    let vv = registry_b.loro_vv(space).expect("b vv");
    let msg = prepare_outgoing_for_pool(pool, registry_a, space, "device-A", Some(&vv))
        .await
        .expect("prepare update")
        .expect("freshness gate must not refuse");
    let outcome = apply_remote(pool, registry_b, "device-B", msg)
        .await
        .expect("apply update");
    assert!(
        matches!(outcome, ApplyOutcome::Imported { .. }),
        "update apply must report Imported, got {outcome:?}"
    );
}

/// #3162 — a sibling whose rank shifted AND which also changed for another
/// reason in the SAME import must keep its full projection. One sibling per
/// excluded channel (property / tag / soft-delete) plus one genuinely
/// rank-only sibling, all shifted by a single insert at index 0.
#[tokio::test]
async fn apply_remote_rank_shifted_sibling_with_a_real_change_still_projects_3162() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block_at(R_P, "content", "p", None, 0)
            .expect("create P");
        e.apply_create_block_at(R_T, "tag", "tag-x", None, 1)
            .expect("create TAG");
        for (i, id) in [R_C0, R_C1, R_C2, R_C3].iter().enumerate() {
            e.apply_create_block_at(id, "content", "c", Some(R_P), i)
                .expect("create child");
        }
    }
    let snap = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare snapshot")
        .expect("freshness gate must not refuse");
    let registry_b = LoroEngineRegistry::new();
    apply_remote(&pool, &registry_b, "device-B", snap)
        .await
        .expect("apply snapshot");

    // ONE update: an insert at index 0 (shifting C0..C3) plus a real change on
    // three of the four shifted siblings.
    const TS: &str = "1777593600000";
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block_at(R_N, "content", "n", Some(R_P), 0)
            .expect("insert at 0");
        e.apply_add_tag(R_C1, R_T).expect("tag C1");
        e.apply_set_property(R_C2, "effort", Some("5"))
            .expect("prop C2");
        e.apply_delete_block(R_C3, TS).expect("soft-delete C3");
    }
    ship_update(&pool, &registry_a, &registry_b, &space).await;

    // Every shifted sibling got its new dense rank (the rank-only path's own
    // job) — C0 is the genuinely rank-only one.
    for (id, want) in [(R_N, 1_i64), (R_C0, 2), (R_C1, 3), (R_C2, 4), (R_C3, 5)] {
        let pos: i64 = sqlx::query_scalar("SELECT position FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("position");
        assert_eq!(pos, want, "{id} must carry its refreshed dense rank");
    }
    // Pass B must NOT have been skipped for C1.
    let tags: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(R_C1)
            .bind(R_T)
            .fetch_one(&pool)
            .await
            .expect("count tags");
    assert_eq!(
        tags, 1,
        "C1's rank shifted but its tags ALSO changed; Pass B must still run \
         for it (#3162)",
    );
    // Pass A-properties must NOT have been skipped for C2.
    let props: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = ?")
            .bind(R_C2)
            .bind("effort")
            .fetch_one(&pool)
            .await
            .expect("count props");
    assert_eq!(
        props, 1,
        "C2's rank shifted but its properties ALSO changed; Pass A-properties \
         must still run for it (#3162)",
    );
    // Pass C must NOT have been skipped for C3.
    let del: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(R_C3)
        .fetch_one(&pool)
        .await
        .expect("deleted_at");
    assert_eq!(
        del,
        Some(TS.parse::<i64>().unwrap()),
        "C3's rank shifted but it was ALSO soft-deleted; Pass C must still run \
         for it (#3162)",
    );
    // ...and the purely rank-only sibling stayed live.
    let c0_del: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(R_C0)
        .fetch_one(&pool)
        .await
        .expect("deleted_at C0");
    assert_eq!(c0_del, None, "C0 only shifted rank; it must stay live");
}

/// #3162 claim 5 — Pass C is skipped for rank-only blocks on the argument that
/// its two jobs are always driven by an ANCESTOR whose own state changed, and
/// that ancestor's cascade covers the whole subtree. This is that exact shape:
/// grandparent G is soft-deleted in the same import that rank-shifts C0..C3
/// (which are therefore rank-only and get NO Pass C call of their own). Their
/// SQL `deleted_at` must still be stamped, by G's cascade.
#[tokio::test]
async fn apply_remote_ancestor_delete_cascades_to_rank_only_descendants_3162() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block_at(R_G, "content", "g", None, 0)
            .expect("create G");
        e.apply_create_block_at(R_P, "content", "p", Some(R_G), 0)
            .expect("create P");
        for (i, id) in [R_C0, R_C1, R_C2, R_C3].iter().enumerate() {
            e.apply_create_block_at(id, "content", "c", Some(R_P), i)
                .expect("create child");
        }
    }
    let snap = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
        .await
        .expect("prepare snapshot")
        .expect("freshness gate must not refuse");
    let snap_bytes = match &snap {
        LoroSyncMessage::Snapshot { bytes, .. } => bytes.clone(),
        other => panic!("expected Snapshot, got {other:?}"),
    };
    let registry_b = LoroEngineRegistry::new();
    apply_remote(&pool, &registry_b, "device-B", snap)
        .await
        .expect("apply snapshot");

    const TS: &str = "1777593600000";
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        // The ancestor's own state changes...
        e.apply_delete_block(R_G, TS).expect("soft-delete G");
        // ...while, in the SAME import, C0..C3 are shifted by an insert. P is
        // not in the changed set at all (its own sibling group is untouched),
        // so the cascade has to come from G.
        e.apply_create_block_at(R_N, "content", "n", Some(R_P), 0)
            .expect("insert at 0");
    }

    // Pin the PRECONDITION, or this test is vacuous: replay the very same
    // update into a probe engine and confirm the resolver really does class
    // C0..C3 as rank-only (⇒ the consumer gives them NO Pass C call of their
    // own) while G is a full-projection member.
    {
        let vv = registry_b.loro_vv(&space).expect("b vv");
        let upd = match prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", Some(&vv))
            .await
            .expect("prepare probe update")
            .expect("freshness gate")
        {
            LoroSyncMessage::Update { bytes, .. } => bytes,
            other => panic!("expected Update, got {other:?}"),
        };
        let mut probe = LoroEngine::new();
        probe.import(&snap_bytes).expect("probe snapshot");
        let delta = probe
            .import_with_changed_purged_tagscope(&upd)
            .expect("probe update");
        let rank_only: Vec<&str> = delta
            .rank_only
            .iter()
            .map(agaric_core::ulid::BlockId::as_str)
            .collect();
        let changed: Vec<&str> = delta
            .changed
            .iter()
            .map(agaric_core::ulid::BlockId::as_str)
            .collect();
        for id in [R_C0, R_C1, R_C2, R_C3] {
            assert!(
                rank_only.contains(&id),
                "precondition: {id} must be rank-only in this import, \
                 got rank_only={rank_only:?}",
            );
        }
        assert!(
            changed.contains(&R_G) && !rank_only.contains(&R_G),
            "precondition: G must be a full-projection member, got \
             changed={changed:?} rank_only={rank_only:?}",
        );
    }

    ship_update(&pool, &registry_a, &registry_b, &space).await;

    let want = TS.parse::<i64>().unwrap();
    for id in [R_G, R_P, R_C0, R_C1, R_C2, R_C3, R_N] {
        let del: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("deleted_at");
        assert_eq!(
            del,
            Some(want),
            "{id} must be swept into G's trash cohort even though Pass C was \
             skipped for the rank-only siblings (#3162)",
        );
    }
}

/// #3194 (#535) — a batched boot replay must NOT delete a slot whose blob the
/// import never actually reached.
///
/// `gate_replay_blobs` admits a blob on the strength of its declared
/// `partial_end_vv` and advances its cumulative reachability base by the same
/// value. `LoroDoc::import_batch` then returns `Ok` even when it could not apply
/// part of the payload — such changes are parked in `pending_changes`
/// (`ImportStatus { pending: Some(..) }`), which never enter the op-log, are
/// never diffed and are never projected. Before this fix the caller deleted the
/// durable inbox row anyway: the slot was that content's ONLY copy, so it was
/// gone with nothing in SQL to show for it — the #535 invariant inverted.
///
/// The fixture reaches that state with well-formed loro blobs:
///
/// * a SHALLOW snapshot of peer A's history — snapshot-shaped, so the gate's
///   carve-out admits it unconditionally, and it declares A's FULL end frontier
///   while carrying only the changes after its truncation point;
/// * an update from peer B whose change depends on an early op of A — the gate
///   accepts it because the snapshot's declared frontier covers that dep.
///
/// Neither settles on import, so the op-log stays behind both declared
/// frontiers and both rows must survive for a later boot.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replay_batch_keeps_slots_whose_end_frontier_the_import_never_reached_3194() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    // Peer A mints a root, then a second block; peer B imports only the root
    // and adds a child of it, so B's blob DEPENDS on A's first op without
    // carrying it.
    let mut a = LoroEngine::with_peer_id("device-A").expect("A");
    let since_a = a.version_vector();
    a.apply_create_block(BLOCK_A, "content", "root", None, 0)
        .expect("a root");
    let blob_a = a.export_update_since(&since_a).expect("blob a");

    let mut b = LoroEngine::with_peer_id("device-B").expect("B");
    b.import(&blob_a).expect("b imports a");
    let since_b = b.version_vector();
    b.apply_create_block(BLOCK_B, "content", "child", Some(BLOCK_A), 0)
        .expect("b child");
    let blob_b = b.export_update_since(&since_b).expect("blob b");

    // A shallow snapshot of A taken at its own tip: it declares A's full end
    // frontier but truncates the history the frontier covers.
    a.apply_create_block(BLOCK_C, "content", "second", None, 1)
        .expect("a second");
    let shallow = {
        let doc = a.doc_handle();
        let tip = doc.oplog_frontiers();
        doc.export(loro::ExportMode::ShallowSnapshot(std::borrow::Cow::Owned(
            tip,
        )))
        .expect("shallow snapshot")
    };

    let registry = LoroEngineRegistry::new();
    // Precondition: the gate ADMITS both blobs — this test is about the delete
    // condition, not the admission rule.
    {
        let mut g = registry.for_space(&space, "device-R").expect("for_space");
        let gates = g
            .engine_mut()
            .gate_replay_blobs(&[shallow.as_slice(), blob_b.as_slice()]);
        assert!(
            gates.iter().all(|gate| matches!(
                gate,
                agaric_engine::loro::engine::ReplayBlobGate::Accept { .. }
            )),
            "precondition: both slots must be admitted, so both would have been \
             deleted pre-#3194; got {gates:?}"
        );
    }

    let slots = vec![
        InboxSlot {
            id: seed_slot(&pool, space.as_str(), &shallow).await,
            bytes: shallow.clone(),
            tombstone_purged: Vec::new(),
        },
        InboxSlot {
            id: seed_slot(&pool, space.as_str(), &blob_b).await,
            bytes: blob_b.clone(),
            tombstone_purged: Vec::new(),
        },
    ];

    let outcome = replay_inbox_batch(&pool, &registry, "device-R", space.as_str(), slots)
        .await
        .expect("batch replay must not fail");

    // Precondition for the assertion below: the import really did leave the
    // op-log short — otherwise this would be asserting nothing.
    {
        let mut g = registry.for_space(&space, "device-R").expect("for_space");
        assert!(
            g.engine_mut().read_block(BLOCK_B).expect("read").is_none(),
            "precondition: the child never settled, so nothing could have been \
             projected for its slot"
        );
    }

    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(&pool)
        .await
        .expect("count inbox");
    assert_eq!(
        remaining, 2,
        "a slot whose blob the op-log never reached must survive for a later \
         boot — deleting it destroys the only copy of unprojected content (#535)"
    );
    assert_eq!(
        outcome.replayed, 0,
        "no slot was cleared, so none may be counted as replayed"
    );
    assert_eq!(
        outcome.errors.len(),
        2,
        "each kept slot must be reported so the boot walk can log it, got {:?}",
        outcome.errors
    );

    let projected: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .expect("count blocks");
    assert_eq!(
        projected, 0,
        "nothing settled, so nothing may be projected either"
    );
}

/// #3194 control — the delete condition must not become a blanket refusal.
///
/// The ordinary boot-replay batch (a cross-peer dep supplied by another slot in
/// the SAME batch, the #3188/#3189 shape) settles fully: the op-log reaches
/// every blob's declared end frontier, so every slot is still cleared in the
/// projection tx and every block lands in SQL. Without this, the test above
/// would pass just as well with a `require_covered` check that always fails.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replay_batch_still_clears_slots_the_import_did_reach_3194() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    let mut a = LoroEngine::with_peer_id("device-A").expect("A");
    let since_a = a.version_vector();
    a.apply_create_block(BLOCK_A, "content", "root", None, 0)
        .expect("a root");
    let blob_a = a.export_update_since(&since_a).expect("blob a");

    let mut b = LoroEngine::with_peer_id("device-B").expect("B");
    b.import(&blob_a).expect("b imports a");
    let since_b = b.version_vector();
    b.apply_create_block(BLOCK_B, "content", "child", Some(BLOCK_A), 0)
        .expect("b child");
    let blob_b = b.export_update_since(&since_b).expect("blob b");

    // Reverse causal order, so the dependency arrives in the LAST slot — the
    // #3188 fixpoint admits it and `import_batch` settles it.
    let slots = vec![
        InboxSlot {
            id: seed_slot(&pool, space.as_str(), &blob_b).await,
            bytes: blob_b.clone(),
            tombstone_purged: Vec::new(),
        },
        InboxSlot {
            id: seed_slot(&pool, space.as_str(), &blob_a).await,
            bytes: blob_a.clone(),
            tombstone_purged: Vec::new(),
        },
    ];

    let registry = LoroEngineRegistry::new();
    let outcome = replay_inbox_batch(&pool, &registry, "device-R", space.as_str(), slots)
        .await
        .expect("batch replay");

    assert_eq!(outcome.replayed, 2, "both slots must be cleared");
    assert!(
        outcome.errors.is_empty(),
        "a fully-settled batch must report no kept slots, got {:?}",
        outcome.errors
    );
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(&pool)
        .await
        .expect("count inbox");
    assert_eq!(remaining, 0, "the whole batch was projected and cleared");
    for id in [BLOCK_A, BLOCK_B] {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("count block");
        assert_eq!(n, 1, "{id} must be projected to SQL");
    }
}

/// Build the #3213 fixture: `(blob_a, blob_b)` where `blob_b` carries peer B's
/// child of peer A's root but does NOT carry A's op it depends on.
///
/// Importing `blob_b` alone makes `LoroDoc::import` return `Ok` while parking
/// the whole change in `pending_changes`: it never enters the op-log, is never
/// diffed and is never projected — so the op-log falls SHORT of the
/// `partial_end_vv` the blob declared, which is exactly the condition
/// `LoroEngine::oplog_shortfall` reports. Importing both settles it.
fn orphaned_child_blob_pair_3213() -> (Vec<u8>, Vec<u8>) {
    let mut a = LoroEngine::with_peer_id("device-A").expect("A");
    let since_a = a.version_vector();
    a.apply_create_block(BLOCK_A, "content", "root", None, 0)
        .expect("a root");
    let blob_a = a.export_update_since(&since_a).expect("blob a");

    let mut b = LoroEngine::with_peer_id("device-B").expect("B");
    b.import(&blob_a).expect("b imports a");
    let since_b = b.version_vector();
    b.apply_create_block(BLOCK_B, "content", "child", Some(BLOCK_A), 0)
        .expect("b child");
    let blob_b = b.export_update_since(&since_b).expect("blob b");

    (blob_a, blob_b)
}

/// An encoded EMPTY version vector — a `from_vv` reachable from any doc.
fn empty_from_vv_3213() -> Vec<u8> {
    LoroEngine::with_peer_id("device-EMPTY")
        .expect("engine")
        .version_vector()
}

fn update_msg_3213(space: &SpaceId, from_vv: Vec<u8>, bytes: Vec<u8>) -> LoroSyncMessage {
    LoroSyncMessage::Update {
        protocol_version: LORO_SYNC_PROTOCOL_VERSION,
        space_id: space.clone(),
        from_vv,
        bytes,
    }
}

async fn inbox_count_3213(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(pool)
        .await
        .expect("count inbox")
}

async fn block_count_3213(pool: &SqlitePool, id: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("count block")
}

/// #3213 (#3194 / #535) — the LIVE inbound path must not delete a write-ahead
/// inbox slot whose payload the import never actually reached.
///
/// `apply_remote` writes the raw bytes into `loro_sync_inbox` BEFORE importing,
/// precisely so a crash between import and projection cannot lose them. But
/// `LoroDoc::import` returns `Ok` even when it parked part of the payload in
/// `pending_changes` for missing deps — those ops are in neither the op-log nor
/// SQL, and the slot was their only durable copy. #3194 fixed this for the
/// batch replay path only, because that path had a gate-declared frontier to
/// check against; the live path had none and deleted unconditionally.
///
/// The blob is delivered as an `Update` declaring an EMPTY `from_vv`, which is
/// reachable from any doc, so the #1054 live gate admits it — the realistic
/// shape, a sender declaring a base it did not actually supply. The payload
/// then parks, and the slot must survive for a boot replay.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_remote_keeps_the_slot_whose_end_frontier_the_import_never_reached_3213() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    let (_blob_a, blob_b) = orphaned_child_blob_pair_3213();

    let registry = LoroEngineRegistry::new();
    let outcome = apply_remote(
        &pool,
        &registry,
        "device-R",
        update_msg_3213(&space, empty_from_vv_3213(), blob_b),
    )
    .await
    .expect("apply_remote must still return Ok — the import itself did not fail");
    assert!(
        matches!(outcome, ApplyOutcome::Imported { .. }),
        "precondition: the live gates must ADMIT this blob, so pre-#3213 its \
         slot would have been deleted; got {outcome:?}"
    );

    // Precondition for the assertion below: the change really did park, so
    // nothing about it reached the engine or SQL.
    {
        let mut g = registry.for_space(&space, "device-R").expect("for_space");
        assert!(
            g.engine_mut().read_block(BLOCK_B).expect("read").is_none(),
            "precondition: the orphaned child never settled into the op-log"
        );
    }
    assert_eq!(
        block_count_3213(&pool, BLOCK_B).await,
        0,
        "precondition: nothing settled, so nothing could be projected"
    );

    assert_eq!(
        inbox_count_3213(&pool).await,
        1,
        "the write-ahead slot is the ONLY copy of content that reached neither \
         the op-log nor SQL — deleting it is the #535 invariant inverted"
    );
}

/// #3213 control — the live delete condition must not become a blanket refusal.
///
/// The ordinary shape (a dependency that really is present, here supplied by a
/// preceding live delivery) settles fully: the op-log reaches each blob's
/// declared end frontier, every slot is cleared in its projection tx, and both
/// blocks land in SQL. Without this, the test above would pass just as well
/// with a condition that always fails.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_remote_still_clears_the_slot_the_import_did_reach_3213() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    let (blob_a, blob_b) = orphaned_child_blob_pair_3213();

    let registry = LoroEngineRegistry::new();
    for blob in [blob_a, blob_b] {
        let outcome = apply_remote(
            &pool,
            &registry,
            "device-R",
            update_msg_3213(&space, empty_from_vv_3213(), blob),
        )
        .await
        .expect("apply_remote");
        assert!(
            matches!(outcome, ApplyOutcome::Imported { .. }),
            "got {outcome:?}"
        );
    }

    assert_eq!(
        inbox_count_3213(&pool).await,
        0,
        "both payloads settled and projected, so both slots must be cleared"
    );
    for id in [BLOCK_A, BLOCK_B] {
        assert_eq!(
            block_count_3213(&pool, id).await,
            1,
            "{id} must be projected to SQL"
        );
    }
}

/// #3213 (#3194 / #535) — the PER-ROW boot-replay path must not delete a slot
/// whose payload the import never actually reached.
///
/// `replay_inbox_row` is `replay_inbox_batch`'s poison-isolation fallback: when
/// a batch import fails, each accepted blob is retried ALONE. A blob whose
/// dependency lived in a sibling slot then parks in `pending_changes` and is
/// not projected — and pre-#3213 its slot was deleted anyway, which is the
/// worst case of the gap, because the isolation retry is exactly where a blob
/// gets separated from its dependency.
///
/// Isolation itself is preserved: keeping the slot still returns `Ok`, so the
/// caller's per-slot walk moves on, and the boot walk advances its
/// `id > last_seen` cursor past every row BEFORE attempting it — a kept slot is
/// retried once per boot, never re-fetched inside one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replay_inbox_row_keeps_the_slot_whose_end_frontier_the_import_never_reached_3213() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    let (_blob_a, blob_b) = orphaned_child_blob_pair_3213();

    let slot_id = seed_slot(&pool, space.as_str(), &blob_b).await;
    let registry = LoroEngineRegistry::new();

    let (changed, purged) = replay_inbox_row(
        &pool,
        &registry,
        "device-R",
        space.as_str(),
        &blob_b,
        slot_id,
        &[],
    )
    .await
    .expect("the per-row replay must not fail — poison isolation depends on it");
    assert!(
        changed.is_empty() && purged.is_empty(),
        "precondition: the orphaned child never settled, so the replay projected \
         nothing; got changed={changed:?} purged={purged:?}"
    );
    assert_eq!(
        block_count_3213(&pool, BLOCK_B).await,
        0,
        "precondition: nothing settled, so nothing could be projected"
    );

    assert_eq!(
        inbox_count_3213(&pool).await,
        1,
        "the retried-alone slot holds the only copy of content that reached \
         neither the op-log nor SQL — it must survive for a later boot (#535)"
    );
}

/// #3213 control — the per-row delete condition must not become a blanket
/// refusal.
///
/// Replaying the dependency's slot first, then the child's, settles both: each
/// import reaches the frontier its blob declared, so each slot is cleared in
/// its projection tx and both blocks land in SQL. The second replay is the
/// load-bearing half — it clears against a NON-empty declared frontier met by a
/// non-trivially advanced op-log, so a condition that merely happened to be
/// vacuous would not pass it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replay_inbox_row_still_clears_the_slot_the_import_did_reach_3213() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    let (blob_a, blob_b) = orphaned_child_blob_pair_3213();

    let registry = LoroEngineRegistry::new();
    for blob in [blob_a, blob_b] {
        let slot_id = seed_slot(&pool, space.as_str(), &blob).await;
        replay_inbox_row(
            &pool,
            &registry,
            "device-R",
            space.as_str(),
            &blob,
            slot_id,
            &[],
        )
        .await
        .expect("per-row replay");
    }

    assert_eq!(
        inbox_count_3213(&pool).await,
        0,
        "both payloads settled and projected, so both slots must be cleared"
    );
    for id in [BLOCK_A, BLOCK_B] {
        assert_eq!(
            block_count_3213(&pool, id).await,
            1,
            "{id} must be projected to SQL"
        );
    }
}

/// #3213 — a kept slot is TRANSIENT in the common case: it clears itself at the
/// next boot once the dependency it was waiting on has landed.
///
/// This is the claim that makes the unbounded-retention trade acceptable, so it
/// is pinned rather than reasoned about. The full round trip is exercised, not a
/// shortcut: the dependency arrives in a LATER live message, the engines are
/// persisted to `loro_doc_state` and a FRESH registry is rehydrated from them —
/// so the heal cannot be coming from loro's in-memory `pending_changes`, which
/// do not survive a process boundary. Only then does the boot walk run.
///
/// Pre-#3213 this test would be vacuous: `apply_remote` deleted the slot on
/// delivery, and its content — never in the op-log, never in SQL — would simply
/// be gone. Here BLOCK_B is absent from SQL until the boot replay puts it there.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kept_slot_self_heals_at_the_next_boot_once_the_dependency_lands_3213() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    let (blob_a, blob_b) = orphaned_child_blob_pair_3213();

    let registry = LoroEngineRegistry::new();

    // 1. The orphaned child arrives FIRST and parks — its slot is kept (#3213).
    apply_remote(
        &pool,
        &registry,
        "device-R",
        update_msg_3213(&space, empty_from_vv_3213(), blob_b),
    )
    .await
    .expect("apply_remote (orphan)");
    assert_eq!(
        inbox_count_3213(&pool).await,
        1,
        "precondition: the orphan's slot must be KEPT, not deleted"
    );
    assert_eq!(
        block_count_3213(&pool, BLOCK_B).await,
        0,
        "precondition: the orphan projected nothing"
    );

    // 2. The dependency arrives in a LATER live message. It clears its own slot;
    //    the orphan's slot is not in that call's id set, so it stays behind.
    apply_remote(
        &pool,
        &registry,
        "device-R",
        update_msg_3213(&space, empty_from_vv_3213(), blob_a),
    )
    .await
    .expect("apply_remote (dependency)");
    assert_eq!(
        inbox_count_3213(&pool).await,
        1,
        "the dependency's own slot clears; the earlier orphan's slot remains"
    );

    // 3. Process boundary: persist the engines and rehydrate a FRESH registry
    //    from `loro_doc_state`, exactly as boot does. In-memory
    //    `pending_changes` do not cross this line.
    agaric_engine::loro::snapshot::save_all_engines(&pool, &registry).await;
    let booted = LoroEngineRegistry::new();
    agaric_engine::loro::snapshot::rehydrate_registry(&pool, &booted, "device-R").await;

    // 4. The boot walk retries the kept slot. Its declared frontier is now
    //    covered, so it projects and the slot is finally cleared.
    let mat = crate::materializer::Materializer::new(pool.clone());
    let replayed = crate::recovery::replay_sync_inbox(&pool, &booted, "device-R", &mat)
        .await
        .expect("replay_sync_inbox");
    assert_eq!(
        replayed, 1,
        "the kept slot must count as replayed once cleared"
    );
    assert_eq!(
        inbox_count_3213(&pool).await,
        0,
        "the kept slot must self-heal — retention is transient, not a leak"
    );
    assert_eq!(
        block_count_3213(&pool, BLOCK_B).await,
        1,
        "and its content must finally reach SQL — the whole point of keeping it"
    );
}

/// Insert one write-ahead inbox slot and return its id.
async fn seed_slot(pool: &SqlitePool, space_id: &str, bytes: &[u8]) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO loro_sync_inbox (space_id, bytes, created_at) \
         VALUES (?, ?, ?) RETURNING id",
    )
    .bind(space_id)
    .bind(bytes)
    .bind(crate::db::now_ms())
    .fetch_one(pool)
    .await
    .expect("seed inbox slot")
}

// ---------------------------------------------------------------------------
// #3226 — durable quarantine for permanently-stuck inbox slots
// ---------------------------------------------------------------------------
//
// #3194 / #3213 made a slot whose declared end frontier the op-log never reached
// SURVIVE, because deleting it would destroy the only durable copy of content
// that reached neither the op-log nor SQL (#535). The residue was that a
// PERMANENTLY unsatisfiable slot was retried — and logged as an error — once per
// boot forever. #3226 bounds the retrying without deleting anything: after
// `QUARANTINE_AFTER_BOOTS` unresolved boots the row MOVES to
// `loro_sync_quarantine` in one transaction.
//
// Three obligations, one test each way:
//   1. the transient population that self-heals must NEVER be quarantined,
//   2. the permanent population must stop being retried, and
//   3. nothing may be lost — the bytes stay recoverable AND still usable.
//
// ## Which fixture drives which arm
//
// The boot walk keeps a slot for two different reasons, and they are reachable
// by different fixtures:
//
// * **The blob cannot be imported at all** (truncated / corrupt payload — named
//   explicitly in #3226). It errors out of `import_and_project` and lands in
//   `replay_inbox_batch`'s per-row `Err` arm. Pre-#3226 this is the shape
//   `replay_batch_partial_failure_preserves_535_invariant_3164` leaves behind
//   forever. Constructible: any non-Loro byte string.
// * **The import succeeded but the op-log fell short of the declared frontier**
//   (#3194/#3213). Reaching this from a *boot* fixture is deliberately hard,
//   because the batch gate closes the door in front of it: an orphaned child
//   whose cross-peer dep is missing is rejected by `replay_base_miss`'s
//   `start_frontiers` half (#3189) and DROPPED, not kept — verified below in
//   `orphan_dropped_by_the_boot_gate_is_never_quarantined_3226`. It survives to
//   the keep only via a sibling-slot dependency in a batch that failed for some
//   other reason. Those tests therefore drive the accounting through
//   `note_unresolved_slot` — the single function BOTH arms of
//   `replay_inbox_batch` call — rather than through a contrived blob.

use agaric_sync::sync_protocol::loro_sync_quarantine as quarantine;

async fn quarantine_count_3226(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_quarantine")
        .fetch_one(pool)
        .await
        .expect("count quarantine")
}

/// The highest `unresolved_boots` among the remaining inbox rows (0 if none).
async fn unresolved_boots_3226(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COALESCE(MAX(unresolved_boots), 0) FROM loro_sync_inbox")
        .fetch_one(pool)
        .await
        .expect("max unresolved_boots")
}

/// #3226 HAPPY PATH (a) — the transient case the issue warns against catching.
///
/// A blob whose dependency arrives in a LATER live message is kept by
/// `apply_remote` (#3213) and heals at the very next boot. It must never be
/// charged a single unresolved boot, let alone quarantined: the whole design
/// constraint is that quarantine "only engages well after that window".
///
/// The heal is proven across a real persist + rehydrate boundary, so it cannot
/// be coming from loro's in-memory `pending_changes`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn transient_kept_slot_self_heals_without_ever_being_charged_3226() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    let (blob_a, blob_b) = orphaned_child_blob_pair_3213();
    let registry = LoroEngineRegistry::new();

    apply_remote(
        &pool,
        &registry,
        "device-R",
        update_msg_3213(&space, empty_from_vv_3213(), blob_b),
    )
    .await
    .expect("apply_remote (orphan)");
    assert_eq!(
        inbox_count_3213(&pool).await,
        1,
        "precondition: the orphan's slot must be KEPT, not deleted (#3213)"
    );
    assert_eq!(
        unresolved_boots_3226(&pool).await,
        0,
        "#3226: a LIVE keep must charge NOTHING — the row was just inserted, no \
         boot has retried it. Charging here would let three redeliveries of one \
         blob spend most of the budget before a single retry ran."
    );

    apply_remote(
        &pool,
        &registry,
        "device-R",
        update_msg_3213(&space, empty_from_vv_3213(), blob_a),
    )
    .await
    .expect("apply_remote (dependency)");

    agaric_engine::loro::snapshot::save_all_engines(&pool, &registry).await;
    let booted = LoroEngineRegistry::new();
    agaric_engine::loro::snapshot::rehydrate_registry(&pool, &booted, "device-R").await;

    let mat = crate::materializer::Materializer::new(pool.clone());
    let replayed = crate::recovery::replay_sync_inbox(&pool, &booted, "device-R", &mat)
        .await
        .expect("replay_sync_inbox");
    assert_eq!(replayed, 1, "the kept slot must replay and clear");
    assert_eq!(inbox_count_3213(&pool).await, 0, "…and leave the inbox");
    assert_eq!(
        quarantine_count_3226(&pool).await,
        0,
        "#3226: the self-healing population must NEVER reach quarantine"
    );
    assert_eq!(
        block_count_3213(&pool, BLOCK_B).await,
        1,
        "and its content must reach SQL — the point of keeping the slot"
    );
    mat.shutdown();
}

/// #3226 HAPPY PATH (b) — an orphan the boot gate DROPS is not quarantined.
///
/// If the dependency never arrives, the batch gate's `start_frontiers` half
/// (#3189) rejects the blob as unreachable and drops the slot outright, leaving
/// the next live sync session to fall back to snapshot catch-up (#1054). That is
/// a pre-existing resolution path, and quarantine must not shadow it: the slot
/// is cleared on its FIRST boot, so it can never accumulate a boot budget.
///
/// This also documents, mechanically, why the quarantine tests below use a
/// corrupt payload rather than an orphan: on the boot path the orphan does not
/// survive to be kept.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orphan_dropped_by_the_boot_gate_is_never_quarantined_3226() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    let (_blob_a, blob_b) = orphaned_child_blob_pair_3213();
    seed_slot(&pool, space.as_str(), &blob_b).await;

    let mat = crate::materializer::Materializer::new(pool.clone());
    let registry = LoroEngineRegistry::new();
    crate::recovery::replay_sync_inbox(&pool, &registry, "device-R", &mat)
        .await
        .expect("replay_sync_inbox");

    assert_eq!(
        inbox_count_3213(&pool).await,
        0,
        "the #1054/#3189 gate drops an unreachable orphan on its first boot"
    );
    assert_eq!(
        quarantine_count_3226(&pool).await,
        0,
        "#3226: a gate DROP is a resolution, not a stuck slot — quarantine must \
         not shadow the snapshot-catch-up path"
    );
    assert_eq!(
        unresolved_boots_3226(&pool).await,
        0,
        "nothing remains to have been charged"
    );
    mat.shutdown();
}

/// #3226 HAPPY PATH (c) — a slot one boot short of the budget that then
/// RESOLVES must clear normally and never be quarantined.
///
/// The budget must be a bound on retrying, not a countdown to disposal. This
/// spends `QUARANTINE_AFTER_BOOTS - 1` unresolved boots through
/// [`quarantine::note_unresolved_slot`] — the single accounting function BOTH of
/// `replay_inbox_batch`'s survivor arms call, so this is the same charging the
/// boot walk performs — and then lets the REAL boot walk replay a blob that can
/// settle. It clears through the ordinary path with an empty quarantine table.
///
/// Driving the charges directly is what makes the off-by-one testable at the
/// exact boundary: a threshold that fired at N-1 instead of N would quarantine
/// this blob before the resolving boot ever ran.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slot_that_resolves_one_boot_short_of_the_budget_is_never_quarantined_3226() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    // `blob_a` is self-contained (peer A's root create), so a boot replay can
    // always settle and project it.
    let (blob_a, _blob_b) = orphaned_child_blob_pair_3213();
    let slot_id = seed_slot(&pool, space.as_str(), &blob_a).await;

    for boot in 1..quarantine::QUARANTINE_AFTER_BOOTS {
        let disposition = quarantine::note_unresolved_slot(&pool, slot_id, &[], "test: unresolved")
            .await
            .expect("note_unresolved_slot");
        assert_eq!(
            disposition,
            quarantine::SlotDisposition::Kept {
                unresolved_boots: boot
            },
            "boot {boot} is inside the budget — the slot must be KEPT"
        );
        assert_eq!(
            quarantine_count_3226(&pool).await,
            0,
            "boot {boot}: nothing may be quarantined yet"
        );
    }
    assert_eq!(
        unresolved_boots_3226(&pool).await,
        quarantine::QUARANTINE_AFTER_BOOTS - 1,
        "precondition: exactly one boot of budget left"
    );

    let mat = crate::materializer::Materializer::new(pool.clone());
    let registry = LoroEngineRegistry::new();
    let replayed = crate::recovery::replay_sync_inbox(&pool, &registry, "device-R", &mat)
        .await
        .expect("replay_sync_inbox");

    assert_eq!(
        replayed, 1,
        "the slot must replay on its last budgeted boot"
    );
    assert_eq!(
        inbox_count_3213(&pool).await,
        0,
        "and be cleared by its projection tx, not quarantined"
    );
    assert_eq!(
        quarantine_count_3226(&pool).await,
        0,
        "#3226: a shortfall that resolves — even on the very last budgeted boot \
         — must NEVER reach quarantine"
    );
    assert_eq!(
        block_count_3213(&pool, BLOCK_A).await,
        1,
        "its content must reach SQL"
    );
    mat.shutdown();
}

/// #3226 QUARANTINE PATH — a permanently unsatisfiable slot moves to quarantine
/// after `QUARANTINE_AFTER_BOOTS` boots and stops being retried.
///
/// The fixture is the corrupt-payload population #3226 names: bytes that are not
/// a Loro blob at all, so neither the batch import nor the per-row fallback can
/// ever project them. Pre-#3226 this row stayed in `loro_sync_inbox` and
/// re-errored at EVERY boot forever (that is exactly what
/// `replay_batch_partial_failure_preserves_535_invariant_3164` asserts about the
/// old behaviour). Both halves of the fix are pinned: the move happens at the
/// budget and not before, and the boot after it does no work at all.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permanently_stuck_slot_is_quarantined_and_stops_being_retried_3226() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    let poison: Vec<u8> = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01];
    seed_slot(&pool, space.as_str(), &poison).await;

    let mat = crate::materializer::Materializer::new(pool.clone());
    let registry = LoroEngineRegistry::new();
    for boot in 1..=quarantine::QUARANTINE_AFTER_BOOTS {
        crate::recovery::replay_sync_inbox(&pool, &registry, "device-R", &mat)
            .await
            .expect("a stuck slot must never fail the boot walk");
        let expected = i64::from(boot == quarantine::QUARANTINE_AFTER_BOOTS);
        assert_eq!(
            quarantine_count_3226(&pool).await,
            expected,
            "boot {boot}: the move must happen at boot {} and NOT before",
            quarantine::QUARANTINE_AFTER_BOOTS
        );
        if expected == 0 {
            assert_eq!(
                unresolved_boots_3226(&pool).await,
                boot,
                "boot {boot}: each boot must charge EXACTLY one unresolved boot"
            );
        }
    }

    assert_eq!(
        inbox_count_3213(&pool).await,
        0,
        "the quarantined slot must have LEFT the inbox — that is what ends the \
         once-per-boot retry"
    );

    // The boot after the move does nothing: the walk has no row to fetch, and
    // nothing re-admits the quarantined blob.
    let replayed = crate::recovery::replay_sync_inbox(&pool, &registry, "device-R", &mat)
        .await
        .expect("replay_sync_inbox");
    assert_eq!(replayed, 0, "there is nothing left to replay");
    assert_eq!(
        quarantine_count_3226(&pool).await,
        1,
        "quarantine is TERMINAL — nothing re-admits automatically (#3226)"
    );

    // …and the stuck blob is discoverable without reading logs.
    let listed = quarantine::list_quarantined_slots(&pool)
        .await
        .expect("list_quarantined_slots");
    assert_eq!(listed.len(), 1, "the stuck blob must be listed");
    let row = &listed[0];
    assert_eq!(row.space_id, space.as_str(), "listed under its own space");
    assert_eq!(
        row.byte_len,
        i64::try_from(poison.len()).expect("len fits i64"),
        "the listing must report the real payload size"
    );
    assert_eq!(
        row.unresolved_boots,
        quarantine::QUARANTINE_AFTER_BOOTS,
        "the listing must report how many boots it survived"
    );
    assert_eq!(
        row.declared_end_vv, "[]",
        "an undecodable blob declares no frontier — recorded as an empty JSON \
         array, not omitted"
    );
    assert!(
        row.last_reason.contains("replay failed"),
        "the listing must say WHY it is stuck, got {:?}",
        row.last_reason
    );
    assert!(
        row.first_seen_at_ms > 0 && row.quarantined_at_ms >= row.first_seen_at_ms,
        "provenance timestamps must be sane: first_seen={} quarantined={}",
        row.first_seen_at_ms,
        row.quarantined_at_ms
    );
    mat.shutdown();
}

/// #3226 / #535 INVARIANT — quarantining must lose nothing.
///
/// The reason #3194 and #3213 both rejected a retry cap is that the inbox row is
/// the only durable copy of content that reached neither the op-log nor SQL.
/// Quarantine is only legitimate if that stays true after the move, so this
/// asserts the preserved bytes are BYTE-IDENTICAL to what was admitted — not
/// merely that "a row exists". #535 applies to corrupt payloads too: we do not
/// get to delete bytes we merely failed to parse.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quarantining_preserves_the_blob_bytes_verbatim_535_3226() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    // A payload with structure, so a truncating / re-encoding bug would show.
    let payload: Vec<u8> = (0u8..=255).cycle().take(3_000).collect();
    seed_slot(&pool, space.as_str(), &payload).await;

    let mat = crate::materializer::Materializer::new(pool.clone());
    let registry = LoroEngineRegistry::new();
    for _ in 0..quarantine::QUARANTINE_AFTER_BOOTS {
        crate::recovery::replay_sync_inbox(&pool, &registry, "device-R", &mat)
            .await
            .expect("replay_sync_inbox");
    }

    let listed = quarantine::list_quarantined_slots(&pool)
        .await
        .expect("list_quarantined_slots");
    assert_eq!(listed.len(), 1, "precondition: the slot was quarantined");
    // Pins the fixture's premise: 3 KB of `(0u8..=255).cycle()` is NOT a Loro
    // blob, so it fails `decode_import_blob_meta` on EVERY boot and reaches the
    // per-row `Err` arm each time — one charge per boot, five boots, one move.
    // If the fixture ever became decodable it would take a different arm and
    // this test would silently stop covering the corrupt-payload population.
    assert!(
        listed[0].last_reason.contains("replay failed"),
        "the fixture must fail to import on every boot, got {:?}",
        listed[0].last_reason
    );
    assert_eq!(
        listed[0].byte_len,
        i64::try_from(payload.len()).expect("len fits i64"),
        "the recorded size must match the admitted payload"
    );

    let recovered = quarantine::read_quarantined_bytes(&pool, listed[0].id)
        .await
        .expect("read_quarantined_bytes")
        .expect("the quarantined row must still hold its bytes");
    assert_eq!(
        recovered, payload,
        "#535: the durable record must survive quarantining byte-for-byte — a \
         quarantine that mangles the payload is just a slower deletion"
    );
    mat.shutdown();
}

/// #3226 — re-admission is MANUAL, and it genuinely works.
///
/// The documented decision is that nothing re-admits a quarantined blob
/// automatically (see `readmit_quarantined_slot`'s docs for the three reasons).
/// This pins the other half of that decision: the manual route exists, moves the
/// row back, resets the budget, and the content is still PROJECTABLE afterwards.
/// Together with the byte-identity test above that is the full meaning of
/// "nothing was lost" — not just "the bytes are somewhere" but "the bytes still
/// work".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn readmitted_quarantined_blob_projects_on_the_next_boot_3226() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    // Self-contained blob: it CAN settle, so a successful projection after
    // re-admission proves the preserved bytes are still usable.
    let (blob_a, _blob_b) = orphaned_child_blob_pair_3213();
    let slot_id = seed_slot(&pool, space.as_str(), &blob_a).await;

    // Spend the whole budget through the boot-walk's own accounting function.
    for _ in 0..quarantine::QUARANTINE_AFTER_BOOTS {
        quarantine::note_unresolved_slot(&pool, slot_id, &[], "test: unresolved")
            .await
            .expect("note_unresolved_slot");
    }
    let listed = quarantine::list_quarantined_slots(&pool)
        .await
        .expect("list");
    assert_eq!(listed.len(), 1, "precondition: quarantined");
    assert_eq!(
        inbox_count_3213(&pool).await,
        0,
        "precondition: the move emptied the inbox"
    );

    let inbox_id = quarantine::readmit_quarantined_slot(&pool, listed[0].id)
        .await
        .expect("readmit_quarantined_slot")
        .expect("a known quarantine id must re-admit");
    assert!(inbox_id > 0, "the new inbox id must be usable");
    assert_eq!(
        inbox_count_3213(&pool).await,
        1,
        "re-admission must put the blob back in the write-ahead inbox"
    );
    assert_eq!(
        quarantine_count_3226(&pool).await,
        0,
        "the move back must be a MOVE — never a copy left in both tables"
    );
    assert_eq!(
        unresolved_boots_3226(&pool).await,
        0,
        "a deliberate re-admission must grant a FRESH budget, else the very next \
         unresolved boot would re-quarantine it and the action would look like a \
         no-op"
    );

    let mat = crate::materializer::Materializer::new(pool.clone());
    let registry = LoroEngineRegistry::new();
    let replayed = crate::recovery::replay_sync_inbox(&pool, &registry, "device-R", &mat)
        .await
        .expect("replay_sync_inbox");
    assert_eq!(replayed, 1, "the re-admitted slot must replay");
    assert_eq!(
        block_count_3213(&pool, BLOCK_A).await,
        1,
        "#535: the quarantined content must still be projectable after the round \
         trip — nothing was lost by quarantining it"
    );
    assert_eq!(
        inbox_count_3213(&pool).await,
        0,
        "and it clears through the ordinary path"
    );
    mat.shutdown();
}

/// #3226 — an unknown quarantine id re-admits nothing and errors nothing.
///
/// `readmit_quarantined_slot` is the manual, human-driven route, so a stale id
/// (already re-admitted, or typed wrong) must be a benign `None` rather than an
/// error that a caller might paper over — and above all must not insert an empty
/// inbox row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn readmitting_an_unknown_quarantine_id_is_a_benign_none_3226() {
    let (pool, _dir) = fresh_pool().await;
    let got = quarantine::readmit_quarantined_slot(&pool, 4_242)
        .await
        .expect("an unknown id must not be an error");
    assert!(got.is_none(), "nothing to re-admit");
    assert_eq!(
        inbox_count_3213(&pool).await,
        0,
        "and nothing may be inserted into the inbox"
    );
}

/// #3226 — one boot charges ONE unresolved boot, even when the batch fails and
/// falls back to the per-row walk.
///
/// `replay_inbox_batch` accounts for a surviving slot in two different arms (the
/// batch-success probe and the per-row fallback). A slot must never be charged
/// by both in the same boot, or the budget silently halves and the transient
/// population starts getting quarantined. Here the corrupt blob makes
/// `import_batch` reject the whole batch up front, so the fallback arm is the
/// one that runs — while the healthy blob still clears normally, which is also
/// the proof that the fallback really executed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn per_row_fallback_charges_one_boot_not_two_3226() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);
    let (blob_a, _blob_b) = orphaned_child_blob_pair_3213();
    let poison: Vec<u8> = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01];

    seed_slot(&pool, space.as_str(), &blob_a).await;
    seed_slot(&pool, space.as_str(), &poison).await;

    let mat = crate::materializer::Materializer::new(pool.clone());
    let registry = LoroEngineRegistry::new();
    let replayed = crate::recovery::replay_sync_inbox(&pool, &registry, "device-R", &mat)
        .await
        .expect("replay_sync_inbox");

    assert_eq!(replayed, 1, "the healthy slot must still clear");
    assert_eq!(
        block_count_3213(&pool, BLOCK_A).await,
        1,
        "precondition: the batch really did fall back per-row and project the \
         healthy blob"
    );
    assert_eq!(
        inbox_count_3213(&pool).await,
        1,
        "only the corrupt slot survives"
    );
    assert_eq!(
        unresolved_boots_3226(&pool).await,
        1,
        "#3226: ONE boot must charge ONE unresolved boot — the batch-success and \
         per-row-fallback arms must not both account for the same slot"
    );
    assert_eq!(
        quarantine_count_3226(&pool).await,
        0,
        "one boot is far inside the budget"
    );
    mat.shutdown();
}

/// #4083 — an inbound incremental update whose changed block has an ANCESTOR
/// that SQL no longer holds must still project.
///
/// Shape (reproduced live on the first two-device pair): the initiator applies
/// an `Update`, whose changed set is the sparse `resolve_changed_blocks` delta —
/// only the blocks the import actually touched. Any untouched ancestor must
/// already have a `blocks` row. It may not: a previous `sync_apply_remote`
/// rollback (this very failure), a prior `project_block_full_to_sql`
/// warn-and-skip, or a purge all leave that gap. Pass A then upserts the child
/// with `parent_id` pointing at a row that does not exist and SQLite aborts the
/// whole projection tx with `(code: 787) FOREIGN KEY constraint failed` — which
/// leaves the gap in place, so the next delivery of the same blob fails the
/// same way.
///
/// Here the gap is created directly (delete the child row, then the parent row —
/// SQLite will not let them go in the other order) and the remote then edits
/// ONLY the child, so the parent is genuinely absent from the changed set.
#[tokio::test]
async fn apply_remote_backfills_ancestor_missing_from_sql_parent_id_4083() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "grandparent", None, 0)
            .expect("create A");
        e.apply_create_block(BLOCK_B, "content", "parent", Some(BLOCK_A), 0)
            .expect("create B");
        e.apply_create_block(BLOCK_C, "content", "child", Some(BLOCK_B), 0)
            .expect("create C");
    }
    let registry_b = seed_receiver_via_snapshot(&pool, &registry_a, &space).await;

    // The gap: B's SQL lost the whole ancestor chain of C while its ENGINE
    // still holds it (exactly what a rolled-back `sync_apply_remote` leaves).
    for id in [BLOCK_C, BLOCK_B, BLOCK_A] {
        sqlx::query("DELETE FROM blocks WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await
            .expect("open the ancestor gap");
    }

    // Remote edits ONLY the deepest block → changed set = [C].
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        g.engine_mut()
            .apply_edit_content(BLOCK_C, 0, 0, "x")
            .expect("edit C");
    }
    let outcome = round_trip_update(&pool, &registry_a, &registry_b, &space).await;
    assert!(
        matches!(outcome, ApplyOutcome::Imported { .. }),
        "the update must apply, got {outcome:?}"
    );

    // The child landed WITH its real parent — never NULL-degraded to the vault
    // root (that would silently reparent it, and nothing reconciles it later).
    let (content, parent): (String, Option<String>) =
        sqlx::query_as("SELECT content, parent_id FROM blocks WHERE id = ?")
            .bind(BLOCK_C)
            .fetch_one(&pool)
            .await
            .expect("child row must exist");
    assert_eq!(content, "xchild", "the inbound edit projected");
    assert_eq!(
        parent.as_deref(),
        Some(BLOCK_B),
        "#4083: the child keeps its engine parent — a dangling parent_id must \
         never be degraded to NULL"
    );

    // …and the whole missing ancestor chain was backfilled from the engine,
    // not just the immediate parent.
    let grandparent: Option<String> =
        sqlx::query_scalar("SELECT parent_id FROM blocks WHERE id = ?")
            .bind(BLOCK_B)
            .fetch_one(&pool)
            .await
            .expect("parent row must be backfilled");
    assert_eq!(
        grandparent.as_deref(),
        Some(BLOCK_A),
        "#4083: the walk must climb the whole chain, not one level"
    );
    let root_content: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("root row must be backfilled");
    assert_eq!(root_content, "grandparent");
}

/// #4100 — the ancestor-backfill HEALING path must read one atomic view of the
/// engine, exactly like the healthy path.
///
/// #540's property is not "acquire the engine guard once when nothing is
/// wrong". It is that a projection reads ONE atomic view: every snapshot it
/// writes comes from the same engine state. #4083's backfill took a SECOND
/// acquisition, gated on the existence probe finding a missing row, so on the
/// healing path the backfilled ancestors' snapshots could come from a later
/// engine state than the changed blocks they were merged with — with a window
/// in between during which the engine can move.
///
/// The two runs below are the SAME apply over the SAME engine state, differing
/// only in whether SQL holds the untouched ancestors. `ancestors_outside`
/// therefore returns the same candidates in both, and every other engine access
/// in `apply_remote` is identical — so any difference in the acquisition count
/// is the healing branch's, and nothing else's.
///
/// `guard_acquisitions` is the registry's own `mark_seq`, bumped exactly once
/// per guard handed out; the delta across the apply is that apply's acquisition
/// count.
#[tokio::test]
async fn apply_remote_healing_reads_one_engine_view_like_the_healthy_path_4100() {
    /// Returns (guard acquisitions during the apply, whether the root row was
    /// missing just before it, whether the root row is present just after).
    async fn run_apply(open_the_gap: bool) -> (u64, bool, bool) {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "grandparent", None, 0)
                .expect("create A");
            e.apply_create_block(BLOCK_B, "content", "parent", Some(BLOCK_A), 0)
                .expect("create B");
            e.apply_create_block(BLOCK_C, "content", "child", Some(BLOCK_B), 0)
                .expect("create C");
        }
        let registry_b = seed_receiver_via_snapshot(&pool, &registry_a, &space).await;

        if open_the_gap {
            // Deepest first — the FK forbids the other order.
            for id in [BLOCK_C, BLOCK_B, BLOCK_A] {
                sqlx::query("DELETE FROM blocks WHERE id = ?")
                    .bind(id)
                    .execute(&pool)
                    .await
                    .expect("open the ancestor gap");
            }
        }

        // Remote edits ONLY the deepest block → changed set = [C], so A and B
        // are untouched ancestors in BOTH runs.
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_edit_content(BLOCK_C, 0, 0, "x")
                .expect("edit C");
        }

        let root_missing_before: Option<String> =
            sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
                .bind(BLOCK_A)
                .fetch_optional(&pool)
                .await
                .expect("probe root before");

        let before = registry_b.guard_acquisitions();
        let outcome = round_trip_update(&pool, &registry_a, &registry_b, &space).await;
        let acquisitions = registry_b.guard_acquisitions() - before;
        assert!(
            matches!(outcome, ApplyOutcome::Imported { .. }),
            "the update must apply, got {outcome:?}"
        );

        let root_after: Option<String> =
            sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
                .bind(BLOCK_A)
                .fetch_optional(&pool)
                .await
                .expect("probe root after");

        (
            acquisitions,
            root_missing_before.is_none(),
            root_after.is_some(),
        )
    }

    let (healthy_acquisitions, healthy_gap, healthy_root) = run_apply(false).await;
    let (healing_acquisitions, healing_gap, healing_root) = run_apply(true).await;

    // Non-vacuity: the two runs really did take different branches.
    assert!(
        !healthy_gap && healthy_root,
        "the control run must have its ancestor row throughout"
    );
    assert!(
        healing_gap && healing_root,
        "the healing run must start with the ancestor row missing and end with \
         it backfilled — otherwise this test compares two healthy applies"
    );

    assert_eq!(
        healing_acquisitions, healthy_acquisitions,
        "#4100: healing must cost no extra engine-guard acquisition. A second \
         acquisition means the backfilled ancestors' snapshots come from a \
         later engine state than the changed blocks they are merged with, which \
         is the #540 property the healing path used to drop (healthy took \
         {healthy_acquisitions}, healing took {healing_acquisitions})"
    );
}

/// #4083 — the shape where the ancestor backfill's own output order is NOT
/// parent-before-child, and only the tx-wide `PRAGMA defer_foreign_keys = ON`
/// carries it.
///
/// `ancestors_outside` climbs PAST an ancestor that is itself in the changed
/// set, so on `A→B→C→D` with changed `[B, D]` it returns `[A, C]`. Prepended,
/// the projection order is `[A, C, B, D]` — `C` is upserted with
/// `parent_id = B` before `B`'s own row exists. With FK enforcement immediate
/// that is a `(code: 787)` abort on the spot; deferred to COMMIT it resolves.
///
/// This is the test that reddens if the pragma is deleted as "unused defence in
/// depth" — without it the sibling test above still passes (its backfill order
/// happens to be root-first), so this shape is the only local witness.
#[tokio::test]
async fn apply_remote_backfills_interleaved_ancestor_gap_4083() {
    let (pool, _dir) = fresh_pool().await;
    let space = SpaceId::from_trusted(SPACE_A);

    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_create_block(BLOCK_A, "content", "a", None, 0)
            .expect("create A");
        e.apply_create_block(BLOCK_B, "content", "b", Some(BLOCK_A), 0)
            .expect("create B");
        e.apply_create_block(BLOCK_C, "content", "c", Some(BLOCK_B), 0)
            .expect("create C");
        e.apply_create_block(BLOCK_D, "content", "d", Some(BLOCK_C), 0)
            .expect("create D");
    }
    let registry_b = seed_receiver_via_snapshot(&pool, &registry_a, &space).await;

    // Open the gap across the WHOLE chain (deepest first — the FK forbids the
    // other order), so every one of A/B/C/D is absent from SQL.
    for id in [BLOCK_D, BLOCK_C, BLOCK_B, BLOCK_A] {
        sqlx::query("DELETE FROM blocks WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await
            .expect("open the ancestor gap");
    }

    // Remote edits B and D but NOT C: changed = [B, D], untouched ancestors of
    // that set = [A, C] — and C's parent B is in the changed set, i.e. later.
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        let e = g.engine_mut();
        e.apply_edit_content(BLOCK_B, 0, 0, "x").expect("edit B");
        e.apply_edit_content(BLOCK_D, 0, 0, "y").expect("edit D");
    }
    let outcome = round_trip_update(&pool, &registry_a, &registry_b, &space).await;
    assert!(
        matches!(outcome, ApplyOutcome::Imported { .. }),
        "the update must apply, got {outcome:?}"
    );

    // Every link of the chain landed with its real parent — none NULL-degraded.
    for (id, want_parent) in [
        (BLOCK_A, None),
        (BLOCK_B, Some(BLOCK_A)),
        (BLOCK_C, Some(BLOCK_B)),
        (BLOCK_D, Some(BLOCK_C)),
    ] {
        let got: Option<String> = sqlx::query_scalar("SELECT parent_id FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|e| panic!("row {id} must exist: {e}"));
        assert_eq!(got.as_deref(), want_parent, "parent_id of {id}");
    }

    // The untouched ancestor C was backfilled from the ENGINE with its real
    // content (not an empty placeholder), and the edited blocks carry the edit.
    for (id, want) in [
        (BLOCK_A, "a"),
        (BLOCK_B, "xb"),
        (BLOCK_C, "c"),
        (BLOCK_D, "yd"),
    ] {
        let got: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|e| panic!("row {id} must exist: {e}"));
        assert_eq!(got, want, "content of {id}");
    }

    // A backfilled ancestor is a full row, not a stub: same `space_id`
    // resolution as the changed block it was reached from, and alive (the
    // engine holds no tombstone for it).
    let (space_of_c, deleted_c): (Option<String>, Option<i64>) =
        sqlx::query_as("SELECT space_id, deleted_at FROM blocks WHERE id = ?")
            .bind(BLOCK_C)
            .fetch_one(&pool)
            .await
            .expect("C row");
    let space_of_d: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
        .bind(BLOCK_D)
        .fetch_one(&pool)
        .await
        .expect("D row");
    assert_eq!(
        space_of_c, space_of_d,
        "the backfilled ancestor must resolve its space exactly like a changed block"
    );
    assert_eq!(deleted_c, None, "the backfilled ancestor must be alive");

    // And SQLite agrees the tree has no dangling edges left.
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&pool)
        .await
        .expect("foreign_key_check");
    assert!(
        violations.is_empty(),
        "post-apply FK check must be clean, got {} violation row(s)",
        violations.len()
    );
}
