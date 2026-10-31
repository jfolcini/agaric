//! A key's values that don't fit its definition, grouped by the value as
//! shown and replaced as the user maps each (#6206).

use super::prelude::*;
use super::property_unfit_cmd_tests::{
    Row, V, change, declare, engine_holders, narrow, op, op_count, rows, set, space, trash, unfit,
};
use agaric_core::error::ValidationCode;
use agaric_engine::loro::engine::PropertyValue;
use agaric_store::op::{PropertyValueFields, SetPropertyPayload};
use serde_json::{Value, json};

/// A peer's set, which no local write makes: `block` holds `value` under
/// `key` whatever the space declares it as.
async fn peer_set(
    pool: &SqlitePool,
    mat: &Materializer,
    block: &str,
    key: &str,
    value: PropertyValueFields,
) {
    let payload = OpPayload::SetProperty(SetPropertyPayload::with_value(
        BlockId::from_trusted(block),
        key.into(),
        value,
    ));
    let record = op_log::append_local_op_at(pool, DEV, payload, agaric_lib::db::now_ms())
        .await
        .unwrap();
    let mut conn = pool.acquire().await.unwrap();
    agaric_engine::apply::kernel::apply_op_projected(&mut conn, &record, mat.loro_state(), false)
        .await
        .unwrap();
}

async fn peer_number(pool: &SqlitePool, mat: &Materializer, block: &str, key: &str, n: f64) {
    let value = PropertyValueFields {
        value_num: Some(n),
        ..Default::default()
    };
    peer_set(pool, mat, block, key, value).await;
}

async fn peer_bool(pool: &SqlitePool, mat: &Materializer, block: &str, key: &str, b: bool) {
    let value = PropertyValueFields {
        value_bool: Some(b),
        ..Default::default()
    };
    peer_set(pool, mat, block, key, value).await;
}

/// What the space's doc holds under `key`, by block: the form it stores each
/// value in, which SQL does not show.
fn engine_values(mat: &Materializer, key: &str) -> Vec<(String, PropertyValue)> {
    let mut held = mat
        .loro_state()
        .registry
        .for_space(&SpaceId::from_trusted(TEST_SPACE_ID), DEV)
        .unwrap()
        .engine_mut()
        .read_property_holders(key)
        .unwrap();
    held.sort_by(|a, b| a.0.cmp(&b.0));
    held
}

/// `N` cards on the page `Home` of [`TEST_SPACE_ID`], in creation order.
async fn cards<const N: usize>(pool: &SqlitePool, mat: &Materializer) -> [String; N] {
    space(pool).await;
    let home =
        create_page_in_space_inner(pool, DEV, mat, None, "Home".into(), TEST_SPACE_ID.into())
            .await
            .unwrap();
    let mut made = Vec::new();
    for i in 0..N {
        let card = append_child(pool, mat, &home, &format!("C{i}")).await;
        made.push(card.as_str().to_owned());
    }
    made.try_into().unwrap()
}

/// `whenx`, a date: `A` holds the date 2026-01-05, which fits; `B` and `C`
/// "soon", the trashed `D` "later" and `E` "5", kept as text; and `F` the
/// number 5, a peer's.
async fn when_seed(pool: &SqlitePool, mat: &Materializer) -> [String; 6] {
    let made = cards::<6>(pool, mat).await;
    let [a, b, c, d, e, f] = &made;
    declare(pool, mat, "whenx", "text", None).await;
    for (card, text) in [
        (a, "2026-01-05"),
        (b, "soon"),
        (c, "soon"),
        (d, "later"),
        (e, "5"),
    ] {
        set(pool, mat, card, "whenx", V::Text(text)).await;
    }
    change(pool, mat, ("whenx", "date", None), (1, 4)).await;
    trash(pool, mat, d).await;
    peer_number(pool, mat, f, "whenx", 5.0).await;
    made
}

