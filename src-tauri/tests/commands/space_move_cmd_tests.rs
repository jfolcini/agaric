//! #5841 S0.6 — a cross-space move drops each property its target space does
//! not define identically, after the user confirms the losses.
//!
//! Every fixture is built through the production commands: two spaces made by
//! `create_space` (so both hold the same editable defaults), definitions per
//! space, a page with a content child, a trashed child, and a nested page
//! with its own child.

use super::prelude::*;
use agaric_core::error::ValidationCode;

struct Fixture {
    pool: SqlitePool,
    mat: Materializer,
    _dir: tempfile::TempDir,
    a: String,
    b: String,
    page: BlockId,
    child: BlockId,
    trashed: BlockId,
    nested: BlockId,
    nested_child: BlockId,
}

/// The losses moving the fixture's page from A to B reports: `kind` (other
/// options), `onlya` (declared in A only; three moving blocks hold it, the
/// trashed one included), `onlyb` (declared in B only) and `size` (number in
/// A, text in B).
fn fixture_losses() -> Vec<PropertyLoss> {
    [("kind", 1), ("onlya", 3), ("onlyb", 1), ("size", 1)]
        .into_iter()
        .map(|(key, count)| PropertyLoss {
            key: key.into(),
            count,
        })
        .collect()
}

