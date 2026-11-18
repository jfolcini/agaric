//! #6755 — a tag's suggested properties: the keys it lists under
//! `tag_properties`, offered on the blocks tagged with it, and a value set on
//! all of them as one undo.
//!
//! Every fixture is built through the production commands and settled.

use super::prelude::*;
use agaric_core::error::ValidationCode;
use agaric_store::op::{PropertyList, PropertyListItem, PropertyValueFields};
use agaric_store::space::SpaceId;

struct Fixture {
    pool: SqlitePool,
    mat: Materializer,
    _dir: tempfile::TempDir,
    space: String,
    book: BlockId,
    novel: BlockId,
    page: BlockId,
}

fn keys(items: &[&str]) -> PropertyValueFields {
    PropertyValueFields {
        value_list: Some(PropertyList(
            items
                .iter()
                .map(|k| PropertyListItem::Text((*k).to_owned()))
                .collect(),
        )),
        ..Default::default()
    }
}

/// A space declaring `stage` (a select of `draft` / `final`) and `isbn`, the
/// tags `book` and `book/novel`, and a page to hold the tagged blocks.
async fn fixture() -> Fixture {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let space = create_space_inner(&pool, DEV, &mat, "S".into(), None)
        .await
        .unwrap()
        .into_string();
    create_property_def_state_inner(
        &pool,
        DEV,
        &mat,
        &space,
        "stage".into(),
        agaric_store::op::PropertyDefState {
            value_type: "select".into(),
            options: Some(r#"["draft","final"]"#.into()),
            multiple: false,
        },
    )
    .await
    .unwrap();
    let scope = SpaceScope::Active(SpaceId::from_trusted(&space));
    let tag = |name: &str| {
        create_block_inner_with_space(
            &pool,
            DEV,
            &mat,
            "tag".into(),
            name.into(),
            None,
            None,
            &scope,
            None,
        )
    };
    let book = tag("book").await.unwrap().id;
    let novel = tag("book/novel").await.unwrap().id;
    let page = create_page_in_space_inner(&pool, DEV, &mat, None, "Shelf".into(), space.clone())
        .await
        .unwrap();
    settle(&mat).await;
    Fixture {
        pool,
        mat,
        _dir: dir,
        space,
        book,
        novel,
        page,
    }
}

impl Fixture {
    async fn set(
        &self,
        block: &BlockId,
        key: &str,
        value: PropertyValueFields,
    ) -> Result<(), AppError> {
        let set = set_property_list_inner(
            &self.pool,
            DEV,
            &self.mat,
            block.as_str().into(),
            key.into(),
            value,
        )
        .await;
        settle(&self.mat).await;
        set.map(|_| ())
    }

    async fn set_text(&self, block: &BlockId, key: &str, text: &str) {
        set_property_inner(
            &self.pool,
            DEV,
            &self.mat,
            block.as_str().into(),
            key.into(),
            Some(text.into()),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        settle(&self.mat).await;
    }

    async fn text(&self, block: &BlockId, key: &str) -> Option<String> {
        get_property_inner(&self.pool, block, key)
            .await
            .unwrap()
            .and_then(|row| row.value_text)
    }

    /// A content block under the shelf page, tagged with `tag` attached.
    async fn tagged(&self, content: &str, tag: &BlockId) -> BlockId {
        let block = append_child(&self.pool, &self.mat, &self.page, content).await;
        add_tag_inner(&self.pool, DEV, &self.mat, block.clone(), tag.clone())
            .await
            .unwrap();
        settle(&self.mat).await;
        block
    }

    async fn suggested(&self, block: &BlockId) -> Vec<(String, String)> {
        list_suggested_properties_inner(&self.pool, block.clone())
            .await
            .unwrap()
            .into_iter()
            .map(|s| (s.key, s.tag_name))
            .collect()
    }

    async fn op_count(&self) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    fn write(&self, value: &str, include_nested: bool, overwrite: bool) -> TaggedBlocksWrite {
        TaggedBlocksWrite {
            tag_id: self.book.clone(),
            key: "stage".into(),
            value: SetPropertyArgs {
                value_text: Some(value.into()),
                ..Default::default()
            },
            include_nested,
            overwrite,
        }
    }

    async fn preview(&self, write: TaggedBlocksWrite) -> Result<TaggedWriteCounts, AppError> {
        preview_set_property_on_tagged_blocks_inner(&self.pool, write).await
    }

    async fn apply(
        &self,
        write: TaggedBlocksWrite,
        acknowledged: TaggedWriteCounts,
    ) -> Result<WithOps<TaggedWriteCounts>, AppError> {
        let done = capture_op_refs(set_property_on_tagged_blocks_inner(
            &self.pool,
            DEV,
            &self.mat,
            write,
            acknowledged,
        ))
        .await;
        settle(&self.mat).await;
        done
    }
}

fn counts(added: i64, changed: i64) -> TaggedWriteCounts {
    TaggedWriteCounts { added, changed }
}

fn assert_validation(result: Result<impl std::fmt::Debug, AppError>, needle: &str) {
    match result {
        Err(AppError::Validation { message, .. }) => {
            assert!(message.contains(needle), "{message:?} names {needle:?}");
        }
        other => panic!("expected a refusal naming {needle:?}, got {other:?}"),
    }
}

/// A tag's `tag_properties` takes a list of keys a user can set and nothing
/// else; a refused write appends no op.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tag_properties_takes_a_list_of_user_keys_6755() {
    let f = fixture().await;
    f.set(&f.book, "tag_properties", keys(&["stage", "isbn"]))
        .await
        .expect("a list of user keys");
    let ops = f.op_count().await;

    for bad in ["bad key", "due_date", "template"] {
        assert_validation(
            f.set(&f.book, "tag_properties", keys(&[bad])).await,
            "lists property keys a user can set",
        );
    }
    let number = PropertyValueFields {
        value_list: Some(PropertyList(vec![PropertyListItem::Num(1.0)])),
        ..Default::default()
    };
    assert_validation(
        f.set(&f.book, "tag_properties", number).await,
        "lists property keys a user can set",
    );
    let single = PropertyValueFields {
        value_text: Some("stage".into()),
        ..Default::default()
    };
    assert_validation(
        f.set(&f.book, "tag_properties", single).await,
        "holds a list",
    );

    assert_eq!(f.op_count().await, ops, "no refused write appended an op");
    let held = get_property_inner(&f.pool, &f.book, "tag_properties")
        .await
        .unwrap()
        .and_then(|row| row.value_list);
    assert_eq!(held, keys(&["stage", "isbn"]).value_list, "the list stands");
}

/// A block directly tagged, attached or inline, is offered its tags' keys and
/// those of the tags their names nest under, each once from the first tag by
/// name, minus the keys it holds. A block that only inherits the tag, one in
/// the Trash and one under a template page are offered nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn suggested_properties_follow_direct_tags_and_name_nesting_6755() {
    let f = fixture().await;
    f.set(&f.book, "tag_properties", keys(&["isbn", "author"]))
        .await
        .unwrap();
    f.set(&f.novel, "tag_properties", keys(&["author", "pages"]))
        .await
        .unwrap();

    let novel = f.tagged("a novel", &f.novel).await;
    f.set_text(&novel, "isbn", "978").await;
    assert_eq!(
        f.suggested(&novel).await,
        [
            ("author".to_owned(), "book".to_owned()),
            ("pages".to_owned(), "book/novel".to_owned()),
        ],
        "book's keys pass on to book/novel; `author` once, from book; `isbn` is held"
    );

    let inline = append_child(
        &f.pool,
        &f.mat,
        &f.page,
        &format!("read #[{}]", f.book.as_str()),
    )
    .await;
    settle(&f.mat).await;
    assert_eq!(
        f.suggested(&inline).await,
        [
            ("isbn".to_owned(), "book".to_owned()),
            ("author".to_owned(), "book".to_owned()),
        ],
        "an inline tag counts; a parent tag is not offered its children's keys"
    );

    let inherited = append_child(&f.pool, &f.mat, &novel, "a chapter").await;
    settle(&f.mat).await;
    assert_eq!(
        f.suggested(&inherited).await,
        [],
        "an inherited tag offers nothing"
    );

    let trashed = f.tagged("gone", &f.book).await;
    delete_block_inner(&f.pool, DEV, &f.mat, trashed.clone())
        .await
        .unwrap();
    settle(&f.mat).await;
    assert_eq!(
        f.suggested(&trashed).await,
        [],
        "the Trash is offered nothing"
    );

    let template =
        create_page_in_space_inner(&f.pool, DEV, &f.mat, None, "T".into(), f.space.clone())
            .await
            .unwrap();
    f.set_text(&template, "template", "true").await;
    let placeholder = append_child(&f.pool, &f.mat, &template, "slot").await;
    add_tag_inner(&f.pool, DEV, &f.mat, placeholder.clone(), f.book.clone())
        .await
        .unwrap();
    settle(&f.mat).await;
    assert_eq!(
        f.suggested(&placeholder).await,
        [],
        "a template page's blocks are offered nothing"
    );
}

