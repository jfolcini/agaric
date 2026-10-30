//! Renaming a property key and merging one key into another (#5841 S2).

use super::prelude::*;
use agaric_core::error::ValidationCode;
use agaric_store::op::OpRef;

/// [`TEST_SPACE_ID`] as a registered space with a doc of its own.
async fn space(pool: &SqlitePool) {
    ensure_test_space(pool).await;
    mark_block_as_space(pool, TEST_SPACE_ID).await;
}

async fn page(pool: &SqlitePool, mat: &Materializer, title: &str) -> String {
    create_page_in_space_inner(pool, DEV, mat, None, title.into(), TEST_SPACE_ID.into())
        .await
        .unwrap()
        .as_str()
        .to_owned()
}

async fn declare(pool: &SqlitePool, mat: &Materializer, key: &str, ty: &str, opts: Option<&str>) {
    create_property_def_inner(
        pool,
        DEV,
        mat,
        TEST_SPACE_ID,
        key.into(),
        ty.into(),
        opts.map(str::to_owned),
    )
    .await
    .unwrap();
}

/// Set `key` on `block` to the text `value`; the op's ref.
async fn set_text(
    pool: &SqlitePool,
    mat: &Materializer,
    block: &str,
    key: &str,
    value: &str,
) -> OpRef {
    let set = capture_op_refs(set_property_inner(
        pool,
        DEV,
        mat,
        block.into(),
        key.into(),
        Some(value.into()),
        None,
        None,
        None,
        None,
        None,
    ))
    .await
    .unwrap();
    set.op_refs[0].clone()
}

/// `block`'s properties as `(key, text or date)`, by key.
async fn props(pool: &SqlitePool, block: &str) -> Vec<(String, String)> {
    sqlx::query_as(
        "SELECT key, COALESCE(value_text, value_date) FROM block_properties \
         WHERE block_id = ? AND key <> 'is_space' ORDER BY key",
    )
    .bind(block)
    .fetch_all(pool)
    .await
    .unwrap()
}

fn kv(key: &str, value: &str) -> (String, String) {
    (key.to_owned(), value.to_owned())
}

/// [`TEST_SPACE_ID`]'s `(value_type, options)` row for `key`.
async fn def_row(pool: &SqlitePool, key: &str) -> Option<(String, Option<String>)> {
    sqlx::query_as(
        "SELECT value_type, options FROM property_definitions WHERE space_id = ? AND key = ?",
    )
    .bind(TEST_SPACE_ID)
    .bind(key)
    .fetch_optional(pool)
    .await
    .unwrap()
}

/// The blocks of [`TEST_SPACE_ID`]'s doc holding `key`, by id.
fn doc_holders(mat: &Materializer, key: &str) -> Vec<String> {
    let mut holders: Vec<String> = mat
        .loro_state()
        .registry
        .for_space(&SpaceId::from_trusted(TEST_SPACE_ID), DEV)
        .unwrap()
        .engine_mut()
        .read_property_holders(key)
        .unwrap()
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    holders.sort();
    holders
}

async fn op_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn rename(
    pool: &SqlitePool,
    mat: &Materializer,
    old: &str,
    new: &str,
) -> Result<WithOps<PropertyDefinition>, AppError> {
    capture_op_refs(rename_property_key_inner(
        pool,
        DEV,
        mat,
        TEST_SPACE_ID,
        old.into(),
        new.into(),
    ))
    .await
}

fn sorted(mut ids: Vec<String>) -> Vec<String> {
    ids.sort();
    ids
}