async fn set_text(f: &Fixture, block: &BlockId, key: &str, value: &str) {
    set_property_inner(
        &f.pool,
        DEV,
        &f.mat,
        block.as_str().into(),
        key.into(),
        Some(value.into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap_or_else(|e| panic!("set {key} = {value}: {e:?}"));
}

async fn child_of(pool: &SqlitePool, mat: &Materializer, parent: &BlockId, text: &str) -> BlockId {
    create_block_inner(
        pool,
        DEV,
        mat,
        "content".into(),
        text.into(),
        Some(parent.clone()),
        None,
    )
    .await
    .unwrap()
    .id
}

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
    for (space, key, value_type, options) in [
        (&a, "same", "text", None),
        (&b, "same", "text", None),
        (&a, "onlya", "text", None),
        (&b, "onlyb", "text", None),
        (&a, "kind", "select", Some(r#"["x","y"]"#)),
        (&b, "kind", "select", Some(r#"["x","y","z"]"#)),
        (&a, "size", "number", None),
        (&b, "size", "text", None),
    ] {
        create_property_def_inner(
            &pool,
            DEV,
            &mat,
            space,
            key.into(),
            value_type.into(),
            options.map(str::to_owned),
        )
        .await
        .unwrap();
    }
    let page = create_page_in_space_inner(&pool, DEV, &mat, None, "P".into(), a.clone())
        .await
        .unwrap();
    let child = child_of(&pool, &mat, &page, "child").await;
    let trashed = child_of(&pool, &mat, &page, "trashed").await;
    let nested = create_page_in_space_inner(
        &pool,
        DEV,
        &mat,
        Some(page.as_str().to_owned()),
        "N".into(),
        a.clone(),
    )
    .await
    .unwrap();
    let nested_child = child_of(&pool, &mat, &nested, "nested child").await;
    let f = Fixture {
        pool,
        mat,
        _dir: dir,
        a,
        b,
        page,
        child,
        trashed,
        nested,
        nested_child,
    };
    for (key, value) in [
        ("same", "s"),
        ("free", "f"),
        ("kind", "x"),
        ("listStyle", "ordered"),
        ("status", "active"),
        ("onlya", "p"),
    ] {
        set_text(&f, &f.page, key, value).await;
    }
    set_text(&f, &f.child, "onlya", "c").await;
    set_text(&f, &f.child, "onlyb", "b").await;
    set_property_inner(
        &f.pool,
        DEV,
        &f.mat,
        f.child.as_str().into(),
        "size".into(),
        None,
        Some(3.0),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    set_text(&f, &f.trashed, "onlya", "t").await;
    set_text(&f, &f.nested, "onlya", "n").await;
    set_text(&f, &f.nested_child, "onlya", "nc").await;
    delete_block_inner(&f.pool, DEV, &f.mat, f.trashed.clone())
        .await
        .unwrap();
    settle(&f.mat).await;
    f
}

impl Fixture {
    async fn preview(&self) -> Vec<PropertyLoss> {
        preview_space_move_inner(&self.pool, vec![self.page.clone()], self.b.clone())
            .await
            .unwrap()
    }

    async fn move_page(&self, ack: &[PropertyLoss]) -> Result<i64, AppError> {
        let moved = move_blocks_to_space_inner(
            &self.pool,
            DEV,
            &self.mat,
            vec![self.page.clone()],
            self.b.clone(),
            ack,
        )
        .await;
        settle(&self.mat).await;
        moved
    }

    /// Every `(key, value)` `block` holds, sorted, the number as text.
    async fn values(&self, block: &BlockId) -> Vec<(String, String)> {
        sqlx::query_as::<_, (String, String)>(
            "SELECT key, COALESCE(value_text, CAST(value_num AS TEXT), value_date, value_ref) \
             FROM block_properties WHERE block_id = ? ORDER BY key",
        )
        .bind(block.as_str())
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }

    async fn space_of(&self, block: &BlockId) -> String {
        sqlx::query_scalar::<_, String>("SELECT space_id FROM blocks WHERE id = ?")
            .bind(block.as_str())
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// The keys `space`'s doc holds for `block`, sorted; `None` when the doc
    /// does not hold the block.
    fn doc_keys(&self, space: &str, block: &BlockId) -> Option<Vec<String>> {
        let space = agaric_store::space::SpaceId::from_trusted(space);
        let mut guard = self
            .mat
            .loro_state()
            .registry
            .for_space(&space, DEV)
            .expect("the space's doc");
        let engine = guard.engine_mut();
        engine.contains_block(block.as_str()).then(|| {
            let mut keys: Vec<String> = engine
                .read_all_properties_typed(block.as_str())
                .expect("read the block's properties")
                .into_iter()
                .map(|(key, _)| key)
                .collect();
            keys.sort();
            keys
        })
    }

    async fn max_seq(&self) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COALESCE(MAX(seq), 0) FROM op_log WHERE device_id = ?")
            .bind(DEV)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// `(op_type, payload)` of every op after `seq`, in append order.
    async fn ops_after(&self, seq: i64) -> Vec<(String, serde_json::Value)> {
        sqlx::query_as::<_, (String, String)>(
            "SELECT op_type, payload FROM op_log WHERE device_id = ? AND seq > ? ORDER BY seq",
        )
        .bind(DEV)
        .bind(seq)
        .fetch_all(&self.pool)
        .await
        .unwrap()
        .into_iter()
        .map(|(op_type, payload)| (op_type, serde_json::from_str(&payload).unwrap()))
        .collect()
    }
}

fn pairs(rows: &[(&str, &str)]) -> Vec<(String, String)> {
    rows.iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

/// The preview counts the page, its live child and its TRASHED child (a soft
/// delete keeps `space_id`, and the move re-stamps the row), and nothing of
/// the nested page, which stays in A. Each drop rule shows: a key declared on
/// one side only (either side), other options, another type.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preview_counts_the_moved_subtree_trashed_rows_included_nested_pages_excluded() {
    let f = fixture().await;
    assert_eq!(f.preview().await, fixture_losses(), "per-key losses");
    assert_eq!(
        preview_space_move_inner(&f.pool, vec![f.nested.clone()], f.b.clone())
            .await
            .unwrap(),
        vec![PropertyLoss {
            key: "onlya".into(),
            count: 2
        }],
        "the nested page and its child are their own move"
    );
}

/// A built-in (`listStyle`), a key both spaces define identically (`same`,
/// and the default `status` both spaces were made with) and a key neither
/// defines (`free`) all stay, so moving a page holding only those reports
/// nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preview_keeps_builtins_identical_and_undeclared_keys() {
    let f = fixture().await;
    let kept = create_page_in_space_inner(&f.pool, DEV, &f.mat, None, "K".into(), f.a.clone())
        .await
        .unwrap();
    for (key, value) in [
        ("listStyle", "ordered"),
        ("same", "s"),
        ("status", "active"),
        ("free", "f"),
    ] {
        set_text(&f, &kept, key, value).await;
    }
    assert_eq!(
        preview_space_move_inner(&f.pool, vec![kept.clone()], f.b.clone())
            .await
            .unwrap(),
        Vec::<PropertyLoss>::new(),
        "nothing is lost"
    );
    let moved =
        move_blocks_to_space_inner(&f.pool, DEV, &f.mat, vec![kept.clone()], f.b.clone(), &[])
            .await
            .expect("a move that loses nothing needs no acknowledgement");
    assert_eq!(moved, 1);
    assert_eq!(f.space_of(&kept).await, f.b);
    assert_eq!(
        f.values(&kept).await,
        pairs(&[
            ("free", "f"),
            ("listStyle", "ordered"),
            ("same", "s"),
            ("status", "active")
        ]),
        "every value came along"
    );
}

/// No acknowledgement, or one that no longer matches (another write changed
/// a count), is refused with the code the frontend re-previews on, and the
/// move writes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_refuses_a_missing_or_stale_acknowledgement() {
    let f = fixture().await;
    let before = f.max_seq().await;
    let mut stale = fixture_losses();
    stale[1].count = 2;
    for ack in [Vec::new(), stale] {
        let err = f.move_page(&ack).await.expect_err("refused");
        assert_eq!(
            err.validation_code(),
            Some(ValidationCode::UnacknowledgedPropertyLoss),
            "ack {ack:?}: {err:?}"
        );
    }
    assert_eq!(f.max_seq().await, before, "no op was appended");
    assert_eq!(f.space_of(&f.page).await, f.a, "the page did not move");
    assert_eq!(
        f.values(&f.child).await,
        pairs(&[("onlya", "c"), ("onlyb", "b"), ("size", "3.0")]),
        "nothing was dropped"
    );
}

/// The drops and the moves are one transaction. A content block cannot change
/// space, so a list holding one fails on it after the page's drops and its own
/// move were appended: the op log, the values, the memberships and both
/// spaces' docs are as they were.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_that_fails_after_its_drops_writes_nothing() {
    let f = fixture().await;
    let before = f.max_seq().await;
    let held = (
        f.values(&f.page).await,
        f.values(&f.child).await,
        f.values(&f.trashed).await,
    );
    let page_in_a = f.doc_keys(&f.a, &f.page);
    assert!(
        page_in_a.is_some(),
        "precondition: A's doc holds the page and its values"
    );

    let err = move_blocks_to_space_inner(
        &f.pool,
        DEV,
        &f.mat,
        vec![f.page.clone(), f.child.clone()],
        f.b.clone(),
        &fixture_losses(),
    )
    .await
    .expect_err("a content block cannot change space");
    settle(&f.mat).await;

    assert!(
        err.to_string().contains("can only be set on a page"),
        "the list fails on the content block, past the acknowledgement: {err}"
    );
    assert_eq!(f.max_seq().await, before, "no drop or move survived");
    assert_eq!(f.space_of(&f.page).await, f.a, "the page did not move");
    assert_eq!(
        (
            f.values(&f.page).await,
            f.values(&f.child).await,
            f.values(&f.trashed).await
        ),
        held,
        "no value was dropped"
    );
    assert_eq!(
        f.doc_keys(&f.a, &f.page),
        page_in_a,
        "A's doc still holds the page with its values"
    );
    assert_eq!(
        f.doc_keys(&f.b, &f.page),
        None,
        "B's doc was not seeded with the page"
    );
}

/// The acknowledged move drops exactly the listed values, each as a
/// `delete_property` carrying the value as its `prior`, all appended BEFORE
/// the `space` op, so an undo moves the page back before it restores them.
/// The kept values and the nested page's are untouched.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acknowledged_move_drops_the_values_with_prior_before_moving() {
    let f = fixture().await;
    let before = f.max_seq().await;
    // The acknowledgement's order does not matter.
    let mut ack = fixture_losses();
    ack.reverse();
    assert_eq!(f.move_page(&ack).await.unwrap(), 1);

    let ops = f.ops_after(before).await;
    let (last, drops) = ops.split_last().expect("ops were appended");
    assert_eq!(last.0, "set_property", "the move is the last op");
    assert_eq!(last.1["key"], "space");
    let mut dropped: Vec<(String, String, serde_json::Value)> = drops
        .iter()
        .map(|(op_type, payload)| {
            assert_eq!(
                op_type, "delete_property",
                "every op before the move is a drop"
            );
            (
                payload["block_id"].as_str().unwrap().to_owned(),
                payload["key"].as_str().unwrap().to_owned(),
                payload["prior"].clone(),
            )
        })
        .collect();
    dropped.sort_by(|x, y| (&x.0, &x.1).cmp(&(&y.0, &y.1)));
    let prior = |text: Option<&str>, num: Option<f64>| {
        serde_json::json!({
            "value_text": text,
            "value_num": num,
            "value_date": null,
            "value_ref": null,
            "value_bool": null,
        })
    };
    let prior_text = |v: &str| prior(Some(v), None);
    let mut expected = vec![
        (f.page.to_string(), "kind".to_owned(), prior_text("x")),
        (f.page.to_string(), "onlya".to_owned(), prior_text("p")),
        (f.child.to_string(), "onlya".to_owned(), prior_text("c")),
        (f.child.to_string(), "onlyb".to_owned(), prior_text("b")),
        (
            f.child.to_string(),
            "size".to_owned(),
            prior(None, Some(3.0)),
        ),
        (f.trashed.to_string(), "onlya".to_owned(), prior_text("t")),
    ];
    expected.sort_by(|x, y| (&x.0, &x.1).cmp(&(&y.0, &y.1)));
    assert_eq!(dropped, expected, "one drop per lost value, with its prior");

    assert_eq!(f.space_of(&f.page).await, f.b);
    assert_eq!(
        f.values(&f.page).await,
        pairs(&[
            ("free", "f"),
            ("listStyle", "ordered"),
            ("same", "s"),
            ("status", "active")
        ]),
    );
    assert_eq!(f.values(&f.child).await, Vec::new());
    assert_eq!(
        f.values(&f.trashed).await,
        Vec::new(),
        "the trashed child's value went too"
    );
    assert_eq!(
        f.space_of(&f.nested).await,
        f.a,
        "the nested page stays in A"
    );
    assert_eq!(f.values(&f.nested).await, pairs(&[("onlya", "n")]));
    assert_eq!(f.values(&f.nested_child).await, pairs(&[("onlya", "nc")]));
}

/// Ctrl+Z on the moved page (the positional group undo the frontend falls
/// back to) reverses the move first, then restores every dropped value, the
/// trashed child's included, and the page is back in A.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_moves_the_page_back_and_restores_the_values() {
    let f = fixture().await;
    // The group joins ops closer than the frontend's `UNDO_GROUP_WINDOW_MS`,
    // passed below, so the fixture's own writes must be older than that or
    // they join it.
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    f.move_page(&fixture_losses()).await.unwrap();

    let results = undo_page_group_inner(&f.pool, DEV, &f.mat, f.page.to_string(), 0, 500)
        .await
        .unwrap();
    settle(&f.mat).await;
    let reversed: Vec<&str> = results
        .iter()
        .map(|r| r.reversed_op_type.as_str())
        .collect();
    assert_eq!(
        reversed,
        [
            "set_property",
            "delete_property",
            "delete_property",
            "delete_property",
            "delete_property",
            "delete_property",
            "delete_property",
        ],
        "one undo: the move first, then the six drops"
    );

    assert_eq!(f.space_of(&f.page).await, f.a, "back in A");
    assert_eq!(f.space_of(&f.child).await, f.a);
    assert_eq!(
        f.values(&f.page).await,
        pairs(&[
            ("free", "f"),
            ("kind", "x"),
            ("listStyle", "ordered"),
            ("onlya", "p"),
            ("same", "s"),
            ("status", "active"),
        ]),
    );
    assert_eq!(
        f.values(&f.child).await,
        pairs(&[("onlya", "c"), ("onlyb", "b"), ("size", "3.0")]),
    );
    assert_eq!(f.values(&f.trashed).await, pairs(&[("onlya", "t")]));
    assert_eq!(
        f.preview().await,
        fixture_losses(),
        "the same move would lose the same again"
    );
}

/// The drops and the moves together stay within one undo
/// (`MAX_REVERT_OPS`): as many values as the cap, plus the page's own op, are
/// refused with "move fewer pages"; one value fewer moves.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_beyond_one_undo_is_refused() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let a = create_space_inner(&pool, DEV, &mat, "A".into(), None)
        .await
        .unwrap()
        .into_string();
    let b = create_space_inner(&pool, DEV, &mat, "B".into(), None)
        .await
        .unwrap()
        .into_string();
    create_property_def_inner(&pool, DEV, &mat, &a, "onlya".into(), "text".into(), None)
        .await
        .unwrap();
    let page = create_page_in_space_inner(&pool, DEV, &mat, None, "P".into(), a.clone())
        .await
        .unwrap();
    let specs = (0..1000)
        .map(|i| CreateBlockSpec {
            block_type: "content".into(),
            content: format!("row {i}"),
            parent_id: Some(page.clone()),
            position: None,
            properties: [("onlya".to_owned(), "v".to_owned())].into_iter().collect(),
        })
        .collect();
    let rows = create_blocks_batch_inner(&pool, DEV, &mat, specs)
        .await
        .unwrap();
    settle(&mat).await;
    let thousand = vec![PropertyLoss {
        key: "onlya".into(),
        count: 1000,
    }];
    assert_eq!(
        preview_space_move_inner(&pool, vec![page.clone()], b.clone())
            .await
            .unwrap(),
        thousand
    );

    let err =
        move_blocks_to_space_inner(&pool, DEV, &mat, vec![page.clone()], b.clone(), &thousand)
            .await
            .expect_err("1001 ops exceed one undo");
    assert!(
        err.to_string().contains("move fewer pages"),
        "the refusal says what to do: {err}"
    );
    assert_eq!(err.validation_code(), None);

    delete_property_inner(&pool, DEV, &mat, rows[0].id.as_str().into(), "onlya".into())
        .await
        .unwrap();
    let moved = move_blocks_to_space_inner(
        &pool,
        DEV,
        &mat,
        vec![page.clone()],
        b.clone(),
        &[PropertyLoss {
            key: "onlya".into(),
            count: 999,
        }],
    )
    .await
    .expect("1000 ops fit one undo");
    assert_eq!(moved, 1);
}

/// The detail pages through every value of one key, block by block, and
/// says which ones are in the Trash. Its `limit` is validated, not clamped.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_property_loss_values_pages_by_block() {
    let f = fixture().await;
    let list = |cursor: Option<String>, limit: Option<i64>| {
        list_property_loss_values_inner(
            &f.pool,
            vec![f.page.clone()],
            f.b.clone(),
            "onlya".into(),
            cursor,
            limit,
        )
    };
    let first = list(None, Some(2)).await.unwrap();
    assert!(first.has_more, "three values, two per page");
    let second = list(first.next_cursor.clone(), Some(2)).await.unwrap();
    assert!(!second.has_more);
    let rows: Vec<(String, String, bool, String)> = first
        .items
        .iter()
        .chain(&second.items)
        .map(|row| {
            assert_eq!(row.key, "onlya");
            assert_eq!(row.page_id.as_deref(), Some(f.page.as_str()));
            assert_eq!(row.page_title.as_deref(), Some("P"));
            (
                row.block_id.clone(),
                row.content.clone().unwrap_or_default(),
                row.deleted,
                row.value_text.clone().unwrap_or_default(),
            )
        })
        .collect();
    let mut expected = vec![
        (f.page.to_string(), "P".to_owned(), false, "p".to_owned()),
        (
            f.child.to_string(),
            "child".to_owned(),
            false,
            "c".to_owned(),
        ),
        (
            f.trashed.to_string(),
            "trashed".to_owned(),
            true,
            "t".to_owned(),
        ),
    ];
    expected.sort();
    assert_eq!(rows, expected, "every value once, in block order");

    let size = list_property_loss_values_inner(
        &f.pool,
        vec![f.page.clone()],
        f.b.clone(),
        "size".into(),
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(size.items.len(), 1);
    assert_eq!(size.items[0].value_num, Some(3.0), "the typed value");

    for limit in [0, 201] {
        let err = list(None, Some(limit)).await.expect_err("out of range");
        assert!(
            matches!(err, AppError::Validation { .. }),
            "limit {limit}: {err:?}"
        );
    }
}

/// The detail lists the values the preview counts, key by key, and none of
/// a key the preview leaves out: `space_move_losses` and
/// `space_move_loss_values` repeat one CTE and filter. A move checks its
/// acknowledgement against the first alone, then drops the rows of the second,
/// so a drift between them would drop values the user was not shown.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_detail_lists_exactly_the_values_the_preview_counts() {
    let f = fixture().await;
    let counted = f.preview().await;
    assert_eq!(counted, fixture_losses(), "the preview has losses to match");
    let keys = sqlx::query_scalar::<_, String>("SELECT DISTINCT key FROM block_properties")
        .fetch_all(&f.pool)
        .await
        .unwrap();
    for key in keys {
        let listed = list_property_loss_values_inner(
            &f.pool,
            vec![f.page.clone()],
            f.b.clone(),
            key.clone(),
            None,
            None,
        )
        .await
        .unwrap();
        let expected = counted
            .iter()
            .find(|loss| loss.key == key)
            .map_or(0, |loss| loss.count);
        assert!(!listed.has_more, "{key}: one page holds every value");
        assert_eq!(
            i64::try_from(listed.items.len()).unwrap(),
            expected,
            "values listed for {key}"
        );
    }
}

