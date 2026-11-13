//! #6544 — a saved view is a page carrying the internal `saved_view` property.
//! Every page list, search and query leaves it out, and it holds no page name;
//! its property, its id and the Trash still reach it.

use crate::prelude::*;
use agaric_core::error::ValidationCode;
use agaric_lib::commands::pages::{
    ListPagesWithMetadataFilter, PageSort, list_pages_with_metadata_inner, record_page_open_inner,
};
use agaric_lib::commands::queries::search_blocks_partitioned_inner;
use agaric_store::query::{AdvancedQueryRequest, compile_and_run};

/// A space holding the page `Weekly plan`, the saved view `Weekly review` and
/// the trashed saved view `Old view`.
struct Vault {
    pool: SqlitePool,
    mat: Materializer,
    dir: tempfile::TempDir,
    space: String,
    plan: BlockId,
    view: BlockId,
    trashed: BlockId,
}

async fn vault() -> Vault {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let space = create_space_inner(&pool, DEV, &mat, "Views".into(), None)
        .await
        .unwrap()
        .into_string();
    let mut v = Vault {
        pool,
        mat,
        dir,
        space,
        plan: BlockId::from_trusted("00000000000000000000000000"),
        view: BlockId::from_trusted("00000000000000000000000000"),
        trashed: BlockId::from_trusted("00000000000000000000000000"),
    };
    v.plan = v.page("Weekly plan").await;
    v.view = v.saved_view("Weekly review").await;
    v.trashed = v.saved_view("Old view").await;
    delete_block_inner(&v.pool, DEV, &v.mat, v.trashed.clone())
        .await
        .unwrap();
    settle(&v.mat).await;
    v
}

impl Vault {
    async fn page(&self, title: &str) -> BlockId {
        let page = create_page_in_space_inner(
            &self.pool,
            DEV,
            &self.mat,
            None,
            title.into(),
            self.space.clone(),
        )
        .await
        .unwrap();
        settle(&self.mat).await;
        page
    }

    /// A page made and marked as the frontend saves a view.
    async fn saved_view(&self, title: &str) -> BlockId {
        let page = self.page(title).await;
        set_property_inner(
            &self.pool,
            DEV,
            &self.mat,
            page.as_str().into(),
            "saved_view".into(),
            Some("v1:e30".into()),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        settle(&self.mat).await;
        page
    }

    fn scope(&self) -> SpaceScope {
        SpaceScope::Active(SpaceId::from_trusted(&self.space))
    }

    fn search(&self) -> SearchFilter {
        search_filter(SearchScope::Spaces(vec![SpaceId::from_trusted(
            &self.space,
        )]))
    }

    async fn rename(&self, block: &BlockId, to: &str) -> Result<BlockRow, AppError> {
        let renamed = edit_block_inner(&self.pool, DEV, &self.mat, block.clone(), to.into()).await;
        settle(&self.mat).await;
        renamed
    }

    async fn title(&self, block: &str) -> String {
        sqlx::query_scalar::<_, String>("SELECT content FROM blocks WHERE id = ?")
            .bind(block)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}

fn ids<'a>(rows: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    rows.into_iter().map(str::to_owned).collect()
}

/// The `[[` picker, the graph and the resolve preload read this list.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn all_pages_in_space_leave_a_saved_view_out() {
    let v = vault().await;
    let pages = list_all_pages_in_space_inner(&v.pool, &v.space, None)
        .await
        .unwrap();
    assert_eq!(
        ids(pages.iter().map(|p| p.id.as_str())),
        [v.plan.as_str()],
        "only the page is listed"
    );
    v.mat.shutdown();
}

/// The Pages view and MCP `list_pages`: the rows and `total_count` alike, by
/// title and from the last-opened arm.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pages_metadata_leaves_a_saved_view_out_of_rows_and_count() {
    let v = vault().await;
    for page in [&v.view, &v.plan] {
        record_page_open_inner(&v.pool, page.clone()).await.unwrap();
    }
    for sort in [PageSort::Alphabetical, PageSort::LastOpened] {
        let filter = ListPagesWithMetadataFilter {
            sort,
            space_id: v.space.clone(),
            filters: Vec::new(),
        };
        let resp = list_pages_with_metadata_inner(&v.pool, filter, None, Some(50))
            .await
            .unwrap();
        assert_eq!(
            ids(resp.items.iter().map(|p| p.id.as_str())),
            [v.plan.as_str()],
            "{sort:?}: only the page is listed"
        );
        assert_eq!(
            resp.total_count,
            Some(1),
            "{sort:?}: the count skips it too"
        );
    }
    v.mat.shutdown();
}