/// The preview counts the live blocks tagged with the tag (and, asked, with
/// a nested tag) that lack the key, and with overwrite those holding another
/// value; the write refuses a stale count or a value its definition refuses,
/// writes the rest as one undo, and leaves the Trash and template pages be.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_on_tagged_blocks_counts_writes_and_undoes_as_one_6755() {
    let f = fixture().await;
    let bare = f.tagged("bare", &f.book).await;
    let held = f.tagged("held", &f.book).await;
    f.set_text(&held, "stage", "draft").await;
    let same = f.tagged("same", &f.book).await;
    f.set_text(&same, "stage", "final").await;
    let nested = f.tagged("nested", &f.novel).await;
    let trashed = f.tagged("trashed", &f.book).await;
    delete_block_inner(&f.pool, DEV, &f.mat, trashed.clone())
        .await
        .unwrap();
    let template =
        create_page_in_space_inner(&f.pool, DEV, &f.mat, None, "T".into(), f.space.clone())
            .await
            .unwrap();
    f.set_text(&template, "template", "true").await;
    let placeholder = append_child(&f.pool, &f.mat, &template, "slot").await;
    add_tag_inner(&f.pool, DEV, &f.mat, placeholder.clone(), f.book.clone())
        .await
        .unwrap();
    settle(&f.mat).await;

    assert_eq!(
        f.preview(f.write("final", false, false)).await.unwrap(),
        counts(1, 0)
    );
    assert_eq!(
        f.preview(f.write("final", true, false)).await.unwrap(),
        counts(2, 0)
    );
    assert_eq!(
        f.preview(f.write("final", false, true)).await.unwrap(),
        counts(1, 1),
        "the value `same` holds already does not change"
    );
    assert_eq!(
        f.preview(f.write("final", true, true)).await.unwrap(),
        counts(2, 1)
    );

    let ops = f.op_count().await;
    let stale = f.apply(f.write("final", true, true), counts(1, 0)).await;
    assert_eq!(
        stale.unwrap_err().validation_code(),
        Some(ValidationCode::UnacknowledgedPropertyLoss),
        "a stale count is refused"
    );
    assert_validation(
        f.apply(f.write("someday", true, true), counts(2, 1)).await,
        "not in allowed options",
    );
    assert_eq!(f.op_count().await, ops, "no refused write appended an op");

    let done = f
        .apply(f.write("final", true, true), counts(2, 1))
        .await
        .unwrap();
    assert_eq!(done.inner, counts(2, 1));
    assert_eq!(done.op_refs.len(), 3, "one set_property per block written");
    for block in [&bare, &held, &same, &nested] {
        assert_eq!(f.text(block, "stage").await.as_deref(), Some("final"));
    }
    assert_eq!(
        f.text(&trashed, "stage").await,
        None,
        "the Trash is untouched"
    );
    assert_eq!(
        f.text(&placeholder, "stage").await,
        None,
        "a template is untouched"
    );

    undo_ops_inner(&f.pool, DEV, &f.mat, done.op_refs)
        .await
        .unwrap();
    settle(&f.mat).await;
    assert_eq!(f.text(&bare, "stage").await, None, "one undo takes it off");
    assert_eq!(
        f.text(&nested, "stage").await,
        None,
        "every block of the batch"
    );
    assert_eq!(
        f.text(&held, "stage").await.as_deref(),
        Some("draft"),
        "and puts an overwritten value back"
    );
    assert_eq!(f.text(&same, "stage").await.as_deref(), Some("final"));
}

