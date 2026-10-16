//! #5423: a property op on one block refreshes only that block's
//! `projected_agenda_cache` rows. Each shape applies its ops through
//! `dispatch_op` (the foreground apply, then the production dispatch table),
//! drains the materializer, and asserts the cache equals a full rebuild at the
//! same `today`, with two other repeating blocks' rows untouched.
//!
//! The handler reads the device clock, so `today` is the wall-clock date and a
//! run that straddles local midnight fails.
use super::*;
use agaric_store::cache::{HORIZON_OCCURRENCES, rebuild_projected_agenda_cache_with_today};

const PAGE: &str = "PAB_PAGE";
const TEMPLATE_PAGE: &str = "PAB_TEMPLATE_PAGE";
const SUBJECT: &str = "PAB_SUBJECT";
const KEEP_DUE: &str = "PAB_KEEP_DUE";
const KEEP_SCHEDULED: &str = "PAB_KEEP_SCHEDULED";

type CacheRow = (String, String, String);

struct Shape {
    name: &'static str,
    page: &'static str,
    due: Option<i64>,
    scheduled: Option<i64>,
    repeat: Option<&'static str>,
    deleted: bool,
    ops: Vec<OpPayload>,
}

fn ymd(today: chrono::NaiveDate, offset: i64) -> String {
    (today + chrono::Duration::days(offset))
        .format("%Y-%m-%d")
        .to_string()
}

fn set_op(key: &str, text: Option<&str>, num: Option<f64>, date: Option<String>) -> OpPayload {
    OpPayload::SetProperty(SetPropertyPayload {
        block_id: BlockId::test_id(SUBJECT),
        key: key.into(),
        value_text: text.map(Into::into),
        value_num: num,
        value_date: date,
        value_ref: None,
        value_bool: None,
    })
}

fn delete_op(key: &str) -> OpPayload {
    OpPayload::DeleteProperty(DeletePropertyPayload {
        block_id: BlockId::test_id(SUBJECT),
        key: key.into(),
    })
}

async fn insert_dated_block(
    pool: &SqlitePool,
    id: &str,
    page: &str,
    due: Option<String>,
    scheduled: Option<String>,
) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id, due_date, scheduled_date) \
         VALUES (?, 'content', 'task', ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(page)
    .bind(page)
    .bind(due)
    .bind(scheduled)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_repeat(pool: &SqlitePool, id: &str, rule: &str) {
    sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'repeat', ?)")
        .bind(id)
        .bind(rule)
        .execute(pool)
        .await
        .unwrap();
}

/// A page, a template page, and two repeating blocks that no op touches.
async fn seed_vault(pool: &SqlitePool, today: chrono::NaiveDate) {
    for page in [PAGE, TEMPLATE_PAGE] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', 'p', ?)",
        )
        .bind(page)
        .bind(page)
        .execute(pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_bool) VALUES (?, 'template', 1)",
    )
    .bind(TEMPLATE_PAGE)
    .execute(pool)
    .await
    .unwrap();
    insert_dated_block(pool, KEEP_DUE, PAGE, Some(ymd(today, 0)), None).await;
    insert_repeat(pool, KEEP_DUE, "daily").await;
    insert_dated_block(pool, KEEP_SCHEDULED, PAGE, None, Some(ymd(today, 0))).await;
    insert_repeat(pool, KEEP_SCHEDULED, "weekly").await;
}

async fn seed_subject(pool: &SqlitePool, shape: &Shape, today: chrono::NaiveDate) {
    let at = |offset: Option<i64>| offset.map(|o| ymd(today, o));
    insert_dated_block(
        pool,
        SUBJECT,
        shape.page,
        at(shape.due),
        at(shape.scheduled),
    )
    .await;
    if let Some(rule) = shape.repeat {
        insert_repeat(pool, SUBJECT, rule).await;
    }
    if shape.deleted {
        soft_delete_block_direct(pool, SUBJECT).await;
    }
}

