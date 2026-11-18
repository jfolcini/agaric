//! #6545 — the change feed (`agaric_lib::change_feed::run`): one
//! `blocks:changed` for the local commits since the last, sent after their
//! background rebuilds.

use std::time::Duration;

use super::common::*;
use agaric_core::ulid::{ActiveBlockId, BlockId};
use agaric_sync::sync_events::BlocksChangedEvent;
use serde_json::{Value, json};
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

/// Each event the feed emits, as it goes on the wire, with the number of
/// `agenda_cache` rows at the moment of the emit.
type Emitted = UnboundedReceiver<(Value, i64)>;

/// Run the feed over `mat`, recording into the returned channel.
fn spawn_feed(pool: &SqlitePool, mat: &Materializer) -> Emitted {
    let (tx, rx) = unbounded_channel();
    let read = pool.clone();
    tokio::spawn(agaric_lib::change_feed::run(
        pool.clone(),
        mat.clone(),
        move |event: BlocksChangedEvent| {
            let agenda_rows = tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(
                    sqlx::query_scalar("SELECT COUNT(*) FROM agenda_cache").fetch_one(&read),
                )
            })
            .unwrap();
            let _ = tx.send((serde_json::to_value(event).unwrap(), agenda_rows));
        },
    ));
    rx
}

/// The next event, its page ids sorted.
async fn next_event(emitted: &mut Emitted) -> (Value, i64) {
    let (mut event, agenda_rows) = tokio::time::timeout(Duration::from_secs(10), emitted.recv())
        .await
        .expect("the feed emitted nothing")
        .expect("the feed stopped");
    if let Some(Value::Array(pages)) = event.get_mut("changed_page_ids") {
        pages.sort_by_key(Value::to_string);
    }
    (event, agenda_rows)
}

/// Settle the fixture's own writes and drop what they recorded.
async fn forget_fixture_writes(mat: &Materializer) {
    settle(mat).await;
    let feed = mat.change_feed();
    feed.take_if_quiet(feed.writes())
        .expect("no commit between the two reads");
}

async fn space(pool: &SqlitePool, mat: &Materializer) -> String {
    create_space_inner(pool, DEV, mat, "Space".into(), None)
        .await
        .unwrap()
        .into_string()
}

async fn page(pool: &SqlitePool, mat: &Materializer, space: &str, title: &str) -> BlockId {
    create_page_in_space_inner(pool, DEV, mat, None, title.into(), space.into())
        .await
        .unwrap()
}

async fn child(pool: &SqlitePool, mat: &Materializer, parent: &BlockId) -> BlockId {
    create_block_inner(
        pool,
        DEV,
        mat,
        "content".into(),
        "child".into(),
        Some(parent.clone()),
        None,
    )
    .await
    .unwrap()
    .id
}

/// What the feed sends for a content block created under `page`.
fn content_create_event(page: &BlockId) -> Value {
    json!({
        "changed_page_ids": [page.as_str()],
        "local_ops_appended": true,
        "domains": ["structure"],
        "local_command": true,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_local_write_is_one_event_sent_after_its_rebuild_6545() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let space = space(&pool, &mat).await;
    let tasks = page(&pool, &mat, &space, "Tasks").await;
    let task = child(&pool, &mat, &tasks).await;
    let other = page(&pool, &mat, &space, "Other").await;
    forget_fixture_writes(&mat).await;
    let mut emitted = spawn_feed(&pool, &mat);

    // Shed the write's rebuild tasks: nothing but the settle the feed owes
    // runs them, so the `agenda_cache` row exists only after it.
    mat.force_shed_after(0);
    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        ActiveBlockId::from_trusted_active(task.as_str()),
        Some("2031-03-04".into()),
    )
    .await
    .unwrap();
    mat.force_shed_after(-1);

    let (event, agenda_rows) = next_event(&mut emitted).await;
    assert_eq!(
        event,
        json!({
            "changed_page_ids": [tasks.as_str()],
            "local_ops_appended": true,
            "domains": ["properties"],
            "local_command": true,
        }),
        "a date write names its page and the properties domain"
    );
    assert_eq!(
        agenda_rows, 1,
        "the write's agenda row is there when the event is sent"
    );

    // A second write's event is the next one: the first write sent only one.
    child(&pool, &mat, &other).await;
    assert_eq!(
        next_event(&mut emitted).await.0,
        content_create_event(&other),
        "the first write sent a single event"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn commits_the_feed_has_not_sent_yet_share_one_event_6545() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let space = space(&pool, &mat).await;
    forget_fixture_writes(&mat).await;

    // Three commits before the feed runs: all three are pending when it wakes.
    let mut pages = Vec::new();
    for title in ["One", "Two", "Three"] {
        pages.push(page(&pool, &mat, &space, title).await);
    }
    let mut emitted = spawn_feed(&pool, &mat);

    let mut created: Vec<&str> = pages.iter().map(BlockId::as_str).collect();
    created.sort_unstable();
    assert_eq!(
        next_event(&mut emitted).await.0,
        json!({
            "changed_page_ids": created,
            "local_ops_appended": true,
            "domains": ["structure", "names"],
            "local_command": true,
        }),
        "three page creates are one event naming all three"
    );

    // A fourth commit's event is the next one: the three sent only one.
    child(&pool, &mat, &pages[0]).await;
    assert_eq!(
        next_event(&mut emitted).await.0,
        content_create_event(&pages[0]),
        "the three creates sent a single event"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_delete_waits_for_its_debounced_rebuild_instead_of_forcing_it_6545() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let space = space(&pool, &mat).await;
    let notes = page(&pool, &mat, &space, "Notes").await;
    let doomed = child(&pool, &mat, &notes).await;
    forget_fixture_writes(&mat).await;
    let mut emitted = spawn_feed(&pool, &mat);

    let deleted_at = std::time::Instant::now();
    delete_block_inner(&pool, DEV, &mat, doomed).await.unwrap();

    let (event, _) = next_event(&mut emitted).await;
    assert_eq!(
        event["changed_page_ids"],
        json!([notes.as_str()]),
        "the delete names its page"
    );
    // A settle would fire the #2935 debounce at once, so a burst of deletes
    // would rebuild every cache once per commit instead of once per burst.
    assert!(
        deleted_at.elapsed() >= agaric_engine::materializer::INBOUND_REBUILD_DEBOUNCE,
        "the event waited out the delete's rebuild debounce"
    );
}
