//! A key's values that don't fit its definition: counted, listed, removed,
//! and added to a select's options (#6206).

use super::prelude::*;
use agaric_core::error::ValidationCode;
use agaric_store::op::OpRef;

/// [`TEST_SPACE_ID`] as a registered space with a doc of its own.
pub(super) async fn space(pool: &SqlitePool) {
    ensure_test_space(pool).await;
    mark_block_as_space(pool, TEST_SPACE_ID).await;
}

pub(super) async fn declare(
    pool: &SqlitePool,
    mat: &Materializer,
    key: &str,
    ty: &str,
    opts: Option<&str>,
) {
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
pub(super) enum V {
    Text(&'static str),
    Num(f64),
    Date(&'static str),
    Bool(bool),
}

pub(super) async fn set(pool: &SqlitePool, mat: &Materializer, block: &str, key: &str, value: V) {
    let (mut text, mut num, mut date, mut flag) = (None, None, None, None);
    match value {
        V::Text(v) => text = Some(v.to_owned()),
        V::Num(v) => num = Some(v),
        V::Date(v) => date = Some(v.to_owned()),
        V::Bool(v) => flag = Some(v),
    }
    set_property_inner(
        pool,
        DEV,
        mat,
        block.into(),
        key.into(),
        text,
        num,
        date,
        None,
        flag,
        None,
    )
    .await
    .unwrap();
}

/// Change `key` to `ty`, acknowledging `(converted, unfit)`.
pub(super) async fn change(
    pool: &SqlitePool,
    mat: &Materializer,
    (key, ty, opts): (&str, &str, Option<&str>),
    (converted, unfit): (i64, i64),
) {
    change_property_type_inner(
        pool,
        DEV,
        mat,
        TEST_SPACE_ID,
        PropertyTypeTarget {
            key: key.into(),
            value_type: ty.into(),
            options: opts.map(str::to_owned),
        },
        PropertyTypeChangeCounts { converted, unfit },
    )
    .await
    .unwrap();
}

pub(super) async fn narrow(pool: &SqlitePool, mat: &Materializer, key: &str, options: &str) {
    update_property_def_options_inner(pool, DEV, mat, TEST_SPACE_ID, key.into(), options.into())
        .await
        .unwrap();
}

pub(super) async fn trash(pool: &SqlitePool, mat: &Materializer, block: &str) {
    delete_block_inner(pool, DEV, mat, BlockId::from_trusted(block))
        .await
        .unwrap();
    settle(mat).await;
}

pub(super) fn unfit(live: i64, in_trash: i64) -> PropertyUnfitCounts {
    PropertyUnfitCounts {
        unfit: live,
        unfit_in_trash: in_trash,
    }
}

/// `key`'s row of `count_property_usage`, failing when it is not listed.
async fn usage(pool: &SqlitePool, key: &str) -> PropertyUsage {
    let rows = count_property_usage_inner(pool, TEST_SPACE_ID)
        .await
        .unwrap();
    rows.into_iter()
        .find(|row| row.key == key)
        .unwrap_or_else(|| panic!("`{key}` is not listed"))
}

/// Every value of `key` that doesn't fit, one page.
async fn unfit_values(pool: &SqlitePool, key: &str) -> Vec<UnfitPropertyValue> {
    let page = list_unfit_property_values_inner(pool, TEST_SPACE_ID, key.into(), None, Some(50))
        .await
        .unwrap();
    assert!(!page.has_more, "one page holds them");
    page.items
}

/// The forms of `key`'s values that don't fit, by block.
async fn unfit_forms(pool: &SqlitePool, key: &str) -> Vec<(String, PropertyValueForm)> {
    unfit_values(pool, key)
        .await
        .into_iter()
        .map(|v| (v.block_id, v.form))
        .collect()
}

async fn remove(
    pool: &SqlitePool,
    mat: &Materializer,
    key: &str,
    acknowledged: PropertyUnfitCounts,
) -> Result<WithOps<PropertyUnfitCounts>, AppError> {
    capture_op_refs(remove_unfit_property_values_inner(
        pool,
        DEV,
        mat,
        TEST_SPACE_ID,
        key.into(),
        acknowledged,
    ))
    .await
}

async fn add(
    pool: &SqlitePool,
    mat: &Materializer,
    key: &str,
) -> Result<WithOps<PropertyDefinition>, AppError> {
    capture_op_refs(add_unfit_values_to_options_inner(
        pool,
        DEV,
        mat,
        TEST_SPACE_ID,
        key.into(),
    ))
    .await
}

/// A `block_properties` row: the block and its five value slots.
pub(super) type Row = (
    String,
    Option<String>,
    Option<f64>,
    Option<String>,
    Option<String>,
    Option<i64>,
);

/// Every row under `key`, by block.
pub(super) async fn rows(pool: &SqlitePool, key: &str) -> Vec<Row> {
    sqlx::query_as(
        "SELECT block_id, value_text, value_num, value_date, value_ref, value_bool \
         FROM block_properties WHERE key = ? ORDER BY block_id",
    )
    .bind(key)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// [`TEST_SPACE_ID`]'s options for `key`.
async fn options(pool: &SqlitePool, key: &str) -> Option<String> {
    sqlx::query_scalar("SELECT options FROM property_definitions WHERE space_id = ? AND key = ?")
        .bind(TEST_SPACE_ID)
        .bind(key)
        .fetch_one(pool)
        .await
        .unwrap()
}

pub(super) async fn op_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// The op `op_ref` names: its type, its `block_id` and its payload.
pub(super) async fn op(
    pool: &SqlitePool,
    op_ref: &OpRef,
) -> (String, Option<String>, serde_json::Value) {
    let (op_type, block_id, payload): (String, Option<String>, String) = sqlx::query_as(
        "SELECT op_type, block_id, payload FROM op_log WHERE device_id = ? AND seq = ?",
    )
    .bind(&op_ref.device_id)
    .bind(op_ref.seq)
    .fetch_one(pool)
    .await
    .unwrap();
    (op_type, block_id, serde_json::from_str(&payload).unwrap())
}

/// The blocks of the space's doc holding a value under `key`, by block.
pub(super) fn engine_holders(mat: &Materializer, key: &str) -> Vec<String> {
    let mut held: Vec<String> = mat
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
    held.sort();
    held
}

/// Four content blocks `X`, `Y`, `Z`, `W` on the page `Home`, by block id.
async fn blocks(pool: &SqlitePool, mat: &Materializer) -> [String; 4] {
    space(pool).await;
    let home =
        create_page_in_space_inner(pool, DEV, mat, None, "Home".into(), TEST_SPACE_ID.into())
            .await
            .unwrap();
    let mut made = Vec::new();
    for content in ["X", "Y", "Z", "W"] {
        made.push(
            append_child(pool, mat, &home, content)
                .await
                .as_str()
                .to_owned(),
        );
    }
    made.try_into().unwrap()
}

/// `whenx`, a date: `X` holds the date 2026-01-05, `Y` "soon" and the trashed
/// `Z` "later", kept as text, and `W` the number 5, kept as a number. `note`
/// on `Y` is a text that fits.
async fn when_seed(pool: &SqlitePool, mat: &Materializer) -> [String; 4] {
    let [x, y, z, w] = blocks(pool, mat).await;
    declare(pool, mat, "whenx", "text", None).await;
    declare(pool, mat, "note", "text", None).await;
    set(pool, mat, &x, "whenx", V::Text("2026-01-05")).await;
    set(pool, mat, &y, "whenx", V::Text("soon")).await;
    set(pool, mat, &z, "whenx", V::Text("later")).await;
    set(pool, mat, &y, "note", V::Text("keep")).await;
    change(pool, mat, ("whenx", "number", None), (0, 3)).await;
    set(pool, mat, &w, "whenx", V::Num(5.0)).await;
    change(pool, mat, ("whenx", "date", None), (1, 3)).await;
    trash(pool, mat, &z).await;
    [x, y, z, w]
}

/// `stagex`, a select of `["z", "q"]`: `X` holds "d", `Y` "b" and the
/// trashed `Z` "c", options it lost, and `W` the number 5, from when it was a
/// number.
async fn stage_seed(pool: &SqlitePool, mat: &Materializer) -> [String; 4] {
    let [x, y, z, w] = blocks(pool, mat).await;
    declare(pool, mat, "stagex", "number", None).await;
    set(pool, mat, &w, "stagex", V::Num(5.0)).await;
    change(
        pool,
        mat,
        ("stagex", "select", Some(r#"["z","d","b","c"]"#)),
        (0, 1),
    )
    .await;
    set(pool, mat, &x, "stagex", V::Text("d")).await;
    set(pool, mat, &y, "stagex", V::Text("b")).await;
    set(pool, mat, &z, "stagex", V::Text("c")).await;
    trash(pool, mat, &z).await;
    narrow(pool, mat, "stagex", r#"["z", "q"]"#).await;
    [x, y, z, w]
}

/// One `block_properties` slot, as a raw row holds it.
enum Slot<'a> {
    Text(&'a str),
    Num(f64),
    Date(&'a str),
    Ref(&'a str),
    Bool(bool),
}

/// A raw `block_properties` row: `block` holds `slot` under `key`.
async fn put(pool: &SqlitePool, block: &str, key: &str, slot: Slot<'_>) {
    let (mut text, mut num, mut date, mut target, mut flag) = (None, None, None, None, None);
    match slot {
        Slot::Text(v) => text = Some(v),
        Slot::Num(v) => num = Some(v),
        Slot::Date(v) => date = Some(v),
        Slot::Ref(v) => target = Some(v),
        Slot::Bool(v) => flag = Some(v),
    }
    sqlx::query(
        "INSERT INTO block_properties \
         (block_id, key, value_text, value_num, value_date, value_ref, value_bool) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(block)
    .bind(key)
    .bind(text)
    .bind(num)
    .bind(date)
    .bind(target)
    .bind(flag)
    .execute(pool)
    .await
    .unwrap();
}

/// `count` pages `P1`, `P2`, … of [`TEST_SPACE_ID`], as raw rows, by block id.
async fn raw_pages(pool: &SqlitePool, count: usize) -> Vec<String> {
    ensure_test_space(pool).await;
    let ids: Vec<String> = (1..=count)
        .map(|i| format!("01HZ000000000000000000PRD{i}"))
        .collect();
    for (i, id) in ids.iter().enumerate() {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id, position, space_id) \
             VALUES (?1, 'page', ?2, ?1, ?3, ?4)",
        )
        .bind(id)
        .bind(format!("P{}", i + 1))
        .bind(i64::try_from(i).unwrap() + 1)
        .bind(TEST_SPACE_ID)
        .execute(pool)
        .await
        .unwrap();
    }
    ids
}

/// The predicate, one value form at a time under each type, from raw rows:
/// `P1`–`P5` hold, under every key, a text, a number, a date, a ref and a
/// boolean; `P6` holds "z" under the selects.
#[tokio::test]
async fn each_type_takes_only_its_own_forms_6206() {
    use PropertyValueForm::{Boolean, Date, Number, Ref, Text};
    let (pool, _dir) = test_pool().await;
    let p = raw_pages(&pool, 6).await;
    let types = [
        ("k-text", "text", None),
        ("k-url", "url", None),
        ("k-select", "select", Some(r#"["a"]"#)),
        ("k-open", "select", None),
        ("k-number", "number", None),
        ("k-date", "date", None),
        ("k-boolean", "boolean", None),
        ("k-ref", "ref", None),
    ];
    for (key, ty, opts) in types {
        sqlx::query(
            "INSERT INTO property_definitions (space_id, key, value_type, options, created_at) \
             VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')",
        )
        .bind(TEST_SPACE_ID)
        .bind(key)
        .bind(ty)
        .bind(opts)
        .execute(&pool)
        .await
        .unwrap();
        put(&pool, &p[0], key, Slot::Text("a")).await;
        put(&pool, &p[1], key, Slot::Num(5.0)).await;
        put(&pool, &p[2], key, Slot::Date("2026-01-05")).await;
        put(&pool, &p[3], key, Slot::Ref(&p[5])).await;
        put(&pool, &p[4], key, Slot::Bool(true)).await;
    }
    put(&pool, &p[5], "k-select", Slot::Text("z")).await;
    put(&pool, &p[5], "k-open", Slot::Text("z")).await;
    put(&pool, &p[0], "repeat-count", Slot::Text("lots")).await;
    put(&pool, &p[1], "repeat-count", Slot::Num(3.0)).await;
    put(&pool, &p[0], "is_space", Slot::Text("yes")).await;
    put(&pool, &p[1], "loose", Slot::Num(1.0)).await;

    let at = |i: usize, form| (p[i].clone(), form);
    let want = [
        ("k-text", vec![at(1, Number), at(2, Date), at(4, Boolean)]),
        (
            "k-url",
            vec![at(1, Number), at(2, Date), at(3, Ref), at(4, Boolean)],
        ),
        (
            "k-select",
            vec![at(1, Number), at(2, Date), at(4, Boolean), at(5, Text)],
        ),
        ("k-open", vec![at(1, Number), at(2, Date), at(4, Boolean)]),
        (
            "k-number",
            vec![at(0, Text), at(2, Date), at(3, Ref), at(4, Boolean)],
        ),
        (
            "k-date",
            vec![at(0, Text), at(1, Number), at(3, Ref), at(4, Boolean)],
        ),
        (
            "k-boolean",
            vec![at(0, Text), at(1, Number), at(2, Date), at(3, Ref)],
        ),
        (
            "k-ref",
            vec![at(0, Text), at(1, Number), at(2, Date), at(4, Boolean)],
        ),
        ("repeat-count", vec![at(0, Text)]),
        ("is_space", vec![]),
        ("loose", vec![]),
    ];
    for (key, forms) in want {
        assert_eq!(unfit_forms(&pool, key).await, forms, "{key}");
    }
    let values: Vec<String> = unfit_values(&pool, "k-url")
        .await
        .into_iter()
        .map(|v| v.value)
        .collect();
    assert_eq!(
        values,
        vec![
            "5".to_owned(),
            "2026-01-05".into(),
            p[5].clone(),
            "true".into()
        ],
        "each value as text"
    );
}

/// A built-in is held to its definition as a user's key is: `listStyle`, a
/// select of `bullet` and `ordered`, takes those and no other text, whose
/// options are the code constant's, not a `property_definitions` row's.
#[tokio::test]
async fn a_builtin_select_takes_only_its_options_6206() {
    use PropertyValueForm::{Number, Text};
    let (pool, _dir) = test_pool().await;
    let p = raw_pages(&pool, 3).await;
    put(&pool, &p[0], "listStyle", Slot::Text("ordered")).await;
    put(&pool, &p[1], "listStyle", Slot::Text("zigzag")).await;
    put(&pool, &p[2], "listStyle", Slot::Num(1.0)).await;

    assert_eq!(
        unfit_forms(&pool, "listStyle").await,
        vec![(p[1].clone(), Text), (p[2].clone(), Number)],
        "`ordered` is an option; `zigzag` and a number are not"
    );
}

/// A space's definitions hold the values of its blocks, and of its own block,
/// which a rewrite's value writes reach; another space's blocks holding the
/// same key are none of them: a removal there would be a loss in a space that
/// never saw the dialog.
#[tokio::test]
async fn the_scope_is_the_spaces_blocks_and_its_own_never_another_spaces_6206() {
    let (pool, _dir) = test_pool().await;
    let p = raw_pages(&pool, 1).await;
    ensure_test_space_b(&pool).await;
    let other = "01HZ000000000000000000OTH1";
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, page_id, position, space_id) \
         VALUES (?1, 'page', 'Other', ?1, 1, ?2)",
    )
    .bind(other)
    .bind(TEST_SPACE_B_ID)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO property_definitions (space_id, key, value_type, options, created_at) \
         VALUES (?, 'k-number', 'number', NULL, '2026-01-01T00:00:00.000Z')",
    )
    .bind(TEST_SPACE_ID)
    .execute(&pool)
    .await
    .unwrap();
    for holder in [p[0].as_str(), TEST_SPACE_ID, other] {
        put(&pool, holder, "k-number", Slot::Text("soon")).await;
    }

    assert_eq!(
        unfit_forms(&pool, "k-number").await,
        vec![
            (p[0].clone(), PropertyValueForm::Text),
            (TEST_SPACE_ID.to_owned(), PropertyValueForm::Text)
        ],
        "its page and its own block, not the other space's"
    );
    assert_eq!(
        usage(&pool, "k-number").await.unfit,
        unfit(2, 0),
        "the count takes the same two"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn usage_counts_live_and_trashed_values_that_dont_fit_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    when_seed(&pool, &mat).await;
    declare(&pool, &mat, "unused", "text", None).await;

    assert_eq!(
        usage(&pool, "whenx").await,
        PropertyUsage {
            key: "whenx".into(),
            count: 3,
            unfit: unfit(2, 1),
        },
        "Y and W live, Z in the Trash"
    );
    for key in ["note", "unused", "repeat-count"] {
        assert_eq!(usage(&pool, key).await.unfit, unfit(0, 0), "{key}");
    }
    let listed: Vec<String> = count_property_usage_inner(&pool, TEST_SPACE_ID)
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.key)
        .collect();
    assert!(
        !listed.iter().any(|k| k == "space" || k == "is_space"),
        "membership keys are not listed: {listed:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_pages_values_that_dont_fit_by_block_id_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [_, y, z, w] = when_seed(&pool, &mat).await;
    let home: String = sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
        .bind(&y)
        .fetch_one(&pool)
        .await
        .unwrap();

    let mut seen = Vec::new();
    let mut cursor = None;
    loop {
        let page =
            list_unfit_property_values_inner(&pool, TEST_SPACE_ID, "whenx".into(), cursor, Some(1))
                .await
                .unwrap();
        assert_eq!(page.items.len(), 1, "one value a page");
        seen.extend(page.items);
        if !page.has_more {
            break;
        }
        cursor = page.next_cursor;
    }
    let mut want = [
        (y, "Y", "soon", false, PropertyValueForm::Text),
        (z, "Z", "later", true, PropertyValueForm::Text),
        (w, "W", "5", false, PropertyValueForm::Number),
    ];
    want.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        seen.iter()
            .map(|v| (
                v.block_id.clone(),
                v.content.as_deref().unwrap_or_default(),
                v.value.as_str(),
                v.deleted,
                v.form
            ))
            .collect::<Vec<_>>(),
        want.iter()
            .map(|(id, content, value, deleted, form)| (
                id.clone(),
                *content,
                *value,
                *deleted,
                *form
            ))
            .collect::<Vec<_>>(),
        "every value that doesn't fit, by block id, the trashed one marked"
    );
    for v in &seen {
        assert_eq!(v.page_id.as_deref(), Some(home.as_str()), "{v:?}");
        assert_eq!(v.page_title.as_deref(), Some("Home"), "{v:?}");
    }

    assert!(
        unfit_values(&pool, "nothing").await.is_empty(),
        "an undeclared key has none"
    );
    for limit in [0, 201] {
        let refused = list_unfit_property_values_inner(
            &pool,
            TEST_SPACE_ID,
            "whenx".into(),
            None,
            Some(limit),
        )
        .await;
        assert!(
            matches!(refused, Err(AppError::Validation { .. })),
            "limit {limit}: {refused:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_takes_out_every_value_that_doesnt_fit_in_one_op_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [x, y, z, w] = when_seed(&pool, &mat).await;
    let notes = rows(&pool, "note").await;
    let before = op_count(&pool).await;

    let removed = remove(&pool, &mat, "whenx", unfit(2, 1)).await.unwrap();

    assert_eq!(removed.inner, unfit(2, 1), "what it removed");
    assert_eq!(
        rows(&pool, "whenx").await,
        vec![(x.clone(), None, None, Some("2026-01-05".into()), None, None)],
        "only the date that fits is left"
    );
    assert_eq!(
        engine_holders(&mat, "whenx"),
        vec![x],
        "and the doc holds no other"
    );
    assert_eq!(rows(&pool, "note").await, notes, "another key is untouched");
    assert_eq!(op_count(&pool).await, before + 1, "one op");
    assert_eq!(removed.op_refs.len(), 1);
    let (op_type, block_id, payload) = op(&pool, &removed.op_refs[0]).await;
    assert_eq!(op_type, "rewrite_properties");
    assert_eq!(
        block_id.as_deref(),
        Some(TEST_SPACE_ID),
        "filed under its space"
    );
    assert_eq!(payload["reason"], "remove_unfit");
    assert_eq!(
        payload["defs"],
        serde_json::json!([]),
        "no definition write"
    );
    let mut writes: Vec<(String, serde_json::Value, serde_json::Value)> = payload["values"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| {
            assert_eq!(w["key"], "whenx");
            let prior = w["prior"]
                .as_object()
                .map_or(serde_json::Value::Null, |slots| {
                    slots
                        .iter()
                        .filter(|(_, v)| !v.is_null())
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect()
                });
            (
                w["block_id"].as_str().unwrap().to_owned(),
                w["value"].clone(),
                prior,
            )
        })
        .collect();
    writes.sort_by(|a, b| a.0.cmp(&b.0));
    let mut want = vec![
        (
            y,
            serde_json::Value::Null,
            serde_json::json!({"value_text": "soon"}),
        ),
        (
            z,
            serde_json::Value::Null,
            serde_json::json!({"value_text": "later"}),
        ),
        (
            w,
            serde_json::Value::Null,
            serde_json::json!({"value_num": 5.0}),
        ),
    ];
    want.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        writes, want,
        "each value removed, recording it as the doc held it"
    );
    assert_eq!(usage(&pool, "whenx").await.unfit, unfit(0, 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_refuses_a_stale_acknowledgement_and_writes_nothing_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    when_seed(&pool, &mat).await;
    let seed = rows(&pool, "whenx").await;
    let before = op_count(&pool).await;

    for stale in [unfit(2, 0), unfit(3, 1), unfit(0, 0)] {
        let refused = remove(&pool, &mat, "whenx", stale).await;
        assert_eq!(
            refused.err().and_then(|e| e.validation_code()),
            Some(ValidationCode::UnacknowledgedPropertyLoss),
            "{stale:?} is refused, coded"
        );
    }
    assert_eq!(op_count(&pool).await, before, "no refusal appends an op");
    assert_eq!(
        rows(&pool, "whenx").await,
        seed,
        "every value is still there"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_restores_every_value_removed_and_redo_removes_them_again_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [x, ..] = when_seed(&pool, &mat).await;
    let seed = rows(&pool, "whenx").await;
    let held = engine_holders(&mat, "whenx");
    let removed = remove(&pool, &mat, "whenx", unfit(2, 1)).await.unwrap();

    let undone = undo_ops_inner(&pool, DEV, &mat, removed.op_refs)
        .await
        .unwrap();
    assert_eq!(undone.len(), 1, "one undo");
    assert_eq!(undone[0].new_op_type, "rewrite_properties");
    assert_eq!(rows(&pool, "whenx").await, seed, "every value as it was");
    assert_eq!(
        engine_holders(&mat, "whenx"),
        held,
        "the doc holds them again"
    );
    assert_eq!(
        usage(&pool, "whenx").await.unfit,
        unfit(2, 1),
        "and they still don't fit"
    );

    let undo = &undone[0].new_op_ref;
    redo_page_op_inner(&pool, DEV, &mat, undo.device_id.clone(), undo.seq)
        .await
        .unwrap();
    assert_eq!(
        rows(&pool, "whenx").await,
        vec![(x, None, None, Some("2026-01-05".into()), None, None)],
        "removed again"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_puts_back_a_boolean_and_a_date_kept_as_text_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [x, y, ..] = blocks(&pool, &mat).await;
    declare(&pool, &mat, "flagx", "boolean", None).await;
    declare(&pool, &mat, "dayx", "date", None).await;
    set(&pool, &mat, &x, "flagx", V::Bool(true)).await;
    set(&pool, &mat, &y, "dayx", V::Date("2026-01-05")).await;
    change(&pool, &mat, ("flagx", "number", None), (0, 1)).await;
    change(&pool, &mat, ("dayx", "number", None), (0, 1)).await;
    let flag_rows = rows(&pool, "flagx").await;
    let day_rows = rows(&pool, "dayx").await;
    assert_eq!(
        (flag_rows[0].5, day_rows[0].1.as_deref()),
        (Some(1), Some("2026-01-05")),
        "the boolean keeps its slot; the date stays as the text it reads"
    );

    for (key, seed) in [("flagx", flag_rows), ("dayx", day_rows)] {
        let removed = remove(&pool, &mat, key, unfit(1, 0)).await.unwrap();
        assert!(rows(&pool, key).await.is_empty(), "{key}: removed");
        undo_ops_inner(&pool, DEV, &mat, removed.op_refs)
            .await
            .unwrap();
        assert_eq!(rows(&pool, key).await, seed, "{key}: as it was");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_with_nothing_to_remove_appends_no_op_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    when_seed(&pool, &mat).await;
    let before = op_count(&pool).await;

    for key in ["note", "nothing"] {
        let removed = remove(&pool, &mat, key, unfit(0, 0)).await.unwrap();
        assert_eq!(removed.inner, unfit(0, 0), "{key}");
        assert!(removed.op_refs.is_empty(), "{key}: no op to undo");
    }
    assert_eq!(op_count(&pool).await, before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_to_options_appends_the_texts_that_dont_fit_sorted_in_one_op_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [_, _, _, w] = stage_seed(&pool, &mat).await;
    assert_eq!(usage(&pool, "stagex").await.unfit, unfit(3, 1));
    let before = op_count(&pool).await;

    let added = add(&pool, &mat, "stagex").await.unwrap();

    let want = r#"["z","q","b","c","d"]"#;
    assert_eq!(
        added.inner.options.as_deref(),
        Some(want),
        "after the options it had"
    );
    assert_eq!(options(&pool, "stagex").await.as_deref(), Some(want));
    assert_eq!(op_count(&pool).await, before + 1, "one op");
    assert_eq!(added.op_refs.len(), 1);
    let (op_type, block_id, _) = op(&pool, &added.op_refs[0]).await;
    assert_eq!(op_type, "set_property_def");
    assert_eq!(block_id.as_deref(), Some(TEST_SPACE_ID));
    assert_eq!(
        unfit_forms(&pool, "stagex").await,
        vec![(w, PropertyValueForm::Number)],
        "the number still doesn't fit"
    );

    let again = add(&pool, &mat, "stagex").await.unwrap();
    assert!(again.op_refs.is_empty(), "nothing left to add");
    assert_eq!(again.inner.options.as_deref(), Some(want));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_to_options_with_nothing_to_add_appends_no_op_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [.., w] = blocks(&pool, &mat).await;
    declare(&pool, &mat, "sizex", "number", None).await;
    set(&pool, &mat, &w, "sizex", V::Num(5.0)).await;
    change(
        &pool,
        &mat,
        ("sizex", "select", Some(r#"["s", "m"]"#)),
        (0, 1),
    )
    .await;
    let before = op_count(&pool).await;

    let added = add(&pool, &mat, "sizex").await.unwrap();

    assert!(added.op_refs.is_empty(), "a number is no option");
    assert_eq!(op_count(&pool).await, before);
    assert_eq!(
        added.inner.options.as_deref(),
        Some(r#"["s", "m"]"#),
        "the options as stored"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_to_options_refuses_what_isnt_a_users_select_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    when_seed(&pool, &mat).await;
    let before = op_count(&pool).await;

    let date = add(&pool, &mat, "whenx").await;
    assert!(
        matches!(date, Err(AppError::Validation { code: None, .. })),
        "a date has no options: {date:?}"
    );
    let builtin = add(&pool, &mat, "listStyle").await;
    assert_eq!(
        builtin.err().and_then(|e| e.validation_code()),
        Some(ValidationCode::BuiltinPropertyLocked),
        "a built-in select is fixed"
    );
    let undeclared = add(&pool, &mat, "nothing").await;
    assert!(
        matches!(undeclared, Err(AppError::NotFound(_))),
        "got {undeclared:?}"
    );
    assert_eq!(op_count(&pool).await, before, "no refusal appends an op");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_of_add_to_options_restores_the_options_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    stage_seed(&pool, &mat).await;
    let added = add(&pool, &mat, "stagex").await.unwrap();
    assert_eq!(
        options(&pool, "stagex").await.as_deref(),
        Some(r#"["z","q","b","c","d"]"#)
    );

    undo_ops_inner(&pool, DEV, &mat, added.op_refs)
        .await
        .unwrap();

    assert_eq!(
        options(&pool, "stagex").await.as_deref(),
        Some(r#"["z", "q"]"#),
        "the options it had"
    );
    assert_eq!(usage(&pool, "stagex").await.unfit, unfit(3, 1));
}