// ======================================================================
// Rename
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rename_moves_every_value_the_trash_included_and_the_definition_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "project", "text", None).await;
    let (one, two, trashed) = (
        page(&pool, &mat, "One").await,
        page(&pool, &mat, "Two").await,
        page(&pool, &mat, "Gone").await,
    );
    for (block, value) in [(&one, "a"), (&two, "b"), (&trashed, "c")] {
        set_text(&pool, &mat, block, "project", value).await;
    }
    delete_block_inner(&pool, DEV, &mat, BlockId::from_trusted(&trashed))
        .await
        .unwrap();
    settle(&mat).await;

    let renamed = rename(&pool, &mat, "project", "area").await.unwrap();
    assert_eq!(
        renamed.inner.key, "area",
        "the definition, under its new key"
    );
    assert_eq!(renamed.op_refs.len(), 1, "a rename is one op");
    let (op_type, block_id): (String, Option<String>) =
        sqlx::query_as("SELECT op_type, block_id FROM op_log WHERE device_id = ? AND seq = ?")
            .bind(&renamed.op_refs[0].device_id)
            .bind(renamed.op_refs[0].seq)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(op_type, "rename_property_key");
    assert_eq!(
        block_id.as_deref(),
        Some(TEST_SPACE_ID),
        "filed under its space"
    );

    for (block, value) in [(&one, "a"), (&two, "b"), (&trashed, "c")] {
        assert_eq!(
            props(&pool, block).await,
            vec![kv("area", value)],
            "{value}"
        );
    }
    assert_eq!(def_row(&pool, "area").await, Some(("text".into(), None)));
    assert_eq!(def_row(&pool, "project").await, None);
    assert_eq!(
        doc_holders(&mat, "area"),
        sorted(vec![one, two, trashed]),
        "the doc moved them too"
    );
    assert!(doc_holders(&mat, "project").is_empty());
}

/// Boot replay meets a rename again after a later write under the old key:
/// the block keeps both values, in SQL as in the doc.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replayed_rename_keeps_a_later_write_under_the_old_key_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "project", "text", None).await;
    let one = page(&pool, &mat, "One").await;
    set_text(&pool, &mat, &one, "project", "a").await;
    let renamed = rename(&pool, &mat, "project", "area").await.unwrap();
    set_text(&pool, &mat, &one, "project", "later").await;

    let op = &renamed.op_refs[0];
    let record = agaric_store::op_log::get_op_by_seq(
        &agaric_store::db::ReadPool(pool.clone()),
        &op.device_id,
        op.seq,
    )
    .await
    .unwrap();
    let mut conn = pool.acquire().await.unwrap();
    agaric_engine::apply::kernel::apply_op_projected(&mut conn, &record, mat.loro_state(), false)
        .await
        .expect("the replay applies");
    assert_eq!(
        props(&pool, &one).await,
        vec![kv("area", "a"), kv("project", "later")]
    );
    assert_eq!(doc_holders(&mat, "area"), vec![one.clone()]);
    assert_eq!(doc_holders(&mat, "project"), vec![one]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rename_refuses_a_locked_internal_taken_or_undeclared_key_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "project", "text", None).await;
    declare(&pool, &mat, "phase", "text", None).await;
    let holder = page(&pool, &mat, "Holder").await;
    set_text(&pool, &mat, &holder, "loose", "x").await;
    settle(&mat).await;
    let before = op_count(&pool).await;

    for (old, new, code) in [
        (
            "project",
            "due_date",
            Some(ValidationCode::BuiltinPropertyLocked),
        ),
        (
            "due_date",
            "area",
            Some(ValidationCode::BuiltinPropertyLocked),
        ),
        ("project", "template", None),
        ("template", "area", None),
        ("project", "phase", None),
        ("project", "loose", None),
        ("project", "project", None),
        ("project", "bad key", None),
    ] {
        let refused = rename(&pool, &mat, old, new).await;
        match refused {
            Err(AppError::Validation { code: got, .. }) => {
                assert_eq!(got, code, "{old} -> {new}");
            }
            other => panic!("{old} -> {new}: expected a refusal, got {other:?}"),
        }
    }
    let undeclared = rename(&pool, &mat, "nothing", "area").await;
    assert!(
        matches!(undeclared, Err(AppError::NotFound(_))),
        "got {undeclared:?}"
    );
    assert_eq!(op_count(&pool).await, before, "no refusal appends an op");
    assert_eq!(props(&pool, &holder).await, vec![kv("loose", "x")]);
}

