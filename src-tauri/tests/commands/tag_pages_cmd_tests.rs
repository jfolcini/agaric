//! #6755 — a tag's page: the page titled `Tag/<tag>` of the tag's space, made
//! through the tag, moved with the tag's rename, and refused to any other
//! create or rename.
//!
//! Every fixture is built through the production commands and settled.

use super::prelude::*;
use agaric_core::error::ValidationCode;
use agaric_store::space::SpaceId;

struct Fixture {
    pool: SqlitePool,
    mat: Materializer,
    _dir: tempfile::TempDir,
    space: String,
}

async fn fixture() -> Fixture {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let space = create_space_inner(&pool, DEV, &mat, "S".into(), None)
        .await
        .unwrap()
        .into_string();
    settle(&mat).await;
    Fixture {
        pool,
        mat,
        _dir: dir,
        space,
    }
}

impl Fixture {
    async fn tag(&self, name: &str) -> BlockId {
        let scope = SpaceScope::Active(SpaceId::from_trusted(&self.space));
        let tag = create_block_inner_with_space(
            &self.pool,
            DEV,
            &self.mat,
            "tag".into(),
            name.into(),
            None,
            None,
            &scope,
            None,
        )
        .await
        .unwrap();
        settle(&self.mat).await;
        tag.id
    }

    async fn page(&self, title: &str) -> Result<BlockId, AppError> {
        let page = create_page_in_space_inner(
            &self.pool,
            DEV,
            &self.mat,
            None,
            title.into(),
            self.space.clone(),
        )
        .await;
        settle(&self.mat).await;
        page
    }

    async fn tag_page(&self, tag: &BlockId) -> BlockRow {
        let page = create_tag_page_inner(&self.pool, DEV, &self.mat, tag.clone())
            .await
            .unwrap();
        settle(&self.mat).await;
        page
    }

    async fn rename(&self, id: &BlockId, to: &str) -> Result<WithOps<BlockRow>, AppError> {
        let renamed = capture_op_refs(edit_block_inner(
            &self.pool,
            DEV,
            &self.mat,
            id.clone(),
            to.into(),
        ))
        .await;
        settle(&self.mat).await;
        renamed
    }

    async fn content(&self, id: &BlockId) -> String {
        sqlx::query_scalar("SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL")
            .bind(id.as_str())
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// The live pages of the space, by title.
    async fn page_titles(&self) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT content FROM blocks WHERE block_type = 'page' AND deleted_at IS NULL \
             AND space_id = ?1 AND id != ?1 ORDER BY content",
        )
        .bind(&self.space)
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }

    /// The page `Tag/<name>` with no live tag: its tag made it, then went to
    /// the Trash, as a page from before the rule is.
    async fn orphan_page(&self, name: &str) -> BlockId {
        let tag = self.tag(name).await;
        let page = self.tag_page(&tag).await.id;
        delete_block_inner(&self.pool, DEV, &self.mat, tag)
            .await
            .unwrap();
        settle(&self.mat).await;
        page
    }

    /// The live tag of the space named `name`, by id.
    async fn tag_named(&self, name: &str) -> Option<String> {
        sqlx::query_scalar(
            "SELECT id FROM blocks WHERE block_type = 'tag' AND deleted_at IS NULL \
             AND space_id = ? AND content = ?",
        )
        .bind(&self.space)
        .bind(name)
        .fetch_optional(&self.pool)
        .await
        .unwrap()
    }

    async fn op_count(&self) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}

