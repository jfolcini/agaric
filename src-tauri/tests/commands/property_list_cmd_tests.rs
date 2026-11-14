//! #6741 — a property that holds a list: one value in the one row, taken only
//! by a key its space declares `multiple`.
//!
//! Every fixture is built through the production commands, and every write is
//! followed by `settle`, whose saved-rows oracle rebuilds each engine from its
//! `loro_doc_state` and `loro_doc_delta` rows and compares it with the live
//! one.

use super::prelude::*;
use agaric_engine::loro::engine::PropertyValue;
use agaric_store::op::{
    OpRef, PropertyDefState, PropertyList, PropertyListItem, PropertyValueFields,
};
use agaric_store::space::SpaceId;

const GONE: &str = "01HZ0000000000000000000G0N";

struct Fixture {
    pool: SqlitePool,
    mat: Materializer,
    _dir: tempfile::TempDir,
    a: String,
    b: String,
    page: BlockId,
    child: BlockId,
    target: BlockId,
    other: BlockId,
    foreign: BlockId,
}

fn texts(items: &[&str]) -> PropertyList {
    PropertyList(
        items
            .iter()
            .map(|item| PropertyListItem::Text((*item).to_owned()))
            .collect(),
    )
}

fn nums(items: &[f64]) -> PropertyList {
    PropertyList(items.iter().copied().map(PropertyListItem::Num).collect())
}

fn list_def(value_type: &str, options: Option<&str>) -> PropertyDefState {
    PropertyDefState {
        value_type: value_type.into(),
        options: options.map(str::to_owned),
        multiple: true,
    }
}