/// Without overwrite a block holding the key keeps its value; nested off
/// leaves a nested tag's blocks be.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_on_tagged_blocks_keeps_held_values_and_nested_tags_by_default_6755() {
    let f = fixture().await;
    let bare = f.tagged("bare", &f.book).await;
    let held = f.tagged("held", &f.book).await;
    f.set_text(&held, "stage", "draft").await;
    let nested = f.tagged("nested", &f.novel).await;

    let done = f
        .apply(f.write("final", false, false), counts(1, 0))
        .await
        .unwrap();
    assert_eq!(done.op_refs.len(), 1);
    assert_eq!(f.text(&bare, "stage").await.as_deref(), Some("final"));
    assert_eq!(f.text(&held, "stage").await.as_deref(), Some("draft"));
    assert_eq!(f.text(&nested, "stage").await, None);

    let ops = f.op_count().await;
    let nothing = f
        .apply(f.write("final", false, false), counts(0, 0))
        .await
        .unwrap();
    assert_eq!(nothing.op_refs.len(), 0, "nothing left to write: no op");
    assert_eq!(f.op_count().await, ops);
}

/// A tag that is not one, a built-in key and a key the app keeps for itself
/// are refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_on_tagged_blocks_refuses_a_missing_tag_and_app_keys_6755() {
    let f = fixture().await;
    let mut write = f.write("final", false, false);
    write.tag_id = f.page.clone();
    assert!(
        matches!(f.preview(write).await, Err(AppError::NotFound(_))),
        "a page is not a tag"
    );
    let mut write = f.write("TODO", false, false);
    write.key = "todo_state".into();
    assert_eq!(
        f.preview(write).await.unwrap_err().validation_code(),
        Some(ValidationCode::BuiltinPropertyLocked)
    );
    let mut write = f.write("x", false, false);
    write.key = "tag_properties".into();
    assert_validation(f.preview(write).await, "the app's own");
}

/// A write one undo could not take back is refused before anything is
/// written. The tagged blocks are seeded straight into `blocks` and
/// `block_tags`: a thousand created through the commands would take minutes,
/// and the refusal comes before any engine apply.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_on_tagged_blocks_over_one_undo_is_refused_6755() {
    let f = fixture().await;
    let over = 1001;
    for i in 0..over {
        let id = format!("01J{i:023}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?1, 'content', 'x', ?2, ?3, ?2, ?4)",
        )
        .bind(&id)
        .bind(f.page.as_str())
        .bind(i + 1)
        .bind(&f.space)
        .execute(&f.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(&id)
            .bind(f.book.as_str())
            .execute(&f.pool)
            .await
            .unwrap();
    }
    let ops = f.op_count().await;
    let refused = capture_op_refs(set_property_on_tagged_blocks_inner(
        &f.pool,
        DEV,
        &f.mat,
        f.write("final", false, false),
        counts(over, 0),
    ))
    .await;
    assert_validation(refused, "more than one undo can take back");
    assert_eq!(f.op_count().await, ops, "nothing was written");
}