async fn dump_cache(pool: &SqlitePool) -> Vec<CacheRow> {
    sqlx::query_as(
        "SELECT block_id, projected_date, source FROM projected_agenda_cache \
         ORDER BY block_id, projected_date, source",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

fn keeper_rows(rows: &[CacheRow]) -> Vec<CacheRow> {
    rows.iter()
        .filter(|(id, _, _)| id == KEEP_DUE || id == KEEP_SCHEDULED)
        .cloned()
        .collect()
}

fn shapes(today: chrono::NaiveDate) -> Vec<Shape> {
    let date = |offset| Some(ymd(today, offset));
    let shape = |name, due, scheduled, repeat, ops| Shape {
        name,
        page: PAGE,
        due,
        scheduled,
        repeat,
        deleted: false,
        ops,
    };
    vec![
        shape(
            "daily repeat, due date moved",
            Some(-5),
            None,
            Some("daily"),
            vec![set_op("due_date", None, None, date(1))],
        ),
        shape(
            "weekly repeat, rule changed",
            Some(-20),
            None,
            Some("weekly"),
            vec![set_op("repeat", Some(".+1w"), None, None)],
        ),
        shape(
            "due only, todo state set",
            Some(-3),
            None,
            Some("daily"),
            vec![set_op("todo_state", Some("TODO"), None, None)],
        ),
        shape(
            "scheduled only, scheduled date moved",
            None,
            Some(4),
            Some("weekly"),
            vec![set_op("scheduled_date", None, None, date(10))],
        ),
        shape(
            "due and scheduled, due date moved",
            Some(-2),
            Some(1),
            Some("daily"),
            vec![set_op("due_date", None, None, date(3))],
        ),
        shape(
            "repeat-until set",
            Some(-2),
            None,
            Some("daily"),
            vec![set_op("repeat-until", None, None, date(20))],
        ),
        shape(
            "repeat-count set",
            Some(-2),
            None,
            Some("daily"),
            vec![set_op("repeat-count", None, Some(5.0), None)],
        ),
        shape(
            "repeat-seq set against a repeat-count",
            Some(-2),
            None,
            Some("daily"),
            vec![
                set_op("repeat-count", None, Some(5.0), None),
                set_op("repeat-seq", None, Some(2.0), None),
            ],
        ),
        shape(
            "set DONE, then back to TODO",
            Some(-1),
            None,
            Some("daily"),
            vec![
                set_op("todo_state", Some("DONE"), None, None),
                set_op("todo_state", Some("TODO"), None, None),
            ],
        ),
        shape(
            "repeat removed",
            Some(-1),
            None,
            Some("weekly"),
            vec![delete_op("repeat")],
        ),
        shape(
            "dates removed one by one",
            Some(-1),
            Some(2),
            Some("daily"),
            vec![delete_op("due_date"), delete_op("scheduled_date")],
        ),
        Shape {
            deleted: true,
            ..shape(
                "soft-deleted block",
                Some(-1),
                None,
                Some("daily"),
                vec![set_op("repeat", Some("weekly"), None, None)],
            )
        },
        Shape {
            page: TEMPLATE_PAGE,
            ..shape(
                "block on a template page gains repeat",
                Some(-1),
                None,
                None,
                vec![set_op("repeat", Some("daily"), None, None)],
            )
        },
        shape(
            "non-repeating block gains repeat",
            Some(2),
            None,
            None,
            vec![set_op("repeat", Some("weekly"), None, None)],
        ),
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn property_op_refreshes_one_block_equal_to_a_full_rebuild_5423() {
    let today = chrono::Local::now().date_naive();
    for shape in shapes(today) {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        seed_vault(&pool, today).await;
        seed_subject(&pool, &shape, today).await;
        rebuild_projected_agenda_cache_with_today(&pool, today)
            .await
            .unwrap();
        let keepers = keeper_rows(&dump_cache(&pool).await);
        assert_eq!(
            keepers.len(),
            2 * HORIZON_OCCURRENCES,
            "{}: both untouched repeating blocks must project their full horizon",
            shape.name
        );

        for (step, op) in shape.ops.into_iter().enumerate() {
            // A row no rebuild writes: only a refresh that leaves the other
            // blocks' rows alone keeps it.
            let poison: CacheRow = (KEEP_DUE.into(), "2099-12-31".into(), "due_date".into());
            sqlx::query(
                "INSERT INTO projected_agenda_cache (block_id, projected_date, source) \
                 VALUES (?, ?, ?)",
            )
            .bind(&poison.0)
            .bind(&poison.1)
            .bind(&poison.2)
            .execute(&pool)
            .await
            .unwrap();
            let record = make_op_record(&pool, op).await;
            mat.dispatch_op(&record).await.unwrap();
            mat.flush().await.unwrap();
            let mut refreshed = dump_cache(&pool).await;
            assert!(
                refreshed.contains(&poison),
                "{} (op {step}): the op rewrote a block it does not own",
                shape.name
            );
            refreshed.retain(|row| row != &poison);
            assert_eq!(
                keeper_rows(&refreshed),
                keepers,
                "{} (op {step}): other blocks' rows must survive untouched",
                shape.name
            );

            rebuild_projected_agenda_cache_with_today(&pool, today)
                .await
                .unwrap();
            assert_eq!(
                refreshed,
                dump_cache(&pool).await,
                "{} (op {step}): the cache must equal a full rebuild at the same today",
                shape.name
            );
        }
    }
}