// ======================================================================
// #6099 — a move brings no page title or tag name into a space where a live
// page or tag holds it, and neither does the move's undo.
// ======================================================================

struct Spaces {
    pool: SqlitePool,
    mat: Materializer,
    _dir: tempfile::TempDir,
    a: String,
    b: String,
    c: String,
}

async fn spaces() -> Spaces {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let mut ids = Vec::new();
    for name in ["A", "B", "C"] {
        let id = create_space_inner(&pool, DEV, &mat, name.into(), None)
            .await
            .unwrap();
        ids.push(id.into_string());
    }
    let [a, b, c] = ids.try_into().unwrap();
    Spaces {
        pool,
        mat,
        _dir: dir,
        a,
        b,
        c,
    }
}

impl Spaces {
    async fn page(&self, space: &str, title: &str) -> BlockId {
        create_page_in_space_inner(&self.pool, DEV, &self.mat, None, title.into(), space.into())
            .await
            .unwrap()
    }

    async fn tag(&self, space: &str, name: &str) -> BlockId {
        create_block_inner_with_space(
            &self.pool,
            DEV,
            &self.mat,
            "tag".into(),
            name.into(),
            None,
            None,
            &SpaceScope::Active(SpaceId::from_trusted(space)),
            None,
        )
        .await
        .unwrap()
        .id
    }