/// Search and the palette's partitioned search: both titles hold `weekly`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_leaves_a_saved_view_out() {
    let v = vault().await;
    let resp = search_blocks_inner(&v.pool, "weekly".into(), None, Some(50), v.search(), None)
        .await
        .unwrap();
    assert_eq!(
        ids(resp.items.iter().map(|r| r.id.as_str())),
        [v.plan.as_str()],
        "only the page is a hit"
    );
    let parts = search_blocks_partitioned_inner(&v.pool, "weekly".into(), 10, 10, v.search(), None)
        .await
        .unwrap();
    assert_eq!(
        ids(parts.pages.items.iter().map(|r| r.id.as_str())),
        [v.plan.as_str()],
        "the pages partition"
    );
    assert_eq!(
        ids(parts.blocks.items.iter().map(|r| r.id.as_str())),
        [v.plan.as_str()],
        "the blocks partition"
    );
    v.mat.shutdown();
}

/// A regex search scans blocks without the FTS index.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn regex_search_leaves_a_saved_view_out() {
    let v = vault().await;
    let filter = SearchFilter {
        is_regex: true,
        ..v.search()
    };
    let resp = search_blocks_inner(&v.pool, "Weekly".into(), None, Some(50), filter, None)
        .await
        .unwrap();
    assert_eq!(
        ids(resp.items.iter().map(|r| r.id.as_str())),
        [v.plan.as_str()],
        "only the page is a hit"
    );
    v.mat.shutdown();
}

/// A search with no words lists what its filters match.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn filter_only_search_leaves_a_saved_view_out() {
    let v = vault().await;
    let filter = SearchFilter {
        block_type_filter: Some("page".into()),
        ..v.search()
    };
    let resp = search_blocks_inner(&v.pool, String::new(), None, Some(50), filter, None)
        .await
        .unwrap();
    assert_eq!(
        ids(resp.items.iter().map(|r| r.id.as_str())),
        [v.plan.as_str()],
        "only the page is listed"
    );
    v.mat.shutdown();
}

/// Advanced Query and MCP `query`: a filterless query is the whole space less
/// the view, in the rows and the count.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn advanced_query_leaves_a_saved_view_out() {
    let v = vault().await;
    let request: AdvancedQueryRequest =
        serde_json::from_value(serde_json::json!({ "spaceId": v.space, "limit": 100 })).unwrap();
    let resp = compile_and_run(&v.pool, request).await.unwrap();
    assert_eq!(
        ids(resp.rows.iter().map(|r| r.block.id.as_str())),
        [v.plan.as_str()],
        "only the page is a row"
    );
    assert_eq!(resp.total_count, Some(1), "the count skips it too");
    v.mat.shutdown();
}

/// A `{{query}}` block's pages.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn filtered_blocks_query_leaves_a_saved_view_out() {
    let v = vault().await;
    let resp = filtered_blocks_query_inner(
        &v.pool,
        Vec::new(),
        None,
        Some("page".into()),
        &v.scope(),
        None,
        Some(100),
    )
    .await
    .unwrap();
    assert_eq!(
        ids(resp.items.iter().map(|r| r.id.as_str())),
        [v.plan.as_str()],
        "only the page is listed"
    );
    v.mat.shutdown();
}

/// `list_blocks` by type: the ref-property picker's pages, rows and count.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pages_by_type_leave_a_saved_view_out_of_rows_and_count() {
    let v = vault().await;
    let resp = list_blocks_inner(
        &v.pool,
        None,
        Some("page".into()),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(50),
        v.space.clone(),
    )
    .await
    .unwrap();
    assert_eq!(
        ids(resp.items.iter().map(|r| r.id.as_str())),
        [v.plan.as_str()],
        "only the page is listed"
    );
    assert_eq!(resp.total_count, Some(1), "the count skips it too");
    v.mat.shutdown();
}

/// A view holds no name: a create naming its title makes a new page, and a
/// page may be renamed onto it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_saved_view_holds_no_page_name() {
    let v = vault().await;
    let made = v.page("weekly review").await;
    assert_ne!(made, v.view, "a new page, not the view");
    assert_eq!(v.title(made.as_str()).await, "weekly review");

    v.saved_view("Monthly review").await;
    v.rename(&v.plan, "monthly Review")
        .await
        .expect("the view's title is free for a page");
    v.mat.shutdown();
}

