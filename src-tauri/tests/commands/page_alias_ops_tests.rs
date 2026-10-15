//! Page aliases as ops (#5387): what `set_page_aliases` appends, how Undo
//! reverses it, and the refusals on both paths.

use crate::prelude::*;
use agaric_core::error::ValidationCode;
use agaric_store::op::OpRef;

/// A page in the test space, made through the commands so its aliases take
/// the engine path.
async fn page(pool: &SqlitePool, mat: &Materializer, title: &str) -> String {
    ensure_test_space(pool).await;
    mark_block_as_space(pool, TEST_SPACE_ID).await;
    create_page_in_space_inner(pool, DEV, mat, None, title.into(), TEST_SPACE_ID.into())
        .await
        .unwrap()
        .into_string()
}

async fn set(
    pool: &SqlitePool,
    mat: &Materializer,
    page_id: &str,
    aliases: &[&str],
) -> Result<WithOps<Vec<String>>, AppError> {
    let aliases = aliases.iter().map(|a| (*a).to_owned()).collect();
    capture_op_refs(set_page_aliases_inner(pool, DEV, mat, page_id, aliases)).await
}

async fn aliases(pool: &SqlitePool, page_id: &str) -> Vec<String> {
    get_page_aliases_inner(pool, page_id).await.unwrap()
}

fn engine_aliases(mat: &Materializer, page_id: &str) -> Vec<String> {
    let space = SpaceId::from_trusted(TEST_SPACE_ID);
    let mut guard = mat.loro_state().registry.for_space(&space, DEV).unwrap();
    let mut held = guard
        .engine_mut()
        .read_page_aliases(page_id)
        .unwrap()
        .unwrap_or_default();
    held.sort();
    held
}

/// `(op_type, alias)` of every op on `page_id` after `after_seq`, in order.
async fn alias_ops_since(
    pool: &SqlitePool,
    page_id: &str,
    after_seq: i64,
) -> Vec<(String, String)> {
    sqlx::query_as::<_, (String, String)>(
        "SELECT op_type, json_extract(payload, '$.alias') FROM op_log \
         WHERE block_id = ? AND seq > ? ORDER BY seq",
    )
    .bind(page_id)
    .bind(after_seq)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn max_seq(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT COALESCE(MAX(seq), 0) FROM op_log")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_alias_edit_removes_then_adds_in_one_tx_and_projects_engine_and_sql() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let p = page(&pool, &mat, "Planning").await;
    set(&pool, &mat, &p, &["Foo", "keep"]).await.unwrap();
    let before = max_seq(&pool).await;

    let resp = set(&pool, &mat, &p, &["foo", "keep", "new"]).await.unwrap();

    assert_eq!(
        resp.inner,
        vec!["foo", "keep", "new"],
        "the wanted list, in order"
    );
    assert_eq!(
        alias_ops_since(&pool, &p, before).await,
        vec![
            ("remove_page_alias".to_owned(), "Foo".to_owned()),
            ("add_page_alias".to_owned(), "foo".to_owned()),
            ("add_page_alias".to_owned(), "new".to_owned()),
        ],
        "a respelling is a remove then an add; the kept alias writes nothing"
    );
    assert_eq!(
        resp.op_refs.len(),
        3,
        "every appended op is captured for undo"
    );
    assert_eq!(aliases(&pool, &p).await, vec!["foo", "keep", "new"]);
    assert_eq!(
        engine_aliases(&mat, &p),
        vec!["foo", "keep", "new"],
        "engine matches SQL"
    );
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_reverts_an_alias_edit_and_page_history_lists_it() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let p = page(&pool, &mat, "Planning").await;
    set(&pool, &mat, &p, &["Foo", "gone"]).await.unwrap();
    let edit = set(&pool, &mat, &p, &["foo", "new"]).await.unwrap();

    undo_ops_inner(&pool, DEV, &mat, edit.op_refs)
        .await
        .unwrap();

    assert_eq!(
        aliases(&pool, &p).await,
        vec!["Foo", "gone"],
        "one Undo reverts the edit"
    );
    assert_eq!(
        engine_aliases(&mat, &p),
        vec!["Foo", "gone"],
        "in the engine too"
    );
    let history = list_page_history_inner(
        &pool,
        p.clone(),
        Some("add_page_alias".into()),
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
        None,
        Some(50),
    )
    .await
    .unwrap();
    assert_eq!(
        history.items.len(),
        6,
        "page history lists the alias adds: two, two from the edit, two from its undo"
    );
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_alias_another_page_holds_is_refused_and_appends_nothing() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let owner = page(&pool, &mat, "Owner").await;
    let other = page(&pool, &mat, "Other").await;
    set(&pool, &mat, &owner, &["Taken"]).await.unwrap();
    set(&pool, &mat, &other, &["mine"]).await.unwrap();
    let before = max_seq(&pool).await;

    let err = set(&pool, &mat, &other, &["taken"]).await.unwrap_err();

    assert_eq!(
        err.validation_code(),
        Some(ValidationCode::DuplicatePageAlias),
        "refused with its code, got {err:?}"
    );
    assert_eq!(max_seq(&pool).await, before, "the whole edit rolled back");
    assert_eq!(
        aliases(&pool, &other).await,
        vec!["mine"],
        "the refused edit kept nothing"
    );
    assert_eq!(
        engine_aliases(&mat, &other),
        vec!["mine"],
        "the engine rolled back too"
    );
    assert_eq!(
        aliases(&pool, &owner).await,
        vec!["Taken"],
        "the holder keeps it"
    );
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aliases_on_a_block_that_is_not_a_page_are_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let p = BlockId::from_trusted(&page(&pool, &mat, "Planning").await);
    let child = append_child(&pool, &mat, &p, "a block").await;

    let err = set(&pool, &mat, child.as_str(), &["x"]).await.unwrap_err();

    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
    assert!(
        aliases(&pool, child.as_str()).await.is_empty(),
        "nothing written"
    );
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_a_removal_is_refused_once_another_page_holds_the_alias() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let a = page(&pool, &mat, "A").await;
    let b = page(&pool, &mat, "B").await;
    set(&pool, &mat, &a, &["shared"]).await.unwrap();
    let removal = set(&pool, &mat, &a, &[]).await.unwrap();
    set(&pool, &mat, &b, &["Shared"]).await.unwrap();

    let err = undo_ops_inner(&pool, DEV, &mat, removal.op_refs)
        .await
        .unwrap_err();

    assert_eq!(
        err.validation_code(),
        Some(ValidationCode::DuplicatePageAlias),
        "re-adding a taken alias is refused, got {err:?}"
    );
    assert!(
        aliases(&pool, &a).await.is_empty(),
        "A did not take it back"
    );
    assert_eq!(aliases(&pool, &b).await, vec!["Shared"], "B keeps it");
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_an_add_on_a_page_that_is_gone_is_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let p = page(&pool, &mat, "Doomed").await;
    let add = set(&pool, &mat, &p, &["x"]).await.unwrap();
    delete_block_inner(&pool, DEV, &mat, BlockId::from_trusted(&p))
        .await
        .unwrap();
    settle(&mat).await;

    let refs: Vec<OpRef> = add.op_refs;
    let err = undo_ops_inner(&pool, DEV, &mat, refs).await.unwrap_err();

    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
    assert_eq!(
        aliases(&pool, &p).await,
        vec!["x"],
        "the alias stays with the trashed page"
    );
    mat.shutdown();
}