/// Two spaces. A declares a list key of every item type, and one key that
/// holds a single value; B declares `kept` as A does, `shape` as text that
/// holds one value where A's holds a list, and nothing else of these. A holds
/// a page with a child and two more pages, B one page.
async fn fixture() -> Fixture {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let a = create_space_inner(&pool, DEV, &mat, "A".into(), None)
        .await
        .unwrap()
        .into_string();
    let b = create_space_inner(&pool, DEV, &mat, "B".into(), None)
        .await
        .unwrap()
        .into_string();
    for (space, key, def) in [
        (&a, "authors", list_def("text", None)),
        (&a, "scores", list_def("number", None)),
        (&a, "read", list_def("date", None)),
        (&a, "related", list_def("ref", None)),
        (
            &a,
            "stages",
            list_def("select", Some(r#"["draft","review"]"#)),
        ),
        (&a, "kept", list_def("text", None)),
        (&b, "kept", list_def("text", None)),
        (&a, "shape", list_def("text", None)),
        (
            &b,
            "shape",
            PropertyDefState {
                multiple: false,
                ..list_def("text", None)
            },
        ),
        (
            &a,
            "single",
            PropertyDefState {
                multiple: false,
                ..list_def("text", None)
            },
        ),
    ] {
        create_property_def_state_inner(&pool, DEV, &mat, space, key.into(), def)
            .await
            .unwrap_or_else(|e| panic!("declare {key}: {e:?}"));
    }
    let page_in = |space: &String, title: &str| {
        create_page_in_space_inner(&pool, DEV, &mat, None, title.into(), space.clone())
    };
    let page = page_in(&a, "Book").await.unwrap();
    let target = page_in(&a, "Ann").await.unwrap();
    let other = page_in(&a, "Bob").await.unwrap();
    let foreign = page_in(&b, "Elsewhere").await.unwrap();
    let child = append_child(&pool, &mat, &page, "note").await;
    settle(&mat).await;
    Fixture {
        pool,
        mat,
        _dir: dir,
        a,
        b,
        page,
        child,
        target,
        other,
        foreign,
    }
}

impl Fixture {
    async fn set_fields(
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

    async fn set_list(
        &self,
        block: &BlockId,
        key: &str,
        list: PropertyList,
    ) -> Result<(), AppError> {
        let value = PropertyValueFields {
            value_list: Some(list),
            ..Default::default()
        };
        self.set_fields(block, key, value).await
    }

    /// The list `get_properties` shows for `block` under `key`: `None` with
    /// no row, and a panic for a row that holds anything else.
    async fn list(&self, block: &BlockId, key: &str) -> Option<PropertyList> {
        let row = get_properties_inner(&self.pool, block.clone())
            .await
            .unwrap()
            .into_iter()
            .find(|row| row.key == key)?;
        assert_eq!(
            (
                &row.value_text,
                row.value_num,
                &row.value_date,
                &row.value_ref,
                row.value_bool
            ),
            (&None, None, &None, &None, None),
            "a list row fills no other column"
        );
        Some(row.value_list.expect("a list row holds its list"))
    }

    /// What `space`'s doc holds for `block` under `key`.
    fn engine_value(&self, space: &str, block: &BlockId, key: &str) -> Option<PropertyValue> {
        let mut guard = self
            .mat
            .loro_state()
            .registry
            .for_space(&SpaceId::from_trusted(space), DEV)
            .expect("the space's doc");
        guard
            .engine_mut()
            .read_property_typed(block.as_str(), key)
            .expect("read the property")
    }

    async fn op_count(&self) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// The newest op of `op_type` whose payload names `key`.
    async fn last_op(&self, op_type: &str, key: &str) -> (OpRef, serde_json::Value) {
        let (seq, payload): (i64, String) = sqlx::query_as(
            "SELECT seq, payload FROM op_log \
             WHERE device_id = ?1 AND op_type = ?2 AND json_extract(payload, '$.key') = ?3 \
             ORDER BY seq DESC LIMIT 1",
        )
        .bind(DEV)
        .bind(op_type)
        .bind(key)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        let op_ref = OpRef {
            device_id: DEV.into(),
            seq,
        };
        (op_ref, serde_json::from_str(&payload).unwrap())
    }

    async fn undo(&self, op_ref: OpRef) {
        undo_op_inner(&self.pool, DEV, &self.mat, op_ref)
            .await
            .expect("undo");
        settle(&self.mat).await;
    }

    async fn trash_and_purge(&self, block: &BlockId) {
        delete_block_inner(&self.pool, DEV, &self.mat, block.clone())
            .await
            .unwrap();
        settle(&self.mat).await;
        purge_block_inner(&self.pool, DEV, &self.mat, block.clone())
            .await
            .unwrap();
        settle(&self.mat).await;
    }
}

fn assert_refused(result: Result<(), AppError>, message: &str) {
    match result {
        Err(AppError::Validation { message: got, .. }) => {
            assert!(got.contains(message), "expected {message:?}, got {got:?}");
        }
        other => panic!("expected a Validation naming {message:?}, got {other:?}"),
    }
}

/// A list written through the `set_property` command's list path reads back,
/// item for item, through each property read, and is what the space's doc
/// holds. The op carries the list, and what it replaced as its `prior`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_list_reads_back_through_the_reads_and_the_engine_6741() {
    let f = fixture().await;
    let authors = texts(&["Smith, John", "Doe"]);
    f.set_list(&f.child, "authors", authors.clone())
        .await
        .unwrap();
    f.set_list(&f.child, "scores", nums(&[2.5, 4.0]))
        .await
        .unwrap();

    assert_eq!(f.list(&f.child, "authors").await, Some(authors.clone()));
    assert_eq!(f.list(&f.child, "scores").await, Some(nums(&[2.5, 4.0])));
    let one = get_property_inner(&f.pool, &f.child, "authors")
        .await
        .unwrap()
        .expect("the row");
    assert_eq!(one.value_list, Some(authors.clone()), "get_property");
    let batch = get_batch_properties_inner(&f.pool, vec![f.child.clone()])
        .await
        .unwrap();
    let batched = batch[f.child.as_str()]
        .iter()
        .find(|row| row.key == "authors")
        .expect("the row");
    assert_eq!(
        batched.value_list,
        Some(authors.clone()),
        "get_batch_properties"
    );
    assert_eq!(
        f.engine_value(&f.a, &f.child, "authors"),
        Some(PropertyValue::List(authors.clone())),
        "the doc holds the list as one value"
    );
    let (_, first) = f.last_op("set_property", "authors").await;
    assert_eq!(
        first["value_list"],
        serde_json::json!(["Smith, John", "Doe"])
    );
    assert_eq!(
        first["prior"],
        serde_json::json!({
            "value_text": null, "value_num": null, "value_date": null,
            "value_ref": null, "value_bool": null,
        }),
        "the first set replaced nothing"
    );

    f.set_list(&f.child, "authors", texts(&["Doe"]))
        .await
        .unwrap();
    assert_eq!(f.list(&f.child, "authors").await, Some(texts(&["Doe"])));
    let (_, second) = f.last_op("set_property", "authors").await;
    assert_eq!(
        second["prior"]["value_list"],
        serde_json::json!(["Smith, John", "Doe"]),
        "the second set records the list it replaced"
    );
}

/// Only a key its space declares `multiple` takes a list, and such a key
/// takes nothing else. A refused write appends no op and writes no row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_list_is_taken_only_by_a_definition_that_holds_one_6741() {
    let f = fixture().await;
    let ops = f.op_count().await;
    let list = || texts(&["a", "b"]);

    for key in ["undeclared", "single", "repeat", "todo_state", "due_date"] {
        assert_refused(
            f.set_list(&f.child, key, list()).await,
            "holds one value, not a list",
        );
    }
    let two_values = PropertyValueFields {
        value_text: Some("a".into()),
        value_list: Some(list()),
        ..Default::default()
    };
    assert_refused(
        f.set_fields(&f.child, "authors", two_values).await,
        "exactly 1 non-null value field, found 2",
    );
    let single_under_list = set_property_inner(
        &f.pool,
        DEV,
        &f.mat,
        f.child.as_str().into(),
        "authors".into(),
        Some("Ann".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .map(|_| ());
    assert_refused(single_under_list, "holds a list");
    assert_refused(
        f.set_list(&f.child, "authors", PropertyList(Vec::new()))
            .await,
        "set_property.value_list.empty",
    );

    assert_eq!(f.op_count().await, ops, "no refused write appended an op");
    assert_eq!(
        get_properties_inner(&f.pool, f.child.clone())
            .await
            .unwrap()
            .len(),
        0,
        "and none wrote a row"
    );
}

/// Each item is held to the definition's type as a single value is.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_item_is_held_to_the_definitions_type_6741() {
    let f = fixture().await;
    let lower = f.target.as_str().to_ascii_lowercase();
    for (key, refused, message) in [
        ("scores", texts(&["3"]), "expects a list of 'number'"),
        ("authors", nums(&[3.0]), "expects a list of 'text'"),
        (
            "read",
            texts(&["2026-10-31", "2026-13-01"]),
            "expects a list of 'date'",
        ),
        (
            "related",
            texts(&["not a block id"]),
            "expects a list of 'ref'",
        ),
        ("related", texts(&[&lower]), "expects a list of 'ref'"),
        (
            "stages",
            texts(&["draft", "published"]),
            "not in allowed options",
        ),
    ] {
        assert_refused(f.set_list(&f.child, key, refused).await, message);
    }
    for (key, taken) in [
        ("scores", nums(&[3.0])),
        ("read", texts(&["2026-10-31"])),
        ("related", texts(&[f.target.as_str()])),
        ("stages", texts(&["review", "draft"])),
    ] {
        f.set_list(&f.child, key, taken.clone()).await.unwrap();
        assert_eq!(f.list(&f.child, key).await, Some(taken), "{key}");
    }
}

/// A list of refs is refused when one item is a block of another space, as a
/// single ref is.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_ref_item_in_another_space_is_refused_6741() {
    let f = fixture().await;
    let ops = f.op_count().await;
    assert_refused(
        f.set_list(
            &f.child,
            "related",
            texts(&[f.target.as_str(), f.foreign.as_str()]),
        )
        .await,
        "cross-space ref property",
    );
    assert_eq!(f.op_count().await, ops, "nothing was appended");
    assert_eq!(f.list(&f.child, "related").await, None);
}

/// A list of refs shows only the items whose target has a row, as the
/// foreign key drops a single dangling ref. The doc keeps the list whole.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_ref_list_shows_only_the_items_whose_target_has_a_row_6741() {
    let f = fixture().await;
    let written = texts(&[f.target.as_str(), GONE, f.other.as_str()]);
    f.set_list(&f.child, "related", written.clone())
        .await
        .unwrap();
    f.set_list(&f.page, "related", texts(&[GONE]))
        .await
        .unwrap();

    assert_eq!(
        f.list(&f.child, "related").await,
        Some(texts(&[f.target.as_str(), f.other.as_str()])),
        "the dangling item is left out, the order kept"
    );
    assert_eq!(
        f.list(&f.page, "related").await,
        None,
        "a list with no item left is no row"
    );
    assert_eq!(
        f.engine_value(&f.a, &f.child, "related"),
        Some(PropertyValue::List(written)),
        "the doc keeps the dangling id"
    );
}