/// A view renamed onto a page's title is refused, so a save names no taken
/// title.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_saved_view_may_not_take_a_pages_title() {
    let v = vault().await;
    let err = v.rename(&v.view, "weekly plan").await.unwrap_err();
    assert_eq!(
        err.validation_code(),
        Some(ValidationCode::DuplicatePageTitle),
        "{err:?}"
    );
    assert_eq!(v.title(v.view.as_str()).await, "Weekly review");
    v.mat.shutdown();
}

/// A view comes back from the Trash while a page holds its title.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_saved_view_restores_while_a_page_holds_its_title() {
    let v = vault().await;
    v.page("Old view").await;
    let deleted_at: i64 = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(v.trashed.as_str())
        .fetch_one(&v.pool)
        .await
        .unwrap();
    restore_block_inner(&v.pool, DEV, &v.mat, v.trashed.clone(), deleted_at)
        .await
        .expect("a view holds no name to clash");
    v.mat.shutdown();
}

/// An imported `[[Weekly review]]` links a new page, not the view.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_imported_link_to_a_saved_views_title_makes_a_new_page() {
    let v = vault().await;
    let result = import_markdown_inner(
        &v.pool,
        DEV,
        &v.mat,
        v.dir.path(),
        "- see [[Weekly review]]\n".into(),
        Some("Notes.md".into()),
        v.space.clone(),
        None,
    )
    .await
    .unwrap();
    settle(&v.mat).await;
    let content: String =
        sqlx::query_scalar("SELECT content FROM blocks WHERE parent_id = ? AND deleted_at IS NULL")
            .bind(&result.page_id)
            .fetch_one(&v.pool)
            .await
            .unwrap();
    let target = content
        .strip_prefix("see [[")
        .and_then(|rest| rest.strip_suffix("]]"))
        .unwrap_or_else(|| panic!("a link: {content}"));
    assert_ne!(target, v.view.as_str(), "the view is not linked");
    assert_eq!(v.title(target).await, "Weekly review");
    v.mat.shutdown();
}

/// What still reaches a view: its property (how the saved-view lists read
/// them), its id (the title path) and the Trash (so it can be restored).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_saved_view_is_read_by_its_property_its_id_and_the_trash() {
    let v = vault().await;
    let by_property = query_by_property_inner(
        &v.pool,
        "saved_view".into(),
        None,
        None,
        None,
        None,
        Some(100),
        &v.scope(),
        None,
        false,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        ids(by_property.items.iter().map(|r| r.id.as_str())),
        [v.view.as_str()],
        "the live view"
    );
    let resolved = batch_resolve_inner(&v.pool, vec![v.view.clone()], &v.scope())
        .await
        .unwrap();
    assert_eq!(
        resolved
            .iter()
            .map(|r| r.title.as_deref())
            .collect::<Vec<_>>(),
        [Some("Weekly review")]
    );
    let trash = list_trash_inner(&v.pool, None, Some(10), v.space.clone())
        .await
        .unwrap();
    assert_eq!(
        ids(trash.items.iter().map(|r| r.id.as_str())),
        [v.trashed.as_str()],
        "the trashed view"
    );
    v.mat.shutdown();
}

impl Vault {
    /// The live blocks still in the vault's space.
    async fn live_in_space(&self) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE space_id = ? AND deleted_at IS NULL")
            .bind(&self.space)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// The `delete_block` ops appended for `block`.
    async fn delete_ops(&self, block: &BlockId) -> i64 {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM op_log WHERE op_type = 'delete_block' AND block_id = ?",
        )
        .bind(block.as_str())
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    /// Whether the space's Loro engine holds `block` deleted.
    fn engine_deleted(&self, block: &BlockId) -> bool {
        let space = SpaceId::from_trusted(&self.space);
        let mut guard = self
            .mat
            .loro_state()
            .registry
            .for_space(&space, DEV)
            .expect("the space's engine");
        guard
            .engine_mut()
            .read_deleted(block.as_str())
            .expect("the engine holds the block")
    }

    /// The `fts_blocks` rows of `block`.
    async fn indexed(&self, block: &BlockId) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM fts_blocks WHERE block_id = ?")
            .bind(block.as_str())
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// The space and the view, in id order: the pages a delete of the space
    /// takes.
    fn space_and_view(&self) -> Vec<&str> {
        let mut pages = vec![self.space.as_str(), self.view.as_str()];
        pages.sort_unstable();
        pages
    }
}

fn sorted(ids: &[String]) -> Vec<&str> {
    let mut ids: Vec<&str> = ids.iter().map(String::as_str).collect();
    ids.sort_unstable();
    ids
}