/// A key only a block in the Trash holds is taken: restoring the block would
/// bring it back beside the renamed values.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rename_refuses_a_key_only_a_trashed_block_holds_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "project", "text", None).await;
    let trashed = page(&pool, &mat, "Gone").await;
    set_text(&pool, &mat, &trashed, "area", "x").await;
    delete_block_inner(&pool, DEV, &mat, BlockId::from_trusted(&trashed))
        .await
        .unwrap();
    settle(&mat).await;
    let before = op_count(&pool).await;

    let refused = rename(&pool, &mat, "project", "area").await;
    assert!(
        matches!(refused, Err(AppError::Validation { code: None, .. })),
        "got {refused:?}"
    );
    assert_eq!(op_count(&pool).await, before);
    assert_eq!(def_row(&pool, "project").await, Some(("text".into(), None)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_renames_back_and_redo_renames_again_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "project", "text", None).await;
    let one = page(&pool, &mat, "One").await;
    set_text(&pool, &mat, &one, "project", "a").await;
    let renamed = rename(&pool, &mat, "project", "area").await.unwrap();

    let undone = undo_ops_inner(&pool, DEV, &mat, renamed.op_refs)
        .await
        .unwrap();
    assert_eq!(undone[0].new_op_type, "rename_property_key");
    assert_eq!(props(&pool, &one).await, vec![kv("project", "a")]);
    assert_eq!(def_row(&pool, "project").await, Some(("text".into(), None)));
    assert_eq!(def_row(&pool, "area").await, None);

    let undo = &undone[0].new_op_ref;
    redo_page_op_inner(&pool, DEV, &mat, undo.device_id.clone(), undo.seq)
        .await
        .unwrap();
    assert_eq!(props(&pool, &one).await, vec![kv("area", "a")]);
    assert_eq!(doc_holders(&mat, "area"), vec![one]);
    assert_eq!(def_row(&pool, "project").await, None);
}

/// Undoing a rename is refused once the space has declared the old key again:
/// renaming back would land on it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_of_a_rename_is_refused_once_the_old_key_is_taken_again_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "project", "text", None).await;
    let renamed = rename(&pool, &mat, "project", "area").await.unwrap();
    declare(&pool, &mat, "project", "number", None).await;

    let refused = undo_ops_inner(&pool, DEV, &mat, renamed.op_refs).await;
    assert!(
        matches!(refused, Err(AppError::Validation { .. })),
        "got {refused:?}"
    );
    assert_eq!(def_row(&pool, "area").await, Some(("text".into(), None)));
    assert_eq!(
        def_row(&pool, "project").await,
        Some(("number".into(), None))
    );
}

// ======================================================================
// Undo of a set or delete follows the key
// ======================================================================

/// A page holding `project = a`, then set to `b` (the returned op), in a
/// space declaring `project`.
async fn set_over_a(pool: &SqlitePool, mat: &Materializer) -> (String, OpRef) {
    space(pool).await;
    declare(pool, mat, "project", "text", None).await;
    let one = page(pool, mat, "One").await;
    set_text(pool, mat, &one, "project", "a").await;
    let set = set_text(pool, mat, &one, "project", "b").await;
    (one, set)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_a_set_after_a_rename_restores_the_value_under_the_new_key_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (one, set) = set_over_a(&pool, &mat).await;
    rename(&pool, &mat, "project", "area").await.unwrap();

    undo_ops_inner(&pool, DEV, &mat, vec![set]).await.unwrap();
    assert_eq!(
        props(&pool, &one).await,
        vec![kv("area", "a")],
        "the prior value, under the key it lives under now"
    );
    assert_eq!(doc_holders(&mat, "project"), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_a_set_from_absent_after_a_rename_removes_the_new_key_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "project", "text", None).await;
    let one = page(&pool, &mat, "One").await;
    let set = set_text(&pool, &mat, &one, "project", "c").await;
    rename(&pool, &mat, "project", "area").await.unwrap();

    let undone = undo_ops_inner(&pool, DEV, &mat, vec![set]).await.unwrap();
    assert_eq!(props(&pool, &one).await, vec![], "neither key");
    assert!(doc_holders(&mat, "area").is_empty());

    let undo = &undone[0].new_op_ref;
    redo_page_op_inner(&pool, DEV, &mat, undo.device_id.clone(), undo.seq)
        .await
        .unwrap();
    assert_eq!(
        props(&pool, &one).await,
        vec![kv("area", "c")],
        "redo sets it again"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_a_delete_after_a_rename_restores_the_value_under_the_new_key_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "project", "text", None).await;
    let one = page(&pool, &mat, "One").await;
    set_text(&pool, &mat, &one, "project", "a").await;
    let deleted = capture_op_refs(delete_property_inner(
        &pool,
        DEV,
        &mat,
        one.as_str().into(),
        "project".into(),
    ))
    .await
    .unwrap();
    rename(&pool, &mat, "project", "area").await.unwrap();

    undo_ops_inner(&pool, DEV, &mat, deleted.op_refs)
        .await
        .unwrap();
    assert_eq!(props(&pool, &one).await, vec![kv("area", "a")]);
}