    async fn move_to(&self, blocks: &[&BlockId], space: &str) -> Result<i64, AppError> {
        let blocks = blocks.iter().map(|&block| block.clone()).collect();
        let moved =
            move_blocks_to_space_inner(&self.pool, DEV, &self.mat, blocks, space.into(), &[]).await;
        settle(&self.mat).await;
        moved
    }

    async fn space_of(&self, block: &BlockId) -> String {
        sqlx::query_scalar::<_, String>("SELECT space_id FROM blocks WHERE id = ?")
            .bind(block.as_str())
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    async fn op_count(&self) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM op_log")
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}

/// Refused with a rename's code and words: `message`.
fn assert_taken<T: std::fmt::Debug>(result: Result<T, AppError>, message: &str) {
    match result.expect_err(message) {
        AppError::Validation { code, message: got } => {
            assert_eq!(code, Some(ValidationCode::DuplicatePageTitle), "{got}");
            assert_eq!(got, message);
        }
        other => panic!("{message}: got {other:?}"),
    }
}

/// Page `Inbox` of A moved into B, which has its own `Inbox`: refused, nothing
/// moved and no op appended. A batch that also holds a free title is refused
/// whole.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_onto_a_taken_page_title_is_refused_whole_6099() {
    let s = spaces().await;
    let inbox = s.page(&s.a, "Inbox").await;
    let plan = s.page(&s.a, "Plan").await;
    s.page(&s.b, "Inbox").await;
    let ops = s.op_count().await;