/// Undoing a set restores the list it replaced, and undoing the first set
/// removes the property.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_of_a_set_restores_the_list_it_replaced_6741() {
    let f = fixture().await;
    f.set_list(&f.child, "authors", texts(&["Ann"]))
        .await
        .unwrap();
    let (first, _) = f.last_op("set_property", "authors").await;
    f.set_list(&f.child, "authors", texts(&["Ann", "Bob"]))
        .await
        .unwrap();
    let (second, _) = f.last_op("set_property", "authors").await;

    f.undo(second).await;
    assert_eq!(f.list(&f.child, "authors").await, Some(texts(&["Ann"])));
    assert_eq!(
        f.engine_value(&f.a, &f.child, "authors"),
        Some(PropertyValue::List(texts(&["Ann"])))
    );

    f.undo(first).await;
    assert_eq!(f.list(&f.child, "authors").await, None);
}

/// A delete records the list it removed, and its undo restores it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_of_a_delete_restores_the_list_6741() {
    let f = fixture().await;
    let scores = nums(&[1.5, 2.0]);
    f.set_list(&f.child, "scores", scores.clone())
        .await
        .unwrap();
    delete_property_inner(
        &f.pool,
        DEV,
        &f.mat,
        f.child.as_str().into(),
        "scores".into(),
    )
    .await
    .unwrap();
    settle(&f.mat).await;
    assert_eq!(f.list(&f.child, "scores").await, None, "deleted");
    let (delete, payload) = f.last_op("delete_property", "scores").await;
    assert_eq!(
        payload["prior"]["value_list"],
        serde_json::json!([1.5, 2.0]),
        "the delete records the list"
    );

    f.undo(delete).await;
    assert_eq!(f.list(&f.child, "scores").await, Some(scores.clone()));
    assert_eq!(
        f.engine_value(&f.a, &f.child, "scores"),
        Some(PropertyValue::List(scores))
    );
}