/// A redo after a rename writes under the key the rename moved the value to.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redoing_a_set_after_a_rename_follows_the_key_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (one, set) = set_over_a(&pool, &mat).await;
    let undone = undo_ops_inner(&pool, DEV, &mat, vec![set]).await.unwrap();
    rename(&pool, &mat, "project", "area").await.unwrap();

    let undo = &undone[0].new_op_ref;
    redo_page_op_inner(&pool, DEV, &mat, undo.device_id.clone(), undo.seq)
        .await
        .unwrap();
    assert_eq!(props(&pool, &one).await, vec![kv("area", "b")]);
}

/// Ctrl+Z on the page reaches the set, not the rename: the rename is filed
/// under the space.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn positional_undo_after_a_rename_follows_the_key_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (one, _) = set_over_a(&pool, &mat).await;
    rename(&pool, &mat, "project", "area").await.unwrap();

    let undone = undo_page_op_inner(&pool, DEV, &mat, one.clone(), 0)
        .await
        .unwrap();
    assert_eq!(undone.reversed_op_type, "set_property");
    assert_eq!(props(&pool, &one).await, vec![kv("area", "a")]);
}

/// One undo of the set and the rename: the rename is undone first, so the
/// set's walk sees the key go and come back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_a_set_and_the_rename_together_lands_on_the_old_key_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (one, set) = set_over_a(&pool, &mat).await;
    let renamed = rename(&pool, &mat, "project", "area").await.unwrap();

    undo_ops_inner(&pool, DEV, &mat, [vec![set], renamed.op_refs].concat())
        .await
        .unwrap();
    assert_eq!(props(&pool, &one).await, vec![kv("project", "a")]);
    assert_eq!(def_row(&pool, "area").await, None);
    assert_eq!(doc_holders(&mat, "project"), vec![one]);
}

/// Delete `key` on `block`; the op's ref.
async fn delete_key(pool: &SqlitePool, mat: &Materializer, block: &str, key: &str) -> OpRef {
    capture_op_refs(delete_property_inner(
        pool,
        DEV,
        mat,
        block.into(),
        key.into(),
    ))
    .await
    .unwrap()
    .op_refs[0]
        .clone()
}

/// A rename onto a name a deleted value once had leaves that value's undo
/// behind on the name the rename vacated: undoing the rename, then Ctrl+Z on
/// the delete, puts each value back under its own key.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_a_delete_of_a_name_a_rename_reused_keeps_both_values_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "project", "text", None).await;
    let p = page(&pool, &mat, "P").await;
    set_text(&pool, &mat, &p, "project", "mine").await;
    set_text(&pool, &mat, &p, "area", "old").await;
    delete_key(&pool, &mat, &p, "area").await;
    let renamed = rename(&pool, &mat, "project", "area").await.unwrap();
    undo_ops_inner(&pool, DEV, &mat, renamed.op_refs)
        .await
        .unwrap();

    let undone = undo_page_op_inner(&pool, DEV, &mat, p.clone(), 0)
        .await
        .unwrap();
    assert_eq!(undone.reversed_op_type, "delete_property");
    assert_eq!(
        props(&pool, &p).await,
        vec![kv("area", "old"), kv("project", "mine")]
    );
    assert_eq!(doc_holders(&mat, "area"), vec![p.clone()]);
    assert_eq!(doc_holders(&mat, "project"), vec![p]);
}

/// Undoing everything newest first through a rename onto a reused name: the
/// undo of the delete lands on the reused name, not on the key the rename
/// moved there.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_newest_first_through_a_rename_onto_a_reused_name_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "k1", "text", None).await;
    let p = page(&pool, &mat, "P").await;
    let set_k1 = set_text(&pool, &mat, &p, "k1", "s1").await;
    let first = rename(&pool, &mat, "k1", "n2").await.unwrap();
    let set_n1 = set_text(&pool, &mat, &p, "n1", "v1").await;
    let delete_n1 = delete_key(&pool, &mat, &p, "n1").await;
    let reuse = rename(&pool, &mat, "n2", "n1").await.unwrap();
    assert_eq!(props(&pool, &p).await, vec![kv("n1", "s1")]);

    let undo = |ops: Vec<OpRef>| undo_ops_inner(&pool, DEV, &mat, ops);
    undo(reuse.op_refs).await.unwrap();
    assert_eq!(props(&pool, &p).await, vec![kv("n2", "s1")]);
    undo(vec![delete_n1]).await.unwrap();
    assert_eq!(
        props(&pool, &p).await,
        vec![kv("n1", "v1"), kv("n2", "s1")],
        "the deleted value is back under its own key, beside the renamed one"
    );
    undo(vec![set_n1]).await.unwrap();
    assert_eq!(props(&pool, &p).await, vec![kv("n2", "s1")]);
    undo(first.op_refs).await.unwrap();
    assert_eq!(props(&pool, &p).await, vec![kv("k1", "s1")]);
    undo(vec![set_k1]).await.unwrap();
    assert_eq!(props(&pool, &p).await, vec![]);
}