/// A space whose only live pages are saved views reads as empty in the Spaces
/// tab, so it deletes, and each view goes with it as its own delete, blocks
/// under it too, in SQL, in the engine and in the search index.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_space_holding_only_saved_views_deletes_with_them() {
    let v = vault().await;
    let note = create_block_inner(
        &v.pool,
        DEV,
        &v.mat,
        "content".into(),
        "a note".into(),
        Some(v.view.clone()),
        None,
    )
    .await
    .unwrap()
    .id;
    settle(&v.mat).await;
    delete_block_inner(&v.pool, DEV, &v.mat, v.plan.clone())
        .await
        .unwrap();
    assert_eq!(v.indexed(&note).await, 1, "the note is searchable");

    let deleted = delete_block_inner(&v.pool, DEV, &v.mat, BlockId::from_trusted(&v.space))
        .await
        .expect("a space holding only views deletes");
    settle(&v.mat).await;

    assert_eq!(v.live_in_space().await, 0, "the view went with its space");
    assert_eq!(v.delete_ops(&v.view).await, 1, "the view's delete is an op");
    assert_eq!(
        deleted.descendants_affected, 3,
        "the space, the view, its note"
    );
    assert_eq!(sorted(&deleted.affected_page_ids), v.space_and_view());
    assert!(
        v.engine_deleted(&v.view),
        "the engine took the view's delete"
    );
    assert!(
        v.engine_deleted(&note),
        "and the delete of the note under it"
    );
    assert_eq!(v.indexed(&note).await, 0, "the note left the search index");
    v.mat.shutdown();
}

/// The batch delete takes a space's views with it as the single delete does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_batch_delete_of_a_space_holding_only_saved_views_takes_them() {
    let v = vault().await;
    delete_block_inner(&v.pool, DEV, &v.mat, v.plan.clone())
        .await
        .unwrap();
    let deleted =
        delete_blocks_by_ids_inner(&v.pool, DEV, &v.mat, vec![BlockId::from_trusted(&v.space)])
            .await
            .expect("a space holding only views deletes");
    settle(&v.mat).await;

    assert_eq!(v.live_in_space().await, 0, "the view went with its space");
    assert_eq!(v.delete_ops(&v.view).await, 1, "the view's delete is an op");
    assert_eq!(deleted.deleted_count, 2, "the space and the view");
    assert_eq!(sorted(&deleted.affected_page_ids), v.space_and_view());
    assert!(
        v.engine_deleted(&v.view),
        "the engine took the view's delete"
    );
    v.mat.shutdown();
}

/// A delete of a space that fails after its views went rolls them back: they
/// are live in SQL and in the engine, and their delete ops are not in the log.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_space_delete_leaves_its_views_live() {
    let v = vault().await;
    delete_block_inner(&v.pool, DEV, &v.mat, v.plan.clone())
        .await
        .unwrap();
    // The views' ops are appended before the space's, so the space's is the
    // one that fails. The id is a ULID this test just minted, not user input.
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "CREATE TRIGGER fail_space_delete BEFORE INSERT ON op_log \
         WHEN NEW.op_type = 'delete_block' AND NEW.block_id = '{}' \
         BEGIN SELECT RAISE(ABORT, 'injected space delete failure'); END",
        v.space
    )))
    .execute(&v.pool)
    .await
    .unwrap();

    let err = delete_block_inner(&v.pool, DEV, &v.mat, BlockId::from_trusted(&v.space))
        .await
        .expect_err("the space's own op is refused");
    assert!(
        err.to_string().contains("injected space delete failure"),
        "{err}"
    );
    settle(&v.mat).await;

    assert_eq!(v.live_in_space().await, 1, "the view stayed");
    assert_eq!(
        v.delete_ops(&v.view).await,
        0,
        "its delete op was rolled back"
    );
    assert!(!v.engine_deleted(&v.view), "the engine rewound with SQL");
    v.mat.shutdown();
}

/// A space that still holds a page is refused, counting only what the Spaces
/// tab counts, and its view stays.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_space_holding_a_page_and_a_saved_view_is_refused() {
    let v = vault().await;
    for err in [
        delete_block_inner(&v.pool, DEV, &v.mat, BlockId::from_trusted(&v.space))
            .await
            .map(|_| ())
            .unwrap_err(),
        delete_blocks_by_ids_inner(&v.pool, DEV, &v.mat, vec![BlockId::from_trusted(&v.space)])
            .await
            .map(|_| ())
            .unwrap_err(),
    ] {
        assert!(
            matches!(&err, AppError::InvalidOperation(m) if m.ends_with("it contains 1 pages")),
            "{err:?}"
        );
    }
    assert_eq!(v.live_in_space().await, 2, "the page and the view stay");
    v.mat.shutdown();
}
