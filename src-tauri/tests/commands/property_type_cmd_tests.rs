//! Changing a property's type (#5841 S3).

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

/// A value as `set_property` takes it, one slot set.
#[derive(Clone)]
enum V {
    Text(&'static str),
    Num(f64),
    Date(&'static str),
    Ref(String),
    Bool(bool),
}

/// Set `key` on `block` to `value`; the op's ref.
async fn set(pool: &SqlitePool, mat: &Materializer, block: &str, key: &str, value: V) -> OpRef {
    let (mut text, mut num, mut date, mut target, mut flag) = (None, None, None, None, None);
    match value {
        V::Text(v) => text = Some(v.to_owned()),
        V::Num(v) => num = Some(v),
        V::Date(v) => date = Some(v.to_owned()),
        V::Ref(v) => target = Some(v),
        V::Bool(v) => flag = Some(v),
    }
    capture_op_refs(set_property_inner(
        pool,
        DEV,
        mat,
        block.into(),
        key.into(),
        text,
        num,
        date,
        target,
        flag,
        None,
    ))
    .await
    .unwrap()
    .op_refs[0]
        .clone()
}

/// A `block_properties` row's five value slots.
type Slots = (
    Option<String>,
    Option<f64>,
    Option<String>,
    Option<String>,
    Option<i64>,
);

fn text(v: &str) -> Option<Slots> {
    Some((Some(v.into()), None, None, None, None))
}

fn num(v: f64) -> Option<Slots> {
    Some((None, Some(v), None, None, None))
}

fn date(v: &str) -> Option<Slots> {
    Some((None, None, Some(v.into()), None, None))
}

/// `block`'s row under `key`.
async fn row(pool: &SqlitePool, block: &str, key: &str) -> Option<Slots> {
    sqlx::query_as(
        "SELECT value_text, value_num, value_date, value_ref, value_bool \
         FROM block_properties WHERE block_id = ? AND key = ?",
    )
    .bind(block)
    .bind(key)
    .fetch_optional(pool)
    .await
    .unwrap()
}

/// A `block_properties` row: the block and its five value slots.
type Row = (
    String,
    Option<String>,
    Option<f64>,
    Option<String>,
    Option<String>,
    Option<i64>,
);

/// Every row under `key`, by block.
async fn rows(pool: &SqlitePool, key: &str) -> Vec<Row> {
    sqlx::query_as(
        "SELECT block_id, value_text, value_num, value_date, value_ref, value_bool \
         FROM block_properties WHERE key = ? ORDER BY block_id",
    )
    .bind(key)
    .fetch_all(pool)
    .await
    .unwrap()
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

async fn op_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
        .fetch_one(pool)
        .await
        .unwrap()
}

fn target(key: &str, ty: &str, opts: Option<&str>) -> PropertyTypeTarget {
    PropertyTypeTarget {
        key: key.into(),
        value_type: ty.into(),
        options: opts.map(str::to_owned),
    }
}

fn counts(converted: i64, removed: i64) -> PropertyTypeChangeCounts {
    PropertyTypeChangeCounts { converted, removed }
}

async fn preview(
    pool: &SqlitePool,
    key: &str,
    ty: &str,
    opts: Option<&str>,
) -> Result<PropertyTypeChangeCounts, AppError> {
    preview_property_type_change_inner(pool, TEST_SPACE_ID, target(key, ty, opts)).await
}

async fn change(
    pool: &SqlitePool,
    mat: &Materializer,
    (key, ty, opts): (&str, &str, Option<&str>),
    acknowledged: PropertyTypeChangeCounts,
) -> Result<WithOps<PropertyDefinition>, AppError> {
    capture_op_refs(change_property_type_inner(
        pool,
        DEV,
        mat,
        TEST_SPACE_ID,
        target(key, ty, opts),
        acknowledged,
    ))
    .await
}

/// `effortx` (text): X holds "3", Y "042", Z "abc", and the trashed W "7".
async fn effort(pool: &SqlitePool, mat: &Materializer) -> [String; 4] {
    space(pool).await;
    declare(pool, mat, "effortx", "text", None).await;
    let mut blocks = Vec::new();
    for (title, value) in [("X", "3"), ("Y", "042"), ("Z", "abc"), ("W", "7")] {
        let block = page(pool, mat, title).await;
        set(pool, mat, &block, "effortx", V::Text(value)).await;
        blocks.push(block);
    }
    delete_block_inner(pool, DEV, mat, BlockId::from_trusted(&blocks[3]))
        .await
        .unwrap();
    settle(mat).await;
    blocks.try_into().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preview_counts_converted_and_removed_values_the_trash_included_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    effort(&pool, &mat).await;

    assert_eq!(
        preview(&pool, "effortx", "number", None).await.unwrap(),
        counts(3, 1),
        "3, 042 and the trashed 7 convert; abc goes"
    );
    assert_eq!(
        preview(&pool, "effortx", "boolean", None).await.unwrap(),
        counts(0, 4)
    );
    assert_eq!(
        preview(&pool, "effortx", "select", Some(r#"["3","abc"]"#))
            .await
            .unwrap(),
        counts(2, 2),
        "a select keeps only its options"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_pages_each_kind_by_block_id_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [x, y, z, w] = effort(&pool, &mat).await;
    let list = |kind, cursor, limit| {
        list_property_type_change_values_inner(
            &pool,
            TEST_SPACE_ID,
            target("effortx", "number", None),
            kind,
            cursor,
            limit,
        )
    };

    let mut seen = Vec::new();
    let mut cursor = None;
    loop {
        let page = list(PropertyTypeChangeKind::Converted, cursor, Some(1))
            .await
            .unwrap();
        assert_eq!(page.items.len(), 1, "one value a page");
        seen.extend(page.items);
        if !page.has_more {
            break;
        }
        cursor = page.next_cursor;
    }
    let mut converted = [
        (x.clone(), "X", "3", Some("3"), false),
        (y, "Y", "042", Some("42"), false),
        (w, "W", "7", Some("7"), true),
    ];
    converted.sort();
    assert_eq!(
        seen.iter()
            .map(|v| (
                v.block_id.clone(),
                v.page_title.as_deref().unwrap_or_default(),
                v.value.as_str(),
                v.converted.as_deref(),
                v.deleted
            ))
            .collect::<Vec<_>>(),
        converted
            .iter()
            .map(|(id, title, value, to, deleted)| (id.clone(), *title, *value, *to, *deleted))
            .collect::<Vec<_>>(),
        "every converted value, by block id, the trashed one marked"
    );
    assert_eq!(seen[0].page_id.as_deref(), Some(converted[0].0.as_str()));

    let removed = list(PropertyTypeChangeKind::Removed, None, Some(50))
        .await
        .unwrap();
    assert!(!removed.has_more);
    assert_eq!(
        removed
            .items
            .iter()
            .map(|v| (
                v.block_id.as_str(),
                v.value.as_str(),
                v.converted.as_deref()
            ))
            .collect::<Vec<_>>(),
        vec![(z.as_str(), "abc", None)]
    );

    for limit in [0, 201] {
        let refused = list(PropertyTypeChangeKind::Removed, None, Some(limit)).await;
        assert!(
            matches!(refused, Err(AppError::Validation { .. })),
            "limit {limit}: {refused:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn change_converts_removes_and_writes_one_op_on_the_space_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [x, y, z, w] = effort(&pool, &mat).await;

    let changed = change(&pool, &mat, ("effortx", "number", None), counts(3, 1))
        .await
        .unwrap();
    assert_eq!(changed.inner.value_type, "number");
    assert_eq!(
        def_row(&pool, "effortx").await,
        Some(("number".into(), None))
    );
    assert_eq!(row(&pool, &x, "effortx").await, num(3.0));
    assert_eq!(row(&pool, &y, "effortx").await, num(42.0));
    assert_eq!(row(&pool, &z, "effortx").await, None, "abc is gone");
    assert_eq!(row(&pool, &w, "effortx").await, num(7.0), "the Trash's too");

    assert_eq!(changed.op_refs.len(), 1, "a type change is one op");
    let (op_type, block_id, payload): (String, Option<String>, String) = sqlx::query_as(
        "SELECT op_type, block_id, payload FROM op_log WHERE device_id = ? AND seq = ?",
    )
    .bind(&changed.op_refs[0].device_id)
    .bind(changed.op_refs[0].seq)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(op_type, "rewrite_properties");
    assert_eq!(
        block_id.as_deref(),
        Some(TEST_SPACE_ID),
        "filed under its space"
    );
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(payload["reason"], "change_type");
    assert_eq!(payload["defs"][0]["def"]["value_type"], "number");
    assert_eq!(payload["defs"][0]["prior"]["value_type"], "text");
    let values = payload["values"].as_array().unwrap();
    assert_eq!(values.len(), 4, "every value changed form");
    let write_of = |block: &str| {
        values
            .iter()
            .find(|w| w["block_id"] == block)
            .unwrap_or_else(|| panic!("no write for {block}"))
    };
    let slot = |fields: &serde_json::Value| {
        let set: Vec<_> = fields
            .as_object()
            .unwrap()
            .iter()
            .filter(|(_, v)| !v.is_null())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        set
    };
    let (y_write, z_write) = (write_of(&y), write_of(&z));
    assert_eq!(
        slot(&y_write["value"]),
        vec![("value_num".to_owned(), serde_json::json!(42.0))],
        "the new value in the engine's own slot"
    );
    assert_eq!(
        slot(&y_write["prior"]),
        vec![("value_text".to_owned(), serde_json::json!("042"))],
        "the value it replaced, as the engine held it"
    );
    assert!(z_write["value"].is_null(), "a removal writes no value");
    assert_eq!(
        slot(&z_write["prior"]),
        vec![("value_text".to_owned(), serde_json::json!("abc"))]
    );

    // A value whose form stays is not written: the apply moves it.
    declare(&pool, &mat, "when", "text", None).await;
    set(&pool, &mat, &x, "when", V::Text("2026-01-05")).await;
    set(&pool, &mat, &y, "when", V::Text("soon")).await;
    let dated = change(&pool, &mat, ("when", "date", None), counts(1, 1))
        .await
        .unwrap();
    let payload: String =
        sqlx::query_scalar("SELECT payload FROM op_log WHERE device_id = ? AND seq = ?")
            .bind(&dated.op_refs[0].device_id)
            .bind(dated.op_refs[0].seq)
            .fetch_one(&pool)
            .await
            .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    let values = payload["values"].as_array().unwrap();
    assert_eq!(values.len(), 1, "only the removal is written: {values:?}");
    assert_eq!(values[0]["block_id"], y.as_str());
    assert_eq!(row(&pool, &x, "when").await, date("2026-01-05"));
    assert_eq!(row(&pool, &y, "when").await, None);

    // A boolean is written in its own slot.
    declare(&pool, &mat, "flag", "text", None).await;
    set(&pool, &mat, &x, "flag", V::Text("true")).await;
    let flagged = change(&pool, &mat, ("flag", "boolean", None), counts(1, 0))
        .await
        .unwrap();
    let payload: String =
        sqlx::query_scalar("SELECT payload FROM op_log WHERE device_id = ? AND seq = ?")
            .bind(&flagged.op_refs[0].device_id)
            .bind(flagged.op_refs[0].seq)
            .fetch_one(&pool)
            .await
            .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(payload["values"][0]["value"]["value_bool"], true);
    assert!(payload["values"][0]["value"]["value_text"].is_null());
    assert_eq!(
        row(&pool, &x, "flag").await,
        Some((None, None, None, None, Some(1)))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn change_refuses_in_order_and_writes_nothing_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [x, ..] = effort(&pool, &mat).await;
    declare(&pool, &mat, "template", "text", None).await;
    let before = op_count(&pool).await;

    let refusals = [
        (
            ("todo_state", "text", None),
            Some(ValidationCode::BuiltinPropertyLocked),
        ),
        (
            ("due_date", "text", None),
            Some(ValidationCode::BuiltinPropertyLocked),
        ),
        (("template", "number", None), None),
        (("effortx", "colour", None), None),
        (("effortx", "select", None), None),
        (("effortx", "text", None), None),
    ];
    for (to, code) in refusals {
        match change(&pool, &mat, to, counts(3, 1)).await {
            Err(AppError::Validation { code: got, .. }) => assert_eq!(got, code, "{to:?}"),
            other => panic!("{to:?}: expected a refusal, got {other:?}"),
        }
        assert!(
            matches!(
                preview(&pool, to.0, to.1, to.2).await,
                Err(AppError::Validation { .. })
            ),
            "the preview refuses {to:?} too"
        );
    }
    let undeclared = change(&pool, &mat, ("nothing", "number", None), counts(0, 0)).await;
    assert!(
        matches!(undeclared, Err(AppError::NotFound(_))),
        "got {undeclared:?}"
    );
    assert!(matches!(
        preview(&pool, "nothing", "number", None).await,
        Err(AppError::NotFound(_))
    ));

    let stale = change(&pool, &mat, ("effortx", "number", None), counts(4, 0)).await;
    assert_eq!(
        stale.err().and_then(|e| e.validation_code()),
        Some(ValidationCode::UnacknowledgedPropertyLoss),
        "a stale acknowledgement is refused, coded"
    );
    assert_eq!(op_count(&pool).await, before, "no refusal appends an op");
    assert_eq!(def_row(&pool, "effortx").await, Some(("text".into(), None)));
    assert_eq!(row(&pool, &x, "effortx").await, text("3"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_restores_the_values_and_the_definition_and_redo_changes_again_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [x, y, z, w] = effort(&pool, &mat).await;
    let seed = rows(&pool, "effortx").await;
    let changed = change(&pool, &mat, ("effortx", "number", None), counts(3, 1))
        .await
        .unwrap();

    let undone = undo_ops_inner(&pool, DEV, &mat, changed.op_refs)
        .await
        .unwrap();
    assert_eq!(undone[0].new_op_type, "rewrite_properties");
    assert_eq!(def_row(&pool, "effortx").await, Some(("text".into(), None)));
    assert_eq!(rows(&pool, "effortx").await, seed, "every value as it was");

    let undo = &undone[0].new_op_ref;
    redo_page_op_inner(&pool, DEV, &mat, undo.device_id.clone(), undo.seq)
        .await
        .unwrap();
    assert_eq!(
        def_row(&pool, "effortx").await,
        Some(("number".into(), None))
    );
    for (block, want) in [(&x, num(3.0)), (&y, num(42.0)), (&z, None), (&w, num(7.0))] {
        assert_eq!(row(&pool, block, "effortx").await, want, "redone");
    }
}

/// Undo of a type change after values were written under the new type: the
/// change's own values come back, and a value written since re-reads under
/// the old type. A number keeps its column; a string shows if the old type
/// takes it and stays hidden in the doc if not.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_after_later_writes_rereads_them_under_the_old_type_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "hours", "number", None).await;
    let (x, y, z) = (
        page(&pool, &mat, "X").await,
        page(&pool, &mat, "Y").await,
        page(&pool, &mat, "Z").await,
    );
    set(&pool, &mat, &x, "hours", V::Num(5.0)).await;
    let changed = change(&pool, &mat, ("hours", "text", None), counts(1, 0))
        .await
        .unwrap();
    assert_eq!(row(&pool, &x, "hours").await, text("5"));
    set(&pool, &mat, &y, "hours", V::Text("12")).await;
    set(&pool, &mat, &z, "hours", V::Text("about two")).await;

    undo_ops_inner(&pool, DEV, &mat, changed.op_refs)
        .await
        .unwrap();
    assert_eq!(def_row(&pool, "hours").await, Some(("number".into(), None)));
    assert_eq!(
        row(&pool, &x, "hours").await,
        num(5.0),
        "the change's own value"
    );
    assert_eq!(
        row(&pool, &y, "hours").await,
        num(12.0),
        "a later string that fits"
    );
    assert_eq!(
        row(&pool, &z, "hours").await,
        None,
        "one that does not is hidden"
    );
    let held = mat
        .loro_state()
        .registry
        .for_space(&SpaceId::from_trusted(TEST_SPACE_ID), DEV)
        .unwrap()
        .engine_mut()
        .read_property_holders("hours")
        .unwrap()
        .into_iter()
        .any(|(id, _)| id == z);
    assert!(held, "the doc still holds it, for a change back");
}

/// Every type to every other, with values that fit the first: the change
/// then its undo leaves the rows as they were.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_type_pair_change_then_undo_restores_the_rows_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    let (a, b) = (page(&pool, &mat, "A").await, page(&pool, &mat, "B").await);
    let linked = page(&pool, &mat, "Linked").await;
    let types: [(&str, Option<&str>, [V; 2]); 7] = [
        ("text", None, [V::Text("3"), V::Text("abc")]),
        ("number", None, [V::Num(3.0), V::Num(2.5)]),
        ("date", None, [V::Date("2026-01-05"), V::Date("2026-02-28")]),
        ("select", Some(r#"["a","3"]"#), [V::Text("a"), V::Text("3")]),
        (
            "ref",
            None,
            [V::Ref(linked.clone()), V::Ref(linked.clone())],
        ),
        ("boolean", None, [V::Bool(true), V::Bool(false)]),
        ("url", None, [V::Text("https://x.example"), V::Text("3")]),
    ];
    for (from, from_opts, values) in &types {
        for (to, ..) in types.iter().filter(|(to, ..)| to != from) {
            let key = format!("k-{from}-{to}");
            declare(&pool, &mat, &key, from, *from_opts).await;
            for (block, value) in [&a, &b].into_iter().zip(values.iter().cloned()) {
                set(&pool, &mat, block, &key, value).await;
            }
            let seed = rows(&pool, &key).await;
            let to_opts = (*to == "select").then_some(r#"["a"]"#);
            let ack = preview(&pool, &key, to, to_opts).await.unwrap();
            let changed = change(&pool, &mat, (&key, to, to_opts), ack)
                .await
                .unwrap_or_else(|e| panic!("{from} -> {to}: {e:?}"));
            undo_ops_inner(&pool, DEV, &mat, changed.op_refs)
                .await
                .unwrap_or_else(|e| panic!("undo {from} -> {to}: {e:?}"));
            assert_eq!(rows(&pool, &key).await, seed, "{from} -> {to} -> {from}");
            assert_eq!(
                def_row(&pool, &key).await,
                Some(((*from).to_owned(), from_opts.map(str::to_owned))),
                "{from} -> {to}: the definition"
            );
        }
    }
}

/// Undo of a set made before the key changed type: a value the type takes is
/// converted to it, under the same key; one it does not take is refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_an_older_set_converts_it_or_is_refused_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "effortx", "text", None).await;
    let (x, y) = (page(&pool, &mat, "X").await, page(&pool, &mat, "Y").await);
    set(&pool, &mat, &x, "effortx", V::Text("6")).await;
    let second = set(&pool, &mat, &x, "effortx", V::Text("5")).await;
    set(&pool, &mat, &y, "effortx", V::Text("abc")).await;
    let refused = set(&pool, &mat, &y, "effortx", V::Text("7")).await;
    change(&pool, &mat, ("effortx", "number", None), counts(2, 0))
        .await
        .unwrap();

    undo_ops_inner(&pool, DEV, &mat, vec![second])
        .await
        .unwrap();
    assert_eq!(row(&pool, &x, "effortx").await, num(6.0), "6, as a number");
    let ops = op_count(&pool).await;
    let err = undo_ops_inner(&pool, DEV, &mat, vec![refused])
        .await
        .unwrap_err();
    assert!(
        matches!(&err, AppError::Validation { message, .. } if message.contains("change its type back first")),
        "got {err:?}"
    );
    assert_eq!(row(&pool, &y, "effortx").await, num(7.0), "left as it is");
    assert_eq!(op_count(&pool).await, ops, "and nothing appended");
}

/// A date held as text joins the agenda once its key becomes a date.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_key_changed_to_date_lists_its_values_in_the_agenda_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "deadline", "text", None).await;
    let one = page(&pool, &mat, "One").await;
    set(&pool, &mat, &one, "deadline", V::Text("2026-11-03")).await;
    settle(&mat).await;
    let sources = || async {
        sqlx::query_scalar::<_, String>("SELECT source FROM agenda_cache WHERE block_id = ?")
            .bind(&one)
            .fetch_all(&pool)
            .await
            .unwrap()
    };
    assert_eq!(sources().await, Vec::<String>::new(), "text is not a date");

    change(&pool, &mat, ("deadline", "date", None), counts(1, 0))
        .await
        .unwrap();
    settle(&mat).await;
    assert_eq!(sources().await, vec!["property:deadline".to_owned()]);
}

/// Undoing a set leaves a value its key's type takes in the slot it was set
/// in: a ref under a text key stays a ref rather than turning into its id
/// as text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_a_set_keeps_a_value_the_type_takes_in_its_own_slot_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "seealso", "text", None).await;
    let (x, a, b) = (
        page(&pool, &mat, "X").await,
        page(&pool, &mat, "A").await,
        page(&pool, &mat, "B").await,
    );
    set(&pool, &mat, &x, "seealso", V::Ref(a.clone())).await;
    let second = set(&pool, &mat, &x, "seealso", V::Ref(b)).await;

    undo_ops_inner(&pool, DEV, &mat, vec![second])
        .await
        .unwrap();
    assert_eq!(
        row(&pool, &x, "seealso").await,
        Some((None, None, None, Some(a), None)),
        "the ref, as a ref"
    );
}

/// The space's own block holds values under the space's keys, and a type
/// change converts them: undoing an older set on it fits the value to the
/// key's type as on any other block of the space.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_an_older_set_on_the_space_block_converts_it_5841() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space(&pool).await;
    declare(&pool, &mat, "effortx", "text", None).await;
    set(&pool, &mat, TEST_SPACE_ID, "effortx", V::Text("6")).await;
    let second = set(&pool, &mat, TEST_SPACE_ID, "effortx", V::Text("5")).await;
    change(&pool, &mat, ("effortx", "number", None), counts(1, 0))
        .await
        .unwrap();
    assert_eq!(row(&pool, TEST_SPACE_ID, "effortx").await, num(5.0));

    undo_ops_inner(&pool, DEV, &mat, vec![second])
        .await
        .unwrap();
    assert_eq!(
        row(&pool, TEST_SPACE_ID, "effortx").await,
        num(6.0),
        "6, as a number"
    );
}