// ======================================================================
// Merge
// ======================================================================

/// `stage` (select `a`) and `phase` (select `b`): X holds stage only, Y
/// phase only, Z both.
async fn stage_and_phase(pool: &SqlitePool, mat: &Materializer) -> (String, String, String) {
    space(pool).await;
    declare(pool, mat, "stage", "select", Some(r#"["a"]"#)).await;
    declare(pool, mat, "phase", "select", Some(r#"["b"]"#)).await;
    let (x, y, z) = (
        page(pool, mat, "X").await,
        page(pool, mat, "Y").await,
        page(pool, mat, "Z").await,
    );
    set_text(pool, mat, &x, "stage", "a").await;
    set_text(pool, mat, &y, "phase", "b").await;
    set_text(pool, mat, &z, "stage", "a").await;
    set_text(pool, mat, &z, "phase", "b").await;
    (x, y, z)
}

async fn merge(
    pool: &SqlitePool,
    mat: &Materializer,
    from: &str,
    into: &str,
    moved: i64,
    dropped: i64,
) -> Result<WithOps<PropertyDefinition>, AppError> {
    capture_op_refs(merge_property_key_inner(
        pool,
        DEV,
        mat,
        TEST_SPACE_ID,
        from.into(),
        into.into(),
        PropertyMergeCounts { moved, dropped },
    ))
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_moves_values_keeps_the_target_where_held_and_unions_options_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (x, y, z) = stage_and_phase(&pool, &mat).await;

    let preview =
        preview_property_merge_inner(&pool, TEST_SPACE_ID, "stage".into(), "phase".into())
            .await
            .unwrap();
    assert_eq!(
        preview,
        PropertyMergeCounts {
            moved: 1,
            dropped: 1
        }
    );

    let merged = merge(&pool, &mat, "stage", "phase", 1, 1).await.unwrap();
    assert_eq!(merged.op_refs.len(), 1, "a merge is one op");
    assert_eq!(merged.inner.key, "phase");
    assert_eq!(merged.inner.options.as_deref(), Some(r#"["b","a"]"#));
    assert_eq!(props(&pool, &x).await, vec![kv("phase", "a")], "moved");
    assert_eq!(props(&pool, &y).await, vec![kv("phase", "b")], "untouched");
    assert_eq!(
        props(&pool, &z).await,
        vec![kv("phase", "b")],
        "keeps phase"
    );
    assert_eq!(def_row(&pool, "stage").await, None);
    assert!(doc_holders(&mat, "stage").is_empty(), "and in the doc");
    assert_eq!(
        doc_holders(&mat, "phase"),
        sorted(vec![x.clone(), y.clone(), z.clone()])
    );

    undo_ops_inner(&pool, DEV, &mat, merged.op_refs)
        .await
        .unwrap();
    assert_eq!(props(&pool, &x).await, vec![kv("stage", "a")]);
    assert_eq!(props(&pool, &y).await, vec![kv("phase", "b")]);
    assert_eq!(
        props(&pool, &z).await,
        vec![kv("phase", "b"), kv("stage", "a")],
        "the dropped value is back"
    );
    assert_eq!(
        def_row(&pool, "stage").await,
        Some(("select".into(), Some(r#"["a"]"#.into())))
    );
    assert_eq!(
        def_row(&pool, "phase").await,
        Some(("select".into(), Some(r#"["b"]"#.into())))
    );
}

/// Undoing a set after a merge follows a moved value to the target key, and
/// leaves a dropped one under its own key, where the undo brings it back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_a_set_after_a_merge_follows_a_moved_value_only_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "stage", "text", None).await;
    declare(&pool, &mat, "phase", "text", None).await;
    let (moved, dropped) = (
        page(&pool, &mat, "Moved").await,
        page(&pool, &mat, "Dropped").await,
    );
    set_text(&pool, &mat, &moved, "stage", "m0").await;
    let set_moved = set_text(&pool, &mat, &moved, "stage", "m1").await;
    set_text(&pool, &mat, &dropped, "phase", "p").await;
    set_text(&pool, &mat, &dropped, "stage", "d0").await;
    let set_dropped = set_text(&pool, &mat, &dropped, "stage", "d1").await;
    merge(&pool, &mat, "stage", "phase", 1, 1).await.unwrap();

    undo_ops_inner(&pool, DEV, &mat, vec![set_moved, set_dropped])
        .await
        .unwrap();
    assert_eq!(props(&pool, &moved).await, vec![kv("phase", "m0")]);
    assert_eq!(
        props(&pool, &dropped).await,
        vec![kv("phase", "p"), kv("stage", "d0")]
    );
}

/// A value a merge moved into a key a delete had emptied is not the deleted
/// value: one undo of the delete and the merge puts each back where it was.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_a_delete_and_a_merge_into_its_key_restores_both_values_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "stage", "text", None).await;
    declare(&pool, &mat, "phase", "text", None).await;
    let x = page(&pool, &mat, "X").await;
    set_text(&pool, &mat, &x, "stage", "s").await;
    set_text(&pool, &mat, &x, "phase", "p").await;
    let deleted = capture_op_refs(delete_property_inner(
        &pool,
        DEV,
        &mat,
        x.as_str().into(),
        "phase".into(),
    ))
    .await
    .unwrap();
    let merged = merge(&pool, &mat, "stage", "phase", 1, 0).await.unwrap();

    undo_ops_inner(&pool, DEV, &mat, [deleted.op_refs, merged.op_refs].concat())
        .await
        .unwrap();
    assert_eq!(
        props(&pool, &x).await,
        vec![kv("phase", "p"), kv("stage", "s")]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_refuses_a_stale_acknowledgement_and_a_type_mismatch_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (x, _, _) = stage_and_phase(&pool, &mat).await;
    declare(&pool, &mat, "count", "number", None).await;
    let before = op_count(&pool).await;

    let stale = merge(&pool, &mat, "stage", "phase", 1, 0).await;
    assert_eq!(
        stale.err().and_then(|e| e.validation_code()),
        Some(ValidationCode::UnacknowledgedPropertyLoss)
    );
    for (from, into, code) in [
        ("stage", "count", None),
        ("stage", "stage", None),
        (
            "stage",
            "priority",
            Some(ValidationCode::BuiltinPropertyLocked),
        ),
        ("template", "phase", None),
        ("stage", "template", None),
    ] {
        match merge(&pool, &mat, from, into, 1, 1).await {
            Err(AppError::Validation { code: got, .. }) => assert_eq!(got, code, "{from}->{into}"),
            other => panic!("{from} -> {into}: expected a refusal, got {other:?}"),
        }
        let preview =
            preview_property_merge_inner(&pool, TEST_SPACE_ID, from.into(), into.into()).await;
        assert!(preview.is_err(), "the preview refuses {from} -> {into} too");
    }
    let undeclared = merge(&pool, &mat, "nothing", "phase", 0, 0).await;
    assert!(
        matches!(undeclared, Err(AppError::NotFound(_))),
        "got {undeclared:?}"
    );
    assert_eq!(op_count(&pool).await, before, "no refusal appends an op");
    assert_eq!(props(&pool, &x).await, vec![kv("stage", "a")]);
}

/// The merge reads the doc, not SQL: a value SQL cannot show (text under a
/// number key) moves with the rest and stays hidden, rather than staying
/// under a key no longer declared, where a reprojection would show it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_moves_a_value_only_the_doc_holds_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "hours", "number", None).await;
    declare(&pool, &mat, "effort2", "number", None).await;
    let x = page(&pool, &mat, "X").await;
    mat.loro_state()
        .registry
        .for_space(&SpaceId::from_trusted(TEST_SPACE_ID), DEV)
        .unwrap()
        .engine_mut()
        .apply_set_property(&x, "hours", Some("about two"))
        .unwrap();
    assert_eq!(
        props(&pool, &x).await,
        vec![],
        "SQL drops what the type can't hold"
    );

    merge(&pool, &mat, "hours", "effort2", 0, 0).await.unwrap();
    assert!(
        doc_holders(&mat, "hours").is_empty(),
        "nothing left under the old key"
    );
    assert_eq!(doc_holders(&mat, "effort2"), vec![x.clone()], "it moved");
    assert_eq!(props(&pool, &x).await, vec![], "and stays hidden");
}

/// `block`'s `(key, value_ref)` rows, by key.
async fn ref_props(pool: &SqlitePool, block: &str) -> Vec<(String, Option<String>)> {
    sqlx::query_as(
        "SELECT key, value_ref FROM block_properties \
         WHERE block_id = ? AND key <> 'is_space' ORDER BY key",
    )
    .bind(block)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// `block`'s value of `key` in [`TEST_SPACE_ID`]'s doc.
fn doc_value(mat: &Materializer, block: &str, key: &str) -> Option<String> {
    mat.loro_state()
        .registry
        .for_space(&SpaceId::from_trusted(TEST_SPACE_ID), DEV)
        .unwrap()
        .engine_mut()
        .read_property_holders(key)
        .unwrap()
        .into_iter()
        .find(|(id, _)| id == block)
        .map(|(_, value)| format!("{value:?}"))
}

/// A target value only the doc holds (a ref whose target was purged) does not
/// stop a value the preview counts as moved from moving; the merge records it,
/// so the undo puts it back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_moves_a_value_over_a_target_value_only_the_doc_holds_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "rel", "ref", None).await;
    declare(&pool, &mat, "see", "ref", None).await;
    let (x, live, gone) = (
        page(&pool, &mat, "X").await,
        page(&pool, &mat, "Live").await,
        page(&pool, &mat, "Gone").await,
    );
    for (key, target) in [("rel", &live), ("see", &gone)] {
        set_property_inner(
            &pool,
            DEV,
            &mat,
            x.as_str().into(),
            key.into(),
            None,
            None,
            None,
            Some(target.clone()),
            None,
            None,
        )
        .await
        .unwrap();
    }
    delete_block_inner(&pool, DEV, &mat, BlockId::from_trusted(&gone))
        .await
        .unwrap();
    purge_block_inner(&pool, DEV, &mat, BlockId::from_trusted(&gone))
        .await
        .unwrap();
    settle(&mat).await;
    assert_eq!(
        ref_props(&pool, &x).await,
        vec![("rel".to_owned(), Some(live.clone()))]
    );
    let hidden = doc_value(&mat, &x, "see");
    assert!(hidden.is_some(), "the doc still holds `see`");
    let preview = preview_property_merge_inner(&pool, TEST_SPACE_ID, "rel".into(), "see".into())
        .await
        .unwrap();
    assert_eq!(
        preview,
        PropertyMergeCounts {
            moved: 1,
            dropped: 0
        }
    );

    let merged = merge(&pool, &mat, "rel", "see", 1, 0).await.unwrap();
    assert_eq!(
        ref_props(&pool, &x).await,
        vec![("see".to_owned(), Some(live.clone()))],
        "moved, as the preview said"
    );
    assert_eq!(doc_value(&mat, &x, "rel"), None);

    undo_ops_inner(&pool, DEV, &mat, merged.op_refs)
        .await
        .unwrap();
    assert_eq!(
        ref_props(&pool, &x).await,
        vec![("rel".to_owned(), Some(live))]
    );
    assert_eq!(
        doc_value(&mat, &x, "see"),
        hidden,
        "the hidden value is back"
    );
}

/// The agenda names the key a date came from, so a rename rebuilds it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_renamed_date_lists_under_its_new_key_in_the_agenda_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "deadline", "date", None).await;
    let one = page(&pool, &mat, "One").await;
    set_property_inner(
        &pool,
        DEV,
        &mat,
        one.as_str().into(),
        "deadline".into(),
        None,
        None,
        Some("2026-11-03".into()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;
    let source = || async {
        sqlx::query_scalar::<_, String>("SELECT source FROM agenda_cache WHERE block_id = ?")
            .bind(&one)
            .fetch_all(&pool)
            .await
            .unwrap()
    };
    assert_eq!(source().await, vec!["property:deadline".to_owned()]);

    rename(&pool, &mat, "deadline", "due_on").await.unwrap();
    settle(&mat).await;
    assert_eq!(source().await, vec!["property:due_on".to_owned()]);
}