/// A move to a space that does not declare the key the same way drops the
/// list, once acknowledged, and its undo restores it: the target declares
/// `authors` not at all, and `shape` with the same type but one value. A list
/// under a key both spaces declare alike moves with the page into the target
/// space's doc.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_space_move_drops_a_list_its_undo_restores_and_carries_one_both_declare_6741() {
    let f = fixture().await;
    let authors = texts(&["Ann", "Bob"]);
    let kept = texts(&["stays"]);
    f.set_list(&f.page, "authors", authors.clone())
        .await
        .unwrap();
    f.set_list(&f.page, "kept", kept.clone()).await.unwrap();
    f.set_list(&f.page, "shape", texts(&["round"]))
        .await
        .unwrap();
    let losses = preview_space_move_inner(&f.pool, vec![f.page.clone()], f.b.clone())
        .await
        .unwrap();
    assert_eq!(
        losses,
        ["authors", "shape"].map(|key| PropertyLoss {
            key: key.into(),
            count: 1
        }),
        "the key B does not declare, and the one it declares to hold one value"
    );
    let detail = list_property_loss_values_inner(
        &f.pool,
        vec![f.page.clone()],
        f.b.clone(),
        "authors".into(),
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        detail
            .items
            .iter()
            .map(|v| v.value_list.clone())
            .collect::<Vec<_>>(),
        [Some(authors.clone())],
        "the detail shows the list the move would drop"
    );

    // The group undo joins ops closer than its window, passed below, so the
    // fixture's own writes must be older than that.
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    move_blocks_to_space_inner(
        &f.pool,
        DEV,
        &f.mat,
        vec![f.page.clone()],
        f.b.clone(),
        &losses,
    )
    .await
    .unwrap();
    settle(&f.mat).await;
    assert_eq!(f.list(&f.page, "authors").await, None, "dropped");
    assert_eq!(f.list(&f.page, "shape").await, None, "dropped");
    assert_eq!(f.list(&f.page, "kept").await, Some(kept.clone()), "carried");
    assert_eq!(
        f.engine_value(&f.b, &f.page, "kept"),
        Some(PropertyValue::List(kept)),
        "B's doc was seeded with the list from its row"
    );

    undo_page_group_inner(&f.pool, DEV, &f.mat, f.page.to_string(), 0, 500)
        .await
        .unwrap();
    settle(&f.mat).await;
    assert_eq!(f.list(&f.page, "authors").await, Some(authors.clone()));
    assert_eq!(f.list(&f.page, "shape").await, Some(texts(&["round"])));
    assert_eq!(
        f.engine_value(&f.a, &f.page, "authors"),
        Some(PropertyValue::List(authors)),
        "back in A's doc"
    );
}