    for batch in [vec![&inbox], vec![&plan, &inbox]] {
        assert_taken(
            s.move_to(&batch, &s.b).await,
            "a page titled 'Inbox' already exists in this space",
        );
    }
    assert_eq!(s.op_count().await, ops, "no op was appended");
    assert_eq!(s.space_of(&inbox).await, s.a, "Inbox did not move");
    assert_eq!(s.space_of(&plan).await, s.a, "nor did Plan, moved with it");
}

/// The same for a tag, under the fold its name is unique by: `work` does not
/// move into a space holding `Work`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_onto_a_taken_tag_name_is_refused_6099() {
    let s = spaces().await;
    let work = s.tag(&s.a, "work").await;
    s.tag(&s.b, "Work").await;
    let ops = s.op_count().await;

    assert_taken(
        s.move_to(&[&work], &s.b).await,
        "a tag named 'work' already exists in this space",
    );
    assert_eq!(s.op_count().await, ops, "no op was appended");
    assert_eq!(s.space_of(&work).await, s.a, "the tag did not move");
}

/// A title free in the target moves: the page is no clash with itself. Two
/// pages titled alike, which one move would bring into a space holding
/// neither, clash with each other.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_takes_a_free_title_but_not_two_alike_6099() {
    let s = spaces().await;
    let in_a = s.page(&s.a, "Notes").await;
    let in_b = s.page(&s.b, "Notes").await;

    assert_taken(
        s.move_to(&[&in_a, &in_b], &s.c).await,
        "a page titled 'Notes' already exists in this space",
    );
    assert_eq!(s.space_of(&in_a).await, s.a);
    assert_eq!(s.space_of(&in_b).await, s.b);

    assert_eq!(s.move_to(&[&in_a], &s.c).await.unwrap(), 1);
    assert_eq!(s.space_of(&in_a).await, s.c, "Notes moved into C");
}