fn code(err: &AppError) -> Option<ValidationCode> {
    err.validation_code()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tag_makes_its_page_under_its_path_in_its_space() {
    let f = fixture().await;
    let tag = f.tag("projects/web").await;

    let page = f.tag_page(&tag).await;

    assert_eq!(page.block_type, "page", "the tag's page is a page");
    assert_eq!(
        page.content.as_deref(),
        Some("Tag/projects/web"),
        "titled by the tag's path"
    );
    let space: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
        .bind(page.id.as_str())
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        space.as_deref(),
        Some(f.space.as_str()),
        "in the tag's space"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_ask_answers_the_same_page_and_appends_nothing() {
    let f = fixture().await;
    let tag = f.tag("book").await;
    let first = f.tag_page(&tag).await;
    let ops = f.op_count().await;

    let second = f.tag_page(&tag).await;

    assert_eq!(second.id, first.id, "the tag has one page");
    assert_eq!(f.op_count().await, ops, "no op for a page that exists");
    assert_eq!(f.page_titles().await, vec!["Tag/book".to_owned()]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_that_was_under_the_path_is_adopted_in_any_case() {
    let f = fixture().await;
    let old = f.orphan_page("Book").await;
    f.rename(&old, "tag/Book").await.unwrap();
    let tag = f.tag("book").await;

    let page = f.tag_page(&tag).await;

    assert_eq!(page.id, old, "the page already under the path is the tag's");
    assert_eq!(
        f.page_titles().await,
        vec!["tag/Book".to_owned()],
        "adopted as it is spelled, nothing created"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tag_page_of_no_live_tag_is_not_found() {
    let f = fixture().await;
    let page = f.page("Plain").await.unwrap();
    let tag = f.tag("gone").await;
    delete_block_inner(&f.pool, DEV, &f.mat, tag.clone())
        .await
        .unwrap();

    for id in [
        page,
        tag,
        BlockId::from_trusted("01HZ00000000000000000000ZZ"),
    ] {
        let err = create_tag_page_inner(&f.pool, DEV, &f.mat, id)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
    }
    assert_eq!(f.page_titles().await, vec!["Plain".to_owned()]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_cannot_be_created_under_the_path() {
    let f = fixture().await;
    f.tag("book").await;

    for title in ["Tag/book", "tag/other", " TAG/x", "Tag/"] {
        let err = f.page(title).await.unwrap_err();
        assert_eq!(
            code(&err),
            Some(ValidationCode::ReservedTagPageTitle),
            "creating {title:?} must be refused; got {err:?}"
        );
    }
    assert_eq!(f.page_titles().await, Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn titles_beside_the_path_are_ordinary() {
    let f = fixture().await;

    for title in ["Tag", "Tags/x", "Notes/Tag/x"] {
        f.page(title).await.unwrap();
    }

    assert_eq!(
        f.page_titles().await,
        vec![
            "Notes/Tag/x".to_owned(),
            "Tag".to_owned(),
            "Tags/x".to_owned()
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn creating_a_title_under_the_path_that_exists_answers_that_page() {
    let f = fixture().await;
    let tag = f.tag("book").await;
    let page = f.tag_page(&tag).await;

    // `[[Tag/book]]` resolves through the create.
    let resolved = f.page("tag/BOOK").await.unwrap();

    assert_eq!(resolved, page.id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_cannot_be_renamed_into_the_path() {
    let f = fixture().await;
    let page = f.page("Plain").await.unwrap();
    let ops = f.op_count().await;

    let err = f.rename(&page, "Tag/plain").await.unwrap_err();

    assert_eq!(code(&err), Some(ValidationCode::ReservedTagPageTitle));
    assert_eq!(f.content(&page).await, "Plain");
    assert_eq!(f.op_count().await, ops, "a refused rename appends no op");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tags_page_does_not_leave_the_path_while_its_tag_lives() {
    let f = fixture().await;
    let tag = f.tag("book").await;
    let page = f.tag_page(&tag).await.id;

    for to in ["Books", "Tag/"] {
        let err = f.rename(&page, to).await.unwrap_err();
        assert_eq!(
            code(&err),
            Some(ValidationCode::ReservedTagPageTitle),
            "renaming the tag's page to {to:?} must be refused; got {err:?}"
        );
    }
    assert_eq!(f.content(&page).await, "Tag/book");
    assert_eq!(f.content(&tag).await, "book");

    f.rename(&page, "tag/Book").await.unwrap();
    assert_eq!(
        f.content(&page).await,
        "tag/Book",
        "the same title respelled"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_under_the_path_whose_tag_is_gone_can_leave_it() {
    let f = fixture().await;
    let tag = f.tag("book").await;
    let page = f.tag_page(&tag).await.id;
    delete_block_inner(&f.pool, DEV, &f.mat, tag).await.unwrap();
    settle(&f.mat).await;

    assert_eq!(
        f.content(&page).await,
        "Tag/book",
        "deleting the tag leaves its page"
    );
    f.rename(&page, "Book notes").await.unwrap();

    assert_eq!(f.content(&page).await, "Book notes");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn renaming_a_tag_moves_its_page_and_one_undo_moves_both_back() {
    let f = fixture().await;
    let tag = f.tag("book").await;
    let child = f.tag("book/novel").await;
    let page = f.tag_page(&tag).await.id;
    let child_page = f.tag_page(&child).await.id;

    let renamed = f.rename(&tag, "Reading").await.unwrap();

    assert_eq!(f.content(&tag).await, "Reading");
    assert_eq!(f.content(&page).await, "Tag/Reading", "the page moved");
    assert_eq!(
        f.content(&child_page).await,
        "Tag/book/novel",
        "a nested tag keeps its name, so its page stays"
    );
    assert_eq!(
        renamed.op_refs.len(),
        2,
        "the tag's edit and its page's, in one transaction"
    );

    undo_ops_inner(&f.pool, DEV, &f.mat, renamed.op_refs)
        .await
        .unwrap();
    settle(&f.mat).await;

    assert_eq!(f.content(&tag).await, "book");
    assert_eq!(f.content(&page).await, "Tag/book");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tag_rename_onto_another_page_is_refused_whole() {
    let f = fixture().await;
    let tag = f.tag("book").await;
    let page = f.tag_page(&tag).await.id;
    let other = f.tag("reading").await;
    let taken = f.tag_page(&other).await.id;
    delete_block_inner(&f.pool, DEV, &f.mat, other)
        .await
        .unwrap();
    settle(&f.mat).await;
    let ops = f.op_count().await;

    let err = f.rename(&tag, "Reading").await.unwrap_err();

    assert_eq!(code(&err), Some(ValidationCode::TagPageTitleTaken));
    assert_eq!(f.content(&tag).await, "book", "the tag keeps its name");
    assert_eq!(f.content(&page).await, "Tag/book");
    assert_eq!(f.content(&taken).await, "Tag/reading");
    assert_eq!(f.op_count().await, ops, "a refused rename appends no op");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tag_renamed_onto_a_waiting_page_adopts_it() {
    let f = fixture().await;
    let other = f.tag("reading").await;
    let waiting = f.tag_page(&other).await.id;
    delete_block_inner(&f.pool, DEV, &f.mat, other)
        .await
        .unwrap();
    let tag = f.tag("book").await;

    let renamed = f.rename(&tag, "reading").await.unwrap();

    assert_eq!(renamed.op_refs.len(), 1, "no page of its own to move");
    assert_eq!(f.tag_page(&tag).await.id, waiting);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tag_rename_onto_another_tags_name_is_refused_as_that_name() {
    let f = fixture().await;
    let tag = f.tag("book").await;
    f.tag_page(&tag).await;
    let other = f.tag("reading").await;
    f.tag_page(&other).await;

    let err = f.rename(&tag, "Reading").await.unwrap_err();

    // The tag's own name clashes, whatever its page would do.
    assert_eq!(
        code(&err),
        Some(ValidationCode::DuplicatePageTitle),
        "got {err:?}"
    );
    assert_eq!(f.content(&tag).await, "book");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn renaming_a_tags_page_renames_its_tag_and_one_undo_moves_both_back() {
    let f = fixture().await;
    let tag = f.tag("book").await;
    let page = f.tag_page(&tag).await.id;

    let renamed = f.rename(&page, "Tag/novel").await.unwrap();

    assert_eq!(f.content(&page).await, "Tag/novel");
    assert_eq!(f.content(&tag).await, "novel", "the tag follows its page");
    assert_eq!(
        renamed.op_refs.len(),
        2,
        "the page's edit and its tag's, in one transaction"
    );

    undo_ops_inner(&f.pool, DEV, &f.mat, renamed.op_refs)
        .await
        .unwrap();
    settle(&f.mat).await;

    assert_eq!(f.content(&page).await, "Tag/book");
    assert_eq!(f.content(&tag).await, "book");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tags_page_renamed_onto_another_tags_name_is_refused_whole() {
    let f = fixture().await;
    let tag = f.tag("book").await;
    let page = f.tag_page(&tag).await.id;
    f.tag("novel").await;
    let ops = f.op_count().await;

    let err = f.rename(&page, "Tag/Novel").await.unwrap_err();

    assert_eq!(
        code(&err),
        Some(ValidationCode::TagPageTitleTaken),
        "got {err:?}"
    );
    assert_eq!(f.content(&page).await, "Tag/book");
    assert_eq!(f.content(&tag).await, "book");
    assert_eq!(f.op_count().await, ops, "a refused rename appends no op");
}

/// The History view reverts one op; a tag's rename and its page's are one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reverting_either_half_of_a_tag_and_page_rename_reverts_both() {
    let f = fixture().await;
    let tag = f.tag("book").await;
    let page = f.tag_page(&tag).await.id;

    for (renamed, to, half) in [
        (&tag, "Reading", 0),
        (&tag, "Reading", 1),
        (&page, "Tag/Reading", 0),
        (&page, "Tag/Reading", 1),
    ] {
        let refs = f.rename(renamed, to).await.unwrap().op_refs;
        assert_eq!(f.tag_named("Reading").await.as_deref(), Some(tag.as_str()));

        let reverted = revert_ops_inner(&f.pool, DEV, &f.mat, vec![refs[half].clone()])
            .await
            .unwrap();
        settle(&f.mat).await;

        assert_eq!(reverted.len(), 2, "both halves report their reverse");
        assert_eq!(
            f.content(&tag).await,
            "book",
            "renaming {renamed:?}, op {half}"
        );
        assert_eq!(
            f.content(&page).await,
            "Tag/book",
            "renaming {renamed:?}, op {half}"
        );
    }
}

/// The positional undo of a tag's page reaches the tag's rename alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_positional_undo_of_a_tag_rename_moves_its_page_back() {
    let f = fixture().await;
    let tag = f.tag("book").await;
    let page = f.tag_page(&tag).await.id;
    f.rename(&tag, "Reading").await.unwrap();

    let undone = undo_page_group_inner(&f.pool, DEV, &f.mat, tag.as_str().to_owned(), 0, 500)
        .await
        .unwrap();
    settle(&f.mat).await;

    assert_eq!(undone.len(), 2);
    assert_eq!(f.content(&tag).await, "book");
    assert_eq!(f.content(&page).await, "Tag/book");
}