/// Purging a block takes it out of the lists of refs holding it, and removes
/// the row of a list it was the only item of.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purging_a_target_takes_it_out_of_the_lists_holding_it_6741() {
    let f = fixture().await;
    f.set_list(
        &f.child,
        "related",
        texts(&[f.target.as_str(), f.other.as_str()]),
    )
    .await
    .unwrap();
    f.set_list(&f.page, "related", texts(&[f.target.as_str()]))
        .await
        .unwrap();
    // A text list that names the block's id is no list of refs.
    f.set_list(&f.page, "authors", texts(&[f.target.as_str()]))
        .await
        .unwrap();

    f.trash_and_purge(&f.target).await;

    assert_eq!(
        f.list(&f.child, "related").await,
        Some(texts(&[f.other.as_str()])),
        "the purged block left the list"
    );
    assert_eq!(
        f.list(&f.page, "related").await,
        None,
        "the emptied list has no row"
    );
    assert_eq!(
        f.list(&f.page, "authors").await,
        Some(texts(&[f.target.as_str()])),
        "a text list keeps its string"
    );
}

/// Emptying the Trash does the same through its own purge chain.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn emptying_the_trash_takes_its_blocks_out_of_the_lists_holding_them_6741() {
    let f = fixture().await;
    f.set_list(
        &f.child,
        "related",
        texts(&[f.target.as_str(), f.other.as_str()]),
    )
    .await
    .unwrap();
    f.set_list(&f.page, "related", texts(&[f.target.as_str()]))
        .await
        .unwrap();
    delete_block_inner(&f.pool, DEV, &f.mat, f.target.clone())
        .await
        .unwrap();
    settle(&f.mat).await;

    purge_all_deleted_inner(&f.pool, DEV, &f.mat).await.unwrap();
    settle(&f.mat).await;

    assert_eq!(
        f.list(&f.child, "related").await,
        Some(texts(&[f.other.as_str()]))
    );
    assert_eq!(f.list(&f.page, "related").await, None);
}

