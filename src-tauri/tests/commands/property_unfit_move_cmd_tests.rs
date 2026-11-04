//! A key's values that don't fit its definition, moved to another key where
//! they fit, on the same blocks (#6206).

use super::prelude::*;
use super::property_unfit_cmd_tests::{
    V, change, declare, engine_holders, op, op_count, rows, set, trash,
};
use super::property_unfit_convert_cmd_tests::{
    cards, dated, engine_values, numbered, peer_bool, peer_number, peer_set, sorted, texted,
};
use agaric_core::error::ValidationCode;
use agaric_engine::loro::engine::PropertyValue;
use agaric_store::op::{OpRef, PropertyValueFields};
use serde_json::{Value, json};

fn counts(moved: i64, occupied: i64, unfit_there: i64) -> UnfitMoveCounts {
    UnfitMoveCounts {
        moved,
        occupied,
        unfit_there,
    }
}

async fn preview(pool: &SqlitePool, key: &str, into: &str) -> Result<UnfitMoveCounts, AppError> {
    preview_unfit_property_move_inner(pool, TEST_SPACE_ID, key.into(), into.into()).await
}

async fn move_values(
    pool: &SqlitePool,
    mat: &Materializer,
    (key, into): (&str, &str),
    acknowledged: UnfitMoveCounts,
) -> Result<WithOps<UnfitMoveCounts>, AppError> {
    capture_op_refs(move_unfit_property_values_inner(
        pool,
        DEV,
        mat,
        TEST_SPACE_ID,
        key.into(),
        into.into(),
        acknowledged,
    ))
    .await
}

/// `ids`, sorted, as [`engine_holders`] lists them.
fn ids(ids: &[&String]) -> Vec<String> {
    let mut ids: Vec<String> = ids.iter().map(|id| (*id).clone()).collect();
    ids.sort();
    ids
}

/// `whenx`, a date: `A` holds the date 2026-01-05, which fits; `B` "soon",
/// the trashed `C` "later", `D` a peer's number 5, `E` a peer's boolean true,
/// and `F` "soon" beside its text `notesx` "kept". `notesx` is a text, `sizex`
/// a number and `ownerx` a ref.
async fn move_seed(pool: &SqlitePool, mat: &Materializer) -> [String; 6] {
    let made = cards::<6>(pool, mat).await;
    let [a, b, c, d, e, f] = &made;
    for (key, ty) in [
        ("whenx", "text"),
        ("notesx", "text"),
        ("sizex", "number"),
        ("ownerx", "ref"),
    ] {
        declare(pool, mat, key, ty, None).await;
    }
    for (card, text) in [(a, "2026-01-05"), (b, "soon"), (c, "later"), (f, "soon")] {
        set(pool, mat, card, "whenx", V::Text(text)).await;
    }
    change(pool, mat, ("whenx", "date", None), (1, 3)).await;
    trash(pool, mat, c).await;
    peer_number(pool, mat, d, "whenx", 5.0).await;
    peer_bool(pool, mat, e, "whenx", true).await;
    set(pool, mat, f, "notesx", V::Text("kept")).await;
    made
}