/// The undo of a move is a move back, refused once the space it left has given
/// the title to another page: the page stays where the move put it and no op
/// is appended. With the title free there again the undo goes through.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_of_a_move_onto_a_taken_title_is_refused_6099() {
    let s = spaces().await;
    let plan = s.page(&s.a, "Plan").await;
    s.move_to(&[&plan], &s.b).await.unwrap();
    let seq: i64 = sqlx::query_scalar(
        "SELECT MAX(seq) FROM op_log WHERE op_type = 'set_property' AND block_id = ?",
    )
    .bind(plan.as_str())
    .fetch_one(&s.pool)
    .await
    .unwrap();
    let move_ref = agaric_store::op::OpRef {
        device_id: DEV.into(),
        seq,
    };
    let holder = s.page(&s.a, "Plan").await;
    let ops = s.op_count().await;

    let taken = "a page titled 'Plan' already exists in this space";
    assert_taken(
        undo_op_inner(&s.pool, DEV, &s.mat, move_ref.clone()).await,
        taken,
    );
    assert_taken(
        revert_ops_inner(&s.pool, DEV, &s.mat, vec![move_ref.clone()]).await,
        taken,
    );
    assert_eq!(s.space_of(&plan).await, s.b, "the page stays in B");
    assert_eq!(s.op_count().await, ops, "no op was appended");

    delete_block_inner(&s.pool, DEV, &s.mat, holder)
        .await
        .unwrap();
    settle(&s.mat).await;
    undo_op_inner(&s.pool, DEV, &s.mat, move_ref)
        .await
        .expect("with the title free in A, the undo moves the page back");
    assert_eq!(s.space_of(&plan).await, s.a);
}