/// Renaming a select's option renames it in the lists holding it, in place,
/// in the rows and in the doc.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_option_rename_reaches_the_items_of_a_list_6741() {
    let f = fixture().await;
    f.set_list(&f.child, "stages", texts(&["review", "draft"]))
        .await
        .unwrap();
    f.set_list(&f.page, "stages", texts(&["draft"]))
        .await
        .unwrap();

    rename_property_option_inner(
        &f.pool,
        DEV,
        &f.mat,
        &f.a,
        "stages".into(),
        "review".into(),
        "in_review".into(),
    )
    .await
    .unwrap();
    settle(&f.mat).await;

    let renamed = texts(&["in_review", "draft"]);
    assert_eq!(f.list(&f.child, "stages").await, Some(renamed.clone()));
    assert_eq!(f.list(&f.page, "stages").await, Some(texts(&["draft"])));
    assert_eq!(
        f.engine_value(&f.a, &f.child, "stages"),
        Some(PropertyValue::List(renamed))
    );
}

/// A definition's `multiple` is stored, read back by each definition read,
/// kept by an options edit, and never set on a boolean.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_definition_keeps_whether_it_holds_a_list_6741() {
    let f = fixture().await;
    let stages = get_property_def_inner(&f.pool, &f.a, "stages")
        .await
        .unwrap()
        .expect("declared");
    let single = get_property_def_inner(&f.pool, &f.a, "single")
        .await
        .unwrap()
        .expect("declared");
    assert_eq!((stages.multiple, single.multiple), (true, false));
    let listed: Vec<(String, bool)> = list_property_defs_inner(&f.pool, &f.a, None, None)
        .await
        .unwrap()
        .items
        .into_iter()
        .filter(|def| ["scores", "single"].contains(&def.key.as_str()))
        .map(|def| (def.key, def.multiple))
        .collect();
    assert_eq!(
        listed,
        [("scores".to_owned(), true), ("single".to_owned(), false)]
    );
    let (_, declared) = f.last_op("set_property_def", "stages").await;
    assert_eq!(declared["def"]["multiple"], true, "the op carries the flag");
    let (_, declared) = f.last_op("set_property_def", "single").await;
    assert_eq!(
        declared["def"].get("multiple"),
        None,
        "and leaves it out of a definition that holds one value"
    );

    let edited = update_property_def_options_inner(
        &f.pool,
        DEV,
        &f.mat,
        &f.a,
        "stages".into(),
        r#"["draft","review","done"]"#.into(),
    )
    .await
    .unwrap();
    assert!(edited.multiple, "an options edit keeps the flag");

    let boolean = create_property_def_state_inner(
        &f.pool,
        DEV,
        &f.mat,
        &f.a,
        "flags".into(),
        list_def("boolean", None),
    )
    .await
    .map(|_| ());
    assert_refused(boolean, "cannot hold a list of booleans");
}

/// A definition is refused over values of the other kind: one that holds a
/// list over single values, and one that holds a single value over lists.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_definition_is_refused_over_values_of_the_other_kind_6741() {
    let f = fixture().await;
    set_property_inner(
        &f.pool,
        DEV,
        &f.mat,
        f.child.as_str().into(),
        "loose".into(),
        Some("one".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let over_single = create_property_def_state_inner(
        &f.pool,
        DEV,
        &f.mat,
        &f.a,
        "loose".into(),
        list_def("text", None),
    )
    .await
    .map(|_| ());
    assert_refused(over_single, "1 stored as text");

    // Undoing a definition's creation leaves its lists under an undeclared key.
    f.set_list(&f.child, "authors", texts(&["Ann"]))
        .await
        .unwrap();
    let (declared, _) = f.last_op("set_property_def", "authors").await;
    f.undo(declared).await;
    assert_eq!(
        get_property_def_inner(&f.pool, &f.a, "authors")
            .await
            .unwrap()
            .map(|d| d.key),
        None,
        "the key is undeclared again"
    );
    let over_list = create_property_def_inner(
        &f.pool,
        DEV,
        &f.mat,
        &f.a,
        "authors".into(),
        "text".into(),
        None,
    )
    .await
    .map(|_| ());
    assert_refused(over_list, "1 stored as a list");
    create_property_def_state_inner(
        &f.pool,
        DEV,
        &f.mat,
        &f.a,
        "authors".into(),
        list_def("text", None),
    )
    .await
    .expect("a definition that holds a list is taken over lists");
    assert_eq!(f.list(&f.child, "authors").await, Some(texts(&["Ann"])));
}