/// A rewrite's value writes as `(block, key, value, prior)`, each with its set
/// slots only, in the op's order.
fn writes(payload: &Value) -> Vec<(String, String, Value, Value)> {
    let slots = |v: &Value| {
        v.as_object().map_or(Value::Null, |slots| {
            slots
                .iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
    };
    payload["values"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| {
            (
                w["block_id"].as_str().unwrap().to_owned(),
                w["key"].as_str().unwrap().to_owned(),
                slots(&w["value"]),
                slots(&w["prior"]),
            )
        })
        .collect()
}

/// Set `key` on `block` to the text `value`; the op's ref.
async fn set_ref(
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preview_counts_what_moves_what_is_set_there_and_what_doesnt_fit_there_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    move_seed(&pool, &mat).await;
    let before = op_count(&pool).await;

    assert_eq!(
        preview(&pool, "whenx", "notesx").await.unwrap(),
        counts(4, 1, 0),
        "soon, the trashed later, 5 and true read as text; F holds notesx already"
    );
    assert_eq!(
        preview(&pool, "whenx", "sizex").await.unwrap(),
        counts(1, 0, 4),
        "only the 5 is a number"
    );
    assert_eq!(
        preview(&pool, "nothing", "notesx").await.unwrap(),
        counts(0, 0, 0),
        "an undeclared key has none"
    );
    assert_eq!(op_count(&pool).await, before, "a preview writes nothing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_writes_each_value_under_the_target_in_one_op_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [a, b, c, d, e, f] = move_seed(&pool, &mat).await;
    let before = op_count(&pool).await;

    let moved = move_values(&pool, &mat, ("whenx", "notesx"), counts(4, 1, 0))
        .await
        .unwrap();

    assert_eq!(moved.inner, counts(4, 1, 0), "what it moved and left");
    assert_eq!(
        rows(&pool, "whenx").await,
        sorted(vec![dated(&a, "2026-01-05"), texted(&f, "soon")]),
        "the date that fits stays, and so does F's, which holds notesx"
    );
    assert_eq!(
        rows(&pool, "notesx").await,
        sorted(vec![
            texted(&b, "soon"),
            texted(&c, "later"),
            texted(&d, "5"),
            texted(&e, "true"),
            texted(&f, "kept"),
        ]),
        "each as text, the Trash's too; F keeps its own"
    );
    assert_eq!(engine_holders(&mat, "whenx"), ids(&[&a, &f]), "the doc too");
    assert_eq!(
        engine_holders(&mat, "notesx"),
        ids(&[&b, &c, &d, &e, &f]),
        "the doc too"
    );
    assert_eq!(op_count(&pool).await, before + 1, "one op");
    assert_eq!(moved.op_refs.len(), 1);
    let (op_type, block_id, payload) = op(&pool, &moved.op_refs[0]).await;
    assert_eq!(op_type, "rewrite_properties");
    assert_eq!(
        block_id.as_deref(),
        Some(TEST_SPACE_ID),
        "filed under its space"
    );
    assert_eq!(payload["reason"], "move_unfit");
    assert_eq!(payload["defs"], json!([]), "no definition write");
    let mut moves = vec![
        (&b, json!({ "value_text": "soon" }), "soon"),
        (&c, json!({ "value_text": "later" }), "later"),
        (&d, json!({ "value_num": 5.0 }), "5"),
        (&e, json!({ "value_bool": true }), "true"),
    ];
    moves.sort_by(|x, y| x.0.cmp(y.0));
    let want: Vec<_> = moves
        .into_iter()
        .flat_map(|(block, prior, text)| {
            [
                (block.clone(), "whenx".to_owned(), Value::Null, prior),
                (
                    block.clone(),
                    "notesx".to_owned(),
                    json!({ "value_text": text }),
                    Value::Null,
                ),
            ]
        })
        .collect();
    assert_eq!(
        writes(&payload),
        want,
        "by block, each removed under whenx as it was held, then written under notesx"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_into_a_number_moves_only_the_value_that_is_one_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [_, _, _, d, _, _] = move_seed(&pool, &mat).await;
    let mut left = rows(&pool, "whenx").await;
    left.retain(|row| row.0 != d);

    let moved = move_values(&pool, &mat, ("whenx", "sizex"), counts(1, 0, 4))
        .await
        .unwrap();

    assert_eq!(moved.inner, counts(1, 0, 4));
    assert_eq!(
        rows(&pool, "sizex").await,
        vec![numbered(&d, 5.0)],
        "the 5 moves, a number"
    );
    assert_eq!(
        engine_values(&mat, "sizex"),
        vec![(d.clone(), PropertyValue::Num(5.0))],
        "and the doc holds it so"
    );
    assert_eq!(
        rows(&pool, "whenx").await,
        left,
        "soon, later and true are no number: they stay"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_refuses_a_stale_acknowledgement_and_writes_nothing_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    move_seed(&pool, &mat).await;
    let seed = (rows(&pool, "whenx").await, rows(&pool, "notesx").await);
    let before = op_count(&pool).await;

    for stale in [
        counts(3, 1, 0),
        counts(5, 0, 0),
        counts(4, 0, 0),
        counts(4, 1, 1),
        counts(0, 0, 0),
    ] {
        let refused = move_values(&pool, &mat, ("whenx", "notesx"), stale).await;
        assert_eq!(
            refused.err().and_then(|e| e.validation_code()),
            Some(ValidationCode::UnacknowledgedPropertyLoss),
            "{stale:?} is refused, coded"
        );
    }
    assert_eq!(op_count(&pool).await, before, "no refusal appends an op");
    assert_eq!(
        (rows(&pool, "whenx").await, rows(&pool, "notesx").await),
        seed,
        "every value as it was"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_and_its_preview_refuse_each_target_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    move_seed(&pool, &mat).await;
    let seed = rows(&pool, "whenx").await;
    let before = op_count(&pool).await;

    for (into, code) in [
        ("whenx", None),
        ("priority", Some(ValidationCode::BuiltinPropertyLocked)),
        ("template", None),
        ("ownerx", None),
    ] {
        match move_values(&pool, &mat, ("whenx", into), counts(4, 1, 0)).await {
            Err(AppError::Validation { code: got, .. }) => assert_eq!(got, code, "into {into}"),
            other => panic!("into {into}: expected a refusal, got {other:?}"),
        }
        match preview(&pool, "whenx", into).await {
            Err(AppError::Validation { code: got, .. }) => {
                assert_eq!(got, code, "the preview into {into}");
            }
            other => panic!("the preview into {into}: expected a refusal, got {other:?}"),
        }
    }
    let undeclared = move_values(&pool, &mat, ("whenx", "nothing"), counts(4, 1, 0)).await;
    assert!(
        matches!(undeclared, Err(AppError::NotFound(_))),
        "got {undeclared:?}"
    );
    let previewed = preview(&pool, "whenx", "nothing").await;
    assert!(
        matches!(previewed, Err(AppError::NotFound(_))),
        "got {previewed:?}"
    );
    assert_eq!(op_count(&pool).await, before, "no refusal appends an op");
    assert_eq!(rows(&pool, "whenx").await, seed, "every value as it was");
}

/// A built-in's value that doesn't fit moves to a user's key as one of a
/// user's key does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_builtins_value_moves_to_a_users_key_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [card] = cards::<1>(&pool, &mat).await;
    declare(&pool, &mat, "notesx", "text", None).await;
    let zigzag = PropertyValueFields {
        value_text: Some("zigzag".into()),
        ..Default::default()
    };
    peer_set(&pool, &mat, &card, "listStyle", zigzag).await;

    let moved = move_values(&pool, &mat, ("listStyle", "notesx"), counts(1, 0, 0))
        .await
        .unwrap();

    assert_eq!(moved.inner, counts(1, 0, 0));
    assert!(rows(&pool, "listStyle").await.is_empty(), "off listStyle");
    assert_eq!(rows(&pool, "notesx").await, vec![texted(&card, "zigzag")]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_puts_each_value_back_under_its_key_and_redo_moves_it_again_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [_, b, c, d, e, f] = move_seed(&pool, &mat).await;
    let seed = (rows(&pool, "whenx").await, rows(&pool, "notesx").await);
    let held = engine_values(&mat, "whenx");
    let moved = move_values(&pool, &mat, ("whenx", "notesx"), counts(4, 1, 0))
        .await
        .unwrap();
    let after = (rows(&pool, "whenx").await, rows(&pool, "notesx").await);

    let undone = undo_ops_inner(&pool, DEV, &mat, moved.op_refs)
        .await
        .unwrap();
    assert_eq!(undone.len(), 1, "one undo");
    assert_eq!(undone[0].new_op_type, "rewrite_properties");
    assert_eq!(
        (rows(&pool, "whenx").await, rows(&pool, "notesx").await),
        seed,
        "each value back under whenx, the number and the boolean as such; F's notesx kept"
    );
    assert_eq!(
        engine_values(&mat, "whenx"),
        held,
        "and in the doc, each in its form"
    );
    assert_eq!(engine_holders(&mat, "notesx"), ids(&[&f]), "the doc too");

    let undo = &undone[0].new_op_ref;
    redo_page_op_inner(&pool, DEV, &mat, undo.device_id.clone(), undo.seq)
        .await
        .unwrap();
    assert_eq!(
        (rows(&pool, "whenx").await, rows(&pool, "notesx").await),
        after,
        "moved again"
    );
    assert_eq!(
        engine_holders(&mat, "notesx"),
        ids(&[&b, &c, &d, &e, &f]),
        "the doc too"
    );
}

/// Undoing a set from before a move follows a moved value to the key it moved
/// to, and leaves one that stayed (its block held the target) under its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_an_older_set_after_a_move_follows_a_moved_value_only_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [moved, stayed] = cards::<2>(&pool, &mat).await;
    declare(&pool, &mat, "whenx", "text", None).await;
    declare(&pool, &mat, "notesx", "text", None).await;
    set(&pool, &mat, &moved, "whenx", V::Text("m0")).await;
    let set_moved = set_ref(&pool, &mat, &moved, "whenx", "m1").await;
    set(&pool, &mat, &stayed, "notesx", V::Text("p")).await;
    set(&pool, &mat, &stayed, "whenx", V::Text("s0")).await;
    let set_stayed = set_ref(&pool, &mat, &stayed, "whenx", "s1").await;
    change(&pool, &mat, ("whenx", "number", None), (0, 2)).await;
    move_values(&pool, &mat, ("whenx", "notesx"), counts(1, 1, 0))
        .await
        .unwrap();

    undo_ops_inner(&pool, DEV, &mat, vec![set_moved, set_stayed])
        .await
        .unwrap();
    assert_eq!(
        rows(&pool, "notesx").await,
        sorted(vec![texted(&moved, "m0"), texted(&stayed, "p")]),
        "the moved value's undo lands under notesx; the other block's notesx is its own"
    );
    assert_eq!(
        rows(&pool, "whenx").await,
        vec![texted(&stayed, "s0")],
        "the value that stayed is undone under whenx, kept as text"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_with_nothing_to_move_appends_no_op_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    move_seed(&pool, &mat).await;
    move_values(&pool, &mat, ("whenx", "notesx"), counts(4, 1, 0))
        .await
        .unwrap();
    let before = op_count(&pool).await;

    for (keys, left) in [
        (("whenx", "notesx"), counts(0, 1, 0)),
        (("whenx", "sizex"), counts(0, 0, 1)),
        (("nothing", "notesx"), counts(0, 0, 0)),
    ] {
        let moved = move_values(&pool, &mat, keys, left).await.unwrap();
        assert_eq!(moved.inner, left, "{keys:?}");
        assert!(moved.op_refs.is_empty(), "{keys:?}: no op to undo");
    }
    assert_eq!(op_count(&pool).await, before);
}

/// A block that holds the target keeps its value whether or not it would fit
/// there, and is counted as holding it: `F` holds `sizex` beside its "soon".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_block_holding_the_target_counts_as_holding_it_even_if_its_value_doesnt_fit_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [_, _, _, d, _, f] = move_seed(&pool, &mat).await;
    set(&pool, &mat, &f, "sizex", V::Num(3.0)).await;

    assert_eq!(
        preview(&pool, "whenx", "sizex").await.unwrap(),
        counts(1, 1, 3),
        "the 5 moves; F's soon is no number but F holds sizex; B, C and E are no number"
    );
    move_values(&pool, &mat, ("whenx", "sizex"), counts(1, 1, 3))
        .await
        .unwrap();
    assert_eq!(
        rows(&pool, "sizex").await,
        sorted(vec![numbered(&d, 5.0), numbered(&f, 3.0)]),
        "F keeps its own sizex"
    );
}

/// A text a key's type can't hold moves into the slot of the key that reads
/// it: a date in `value_date`, "true" as a boolean, a select's option as text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_text_moves_into_the_slot_of_the_key_that_reads_it_6206() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [a, b, c, d] = cards::<4>(&pool, &mat).await;
    declare(&pool, &mat, "rawx", "text", None).await;
    declare(&pool, &mat, "duex", "date", None).await;
    declare(&pool, &mat, "flagx", "boolean", None).await;
    declare(&pool, &mat, "kindx", "select", Some(r#"["red","green"]"#)).await;
    for (card, text) in [
        (&a, "2026-01-05"),
        (&b, "true"),
        (&c, "green"),
        (&d, "7 apples"),
    ] {
        set(&pool, &mat, card, "rawx", V::Text(text)).await;
    }
    change(&pool, &mat, ("rawx", "number", None), (0, 4)).await;

    for (into, left) in [
        ("duex", counts(1, 0, 3)),
        ("flagx", counts(1, 0, 2)),
        ("kindx", counts(1, 0, 1)),
    ] {
        let moved = move_values(&pool, &mat, ("rawx", into), left)
            .await
            .unwrap();
        assert_eq!(moved.inner, left, "into {into}");
    }

    assert_eq!(rows(&pool, "duex").await, vec![dated(&a, "2026-01-05")]);
    assert_eq!(
        rows(&pool, "flagx").await,
        vec![(b.clone(), None, None, None, None, Some(1))],
        "true is a boolean there"
    );
    assert_eq!(rows(&pool, "kindx").await, vec![texted(&c, "green")]);
    assert_eq!(
        rows(&pool, "rawx").await,
        vec![texted(&d, "7 apples")],
        "the text no other key reads stays"
    );
    assert_eq!(
        engine_values(&mat, "flagx"),
        vec![(b, PropertyValue::Bool(true))],
        "and the doc holds it so"
    );
}