/// A key of each type holding one value that doesn't fit: the number
/// `effortx` "lots", the boolean `donex` "maybe", the select `stagex` of
/// `["z", "q"]` "d", the text `notex` a peer's number 42, and the date `dayx`
/// "soon". Returns their cards in that order.
async fn typed_seed(pool: &SqlitePool, mat: &Materializer) -> [String; 5] {
    let made = cards::<5>(pool, mat).await;
    let [effort, done, stage, note, day] = &made;
    for (card, key, text, ty) in [
        (effort, "effortx", "lots", "number"),
        (done, "donex", "maybe", "boolean"),
        (day, "dayx", "soon", "date"),
    ] {
        declare(pool, mat, key, "text", None).await;
        set(pool, mat, card, key, V::Text(text)).await;
        change(pool, mat, (key, ty, None), (0, 1)).await;
    }
    declare(pool, mat, "stagex", "select", Some(r#"["d","z","q"]"#)).await;
    set(pool, mat, stage, "stagex", V::Text("d")).await;
    narrow(pool, mat, "stagex", r#"["z","q"]"#).await;
    declare(pool, mat, "notex", "text", None).await;
    peer_number(pool, mat, note, "notex", 42.0).await;
    made
}

const TYPED_KEYS: [&str; 5] = ["effortx", "donex", "stagex", "notex", "dayx"];

fn map(value: &str, replacement: &str, acknowledged: PropertyUnfitCounts) -> UnfitValueReplacement {
    UnfitValueReplacement {
        value: value.into(),
        replacement: replacement.into(),
        acknowledged,
    }
}

async fn distinct(
    pool: &SqlitePool,
    key: &str,
    cursor: Option<String>,
    limit: i64,
) -> Result<PageResponse<DistinctUnfitValue>, AppError> {
    list_distinct_unfit_property_values_inner(pool, TEST_SPACE_ID, key.into(), cursor, Some(limit))
        .await
}

/// Every distinct value of `key` that doesn't fit, one page.
async fn groups(pool: &SqlitePool, key: &str) -> Vec<(String, PropertyUnfitCounts)> {
    let page = distinct(pool, key, None, 50).await.unwrap();
    assert!(!page.has_more, "one page holds them");
    page.items
        .into_iter()
        .map(|g| (g.value, g.counts))
        .collect()
}

fn group(value: &str, counts: PropertyUnfitCounts) -> (String, PropertyUnfitCounts) {
    (value.to_owned(), counts)
}

async fn convert(
    pool: &SqlitePool,
    mat: &Materializer,
    key: &str,
    replacements: Vec<UnfitValueReplacement>,
) -> Result<WithOps<PropertyUnfitCounts>, AppError> {
    capture_op_refs(convert_unfit_property_values_inner(
        pool,
        DEV,
        mat,
        TEST_SPACE_ID,
        key.into(),
        replacements,
    ))
    .await
}

/// A row of `block` holding one slot: a date, a text or a number.
fn dated(block: &str, date: &str) -> Row {
    (block.to_owned(), None, None, Some(date.into()), None, None)
}

fn texted(block: &str, text: &str) -> Row {
    (block.to_owned(), Some(text.into()), None, None, None, None)
}

fn numbered(block: &str, n: f64) -> Row {
    (block.to_owned(), None, Some(n), None, None, None)
}

fn sorted(mut want: Vec<Row>) -> Vec<Row> {
    want.sort_by(|a, b| a.0.cmp(&b.0));
    want
}

/// A rewrite's value writes as `(block, value, prior)`, each with its set
/// slots only, by block.
fn writes(payload: &Value, key: &str) -> Vec<(String, Value, Value)> {
    let slots = |v: &Value| {
        v.as_object().map_or(Value::Null, |slots| {
            slots
                .iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
    };
    let mut writes: Vec<_> = payload["values"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| {
            assert_eq!(w["key"], key);
            (
                w["block_id"].as_str().unwrap().to_owned(),
                slots(&w["value"]),
                slots(&w["prior"]),
            )
        })
        .collect();
    writes.sort_by(|a, b| a.0.cmp(&b.0));
    writes
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn distinct_values_count_live_and_trashed_and_page_by_value_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    when_seed(&pool, &mat).await;

    let mut seen = Vec::new();
    let mut cursor = None;
    loop {
        let page = distinct(&pool, "whenx", cursor, 1).await.unwrap();
        assert_eq!(page.items.len(), 1, "one value a page");
        seen.extend(page.items.into_iter().map(|g| (g.value, g.counts)));
        if !page.has_more {
            break;
        }
        cursor = page.next_cursor;
    }
    assert_eq!(
        seen,
        vec![
            group("5", unfit(2, 0)),
            group("later", unfit(0, 1)),
            group("soon", unfit(2, 0)),
        ],
        "by value as shown, the text 5 and the number 5 as one, the trashed one apart"
    );
    assert!(
        groups(&pool, "nothing").await.is_empty(),
        "an undeclared key has none"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn distinct_values_refuse_a_limit_out_of_range_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    when_seed(&pool, &mat).await;

    for limit in [0, 201] {
        let refused = distinct(&pool, "whenx", None, limit).await;
        assert!(
            matches!(refused, Err(AppError::Validation { .. })),
            "limit {limit}: {refused:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn convert_writes_each_mapped_value_in_one_op_and_leaves_the_rest_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [a, b, c, d, e, f] = when_seed(&pool, &mat).await;
    let held = engine_holders(&mat, "whenx");
    let before = op_count(&pool).await;

    let converted = convert(
        &pool,
        &mat,
        "whenx",
        vec![
            map("soon", "2026-03-01", unfit(2, 0)),
            map("later", "2026-04-01", unfit(0, 1)),
        ],
    )
    .await
    .unwrap();

    assert_eq!(converted.inner, unfit(2, 1), "what it converted");
    assert_eq!(
        rows(&pool, "whenx").await,
        sorted(vec![
            dated(&a, "2026-01-05"),
            dated(&b, "2026-03-01"),
            dated(&c, "2026-03-01"),
            dated(&d, "2026-04-01"),
            texted(&e, "5"),
            numbered(&f, 5.0),
        ]),
        "each mapped value is a date now, the Trash's too; the 5s stay"
    );
    assert_eq!(
        engine_holders(&mat, "whenx"),
        held,
        "the doc holds them all"
    );
    assert_eq!(groups(&pool, "whenx").await, vec![group("5", unfit(2, 0))]);
    assert_eq!(op_count(&pool).await, before + 1, "one op");
    assert_eq!(converted.op_refs.len(), 1);
    let (op_type, block_id, payload) = op(&pool, &converted.op_refs[0]).await;
    assert_eq!(op_type, "rewrite_properties");
    assert_eq!(
        block_id.as_deref(),
        Some(TEST_SPACE_ID),
        "filed under its space"
    );
    assert_eq!(payload["reason"], "convert_unfit");
    assert_eq!(payload["defs"], json!([]), "no definition write");
    let write = |block: &str, to: &str, from: &str| {
        (
            block.to_owned(),
            json!({ "value_text": to }),
            json!({ "value_text": from }),
        )
    };
    let mut want = vec![
        write(&b, "2026-03-01", "soon"),
        write(&c, "2026-03-01", "soon"),
        write(&d, "2026-04-01", "later"),
    ];
    want.sort_by(|x, y| x.0.cmp(&y.0));
    assert_eq!(
        writes(&payload, "whenx"),
        want,
        "each value replaced, recording it as the doc held it"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn convert_reads_a_replacement_under_the_type_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [effort, done, stage, note, _] = typed_seed(&pool, &mat).await;

    for (key, value, replacement, want, written, held) in [
        (
            "effortx",
            "lots",
            "3",
            numbered(&effort, 3.0),
            json!({ "value_num": 3.0 }),
            PropertyValue::Num(3.0),
        ),
        (
            "donex",
            "maybe",
            "true",
            (done.clone(), None, None, None, None, Some(1)),
            json!({ "value_bool": true }),
            PropertyValue::Bool(true),
        ),
        (
            "stagex",
            "d",
            "q",
            texted(&stage, "q"),
            json!({ "value_text": "q" }),
            PropertyValue::Str("q".into()),
        ),
        (
            "notex",
            "42",
            "42",
            texted(&note, "42"),
            json!({ "value_text": "42" }),
            PropertyValue::Str("42".into()),
        ),
    ] {
        let converted = convert(&pool, &mat, key, vec![map(value, replacement, unfit(1, 0))])
            .await
            .unwrap();
        assert_eq!(converted.inner, unfit(1, 0), "{key}");
        assert_eq!(
            rows(&pool, key).await,
            vec![want],
            "{key}: {replacement:?} as its type reads it"
        );
        assert!(groups(&pool, key).await.is_empty(), "{key}: it fits now");
        let (_, _, payload) = op(&pool, &converted.op_refs[0]).await;
        let values: Vec<Value> = writes(&payload, key).into_iter().map(|w| w.1).collect();
        assert_eq!(
            values,
            vec![written],
            "{key}: the op writes it in the form a typed write gives it"
        );
        let in_doc: Vec<PropertyValue> = engine_values(&mat, key)
            .into_iter()
            .map(|(_, v)| v)
            .collect();
        assert_eq!(in_doc, vec![held], "{key}: and the doc holds it so");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn convert_refuses_a_stale_acknowledgement_and_writes_nothing_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    when_seed(&pool, &mat).await;
    let seed = rows(&pool, "whenx").await;
    let before = op_count(&pool).await;

    for (what, replacements) in [
        ("one fewer", vec![map("soon", "2026-03-01", unfit(1, 0))]),
        ("one more", vec![map("soon", "2026-03-01", unfit(2, 1))]),
        ("none", vec![map("soon", "2026-03-01", unfit(0, 0))]),
        ("a value gone", vec![map("gone", "2026-03-01", unfit(1, 0))]),
        (
            "the second of two",
            vec![
                map("later", "2026-04-01", unfit(0, 1)),
                map("soon", "2026-03-01", unfit(1, 0)),
            ],
        ),
    ] {
        let refused = convert(&pool, &mat, "whenx", replacements).await;
        assert_eq!(
            refused.err().and_then(|e| e.validation_code()),
            Some(ValidationCode::UnacknowledgedPropertyLoss),
            "{what} is refused, coded"
        );
    }
    assert_eq!(op_count(&pool).await, before, "no refusal appends an op");
    assert_eq!(rows(&pool, "whenx").await, seed, "every value as it was");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn convert_refuses_a_replacement_that_doesnt_fit_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    typed_seed(&pool, &mat).await;
    let mut seed = Vec::new();
    for key in TYPED_KEYS {
        seed.push(rows(&pool, key).await);
    }
    let before = op_count(&pool).await;

    for (key, value, replacement) in [
        ("dayx", "soon", "2026-02-30"),
        ("donex", "maybe", "yes"),
        ("effortx", "lots", "abc"),
        ("stagex", "d", "w"),
        ("notex", "42", " "),
    ] {
        let refused = convert(&pool, &mat, key, vec![map(value, replacement, unfit(1, 0))]).await;
        assert!(
            matches!(refused, Err(AppError::Validation { code: None, .. })),
            "{key}: {replacement:?} doesn't fit: {refused:?}"
        );
    }
    assert_eq!(op_count(&pool).await, before, "no refusal appends an op");
    for (key, seed) in TYPED_KEYS.into_iter().zip(seed) {
        assert_eq!(rows(&pool, key).await, seed, "{key}: as it was");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn convert_refuses_no_replacements_a_value_twice_a_ref_key_and_an_undeclared_key_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    when_seed(&pool, &mat).await;
    declare(&pool, &mat, "ownerx", "ref", None).await;
    let before = op_count(&pool).await;

    for (what, key, replacements) in [
        ("no replacement", "whenx", vec![]),
        (
            "a value twice",
            "whenx",
            vec![
                map("soon", "2026-03-01", unfit(2, 0)),
                map("soon", "2026-03-02", unfit(2, 0)),
            ],
        ),
        ("a ref key", "ownerx", vec![map("x", "y", unfit(0, 0))]),
    ] {
        let refused = convert(&pool, &mat, key, replacements).await;
        assert!(
            matches!(refused, Err(AppError::Validation { code: None, .. })),
            "{what}: {refused:?}"
        );
    }
    let undeclared = convert(&pool, &mat, "nothing", vec![map("x", "y", unfit(0, 0))]).await;
    assert!(
        matches!(undeclared, Err(AppError::NotFound(_))),
        "got {undeclared:?}"
    );
    assert_eq!(op_count(&pool).await, before, "no refusal appends an op");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_restores_the_values_converted_and_redo_converts_them_again_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    when_seed(&pool, &mat).await;
    let seed = rows(&pool, "whenx").await;
    let held = engine_holders(&mat, "whenx");
    let mapping = vec![
        map("soon", "2026-03-01", unfit(2, 0)),
        map("later", "2026-04-01", unfit(0, 1)),
    ];
    let converted = convert(&pool, &mat, "whenx", mapping).await.unwrap();
    let after = rows(&pool, "whenx").await;

    let undone = undo_ops_inner(&pool, DEV, &mat, converted.op_refs)
        .await
        .unwrap();
    assert_eq!(undone.len(), 1, "one undo");
    assert_eq!(undone[0].new_op_type, "rewrite_properties");
    assert_eq!(rows(&pool, "whenx").await, seed, "every value as it was");
    assert_eq!(engine_holders(&mat, "whenx"), held);
    assert_eq!(
        groups(&pool, "whenx").await,
        vec![
            group("5", unfit(2, 0)),
            group("later", unfit(0, 1)),
            group("soon", unfit(2, 0)),
        ],
        "and they don't fit again"
    );

    let undo = &undone[0].new_op_ref;
    redo_page_op_inner(&pool, DEV, &mat, undo.device_id.clone(), undo.seq)
        .await
        .unwrap();
    assert_eq!(rows(&pool, "whenx").await, after, "converted again");
}

/// The text `5`, a peer's number 5 (one of them in the Trash) and a peer's
/// boolean are two values as shown, `5` and `true`: a mapping replaces every
/// block holding one whatever form it holds it in, each write records its own
/// block's form, and the undo gives each back as it was.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn convert_replaces_every_form_of_a_value_and_undo_gives_each_back_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [text, num, flag, trashed] = cards::<4>(&pool, &mat).await;
    declare(&pool, &mat, "whenx", "text", None).await;
    set(&pool, &mat, &text, "whenx", V::Text("5")).await;
    change(&pool, &mat, ("whenx", "date", None), (0, 1)).await;
    peer_number(&pool, &mat, &num, "whenx", 5.0).await;
    peer_bool(&pool, &mat, &flag, "whenx", true).await;
    peer_number(&pool, &mat, &trashed, "whenx", 5.0).await;
    trash(&pool, &mat, &trashed).await;
    assert_eq!(
        groups(&pool, "whenx").await,
        vec![group("5", unfit(2, 1)), group("true", unfit(1, 0))],
        "the text 5 and the number 5 as one"
    );
    let (seed, held) = (rows(&pool, "whenx").await, engine_values(&mat, "whenx"));

    let converted = convert(
        &pool,
        &mat,
        "whenx",
        vec![
            map("5", "2026-05-05", unfit(2, 1)),
            map("true", "2026-06-06", unfit(1, 0)),
        ],
    )
    .await
    .unwrap();

    assert_eq!(converted.inner, unfit(3, 1), "every block holding either");
    let after = rows(&pool, "whenx").await;
    assert_eq!(
        after,
        sorted(vec![
            dated(&text, "2026-05-05"),
            dated(&num, "2026-05-05"),
            dated(&flag, "2026-06-06"),
            dated(&trashed, "2026-05-05"),
        ]),
        "each is a date now, the Trash's too"
    );
    let mut want = vec![
        (text.clone(), PropertyValue::Str("2026-05-05".into())),
        (num.clone(), PropertyValue::Str("2026-05-05".into())),
        (flag.clone(), PropertyValue::Str("2026-06-06".into())),
        (trashed.clone(), PropertyValue::Str("2026-05-05".into())),
    ];
    want.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        engine_values(&mat, "whenx"),
        want,
        "the doc holds each as the string it was given, the Trash's too"
    );
    let (_, _, payload) = op(&pool, &converted.op_refs[0]).await;
    let write =
        |block: &str, to: &str, from: Value| (block.to_owned(), json!({ "value_text": to }), from);
    let mut recorded = vec![
        write(&text, "2026-05-05", json!({ "value_text": "5" })),
        write(&num, "2026-05-05", json!({ "value_num": 5.0 })),
        write(&flag, "2026-06-06", json!({ "value_bool": true })),
        write(&trashed, "2026-05-05", json!({ "value_num": 5.0 })),
    ];
    recorded.sort_by(|x, y| x.0.cmp(&y.0));
    assert_eq!(
        writes(&payload, "whenx"),
        recorded,
        "each write records its own block's value in the form it held it"
    );

    let undone = undo_ops_inner(&pool, DEV, &mat, converted.op_refs)
        .await
        .unwrap();
    assert_eq!(
        rows(&pool, "whenx").await,
        seed,
        "text, numbers and boolean"
    );
    assert_eq!(engine_values(&mat, "whenx"), held, "and the doc's forms");

    let undo = &undone[0].new_op_ref;
    redo_page_op_inner(&pool, DEV, &mat, undo.device_id.clone(), undo.seq)
        .await
        .unwrap();
    assert_eq!(rows(&pool, "whenx").await, after, "dates again");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn convert_with_nothing_held_appends_no_op_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    when_seed(&pool, &mat).await;
    let before = op_count(&pool).await;

    for key in ["whenx", "repeat"] {
        let converted = convert(
            &pool,
            &mat,
            key,
            vec![map("gone", "2026-03-01", unfit(0, 0))],
        )
        .await
        .unwrap();
        assert_eq!(converted.inner, unfit(0, 0), "{key}");
        assert!(converted.op_refs.is_empty(), "{key}: no op to undo");
    }
    assert_eq!(op_count(&pool).await, before);
}
