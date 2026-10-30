//! Renaming a select property's option (#5841 S4).

use super::prelude::*;
use agaric_core::error::ValidationCode;
use agaric_engine::loro::engine::PropertyValue;
use agaric_store::op::OpRef;

const STAGE_OPTIONS: &str = r#"["draft","review","done"]"#;

/// [`TEST_SPACE_ID`] as a registered space with a doc of its own, declaring
/// `stage` as a select of [`STAGE_OPTIONS`].
async fn stage_space(pool: &SqlitePool, mat: &Materializer) {
    ensure_test_space(pool).await;
    mark_block_as_space(pool, TEST_SPACE_ID).await;
    declare(pool, mat, "stage", "select", Some(STAGE_OPTIONS)).await;
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

async fn page(pool: &SqlitePool, mat: &Materializer, title: &str) -> String {
    create_page_in_space_inner(pool, DEV, mat, None, title.into(), TEST_SPACE_ID.into())
        .await
        .unwrap()
        .as_str()
        .to_owned()
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

async fn trash(pool: &SqlitePool, mat: &Materializer, block: &str) {
    delete_block_inner(pool, DEV, mat, BlockId::from_trusted(block))
        .await
        .unwrap();
    settle(mat).await;
}

/// `block`'s properties as `(key, text)`, by key.
async fn props(pool: &SqlitePool, block: &str) -> Vec<(String, String)> {
    sqlx::query_as(
        "SELECT key, value_text FROM block_properties \
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

/// [`TEST_SPACE_ID`]'s options for `key`, `None` when it declares no `key`.
async fn options(pool: &SqlitePool, key: &str) -> Option<String> {
    sqlx::query_scalar("SELECT options FROM property_definitions WHERE space_id = ? AND key = ?")
        .bind(TEST_SPACE_ID)
        .bind(key)
        .fetch_optional(pool)
        .await
        .unwrap()
}

/// `block`'s `key` value in [`TEST_SPACE_ID`]'s doc.
fn doc_value(mat: &Materializer, block: &str, key: &str) -> Option<PropertyValue> {
    mat.loro_state()
        .registry
        .for_space(&SpaceId::from_trusted(TEST_SPACE_ID), DEV)
        .unwrap()
        .engine_mut()
        .read_property_holders(key)
        .unwrap()
        .into_iter()
        .find(|(id, _)| id == block)
        .map(|(_, value)| value)
}

fn doc_options(mat: &Materializer, key: &str) -> Option<String> {
    mat.loro_state()
        .registry
        .for_space(&SpaceId::from_trusted(TEST_SPACE_ID), DEV)
        .unwrap()
        .engine_mut()
        .read_property_def(key)
        .unwrap()
        .and_then(|def| def.options)
}

fn text(value: &str) -> Option<PropertyValue> {
    Some(PropertyValue::Str(value.to_owned()))
}

async fn op_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn rename_option(
    pool: &SqlitePool,
    mat: &Materializer,
    key: &str,
    old: &str,
    new: &str,
) -> Result<WithOps<PropertyDefinition>, AppError> {
    capture_op_refs(rename_property_option_inner(
        pool,
        DEV,
        mat,
        TEST_SPACE_ID,
        key.into(),
        old.into(),
        new.into(),
    ))
    .await
}

async fn undo(
    pool: &SqlitePool,
    mat: &Materializer,
    refs: Vec<OpRef>,
) -> Result<Vec<UndoResult>, AppError> {
    undo_ops_inner(pool, DEV, mat, refs).await
}

// ======================================================================
// Rename
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rename_renames_the_option_in_place_and_every_value_the_trash_included_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    stage_space(&pool, &mat).await;
    let (one, two, gone) = (
        page(&pool, &mat, "One").await,
        page(&pool, &mat, "Two").await,
        page(&pool, &mat, "Gone").await,
    );
    for (block, value) in [(&one, "review"), (&two, "draft"), (&gone, "review")] {
        set_text(&pool, &mat, block, "stage", value).await;
    }
    set_text(&pool, &mat, &two, "note", "review").await;
    trash(&pool, &mat, &gone).await;

    let renamed = rename_option(&pool, &mat, "stage", "review", "in_review")
        .await
        .unwrap();
    let in_place = Some(r#"["draft","in_review","done"]"#.to_owned());
    assert_eq!(renamed.inner.options, in_place, "the definition after");
    assert_eq!(renamed.op_refs.len(), 1, "a rename is one op");
    let (op_type, block_id): (String, Option<String>) =
        sqlx::query_as("SELECT op_type, block_id FROM op_log WHERE device_id = ? AND seq = ?")
            .bind(&renamed.op_refs[0].device_id)
            .bind(renamed.op_refs[0].seq)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(op_type, "rename_property_option");
    assert_eq!(
        block_id.as_deref(),
        Some(TEST_SPACE_ID),
        "filed under its space"
    );

    assert_eq!(props(&pool, &one).await, vec![kv("stage", "in_review")]);
    assert_eq!(
        props(&pool, &gone).await,
        vec![kv("stage", "in_review")],
        "the Trash's value too"
    );
    assert_eq!(
        props(&pool, &two).await,
        vec![kv("note", "review"), kv("stage", "draft")],
        "another option, and the old name under another key, stay"
    );
    assert_eq!(
        options(&pool, "stage").await,
        in_place,
        "the options in place"
    );
    assert_eq!(
        doc_value(&mat, &one, "stage"),
        text("in_review"),
        "the doc too"
    );
    assert_eq!(doc_value(&mat, &gone, "stage"), text("in_review"));
    assert_eq!(doc_options(&mat, "stage"), in_place);
}

/// Each refusal, in the order the mock mirrors: a case that breaks a later
/// rule too is refused by the earlier one. None appends an op or changes a
/// row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rename_refuses_in_order_and_appends_nothing_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    stage_space(&pool, &mat).await;
    declare(&pool, &mat, "prose", "text", None).await;
    let (one, gone) = (
        page(&pool, &mat, "One").await,
        page(&pool, &mat, "Gone").await,
    );
    set_text(&pool, &mat, &one, "stage", "review").await;
    set_text(&pool, &mat, &gone, "stage", "done").await;
    update_property_def_options_inner(
        &pool,
        DEV,
        &mat,
        TEST_SPACE_ID,
        "stage".into(),
        r#"["draft","review"]"#.into(),
    )
    .await
    .unwrap();
    trash(&pool, &mat, &gone).await;
    let before = op_count(&pool).await;

    let locked = Some(ValidationCode::BuiltinPropertyLocked);
    for (key, old, new, code, message) in [
        (
            "priority",
            "1",
            "  ",
            locked,
            "property 'priority' is built in and cannot be changed",
        ),
        ("todo_state", "DONE", "FINISHED", locked, "is built in"),
        (
            "template",
            "a",
            "a",
            None,
            "property 'template' is the app's own and cannot be changed",
        ),
        ("nothing", "a", " \n", None, "an option cannot be empty"),
        ("nothing", "a", "a", None, "'a' cannot be renamed to itself"),
        (
            "prose",
            "zzz",
            "draft",
            None,
            "'prose' is a text property; only a select has options",
        ),
        (
            "stage",
            "zzz",
            "draft",
            None,
            "'zzz' is not an option of 'stage'",
        ),
        (
            "stage",
            "review",
            "draft",
            None,
            "'draft' is already an option of 'stage'",
        ),
        (
            "stage",
            "review",
            "done",
            None,
            "'done' is already held by 1 block(s) of this space, the Trash included",
        ),
    ] {
        match rename_option(&pool, &mat, key, old, new).await {
            Err(AppError::Validation {
                code: got,
                message: msg,
            }) => {
                assert_eq!(got, code, "{key}: {old} -> {new}");
                assert!(msg.contains(message), "{key}: {old} -> {new}: got {msg:?}");
            }
            other => panic!("{key}: {old} -> {new}: expected a refusal, got {other:?}"),
        }
    }
    let undeclared = rename_option(&pool, &mat, "nothing", "a", "b").await;
    assert!(
        matches!(&undeclared, Err(AppError::NotFound(m)) if m == "property definition 'nothing'"),
        "got {undeclared:?}"
    );
    assert_eq!(op_count(&pool).await, before, "no refusal appends an op");
    assert_eq!(props(&pool, &one).await, vec![kv("stage", "review")]);
    assert_eq!(
        options(&pool, "stage").await.as_deref(),
        Some(r#"["draft","review"]"#)
    );
}

/// Boot replay applies the rename a second time; it finds nothing left to
/// rename, so values and options stay as the first apply left them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replayed_rename_changes_nothing_more_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    stage_space(&pool, &mat).await;
    let one = page(&pool, &mat, "One").await;
    set_text(&pool, &mat, &one, "stage", "review").await;
    let renamed = rename_option(&pool, &mat, "stage", "review", "in_review")
        .await
        .unwrap();
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
    assert_eq!(props(&pool, &one).await, vec![kv("stage", "in_review")]);
    assert_eq!(
        options(&pool, "stage").await.as_deref(),
        Some(r#"["draft","in_review","done"]"#)
    );
}

// ======================================================================
// Undo of the rename
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_renames_back_in_place_and_redo_renames_again_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    stage_space(&pool, &mat).await;
    let (one, gone) = (
        page(&pool, &mat, "One").await,
        page(&pool, &mat, "Gone").await,
    );
    set_text(&pool, &mat, &one, "stage", "review").await;
    set_text(&pool, &mat, &gone, "stage", "review").await;
    trash(&pool, &mat, &gone).await;
    let renamed = rename_option(&pool, &mat, "stage", "review", "in_review")
        .await
        .unwrap();

    let undone = undo(&pool, &mat, renamed.op_refs).await.unwrap();
    assert_eq!(undone[0].new_op_type, "rename_property_option");
    assert_eq!(props(&pool, &one).await, vec![kv("stage", "review")]);
    assert_eq!(props(&pool, &gone).await, vec![kv("stage", "review")]);
    assert_eq!(
        options(&pool, "stage").await.as_deref(),
        Some(STAGE_OPTIONS),
        "order kept"
    );
    assert_eq!(doc_value(&mat, &one, "stage"), text("review"));

    let undo_ref = &undone[0].new_op_ref;
    redo_page_op_inner(&pool, DEV, &mat, undo_ref.device_id.clone(), undo_ref.seq)
        .await
        .unwrap();
    assert_eq!(props(&pool, &one).await, vec![kv("stage", "in_review")]);
    assert_eq!(
        options(&pool, "stage").await.as_deref(),
        Some(r#"["draft","in_review","done"]"#)
    );
}

/// The undo renames back whatever holds the new name now: a value set since
/// goes back too, and a renamed value edited since keeps its edit.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_renames_back_later_writes_of_the_new_name_and_keeps_later_edits_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    stage_space(&pool, &mat).await;
    let (one, two, three) = (
        page(&pool, &mat, "One").await,
        page(&pool, &mat, "Two").await,
        page(&pool, &mat, "Three").await,
    );
    set_text(&pool, &mat, &one, "stage", "review").await;
    set_text(&pool, &mat, &two, "stage", "review").await;
    let renamed = rename_option(&pool, &mat, "stage", "review", "in_review")
        .await
        .unwrap();
    set_text(&pool, &mat, &two, "stage", "done").await;
    set_text(&pool, &mat, &three, "stage", "in_review").await;

    undo(&pool, &mat, renamed.op_refs).await.unwrap();
    assert_eq!(props(&pool, &one).await, vec![kv("stage", "review")]);
    assert_eq!(
        props(&pool, &two).await,
        vec![kv("stage", "done")],
        "the edit stays"
    );
    assert_eq!(
        props(&pool, &three).await,
        vec![kv("stage", "review")],
        "a value written as the new name since goes back with the option"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_is_refused_once_the_old_name_is_an_option_again_or_the_definition_is_gone_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    stage_space(&pool, &mat).await;
    let one = page(&pool, &mat, "One").await;
    set_text(&pool, &mat, &one, "stage", "review").await;
    let renamed = rename_option(&pool, &mat, "stage", "review", "in_review")
        .await
        .unwrap();
    let again = r#"["draft","in_review","done","review"]"#;
    update_property_def_options_inner(
        &pool,
        DEV,
        &mat,
        TEST_SPACE_ID,
        "stage".into(),
        again.into(),
    )
    .await
    .unwrap();
    let before = op_count(&pool).await;

    let refused = undo(&pool, &mat, renamed.op_refs.clone()).await;
    assert!(
        matches!(&refused, Err(AppError::Validation { message, .. })
            if message == "'review' is already an option of 'stage'"),
        "got {refused:?}"
    );
    assert_eq!(
        op_count(&pool).await,
        before,
        "a refused undo appends nothing"
    );
    assert_eq!(props(&pool, &one).await, vec![kv("stage", "in_review")]);

    // The definition goes only once no block holds the key.
    delete_property_inner(&pool, DEV, &mat, one.as_str().into(), "stage".into())
        .await
        .unwrap();
    delete_property_def_inner(&pool, DEV, &mat, TEST_SPACE_ID, "stage".into())
        .await
        .unwrap();
    let before = op_count(&pool).await;
    let refused = undo(&pool, &mat, renamed.op_refs).await;
    assert!(
        matches!(&refused, Err(AppError::NotFound(m)) if m == "property definition 'stage'"),
        "got {refused:?}"
    );
    assert_eq!(
        op_count(&pool).await,
        before,
        "a refused undo appends nothing"
    );
}

/// The undo follows the key through a later key rename and renames back
/// under the key the definition has now.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_after_a_key_rename_renames_back_under_the_new_key_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    stage_space(&pool, &mat).await;
    let one = page(&pool, &mat, "One").await;
    set_text(&pool, &mat, &one, "stage", "review").await;
    let renamed = rename_option(&pool, &mat, "stage", "review", "in_review")
        .await
        .unwrap();
    rename_property_key_inner(
        &pool,
        DEV,
        &mat,
        TEST_SPACE_ID,
        "stage".into(),
        "phase".into(),
    )
    .await
    .unwrap();

    let undone = undo(&pool, &mat, renamed.op_refs).await.unwrap();
    assert_eq!(props(&pool, &one).await, vec![kv("phase", "review")]);
    assert_eq!(
        options(&pool, "phase").await.as_deref(),
        Some(STAGE_OPTIONS)
    );
    assert_eq!(
        options(&pool, "stage").await,
        None,
        "no definition comes back"
    );
    assert_eq!(doc_value(&mat, &one, "phase"), text("review"));
    let payload: String =
        sqlx::query_scalar("SELECT payload FROM op_log WHERE device_id = ? AND seq = ?")
            .bind(&undone[0].new_op_ref.device_id)
            .bind(undone[0].new_op_ref.seq)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        payload.contains(r#""key":"phase""#),
        "the undo records the key it renamed under, so a replay agrees: {payload}"
    );
}

/// One undo of the option rename and the key rename after it: the key rename
/// is undone first, so the walk sees the key go and come back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_an_option_rename_and_a_key_rename_together_restores_both_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    stage_space(&pool, &mat).await;
    let one = page(&pool, &mat, "One").await;
    set_text(&pool, &mat, &one, "stage", "review").await;
    let renamed = rename_option(&pool, &mat, "stage", "review", "in_review")
        .await
        .unwrap();
    let key_renamed = capture_op_refs(rename_property_key_inner(
        &pool,
        DEV,
        &mat,
        TEST_SPACE_ID,
        "stage".into(),
        "phase".into(),
    ))
    .await
    .unwrap();

    undo(&pool, &mat, [renamed.op_refs, key_renamed.op_refs].concat())
        .await
        .unwrap();
    assert_eq!(props(&pool, &one).await, vec![kv("stage", "review")]);
    assert_eq!(
        options(&pool, "stage").await.as_deref(),
        Some(STAGE_OPTIONS)
    );
    assert_eq!(options(&pool, "phase").await, None);
}

// ======================================================================
// Undo of a set follows the value
// ======================================================================

/// A value set before the rename comes back under its new name, and one equal
/// to the new name from before the rename is not mapped back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_an_earlier_set_maps_the_value_through_the_rename_one_way_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    stage_space(&pool, &mat).await;
    let with_new_name = r#"["draft","review","done","in_review"]"#;
    update_property_def_options_inner(
        &pool,
        DEV,
        &mat,
        TEST_SPACE_ID,
        "stage".into(),
        with_new_name.into(),
    )
    .await
    .unwrap();
    let (one, two) = (
        page(&pool, &mat, "One").await,
        page(&pool, &mat, "Two").await,
    );
    set_text(&pool, &mat, &one, "stage", "review").await;
    let to_done = set_text(&pool, &mat, &one, "stage", "done").await;
    set_text(&pool, &mat, &two, "stage", "in_review").await;
    let to_draft = set_text(&pool, &mat, &two, "stage", "draft").await;
    update_property_def_options_inner(
        &pool,
        DEV,
        &mat,
        TEST_SPACE_ID,
        "stage".into(),
        STAGE_OPTIONS.into(),
    )
    .await
    .unwrap();
    rename_option(&pool, &mat, "stage", "review", "in_review")
        .await
        .unwrap();

    undo(&pool, &mat, vec![to_done]).await.unwrap();
    assert_eq!(
        props(&pool, &one).await,
        vec![kv("stage", "in_review")],
        "the prior value, under the name it has now"
    );
    assert_eq!(doc_value(&mat, &one, "stage"), text("in_review"));

    undo(&pool, &mat, vec![to_draft]).await.unwrap();
    assert_eq!(
        props(&pool, &two).await,
        vec![kv("stage", "in_review")],
        "an older value equal to the new name is not the renamed option"
    );
}

/// The walk follows the key first and then the option renamed under it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_an_earlier_set_follows_a_key_rename_then_an_option_rename_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    stage_space(&pool, &mat).await;
    let one = page(&pool, &mat, "One").await;
    set_text(&pool, &mat, &one, "stage", "review").await;
    let to_done = set_text(&pool, &mat, &one, "stage", "done").await;
    rename_property_key_inner(
        &pool,
        DEV,
        &mat,
        TEST_SPACE_ID,
        "stage".into(),
        "phase".into(),
    )
    .await
    .unwrap();
    rename_option(&pool, &mat, "phase", "review", "in_review")
        .await
        .unwrap();

    undo(&pool, &mat, vec![to_done]).await.unwrap();
    assert_eq!(props(&pool, &one).await, vec![kv("phase", "in_review")]);
}
